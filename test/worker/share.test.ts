// 大附件轉連結：上傳（R2+token）→ 公開 /dl 下載（attachment/octet-stream 防 XSS）→ 過期 410 + sweep 清理。
import { describe, expect, it } from 'vitest';
import { createExecutionContext, env } from 'cloudflare:test';
import worker from '../../src/worker/index';
import { seedUser } from './helpers/fixtures';
import { sweep } from '../../src/worker/jobs/sweep';

const BASE = 'https://mail.miseroda.com/api/v1';
function quietEnv() {
  return { ...env, INGEST_QUEUE: { send: async () => {} }, SEND_QUEUE: { send: async () => {} } } as unknown as typeof env;
}
function uploadShare(cookies: { session: string; csrf: string }, content: string, filename: string) {
  const form = new FormData();
  form.set('file', new File([content], filename, { type: 'application/zip' }));
  return worker.fetch(
    new Request(`${BASE}/share/upload`, {
      method: 'POST',
      headers: {
        Cookie: `__Host-session=${encodeURIComponent(cookies.session)}; __Host-csrf=${encodeURIComponent(cookies.csrf)}`,
        'X-CSRF-Token': cookies.csrf,
      },
      body: form,
    }),
    quietEnv(),
    createExecutionContext(),
  );
}
function getDl(token: string) {
  return worker.fetch(new Request(`https://mail.miseroda.com/dl/${token}`), quietEnv(), createExecutionContext());
}

describe('large attachment share link', () => {
  it('上傳 → 公開下載（attachment/octet-stream）→ 內容正確', async () => {
    const hon = await seedUser(env, 'hon@miseroda.com', 'admin');
    const res = await uploadShare(hon.cookies, 'BIGFILECONTENT', 'report.zip');
    expect(res.status).toBe(200);
    const { token, url, sizeBytes } = await res.json<{ token: string; url: string; sizeBytes: number }>();
    expect(url).toContain(`/dl/${token}`);
    expect(/^[a-f0-9]{48}$/.test(token)).toBe(true);
    expect(sizeBytes).toBe('BIGFILECONTENT'.length);

    const dl = await getDl(token);
    expect(dl.status).toBe(200);
    expect(dl.headers.get('Content-Disposition')).toContain('attachment');
    // 安全：一律 octet-stream（防 mail.miseroda.com 同源把上傳的 HTML 當頁面執行）
    expect(dl.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(await dl.text()).toBe('BIGFILECONTENT');
  });

  it('中文檔名下載不爆（RFC 5987 編碼，修復前會 500）', async () => {
    const hon = await seedUser(env, 'hon@miseroda.com', 'admin');
    const r = await uploadShare(hon.cookies, 'BYTES', '專案報告.pdf');
    const { token } = await r.json<{ token: string }>();
    const dl = await getDl(token);
    expect(dl.status).toBe(200);
    expect(dl.headers.get('Content-Disposition')).toContain("filename*=UTF-8''");
    expect(await dl.text()).toBe('BYTES');
  });

  it('壞 token → 404；過期 → 410；sweep 清掉過期（R2 + DB）', async () => {
    const hon = await seedUser(env, 'hon@miseroda.com', 'admin');
    expect((await getDl('not-hex-token')).status).toBe(404); // 格式不符
    expect((await getDl('a'.repeat(48))).status).toBe(404); // 格式對但不存在

    const r = await uploadShare(hon.cookies, 'X', 'a.bin');
    const { token } = await r.json<{ token: string }>();
    await env.DB.prepare(`UPDATE shared_files SET expires_at = ? WHERE token = ?`).bind(Date.now() - 1000, token).run();
    expect((await getDl(token)).status).toBe(410); // 過期

    await sweep(quietEnv());
    const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM shared_files WHERE token = ?`)
      .bind(token)
      .first<{ n: number }>();
    expect(n?.n).toBe(0); // 已清理
  });
});
