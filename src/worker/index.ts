import { createApi } from './api/app';
import { serveSharedFile } from './share';
import { serveCalFeed } from './calfeed';
import { handleShareTarget } from './share-target';
import { serveDecryptJs, serveEncryptedData, serveEncryptedPage } from './encrypted';
import { handleEmail } from './email/ingest';
import { runDailyDigest } from './jobs/digest';
import { BACKUP_CRON, runBackup } from './jobs/backup';
import { ICS_SYNC_CRON, runIcsSync } from './jobs/icsSync';
import { processIngestJob } from './jobs/ingestConsumer';
import { processImportJob } from './jobs/importConsumer';
import { processSendJob } from './jobs/sendConsumer';
import { sweep } from './jobs/sweep';
import { logError } from './lib/logError';
import type { QueueJob } from './jobs/types';

const DIGEST_CRON = '0 0 * * *'; // 00:00 UTC = 08:00 台北

export { UserHub } from './realtime';

const api = createApi();

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // React inline style 屬性 + 信件 srcdoc 內注入的 <style>；Google Fonts 樣式表
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  // 信件 iframe(srcdoc) 繼承本 CSP：使用者點「載入圖片」後需放行任意 https 圖源；cid 圖走 self
  "img-src 'self' data: blob: https:",
  "connect-src 'self'",
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

function withSecurityHeaders(res: Response): Response {
  const out = new Response(res.body, res);
  out.headers.set('Strict-Transport-Security', 'max-age=31536000');
  out.headers.set('X-Content-Type-Options', 'nosniff');
  out.headers.set('Referrer-Policy', 'no-referrer');
  if (out.headers.get('Content-Type')?.includes('text/html')) {
    out.headers.set('Content-Security-Policy', CSP);
    out.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  }
  return out;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      const res = await api.fetch(request, env, ctx);
      // WebSocket 升級回應不能重建（會丟失 webSocket 物件），原樣放行
      if (res.status === 101) return res;
      return withSecurityHeaders(res);
    }
    // 大附件公開下載（不經 /api、無 session）：token 在路徑、檔案以 attachment 強制下載。
    if (url.pathname.startsWith('/dl/')) {
      return withSecurityHeaders(await serveSharedFile(decodeURIComponent(url.pathname.slice('/dl/'.length)), env));
    }
    // F7.2 Web Share Target：別 App 分享進來（OS POST multipart，無 CSRF token，自驗 session → 302）。
    if (url.pathname === '/share-target' && request.method === 'POST') {
      return withSecurityHeaders(await handleShareTarget(request, env));
    }
    // F11.2 行事曆 ICS 訂閱 feed（公開唯讀、高熵 token、IP 限流；家人互訂）。
    if (url.pathname.startsWith('/cal/') && request.method === 'GET') {
      const token = decodeURIComponent(url.pathname.slice('/cal/'.length));
      if (token && !token.includes('/')) {
        return withSecurityHeaders(await serveCalFeed(token, env, request.headers.get('CF-Connecting-IP') ?? 'unknown'));
      }
    }
    // F7.7 訊息級加密連結（公開、無 session）：解密頁 + 外部腳本（符合 CSP 'self'）+ 密文 bundle。
    if (url.pathname === '/e-decrypt.js') return withSecurityHeaders(serveDecryptJs());
    if (url.pathname.startsWith('/e/')) {
      const rest = url.pathname.slice('/e/'.length);
      if (rest.endsWith('/raw')) return withSecurityHeaders(await serveEncryptedData(decodeURIComponent(rest.slice(0, -4)), env));
      if (rest && !rest.includes('/')) return withSecurityHeaders(serveEncryptedPage());
    }
    // 靜態資產 + SPA fallback（binding 處理 html_handling / not_found_handling / 快取協商）
    return withSecurityHeaders(await env.ASSETS.fetch(request));
  },

  // Email Routing ingest：守門 → R2 → D1 → INGEST_QUEUE（重活在 consumer）
  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    await handleEmail(message, env, ctx);
  },

  // 佇列消費者：逐則處理，失敗 retry（最終進 DLQ）
  async queue(batch: MessageBatch<unknown>, env: Env, _ctx: ExecutionContext): Promise<void> {
    // F18.1：DLQ 之前沒有任何 consumer（2026-09-20 查證）——重試 5 次仍失敗的 job 會靜靜躺在裡面，沒人知道。
    // 這裡只做一件事：記進 error_log（scope = dlq.<kind>）然後 ack，讓失敗至少在管理頁看得到。不重試、不重跑。
    if (batch.queue === 'miseroda-dlq') {
      for (const msg of batch.messages) {
        const kind = (msg.body as { kind?: string } | null)?.kind ?? 'unknown';
        await logError(env, `dlq.${kind}`, 'job exhausted retries', { body: msg.body });
        msg.ack();
      }
      return;
    }
    for (const msg of batch.messages) {
      const job = msg.body as QueueJob;
      try {
        if (job.kind === 'ingest') {
          await processIngestJob(env, job);
        } else if (job.kind === 'send') {
          await processSendJob(env, job);
        } else if (job.kind === 'import-mbox') {
          await processImportJob(env, job);
        }
        msg.ack();
      } catch (err) {
        await logError(env, `queue.${(job as { kind?: string })?.kind ?? 'unknown'}`, err); // F12.2
        msg.retry();
      }
    }
  },

  // 每分鐘：排程寄送掃描 + 過期清理 / 每日：AI 晨報
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (controller.cron === DIGEST_CRON) {
      ctx.waitUntil(runDailyDigest(env));
    } else if (controller.cron === BACKUP_CRON) {
      ctx.waitUntil(runBackup(env)); // F12.1：每日 D1 → R2 備份 + 輪替
    } else if (controller.cron === ICS_SYNC_CRON) {
      ctx.waitUntil(runIcsSync(env)); // F14.1：每 6h 同步外部 ICS 訂閱 → KV 快取
    } else {
      await sweep(env);
    }
  },
} satisfies ExportedHandler<Env>;
