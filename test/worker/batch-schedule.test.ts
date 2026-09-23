// F17.3：依序寄出的後端契約。
// 批次功能完全建立在「對 N 封各呼叫既有的 /messages/send、帶遞增的 scheduleAt」之上，
// 前端沒有新端點、後端一行都沒改。這支測試就是釘住那個被依賴的契約：
// N 封各自落進 send_queue、scheduled_at 依序遞增、一律 status='scheduled' 且不立即投遞
// （排程件由每分鐘的 cron 撿件，見 src/worker/api/send.ts 的註解）。
import { describe, expect, it } from 'vitest';
import { createExecutionContext, env } from 'cloudflare:test';
import worker from '../../src/worker/index';
import { seedUser } from './helpers/fixtures';

const BASE = 'https://mail.miseroda.com/api/v1';

describe('依序寄出（批次排程）', () => {
  it('三封帶遞增 scheduleAt → send_queue 三列，scheduled_at 依序遞增、都不立即投遞', async () => {
    const u = await seedUser(env, `batch-${crypto.randomUUID().slice(0, 8)}@miseroda.com`);
    const enqueued: unknown[] = [];
    // stub：真的 SEND_QUEUE producer 會在測試結束後才投遞，污染 isolated storage（見 send.test.ts 的註解）
    const envSend = {
      ...env,
      SEND_EMAIL: { async send() { return { messageId: '<x@cf>' }; } },
      SEND_QUEUE: { send: async (b: unknown) => void enqueued.push(b) },
      INGEST_QUEUE: { send: async () => {} },
    } as unknown as typeof env;

    const firstAt = Date.now() + 60_000;
    const intervalMs = 2 * 60_000;
    const ids: string[] = [];
    const wanted: number[] = [];
    for (let i = 0; i < 3; i++) {
      const at = firstAt + i * intervalMs;
      wanted.push(at);
      const ctx = createExecutionContext();
      const res = await worker.fetch(
        new Request(`${BASE}/messages/send`, {
          method: 'POST',
          headers: {
            Cookie: `__Host-session=${encodeURIComponent(u.cookies.session)}; __Host-csrf=${encodeURIComponent(u.cookies.csrf)}`,
            'X-CSRF-Token': u.cookies.csrf,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            to: [`dest${i}@example.com`],
            cc: [], bcc: [],
            subject: `批次 ${i}`,
            text: `第 ${i} 封`,
            attachmentIds: [],
            replyToMessageId: null,
            scheduleAt: at,
          }),
        }),
        envSend,
        ctx,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { id: string; scheduledAt: number; undoWindowSec: number };
      expect(body.scheduledAt).toBe(at);
      expect(body.undoWindowSec).toBe(0); // 排程寄出沒有 undo 倒數窗
      ids.push(body.id);
    }

    // 帶 scheduleAt 的一律不立即丟佇列 → 批次排程不會一次全部炸出去
    expect(enqueued).toEqual([]);

    const rows = await env.DB.prepare(
      `SELECT id, status, scheduled_at FROM send_queue WHERE user_id = ? ORDER BY scheduled_at ASC`,
    ).bind(u.userId).all<{ id: string; status: string; scheduled_at: number }>();
    expect(rows.results.map((r) => r.id)).toEqual(ids);
    expect(rows.results.map((r) => r.scheduled_at)).toEqual(wanted);
    expect(rows.results.every((r) => r.status === 'scheduled')).toBe(true);
    // 「依序」的實質保證：相鄰兩封剛好差一個間隔
    expect(rows.results[1].scheduled_at - rows.results[0].scheduled_at).toBe(intervalMs);
    expect(rows.results[2].scheduled_at - rows.results[1].scheduled_at).toBe(intervalMs);
  });
});
