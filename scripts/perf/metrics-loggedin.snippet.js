// 登入後開機瀑布（本機登入態環境或正式站皆可貼）。重點看 gap：/auth/me 回來 → 第一支信箱資料請求出發的空窗。
await new Promise(r => setTimeout(r, 3500));
const res = performance.getEntriesByType('resource').filter(e => e.name.includes('/api/'));
const me = res.find(e => e.name.includes('/auth/me'));
const data = res.filter(e => !e.name.includes('/auth/'));
const first = Math.min(...data.map(e => e.startTime));
JSON.stringify({
  me: me && [Math.round(me.startTime), Math.round(me.responseEnd)],
  firstData: Math.round(first), gap: me ? Math.round(first - me.responseEnd) : null,
  api: res.map(e => [e.name.replace(location.origin + '/api/v1', '').slice(0, 50), Math.round(e.startTime), Math.round(e.responseEnd)]),
});
