// F19.1 / 2026-09-20 安全掃描 F3：對話串扇出無上限 → 一次讀信請求就能在單一 isolate 裡配置數百 MB，
// 連帶殺掉同 isolate 上其他使用者的請求，而那一串對受害者形同永久打不開。
// 對話串成員完全由寄件者自選的 In-Reply-To/References 決定，所以「串有多長」是攻擊者說了算。
import { describe, expect, it } from 'vitest';
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../../src/worker/index';
import { seedUser } from './helpers/fixtures';

const uniq = () => crypto.randomUUID().replace(/-/g, '').slice(0, 10);

type User = Awaited<ReturnType<typeof seedUser>>;

async function seedThread(u: User, threadId: string, n: number, bodyBytes: number) {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = `m-${uniq()}`;
    ids.push(id);
    const key = `html/${u.userId}/${id}.html`;
    await env.MAIL_STORE.put(key, '<p>' + 'x'.repeat(bodyBytes) + '</p>');
    await env.DB.prepare(
      `INSERT INTO messages (id, user_id, thread_id, direction, from_addr, from_name, to_addrs, subject, snippet, folder, r2_html_key, received_at, created_at)
       VALUES (?, ?, ?, 'inbound', 'a@evil.example', 'A', '[]', ?, '', 'inbox', ?, ?, ?)`,
    ).bind(id, u.userId, threadId, `第 ${i} 封`, key, 1000 + i, 1000 + i).run();
  }
  return ids;
}

async function openThread(u: User, id: string) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`https://mail.miseroda.com/api/v1/messages/${id}`, {
      headers: { Cookie: `__Host-session=${encodeURIComponent(u.cookies.session)}; __Host-csrf=${encodeURIComponent(u.cookies.csrf)}` },
    }),
    env,
    ctx,
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { thread: { id: string; html: string; htmlOmitted?: boolean }[] };
  await waitOnExecutionContext(ctx);
  return body.thread;
}

describe('對話串扇出的邊界（F19.1）', () => {
  it('一般對話串（少量、小內文）：每一封都照常帶完整內文，行為不變', async () => {
    const u = await seedUser(env, `t1-${uniq()}@miseroda.com`);
    const ids = await seedThread(u, `th-${uniq()}`, 3, 100);
    const thread = await openThread(u, ids[1]);
    expect(thread.length).toBe(3);
    expect(thread.every((m) => m.html.length > 0)).toBe(true);
    expect(thread.some((m) => m.htmlOmitted)).toBe(false);
  });

  it('超大對話串：內文份數受限、其餘標 htmlOmitted，而不是全部載進記憶體', async () => {
    const u = await seedUser(env, `t2-${uniq()}@miseroda.com`);
    // 25 封 × 120 KB：份數上限 20、位元組上限 2 MB，兩道都會踩到
    const ids = await seedThread(u, `th-${uniq()}`, 25, 120_000);
    const thread = await openThread(u, ids[0]);
    const withBody = thread.filter((m) => m.html.length > 0);
    const omitted = thread.filter((m) => m.htmlOmitted);
    expect(withBody.length).toBeLessThanOrEqual(20);          // 份數上限
    expect(omitted.length).toBeGreaterThan(0);                // 其餘明確標示，不是靜默空白
    expect(withBody.length + omitted.length).toBe(thread.length);
    const bytes = withBody.reduce((n, m) => n + m.html.length, 0);
    expect(bytes).toBeLessThan(2 * 1024 * 1024 + 200_000);    // 位元組預算（容許最後一封超出）
  });

  it('被請求的那一封永遠排第一順位 → 一定載得到內文', async () => {
    const u = await seedUser(env, `t3-${uniq()}@miseroda.com`);
    const ids = await seedThread(u, `th-${uniq()}`, 25, 120_000);
    // 挑最舊的那封（預設優先序最低）——它被請求時仍必須有內文
    const thread = await openThread(u, ids[0]);
    const target = thread.find((m) => m.id === ids[0])!;
    expect(target.html.length).toBeGreaterThan(0);
    expect(target.htmlOmitted).toBe(false);
  });

  it('超長對話串：回傳筆數受 MAX_THREAD_MESSAGES 限制，且保留的是最新的那些', async () => {
    const u = await seedUser(env, `t4-${uniq()}@miseroda.com`);
    const ids = await seedThread(u, `th-${uniq()}`, 210, 50);
    const thread = await openThread(u, ids[209]);
    expect(thread.length).toBeLessThanOrEqual(200);
    expect(thread.some((m) => m.id === ids[209])).toBe(true);  // 最新的在
    expect(thread.some((m) => m.id === ids[0])).toBe(false);   // 最舊的被截掉
  });
});
