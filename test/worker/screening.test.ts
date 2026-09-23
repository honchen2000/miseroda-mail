// F5.3：寄件者首見審核閘（收窄）——陌生人 + 驗證 fail → 待審夾；已驗證/已往來 → 收件匣。
import { describe, expect, it } from 'vitest';
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { createMessageBatch, getQueueResult } from 'cloudflare:test';
import worker from '../../src/worker/index';
import { mockEmailMessage, seedUser } from './helpers/fixtures';

// verdict 對照（authVerdict.trustLevel）：pass=全過；fail=dmarc fail；partial=已評估但 SPF/DKIM 不一致；none=無標頭。
function authEmail(to: string, from: string, kind: 'pass' | 'fail' | 'partial' | 'none', listUnsub = false): string {
  const dom = from.split('@')[1];
  const lines = [`From: ${from}`, `To: ${to}`, 'Subject: 你好陌生人', 'MIME-Version: 1.0'];
  if (kind === 'pass') lines.push(`Authentication-Results: mx.miseroda.com; spf=pass smtp.mailfrom=${dom}; dkim=pass; dmarc=pass header.from=${dom}`);
  else if (kind === 'fail') lines.push(`Authentication-Results: mx.miseroda.com; spf=fail smtp.mailfrom=${dom}; dkim=fail; dmarc=fail header.from=${dom}`);
  else if (kind === 'partial') lines.push(`Authentication-Results: mx.miseroda.com; spf=pass smtp.mailfrom=${dom}; dkim=fail`); // 無 dmarc + spf≠dkim → partial
  if (listUnsub) lines.push(`List-Unsubscribe: <mailto:unsub@${dom}>`);
  // none = 完全無 Authentication-Results
  lines.push('Content-Type: text/plain; charset=utf-8', '', '哈囉。');
  return lines.join('\r\n');
}
async function getCounts(u: Awaited<ReturnType<typeof seedUser>>) {
  const ctx = createExecutionContext();
  const r = await worker.fetch(
    new Request('https://mail.miseroda.com/api/v1/mailbox/counts', {
      headers: { Cookie: `__Host-session=${encodeURIComponent(u.cookies.session)}; __Host-csrf=${encodeURIComponent(u.cookies.csrf)}` },
    }),
    env,
    ctx,
  );
  const body = await r.json<{ screening: number; newsletter: number; folders: Record<string, { total: number; unread: number }> }>();
  await waitOnExecutionContext(ctx);
  return body;
}
// INGEST_QUEUE noop：真 env 的 send 會讓佇列在背景自動投遞，consumer 跑在 it() 之外
// （storage frame 已回滾 → no such table: messages、KV .sqlite-shm → Failed to pop isolated storage）。
// 改由 ingestLatest 手動跑 batch（L5；先例 auto-draft.test.ts）。
const deliverEnv = { ...env, INGEST_QUEUE: { send: async () => {} } } as unknown as typeof env;
async function deliver(raw: string, from: string, to: string) {
  const ctx = createExecutionContext();
  await worker.email(mockEmailMessage(raw, { from, to }).message, deliverEnv, ctx);
  await waitOnExecutionContext(ctx);
}
async function ingestLatest(userId: string): Promise<string> {
  const row = await env.DB.prepare(`SELECT id FROM messages WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`).bind(userId).first<{ id: string }>();
  const id = row!.id;
  const batch = createMessageBatch('miseroda-ingest', [{ id: crypto.randomUUID(), timestamp: new Date(), body: { kind: 'ingest', messageId: id, userId }, attempts: 1 }]);
  const ctx = createExecutionContext();
  await worker.queue(batch, env, ctx);
  await getQueueResult(batch, ctx);
  return id;
}
const stateOf = (id: string) => env.DB.prepare(`SELECT folder, screening FROM messages WHERE id = ?`).bind(id).first<{ folder: string; screening: number }>();

async function screenDecide(u: Awaited<ReturnType<typeof seedUser>>, id: string, decision: 'allow' | 'block') {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`https://mail.miseroda.com/api/v1/messages/${id}/screen`, {
      method: 'POST',
      headers: {
        Cookie: `__Host-session=${encodeURIComponent(u.cookies.session)}; __Host-csrf=${encodeURIComponent(u.cookies.csrf)}`,
        'X-CSRF-Token': u.cookies.csrf,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ decision }),
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}
// 造一封待審信（partial 陌生首觸）並回 id
async function seedScreening(u: Awaited<ReturnType<typeof seedUser>>, email: string, sender: string): Promise<string> {
  await deliver(authEmail(email, sender, 'partial'), sender, email);
  return ingestLatest(u.userId);
}

