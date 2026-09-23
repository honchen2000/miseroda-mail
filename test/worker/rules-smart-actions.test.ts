// F2.2a：規則動作擴充 —— snooze（今晚/明早/週末）+ followUpAfterMin（寫 follow_ups）。
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { seedUser } from './helpers/fixtures';
import { applyRules, snoozeTargetMs } from '../../src/worker/email/rulesEngine';

const TPE = 8 * 3_600_000;

let n = 0;
async function addRule(userId: string, conditions: unknown, actions: unknown) {
  n += 1;
  await env.DB.prepare(
    `INSERT INTO rules (id, user_id, name, conditions, actions, enabled, priority, created_at) VALUES (?, ?, 'r', ?, ?, 1, ?, 0)`,
  )
    .bind(`rule-${n}`, userId, JSON.stringify(conditions), JSON.stringify(actions), n)
    .run();
}
async function addMsg(userId: string, id: string, subject: string, from = 'a@x.com') {
  await env.DB.prepare(
    `INSERT INTO messages (id, user_id, thread_id, direction, from_addr, from_name, subject, snippet, folder, received_at, created_at)
     VALUES (?, ?, ?, 'inbound', ?, '', ?, '', 'inbox', 0, 0)`,
  )
    .bind(id, userId, `t-${id}`, from, subject)
    .run();
  return { id, user_id: userId, from_addr: from, from_name: '', subject, folder: 'inbox', to_addrs: '' };
}

describe('規則智慧動作（F2.2a）', () => {
  it('snoozeTargetMs：今晚/明早/週末（台北牆鐘）', () => {
    const now = Date.UTC(2026, 5, 23, 2, 0); // 2026-06-23 10:00 台北（週二）
    expect(snoozeTargetMs('evening', now)).toBe(Date.UTC(2026, 5, 23, 11, 0)); // 今晚 19:00 台北
    expect(snoozeTargetMs('tomorrow', now)).toBe(Date.UTC(2026, 5, 24, 0, 0)); // 明早 08:00 台北
    const wk = snoozeTargetMs('weekend', now);
    expect((wk + TPE) % 86_400_000).toBe(8 * 3_600_000); // 08:00 台北
    expect(Math.floor((wk + TPE) / 86_400_000 + 4) % 7).toBe(6); // 週六
    expect(wk).toBeGreaterThan(now);
    // 週六邊界（Codex R [2]）：週六 06:00 台北 → 取「今天」08:00；週六 10:00 → 下週六
    const satEarly = Date.UTC(2026, 5, 26, 22, 0); // = 2026-06-27（六）06:00 台北
    expect(snoozeTargetMs('weekend', satEarly)).toBe(Date.UTC(2026, 5, 27, 0, 0)); // 本週六 08:00 台北
    const satLate = Date.UTC(2026, 5, 27, 2, 0); // = 2026-06-27（六）10:00 台北
    expect(snoozeTargetMs('weekend', satLate)).toBe(Date.UTC(2026, 6, 4, 0, 0)); // 下週六 08:00 台北
  });

  it('snooze 動作：落地時設 snoozed_until（未來）', async () => {
    const u = await seedUser(env, 'u@miseroda.com');
    await addRule(u.userId, { clauses: [{ field: 'subject', op: 'contains', value: '電子報' }] }, { snooze: 'weekend' });
    const msg = await addMsg(u.userId, 'm1', '本週電子報');
    await applyRules(env, msg, { hasListUnsubscribe: false });
    const row = await env.DB.prepare(`SELECT snoozed_until FROM messages WHERE id = 'm1'`).first<{ snoozed_until: number | null }>();
    expect(row?.snoozed_until).toBeGreaterThan(Date.now());
  });

  it('followUpAfterMin 動作：寫一筆 follow_ups（due ≈ now + N 分）', async () => {
    const u = await seedUser(env, 'u@miseroda.com');
    await addRule(u.userId, { clauses: [{ field: 'from', op: 'contains', value: 'boss' }] }, { followUpAfterMin: 240 });
    const msg = await addMsg(u.userId, 'm2', '請回覆', 'boss@corp.com');
    const before = Date.now();
    await applyRules(env, msg, { hasListUnsubscribe: false });
    const fu = await env.DB.prepare(`SELECT message_id, due_at, status FROM follow_ups WHERE user_id = ? AND message_id = 'm2'`).bind(u.userId).first<{ message_id: string; due_at: number; status: string }>();
    expect(fu?.status).toBe('pending');
    expect(fu!.due_at).toBeGreaterThanOrEqual(before + 240 * 60_000);
  });

  it('oneShot：去重重跑（firstInsert:false）不再 snooze', async () => {
    const u = await seedUser(env, 'u@miseroda.com');
    await addRule(u.userId, { clauses: [{ field: 'subject', op: 'contains', value: '報' }] }, { snooze: 'tomorrow' });
    const msg = await addMsg(u.userId, 'm3', '電子報');
    await applyRules(env, msg, { hasListUnsubscribe: false, firstInsert: false });
    const row = await env.DB.prepare(`SELECT snoozed_until FROM messages WHERE id = 'm3'`).first<{ snoozed_until: number | null }>();
    expect(row?.snoozed_until).toBeNull();
  });

  it('被搬到資料夾時不 snooze（避免矛盾）', async () => {
    const u = await seedUser(env, 'u@miseroda.com');
    await addRule(u.userId, { clauses: [{ field: 'subject', op: 'contains', value: '廣告' }] }, { moveToFolder: 'archive', snooze: 'weekend' });
    const msg = await addMsg(u.userId, 'm4', '廣告信');
    await applyRules(env, msg, { hasListUnsubscribe: false });
    const row = await env.DB.prepare(`SELECT folder, snoozed_until FROM messages WHERE id = 'm4'`).first<{ folder: string; snoozed_until: number | null }>();
    expect(row?.folder).toBe('archive');
    expect(row?.snoozed_until).toBeNull();
  });
});
