// Demo 專用雙語文案：偵測瀏覽器語言，中文語系顯示繁中，其餘一律 fallback 英文（北美用語）。
// 只用於 demo 落地頁/橫幅/寫信封鎖提示；app 其餘部分維持全繁中（設計定案）。

/** zh-* → 'zh'；其餘（含非 en 語系如 ja/fr）→ 'en' fallback。可注入 nav 以利測試。 */
export function demoLang(nav: string | undefined = typeof navigator !== 'undefined' ? navigator.language : undefined): 'zh' | 'en' {
  return /^zh(-|$)/i.test(nav ?? '') ? 'zh' : 'en'; // zh / zh-TW / zh-Hant / zh-CN … → zh；其餘 fallback en
}

/** 依偵測語言二選一。 */
export function dt(zh: string, en: string, nav?: string): string {
  return demoLang(nav) === 'zh' ? zh : en;
}
