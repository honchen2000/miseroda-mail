// 寄件者信任卡：從 Authentication-Results 標頭萃取 SPF/DKIM/DMARC 結果。
// 純函式、無 DOM、無 IO → 可在 worker env 直接單元測試（見 test/worker/authVerdict.test.ts）。
// 輸入應為已轉小寫的合併字串（見 ingest.ts collectAuthResults）。

export interface AuthVerdict {
  spf: string | null;
  dkim: string | null;
  dmarc: string | null;
}

/** 整體信任等級：pass=已驗證、fail=驗證失敗（可疑）、partial=部分驗證。null=無資訊（不顯示徽章）。 */
export type TrustLevel = 'pass' | 'fail' | 'partial';

function firstResult(s: string, mech: 'spf' | 'dkim' | 'dmarc'): string | null {
  // 取第一個出現的結果：collectAuthResults 把 runtime 標頭（最可信的邊界 MTA）排在最前。
  const m = new RegExp(`\\b${mech}=([a-z]+)`).exec(s);
  return m ? m[1] : null;
}

/** 解析合併後的 Authentication-Results 字串；三項皆缺則回 null。 */
export function parseAuthVerdict(authResults: string): AuthVerdict | null {
  if (!authResults) return null;
  const spf = firstResult(authResults, 'spf');
  const dkim = firstResult(authResults, 'dkim');
  const dmarc = firstResult(authResults, 'dmarc');
  if (!spf && !dkim && !dmarc) return null;
  return { spf, dkim, dmarc };
}

/**
 * 衍生整體信任等級。前端 src/app/components/mail.tsx 內鏡像同一套規則
 * （app/worker tsconfig 分離，避免跨界 import；這段邏輯極短、兩邊各持一份）。
 * 與 ingest.ts looksSpam 的失敗判定一致：DMARC fail，或 SPF fail/softfail 且 DKIM fail。
 */
export function trustLevel(v: AuthVerdict | null): TrustLevel | null {
  if (!v) return null;
  // DMARC 是對齊後的權威結果，有明確 pass/fail 就採信（fail 即使 SPF/DKIM 各自 pass 也是對齊失敗＝偽冒訊號）。
  if (v.dmarc === 'pass') return 'pass';
  if (v.dmarc === 'fail') return 'fail';
  // 無明確 DMARC → 退看 SPF + DKIM。
  if (v.spf === 'pass' && v.dkim === 'pass') return 'pass';
  if ((v.spf === 'fail' || v.spf === 'softfail') && v.dkim === 'fail') return 'fail';
  return 'partial';
}
