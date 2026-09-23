// 大附件下載連結（純函式，無 DOM → 可在 worker 環境單測）。
// 寄信時把連結附在內文末；html 版本對 filename/url 做 HTML 轉義（伺服器仍會再消毒，這是縱深防禦）。

export interface ShareLink {
  token: string;
  url: string;
  filename: string;
  sizeBytes: number;
  expiresAt: number;
}

function fmt(n: number): string {
  return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}
function esc(s: string): string {
  return s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch] as string);
}

/** 把大附件下載連結附在內文末。無連結時原樣回傳；html 為 null 時不動 html。 */
export function appendShareLinks(draft: { body: string; bodyHtml: string | null; linkFiles?: ShareLink[] }): {
  text: string;
  html: string | null;
} {
  const links = draft.linkFiles ?? [];
  if (!links.length) return { text: draft.body, html: draft.bodyHtml };
  const text = `${draft.body}\n\n📎 大檔案下載（7 天內有效）：\n${links
    .map((f) => `• ${f.filename}（${fmt(f.sizeBytes)}）：${f.url}`)
    .join('\n')}`;
  const html =
    draft.bodyHtml == null
      ? null
      : `${draft.bodyHtml}<hr><p>📎 大檔案下載（7 天內有效）：</p><ul>${links
          .map((f) => `<li><a href="${esc(f.url)}">${esc(f.filename)}</a>（${fmt(f.sizeBytes)}）</li>`)
          .join('')}</ul>`;
  return { text, html };
}
