// mbox 匯出的兩個小工具（純函式，便於測試）。
// 與匯入端的 splitMbox（jobs/importConsumer.ts）成對：那邊做 mboxrd 反跳脫（>From → From），
// 這邊做跳脫。兩邊要一起看，改動任一側都要確認往返仍成立。

const GT = 0x3e; // '>'
const LF = 0x0a; // '\n'
const FROM = [0x46, 0x72, 0x6f, 0x6d, 0x20]; // 'From '

/**
 * mboxrd 跳脫（F19.4／2026-09-20 安全掃描 F11）：行首的 `From ` / `>From ` / `>>From `… 前面再加一個 `>`。
 *
 * 不做的話，入站信的原始位元組（完全由寄件者控制）裡一行 `From boss@x Mon Jan  1 …` 在匯出檔中
 * 就是一個訊息分隔符 → 攻擊者只要寄一封信，就能在受害者的備份裡憑空多出一封「來自任何人」的信，
 * 再匯入後與真信無從分辨。不涉及機密性外洩，是**封存完整性**問題。
 *
 * ★ 刻意走 byte 層、不解碼：信件原始位元組可能是任何 8-bit 編碼（Big5、Latin-1…），
 *   解成 UTF-8 字串再編回去會把非 UTF-8 的位元組換成 U+FFFD，等於毀掉原文。
 */
export function mboxrdQuote(raw: Uint8Array): Uint8Array {
  const marks: number[] = []; // 需要插入 '>' 的位移（行首）
  for (let i = 0; i < raw.length; i++) {
    if (i !== 0 && raw[i - 1] !== LF) continue; // 只看行首
    let j = i;
    while (j < raw.length && raw[j] === GT) j++; // 跳過既有的 '>'（>From、>>From…）
    if (j + FROM.length > raw.length) continue;
    let hit = true;
    for (let k = 0; k < FROM.length; k++) {
      if (raw[j + k] !== FROM[k]) { hit = false; break; }
    }
    if (hit) marks.push(i);
  }
  if (!marks.length) return raw;
  const out = new Uint8Array(raw.length + marks.length);
  let src = 0;
  let dst = 0;
  for (const m of marks) {
    out.set(raw.subarray(src, m), dst);
    dst += m - src;
    out[dst++] = GT;
    src = m;
  }
  out.set(raw.subarray(src), dst);
  return out;
}

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * mbox 的信封 From_ 行，asctime 格式：`From addr Mon Jan  1 09:00:00 2026`。
 *
 * 原本用 `toUTCString()`，產生的是 `From addr Mon, 01 Jan 2026 09:00:00 GMT`——星期幾後面是逗號，
 * 而匯入端 splitMbox 的 regex 要求星期幾後接**空格**（`From \S+ (?:Mon|Tue|…) `）→ 匯出檔
 * 連本專案自己的匯入器都切不開。改用標準 asctime 後往返才成立。
 * 位址去掉空白：splitMbox 以 `\S+` 匹配位址，含空白會讓該行不被視為分隔符。
 */
export function mboxFromLine(addr: string, ms: number): string {
  const d = new Date(ms);
  const p2 = (n: number) => String(n).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, ' ');
  const who = addr.replace(/\s+/g, '') || 'MAILER-DAEMON';
  return `From ${who} ${WD[d.getUTCDay()]} ${MO[d.getUTCMonth()]} ${day} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} ${d.getUTCFullYear()}\n`;
}
