// F12.1：D1 每日備份 → R2 dump 完整性、冪等、輪替不誤刪。
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { runBackup, shouldKeepBackup } from '../../src/worker/jobs/backup';
import { seedUser } from './helpers/fixtures';

const T0 = Date.parse('2026-07-06T18:05:00Z'); // 模擬 cron 觸發時刻（day=2026-07-06）

describe('F12.1 shouldKeepBackup（輪替純函式）', () => {
  it('30 天內保留；31 天丟棄；月初 1 日保留到 365 天', () => {
    expect(shouldKeepBackup('2026-06-10', '2026-07-06')).toBe(true); // 26 天
    expect(shouldKeepBackup('2026-06-06', '2026-07-06')).toBe(true); // 恰 30 天（邊界含）
    expect(shouldKeepBackup('2026-06-05', '2026-07-06')).toBe(false); // 31 天
    expect(shouldKeepBackup('2026-01-01', '2026-07-06')).toBe(true); // 月初，186 天 < 365
    expect(shouldKeepBackup('2025-07-01', '2026-07-06')).toBe(false); // 月初但 370 天
    expect(shouldKeepBackup('garbage', '2026-07-06')).toBe(true); // 解析失敗往保留方向
  });
});

describe('F12.1 runBackup', () => {
  it('dump 各表 JSONL＋manifest 列數正確；跳過 sessions；同日第二次冪等跳過', async () => {
    const hon = await seedUser(env, 'hon@miseroda.com');
    await env.DB.prepare(
      `INSERT INTO messages (id, user_id, thread_id, direction, from_addr, subject, snippet, folder, is_read, received_at, created_at)
       VALUES ('bk1', ?, 't-bk1', 'inbound', 'a@b.c', '備份測試', '', 'inbox', 0, ?, ?)`,
    )
      .bind(hon.userId, T0, T0)
      .run();

    const r = await runBackup(env, T0);
    expect(r).not.toBeNull();
    expect(r!.day).toBe('2026-07-06');
    // 使用者資料完整：users dump 含 seed 的那筆、messages 含 bk1
    const users = await env.MAIL_STORE.get('backup/2026-07-06/users.jsonl');
    expect(users).not.toBeNull();
    const userLines = (await users!.text()).split('\n').filter(Boolean);
    expect(userLines.some((l) => JSON.parse(l).email === 'hon@miseroda.com')).toBe(true);
    const msgs = await env.MAIL_STORE.get('backup/2026-07-06/messages.jsonl');
    expect(JSON.parse((await msgs!.text()).split('\n')[0]).id).toBe('bk1');
    // manifest 列數與 dump 一致
    const manifest = await env.MAIL_STORE.get('backup/2026-07-06/_manifest.json');
    const m = JSON.parse(await manifest!.text());
    expect(m.tables.users).toBe(userLines.length);
    expect(m.tables.messages).toBe(1);
    // 短命表不備份
    expect(await env.MAIL_STORE.head('backup/2026-07-06/sessions.jsonl')).toBeNull();
    expect(m.tables.sessions).toBeUndefined();
    // 冪等：同日再跑直接跳過
    expect(await runBackup(env, T0 + 60_000)).toBeNull();
  });

  it('輪替：>30 天日備份刪除、月初保留、非 backup 格式與其他 prefix 絕不誤刪', async () => {
    await env.MAIL_STORE.put('backup/2026-06-03/users.jsonl', 'old'); // 33 天前 → 刪
    await env.MAIL_STORE.put('backup/2026-06-03/_manifest.json', '{}'); // 同日一起刪
    await env.MAIL_STORE.put('backup/2026-07-01/users.jsonl', 'monthly'); // 月初 → 留
    await env.MAIL_STORE.put('backup/2026-06-20/users.jsonl', 'recent'); // 16 天 → 留
    await env.MAIL_STORE.put('backup/not-a-date/x.jsonl', 'weird'); // 格式不符 → 不動
    await env.MAIL_STORE.put('raw/usr1/mail.eml', 'user-data'); // 其他 prefix → 絕不動

    const r = await runBackup(env, T0);
    expect(r).not.toBeNull();
    expect(await env.MAIL_STORE.head('backup/2026-06-03/users.jsonl')).toBeNull();
    expect(await env.MAIL_STORE.head('backup/2026-06-03/_manifest.json')).toBeNull();
    expect(await env.MAIL_STORE.head('backup/2026-07-01/users.jsonl')).not.toBeNull();
    expect(await env.MAIL_STORE.head('backup/2026-06-20/users.jsonl')).not.toBeNull();
    expect(await env.MAIL_STORE.head('backup/not-a-date/x.jsonl')).not.toBeNull();
    expect(await env.MAIL_STORE.head('raw/usr1/mail.eml')).not.toBeNull();
  });
});
