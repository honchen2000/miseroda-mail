// Service Worker 註冊 + 背景自動更新（2026-09-22 Hon 定案甲案；判斷邏輯在純模組 autoUpdate.ts）。
//
// 原本：網頁開著時瀏覽器不會主動檢查新版 → 使用者要先重整一次，新 SW 才進 waiting 並跳「立即更新」，
// 按下去再重整一次（Hon：「每次重整一次才會跳出更新給我點再重整一次」）。
// 現在：
//   ① 主動檢查：切回分頁／取得焦點／恢復連線／每 30 分鐘（節流 1 分鐘）；定時器也會在背景重試安全時機。
//   ② 自動套用：有新版等著 → 等「安全時機」（分頁沒被看著＋有網路＋沒在忙）自動請它接管。
//      「沒在忙」＝沒開撰寫器（含縮成晶片）、沒有對話框、沒有「復原」倒數——見 isBusy()。
//   ③ 每個分頁各自決定何時重整：新 SW 接管時所有分頁都會收到 controllerchange；
//      只有使用者親手按「立即更新」的那個分頁立刻重整，其餘分頁等自己的安全時機，
//      絕不把另一個正在寫信的分頁一起重整掉。
//   ④ 一直等不到安全時機超過 60 分鐘 → 退回原本的「立即更新」提示（onUpdatePromptDue）。
//   ⑤ 安全網：長時間開著的舊頁面在部署後去載入已被換掉的 lazy chunk 會失敗——沒有錯誤邊界時
//      React 會整頁白屏。攔下 Vite 的 `vite:preloadError`，重整一次換上新版（防迴圈：2 分鐘內不重複）。
//   ⑥ 主畫面 PWA 改在「回到 App」時更新（2026-09-23 Hon 定案甲案）：iOS 一切到背景幾秒內就凍結 PWA，
//      ②「切走時套用」常做到一半就被凍住。離開 ≥5 分鐘再回來、沒在忙 → 已有新版就直接換；回來那一刻才查到的，
//      6 秒內下載好且還沒碰畫面也直接換。瀏覽器分頁不受影響。判斷在 autoUpdate.ts resumeUpdateAllowed／resumeApplyAllowed。
// 依然刻意不在 install 自動 skipWaiting（見 public/sw.js）：接管與否仍由這裡在安全時機決定。
import {
  UPDATE_CHECK_INTERVAL_MS,
  chunkReloadAllowed,
  isSafeMoment,
  resumeApplyAllowed,
  resumeUpdateAllowed,
  shouldCheckNow,
  shouldPromptFallback,
  shouldReloadNow,
  type PageState,
} from './autoUpdate';
import { readPwaState } from './platform.dom';

let reg: ServiceWorkerRegistration | null = null;
let waitingWorker: ServiceWorker | null = null;
let promptListener: (() => void) | null = null;
/** 使用者在「這個分頁」親手按了「立即更新」。接管後立刻重整。
 *  ⑥ 刻意**不**借用這個旗標（審查 HIGH）：它永不重置，若回到 App 時送出的接管延後到很久以後才發生，
 *  會無視當下在寫信而強制重整；⑥ 改由 resumeApplyNow() 在接管當下即時重新判斷。 */
let userRequested = false;
/** 上次切到背景的時間（算「離開多久」）。 */
let hiddenAt: number | null = null;
/** PWA 回到 App 的寬限時間（⑥）：開始時間、使用者是否已經碰過畫面。 */
let resume: { at: number; interacted: boolean } | null = null;
/** ⑥ 偵測「碰過畫面」的監聽器；碰到一次或切走就整組移除（觸控裝置可能永遠不發 keydown／wheel，別讓它們累積）。 */
let resumeListeners: AbortController | null = null;
/** 新 SW 已接管，但這個分頁還在跑舊版、等安全時機重整。 */
let reloadPending = false;
/** 更新懸而未決的起點（偵測到 waiting 或已接管未重整）；給「等太久就提示」用。 */
let pendingSince: number | null = null;
let lastCheckAt: number | null = null;
let reloaded = false;
let prompted = false;

const CHUNK_RELOAD_KEY = 'miseroda_chunk_reload_at';

