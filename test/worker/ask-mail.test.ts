// F10.1：Ask AI 信箱問答 —— 關鍵字清洗（純函式）/ FTS 檢索管線（隔離/去重/排除 trash）/ 端點含快取。
import { describe, expect, it } from 'vitest';
import { createExecutionContext, env } from 'cloudflare:test';
import worker from '../../src/worker/index';
import { seedUser } from './helpers/fixtures';
import { parseKeywords, retrieveAskContext } from '../../src/worker/lib/askMail';

const BASE = 'https://mail.miseroda.com/api/v1';

async function apiCall(
  path: string,
  cookies: { session: string; csrf: string },
  targetEnv: typeof env,
  opts: { method?: string; body?: unknown } = {},
) {
  const headers: Record<string, string> = {
    Cookie: `__Host-session=${encodeURIComponent(cookies.session)}; __Host-csrf=${encodeURIComponent(cookies.csrf)}`,
    'X-CSRF-Token': cookies.csrf,
  };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  return worker.fetch(
    new Request(`${BASE}${path}`, {
      method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }),
    targetEnv,
    createExecutionContext(),
  );
}

let seq = 0;
/** 主庫 + FTS 庫一起種（模擬 ingest 後狀態） */
async function seedIndexed(userId: string, subject: string, body: string, folder = 'inbox') {
  seq += 1;
  const id = `ask${seq}`;
  const now = Date.now() - seq * 1000;
  await env.DB.prepare(
    `INSERT INTO messages (id, user_id, thread_id, direction, from_addr, from_name, subject, snippet, folder, is_read, received_at, created_at)
     VALUES (?, ?, ?, 'inbound', 'bill@utility.com', '台電', ?, ?, ?, 1, ?, ?)`,
  )
    .bind(id, userId, `t-${id}`, subject, body.slice(0, 100), folder, now, now)
    .run();
  await env.DB_FTS.prepare(`INSERT INTO msg_map (message_id, user_id) VALUES (?, ?)`).bind(id, userId).run();
  const map = await env.DB_FTS.prepare(`SELECT fts_rowid FROM msg_map WHERE message_id = ?`).bind(id).first<{ fts_rowid: number }>();
  await env.DB_FTS.prepare(`INSERT INTO messages_fts (rowid, subject, from_addr, snippet, body_text) VALUES (?, ?, ?, ?, ?)`)
    .bind(map!.fts_rowid, subject, '台電 bill@utility.com', body.slice(0, 100), body)
    .run();
  return id;
}

describe('F10.1 Ask AI 信箱問答', () => {
  it('parseKeywords：清洗引號/前綴/分隔/去重/上限 4，整句過長丟棄', () => {
    expect(parseKeywords('「水電費」, 台電，帳單')).toEqual(['水電費', '台電', '帳單']);
    expect(parseKeywords('關鍵字：包裹, 包裹, 黑貓')).toEqual(['包裹', '黑貓']);
    expect(parseKeywords('a, b, c, d, e')).toEqual(['a', 'b', 'c', 'd']);
    expect(parseKeywords('這是一整句完全沒有照格式輸出的回答所以應該被丟棄因為它太長了超過四十個字元的上限沒錯就是這樣')).toEqual([]);
  });

  it('檢索：FTS 命中內文、聯集去重、排除 trash/spam、使用者隔離、body 節錄', async () => {
    const hon = await seedUser(env, 'hon@miseroda.com');
    const kai = await seedUser(env, 'kai@miseroda.com');
    const hit = await seedIndexed(hon.userId, '2026 年 6 月電費帳單', '本期水電費共計 1,234 元，請於 7 月 15 日前繳納。');
    await seedIndexed(hon.userId, '促銷', '完全無關的內容');
    const trashed = await seedIndexed(hon.userId, '舊水電費', '水電費 999 元', 'trash');
    await seedIndexed(kai.userId, '別人的水電費', '水電費 555 元');

    const out = await retrieveAskContext(env, hon.userId, ['水電費', '電費帳單']);
    expect(out.map((s) => s.id)).toEqual([hit]); // trash 排除、他人排除、雙關鍵字命中同信不重複
    expect(out[0].excerpt).toContain('1,234');
    expect(out.some((s) => s.id === trashed)).toBe(false);
  });

  it('端點：mock AI 全流程回答＋來源；第二次同問題走 KV 快取（cached=true）', async () => {
    const hon = await seedUser(env, 'hon@miseroda.com');
    await seedIndexed(hon.userId, '6 月電費帳單', '本期水電費共計 1,234 元。');
    let calls = 0;
    const aiEnv = {
      ...env,
      AI: {
        run: async () => {
          calls += 1;
          return { response: calls === 1 ? '水電費' : '上次的水電費是 1,234 元 [1]' };
        },
      },
    } as unknown as typeof env;

    const r1 = await apiCall('/ai/ask', hon.cookies, aiEnv, { body: { question: '上次水電費多少？' } });
    expect(r1.status).toBe(200);
    const j1 = (await r1.json()) as { answer: string; sources: { id: string }[]; cached: boolean };
    expect(j1.answer).toContain('1,234');
    expect(j1.sources.length).toBe(1);
    expect(j1.cached).toBe(false);
    expect(calls).toBe(2); // 抽關鍵字 + 作答

    const r2 = await apiCall('/ai/ask', hon.cookies, aiEnv, { body: { question: '上次水電費多少？' } });
    const j2 = (await r2.json()) as { cached: boolean };
    expect(j2.cached).toBe(true);
    expect(calls).toBe(2); // 快取命中，不再燒 AI
  });

  it('端點：檢索落空 → 誠實回 no_match（不呼叫作答 AI）', async () => {
    const hon = await seedUser(env, 'hon@miseroda.com');
    let calls = 0;
    const aiEnv = { ...env, AI: { run: async () => { calls += 1; return { response: '獨角獸' }; } } } as unknown as typeof env;
    const r = await apiCall('/ai/ask', hon.cookies, aiEnv, { body: { question: '有獨角獸的信嗎？' } });
    const j = (await r.json()) as { answer: string | null; reason?: string };
    expect(j.answer).toBeNull();
    expect(j.reason).toBe('no_match');
    expect(calls).toBe(1); // 只抽了關鍵字
  });
});
