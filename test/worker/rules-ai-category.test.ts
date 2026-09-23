// F2.2b：規則 ai_category 條件 + 第二趟套用（applyAiCategoryRules）。
// 註：aiCategorize() 本身呼叫 Workers AI（非確定性、測試環境無），不在此測；這裡測「分類算出後」的規則邏輯。
import { describe, expect, it } from 'vitest';
import { createExecutionContext, env } from 'cloudflare:test';
import worker from '../../src/worker/index';
import { seedUser } from './helpers/fixtures';
import { applyRules, applyAiCategoryRules, matchesConditions, userHasAiCategoryRule } from '../../src/worker/email/rulesEngine';

let n = 0;
async function addRule(userId: string, conditions: unknown, actions: unknown) {
  n += 1;
  await env.DB.prepare(
    `INSERT INTO rules (id, user_id, name, conditions, actions, enabled, priority, created_at) VALUES (?, ?, 'r', ?, ?, 1, ?, 0)`,
  )
    .bind(`air-${n}`, userId, JSON.stringify(conditions), JSON.stringify(actions), n)
    .run();
}
async function addMsg(userId: string, id: string) {
  await env.DB.prepare(
    `INSERT INTO messages (id, user_id, thread_id, direction, from_addr, from_name, subject, snippet, folder, received_at, created_at)
     VALUES (?, ?, ?, 'inbound', 'news@x.com', '電子報', '本週優惠', '', 'inbox', 0, 0)`,
  )
    .bind(id, userId, `t-${id}`)
    .run();
  return { id, user_id: userId, from_addr: 'news@x.com', from_name: '電子報', subject: '本週優惠', folder: 'inbox', to_addrs: '' };
}

