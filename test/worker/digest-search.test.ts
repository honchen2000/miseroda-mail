// 每日 AI 晨報 + 搜尋運算子
import { describe, expect, it } from 'vitest';
import { createExecutionContext, env } from 'cloudflare:test';
import worker from '../../src/worker/index';
import { attachmentEmail, mockEmailMessage, plainEmail, seedUser } from './helpers/fixtures';

const BASE = 'https://mail.miseroda.com/api/v1';

function quietEnv(extra: Record<string, unknown> = {}) {
  return { ...env, INGEST_QUEUE: { send: async () => {} }, ...extra } as unknown as typeof env;
}

async function apiCall(path: string, cookies: { session: string; csrf: string }, targetEnv: typeof env) {
  return worker.fetch(
    new Request(`${BASE}${path}`, {
      headers: { Cookie: `__Host-session=${encodeURIComponent(cookies.session)}; __Host-csrf=${encodeURIComponent(cookies.csrf)}` },
    }),
    targetEnv,
    createExecutionContext(),
  );
}

describe('daily digest', () => {
  it('creates a digest message only when enabled and unread exists', async () => {
    const aiStub = { run: async () => ({ response: '今天有幾封工作信等你 🐧' }) };
    const qenv = quietEnv({ AI: aiStub });
    const hon = await seedUser(env, 'hon@miseroda.com', 'admin');
    // user_settings 由 seedUser 不建立 → 補上
    await env.DB.prepare(`INSERT OR REPLACE INTO user_settings (user_id, signature, prefs, updated_at) VALUES (?, '', ?, ?)`)
      .bind(hon.userId, JSON.stringify({ dailyDigest: true }), Date.now())
      .run();

    // 兩封未讀
    await worker.email(mockEmailMessage(plainEmail({ subject: '工作信A' })).message, qenv, createExecutionContext());
    await worker.email(mockEmailMessage(plainEmail({ subject: '工作信B' })).message, qenv, createExecutionContext());

    const { runDailyDigest } = await import('../../src/worker/jobs/digest');
    await runDailyDigest(qenv);

    const digest = await env.DB.prepare(
      `SELECT subject, from_addr, folder FROM messages WHERE user_id = ? AND from_addr = 'digest@miseroda.com'`,
    )
      .bind(hon.userId)
      .first<{ subject: string; from_addr: string; folder: string }>();
    expect(digest).not.toBeNull();
    expect(digest!.subject).toContain('晨報');
    expect(digest!.folder).toBe('inbox');

    // 關閉的使用者不產生
    const kai = await seedUser(env, 'kai@miseroda.com');
    await env.DB.prepare(`INSERT OR REPLACE INTO user_settings (user_id, signature, prefs, updated_at) VALUES (?, '', '{}', ?)`)
      .bind(kai.userId, Date.now())
      .run();
    await worker.email(mockEmailMessage(plainEmail({ subject: 'k', to: 'kai@miseroda.com' }), { to: 'kai@miseroda.com' }).message, qenv, createExecutionContext());
    await runDailyDigest(qenv);
    const kaiDigest = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM messages WHERE user_id = ? AND from_addr = 'digest@miseroda.com'`,
    )
      .bind(kai.userId)
      .first<{ n: number }>();
    expect(kaiDigest!.n).toBe(0);
  });
});

describe('search operators', () => {
  it('from / has:attachment / is:unread / before-after', async () => {
    const qenv = quietEnv();
    const hon = await seedUser(env, 'hon@miseroda.com', 'admin');
    // ingest 以 envelope message.from 寫入 from_addr，故 envelope 也要設成 alice
    await worker.email(mockEmailMessage(plainEmail({ subject: '一般信', from: 'alice@example.com', fromName: 'Alice' }), { from: 'alice@example.com' }).message, qenv, createExecutionContext());
    await worker.email(mockEmailMessage(attachmentEmail()).message, qenv, createExecutionContext());

    const list = async (qs: string) =>
      (await (await apiCall(`/messages?folder=inbox&${qs}`, hon.cookies, qenv)).json<{ items: { id: string; subject: string; from: { addr: string } }[] }>()).items;

    const fromAlice = await list('from=alice');
    expect(fromAlice.every((m) => m.from.addr.includes('alice'))).toBe(true);
    expect(fromAlice.length).toBe(1);

    const withAtt = await list('hasAttachment=1');
    expect(withAtt.length).toBe(1);
    expect(withAtt[0].subject).toContain('小琉球');

    const unread = await list('isUnread=1');
    expect(unread.length).toBe(2); // 兩封都未讀

    const future = await list(`after=${Date.now() + 86400000}`);
    expect(future.length).toBe(0);
    const past = await list(`before=${Date.now() + 86400000}`);
    expect(past.length).toBe(2);
  });
});
