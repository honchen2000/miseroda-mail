// 檔案庫 API：附件總覽 + 檔名搜尋 + 排除草稿暫存/垃圾桶
import { describe, expect, it } from 'vitest';
import { createExecutionContext, env } from 'cloudflare:test';
import worker from '../../src/worker/index';
import { seedUser } from './helpers/fixtures';

const BASE = 'https://mail.miseroda.com/api/v1';

async function get(path: string, cookies: { session: string; csrf: string }) {
  return worker.fetch(
    new Request(`${BASE}${path}`, {
      headers: { Cookie: `__Host-session=${encodeURIComponent(cookies.session)}; __Host-csrf=${encodeURIComponent(cookies.csrf)}` },
    }),
    env,
    createExecutionContext(),
  );
}

describe('files library', () => {
  it('lists attachments with message context; filters by name; excludes staging/trash/other-user', async () => {
    const hon = await seedUser(env, 'hon@miseroda.com', 'admin');
    const tom = await seedUser(env, 'tom@miseroda.com', 'user');
    const now = Date.now();

    const mkMsg = async (id: string, userId: string, folder: string, subject: string) => {
      await env.DB.prepare(
        `INSERT INTO threads (id, user_id, subject, last_message_at, message_count) VALUES (?, ?, ?, ?, 1)`,
      ).bind(`th_${id}`, userId, subject, now).run();
      await env.DB.prepare(
        `INSERT INTO messages (id, user_id, thread_id, direction, from_addr, from_name, to_addrs, subject, snippet, folder, received_at, created_at)
         VALUES (?, ?, ?, 'inbound', 'amy@example.com', 'Amy', '[]', ?, '', ?, ?, ?)`,
      ).bind(id, userId, `th_${id}`, subject, folder, now, now).run();
    };
    const mkAtt = async (id: string, userId: string, messageId: string | null, filename: string) => {
      await env.DB.prepare(
        `INSERT INTO attachments (id, message_id, user_id, filename, mime_type, size_bytes, disposition, r2_key, created_at)
         VALUES (?, ?, ?, ?, 'application/pdf', 1234, 'attachment', ?, ?)`,
      ).bind(id, messageId, userId, filename, `att/x/${id}`, now).run();
    };

    await mkMsg('msg_a', hon.userId, 'inbox', '報價');
    await mkAtt('att_a', hon.userId, 'msg_a', '報價單.pdf');
    await mkMsg('msg_b', hon.userId, 'trash', '舊檔');
    await mkAtt('att_b', hon.userId, 'msg_b', '作廢.pdf'); // trash → 排除
    await mkAtt('att_c', hon.userId, null, '草稿上傳.pdf'); // staging（無 message）→ 排除
    await mkMsg('msg_t', tom.userId, 'inbox', 'tom 的信');
    await mkAtt('att_t', tom.userId, 'msg_t', 'tom機密.pdf'); // 他人 → 排除

    const all = await (await get('/files', hon.cookies)).json<{ files: { id: string; filename: string; subject: string; folder: string }[] }>();
    expect(all.files.map((f) => f.id)).toEqual(['att_a']);
    expect(all.files[0].subject).toBe('報價');
    expect(all.files[0].folder).toBe('inbox');

    const hit = await (await get('/files?q=%E5%A0%B1%E5%83%B9', hon.cookies)).json<{ files: unknown[] }>(); // q=報價
    expect(hit.files).toHaveLength(1);
    const miss = await (await get('/files?q=zzz', hon.cookies)).json<{ files: unknown[] }>();
    expect(miss.files).toHaveLength(0);
  });
});