describe('Screener 首見審核閘（F5.3，收窄）', () => {
  it('陌生人 + partial(SPF/DKIM 不一致) → 待審（仍 inbox 但 screening=1）', async () => {
    const u = await seedUser(env, 'scr1@miseroda.com');
    await deliver(authEmail('scr1@miseroda.com', 'mixed@nodmarc.io', 'partial'), 'mixed@nodmarc.io', 'scr1@miseroda.com');
    const s = await stateOf(await ingestLatest(u.userId));
    expect(s?.folder).toBe('inbox');
    expect(s?.screening).toBe(1);
  });

  it('陌生人 + pass → 收件匣（已驗證不誤擋）', async () => {
    const u = await seedUser(env, 'scr2@miseroda.com');
    await deliver(authEmail('scr2@miseroda.com', 'clinic@hospital.org', 'pass'), 'clinic@hospital.org', 'scr2@miseroda.com');
    const s = await stateOf(await ingestLatest(u.userId));
    expect(s?.folder).toBe('inbox');
    expect(s?.screening).toBe(0);
  });

  it('陌生人 + none(無驗證標頭) → 收件匣（給 benefit-of-doubt，不 over-hold）', async () => {
    const u = await seedUser(env, 'scr2b@miseroda.com');
    await deliver(authEmail('scr2b@miseroda.com', 'cold@noauth.io', 'none'), 'cold@noauth.io', 'scr2b@miseroda.com');
    const s = await stateOf(await ingestLatest(u.userId));
    expect(s?.folder).toBe('inbox');
    expect(s?.screening).toBe(0);
  });

  it('已是聯絡人 + partial → 收件匣（非陌生人，不擋）', async () => {
    const u = await seedUser(env, 'scr3@miseroda.com');
    await env.DB.prepare(`INSERT INTO contacts (user_id, email, created_at, updated_at) VALUES (?, 'known@partner.com', 0, 0)`).bind(u.userId).run();
    await deliver(authEmail('scr3@miseroda.com', 'known@partner.com', 'partial'), 'known@partner.com', 'scr3@miseroda.com');
    const s = await stateOf(await ingestLatest(u.userId));
    expect(s?.screening).toBe(0);
  });

  it('陌生人 + dmarc=fail → spam（既有 looksSpam，不標 screening）', async () => {
    const u = await seedUser(env, 'scr4@miseroda.com');
    await deliver(authEmail('scr4@miseroda.com', 'phish@evil.com', 'fail'), 'phish@evil.com', 'scr4@miseroda.com');
    const s = await stateOf(await ingestLatest(u.userId));
    expect(s?.folder).toBe('spam'); // 明確 fail 落 spam（更強），screening 守門(folder='inbox')天然略過
    expect(s?.screening).toBe(0);
  });
});

describe('待審決策端點 /messages/:id/screen（F5.3b）', () => {
  it('放行 → screening=0（進收件匣）+ 寄件者加為聯絡人', async () => {
    const u = await seedUser(env, 'sd1@miseroda.com');
    const id = await seedScreening(u, 'sd1@miseroda.com', 'newpal@partial.io');
    const res = await screenDecide(u, id, 'allow');
    expect(res.status).toBe(200);
    const s = await stateOf(id);
    expect(s?.folder).toBe('inbox');
    expect(s?.screening).toBe(0);
    const c = await env.DB.prepare(`SELECT 1 FROM contacts WHERE user_id = ? AND lower(email) = 'newpal@partial.io'`).bind(u.userId).first();
    expect(c).not.toBeNull();
  });

  it('永遠擋 → 移 spam + 建 fromContains→spam 規則', async () => {
    const u = await seedUser(env, 'sd2@miseroda.com');
    const id = await seedScreening(u, 'sd2@miseroda.com', 'spammer@partial.io');
    const res = await screenDecide(u, id, 'block');
    expect(res.status).toBe(200);
    const s = await stateOf(id);
    expect(s?.folder).toBe('spam');
    expect(s?.screening).toBe(0);
    const rule = await env.DB.prepare(`SELECT actions FROM rules WHERE user_id = ? AND conditions LIKE '%spammer@partial.io%'`).bind(u.userId).first<{ actions: string }>();
    expect(rule).not.toBeNull();
    expect(JSON.parse(rule!.actions).moveToFolder).toBe('spam');
  });

  it('跨使用者：不能決策別人的待審信（404，且不變動）', async () => {
    const a = await seedUser(env, 'sda@miseroda.com');
    const b = await seedUser(env, 'sdb@miseroda.com');
    const id = await seedScreening(a, 'sda@miseroda.com', 'x@partial.io');
    const res = await screenDecide(b, id, 'allow');
    expect(res.status).toBe(404);
    expect((await stateOf(id))?.screening).toBe(1); // a 的信仍待審
  });

  it('Codex 修：待審信(含 List-Unsubscribe)不外漏到電子報 lane/計數', async () => {
    const u = await seedUser(env, 'sd3@miseroda.com');
    await deliver(authEmail('sd3@miseroda.com', 'promo@partial.io', 'partial', true), 'promo@partial.io', 'sd3@miseroda.com');
    const id = await ingestLatest(u.userId);
    expect((await stateOf(id))?.screening).toBe(1);
    const c = await getCounts(u);
    expect(c.screening).toBe(1); // 在待審
    expect(c.newsletter).toBe(0); // 不在電子報 lane（已排除）
  });

  it('Codex 修：同條件但停用的舊規則不該壓掉封鎖（仍建一條啟用 spam 規則）', async () => {
    const u = await seedUser(env, 'sd4@miseroda.com');
    // 預先放一條同條件但「停用」的規則（模擬殘留）
    await env.DB.prepare(
      `INSERT INTO rules (id, user_id, name, conditions, actions, enabled, priority, created_at)
       VALUES ('rul_old', ?, '舊', ?, ?, 0, 0, 0)`,
    ).bind(u.userId, JSON.stringify({ fromContains: 'bad@partial.io' }), JSON.stringify({ moveToFolder: 'spam' })).run();
    const id = await seedScreening(u, 'sd4@miseroda.com', 'bad@partial.io');
    expect((await screenDecide(u, id, 'block')).status).toBe(200);
    const enabled = await env.DB.prepare(`SELECT COUNT(*) AS n FROM rules WHERE user_id = ? AND conditions LIKE '%bad@partial.io%' AND enabled = 1`).bind(u.userId).first<{ n: number }>();
    expect(enabled?.n).toBe(1); // 確實建了一條啟用中的封鎖規則
  });
});
