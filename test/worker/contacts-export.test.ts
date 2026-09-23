// 聯絡人聚合/覆寫 + plus 別名統計 + mbox 匯出
import { describe, expect, it } from 'vitest';
import { createExecutionContext, env } from 'cloudflare:test';
import worker from '../../src/worker/index';
import { mockEmailMessage, plainEmail, seedUser } from './helpers/fixtures';

const BASE = 'https://mail.miseroda.com/api/v1';

function quietEnv() {
  return { ...env, INGEST_QUEUE: { send: async () => {} } } as unknown as typeof env;
}

async function apiCall(
  path: string,
  cookies: { session: string; csrf: string },
  targetEnv: typeof env,
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
    targetEnv,
    createExecutionContext(),
  );
}

describe('contacts / aliases / export', () => {
  it('aggregates contacts, saves overrides, lists aliases, streams mbox', async () => {
    const qenv = quietEnv();
    const hon = await seedUser(env, 'hon@miseroda.com', 'admin');

    // 收一封外部信（建立聯絡人來源 + 別名 + raw .eml）
    await worker.email(
      mockEmailMessage(plainEmail({ from: 'alice@example.com', fromName: 'Alice', subject: '哈囉', to: 'hon+news@miseroda.com' }), {
        from: 'alice@example.com',
        to: 'hon+news@miseroda.com',
      }).message,
      qenv,
      createExecutionContext(),
    );

    /* ---- 聯絡人聚合 ---- */
    const list = await (await apiCall('/contacts', hon.cookies, qenv)).json<{
      contacts: { email: string; knownName: string; customName: string; count: number }[];
    }>();
    const alice = list.contacts.find((ct) => ct.email === 'alice@example.com');
    expect(alice).toBeTruthy();
    expect(alice!.knownName).toBe('Alice');

    /* ---- 自訂名稱覆寫 ---- */
    const put = await apiCall(`/contacts/${encodeURIComponent('alice@example.com')}`, hon.cookies, qenv, {
      method: 'PUT',
      body: { customName: '小艾', note: '潛水同好' },
    });
    expect(put.status).toBe(200);
    const list2 = await (await apiCall('/contacts', hon.cookies, qenv)).json<{
      contacts: { email: string; customName: string; note: string }[];
    }>();
    const alice2 = list2.contacts.find((ct) => ct.email === 'alice@example.com');
    expect(alice2!.customName).toBe('小艾');
    expect(alice2!.note).toBe('潛水同好');

    /* ---- 別名統計 ---- */
    const aliases = await (await apiCall('/aliases', hon.cookies, qenv)).json<{
      aliases: { address: string; tag: string; count: number }[];
    }>();
    expect(aliases.aliases.find((a) => a.tag === 'news')?.count).toBe(1);

    /* ---- mbox 匯出 ---- */
    const mbox = await apiCall('/export/mbox', hon.cookies, qenv);
    expect(mbox.status).toBe(200);
    expect(mbox.headers.get('Content-Type')).toBe('application/mbox');
    const text = await mbox.text();
    expect(text.startsWith('From alice@example.com ')).toBe(true);
    expect(text).toContain('Subject:'); // 原始 .eml 內容在裡面

    /* ---- 隔離：別人看不到我的聯絡人覆寫 ---- */
    const kai = await seedUser(env, 'kai@miseroda.com');
    const kaiList = await (await apiCall('/contacts', kai.cookies, qenv)).json<{ contacts: unknown[] }>();
    expect(kaiList.contacts).toHaveLength(0);
  });

  it('F4.3a：PUT 公司/職稱/生日/地址 → GET 回傳；vCard 匯入保留 ORG/BDAY', async () => {
    const qenv = quietEnv();
    const u = await seedUser(env, 'cf@miseroda.com');
    const put = await apiCall(`/contacts/${encodeURIComponent('boss@corp.com')}`, u.cookies, qenv, {
      method: 'PUT',
      body: { customName: '老闆', company: 'Acme', title: 'CEO', birthday: '1980-03-01', address: '台北' },
    });
    expect(put.status).toBe(200);
    const list = await (await apiCall('/contacts', u.cookies, qenv)).json<{
      contacts: { email: string; company: string; title: string; birthday: string; address: string }[];
    }>();
    expect(list.contacts.find((x) => x.email === 'boss@corp.com')).toMatchObject({ company: 'Acme', title: 'CEO', birthday: '1980-03-01', address: '台北' });

    const vcf = ['BEGIN:VCARD', 'VERSION:3.0', 'FN:Jane', 'EMAIL:jane@corp.com', 'ORG:Globex', 'BDAY:1990-07-07', 'END:VCARD'].join('\r\n');
    expect((await apiCall('/contacts/import', u.cookies, qenv, { body: { vcf } })).status).toBe(200);
    const list2 = await (await apiCall('/contacts', u.cookies, qenv)).json<{ contacts: { email: string; company: string; birthday: string }[] }>();
    expect(list2.contacts.find((x) => x.email === 'jane@corp.com')).toMatchObject({ company: 'Globex', birthday: '1990-07-07' });
  });
});
