// F5.2：附件 inline 預覽——影片/音訊/圖片/PDF 走 inline，文字走 attachment（前端 fetch+<pre>）。
import { describe, expect, it } from 'vitest';
import { createExecutionContext, env } from 'cloudflare:test';
import worker from '../../src/worker/index';
import { seedUser } from './helpers/fixtures';

function get(u: Awaited<ReturnType<typeof seedUser>>, id: string) {
  return worker.fetch(
    new Request(`https://mail.miseroda.com/api/v1/attachments/${id}?inline=1`, {
      headers: { Cookie: `__Host-session=${encodeURIComponent(u.cookies.session)}; __Host-csrf=${encodeURIComponent(u.cookies.csrf)}` },
    }),
    env,
    createExecutionContext(),
  );
}
const addAtt = async (userId: string, id: string, mime: string) => {
  await env.MAIL_STORE.put(`att/${id}`, new Uint8Array([1, 2, 3, 4]));
  await env.DB.prepare(
    `INSERT INTO attachments (id, message_id, user_id, filename, mime_type, size_bytes, disposition, r2_key, created_at)
     VALUES (?, NULL, ?, ?, ?, 4, 'attachment', ?, 0)`,
  ).bind(id, userId, `${id}.bin`, mime, `att/${id}`).run();
};

describe('附件 inline 預覽（F5.2）', () => {
  it('影片/音訊/圖片/PDF → inline；文字 → attachment；型別正確', async () => {
    const u = await seedUser(env, 'ap1@miseroda.com');
    await addAtt(u.userId, 'vid', 'video/mp4');
    await addAtt(u.userId, 'aud', 'audio/mpeg');
    await addAtt(u.userId, 'img', 'image/png');
    await addAtt(u.userId, 'txt', 'text/plain');
    // 消化 body（R2 stream 不取回會卡住 isolatedStorage——CLAUDE.md）
    const disp = async (id: string) => {
      const r = await get(u, id);
      const h = r.headers.get('Content-Disposition') ?? '';
      const ct = r.headers.get('Content-Type') ?? '';
      const nosniff = r.headers.get('X-Content-Type-Options') ?? '';
      await r.arrayBuffer().catch(() => {});
      return { h, ct, nosniff };
    };
    const vid = await disp('vid');
    expect(vid.h).toMatch(/^inline/); // 影片 inline → <video> 可播
    expect(vid.ct).toBe('video/mp4');
    expect(vid.nosniff).toBe('nosniff'); // 防型別嗅探
    expect((await disp('aud')).h).toMatch(/^inline/); // 音訊 inline
    expect((await disp('img')).h).toMatch(/^inline/);
    expect((await disp('txt')).h).toMatch(/^attachment/); // 文字不 inline（前端 fetch 顯示）
  });

  // 寄件人可自選附件 mime_type（ingest 原樣存）：cid inline 端點若照原型別回送 SVG，
  // 開新分頁就是同源文件 XSS（能讀非 HttpOnly 的 __Host-csrf）。
  it('cid inline：SVG 降級成下載、點陣圖照舊 inline；一律帶 sandbox CSP', async () => {
    const u = await seedUser(env, 'ap2@miseroda.com');
    await addAtt(u.userId, 'evilsvg', 'image/svg+xml');
    await addAtt(u.userId, 'okpng', 'image/png');
    const inline = (id: string) =>
      worker.fetch(
        new Request(`https://mail.miseroda.com/api/v1/attachments/${id}/inline`, {
          headers: { Cookie: `__Host-session=${encodeURIComponent(u.cookies.session)}; __Host-csrf=${encodeURIComponent(u.cookies.csrf)}` },
        }),
        env,
        createExecutionContext(),
      );

    const svg = await inline('evilsvg');
    expect(svg.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(svg.headers.get('Content-Disposition')).toBe('attachment');
    expect(svg.headers.get('Content-Security-Policy')).toBe("sandbox; default-src 'none'");
    await svg.arrayBuffer(); // 消化 body

    const png = await inline('okpng');
    expect(png.headers.get('Content-Type')).toBe('image/png'); // 一般圖片照舊
    expect(png.headers.get('Content-Disposition')).toBe('inline');
    expect(png.headers.get('Content-Security-Policy')).toBe("sandbox; default-src 'none'");
    await png.arrayBuffer();
  });

  it('跨使用者：別人的附件 404', async () => {
    const a = await seedUser(env, 'apa@miseroda.com');
    const b = await seedUser(env, 'apb@miseroda.com');
    await addAtt(a.userId, 'mine', 'video/mp4');
    const r = await get(b, 'mine');
    expect(r.status).toBe(404);
    await r.arrayBuffer().catch(() => {}); // 消化 body
  });
});