/**
 * 正在做會被重整打斷的事？一律看 DOM，不依賴哪個元件有沒有掛上（登入頁、信箱都適用）：
 *   `.composer`：撰寫器根元素——浮動視窗、信件內嵌回覆、縮成晶片的（縮小只是 CSS 藏起來，仍在 DOM）
 *   `[role=dialog]`／`[role=alertdialog]`：模態、選單、鈴鐺下拉
 *   `.undo-ring`：寄出後「復原」倒數（信已送到伺服器、倒數結束才寄；重整不會寄丟，但會失去復原鈕）
 * 查不到 document 或查詢出錯 → 當成忙，寧可不自動更新。
 */
function isBusy(): boolean {
  try {
    return !!document.querySelector('.composer, [role="dialog"], [role="alertdialog"], .undo-ring');
  } catch {
    return true;
  }
}

function pageState(): PageState {
  return {
    hidden: document.visibilityState === 'hidden',
    online: navigator.onLine !== false,
    busy: isBusy(),
  };
}

function doReload(): void {
  if (reloaded) return;
  reloaded = true;
  location.reload();
}

function markPending(): void {
  if (pendingSince === null) pendingSince = Date.now();
}

/** 目前等待中的新版：優先讀即時的 reg.waiting（連續兩次部署時舊的 waiting 會作廢被取代）。 */
function currentWaiting(): ServiceWorker | null {
  return reg?.waiting ?? waitingWorker;
}

/** 有新版等著 → 安全時機就請它接管（接管後 controllerchange 再決定這個分頁何時重整）。 */
function tryAutoApply(): void {
  const w = currentWaiting();
  if (w && isSafeMoment(pageState())) w.postMessage({ type: 'SKIP_WAITING' });
}

/** 已接管但這個分頁還是舊版 → 安全時機就重整。 */
function tryPendingReload(): void {
  if (reloadPending && isSafeMoment(pageState())) doReload();
}

/** ⑥ 此刻在「回到 App」寬限時間內、而且可以直接套用。 */
function resumeApplyNow(): boolean {
  if (!resume) return false;
  const s = pageState();
  return resumeApplyAllowed({ sinceResumeMs: Date.now() - resume.at, interacted: resume.interacted, online: s.online, busy: s.busy });
}

/**
 * ⑥ 回到 App 時更新：已接管 → 直接重整；有新版等著 → 請它接管。接管後 controllerchange 會用
 * resumeApplyNow() **當下**再判斷一次：還在寬限內、沒碰畫面、沒在忙才重整，晚到的就等下一個安全時機。
 */
function tryResumeApply(): void {
  if (!resumeApplyNow()) return;
  if (reloadPending) {
    doReload();
    return;
  }
  currentWaiting()?.postMessage({ type: 'SKIP_WAITING' });
}

function endResumeWindow(): void {
  resume = null;
  resumeListeners?.abort();
  resumeListeners = null;
}

/** ⑥ 開始寬限時間；使用者一碰畫面（點、按鍵、捲動）就不再打斷，留到下次回來。 */
function startResumeWindow(): void {
  endResumeWindow();
  const r = { at: Date.now(), interacted: false };
  const ac = new AbortController();
  resume = r;
  resumeListeners = ac;
  const mark = () => {
    r.interacted = true;
    ac.abort();
  };
  for (const t of ['pointerdown', 'touchstart', 'keydown', 'wheel'] as const) {
    window.addEventListener(t, mark, { capture: true, passive: true, signal: ac.signal });
  }
}

function checkForUpdate(): void {
  const now = Date.now();
  if (!reg || !shouldCheckNow(lastCheckAt, now)) return;
  lastCheckAt = now;
  void reg.update().catch(() => {});
}

function maybePrompt(): void {
  if (prompted || !promptListener) return;
  if (!currentWaiting() && !reloadPending) return;
  if (!shouldPromptFallback(pendingSince, Date.now())) return;
  prompted = true;
  promptListener();
}

/**
 * 訂閱「等太久，該提示使用者手動更新了」。只在一直等不到安全時機（60 分鐘）時觸發一次。
 * 回傳取消訂閱函式。
 */
export function onUpdatePromptDue(cb: () => void): () => void {
  promptListener = cb;
  maybePrompt();
  return () => {
    if (promptListener === cb) promptListener = null;
  };
}

/** 使用者按下「立即更新」：這個分頁立刻換新版（其他分頁仍各自等安全時機）。 */
export function applySwUpdate(): void {
  userRequested = true;
  const w = currentWaiting();
  if (w) w.postMessage({ type: 'SKIP_WAITING' });
  else if (reloadPending) doReload();
}

