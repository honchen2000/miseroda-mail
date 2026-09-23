// 測試用 .eml fixtures 與 mock ForwardableEmailMessage
import { sha256Hex, randomToken, bufToB64url, randomBytes } from '../../../src/worker/lib/crypto';
import { newId } from '../../../src/worker/lib/ids';

const CRLF = '\r\n';

function encWord(text: string): string {
  return `=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(text)))}?=`;
}

export function plainEmail(opts: {
  from?: string;
  fromName?: string;
  to?: string;
  subject?: string;
  body?: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string;
  extraHeaders?: string[];
}): string {
  const lines = [
    `From: ${opts.fromName ? `${encWord(opts.fromName)} ` : ''}<${opts.from ?? 'friend@example.com'}>`,
    `To: <${opts.to ?? 'hon@miseroda.com'}>`,
    `Subject: ${encWord(opts.subject ?? '測試主旨')}`,
    `Message-ID: ${opts.messageId ?? `<${newId('mid')}@example.com>`}`,
    ...(opts.inReplyTo ? [`In-Reply-To: ${opts.inReplyTo}`] : []),
    ...(opts.references ? [`References: ${opts.references}`] : []),
    `Date: Wed, 10 Jun 2026 12:00:00 +0000`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=utf-8`,
    `Content-Transfer-Encoding: 8bit`,
    ...(opts.extraHeaders ?? []),
    '',
    opts.body ?? '哈囉，這是測試信件內容。',
  ];
  return lines.join(CRLF);
}

export function htmlXssEmail(to = 'hon@miseroda.com'): string {
  const html = [
    '<html><body>',
    '<p>正常段落 with <b>bold</b></p>',
    '<script>alert("xss")</script>',
    '<img src="x" onerror="alert(1)">',
    '<a href="javascript:alert(2)">惡意連結</a>',
    '<a href="https://example.com/ok">正常連結</a>',
    '<img src="https://tracker.example.com/pixel.png">',
    '<style>body{display:none}</style>',
    '<iframe src="https://evil.example.com"></iframe>',
    '<form action="https://phish.example.com"><input name="pw"></form>',
    '</body></html>',
  ].join('');
  return [
    `From: <newsletter@example.com>`,
    `To: <${to}>`,
    `Subject: ${encWord('HTML 測試信')}`,
    `Message-ID: <xss-test@example.com>`,
    `MIME-Version: 1.0`,
    `Content-Type: text/html; charset=utf-8`,
    '',
    html,
  ].join(CRLF);
}

/** HTML 信：From 標頭含 CJK 顯示名 + 三種 inline style（安全尺寸/排版、覆蓋類、遠端背景圖） */
export function htmlStyleEmail(to = 'hon@miseroda.com'): string {
  const html = [
    '<html><body>',
    '<img src="https://abao-massage.miseroda.com/logo.png" style="width:120px;max-width:120px;height:auto">',
    '<div style="text-align:center;color:#223344;font-size:18px;position:fixed;top:0">標題</div>',
    '<div style="background:url(https://tracker.example.com/p.png);padding:8px">內文</div>',
    '</body></html>',
  ].join('');
  return [
    `From: ${encWord('葆健室')} <system@abao-massage.miseroda.com>`,
    `To: <${to}>`,
    `Subject: ${encWord('預約確認')}`,
    `Message-ID: <style-test@abao-massage.miseroda.com>`,
    `MIME-Version: 1.0`,
    `Content-Type: text/html; charset=utf-8`,
    '',
    html,
  ].join(CRLF);
}

export function attachmentEmail(to = 'hon@miseroda.com'): string {
  const boundary = 'BOUNDARY42';
  const pdfBytes = btoa('fake-pdf-bytes-for-test');
  return [
    `From: ${encWord('林小螢')} <firefly@example.com>`,
    `To: <${to}>`,
    `Subject: ${encWord('七月小琉球潛水！要不要一起')}`,
    `Message-ID: <dive-invite@example.com>`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    `Content-Type: text/plain; charset=utf-8`,
    `Content-Transfer-Encoding: 8bit`,
    '',
    '民宿還有一間雙人房，行程附在附件！',
    `--${boundary}`,
    `Content-Type: application/pdf; name="itinerary.pdf"`,
    `Content-Disposition: attachment; filename="itinerary.pdf"`,
    `Content-Transfer-Encoding: base64`,
    '',
    pdfBytes,
    `--${boundary}--`,
  ].join(CRLF);
}

/** 會議邀請信：multipart/mixed 帶 text/calendar（method=REQUEST）的 .ics */
export function calendarInviteEmail(to = 'hon@miseroda.com'): string {
  const boundary = 'CALBND42';
  const icsBody = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//EN', 'METHOD:REQUEST',
    'BEGIN:VEVENT', 'UID:evt-1@example.com', 'SUMMARY:季度會議',
    'DTSTART:20260620T060000Z', 'DTEND:20260620T070000Z',
    'LOCATION:會議室 A', 'ORGANIZER;CN=陳主管:mailto:lead@example.com', 'END:VEVENT', 'END:VCALENDAR',
  ].join(CRLF);
  return [
    `From: ${encWord('陳主管')} <lead@example.com>`,
    `To: <${to}>`,
    `Subject: ${encWord('會議邀請：季度會議')}`,
    `Message-ID: <cal-invite@example.com>`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    `Content-Type: text/plain; charset=utf-8`,
    '',
    '請出席季度會議。',
    `--${boundary}`,
    `Content-Type: text/calendar; method=REQUEST; charset=utf-8; name="invite.ics"`,
    `Content-Disposition: attachment; filename="invite.ics"`,
    '',
    icsBody,
    `--${boundary}--`,
  ].join(CRLF);
}

export function spamEmail(to = 'hon@miseroda.com'): string {
  return plainEmail({
    from: 'winner@crypto-scam.example',
    to,
    subject: 'You won 5 BTC',
    body: 'claim now',
    extraHeaders: [
      'Authentication-Results: mx.cloudflare.net; spf=fail smtp.mailfrom=crypto-scam.example; dkim=fail; dmarc=fail',
    ],
  });
}

export interface MockEmailResult {
  rejected: string | null;
  forwarded: string[];
}

export function mockEmailMessage(
  raw: string,
  opts: { from?: string; to?: string } = {},
): { message: ForwardableEmailMessage; result: MockEmailResult } {
  const bytes = new TextEncoder().encode(raw);
  const result: MockEmailResult = { rejected: null, forwarded: [] };
  const message = {
    from: opts.from ?? 'friend@example.com',
    to: opts.to ?? 'hon@miseroda.com',
    raw: new Response(bytes).body!,
    rawSize: bytes.byteLength,
    headers: new Headers(),
    setReject(reason: string) {
      result.rejected = reason;
    },
    async forward(addr: string) {
      result.forwarded.push(addr);
    },
    async reply() {},
  } as unknown as ForwardableEmailMessage;
  return { message, result };
}

/** 直接在 D1 造使用者 + session（繞過完整 auth 流程，加速非 auth 測試） */
export async function seedUser(
  env: Env,
  email: string,
  role: 'admin' | 'user' = 'user',
): Promise<{ userId: string; cookies: { session: string; csrf: string } }> {
  const userId = newId('usr');
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO users (id, email, display_name, role, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)`,
  )
    .bind(userId, email.toLowerCase(), email.split('@')[0], role, now)
    .run();
  // 預設視為已完成入會（啟用 TOTP），通過伺服器端 MFA 強制；測試 MFA 流程時自行覆寫
  await env.DB.prepare(
    `INSERT INTO totp_secrets (user_id, secret_enc, enabled, created_at) VALUES (?, 'x', 1, ?)`,
  )
    .bind(userId, now)
    .run();
  const token = randomToken();
  const csrf = bufToB64url(randomBytes(16));
  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, client, created_at, expires_at) VALUES (?, ?, 'web', ?, ?)`,
  )
    .bind(await sha256Hex(token), userId, now, now + 86400_000)
    .run();
  return { userId, cookies: { session: token, csrf } };
}
