// F4.1b：規則自動轉寄 — 目標驗證、去重、迴圈防護、扇出上限、schema 把關。
// F11：迴圈斷點標頭改為「系統核發的 marker」——偽造的 X-Miseroda-Forwarded 不再關掉轉寄規則。
import { describe, expect, it } from 'vitest';
import { createExecutionContext, createMessageBatch, env, getQueueResult, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../../src/worker/index';
import { mockEmailMessage, plainEmail, seedUser } from './helpers/fixtures';
import { applyRules } from '../../src/worker/email/rulesEngine';
import {
  enqueueForwards,
  hasSystemForwardMarker,
  isForwardTargetAllowed,
  FORWARD_MARKER_TTL_MS,
} from '../../src/worker/email/forward';

// 佇列 noop：真 env 的 INGEST_QUEUE／SEND_QUEUE.send 會讓 miniflare 在背景自動投遞，consumer 跑在 it() 之外
// （storage frame 已回滾 → [queue.send] no such table: send_queue、Failed to pop isolated storage）。
// 斷言只看 send_queue／forwarded_log 落地列，不依賴佇列真的被消費；ingest 由 deliverAndIngest 手動跑 batch（L5／L14）。
const quietEnv = { ...env, INGEST_QUEUE: { send: async () => {} }, SEND_QUEUE: { send: async () => {} } } as unknown as typeof env;

let n = 0;
async function addRule(userId: string, conditions: unknown, actions: unknown, priority = 0) {
  n += 1;
  await env.DB.prepare(
    `INSERT INTO rules (id, user_id, name, conditions, actions, enabled, priority, created_at) VALUES (?, ?, 'fwd', ?, ?, 1, ?, 0)`,
  ).bind(`fr-${n}`, userId, JSON.stringify(conditions), JSON.stringify(actions), priority).run();
}
async function addMsg(userId: string, id: string, fromAddr: string, folder = 'inbox', direction: 'inbound' | 'outbound' = 'inbound') {
  await env.DB.prepare(
    `INSERT INTO messages (id, user_id, thread_id, direction, from_addr, from_name, to_addrs, subject, snippet, folder, received_at, created_at)
     VALUES (?, ?, ?, ?, ?, 'X', '[]', 's', '', ?, 0, 0)`,
  ).bind(id, userId, `t-${id}`, direction, fromAddr, folder).run();
  return { id, user_id: userId, from_addr: fromAddr, from_name: 'X', subject: 's', folder, to_addrs: '[]' };
}

describe('isForwardTargetAllowed（站內現存使用者/聯絡人；非本人；spam 不算往來）', () => {
  it('站內現存使用者允許；未知站內/外部/本人拒絕', async () => {
    const u = await seedUser(env, 'fa@miseroda.com');
    await seedUser(env, 'peer1@miseroda.com'); // 現存站內使用者
    expect(await isForwardTargetAllowed(env, u.userId, 'fa@miseroda.com', 'peer1@miseroda.com')).toBe(true);
    expect(await isForwardTargetAllowed(env, u.userId, 'fa@miseroda.com', 'ghost@miseroda.com')).toBe(false); // 未知站內 [R1-1]
    expect(await isForwardTargetAllowed(env, u.userId, 'fa@miseroda.com', 'stranger@evil.com')).toBe(false); // 外部
    expect(await isForwardTargetAllowed(env, u.userId, 'fa@miseroda.com', 'fa@miseroda.com')).toBe(false); // 本人
  });
  it('手動聯絡人 + 非 spam/trash 往來允許；spam 往來不算；陌生外部不算', async () => {
    const u = await seedUser(env, 'fb@miseroda.com');
    await env.DB.prepare(`INSERT INTO contacts (user_id, email, created_at, updated_at) VALUES (?, 'spouse@gmail.com', 0, 0)`).bind(u.userId).run();
    expect(await isForwardTargetAllowed(env, u.userId, 'fb@miseroda.com', 'spouse@gmail.com')).toBe(true);
    await addMsg(u.userId, 'fb-corr', 'corr@out.com', 'inbox');
    expect(await isForwardTargetAllowed(env, u.userId, 'fb@miseroda.com', 'corr@out.com')).toBe(true);
    await addMsg(u.userId, 'fb-spam', 'spammer@out.com', 'spam'); // spam 往來不算 [R1-2]
    expect(await isForwardTargetAllowed(env, u.userId, 'fb@miseroda.com', 'spammer@out.com')).toBe(false);
    expect(await isForwardTargetAllowed(env, u.userId, 'fb@miseroda.com', 'never@out.com')).toBe(false);
  });
});

describe('applyRules 收集轉寄目標 + isForwarded 斷迴圈', () => {
  it('命中 forward 規則 → forwardTargets 含目標；isForwarded → 不收集', async () => {
    const u = await seedUser(env, 'fc@miseroda.com');
    await addRule(u.userId, { clauses: [{ field: 'from', op: 'contains', value: 'boss' }] }, { forward: 'peer@miseroda.com' });
    const msg = await addMsg(u.userId, 'fc1', 'boss@x.com');
    const r1 = await applyRules(env, msg, { hasListUnsubscribe: false, firstInsert: true });
    expect(r1.forwardTargets).toEqual(['peer@miseroda.com']);
    // 迴圈防護：本身是轉寄產物（isForwarded）→ 不再收集任何 forward 目標
    const r2 = await applyRules(env, msg, { hasListUnsubscribe: false, firstInsert: false, isForwarded: true });
    expect(r2.forwardTargets).toEqual([]);
  });
});

describe('enqueueForwards（排程 + 去重 + payload 標記 + 扇出上限）', () => {
  it('允許目標 → send_queue（forwarded=true）+ forwarded_log；重跑去重不重複', async () => {
    const u = await seedUser(env, 'fd@miseroda.com');
    await seedUser(env, 'fdpeer@miseroda.com');
    const src = { userId: u.userId, userEmail: 'fd@miseroda.com', messageId: 'fd-m', fromAddr: 'boss@x.com', fromName: 'Boss', subject: 'Q3', html: '<p>hi</p>', text: 'hi' };
    await enqueueForwards(quietEnv, src, ['fdpeer@miseroda.com']);
    const q1 = await env.DB.prepare(`SELECT payload FROM send_queue WHERE user_id = ?`).bind(u.userId).all<{ payload: string }>();
    expect(q1.results.length).toBe(1);
    const payload = JSON.parse(q1.results[0].payload) as { to: string[]; forwarded?: boolean; subject: string };
    expect(payload.to).toEqual(['fdpeer@miseroda.com']);
    expect(payload.forwarded).toBe(true); // 斷迴圈標記
    expect(payload.subject.startsWith('Fwd:')).toBe(true);
    expect(await env.DB.prepare(`SELECT 1 FROM forwarded_log WHERE user_id = ? AND message_id = 'fd-m' AND target = 'fdpeer@miseroda.com'`).bind(u.userId).first()).toBeTruthy();
    await enqueueForwards(quietEnv, src, ['fdpeer@miseroda.com']); // 去重
    expect((await env.DB.prepare(`SELECT COUNT(*) c FROM send_queue WHERE user_id = ?`).bind(u.userId).first<{ c: number }>())?.c).toBe(1);
  });
  it('不允許目標（隨機外部 / 自己）→ 完全不排程', async () => {
    const u = await seedUser(env, 'fe@miseroda.com');
    const src = { userId: u.userId, userEmail: 'fe@miseroda.com', messageId: 'fe-m', fromAddr: 'x@x.com', fromName: 'X', subject: 's', html: '', text: '' };
    await enqueueForwards(quietEnv, src, ['stranger@evil.com', 'fe@miseroda.com']);
    expect((await env.DB.prepare(`SELECT COUNT(*) c FROM send_queue WHERE user_id = ?`).bind(u.userId).first<{ c: number }>())?.c).toBe(0);
  });
  it('扇出上限：>5 目標 → 最多排程 5 封 [R1-4]', async () => {
    const u = await seedUser(env, 'fg@miseroda.com');
    const targets: string[] = [];
    for (let i = 0; i < 7; i++) {
      await seedUser(env, `fgp${i}@miseroda.com`);
      targets.push(`fgp${i}@miseroda.com`);
    }
    const src = { userId: u.userId, userEmail: 'fg@miseroda.com', messageId: 'fg-m', fromAddr: 'x@x.com', fromName: 'X', subject: 's', html: '', text: '' };
    await enqueueForwards(quietEnv, src, targets);
    expect((await env.DB.prepare(`SELECT COUNT(*) c FROM send_queue WHERE user_id = ?`).bind(u.userId).first<{ c: number }>())?.c).toBe(5);
  });
});

describe('規則 schema：forward 目標把關（F4.1b）', () => {
  it('轉寄到隨機外部 → 400；轉寄到現存站內使用者 → 200', async () => {
    const u = await seedUser(env, 'ff@miseroda.com');
    await seedUser(env, 'ffpeer@miseroda.com');
    const post = async (forward: string) => {
      const ctx = createExecutionContext();
      const res = await worker.fetch(
        new Request('https://mail.miseroda.com/api/v1/rules', {
          method: 'POST',
          headers: {
            Cookie: `__Host-session=${encodeURIComponent(u.cookies.session)}; __Host-csrf=${encodeURIComponent(u.cookies.csrf)}`,
            'X-CSRF-Token': u.cookies.csrf,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ name: 'r', conditions: { clauses: [{ field: 'from', op: 'contains', value: 'x' }] }, actions: { forward } }),
        }),
        env,
        ctx,
      );
      await waitOnExecutionContext(ctx);
      return res;
    };
    expect((await post('stranger@evil.com')).status).toBe(400);
    expect((await post('ffpeer@miseroda.com')).status).toBe(200);
  });
});

