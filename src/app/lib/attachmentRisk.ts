// F13.3：危險附件副檔名判定（純函式、無 DOM——worker 測試可直接 import）。
// 誠實邊界：只看副檔名，不掃內容、不宣稱掃毒。警示不阻擋（家用系統，決定權在人）。
// 名單取向：可執行/腳本/巨集文件/HTML（釣魚頁）/壓縮與映像檔（惡意軟體最常見載體）。

const RISKY_EXTS = new Set([
  // 可執行/安裝
  'exe', 'msi', 'bat', 'cmd', 'com', 'scr', 'pif', 'app', 'dmg', 'apk', 'jar', 'dll', 'lnk', 'reg',
  // 腳本
  'js', 'jse', 'vbs', 'vbe', 'wsf', 'wsh', 'ps1', 'hta',
  // 網頁（釣魚頁常見夾帶）
  'html', 'htm', 'shtml', 'svg',
  // 巨集文件
  'docm', 'xlsm', 'pptm', 'dotm',
  // 壓縮/映像（無法看穿內容）
  'zip', 'rar', '7z', 'iso', 'img', 'gz', 'tgz', 'bz2', 'xz',
]);

/** 回傳命中的副檔名（小寫、不含點），安全則 null。雙重副檔名（invoice.pdf.exe）取最後一段。 */
export function attachmentRiskExt(filename: string): string | null {
  const m = /\.([a-z0-9]{1,6})$/i.exec(filename.trim());
  if (!m) return null;
  const ext = m[1].toLowerCase();
  return RISKY_EXTS.has(ext) ? ext : null;
}

/** 整封附件清單的警示文案；無風險回 null。 */
export function attachmentWarning(filenames: string[]): string | null {
  const hits = [...new Set(filenames.map(attachmentRiskExt).filter((e): e is string => !!e))];
  if (!hits.length) return null;
  return `附件含 ${hits.map((e) => `.${e}`).join('、')} 檔——此類檔案可能夾帶惡意內容，開啟前請確認寄件者可信（系統不掃毒）。`;
}