describe('規則 AI 分類條件（F2.2b）', () => {
  it('matchesConditions：aiCategory 唯有 f.aiCategory 相符才成立（落信第一趟為 null → 不成立）', () => {
    const cond = { aiCategory: '電子報' };
    const base = { from: '', subject: '', to: '', hasListUnsubscribe: false };
    expect(matchesConditions(cond, { ...base, aiCategory: '電子報' })).toBe(true);
    expect(matchesConditions(cond, { ...base, aiCategory: '工作' })).toBe(false);
    expect(matchesConditions(cond, { ...base, aiCategory: null })).toBe(false);
    expect(matchesConditions(cond, base)).toBe(false); // aiCategory 未提供（第一趟）
  });

  it('applyRules 第一趟：ai_category 規則不誤觸（分類尚未算出）', async () => {
    const u = await seedUser(env, 'u@miseroda.com');
    await addRule(u.userId, { aiCategory: '電子報' }, { snooze: 'weekend' });
    const msg = await addMsg(u.userId, 'a1');
    await applyRules(env, msg, { hasListUnsubscribe: false, firstInsert: true });
    const row = await env.DB.prepare(`SELECT snoozed_until FROM messages WHERE id = 'a1'`).first<{ snoozed_until: number | null }>();
    expect(row?.snoozed_until).toBeNull();
  });

  it('applyAiCategoryRules：分類相符才套用動作', async () => {
    const u = await seedUser(env, 'u@miseroda.com');
    await addRule(u.userId, { aiCategory: '電子報' }, { snooze: 'weekend' });
    const msg = await addMsg(u.userId, 'a2');
    // 分類 = 工作 → 不符 → 不 snooze
    await applyAiCategoryRules(env, msg, { hasListUnsubscribe: false, firstInsert: true }, '工作');
    expect((await env.DB.prepare(`SELECT snoozed_until FROM messages WHERE id = 'a2'`).first<{ snoozed_until: number | null }>())?.snoozed_until).toBeNull();
    // 分類 = 電子報 → 符 → snooze
    await applyAiCategoryRules(env, msg, { hasListUnsubscribe: false, firstInsert: true }, '電子報');
    expect((await env.DB.prepare(`SELECT snoozed_until FROM messages WHERE id = 'a2'`).first<{ snoozed_until: number | null }>())?.snoozed_until).toBeGreaterThan(Date.now());
  });

  it('match=any 規則：第一趟已靠別的條件符合者，第二趟不重套（不重設 star/snooze）', async () => {
    const u = await seedUser(env, 'u@miseroda.com');
    // 寄件者含 news 「或」AI 分類=電子報；msg 寄件者就是 news@x.com → 第一趟即符合
    await addRule(u.userId, { match: 'any', clauses: [{ field: 'from', op: 'contains', value: 'news' }], aiCategory: '電子報' }, { star: true });
    const msg = await addMsg(u.userId, 'a4');
    // 第二趟給「帳單」（分類不符），但 from 仍符合 → 無分類時也成立 → 視為第一趟已套 → 不重套
    await applyAiCategoryRules(env, msg, { hasListUnsubscribe: false, firstInsert: true }, '帳單');
    expect((await env.DB.prepare(`SELECT is_starred FROM messages WHERE id = 'a4'`).first<{ is_starred: number }>())?.is_starred).toBe(0);
  });

  it('規則 API：aiCategory 條件能存進去（不被 conditionsSchema 剝掉）', async () => {
    const u = await seedUser(env, 'api@miseroda.com');
    const res = await worker.fetch(
      new Request('https://mail.miseroda.com/api/v1/rules', {
        method: 'POST',
        headers: {
          Cookie: `__Host-session=${encodeURIComponent(u.cookies.session)}; __Host-csrf=${encodeURIComponent(u.cookies.csrf)}`,
          'X-CSRF-Token': u.cookies.csrf,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: '電子報週末', conditions: { aiCategory: '電子報' }, actions: { snooze: 'weekend' } }),
      }),
      env,
      createExecutionContext(),
    );
    expect(res.status).toBe(200);
    const stored = await env.DB.prepare(`SELECT conditions FROM rules WHERE user_id = ?`).bind(u.userId).first<{ conditions: string }>();
    expect((JSON.parse(stored!.conditions) as { aiCategory?: string }).aiCategory).toBe('電子報');
  });

  it('match=any：非 AI 條件不符但分類符 → 第二趟套用', async () => {
    const u = await seedUser(env, 'u@miseroda.com');
    await addRule(u.userId, { match: 'any', clauses: [{ field: 'from', op: 'contains', value: 'zzz' }], aiCategory: '電子報' }, { star: true });
    const msg = await addMsg(u.userId, 'a5'); // from news@x.com（不含 zzz）→ 唯靠分類成立
    await applyAiCategoryRules(env, msg, { hasListUnsubscribe: false, firstInsert: true }, '電子報');
    expect((await env.DB.prepare(`SELECT is_starred FROM messages WHERE id = 'a5'`).first<{ is_starred: number }>())?.is_starred).toBe(1);
  });

  it('match=all：非 AI 條件 + 分類皆符 → 第二趟套用（第一趟因缺分類不成立）', async () => {
    const u = await seedUser(env, 'u@miseroda.com');
    await addRule(u.userId, { match: 'all', clauses: [{ field: 'from', op: 'contains', value: 'news' }], aiCategory: '電子報' }, { star: true });
    const msg = await addMsg(u.userId, 'a6'); // from news@x.com（含 news）
    await applyAiCategoryRules(env, msg, { hasListUnsubscribe: false, firstInsert: true }, '電子報');
    expect((await env.DB.prepare(`SELECT is_starred FROM messages WHERE id = 'a6'`).first<{ is_starred: number }>())?.is_starred).toBe(1);
  });

  it('userHasAiCategoryRule：成本守門', async () => {
    const a = await seedUser(env, 'a@miseroda.com');
    const b = await seedUser(env, 'b@miseroda.com');
    await addRule(a.userId, { aiCategory: '帳單' }, { star: true });
    await addRule(b.userId, { clauses: [{ field: 'from', op: 'contains', value: 'x' }] }, { star: true });
    expect(await userHasAiCategoryRule(env, a.userId)).toBe(true);
    expect(await userHasAiCategoryRule(env, b.userId)).toBe(false); // 只有非 AI 規則
  });
});