/* ================= F11：迴圈斷點 marker（不信任遠端寫的標頭） ================= */

/** 收一封外部來信（含自訂標頭）並跑 ingest consumer */
async function deliverAndIngest(to: string, userId: string, from: string, extraHeaders: string[]): Promise<void> {
  const raw = plainEmail({ from, to, subject: '請看這個', extraHeaders });
  const emailCtx = createExecutionContext();
  await worker.email(mockEmailMessage(raw, { from, to }).message, quietEnv, emailCtx);
  await waitOnExecutionContext(emailCtx);
  const row = await env.DB.prepare(`SELECT id FROM messages WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`)
    .bind(userId)
    .first<{ id: string }>();
  const batch = createMessageBatch('miseroda-ingest', [
    { id: crypto.randomUUID(), timestamp: new Date(), body: { kind: 'ingest', messageId: row!.id, userId }, attempts: 1 },
  ]);
  const ctx = createExecutionContext();
  await worker.queue(batch, quietEnv, ctx); // consumer 內命中轉寄規則會 SEND_QUEUE.send → 同樣要 noop
  await getQueueResult(batch, ctx);
}

const forwardCount = async (userId: string) =>
  (await env.DB.prepare(`SELECT COUNT(*) c FROM send_queue WHERE user_id = ?`).bind(userId).first<{ c: number }>())?.c ?? 0;

