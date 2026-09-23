// 全域 401 處理（與 fetch 包裝拆開，保持純淨：不碰 document/DOM，方便在 worker 測試環境單測）。
// 任一非 auth 端點回 401（工作階段可能已失效）時通知 App 重新驗證——App 註冊的 handler 會以
// /auth/me 重新確認：真失效才掉登入、誤觸（單一端點偶發 401）則維持登入，避免誤登出。
let unauthorizedHandler: (() => void) | null = null;
let revalidateTimer: ReturnType<typeof setTimeout> | null = null;

export function setUnauthorizedHandler(fn: (() => void) | null): void {
  unauthorizedHandler = fn;
}

/** 去抖通知：合併同一波多個 401（多個查詢同時失敗）為一次重新驗證；排除 /auth/* 自身（避免迴圈）。 */
export function noteUnauthorized(path: string, status: number): void {
  if (status !== 401 || path.startsWith('/auth/') || !unauthorizedHandler) return;
  if (revalidateTimer) return; // 已排程 → 合併
  revalidateTimer = setTimeout(() => {
    revalidateTimer = null;
    unauthorizedHandler?.();
  }, 300);
}
