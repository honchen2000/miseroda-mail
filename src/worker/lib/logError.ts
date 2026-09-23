// F12.2：真錯誤集中記錄到 error_log（ring buffer；admin 系統頁檢視）。
// 鐵則：logError 是**診斷輔助**，絕不可拖垮主流程——
//   ① 自身寫入失敗一律吞掉（最多 console.error 一次做最後防線），不 rethrow；
//   ② 不遞迴（自己的 catch 內不再呼叫 logError）；
//   ③ 只記「真錯誤」（重試後仍失敗、整段管線失敗），best-effort 單筆預期失敗仍用 console.error。
import { newId } from './ids';

export async function logError(
  env: Env,
  scope: string,
  err: unknown,
  meta?: Record<string, unknown>,
): Promise<void> {
  const message = String(err instanceof Error ? (err.stack ?? err.message) : err).slice(0, 2000);
  // console 保留：既有觀測（wrangler tail）不因入表而消失
  console.error(`[${scope}]`, err);
  try {
    await env.DB.prepare(
      `INSERT INTO error_log (id, scope, message, meta, created_at) VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(newId('err'), scope.slice(0, 80), message, meta ? JSON.stringify(meta).slice(0, 2000) : null, Date.now())
      .run();
  } catch {
    // 靜默：D1 配額/鎖爭用時，診斷記錄失敗絕不可反噬主流程
  }
}
