// 登入枚舉誘餌（F16.4／2026-09-20 掃描 F6+F7）。
//
// 問題：`/auth/login/options` 對真帳號回真實 credential id、對未知帳號回空陣列
// → 空 vs 非空就是一個「這個信箱有沒有帳號」的預言機，還順帶洩漏該帳號有幾把 passkey
//（credential id 是每把驗證器穩定不變的識別碼，等於可連結的指紋）。
//
// ★ 這裡**刻意不查 credentials 表**。前一輪的修補為了讓誘餌「像真的」而去
//   `SELECT user_id, LENGTH(id) FROM credentials LIMIT 500` 取樣，結果未認證者換不同 email
//   反覆探測就能讀回站上真實的 passkey 數量與 id 長度分布，還能當帳號異動偵測器——
//   那是**新增**的洩漏（原本那條路徑一個 byte 都沒碰 credentials 表），整個 patch 因此被退。
//   形狀改由下面這份「一次性離線取樣後寫死」的 profile 決定。

/** 每人憑證數。2026-09-20 一次性取樣正式庫聚合結果：4 人共 6 把，1 把與 2 把各半。 */
const DECOY_COUNTS = [1, 1, 2, 2];
/** base64url credential id 的長度分布。同次取樣：22×2、27×3、43×1。 */
const DECOY_LENGTHS = [22, 27, 27, 27, 43];

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** counter mode 的 HMAC 位元組流：一次 HMAC 只有 32 bytes，長 id 需要接續多塊。 */
async function hmacStream(keyBytes: Uint8Array, msg: string, nBytes: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const out = new Uint8Array(nBytes);
  const enc = new TextEncoder();
  let off = 0;
  let ctr = 0;
  while (off < nBytes) {
    const block = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`${msg}|${ctr++}`)));
    const take = Math.min(block.length, nBytes - off);
    out.set(block.subarray(0, take), off);
    off += take;
  }
  return out;
}

/**
 * 為「沒有可用憑證的信箱」產生穩定的誘餌 credential id。
 * 同一個 email 永遠得到同一組（大小寫與前後空白不敏感），不同 email 得到不同組；
 * 金鑰是伺服器 secret，外部無法預先算出或驗證某一組是不是誘餌。
 */
export async function decoyCredentialIds(env: Env, email: string): Promise<string[]> {
  const norm = email.trim().toLowerCase();
  const keyBytes = new TextEncoder().encode(`${env.TOTP_ENC_KEY}:${env.RP_ID}`);
  // 先用一小段決定形狀（幾把、各多長），再依總長取足位元組產內容
  const head = await hmacStream(keyBytes, `webauthn-login-decoy-shape:${norm}`, 8);
  const count = DECOY_COUNTS[head[0] % DECOY_COUNTS.length];
  const lens = Array.from({ length: count }, (_, i) => DECOY_LENGTHS[head[1 + i] % DECOY_LENGTHS.length]);
  const body = await hmacStream(keyBytes, `webauthn-login-decoy-id:${norm}`, lens.reduce((a, b) => a + b, 0));

  const out: string[] = [];
  let off = 0;
  for (const len of lens) {
    let s = '';
    for (let i = 0; i < len; i++) s += B64URL[body[off + i] & 63];
    out.push(s);
    off += len;
  }
  return out;
}

/* ★ 誠實的殘留（不要再宣稱兩種回應「不可區分」）：
   1. 誘餌最多 2 把，所以**持有 3 把以上 passkey 的真帳號，回應形狀仍可被辨識出來**。
      要不要把真帳號的回傳也截到 2 把是另一個取捨——那會讓第 3 把之後的憑證無法用於登入，
      故未做。
   2. 時間側信道：真帳號多跑一次 credentials 查詢，未知帳號多跑兩次 HMAC，兩者耗時不同。
      這條沒有處理。
   3. 誘餌是決定性的：同一 email 每次都拿到同一組。這是刻意的（否則每次不同反而成為
      「這是誘餌」的指標），代價是攻擊者可以確認「這個 email 的回應從未改變」。 */
