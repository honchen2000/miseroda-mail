// List-Unsubscribe 解析（RFC 2369 + RFC 8058 one-click）——純函式便於測試。
// 安全：httpUrl 僅接受 https（不收 http，避免明文 + 降低被當追蹤的風險）。

export interface Unsubscribe {
  /** https 退訂連結（僅 https） */
  httpUrl: string | null;
  /** mailto: 退訂位址 */
  mailto: string | null;
  /** RFC 8058 一鍵退訂（List-Unsubscribe-Post: List-Unsubscribe=One-Click） */
  oneClick: boolean;
}

/**
 * 解析 List-Unsubscribe 標頭值（形如 `<https://...>, <mailto:...>`）+ List-Unsubscribe-Post。
 * 無可用退訂方式 → null。
 */
/**
 * 解析前的長度上限（F19.3／2026-09-20 安全掃描 F10）。
 * 這個標頭完全由寄件者控制，而這段跑在**未認證的 email() handler** 裡、在 INGEST_QUEUE.send
 * 與 FORWARD_TO 轉寄之前——吃掉 CPU 配額會讓整封信根本存不下來。
 * RFC 2369 的合法值遠小於此，截斷只影響畸形／惡意標頭。
 */
const MAX_HEADER_CHARS = 2048;

export function parseListUnsubscribe(header: string | null | undefined, postHeader: string | null | undefined): Unsubscribe | null {
  if (!header) return null;
  const h = header.slice(0, MAX_HEADER_CHARS);
  let httpUrl: string | null = null;
  let mailto: string | null = null;
  // 線性掃描，刻意不用 /<([^>]+)>/g：貪婪的 [^>]+ 在「有 < 卻沒有對應的 >」時會吃光剩餘輸入
  // 再整個回溯，N 個 < 就是 O(N²)。同一種毛病 ingest.ts 的 stripTagsForSnippet 與
  // sanitize.ts 的 stripCssComments 都已經改寫過，這裡是漏網的最後一處。
  let i = 0;
  while (i < h.length) {
    const lt = h.indexOf('<', i);
    if (lt < 0) break;
    const gt = h.indexOf('>', lt + 1);
    if (gt < 0) break; // 沒有對應的 '>' → 後面不可能再有完整的一組，直接收工（正是回溯的來源）
    const u = h.slice(lt + 1, gt).trim();
    if (!httpUrl && /^https:\/\//i.test(u)) httpUrl = u;
    else if (!mailto && /^mailto:/i.test(u)) mailto = u;
    if (httpUrl && mailto) break;
    i = gt + 1;
  }
  if (!httpUrl && !mailto) return null;
  const oneClick = !!httpUrl && !!postHeader && /one-click/i.test(postHeader);
  return { httpUrl, mailto, oneClick };
}

/** httpUrl 是否可安全地由伺服器端送出 one-click POST（https + 公開主機，擋 localhost/內網/裸 IP）。 */
export function isPublicHttpsUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  // FQDN 尾點要先削掉：`localhost.` / `x.internal.` 解析結果同無尾點版本，卻能繞過下面的字串比對。
  const host = u.hostname.toLowerCase().replace(/\.+$/, '');
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    // 裸 IP：擋私有/迴環/link-local 段
    const [a, b] = host.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254)) {
      return false;
    }
  }
  return host.includes('.');
}

const MAX_REDIRECTS = 3;

/**
 * 伺服器端代送 RFC 8058 一鍵退訂 POST；回傳上游是否成功（2xx）。
 *
 * SSRF 防護同 jobs/icsSync.ts：`redirect:'manual'` 手動跟隨，**每一跳都重驗 isPublicHttpsUrl**——
 * List-Unsubscribe 來自來信標頭（攻擊者可控），公開 URL 只要 302 導到 localhost/內網，
 * `redirect:'follow'` 會直接連進去而不重驗。被擋 / 超過跳數 / 缺 Location 一律 throw。
 *
 * 跟隨語意比照 fetch 預設，正常電子報不受影響：301/302/303 → 轉 GET（不帶 body）；307/308 → 維持 POST + body。
 */
export async function postOneClickUnsubscribe(url: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  let current = url;
  let asPost = true;
  for (let hop = 0; ; hop++) {
    if (!isPublicHttpsUrl(current)) throw new Error('blocked url');
    const res = await fetchImpl(
      current,
      asPost
        ? {
            method: 'POST',
            redirect: 'manual',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'List-Unsubscribe=One-Click',
          }
        : { method: 'GET', redirect: 'manual' },
    );
    if (res.status >= 300 && res.status < 400) {
      void res.body?.cancel();
      if (hop >= MAX_REDIRECTS) throw new Error('too many redirects');
      const loc = res.headers.get('location');
      if (!loc) throw new Error('redirect without location');
      current = new URL(loc, current).toString(); // 相對 Location → 絕對；下一圈開頭重驗
      if (res.status !== 307 && res.status !== 308) asPost = false;
      continue;
    }
    void res.body?.cancel();
    return res.ok;
  }
}
