// 開機驗身（效能迴圈 P1，2026-09-22）。純函式、依賴注入 → 可在 worker vitest 單測。
//
// 為什麼要抽出來：原本 App 的開機 effect 是
//   await api('/auth/config')  →  網域檢查  →  await api('/auth/me')
// 兩支都是開機必打、彼此沒有資料依賴，卻串行 —— 實測熱啟動時 /auth/me 要等 config 回來才出發，
// 平白多付一整趟 API 往返（本機約 290 ms，佔熱啟動到畫面時間的 ~35%，見 docs/perf-startup-log.md §4）。
//
// 這裡讓兩支**同時出發**，但**判定順序完全不變**：先看網域（不符就停，不處理身分），再交出 me 的結果。
// 與舊行為唯一的差別：網域不符時 /auth/me 也已經發出去了 —— 但 session cookie 是 `__Host-` 前綴、
// 綁在正式網域，別的網域根本帶不上 cookie，只會拿到一個被丟棄的 401（/auth/* 的 401 也不觸發全域重驗，
// 見 api/unauthorized.ts）。不讀、不存、不顯示任何東西，資料安全不變。
//
// 已知且接受的差異（2026-09-22 審查鏡頭 C 指出，見 docs/perf-startup-log.md D1-1）：
// 兩支並行後，D1 bookmark 的「最後寫入者」取決於回應抵達順序。若 config 回 5xx 且晚於 me 到達，
// api() 的 5xx 自癒會清掉 me 剛寫入的 bookmark；舊的串行寫法裡 me 永遠是最後寫入者。
// bookmark 只是讀取複本的版本提示（不具授權效力、不含個資），這類「最後回應覆蓋」競態在 App 每批
// 並行請求裡本來就存在並被 api/bookmark.ts 明文接受；最壞只讓開機後第一次讀取暫失讀你所寫保證，下個回應即自癒。

export interface BootDeps<M> {
  host: string;
  fetchConfig: () => Promise<{ rpId: string }>;
  fetchMe: () => Promise<M>;
}

export type BootResult<M> = { kind: 'wrong-host' } | { kind: 'proceed'; me: Promise<M> };

/** 正式網域以外（本機開發除外）一律視為網域不符——passkey 綁網域，在別處註冊的無法在正式站使用。 */
export function isWrongHost(host: string, rpId: string): boolean {
  return host !== rpId && host !== 'localhost' && host !== '127.0.0.1';
}

/**
 * 同時發出 config 與 me，先依 config 判網域，再把 me 的 promise 原樣交給呼叫端處理
 * （呼叫端的 try/catch 仍會收到原本的 rejection：401／斷線的分支邏輯一字不改）。
 */
export async function bootAuth<M>(deps: BootDeps<M>): Promise<BootResult<M>> {
  const me = deps.fetchMe();
  // 網域不符會提早 return、沒有人 await `me` → 掛一個空 catch 防 unhandled rejection。
  // 這不會吞掉錯誤：呼叫端 await 的仍是原本的 `me`，它照樣 reject。
  me.catch(() => {});
  try {
    const cfg = await deps.fetchConfig();
    if (isWrongHost(deps.host, cfg.rpId)) return { kind: 'wrong-host' };
  } catch {
    /* config 拿不到時不擋（與原行為一致） */
  }
  return { kind: 'proceed', me };
}
