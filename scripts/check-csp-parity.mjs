// 安全標頭一致性守門：public/_headers（靜態資產走邊緣直送）必須與 src/worker/index.ts 的
// CSP 常數 + withSecurityHeaders 等價。兩處都要維護 → 用這支在 verify.sh 擋住漂移。
// 背景：run_worker_first 已縮到只涵蓋 worker 路由（為了讓 Smart Placement 生效），
// 靜態/SPA 不再經過 worker，因此標頭必須由 _headers 補上；一旦漂移＝正式站少了防護。
import { readFileSync } from 'node:fs';

const fail = (msg) => {
  console.error(`CSP/安全標頭漂移：${msg}`);
  process.exit(1);
};

const worker = readFileSync('src/worker/index.ts', 'utf8');
const headers = readFileSync('public/_headers', 'utf8');

// worker 的 CSP 常數（先去掉註解行，避免註解裡的引號干擾）
const arr = /const CSP = \[(.*?)\]\.join/s.exec(worker);
if (!arr) fail('在 src/worker/index.ts 找不到 CSP 常數');
// 注意：陣列元素是 "default-src 'self'" 這種「雙引號字串內含單引號」，
// 所以必須用「各自配對」的交替式，不能用 ['"] 字元類（會把內層單引號當結尾切爛）。
// 只去掉「整行」註解：不能用 /\/\/.*/ ——那會把 https:// 裡的雙斜線也吃掉，URL 被切爛。
const cspWorker = [...arr[1].replace(/^[ \t]*\/\/.*$/gm, '').matchAll(/'([^']*)'|"([^"]*)"/g)]
  .map((m) => m[1] ?? m[2])
  .filter(Boolean)
  .join('; ');

const headerVal = (name) => {
  const m = new RegExp(`^\\s*${name}:\\s*(.+)$`, 'mi').exec(headers);
  return m ? m[1].trim() : null;
};

const cspHeaders = headerVal('Content-Security-Policy');
if (cspWorker !== cspHeaders) {
  fail(`CSP 不一致\n  worker  : ${cspWorker}\n  _headers: ${cspHeaders}`);
}

// withSecurityHeaders 逐項套用的其餘標頭也必須在 _headers 出現
for (const [name, expected] of [
  ['Strict-Transport-Security', 'max-age=31536000'],
  ['X-Content-Type-Options', 'nosniff'],
  ['Referrer-Policy', 'no-referrer'],
  ['Permissions-Policy', 'camera=(), microphone=(), geolocation=()'],
]) {
  if (!worker.includes(expected)) fail(`worker 已不再設定 ${name}: ${expected}（請同步 _headers）`);
  if (headerVal(name) !== expected) fail(`_headers 缺少或不符 ${name}（應為 ${expected}）`);
}

console.log('CSP/安全標頭一致 ✓');
