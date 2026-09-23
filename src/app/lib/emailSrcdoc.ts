// 信件內文 iframe 的 srcdoc 組裝（從 components/mail.tsx 抽出的純字串邏輯 → 可被 worker vitest 單測，
// 也讓真瀏覽器重現頁能直接打包上線這一份，不必手抄）。
import { FIT_WRAPPER } from './emailFit';

export function buildSrcdoc(html: string, loadImages: boolean, showQuotes = true): string {
  const body = loadImages ? html.replace(/data-blocked-src=/g, 'src=') : html;
  // F13.1：引文預設摺疊（worker serve 時標了 data-quote）；展開由父層重建 srcdoc
  const quoteCss = showQuotes ? '' : '@media screen{[data-quote]{display:none}}'; // 只在螢幕摺疊；列印永遠全文
  // 郵件以「白底深字」為原生設計環境——跨深淺主題一律正確渲染（避免深色主題下黑字看不見），
  // 等同 Gmail/Outlook 把信件渲染在自身白色畫布上。連結用標準藍；圖片/表格寬度約束維持。
  // text-size-adjust：寬版信縮放後，iOS 不再自作主張把字放大（實測 600px 版型會被放大到 23px）。
  // <mr-fit>：寬版信縮放到閱讀區寬度的外層（見 lib/emailFit.ts：縮外層而不縮 body）。
  // 必須是 flow-root（自成排版區塊，把浮動元素包進來）：舊式信件常用 <table align="left">／<img align="right">，
  // 瀏覽器當成 float 處理——浮動元素不撐高父層、超出的寬度也不算在父層身上，而是記到整份文件的最外層。
  // 外層若只是 block，量到的內容高＝0 → iframe 卡在最小 40px、寬度也量不到而不縮放
  // （2026-09-23 Hon 的 NameSilo 信：<TABLE WIDTH="600" ALIGN="left">，iOS 實測 iframe 40 vs 內容 136）。
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="light"><style>
    html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
    ${FIT_WRAPPER}{display:flow-root}
    body{margin:0;padding:14px 16px;font:14px/1.7 -apple-system,'Helvetica Neue','Noto Sans TC',sans-serif;color:#1a1a1a;background:#ffffff;word-break:break-word;overflow-wrap:anywhere}
    a{color:#2563eb}
    img{max-width:100%;height:auto}
    img:not([src]){display:none}
    blockquote{border-left:3px solid #d0d7e2;margin:6px 0 6px 2px;padding-left:12px;color:#5b6b86}
    pre{white-space:pre-wrap}
    table{max-width:100%;border-collapse:collapse}
    ${quoteCss}
  </style></head><body><${FIT_WRAPPER}>${body}</${FIT_WRAPPER}></body></html>`;
}
