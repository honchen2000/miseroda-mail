// 寄件者頭像的來源清單（純邏輯，無 DOM、無 React）。
// 抽成獨立模組的理由：worker tsconfig 沒有 DOM lib，測試不能 import mail.tsx；
// 拆檔法沿用既有先例（platform.dom.ts / composerWins.ts）。
//
// ★ 鐵則：這裡回傳的每一個來源都必須是**本站同源路徑**，測試會釘住這件事。
//   2026-09-20 安全掃描 F2：原本這裡會推一個 `https://unavatar.io/<明文 email>` 進去，
//   於是每開一封信，瀏覽器就把該通信對象的**明文地址**與開信時間送給第三方
//   （unavatar.io 及其背後代理的 Google/Gravatar/GitHub…）。對一個以「私有家用信箱」
//   為前提、內文遠端圖片一律封鎖、Referrer-Policy 設 no-referrer 的系統而言，
//   這條是把其餘所有隱私努力一次繞過的洩漏管道，且沒有任何開關可關。
//   外部寄件者現在一律退回字首圓圈——那是 AvatarImg 來源用盡時的既有行為，不需額外處理。

/** 站內網域：只有這個網域的地址會去查內部上傳頭像。 */
const INTERNAL_DOMAIN = '@miseroda.com';

export function senderAvatarSources(addr: string): string[] {
  const email = addr.trim().toLowerCase();
  if (email.endsWith(INTERNAL_DOMAIN)) {
    return [`/api/v1/avatars/by-email?email=${encodeURIComponent(email)}`];
  }
  return []; // 外部寄件者：不對外發任何請求，交給 AvatarImg 退回字首圓圈
}
