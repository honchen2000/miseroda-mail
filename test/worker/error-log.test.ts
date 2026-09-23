// F12.2：錯誤 ring buffer——logError 寫入/自身失敗吞掉、sweep 環形保留、admin 端點權限。
import { describe, expect, it } from 'vitest';
import { createExecutionContext, env } from 'cloudflare:test';
import worker from '../../src/worker/index';
import { logError } from '../../src/worker/lib/logError';
import { sweep } from '../../src/worker/jobs/sweep';
import { seedUser } from './helpers/fixtures';

const BASE = 'https://mail.miseroda.com/api/v1';

function adminGet(path: string, cookies: { session: string; csrf: string }) {
  return worker.fetch(
    new Request(`${BASE}${path}`, {
      headers: {
        Cookie: `__Host-session=${encodeURIComponent(cookies.session)}; __Host-csrf=${encodeURIComponent(cookies.csrf)}`,
        'X-CSRF-Token': cookies.csrf,
      },
    }),
    env,
    createExecutionContext(),
  );
}

describe('F12.2 logError', () => {
  it('寫入 error_log（scope/message/meta）；自身寫入失敗被吞（不 rethrow）', async () => {
    await logError(env, 'test.scope', new Error('boom'), { messageId: 'm1' });
    const row = await env.DB.prepare(`SELECT scope, message, meta FROM error_log WHERE scope = 'test.scope'`).first<{ scope: string; message: string; meta: string }>();
    expect(row?.scope).toBe('test.scope');
    expect(row?.message).toContain('boom');
    expect(JSON.parse(row!.meta).messageId).toBe('m1');

    // 自身失敗吞掉：傳一個 DB 會炸的 env（prepare 丟例外）→ logError 不可 rethrow
    const brokenEnv = { ...env, DB: { prepare() { throw new Error('db down'); } } } as unknown as typeof env;
    await expect(logError(brokenEnv, 'x', new Error('y'))).resolves.toBeUndefined();
  });
});

describe('F12.2 sweep 環形保留', () => {
  it('保留最近 500 筆、刪其餘', async () => {
    const now = Date.now();
    // 塞 505 筆，created_at 遞增（新的在後）
    for (let i = 0; i < 505; i++) {
      await env.DB.prepare(`INSERT INTO error_log (id, scope, message, created_at) VALUES (?, 's', 'm', ?)`)
        .bind(`e${i}`, now - (505 - i) * 1000)
        .run();
    }
    await sweep(env);
    const cnt = await env.DB.prepare(`SELECT COUNT(*) AS n FROM error_log`).first<{ n: number }>();
    expect(cnt!.n).toBe(500);
    // 最舊的 e0 被刪、最新的 e504 留著
    expect(await env.DB.prepare(`SELECT 1 FROM error_log WHERE id = 'e0'`).first()).toBeNull();
    expect(await env.DB.prepare(`SELECT 1 FROM error_log WHERE id = 'e504'`).first()).not.toBeNull();
  });
});

describe('F12.2 admin /errors', () => {
  it('admin 可讀 recent + byScope；非 admin 403', async () => {
    const admin = await seedUser(env, 'admin@miseroda.com', 'admin');
    const user = await seedUser(env, 'user@miseroda.com');
    await logError(env, 'send.persist', new Error('e1'));
    await logError(env, 'send.persist', new Error('e2'));
    await logError(env, 'ingest.categorize', new Error('e3'));

    const res = await adminGet('/admin/errors', admin.cookies);
    expect(res.status).toBe(200);
    const data = await res.json<{ recent: { scope: string }[]; byScope: { scope: string; n: number }[] }>();
    expect(data.recent.length).toBeGreaterThanOrEqual(3);
    expect(data.byScope.find((s) => s.scope === 'send.persist')?.n).toBe(2);

    const forbidden = await adminGet('/admin/errors', user.cookies);
    expect(forbidden.status).toBe(403);
  });
});
