import { cookieNames, getSessionUser, parseCookies } from './auth/sessions';
import { newId } from './lib/ids';
import { r2UploadKey } from './lib/keys';
import { checkRateLimit } from './lib/ratelimit';

const SHARE_MAX_FILE_BYTES = 5 * 1024 * 1024; // 同寄信附件上限（MAX_SEND_BYTES）
const SHARE_MAX_FILES = 10; // 單次分享最多幾個檔（防儲存濫用）
const SHARE_PAYLOAD_TTL_S = 600; // 暫存 payload 在 KV 存活 10 分鐘

/**
 * F7.2 Web Share Target：別 App 分享進來 → 暫存附件到 R2（同 /attachments/upload）
 * + 把 {主旨,內文,附件清單} 存 KV 短 TTL token → 302 到 `/?share=<token>`，前端開 compose 還原。
 *
 * 走「頂層路由」（非 /api，繞過 requireSession 會回 401 的行為），自行驗 session：
 * - 未登入 → 302 導去登入頁（Hon 拍板的 MVP；這次分享內容不保留）。
 * - OS 分享的 POST 不可能帶 app 的 CSRF token，故此端點不檢 CSRF；其動作「非破壞性」
 *   （只暫存附件 + 開草稿，不寄出、不刪除、無 migration），以 session-gated + 檔數/大小上限
 *   作為濫用防線。token 高熵且 KV key 綁 userId（跨使用者隔離）。
 */
export async function handleShareTarget(request: Request, env: Env): Promise<Response> {
  const origin = new URL(request.url).origin;
  const toLogin = () => Response.redirect(`${origin}/`, 302);

  const names = cookieNames(env);
  const cookies = parseCookies(request.headers.get('Cookie'));
  const sessionToken = cookies[names.session];
  const found = sessionToken ? await getSessionUser(env, sessionToken) : null;
  if (!found) return toLogin();
  const userId = found.user.id;

  // MFA 對等：取回端點走 requireSession（會擋未啟用 TOTP）；此寫入端在 Hono 之外，需自行比照，
  // 否則半完成註冊的 session 也能暫存檔案（讀取雖被擋，但寫入不一致＝會爛的破口）。
  const totp = await env.DB.prepare(`SELECT enabled FROM totp_secrets WHERE user_id = ?`)
    .bind(userId)
    .first<{ enabled: number }>();
  if (!totp?.enabled) return toLogin();

  // 唯讀 demo 帳號：此端點在 Hono 之外，requireSession 的 demo_readonly 守門不會生效——在此比照擋下
  // （否則 demo 可透過 Web Share Target 寫 R2 + attachments + KV）。demo 免 TOTP 但上一行不擋它（TOTP 關），故這行必要。
  if (found.user.is_demo) return toLogin();

  // 速率限制：此端點在 Hono 之外、無 rateLimitMw → 自己擋。每人 10 次/分，封住「無限 multipart POST」
  // 的記憶體/R2/KV DoS 與儲存灌爆（CSRF 灌檔也一併被此上限框住）。
  if (!(await checkRateLimit(env, `share-target:u:${userId}`, 10, 60))) return toLogin();

  // formData() 會把整個 body 緩衝進記憶體；先用 Content-Length 擋掉超大 body（在逐檔大小檢查「之前」），
  // 避免巨型 multipart 在驗證前就吃爆 workerd 記憶體。
  const declaredBytes = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredBytes) && declaredBytes > SHARE_MAX_FILE_BYTES * SHARE_MAX_FILES) return toLogin();

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return toLogin();
  }

  const getStr = (k: string, max: number) => {
    const v = form.get(k);
    return typeof v === 'string' ? v.slice(0, max) : '';
  };
  const title = getStr('title', 500);
  const text = getStr('text', 50_000);
  const sharedUrl = getStr('url', 2_000);

  const files = form.getAll('files').filter((f): f is File => f instanceof File).slice(0, SHARE_MAX_FILES);
  const attachments: { id: string; filename: string; mimeType: string; sizeBytes: number }[] = [];
  for (const file of files) {
    if (file.size === 0 || file.size > SHARE_MAX_FILE_BYTES) continue; // 跳過空檔/超大檔
    const id = newId('att');
    const key = r2UploadKey(userId, id);
    const mime = file.type || 'application/octet-stream';
    await env.MAIL_STORE.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: mime } });
    await env.DB.prepare(
      `INSERT INTO attachments (id, message_id, user_id, filename, mime_type, size_bytes, disposition, r2_key, created_at)
       VALUES (?, NULL, ?, ?, ?, ?, 'attachment', ?, ?)`,
    )
      .bind(id, userId, file.name || 'attachment', mime, file.size, key, Date.now())
      .run();
    attachments.push({ id, filename: file.name || 'attachment', mimeType: mime, sizeBytes: file.size });
  }

  const body = [text, sharedUrl].filter(Boolean).join('\n\n');
  if (!title && !body && attachments.length === 0) return toLogin(); // 沒有可帶入的內容 → 不必開草稿

  // 高熵 token（18 bytes = 144 bits）；KV key 綁 userId → 取回端點以 session 的 userId 查，跨人隔離。
  const shareToken = Array.from(crypto.getRandomValues(new Uint8Array(18)), (b) => b.toString(16).padStart(2, '0')).join('');
  await env.KV.put(
    `share:${userId}:${shareToken}`,
    JSON.stringify({ subject: title, body, attachments }),
    { expirationTtl: SHARE_PAYLOAD_TTL_S },
  );
  return Response.redirect(`${origin}/?share=${shareToken}`, 302);
}
