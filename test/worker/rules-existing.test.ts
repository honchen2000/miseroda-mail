// 規則套用到既有信：runRuleOnExisting 的 preview（不異動）/ apply（套用動作）/ 重跑冪等。
import { describe, expect, it } from 'vitest';
import { createExecutionContext, env } from 'cloudflare:test';
import worker from '../../src/worker/index';
import { runRuleOnExisting } from '../../src/worker/email/rulesEngine';
import { mockEmailMessage, plainEmail, seedUser } from './helpers/fixtures';

function quietEnv() {
  return { ...env, INGEST_QUEUE: { send: async () => {} } } as unknown as typeof env;
}

async function countFolder(userId: string, folder: string): Promise<number> {
  const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM messages WHERE user_id = ? AND folder = ?`)
    .bind(userId, folder)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

function postRun(path: string, cookies: { session: string; csrf: string }, body: unknown) {
  return worker.fetch(
    new Request(`https://mail.miseroda.com/api/v1${path}`, {
      method: 'POST',
      headers: {
        Cookie: `__Host-session=${encodeURIComponent(cookies.session)}; __Host-csrf=${encodeURIComponent(cookies.csrf)}`,
        'X-CSRF-Token': cookies.csrf,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
    quietEnv(),
    createExecutionContext(),
  );
}

describe('run rule on existing inbox mail', () => {
  it('preview 不異動、apply 套用動作、重跑冪等、不存在的規則回 null', async () => {
    const qenv = quietEnv();
    const hon = await seedUser(env, 'hon@miseroda.com', 'admin');
    // 3 封入站：2 封 promo@shop.com（將符合）、1 封 friend@x.com（不符合）
    for (const from of ['promo@shop.com', 'promo@shop.com', 'friend@x.com']) {
      await worker.email(
        mockEmailMessage(plainEmail({ to: 'hon@miseroda.com', from, subject: '測試' })).message,
        qenv,
        createExecutionContext(),
      );
    }
    // 規則：寄件者含 shop.com → 移至封存
    await env.DB.prepare(
      `INSERT INTO rules (id, user_id, name, conditions, actions, enabled, priority, created_at) VALUES (?,?,?,?,?,1,0,?)`,
    )
      .bind(
        'rul_test',
        hon.userId,
        '促銷歸檔',
        JSON.stringify({ clauses: [{ field: 'from', op: 'contains', value: 'shop.com' }] }),
        JSON.stringify({ moveToFolder: 'archive' }),
        Date.now(),
      )
      .run();

    // preview：符合 2、未套用、收件匣仍 3 封
    const preview = await runRuleOnExisting(env, hon.userId, 'rul_test', { dryRun: true });
    expect(preview?.matched).toBe(2);
    expect(preview?.applied).toBe(0);
    expect(await countFolder(hon.userId, 'inbox')).toBe(3);

    // apply：套用 2，shop 信移封存、friend 留收件匣
    const applied = await runRuleOnExisting(env, hon.userId, 'rul_test', { dryRun: false });
    expect(applied?.applied).toBe(2);
    expect(await countFolder(hon.userId, 'archive')).toBe(2);
    expect(await countFolder(hon.userId, 'inbox')).toBe(1);

    // 冪等：重跑 preview 不再符合（已移出收件匣）
    const again = await runRuleOnExisting(env, hon.userId, 'rul_test', { dryRun: true });
    expect(again?.matched).toBe(0);

    // 不存在的規則 → null
    expect(await runRuleOnExisting(env, hon.userId, 'rul_nope', { dryRun: true })).toBeNull();
  });

  it('跨使用者：他人不能對你的規則執行套用（HTTP 404、零異動）', async () => {
    const hon = await seedUser(env, 'hon@miseroda.com', 'admin');
    const kai = await seedUser(env, 'kai@miseroda.com');
    // hon 建一條「移到垃圾桶」的破壞性規則
    await env.DB.prepare(
      `INSERT INTO rules (id, user_id, name, conditions, actions, enabled, priority, created_at) VALUES (?,?,?,?,?,1,0,?)`,
    )
      .bind(
        'rul_hon',
        hon.userId,
        'hon 規則',
        JSON.stringify({ clauses: [{ field: 'from', op: 'contains', value: 'x.com' }] }),
        JSON.stringify({ moveToFolder: 'trash' }),
        Date.now(),
      )
      .run();
    await worker.email(
      mockEmailMessage(plainEmail({ to: 'hon@miseroda.com', from: 'sender@x.com' })).message,
      quietEnv(),
      createExecutionContext(),
    );

    // kai 拿自己的 session 對 hon 的規則 POST /run → 404，且 hon 的信完全未動
    const res = await postRun('/rules/rul_hon/run', kai.cookies, { dryRun: false });
    expect(res.status).toBe(404);
    expect(await countFolder(hon.userId, 'inbox')).toBe(1);
    expect(await countFolder(hon.userId, 'trash')).toBe(0);
  });
});
