// 標籤 / 規則 / 設定 / FTS 搜尋 API / admin 統計
import { describe, expect, it } from 'vitest';
import { createExecutionContext, createMessageBatch, env, getQueueResult, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../../src/worker/index';
import { mockEmailMessage, plainEmail, seedUser } from './helpers/fixtures';

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
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`${BASE}${path}`, {
      method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

// INGEST_QUEUE noop：真 env 的 send 會讓佇列在背景自動投遞，consumer 跑在 it() 之外
// （storage frame 已回滾 → no such table: messages / Failed to pop isolated storage）。ingest 由測試內手動 batch 跑（L5／L14）。
const deliverEnv = { ...env, INGEST_QUEUE: { send: async () => {} } } as unknown as typeof env;

describe('labels / rules / settings / search / admin stats', () => {
  it('end-to-end', async () => {
    const hon = await seedUser(env, 'hon@miseroda.com', 'admin');

    /* ---- 標籤 CRUD ---- */
    const created = await (
      await apiCall('/labels', hon.cookies, { body: { name: '帳單', color: '#FBD46D' } })
    ).json<{ id: string }>();
    expect(created.id).toBeTruthy();
    const dup = await apiCall('/labels', hon.cookies, { body: { name: '帳單', color: '#FBD46D' } });
    expect(dup.status).toBe(409);
    const renamed = await apiCall(`/labels/${created.id}`, hon.cookies, {
      method: 'PATCH',
      body: { name: '帳單通知' },
    });
    expect(renamed.status).toBe(200);

    /* ---- 規則 CRUD + 驗證 ---- */
    const badRule = await apiCall('/rules', hon.cookies, {
      body: { name: '空條件', conditions: {}, actions: { star: true } },
    });
    expect(badRule.status).toBe(400);
    const foreignLabel = await apiCall('/rules', hon.cookies, {
      body: { name: '偷標籤', conditions: { fromContains: 'x' }, actions: { addLabelId: 'lbl_not_mine' } },
    });
    expect(foreignLabel.status).toBe(400);
    const rule = await (
      await apiCall('/rules', hon.cookies, {
        body: {
          name: '帳單自動歸檔',
          conditions: { fromContains: 'ebill@' },
          actions: { addLabelId: created.id, star: true },
        },
      })
    ).json<{ id: string }>();
    const ruleList = await (await apiCall('/rules', hon.cookies)).json<{ rules: { id: string; enabled: boolean }[] }>();
    expect(ruleList.rules.find((r) => r.id === rule.id)?.enabled).toBe(true);
    const toggled = await apiCall(`/rules/${rule.id}`, hon.cookies, { method: 'PATCH', body: { enabled: false } });
    expect(toggled.status).toBe(200);

    /* ---- 設定（簽名 + prefs 合併） ---- */
    await apiCall('/settings', hon.cookies, { method: 'PATCH', body: { signature: '—\nHon 🐧' } });
    await apiCall('/settings', hon.cookies, { method: 'PATCH', body: { prefs: { theme: 'light' } } });
    await apiCall('/settings', hon.cookies, { method: 'PATCH', body: { prefs: { accent: 'violet' } } });
    const settings = await (await apiCall('/settings', hon.cookies)).json<{
      signature: string;
      prefs: Record<string, string>;
    }>();
    expect(settings.signature).toBe('—\nHon 🐧');
    expect(settings.prefs).toMatchObject({ theme: 'light', accent: 'violet' }); // 合併不覆蓋

    /* ---- FTS 搜尋（≥3 字走 trigram，含內文） ---- */
    const emailCtx = createExecutionContext();
    await worker.email(
      mockEmailMessage(plainEmail({ subject: '潛水行程', body: '七月第二週去小琉球，AOW 證照三天可拿。' })).message,
      deliverEnv,
      emailCtx,
    );
    await waitOnExecutionContext(emailCtx);
    const msgRow = await env.DB.prepare(`SELECT id FROM messages WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`)
      .bind(hon.userId)
      .first<{ id: string }>();
    // 跑 ingest consumer 建 FTS
    const batch = createMessageBatch('miseroda-ingest', [
      {
        id: crypto.randomUUID(),
        timestamp: new Date(),
        body: { kind: 'ingest', messageId: msgRow!.id, userId: hon.userId },
        attempts: 1,
      },
    ]);
    const queueCtx = createExecutionContext();
    await worker.queue(batch, env, queueCtx);
    await getQueueResult(batch, queueCtx);

    // 內文關鍵字（不在主旨/摘要 LIKE 範圍才能證明走了 FTS…內文「小琉球」也在 snippet；用更深的詞「證照三天」）
    const ftsRes = await (
      await apiCall(`/messages?folder=inbox&q=${encodeURIComponent('證照三天')}`, hon.cookies)
    ).json<{ items: { id: string }[] }>();
    expect(ftsRes.items.map((i) => i.id)).toContain(msgRow!.id);

    // 2 字查詢走 LIKE fallback（主旨可中）
    const likeRes = await (
      await apiCall(`/messages?folder=inbox&q=${encodeURIComponent('潛水')}`, hon.cookies)
    ).json<{ items: { id: string }[] }>();
    expect(likeRes.items.map((i) => i.id)).toContain(msgRow!.id);

    // 沒有結果
    const missRes = await (
      await apiCall(`/messages?folder=inbox&q=${encodeURIComponent('完全不存在的詞')}`, hon.cookies)
    ).json<{ items: unknown[] }>();
    expect(missRes.items).toHaveLength(0);

    /* ---- 標籤刪除連動 message_labels ---- */
    await env.DB.prepare(`INSERT OR IGNORE INTO message_labels (message_id, label_id) VALUES (?, ?)`)
      .bind(msgRow!.id, created.id)
      .run();
    const del = await apiCall(`/labels/${created.id}`, hon.cookies, { method: 'DELETE' });
    expect(del.status).toBe(200);
    const leftover = await env.DB.prepare(`SELECT COUNT(*) AS n FROM message_labels WHERE label_id = ?`)
      .bind(created.id)
      .first<{ n: number }>();
    expect(leftover!.n).toBe(0);

    /* ---- admin 統計 ---- */
    const stats = await (await apiCall('/admin/stats', hon.cookies)).json<{
      users: { total: number };
      messages: { total: number };
      monthlyQuota: number;
    }>();
    expect(stats.users.total).toBe(1);
    expect(stats.messages.total).toBeGreaterThanOrEqual(1);
    expect(stats.monthlyQuota).toBe(3000);

    /* ---- 跨使用者隔離 ---- */
    const kai = await seedUser(env, 'kai@miseroda.com');
    const crossPatch = await apiCall(`/rules/${rule.id}`, kai.cookies, { method: 'PATCH', body: { enabled: true } });
    expect(crossPatch.status).toBe(404);
    const crossStats = await apiCall('/admin/stats', kai.cookies);
    expect(crossStats.status).toBe(403);
  });

  /* ---- F12.4：PATCH /settings 原子合併（json_set 取代 read-merge-write） ---- */
  it('並發 PATCH 不同 key 都保留；值不雙重編碼；null 保留；奇形鍵拒收', async () => {
    const hon = await seedUser(env, 'hon@miseroda.com');
    // 首次 PATCH 建列（INSERT 分支）
    expect((await apiCall('/settings', hon.cookies, { method: 'PATCH', body: { prefs: { theme: 'dark' } } })).status).toBe(200);
    // 並發兩個不同 key：舊實作是 SELECT→JS merge→覆寫，交錯時後者蓋掉前者；json_set 原子合併保證都在
    const [r1, r2] = await Promise.all([
      apiCall('/settings', hon.cookies, { method: 'PATCH', body: { prefs: { accent: 'violet' } } }),
      apiCall('/settings', hon.cookies, { method: 'PATCH', body: { prefs: { density: 'compact' } } }),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const got = await (await apiCall('/settings', hon.cookies)).json<{ prefs: Record<string, unknown> }>();
    expect(got.prefs).toMatchObject({ theme: 'dark', accent: 'violet', density: 'compact' });
    // 字串不雙重編碼（不是 '"violet"'）、巢狀物件整顆換、null 保留（speakeasy 清除語義）
    expect(got.prefs.accent).toBe('violet');
    await apiCall('/settings', hon.cookies, { method: 'PATCH', body: { prefs: { retention: { archive: 90 } } } });
    await apiCall('/settings', hon.cookies, { method: 'PATCH', body: { prefs: { speakeasy: null } } });
    const got2 = await (await apiCall('/settings', hon.cookies)).json<{ prefs: Record<string, unknown> }>();
    expect(got2.prefs.retention).toEqual({ archive: 90 });
    expect('speakeasy' in got2.prefs).toBe(true);
    expect(got2.prefs.speakeasy).toBeNull();
    // 只帶 signature 的 PATCH 不動 prefs；只帶 prefs 的 PATCH 不動 signature
    await apiCall('/settings', hon.cookies, { method: 'PATCH', body: { signature: 'Hon' } });
    const got3 = await (await apiCall('/settings', hon.cookies)).json<{ signature: string; prefs: Record<string, unknown> }>();
    expect(got3.signature).toBe('Hon');
    expect(got3.prefs.theme).toBe('dark');
    // 鍵名要拼進 JSON path：奇形鍵拒收 400
    const weird = await apiCall('/settings', hon.cookies, { method: 'PATCH', body: { prefs: { 'a."b"': 1 } } });
    expect(weird.status).toBe(400);
    // 型別 guard 迴歸（F9.1）：purgeSpamTrash 非布林拒收
    const bad = await apiCall('/settings', hon.cookies, { method: 'PATCH', body: { prefs: { purgeSpamTrash: 'false' } } });
    expect(bad.status).toBe(400);
  });

  it('F12.4 邊界：空 body、僅 signature 的首次 PATCH、鍵名長度、F9.2/F9.5 guard 迴歸', async () => {
    const hon = await seedUser(env, 'hon@miseroda.com');
    // 空 body {}：新使用者建空殼列，不炸
    expect((await apiCall('/settings', hon.cookies, { method: 'PATCH', body: {} })).status).toBe(200);
    const empty = await (await apiCall('/settings', hon.cookies)).json<{ signature: string; prefs: Record<string, unknown> }>();
    expect(empty).toMatchObject({ signature: '', prefs: {} });
    // 既有列後的空 body = no-op，不清資料
    await apiCall('/settings', hon.cookies, { method: 'PATCH', body: { signature: 'S', prefs: { theme: 'dark' } } });
    await apiCall('/settings', hon.cookies, { method: 'PATCH', body: {} });
    const kept = await (await apiCall('/settings', hon.cookies)).json<{ signature: string; prefs: Record<string, unknown> }>();
    expect(kept).toMatchObject({ signature: 'S', prefs: { theme: 'dark' } });
    // 僅 signature 的首次 PATCH（INSERT 分支另一臂）
    const kai = await seedUser(env, 'kai@miseroda.com');
    await apiCall('/settings', kai.cookies, { method: 'PATCH', body: { signature: 'K' } });
    const sigOnly = await (await apiCall('/settings', kai.cookies)).json<{ signature: string; prefs: Record<string, unknown> }>();
    expect(sigOnly).toMatchObject({ signature: 'K', prefs: {} });
    // 鍵名邊界：64 字放行、65 字拒收、空字串鍵拒收
    expect((await apiCall('/settings', hon.cookies, { method: 'PATCH', body: { prefs: { ['k'.repeat(64)]: 1 } } })).status).toBe(200);
    expect((await apiCall('/settings', hon.cookies, { method: 'PATCH', body: { prefs: { ['k'.repeat(65)]: 1 } } })).status).toBe(400);
    expect((await apiCall('/settings', hon.cookies, { method: 'PATCH', body: { prefs: { '': 1 } } })).status).toBe(400);
    // F9.2 迴歸：retention 非法檔位在新路徑仍拒收
    expect((await apiCall('/settings', hon.cookies, { method: 'PATCH', body: { prefs: { retention: { archive: -1 } } } })).status).toBe(400);
    expect((await apiCall('/settings', hon.cookies, { method: 'PATCH', body: { prefs: { retention: { archive: '30' } } } })).status).toBe(400);
    // F9.5 迴歸：speakeasy 長度守門仍在
    expect((await apiCall('/settings', hon.cookies, { method: 'PATCH', body: { prefs: { speakeasy: 'abc' } } })).status).toBe(400);
    expect((await apiCall('/settings', hon.cookies, { method: 'PATCH', body: { prefs: { speakeasy: '通關密語四字' } } })).status).toBe(200);
  });
});
