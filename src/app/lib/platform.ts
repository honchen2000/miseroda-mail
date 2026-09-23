// 平台 / PWA 安裝狀態偵測。
// 純函式（不碰 navigator/window，由呼叫端注入字串）→ 可在 worker vitest 單測，
// 且不會把 DOM 型別拖進 worker tsconfig（CLAUDE.md：被 worker 測試 import 的邏輯要抽純模組）。
//
// 背景：iOS Safari 16.4+ 的 Web Push 只有在「加入主畫面」成 standalone 後才能用；
// 在 Safari 分頁裡呼叫 Notification.requestPermission()/pushManager.subscribe() 會直接失敗，
// 使用者只看到「推播設定失敗」卻不知真正原因 —— 這是 iPhone 收不到通知的頭號根因。
// 故需在 UI 先偵測平台/安裝狀態，未安裝就改顯示「先加入主畫面」引導。

export interface PwaState {
  /** 是否 iOS / iPadOS（PWA 安裝與推播規則特殊）。 */
  ios: boolean;
  /** 是否已以 standalone（已加入主畫面 / 已安裝 PWA）開啟。 */
  standalone: boolean;
  /** iOS 上是否為 Safari 本體（唯一能「加入主畫面」與收 Web Push 的瀏覽器）。 */
  iosSafari: boolean;
}

/** UA/平台/觸控點 → 是否 iOS。含 iPadOS 13+ 偽裝成 Macintosh 的觸控裝置。 */
export function detectIOS(ua: string, platform: string, maxTouchPoints: number): boolean {
  if (/iPhone|iPad|iPod/.test(ua)) return true;
  // iPadOS 13+ 預設請求桌面版網站 → UA 變 Macintosh；用「Mac 但有觸控」補判。
  return platform === 'MacIntel' && maxTouchPoints > 1;
}

/**
 * 是否為 iOS 的 Safari 本體（唯一能「加入主畫面」並收 Web Push 的瀏覽器）。
 * 自帶 iOS 守門 → 非 iOS（桌機 Safari / Android Chrome，其 UA 也含 "Safari" 字串）一律 false，
 * 可安全單獨呼叫、不會誤判。iOS 上 Chrome(CriOS)/Firefox(FxiOS)/Edge(EdgiOS)/Google App(GSA)
 * 及各 App 內嵌 WebView 都是 WebKit 但拿不到 A2HS/推播 → 排除，引導改用 Safari。
 */
export function isIOSSafari(ua: string, platform: string, maxTouchPoints: number): boolean {
  if (!detectIOS(ua, platform, maxTouchPoints)) return false;
  return /Safari/.test(ua) && !/(CriOS|FxiOS|EdgiOS|GSA|Instagram|FBAN|FBAV|Line\/|Twitter)/.test(ua);
}

/**
 * 此平台「現在」能否實際訂閱 Web Push（與瀏覽器是否支援 PushManager API 無關）。
 * iOS 未加入主畫面 → 不能（subscribe 會失敗）。其餘平台 → 能。
 */
export function canSubscribePush(s: PwaState): boolean {
  return !(s.ios && !s.standalone);
}

/** iOS 未安裝時，要不要顯示「先加入主畫面」引導（取代推播開關）。 */
export function shouldShowIOSInstallGuide(s: PwaState): boolean {
  return s.ios && !s.standalone;
}

// 讀 runtime globals 的版本在 ./platform.dom.ts（碰 navigator/window，不能被 worker 測試 import）。
