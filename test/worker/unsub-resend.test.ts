// F2.8b：退訂記錄 + 「已退訂卻又寄來」ingest 自動歸檔。
// 端點記錄以真實 POST 驗；ingest 歸檔以「與 consumer 同一條 SQL」整合驗（consumer 全流程依賴佇列，不在此測）。
import { describe, expect, it } from 'vitest';
import { createExecutionContext, env } from 'cloudflare:test';
import worker from '../../src/worker/index';
import { seedUser } from './helpers/fixtures';

type Seed = Awaited<ReturnType<typeof seedUser>>;
function post(path: string, u: Seed, body?: unknown) {
  return worker.fetch(
    new Request(`https://mail.miseroda.com/api/v1${path}`, {
      method: 'POST',
      headers: {
        Cookie: `__Host-session=${encodeURIComponent(u.cookies.session)}; __Host-csrf=${encodeURIComponent(u.cookies.csrf)}`,
        'X-CSRF-Token': u.cookies.csrf,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body ?? {}),
    }),
    env,
    createExecutionContext(),
  );
}

describe('退訂記錄（F2.8b 端點）', () => {
  it('POST /messages/:id/unsubscribe 記下小寫寄件者', async () => {
    const u = await seedUser(env, 'u@miseroda.com');
    await env.DB.prepare(
      `INSERT INTO messages (id, user_id, thread_id, direction, from_addr, from_name, subject, snippet, folder, list_unsubscribe, received_at, created_at)
       VALUES ('m1', ?, 't1', 'inbound', 'News@Spam.com', '電子報', '優惠', '', 'inbox', ?, 0, 0)`,
    )
      .bind(u.userId, JSON.stringify({ httpUrl: null, mailto: 'mailto:unsub@spam.com', oneClick: false }))
      .run();
    const res = await post('/messages/m1/unsubscribe', u); // mailto 路徑 → 不打外部、直接回
    expect(res.status).toBe(200);
    const rec = await env.DB.prepare(`SELECT sender FROM unsubscribed_senders WHERE user_id = ?`).bind(u.userId).first<{ sender: string }>();
    expect(rec?.sender).toBe('news@spam.com');
  });
});

describe('已退訂仍寄送自動歸檔（F2.8b 整合）', () => {
  // 與 ingestConsumer 同一條：命中 unsubscribed_senders 且仍於 inbox → 歸檔 + 標記
  async function autoArchive(u: Seed, id: string, fromAddr: string) {
    const hit = await env.DB.prepare(`SELECT 1 FROM unsubscribed_senders WHERE user_id = ? AND sender = ?`)
      .bind(u.userId, fromAddr.toLowerCase())
      .first();
    if (hit) {
      await env.DB.prepare(`UPDATE messages SET folder = 'archive', unsub_resend = 1 WHERE id = ? AND user_id = ? AND folder = 'inbox'`)
        .bind(id, u.userId)
        .run();
    }
  }

  it('退訂者再寄→歸檔+標記；非退訂者不動；冪等', async () => {
    const u = await seedUser(env, 'u2@miseroda.com');
    await env.DB.prepare(`INSERT OR IGNORE INTO unsubscribed_senders (user_id, sender, created_at) VALUES (?, 'news@spam.com', 0)`).bind(u.userId).run();
    await env.DB.prepare(
      `INSERT INTO messages (id, user_id, thread_id, direction, from_addr, from_name, subject, snippet, folder, received_at, created_at)
       VALUES ('m2', ?, 't2', 'inbound', 'news@spam.com', '電子報', '又來了', '', 'inbox', 0, 0)`,
    ).bind(u.userId).run();
    await env.DB.prepare(
      `INSERT INTO messages (id, user_id, thread_id, direction, from_addr, from_name, subject, snippet, folder, received_at, created_at)
       VALUES ('m3', ?, 't3', 'inbound', 'friend@ok.com', '朋友', '哈囉', '', 'inbox', 0, 0)`,
    ).bind(u.userId).run();

    await autoArchive(u, 'm2', 'news@spam.com');
    await autoArchive(u, 'm3', 'friend@ok.com');
    expect(await env.DB.prepare(`SELECT folder, unsub_resend FROM messages WHERE id='m2'`).first<{ folder: string; unsub_resend: number }>()).toMatchObject({ folder: 'archive', unsub_resend: 1 });
    expect((await env.DB.prepare(`SELECT folder FROM messages WHERE id='m3'`).first<{ folder: string }>())?.folder).toBe('inbox');

    // 冪等：m2 已 archive（folder!=inbox）→ 再跑無作用、不報錯
    await autoArchive(u, 'm2', 'news@spam.com');
    expect((await env.DB.prepare(`SELECT folder FROM messages WHERE id='m2'`).first<{ folder: string }>())?.folder).toBe('archive');
  });

  it('使用者已手動搬離 inbox（規則先歸 spam）→ 不被改寫', async () => {
    const u = await seedUser(env, 'u3@miseroda.com');
    await env.DB.prepare(`INSERT OR IGNORE INTO unsubscribed_senders (user_id, sender, created_at) VALUES (?, 'news@spam.com', 0)`).bind(u.userId).run();
    await env.DB.prepare(
      `INSERT INTO messages (id, user_id, thread_id, direction, from_addr, from_name, subject, snippet, folder, received_at, created_at)
       VALUES ('m4', ?, 't4', 'inbound', 'news@spam.com', '電子報', 'x', '', 'spam', 0, 0)`,
    ).bind(u.userId).run();
    await autoArchive(u, 'm4', 'news@spam.com');
    expect((await env.DB.prepare(`SELECT folder FROM messages WHERE id='m4'`).first<{ folder: string }>())?.folder).toBe('spam'); // 只動 inbox
  });
});
