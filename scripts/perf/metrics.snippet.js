// 開機瀑布量測（貼到 mail.miseroda.com 的 DevTools console，或由自動化在頁面載入後執行）。
// 回傳各關鍵資源的 [開始, 結束, 傳輸位元組]（毫秒，自導覽起算）。
//   T_auth ＝ me[1]：/auth/me 回來的時間 ＝ App 決定顯示「登入頁」或「信箱」的時刻，本迴圈的主指標。
//   傳輸位元組：0＝本機快取命中；約 300＝304 重新驗證（仍付一趟往返）；其餘＝實際下載。
// 冷啟動量法：先執行 unregister SW + 清 caches，再重新導覽；熱啟動：SW 控制下直接重新導覽。
await new Promise(r => setTimeout(r, 3000));
const nav = performance.getEntriesByType('navigation')[0];
const res = performance.getEntriesByType('resource');
const pick = (re) => { const e = res.find(x => re.test(x.name)); return e ? [Math.round(e.startTime), Math.round(e.responseEnd), e.transferSize] : null; };
const h = await fetch('/api/v1/health', { cache: 'no-store' });
JSON.stringify({
  sw: !!navigator.serviceWorker?.controller,
  colo: (h.headers.get('cf-ray') || '').split('-').pop(), plc: h.headers.get('cf-placement') || '',
  ttfb: Math.round(nav.responseStart), dcl: Math.round(nav.domContentLoadedEventEnd),
  js: pick(/\/assets\/index-.*\.js/), css: pick(/\/assets\/index-.*\.css/), gcss: pick(/fonts\.googleapis\.com/),
  cfg: pick(/\/api\/v1\/auth\/config/), me: pick(/\/api\/v1\/auth\/me/),
});