/** 註冊 SW（僅 https / localhost）並掛上自動更新。在 app 進入點呼叫一次。 */
export function registerSW(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  if (!(location.protocol === 'https:' || location.hostname === 'localhost')) return;

  // ⑤ 安全網：lazy chunk 載入失敗 → 重整一次換新版（不看忙不忙：不處理就是整頁白屏，撰寫器反正也保不住；
  // 草稿有自動儲存）。防迴圈窗內再失敗就放行原錯誤，不無限重整。
  window.addEventListener('vite:preloadError', (event) => {
    // 這一頁已經在重整了（同批多個 chunk 一起失敗）→ 後續的一律吞掉，別讓它們拋錯
    if (reloaded) {
      event.preventDefault();
      return;
    }
    const now = Date.now();
    let last: number | null = null;
    try {
      const raw = sessionStorage.getItem(CHUNK_RELOAD_KEY);
      last = raw ? Number(raw) : null;
    } catch {
      /* 無 sessionStorage → 當成沒重整過 */
    }
    if (!chunkReloadAllowed(last, now)) return;
    try {
      sessionStorage.setItem(CHUNK_RELOAD_KEY, String(now));
    } catch {
      /* ignore */
    }
    event.preventDefault();
    doReload();
  });

  // 載入時是否「已被 SW 控制」：用來區分首裝(null→SW，不 reload) 與 更新(舊→新，要換新版)。
  const wasControlled = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!wasControlled || reloaded) return;
    waitingWorker = null;
    // ⑥：iOS 常在凍結前才完成接管、回到 App 後才收到這個事件 → 寬限時間內一樣直接重整
    if (shouldReloadNow({ ...pageState(), userRequested }) || resumeApplyNow()) {
      doReload();
    } else {
      reloadPending = true; // ③ 別的分頁觸發、或這個分頁正忙／正被看著 → 等自己的安全時機
      markPending();
    }
  });

  const notify = (w: ServiceWorker) => {
    waitingWorker = w;
    markPending();
    tryAutoApply(); // 若偵測到時剛好在背景且沒在忙，直接套用
    tryResumeApply(); // ⑥ PWA 回到 App 那一刻才查到的新版：寬限時間內下載好 → 直接套用
  };

  // ① 主動檢查 ＋ ② 在安全時機套用
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now();
      endResumeWindow();
      // 切走＝最主要的安全時機（瀏覽器分頁；PWA 常被 iOS 凍結在半路，另見 ⑥）
      tryPendingReload();
      tryAutoApply();
      // 還不知道有沒有新版 → 順手查；查到並安裝完成時若仍在背景，notify 會直接套用
      if (!currentWaiting() && !reloadPending) checkForUpdate();
    } else {
      const awayMs = hiddenAt === null ? 0 : Date.now() - hiddenAt;
      hiddenAt = null;
      const s = pageState();
      if (resumeUpdateAllowed({ standalone: readPwaState().standalone, awayMs, online: s.online, busy: s.busy })) {
        startResumeWindow();
        tryResumeApply(); // 離開前就下載好（或已接管）的新版：回來這一刻直接換
      }
      checkForUpdate(); // 回來那一刻才查到的：下載好時 notify → tryResumeApply
      maybePrompt();
    }
  });
  window.addEventListener('focus', checkForUpdate);
  window.addEventListener('online', () => {
    checkForUpdate();
    tryPendingReload();
    tryAutoApply();
  });
  // 定時：背景分頁也重試安全時機（例如切走時還在「復原」倒數，倒數結束後沒有任何事件會再觸發）＋ 檢查新版
  setInterval(() => {
    if (document.visibilityState === 'hidden') {
      tryPendingReload();
      tryAutoApply();
    }
    checkForUpdate();
    maybePrompt();
  }, UPDATE_CHECK_INTERVAL_MS);

  window.addEventListener('load', () => {
    void navigator.serviceWorker
      .register('/sw.js')
      .then((r) => {
        reg = r;
        lastCheckAt = Date.now(); // register() 本身就會檢查一次
        // 前次造訪留下、仍在等待的新版（且目前頁面已被舊 SW 控制 → 確實是「更新」）
        if (r.waiting && navigator.serviceWorker.controller) notify(r.waiting);
        r.addEventListener('updatefound', () => {
          const installing = r.installing;
          if (!installing) return;
          installing.addEventListener('statechange', () => {
            // installed + 已有 controller = 這是更新而非首裝 → 進入 waiting
            if (installing.state === 'installed' && navigator.serviceWorker.controller) notify(installing);
          });
        });
      })
      .catch(() => {});
  });
}
