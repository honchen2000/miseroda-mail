// F14.1：外部行事曆訂閱（反向）——每 6h fetch 使用者訂閱的 ICS URL，解析成唯讀虛擬事件快取到 KV。
// 照 F11.3 生日虛擬事件先例：不寫 calendar_events 主表，/calendar/events 讀取時併入（source:'external'）。
// 安全：SSRF 走 isPublicHttpsUrl；逾時 8s；大小上限 2MB；壞 feed 靜默跳過並記狀態，絕不擋主流程。

import { parseIcsEvents } from '../email/calendar';
import { isPublicHttpsUrl } from '../email/list-unsubscribe';

export const ICS_SYNC_CRON = '0 */6 * * *'; // 每 6 小時

const MAX_SUBS = 5;
const FETCH_TIMEOUT_MS = 8000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const CACHE_TTL = 7 * 3600; // 略大於 6h：cron 延遲時舊快取不先過期

/** KV 快取形狀：某使用者所有訂閱展開後的事件 + 各 feed 狀態。 */
export interface IcsCache {
  syncedAt: number;
  events: {
    uid: string; summary: string; startMs: number | null; endMs: number | null;
    startText: string; allDay: boolean; location: string; feed: string; rrule: string | null;
  }[];
  feeds: { url: string; label: string; status: 'ok' | 'error'; count: number; error?: string }[];
}

export function icsCacheKey(userId: string): string {
  return `ics:${userId}`;
}

interface Subscription {
  url: string;
  label: string;
}

/** 讀某使用者 prefs.icsSubscriptions（容錯：非陣列/超量/壞項一律過濾）。 */
function readSubs(prefsRaw: string | null): Subscription[] {
  try {
    const prefs = JSON.parse(prefsRaw ?? '{}') as { icsSubscriptions?: unknown };
    if (!Array.isArray(prefs.icsSubscriptions)) return [];
    return prefs.icsSubscriptions
      .filter((s): s is Subscription => !!s && typeof (s as Subscription).url === 'string' && isPublicHttpsUrl((s as Subscription).url))
      .slice(0, MAX_SUBS)
      .map((s) => ({ url: s.url, label: typeof s.label === 'string' ? s.label.slice(0, 60) : '' }));
  } catch {
    return [];
  }
}

async function fetchIcs(url: string, fetchImpl: typeof fetch): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    // SSRF 防護：redirect:'manual' 手動跟隨，**每一跳都重驗 isPublicHttpsUrl**——
    // 攻擊者用公開 URL 302 導到 169.254/10.x/localhost，redirect:'follow' 會直接連進去而不重驗。
    let current = url;
    for (let hop = 0; ; hop++) {
      if (!isPublicHttpsUrl(current)) throw new Error('blocked url');
      const res = await fetchImpl(current, { signal: ctrl.signal, redirect: 'manual', headers: { accept: 'text/calendar' } });
      if (res.status >= 300 && res.status < 400) {
        void res.body?.cancel();
        if (hop >= MAX_REDIRECTS) throw new Error('too many redirects');
        const loc = res.headers.get('location');
        if (!loc) throw new Error('redirect without location');
        current = new URL(loc, current).toString(); // 相對 Location → 絕對；下一圈開頭重驗
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // 大小上限：串流讀取，超過即中止（不下載整個惡意大檔）
      const reader = res.body?.getReader();
      if (!reader) return '';
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          total += value.length;
          if (total > MAX_BYTES) { void reader.cancel(); throw new Error('feed too large'); }
          chunks.push(value);
        }
      }
      return new TextDecoder().decode(await new Blob(chunks).arrayBuffer());
    }
  } finally {
    clearTimeout(timer);
  }
}

/** 同步單一使用者的所有訂閱 → 寫 KV 快取。回傳成功 feed 數。 */
async function syncUser(env: Env, userId: string, subs: Subscription[], fetchImpl: typeof fetch): Promise<number> {
  // 同一使用者的 feeds 並發抓（各自 8s timeout；削減 cron 壁鐘時間、防慢 feed 拖垮同批其他 feed）
  const results = await Promise.all(
    subs.map(async (sub) => {
      try {
        const ics = await fetchIcs(sub.url, fetchImpl);
        const parsed = parseIcsEvents(ics);
        const evs: IcsCache['events'] = parsed.map((e, i) => ({
          uid: e.uid ?? `${sub.url}#${i}`,
          summary: e.summary ?? '(無標題)',
          startMs: e.startMs,
          endMs: e.endMs,
          startText: e.startText ?? '',
          allDay: e.allDay,
          location: e.location ?? '',
          feed: sub.label || sub.url,
          rrule: e.rrule,
        }));
        return { evs, feed: { url: sub.url, label: sub.label, status: 'ok' as const, count: parsed.length } };
      } catch (err) {
        return { evs: [] as IcsCache['events'], feed: { url: sub.url, label: sub.label, status: 'error' as const, count: 0, error: String(err instanceof Error ? err.message : err).slice(0, 120) } };
      }
    }),
  );
  const events = results.flatMap((r) => r.evs);
  const feeds = results.map((r) => r.feed);
  const ok = feeds.filter((f) => f.status === 'ok').length;
  const cache: IcsCache = { syncedAt: Date.now(), events, feeds };
  await env.KV.put(icsCacheKey(userId), JSON.stringify(cache), { expirationTtl: CACHE_TTL });
  return ok;
}

/** cron 入口：掃所有有訂閱設定的使用者，逐一同步。 */
export async function runIcsSync(env: Env, fetchImpl: typeof fetch = fetch): Promise<{ users: number; feeds: number }> {
  // 只撈 prefs 提到 icsSubscriptions 的使用者（LIKE 粗篩，readSubs 再精驗）
  const rows = await env.DB.prepare(
    `SELECT user_id, prefs FROM user_settings WHERE prefs LIKE '%icsSubscriptions%' LIMIT 500`,
  ).all<{ user_id: string; prefs: string }>();
  let users = 0;
  let feeds = 0;
  for (const r of rows.results) {
    const subs = readSubs(r.prefs);
    if (!subs.length) continue;
    feeds += await syncUser(env, r.user_id, subs, fetchImpl);
    users += 1;
  }
  return { users, feeds };
}

export { readSubs, MAX_SUBS };