describe('F11 迴圈斷點 marker', () => {
  it('偽造 X-Miseroda-Forwarded 擋不掉轉寄；系統核發的 marker 才斷迴圈', async () => {
    const u = await seedUser(env, 'f11a@miseroda.com');
    await seedUser(env, 'f11peer@miseroda.com');
    await addRule(u.userId, { clauses: [{ field: 'from', op: 'contains', value: 'boss' }] }, { forward: 'f11peer@miseroda.com' });

    // (1) 遠端寄件者自己寫的標頭值 → 不採信 → 轉寄照常發生
    await deliverAndIngest('f11a@miseroda.com', u.userId, 'boss@x.com', ['X-Miseroda-Forwarded: 1']);
    expect(await forwardCount(u.userId)).toBe(1);

    // (2) 上一步真的核發了 marker（隨機值，不是內部 msg_ id）
    const payload = JSON.parse(
      (await env.DB.prepare(`SELECT payload FROM send_queue WHERE user_id = ? LIMIT 1`).bind(u.userId).first<{ payload: string }>())!
        .payload,
    ) as { forwarded?: boolean; forwardMarker?: string };
    expect(payload.forwarded).toBe(true);
    const marker = payload.forwardMarker!;
    expect(marker.length).toBeGreaterThan(20);
    expect(marker).not.toContain('msg_');

    // (3) 帶著這個 marker 扇回來 → 採信 → 不再轉寄（沒有新的 send_queue 列）
    await deliverAndIngest('f11a@miseroda.com', u.userId, 'boss@x.com', [`X-Miseroda-Forwarded: ${marker}`]);
    expect(await forwardCount(u.userId)).toBe(1);
  });

  it('marker 全站有效：A 核發的 marker 落到 B 的信箱也斷迴圈（防跨使用者接力迴圈）', async () => {
    const a = await seedUser(env, 'f11x@miseroda.com');
    const b = await seedUser(env, 'f11y@miseroda.com');
    await seedUser(env, 'f11z@miseroda.com');
    // A 產生一封轉寄 → 取得 A 核發的 marker
    await enqueueForwards(
      quietEnv,
      { userId: a.userId, userEmail: 'f11x@miseroda.com', messageId: 'f11-src', fromAddr: 'boss@x.com', fromName: 'B', subject: 's', html: '', text: '' },
      ['f11z@miseroda.com'],
    );
    const marker = (
      JSON.parse(
        (await env.DB.prepare(`SELECT payload FROM send_queue WHERE user_id = ? LIMIT 1`).bind(a.userId).first<{ payload: string }>())!
          .payload,
      ) as { forwardMarker?: string }
    ).forwardMarker!;

    // B 有自己的轉寄規則；A 的 marker 落到 B 這邊一樣要斷（查表刻意不分使用者）
    await addRule(b.userId, { clauses: [{ field: 'from', op: 'contains', value: 'boss' }] }, { forward: 'f11z@miseroda.com' });
    await deliverAndIngest('f11y@miseroda.com', b.userId, 'boss@x.com', [`X-Miseroda-Forwarded: ${marker}`]);
    expect(await forwardCount(b.userId)).toBe(0);
  });

  it('hasSystemForwardMarker：偽造值/空值/過期 marker 一律不採信', async () => {
    expect(await hasSystemForwardMarker(env, ['1'])).toBe(false);
    expect(await hasSystemForwardMarker(env, ['', '   ', null, undefined])).toBe(false);
    expect(await hasSystemForwardMarker(env, ['a'.repeat(500)])).toBe(false);
    const u = await seedUser(env, 'f11t@miseroda.com');
    const stale = Date.now() - FORWARD_MARKER_TTL_MS - 1000;
    await env.DB.prepare(`INSERT INTO forward_markers (marker, user_id, message_id, created_at) VALUES ('f11-stale', ?, 'm', ?)`)
      .bind(u.userId, stale)
      .run();
    expect(await hasSystemForwardMarker(env, ['f11-stale'])).toBe(false);
    await env.DB.prepare(`UPDATE forward_markers SET created_at = ? WHERE marker = 'f11-stale'`).bind(Date.now()).run();
    expect(await hasSystemForwardMarker(env, ['nope', 'f11-stale'])).toBe(true);
  });
});
