// 大附件公開下載：GET /dl/:token（在 index.ts fetch 攔截，不經 /api、無 session）。
// 安全：token 高熵不可猜；一律以 application/octet-stream + Content-Disposition: attachment 提供，
// 避免使用者上傳的 HTML/SVG 在 mail.miseroda.com 同源被當頁面執行（XSS）；過期回 410。

export async function serveSharedFile(token: string, env: Env): Promise<Response> {
  // token = 24 bytes hex（見 /share/upload）；格式不符直接 404，杜絕路徑穿越/掃描。
  if (!/^[a-f0-9]{48}$/.test(token)) return new Response('Not found', { status: 404 });

  const row = await env.DB.prepare(
    `SELECT id, r2_key, filename, mime_type, size_bytes, expires_at FROM shared_files WHERE token = ?`,
  )
    .bind(token)
    .first<{ id: string; r2_key: string; filename: string; mime_type: string; size_bytes: number; expires_at: number }>();
  if (!row) return new Response('Not found', { status: 404 });
  if (row.expires_at < Date.now()) return new Response('此下載連結已過期。', { status: 410 });

  const obj = await env.MAIL_STORE.get(row.r2_key);
  if (!obj) return new Response('Not found', { status: 404 });

  // 下載計數（best-effort）。
  await env.DB.prepare(`UPDATE shared_files SET download_count = download_count + 1 WHERE id = ?`).bind(row.id).run();

  // 中文/emoji 檔名直接塞進 header 會在 workerd 觸發 ByteString 例外（→ 500）。
  // 比照 mail.ts 附件下載：ASCII fallback（filename=）+ RFC 5987 真名（filename*=UTF-8''…）。
  const asciiName = row.filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_').slice(0, 200) || 'download';
  const utf8Name = encodeURIComponent(row.filename).slice(0, 300);
  return new Response(obj.body, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${utf8Name}`,
      'Content-Length': String(row.size_bytes),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    },
  });
}
