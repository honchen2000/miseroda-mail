// F2.3：寄出含問句的信 → 自動建 await_reply 跟進。
// shouldTrackReply 為純函式；follow_up 落地 SQL（await_reply=1、ref_at=寄出時間）以整合方式驗證。
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { seedUser } from './helpers/fixtures';
import { shouldTrackReply } from '../../src/worker/api/send';

const R = (to: string[] = ['a@x.com']) => ({ subject: '', text: '', to, cc: [], bcc: [] });

describe('shouldTrackReply（F2.3 啟發式）', () => {
  it('含問號 / 請託語 → 追蹤；普通通知 → 不追蹤', () => {
    expect(shouldTrackReply({ ...R(), subject: '下週要開會嗎？' })).toBe(true);
    expect(shouldTrackReply({ ...R(), text: '麻煩你確認一下，謝謝' })).toBe(true);
    expect(shouldTrackReply({ ...R(), subject: '會議記錄', text: '附上昨天的記錄。' })).toBe(false);
  });
  it('無收件人 / 疑似群發(>5) → 不追蹤', () => {
    expect(shouldTrackReply({ ...R([]), subject: '在嗎？' })).toBe(false);
    expect(shouldTrackReply({ subject: '可以嗎？', text: '', to: ['1@x', '2@x', '3@x', '4@x', '5@x', '6@x'], cc: [], bcc: [] })).toBe(false);
    expect(shouldTrackReply({ subject: '可以嗎？', text: '', to: ['1@x', '2@x'], cc: ['3@x'], bcc: [] })).toBe(true);
  });
});

describe('await_reply follow_up 落地（F2.3 整合）', () => {
  it('對已寄出信建 await_reply 跟進：await_reply=1、ref_at=寄出時間、due=now+3d', async () => {
    const u = await seedUser(env, 'u@miseroda.com');
    const sentAt = 1_750_000_000_000;
    // 模擬寄件備份（outbound, folder=sent, received_at=寄出時間）
    await env.DB.prepare(
      `INSERT INTO messages (id, user_id, thread_id, direction, from_addr, from_name, subject, snippet, folder, received_at, created_at)
       VALUES ('snt1', ?, 'thr1', 'outbound', ?, '我', '可以幫忙嗎？', '', 'sent', ?, ?)`,
    )
      .bind(u.userId, 'u@miseroda.com', sentAt, sentAt)
      .run();
    const now = sentAt + 1000;
    // 與 sendConsumer 同一條 INSERT...SELECT
    await env.DB.prepare(
      `INSERT OR IGNORE INTO follow_ups (id, user_id, message_id, thread_id, subject, due_at, await_reply, ref_at, status, created_at)
       SELECT ?, user_id, id, thread_id, subject, ?, 1, received_at, 'pending', ?
       FROM messages WHERE id = ? AND user_id = ?`,
    )
      .bind('fu1', now + 3 * 86_400_000, now, 'snt1', u.userId)
      .run();
    const fu = await env.DB.prepare(`SELECT message_id, thread_id, await_reply, ref_at, due_at, status FROM follow_ups WHERE id = 'fu1'`)
      .first<{ message_id: string; thread_id: string; await_reply: number; ref_at: number; due_at: number; status: string }>();
    expect(fu).toMatchObject({ message_id: 'snt1', thread_id: 'thr1', await_reply: 1, ref_at: sentAt, status: 'pending' });
    expect(fu!.due_at).toBe(now + 3 * 86_400_000);
  });
});
