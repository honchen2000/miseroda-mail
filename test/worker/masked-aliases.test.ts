// F9.4：Masked Email —— 生成 / 停用後 ingest 拒收（且不走過渡轉寄）/ 重啟用復活 / 越權防護。
import { describe, expect, it } from 'vitest';
import { createExecutionContext, env } from 'cloudflare:test';
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

function quietEnv(extra: Record<string, unknown> = {}) {
  return { ...env, INGEST_QUEUE: { send: async () => {} }, ...extra } as unknown as typeof env;
}

async function ingestTo(address: string, targetEnv = quietEnv()) {
  const m = mockEmailMessage(plainEmail({ subject: 'hi', body: 'yo', to: address }), { to: address });
  await worker.email(m.message, targetEnv, createExecutionContext());
  return m.result;
}

describe('F9.4 Masked Email', () => {
  it('生成：格式 word-word-NN@網域、帶備註、出現在 /masked-aliases 清單', async () => {
    const hon = await seedUser(env, 'hon@miseroda.com');
    const res = await apiCall('/masked-aliases', hon.cookies, { body: { note: '購物網站' } });
    expect(res.status).toBe(200);
    const { address } = (await res.json()) as { address: string };
    expect(address).toMatch(/^[a-z]+-[a-z]+-\d{1,2}@miseroda\.com$/);
    const list = (await (await apiCall('/masked-aliases', hon.cookies)).json()) as { aliases: { address: string; note: string | null; disabled: boolean }[] };
    expect(list.aliases.some((a) => a.address === address && a.note === '購物網站' && !a.disabled)).toBe(true);
  });

  it('ingest：啟用中送達擁有者；停用後拒收且絕不走 FORWARD_TO 過渡轉寄；重啟用復活', async () => {
    const hon = await seedUser(env, 'hon@miseroda.com');
    const gen = (await (await apiCall('/masked-aliases', hon.cookies, { body: {} })).json()) as { id: string; address: string };

    // 啟用中 → 送達
    const r1 = await ingestTo(gen.address);
    expect(r1.rejected).toBeNull();
    const n1 = await env.DB.prepare(`SELECT COUNT(*) AS n FROM messages WHERE user_id = ?`).bind(hon.userId).first<{ n: number }>();
    expect(n1!.n).toBe(1);

    // 停用 → 拒收；即使 FORWARD_TO 設定中也不得轉寄（防外洩到過渡信箱）
    expect((await apiCall(`/masked-aliases/${gen.id}`, hon.cookies, { method: 'PATCH', body: { disabled: true } })).status).toBe(200);
    const r2 = await ingestTo(gen.address, quietEnv({ FORWARD_TO: 'legacy@example.com' }));
    expect(r2.rejected).toBeTruthy();
    expect(r2.forwarded).toEqual([]);
    const n2 = await env.DB.prepare(`SELECT COUNT(*) AS n FROM messages WHERE user_id = ?`).bind(hon.userId).first<{ n: number }>();
    expect(n2!.n).toBe(1); // 沒新信落地

    // 重啟用 → 又送達
    expect((await apiCall(`/masked-aliases/${gen.id}`, hon.cookies, { method: 'PATCH', body: { disabled: false } })).status).toBe(200);
    const r3 = await ingestTo(gen.address);
    expect(r3.rejected).toBeNull();
  });

  it('隔離與守門：不能動他人別名；停用別名不出現在撰寫器 identities', async () => {
    const hon = await seedUser(env, 'hon@miseroda.com');
    const kai = await seedUser(env, 'kai@miseroda.com');
    const gen = (await (await apiCall('/masked-aliases', hon.cookies, { body: {} })).json()) as { id: string; address: string };
    expect((await apiCall(`/masked-aliases/${gen.id}`, kai.cookies, { method: 'PATCH', body: { disabled: true } })).status).toBe(404);

    await apiCall(`/masked-aliases/${gen.id}`, hon.cookies, { method: 'PATCH', body: { disabled: true } });
    const ids = (await (await apiCall('/identities', hon.cookies)).json()) as { aliases: { address: string }[] };
    expect(ids.aliases.some((a) => a.address === gen.address)).toBe(false);
  });
});
