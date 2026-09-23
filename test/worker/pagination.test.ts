// 訊息列表游標分頁（無限捲動依賴的 keyset 契約）：分頁覆蓋全部、不重複、順序正確、到底回 null。
import { describe, expect, it } from 'vitest';
import { createExecutionContext, env } from 'cloudflare:test';
import worker from '../../src/worker/index';
import { mockEmailMessage, plainEmail, seedUser } from './helpers/fixtures';

const BASE = 'https://mail.miseroda.com/api/v1';

function quietEnv() {
  return { ...env, INGEST_QUEUE: { send: async () => {} } } as unknown as typeof env;
}

async function apiGet(path: string, cookies: { session: string; csrf: string }, targetEnv: typeof env) {
  return worker.fetch(
    new Request(`${BASE}${path}`, {
      headers: {
        Cookie: `__Host-session=${encodeURIComponent(cookies.session)}; __Host-csrf=${encodeURIComponent(cookies.csrf)}`,
        'X-CSRF-Token': cookies.csrf,
      },
    }),
    targetEnv,
    createExecutionContext(),
  );
}

interface Page { items: { id: string; ts: number }[]; nextCursor: string | null }

describe('message list cursor pagination', () => {
  it('paginates the full set with no gaps, no dups, newest-first, null at end', async () => {
    const qenv = quietEnv();
    const hon = await seedUser(env, 'hon@miseroda.com', 'admin');
    // 投遞 5 封，逐一錯開 received_at（mockEmail 用 Date 標頭固定 → 直接改 DB 確保嚴格遞增）
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      await worker.email(mockEmailMessage(plainEmail({ subject: `分頁 ${i}`, body: `body ${i}` })).message, qenv, createExecutionContext());
      const row = (await env.DB.prepare(
        `SELECT id FROM messages WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`,
      ).bind(hon.userId).first<{ id: string }>())!;
      // 嚴格遞增 received_at，避免同毫秒讓 keyset 走 id tiebreak（仍應正確，但讓斷言更清楚）
      await env.DB.prepare(`UPDATE messages SET received_at = ? WHERE id = ?`).bind(1_000_000 + i * 1000, row.id).run();
      ids.push(row.id);
    }

    // 以每頁 2 筆分頁，收集所有 id
    const collected: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url = `/messages?folder=inbox&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const page: Page = await (await apiGet(url, hon.cookies, qenv)).json();
      expect(page.items.length).toBeLessThanOrEqual(2);
      collected.push(...page.items.map((m) => m.id));
      cursor = page.nextCursor;
      if (++pages > 10) throw new Error('pagination did not terminate');
    } while (cursor);

    // 全部 5 封都出現、不重複
    expect(collected.length).toBe(5);
    expect(new Set(collected).size).toBe(5);
    // 新到舊（received_at desc）：ids 是舊→新插入，故反序
    expect(collected).toEqual([...ids].reverse());
  });

  it('limit caps page size and a single page returns null cursor', async () => {
    const qenv = quietEnv();
    const hon = await seedUser(env, 'hon@miseroda.com', 'admin');
    await worker.email(mockEmailMessage(plainEmail({ subject: '只有一封' })).message, qenv, createExecutionContext());
    const page: Page = await (await apiGet('/messages?folder=inbox&limit=50', hon.cookies, qenv)).json();
    expect(page.items.length).toBe(1);
    expect(page.nextCursor).toBeNull();
  });

  // F9：負數/0/非數字 limit 曾讓 SQL LIMIT 失去上限、並讀取 items[-1] 而丟 500
  it('clamps out-of-range limit instead of throwing', async () => {
    const qenv = quietEnv();
    const hon = await seedUser(env, 'hon@miseroda.com', 'admin');
    for (let i = 0; i < 2; i++) {
      await worker.email(mockEmailMessage(plainEmail({ subject: `夾擠 ${i}` })).message, qenv, createExecutionContext());
    }
    for (const bad of ['-1', '-1000', '0', 'abc']) {
      const res = await apiGet(`/messages?folder=inbox&limit=${bad}`, hon.cookies, qenv);
      expect(res.status).toBe(200);
      const page: Page = await res.json();
      expect(page.items.length).toBeGreaterThanOrEqual(1);
      expect(page.items.length).toBeLessThanOrEqual(2);
    }
  });
});
