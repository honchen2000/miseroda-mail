// F4.1a：規則新條件（cc/recipient/has_attachment/size/older_than）+ stopProcessing 動作。
import { describe, expect, it } from 'vitest';
import { createExecutionContext, env } from 'cloudflare:test';
import worker from '../../src/worker/index';
import { seedUser } from './helpers/fixtures';
import { applyRules, applyAiCategoryRules, matchesConditions } from '../../src/worker/email/rulesEngine';

function postRule(u: Awaited<ReturnType<typeof seedUser>>, body: unknown) {
  return worker.fetch(
    new Request('https://mail.miseroda.com/api/v1/rules', {
      method: 'POST',
      headers: {
        Cookie: `__Host-session=${encodeURIComponent(u.cookies.session)}; __Host-csrf=${encodeURIComponent(u.cookies.csrf)}`,
        'X-CSRF-Token': u.cookies.csrf,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
    env,
    createExecutionContext(),
  );
}

const base = { from: '', subject: '', to: '', hasListUnsubscribe: false };

describe('matchesConditions 新條件（F4.1a，純函式）', () => {
  it('cc / recipient 子句', () => {
    expect(matchesConditions({ clauses: [{ field: 'cc', op: 'contains', value: 'boss' }] }, { ...base, cc: 'boss@x.com' })).toBe(true);
    expect(matchesConditions({ clauses: [{ field: 'cc', op: 'contains', value: 'boss' }] }, { ...base, cc: 'a@x.com' })).toBe(false);
    expect(matchesConditions({ clauses: [{ field: 'recipient', op: 'contains', value: 'team' }] }, { ...base, recipient: 'me@x team@x' })).toBe(true);
  });
  it('hasAttachment 嚴格比對；欄位未提供 → 不成立（保守）', () => {
    expect(matchesConditions({ hasAttachment: true }, { ...base, hasAttachment: true })).toBe(true);
    expect(matchesConditions({ hasAttachment: true }, { ...base, hasAttachment: false })).toBe(false);
    expect(matchesConditions({ hasAttachment: false }, { ...base, hasAttachment: false })).toBe(true);
    expect(matchesConditions({ hasAttachment: true }, base)).toBe(false);
  });
  it('sizeOverKb / olderThanDays 數值；欄位未提供 → 保守不成立', () => {
    expect(matchesConditions({ sizeOverKb: 100 }, { ...base, sizeBytes: 200 * 1024 })).toBe(true);
    expect(matchesConditions({ sizeOverKb: 100 }, { ...base, sizeBytes: 50 * 1024 })).toBe(false);
    expect(matchesConditions({ sizeOverKb: 100 }, base)).toBe(false);
    expect(matchesConditions({ olderThanDays: 7 }, { ...base, ageMs: 8 * 86_400_000 })).toBe(true);
    expect(matchesConditions({ olderThanDays: 7 }, { ...base, ageMs: 1 * 86_400_000 })).toBe(false);
    expect(matchesConditions({ olderThanDays: 7 }, base)).toBe(false);
  });
});

let n = 0;
async function addRule(userId: string, priority: number, conditions: unknown, actions: unknown) {
  n += 1;
  await env.DB.prepare(
    `INSERT INTO rules (id, user_id, name, conditions, actions, enabled, priority, created_at) VALUES (?, ?, 'r', ?, ?, 1, ?, 0)`,
  ).bind(`fx-${n}`, userId, JSON.stringify(conditions), JSON.stringify(actions), priority).run();
}
async function addMsg(userId: string, id: string, fromAddr: string) {
  await env.DB.prepare(
    `INSERT INTO messages (id, user_id, thread_id, direction, from_addr, from_name, subject, snippet, folder, received_at, created_at)
     VALUES (?, ?, ?, 'inbound', ?, 'X', 's', '', 'inbox', 0, 0)`,
  ).bind(id, userId, `t-${id}`, fromAddr).run();
  return { id, user_id: userId, from_addr: fromAddr, from_name: 'X', subject: 's', folder: 'inbox', to_addrs: '' };
}

describe('applyRules stopProcessing（F4.1a）', () => {
  it('高優先 stop 規則命中 → 低優先規則不套用', async () => {
    const u = await seedUser(env, 'u@miseroda.com');
    await addRule(u.userId, 1, { clauses: [{ field: 'from', op: 'contains', value: 'spam' }] }, { star: true, stopProcessing: true });
    await addRule(u.userId, 2, { clauses: [{ field: 'from', op: 'contains', value: 'spam' }] }, { moveToFolder: 'archive' });
    const msg = await addMsg(u.userId, 'm1', 'spammer@x.com');
    await applyRules(env, msg, { hasListUnsubscribe: false, firstInsert: true });
    const row = await env.DB.prepare(`SELECT folder, is_starred FROM messages WHERE id='m1'`).first<{ folder: string; is_starred: number }>();
    expect(row?.is_starred).toBe(1); // rule1 套用
    expect(row?.folder).toBe('inbox'); // rule2 被 stop 擋掉
  });
  it('無 stop → 兩條都套用', async () => {
    const u = await seedUser(env, 'u2@miseroda.com');
    await addRule(u.userId, 1, { clauses: [{ field: 'from', op: 'contains', value: 'spam' }] }, { star: true });
    await addRule(u.userId, 2, { clauses: [{ field: 'from', op: 'contains', value: 'spam' }] }, { moveToFolder: 'archive' });
    const msg = await addMsg(u.userId, 'm2', 'spammer@x.com');
    await applyRules(env, msg, { hasListUnsubscribe: false, firstInsert: true });
    const row = await env.DB.prepare(`SELECT folder, is_starred FROM messages WHERE id='m2'`).first<{ folder: string; is_starred: number }>();
    expect(row?.is_starred).toBe(1);
    expect(row?.folder).toBe('archive'); // 兩條都套用
  });
});

describe('cross-pass stopProcessing（F4.1a 修復 [4]）', () => {
  it('stopAtPriority：第二趟跳過 priority 更大（更低優先序）的 AI 分類規則', async () => {
    const u = await seedUser(env, 'u3@miseroda.com');
    await addRule(u.userId, 5, { aiCategory: '電子報' }, { star: true });
    const msg = await addMsg(u.userId, 'm3', 'news@x.com');
    // 第一趟在 priority 3 停止 → 第二趟 priority 5 > 3 → 跳過
    await applyAiCategoryRules(env, { ...msg, folder: 'inbox' }, { hasListUnsubscribe: false, firstInsert: true, stopAtPriority: 3 }, '電子報');
    expect((await env.DB.prepare(`SELECT is_starred FROM messages WHERE id='m3'`).first<{ is_starred: number }>())?.is_starred).toBe(0);
  });
  it('無 stopAtPriority：第二趟正常套用', async () => {
    const u = await seedUser(env, 'u4@miseroda.com');
    await addRule(u.userId, 5, { aiCategory: '電子報' }, { star: true });
    const msg = await addMsg(u.userId, 'm4', 'news@x.com');
    await applyAiCategoryRules(env, { ...msg, folder: 'inbox' }, { hasListUnsubscribe: false, firstInsert: true }, '電子報');
    expect((await env.DB.prepare(`SELECT is_starred FROM messages WHERE id='m4'`).first<{ is_starred: number }>())?.is_starred).toBe(1);
  });
});

describe('動作 schema（F4.1a 修復 [7]）', () => {
  it('只送 stopProcessing:false → 400；stopProcessing:true → 200', async () => {
    const u = await seedUser(env, 'sc@miseroda.com');
    const cond = { clauses: [{ field: 'from', op: 'contains', value: 'x' }] };
    expect((await postRule(u, { name: 't1', conditions: cond, actions: { stopProcessing: false } })).status).toBe(400);
    expect((await postRule(u, { name: 't2', conditions: cond, actions: { stopProcessing: true } })).status).toBe(200);
  });
});

describe('規則 API：新條件/動作能存進去（F4.1a）', () => {
  it('POST /rules 帶 cc 子句 + hasAttachment + stopProcessing', async () => {
    const u = await seedUser(env, 'api@miseroda.com');
    const res = await worker.fetch(
      new Request('https://mail.miseroda.com/api/v1/rules', {
        method: 'POST',
        headers: {
          Cookie: `__Host-session=${encodeURIComponent(u.cookies.session)}; __Host-csrf=${encodeURIComponent(u.cookies.csrf)}`,
          'X-CSRF-Token': u.cookies.csrf,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: '大附件歸檔',
          conditions: { clauses: [{ field: 'cc', op: 'contains', value: 'team' }], hasAttachment: true, sizeOverKb: 500, olderThanDays: 30 },
          actions: { moveToFolder: 'archive', stopProcessing: true },
        }),
      }),
      env,
      createExecutionContext(),
    );
    expect(res.status).toBe(200);
    const stored = await env.DB.prepare(`SELECT conditions, actions FROM rules WHERE user_id = ?`).bind(u.userId).first<{ conditions: string; actions: string }>();
    const c = JSON.parse(stored!.conditions) as { clauses?: { field: string }[]; hasAttachment?: boolean; sizeOverKb?: number; olderThanDays?: number };
    const a = JSON.parse(stored!.actions) as { stopProcessing?: boolean };
    expect(c.clauses?.[0].field).toBe('cc');
    expect(c.hasAttachment).toBe(true);
    expect(c.sizeOverKb).toBe(500);
    expect(c.olderThanDays).toBe(30);
    expect(a.stopProcessing).toBe(true);
  });
});
