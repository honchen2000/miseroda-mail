// 背景自動更新的判斷（2026-09-22 Hon 定案甲案）。純函式、不碰 DOM → 可被 worker vitest 單測。
// 接線在 swUpdate.ts。
//
// 原本：網頁開著時瀏覽器不會主動檢查新版 → 要先重整一次才冒出「立即更新」，按下去再重整一次。
// 現在：主動檢查（切回分頁／取得焦點／每 30 分鐘），偵測到新版就等「安全時機」自動套用：
//   分頁沒被看著 ＋ 有網路 ＋ 沒在忙（沒開撰寫器、沒有對話框、沒有「復原」倒數）。
// 重整後網址保留（F20 路由），回到原本的資料夾與那封信；只有捲動位置會回到頂端。
//
// **每個分頁各自判斷要不要重整**：新 SW 接管時所有分頁都會收到 controllerchange——
// 若照舊一律立刻重整，會把「另一個正在寫信的分頁」一起重整掉。只有使用者親手按「立即更新」的那個分頁立刻重整。

/** 多久主動檢查一次新版（背景分頁同時重試安全時機）。 */
export const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;
/** 兩次檢查的最短間隔（切回分頁、取得焦點很頻繁，別每次都打）。 */
export const MIN_CHECK_GAP_MS = 60 * 1000;
/** 有新版卻一直等不到安全時機超過這麼久 → 退回「立即更新」提示讓使用者自己按。 */
export const FALLBACK_PROMPT_AFTER_MS = 60 * 60 * 1000;
/** 動態載入失敗自動重整的防迴圈窗：這段時間內重整過就不再自動重整。 */
export const CHUNK_RELOAD_GUARD_MS = 2 * 60 * 1000;

export interface PageState {
  /** 分頁是否沒被看著（document.visibilityState === 'hidden'）。 */
  hidden: boolean;
  online: boolean;
  /** 正在做會被重整打斷的事：撰寫器開著（含縮成晶片）、有對話框、「復原」倒數中。 */
  busy: boolean;
}

/** 現在可以不打擾地自動套用／重整嗎？ */
export function isSafeMoment(s: PageState): boolean {
  return s.hidden && s.online && !s.busy;
}

/**
 * 新 SW 接管（controllerchange）後，這個分頁要不要立刻重整。
 * 使用者在「這個分頁」親手按了「立即更新」→ 立刻；否則只在安全時機重整，不然先記著、等下次安全時機。
 */
export function shouldReloadNow(s: PageState & { userRequested: boolean }): boolean {
  return s.userRequested || isSafeMoment(s);
}

/** 距上次檢查夠久了嗎（null＝從沒檢查過）。 */
export function shouldCheckNow(lastCheckAt: number | null, now: number): boolean {
  return lastCheckAt === null || now - lastCheckAt >= MIN_CHECK_GAP_MS;
}

/** 更新懸而未決（有新版等著、或已接管但這個分頁還沒重整）超過門檻 → 該提示使用者了。 */
export function shouldPromptFallback(pendingSince: number | null, now: number): boolean {
  return pendingSince !== null && now - pendingSince >= FALLBACK_PROMPT_AFTER_MS;
}

/**
 * 動態載入（lazy chunk）失敗時可以自動重整嗎？——長時間開著的舊頁面在部署後去要已被換掉的舊檔會失敗，
 * 重整即可拿到新版。防迴圈：上次自動重整在窗內就不再重整（例如網路真的斷了，重整也載不到）。
 */
export function chunkReloadAllowed(lastReloadAt: number | null, now: number): boolean {
  return lastReloadAt === null || now - lastReloadAt >= CHUNK_RELOAD_GUARD_MS;
}

// ---- 主畫面 PWA：回到 App 時更新（2026-09-23 Hon 定案甲案） ----
// iOS 一把 PWA 切到背景，幾秒內就凍結它 →「切走時套用、重整」常常做到一半就被凍住，要切好幾次才換上。
// PWA 改在「回到 App」那一刻更新：離開夠久（不是切去複製驗證碼那種來回）＋有網路＋沒在忙 → 直接重整成新版，
// 網址保留、停在原本那封信；代價是回來時畫面閃一下（Hon 已知悉並選定）。瀏覽器分頁維持「切走時更新」。

/** 離開多久以上再回來，才算「回到 App」而不是短暫切出去。 */
export const RESUME_UPDATE_AWAY_MS = 5 * 60 * 1000;
/**
 * 回來之後的寬限時間：新版常常是回來那一刻才查到、下載要一兩秒 → 這段時間內下載好、而且使用者還沒碰畫面，
 * 仍算「回到 App 時」直接套用。超過或已經開始操作 → 不打斷，留到下次回來。
 */
export const RESUME_GRACE_MS = 6_000;

/** 這次回到前景，要不要開啟「回到 App 時更新」的寬限時間。 */
export function resumeUpdateAllowed(s: { standalone: boolean; awayMs: number; online: boolean; busy: boolean }): boolean {
  return s.standalone && s.awayMs >= RESUME_UPDATE_AWAY_MS && s.online && !s.busy;
}

/** 寬限時間內的此刻，可以直接套用新版並重整嗎（使用者還沒碰畫面、沒在忙、有網路）。 */
export function resumeApplyAllowed(s: { sinceResumeMs: number; interacted: boolean; online: boolean; busy: boolean }): boolean {
  return s.sinceResumeMs >= 0 && s.sinceResumeMs <= RESUME_GRACE_MS && !s.interacted && s.online && !s.busy;
}
