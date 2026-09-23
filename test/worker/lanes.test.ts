// 分流 lane：電子報（List-Unsubscribe）/ 收據（主旨關鍵字）虛擬資料夾 + 側欄計數，排除垃圾桶。
import { describe, expect, it } from 'vitest';
import { createExecutionContext, env } from 'cloudflare:test';
import worker from '../../src/worker/index';
import { mockEmailMessage, plainEmail, seedUser } from './helpers/fixtures';

const BASE = 'https://mail.miseroda.com/api/v1';
function quietEnv() {
  return { ...env, INGEST_QUEUE: { send: async () => {} } } as unknown as typeof env;
}
function get(path: string, cookies: { session: string; csrf: string }) {
  return worker.fetch(
    new Request(`${BASE}${path}`, {
      headers: {
        Cookie: `__Host-session=${encodeURIComponent(cookies.session)}; __Host-csrf=${encodeURIComponent(cookies.csrf)}`,
        'X-CSRF-Token': cookies.csrf,
      },
    }),
    quietEnv(),
    createExecutionContext(),
  );
}
async function ids(path: string, cookies: { session: string; csrf: string }) {
  const r = await (await get(path, cookies)).json<{ items: { id: string }[] }>();
  return r.items.map((i) => i.id).sort();
}

describe('newsletter / receipt lanes', () => {
  it('電子報（List-Unsubscribe）與收據（主旨關鍵字）虛擬資料夾 + 計數，排除垃圾桶', async () => {
    const hon = await seedUser(env, 'hon@miseroda.com', 'admin');
    const ingest = async (subject: string) => {
      await worker.email(mockEmailMessage(plainEmail({ subject })).message, quietEnv(), createExecutionContext());
      return (await env.DB.prepare(`SELECT id FROM messages WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`)
        .bind(hon.userId)
        .first<{ id: string }>())!.id;
    };
    const news = await ingest('每週科技新聞');
    const receipt = await ingest('您的訂單收據 #1234');
    const plain = await ingest('午餐約嗎');
    const trashedNews = await ingest('促銷快訊');

    // news + trashedNews 有 List-Unsubscribe；trashedNews 丟垃圾桶；其餘確保在 inbox（避免 spam 評分干擾）
    await env.DB.prepare(`UPDATE messages SET list_unsubscribe = '<https://e.test/unsub>' WHERE id IN (?, ?)`)
      .bind(news, trashedNews)
      .run();
    await env.DB.prepare(`UPDATE messages SET folder = 'inbox' WHERE id IN (?, ?, ?)`).bind(news, receipt, plain).run();
    await env.DB.prepare(`UPDATE messages SET folder = 'trash' WHERE id = ?`).bind(trashedNews).run();

    // 電子報 lane = 有 List-Unsubscribe，且排除垃圾桶（trashedNews 不在）
    expect(await ids('/messages?folder=newsletter', hon.cookies)).toEqual([news]);
    // 收據 lane = 主旨含「收據/訂單」關鍵字
    expect(await ids('/messages?folder=receipt', hon.cookies)).toEqual([receipt]);

    const c = await (await get('/mailbox/counts', hon.cookies)).json<{ newsletter: number; receipt: number }>();
    expect(c.newsletter).toBe(1); // trashedNews 被排除
    expect(c.receipt).toBe(1);
  });
});
