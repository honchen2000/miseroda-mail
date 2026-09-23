// F9.5 守門暗號的產生器（純模組、無 DOM 依賴 → worker vitest 可直接 import）。
// 舊版是「10 字詞表 ×2 ＋ 兩位數」＝ 10×10×100 = 10,000 種（~13 bit），而詞表隨前端 bundle 公開：
// 陌生寄件者可把數十組候選塞進同一封主旨（守門是主旨子字串比對）暴力猜中，直接繞過待審守門。
// 新版沿用專案既有「人類可讀高熵碼」格式（邀請碼 randomCode(3,4)／備援碼同一套字母表）：
// 3 組 × 4 字元、字母表 31 字（去掉易混淆的 0/O/1/I/L）→ 12 × log2(31) ≈ 59.5 bit。
// 長度 14 字，落在 API 的 4–32 字驗證內；守門比對本來就不分大小寫，故產生小寫（主旨裡好讀）。
// 只影響「產生暗號／換一組」新產的碼；已設定並告訴對方的舊暗號完全不受影響。

// 與 src/worker/lib/crypto.ts 的 CODE_ALPHABET 同一組字元（此處小寫）——刻意不跨 app/worker import。
const CODE_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';
const GROUPS = 3;
const GROUP_LEN = 4;

/** 產生守門暗號，形如 `k7mq-2hd8-9ra4`（≈59 bit 熵）。 */
export function generateSpeakeasy(): string {
  const total = GROUPS * GROUP_LEN;
  // 拒絕取樣：只採用 < 248（=31×8）的位元組，避免 % 31 的模偏差吃掉熵。
  const limit = Math.floor(256 / CODE_ALPHABET.length) * CODE_ALPHABET.length;
  const chars: string[] = [];
  while (chars.length < total) {
    const buf = new Uint8Array(total);
    crypto.getRandomValues(buf);
    for (const b of buf) {
      if (b >= limit) continue;
      chars.push(CODE_ALPHABET[b % CODE_ALPHABET.length]);
      if (chars.length === total) break;
    }
  }
  const parts: string[] = [];
  for (let g = 0; g < GROUPS; g++) parts.push(chars.slice(g * GROUP_LEN, (g + 1) * GROUP_LEN).join(''));
  return parts.join('-');
}
