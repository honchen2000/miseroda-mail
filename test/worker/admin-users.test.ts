// Admin 帳號管理：email 前綴/顯示名稱編輯 + 永久刪除（級聯清理）
import { describe, expect, it } from 'vitest';
import { createExecutionContext, env } from 'cloudflare:test';
import worker from '../../src/worker/index';
import { seedUser } from './helpers/fixtures';

const BASE = 'https://mail.miseroda.com/api/v1';

async function apiCall(
  path: string,
  cookies: { session: string; csrf: string },
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
    env,
    createExecutionContext(),
  );
}

describe('admin user rename', () => {
  it('改前綴：驗證/唯一性/保留字；改名後站內寄信走新址、舊址 400', async () => {
    const hon = await seedUser(env, 'hon@miseroda.com', 'admin');
    const tom = await seedUser(env, 'tom95241@miseroda.com');

    // 格式錯誤（大寫會被寬容轉小寫，不在此列）
    for (const bad of ['-tom', 'tom-', 'a+b', '中文', 'a b']) {
      const res = await apiCall(`/admin/users/${tom.userId}`, hon.cookies, {
        method: 'PATCH',
        body: { emailLocal: bad },
      });
      expect([400]).toContain(res.status);
    }
    // 保留字
    expect(
      (await apiCall(`/admin/users/${tom.userId}`, hon.cookies, { method: 'PATCH', body: { emailLocal: 'digest' } }))
        .status,
    ).toBe(400);
    // 撞既有帳號
    expect(
      (await apiCall(`/admin/users/${tom.userId}`, hon.cookies, { method: 'PATCH', body: { emailLocal: 'hon' } }))
        .status,
    ).toBe(409);

    // 正常改名 + 顯示名稱
    const ok = await apiCall(`/admin/users/${tom.userId}`, hon.cookies, {
      method: 'PATCH',
      body: { emailLocal: 'tom', displayName: 'Tom Chen' },
    });
    expect(ok.status).toBe(200);
    const row = await env.DB.prepare(`SELECT email, display_name FROM users WHERE id = ?`)
      .bind(tom.userId)
      .first<{ email: string; display_name: string }>();
    expect(row).toEqual({ email: 'tom@miseroda.com', display_name: 'Tom Chen' });

    // 站內寄信：新址通、舊址 400 unknown_internal_recipient
    expect(
      (await apiCall('/messages/send', hon.cookies, {
        body: { to: ['tom@miseroda.com'], subject: '新址測試', text: 'hi', undoWindowSec: 0 },
      })).status,
    ).toBe(200);
    const stale = await apiCall('/messages/send', hon.cookies, {
      body: { to: ['tom95241@miseroda.com'], subject: '舊址測試', text: 'hi', undoWindowSec: 0 },
    });
    expect(stale.status).toBe(400);
    expect(((await stale.json()) as { error: string }).error).toBe('unknown_internal_recipient');

    // admin 可改自己的前綴；非 admin 不可碰管理端點
    expect(
      (await apiCall(`/admin/users/${hon.userId}`, hon.cookies, { method: 'PATCH', body: { emailLocal: 'hon-chen' } }))
        .status,
    ).toBe(200);
    expect(
      (await apiCall(`/admin/users/${hon.userId}`, tom.cookies, { method: 'PATCH', body: { emailLocal: 'pwned' } }))
        .status,
    ).toBe(403);

    // 稽核紀錄落地
    const auditRows = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM audit_log WHERE action = 'admin.user.update'`,
    ).first<{ n: number }>();
    expect(auditRows?.n).toBeGreaterThanOrEqual(2);
  });
});

describe('admin user delete', () => {
  it('防呆（active/自己/不存在）＋級聯清除 D1/R2/FTS、稽核保留', async () => {
    const hon = await seedUser(env, 'hon@miseroda.com', 'admin');
    const bad = await seedUser(env, 'ptlchen060@miseroda.com');
    const now = Date.now();

    // 塞滿關聯資料
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO threads (id, user_id, subject, last_message_at, message_count) VALUES ('th_d', ?, 'x', ?, 1)`).bind(bad.userId, now),
      env.DB.prepare(
        `INSERT INTO messages (id, user_id, thread_id, direction, from_addr, from_name, to_addrs, subject, snippet, folder, received_at, created_at)
         VALUES ('msg_d', ?, 'th_d', 'inbound', 'a@b.c', 'A', '[]', '刪我', '', 'inbox', ?, ?)`,
      ).bind(bad.userId, now, now),
      env.DB.prepare(
        `INSERT INTO attachments (id, message_id, user_id, filename, mime_type, size_bytes, disposition, r2_key, created_at)
         VALUES ('att_d', 'msg_d', ?, 'f.pdf', 'application/pdf', 10, 'attachment', 'att/${'X'}/x', ?)`,
      ).bind(bad.userId, now),
      env.DB.prepare(`INSERT INTO labels (id, user_id, name, color, created_at) VALUES ('lb_d', ?, 'L', '#FFFFFF', ?)`).bind(bad.userId, now),
      env.DB.prepare(`INSERT INTO message_labels (message_id, label_id) VALUES ('msg_d', 'lb_d')`),
      env.DB.prepare(`INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at) VALUES ('ps_d', ?, 'https://p.example/1', 'k', 'a', ?)`).bind(bad.userId, now),
      env.DB.prepare(`INSERT INTO contacts (user_id, email, custom_name, note, created_at, updated_at) VALUES (?, 'x@y.z', 'X', '', ?, ?)`).bind(bad.userId, now, now),
      env.DB.prepare(`INSERT INTO follow_ups (id, user_id, message_id, thread_id, subject, due_at, await_reply, ref_at, status, created_at) VALUES ('fup_d', ?, 'msg_d', 'th_d', '刪我', ?, 0, 0, 'pending', ?)`).bind(bad.userId, now, now),
      env.DB.prepare(`INSERT INTO recovery_tokens (id, user_id, token_hash, created_by, created_at, expires_at) VALUES ('rec_d', ?, 'hash_d', NULL, ?, ?)`).bind(bad.userId, now, now + 3600_000),
    ]);
    for (const key of [`raw/${bad.userId}/msg_d.eml`, `html/${bad.userId}/msg_d.html`, `att/${bad.userId}/msg_d/att_d`, `upload/${bad.userId}/u1`, `avatar/${bad.userId}/1`]) {
      await env.MAIL_STORE.put(key, 'data');
    }
    await env.DB_FTS.prepare(`INSERT INTO msg_map (message_id, user_id) VALUES ('msg_d', ?)`).bind(bad.userId).run();

    // usage 預覽
    const usage = await (await apiCall(`/admin/users/${bad.userId}/usage`, hon.cookies)).json<{ messages: number; attachments: number }>();
    expect(usage).toMatchObject({ messages: 1, attachments: 1 });

    // 防呆：active 不可刪
    expect((await apiCall(`/admin/users/${bad.userId}`, hon.cookies, { method: 'DELETE' })).status).toBe(400);
    // 防呆：不能刪自己（即使想辦法停用也輪不到——先測 active 的自己）
    expect((await apiCall(`/admin/users/${hon.userId}`, hon.cookies, { method: 'DELETE' })).status).toBe(400);
    // 防呆：不存在
    expect((await apiCall(`/admin/users/usr_nope`, hon.cookies, { method: 'DELETE' })).status).toBe(404);

    // 停用 → 刪除
    expect(
      (await apiCall(`/admin/users/${bad.userId}`, hon.cookies, { method: 'PATCH', body: { status: 'disabled' } }))
        .status,
    ).toBe(200);
    const del = await apiCall(`/admin/users/${bad.userId}`, hon.cookies, { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect(((await del.json()) as { deleted: { messages: number } }).deleted.messages).toBe(1);

    // D1 全鏈歸零
    for (const table of ['users', 'messages', 'threads', 'attachments', 'labels', 'sessions', 'credentials', 'user_settings', 'contacts', 'push_subscriptions', 'follow_ups', 'recovery_tokens']) {
      const col = table === 'users' ? 'id' : 'user_id';
      const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?`).bind(bad.userId).first<{ n: number }>();
      expect(n?.n, table).toBe(0);
    }
    const ml = await env.DB.prepare(`SELECT COUNT(*) AS n FROM message_labels WHERE message_id = 'msg_d'`).first<{ n: number }>();
    expect(ml?.n).toBe(0);

    // R2 清空
    for (const prefix of ['raw/', 'html/', 'att/', 'upload/', 'avatar/']) {
      const listed = await env.MAIL_STORE.list({ prefix: `${prefix}${bad.userId}/` });
      expect(listed.objects, prefix).toHaveLength(0);
    }
    // FTS 清空
    const map = await env.DB_FTS.prepare(`SELECT COUNT(*) AS n FROM msg_map WHERE user_id = ?`).bind(bad.userId).first<{ n: number }>();
    expect(map?.n).toBe(0);

    // 稽核：刪除紀錄落地、歷史 audit 保留
    const delAudit = await env.DB.prepare(
      `SELECT meta FROM audit_log WHERE action = 'admin.user.delete' AND target_id = ?`,
    ).bind(bad.userId).first<{ meta: string }>();
    expect(delAudit).toBeTruthy();
    expect(JSON.parse(delAudit!.meta)).toMatchObject({ email: 'ptlchen060@miseroda.com', messages: 1 });

    // 旁觀者不受影響
    const honRow = await env.DB.prepare(`SELECT COUNT(*) AS n FROM users WHERE id = ?`).bind(hon.userId).first<{ n: number }>();
    expect(honRow?.n).toBe(1);
  });
});
