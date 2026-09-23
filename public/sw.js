// Miseroda Mail service worker —— App Shell 快取（離線時 SPA 殼仍開得起來）
// 注意：絕不快取 /api/*（信件資料一律即時取，避免讀到舊信或洩漏）
// __SW_BUILD__ 由 vite build 後置換成本次 build 的 entry hash（見 vite.config.ts swVersion 外掛）：
// 讓 SW 位元組隨每次部署改變 → 瀏覽器必偵測到新版 SW 並重抓，解決「sw.js 不變→卡舊殼」。
const CACHE = 'miseroda-shell-__SW_BUILD__';
const SHELL = ['/', '/favicon-32.png', '/apple-touch-icon.png', '/logo-dark.png', '/logo-light.png'];

// worker 動態路由：一律不進 runtime 快取（清單與 wrangler.jsonc 的 run_worker_first 同步，改一邊要改另一邊）。
// 這些回應帶一次性 token／會過期的秘密，不是靜態資產：
//   /e/<token>/raw 是加密訊息的密文 bundle（含明文主旨）——快取住等於 expires_at 失效、
//   過期後的 410 也永遠打不到（410 非 ok、不覆蓋也不清舊條目）；/dl/、/cal/ 同理是 token 換資料。
// 只有 Asset Worker 直送的靜態檔（/ 殼、/assets/*、圖示…）才需要離線快取。
const DYNAMIC_PREFIXES = ['/api/', '/dl/', '/cal/', '/e/'];
const DYNAMIC_EXACT = ['/share-target', '/e-decrypt.js'];
function isDynamicRoute(url) {
  if (url.origin !== self.location.origin) return false;
  return DYNAMIC_PREFIXES.some((p) => url.pathname.startsWith(p)) || DYNAMIC_EXACT.includes(url.pathname);
}

self.addEventListener('install', (e) => {
  // 刻意「不」自動 skipWaiting：更新版進 waiting 等使用者按「立即更新」才接管，
  // 避免操作到一半被新 SW 接管、舊殼引用的 hash 資產已被新部署清掉 → 白屏。
  // （首裝時無既有 SW，本來就會直接 activate，不受影響。）
  e.waitUntil(
    (async () => {
      const c = await caches.open(CACHE);
      await c.addAll(SHELL); // 含 '/'（fresh fetch）
      // F7.10：冷裝（從未線上載過）也能離線開 App——解析 index.html 引用的 entry chunk（hashed JS/CSS）一併預快取。
      try {
        const res = await c.match('/');
        if (res) {
          const html = await res.text();
          const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+\.(?:js|css))"/g)].map((m) => m[1]);
          await Promise.all([...new Set(assets)].map((a) => c.add(a).catch(() => {}))); // best-effort：單一資產失敗不擋安裝
        }
      } catch {
        /* 解析失敗不阻斷安裝；線上首載仍會 runtime 快取 */
      }
    })(),
  );
});

// 前端按下「立即更新」→ postMessage 觸發接管（接著 activate→claim→controllerchange→前端 reload）。
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

// 推播訂閱輪換：瀏覽器週期性換金鑰/重裝會觸發此事件；不處理 → 舊 endpoint 失效、新的沒上報
// → 使用者「莫名收不到通知」。用公開的 VAPID key 重訂閱並回報後端（附舊 endpoint 讓它換掉）。
// best-effort：拿不到 key/CSRF（未登入或不支援 cookieStore）就放棄，等 App 啟動健康檢查補。
self.addEventListener('pushsubscriptionchange', (e) => {
  e.waitUntil(resubscribePush(e));
});
async function resubscribePush(e) {
  try {
    const appServerKey = await fetchVapidKey();
    if (!appServerKey) return;
    const sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: appServerKey });
    const csrf = await readCsrfCookie();
    if (!csrf) return;
    const json = sub.toJSON();
    await fetch('/api/v1/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify({
        endpoint: sub.endpoint,
        p256dh: (json.keys && json.keys.p256dh) || '',
        auth: (json.keys && json.keys.auth) || '',
        oldEndpoint: e.oldSubscription ? e.oldSubscription.endpoint : undefined,
      }),
    });
  } catch {
    /* best-effort：失敗等 App 啟動健康檢查補上 */
  }
}
async function fetchVapidKey() {
  try {
    const res = await fetch('/api/v1/auth/config'); // 公開端點，回 vapidPublicKey
    if (!res.ok) return null;
    const cfg = await res.json();
    return cfg.vapidPublicKey ? urlBase64ToUint8Array(cfg.vapidPublicKey) : null;
  } catch {
    return null;
  }
}
function urlBase64ToUint8Array(b64url) {
  const padding = '='.repeat((4 - (b64url.length % 4)) % 4);
  const base64 = (b64url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) arr[i] = raw.charCodeAt(i);
  return arr;
}

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => purgeDynamicEntries())
      .then(() => self.clients.claim()),
  );
});

// 舊版 SW 把 /e/<token>/raw、/dl/ 等動態回應也寫進了快取。快取名只隨 entry hash 變動，
// 只改 sw.js 的部署會沿用同一個名字 → 上面的「刪非本版快取」掃不到那些殘留條目。
// 接管時逐筆清掉：已被寫進磁碟的密文 bundle／明文主旨不會留到下一次換 hash。
async function purgeDynamicEntries() {
  try {
    const c = await caches.open(CACHE);
    const reqs = await c.keys();
    await Promise.all(reqs.filter((r) => isDynamicRoute(new URL(r.url))).map((r) => c.delete(r)));
  } catch {
    /* best-effort：清不掉也不擋接管 */
  }
}

// Web Push：新信系統通知（payload 由 worker 以 RFC 8291 加密送來）
self.addEventListener('push', (e) => {
  let data = { title: 'Miseroda Mail', body: '你有新郵件', url: '/' };
  try {
    data = { ...data, ...e.data.json() };
  } catch {
    /* 無 payload 的喚醒推播：用預設文案 */
  }
  e.waitUntil(
    (async () => {
      // F7.8：已有「可見」視窗（使用者正在看 App，WS 已即時更新 UI）→ 抑制重複通知，只更新角標。
      // 必須先濾自家來源：includeUncontrolled 會帶回他源/上一代 SW 的殘留視窗，否則別站可見就誤抑制。
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const ownVisible = wins.some((w) => {
        if (w.visibilityState !== 'visible') return false;
        try {
          return new URL(w.url).origin === self.location.origin;
        } catch {
          return false;
        }
      });
      const visible = ownVisible;
      const jobs = [];
      // F21.2：告訴還活著的分頁「有新信」——分頁隱藏超過 60 秒時 WS 已被主動關掉（F7.8），
      // 沒有這條，提示音在最需要的情境（人不在這個分頁）永遠不會響。
      // 只送自家來源的視窗；是否出聲由頁面自己判斷（提示音開關、有沒有在看、節流）。
      for (const w of wins) {
        try {
          if (new URL(w.url).origin === self.location.origin) {
            // title＝寄件者、body＝主旨（推播通知本來就這樣呈現），站內卡片直接沿用。
            w.postMessage({ type: 'new-mail', id: data.id, title: data.title, body: data.body });
          }
        } catch {
          /* 壞掉的 client 略過，絕不能影響通知與角標 */
        }
      }
      if (!visible) {
        jobs.push(
          self.registration.showNotification(data.title, {
            body: data.body,
            icon: '/icon-192.png',
            badge: '/favicon-32.png',
            // tag 改用訊息 id：不同信並列、不互相覆蓋（舊版用單一 tag 會把前一封蓋掉）。
            tag: data.id || 'miseroda-mail',
            renotify: true,
            // 動作鈕：不開 App 即可封存 / 標已讀（notificationclick 內依 e.action 直接打 API）。
            actions: data.id ? [{ action: 'archive', title: '封存' }, { action: 'read', title: '標為已讀' }] : [],
            data: { url: data.url, id: data.id },
          }),
        );
      }
      // OS 圖示角標：不論前景背景都更新未讀紅點（已安裝 PWA 才有效，feature-detect）。
      if (typeof data.unread === 'number' && 'setAppBadge' in self.navigator) {
        jobs.push(
          data.unread > 0
            ? self.navigator.setAppBadge(data.unread).catch(() => {})
            : self.navigator.clearAppBadge().catch(() => {}),
        );
      }
      await Promise.all(jobs);
    })(),
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const data = e.notification.data || {};
  const url = data.url || '/';
  // 動作鈕：不開 App，直接打 API 封存 / 標已讀（拿不到 CSRF 或失敗 → 退回開信讓使用者處理）。
  if ((e.action === 'archive' || e.action === 'read') && data.id) {
    e.waitUntil(runNotificationAction(e.action, data.id, url));
    return;
  }
  e.waitUntil(openOrFocus(url));
});

// 讀 CSRF double-submit token（非 HttpOnly，可由 cookieStore 取）→ 對自己的信打 PATCH。
async function runNotificationAction(action, id, url) {
  try {
    const csrf = await readCsrfCookie();
    if (!csrf) return openOrFocus(url); // 不支援 cookieStore / 無 token → 退回開信
    const body = action === 'archive' ? { folder: 'archive' } : { unread: false };
    const res = await fetch(`/api/v1/messages/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify(body),
    });
    if (!res.ok) return openOrFocus(url); // 失敗 → 退回開信
    // 成功：請開著的分頁刷新列表/計數（App 監聽 mail-changed）
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) w.postMessage({ type: 'mail-changed' });
  } catch {
    return openOrFocus(url);
  }
}

async function readCsrfCookie() {
  if (!self.cookieStore) return null;
  try {
    const c = (await self.cookieStore.get('__Host-csrf')) || (await self.cookieStore.get('csrf'));
    return c ? c.value : null;
  } catch {
    return null;
  }
}

async function openOrFocus(url) {
  const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const w of wins) {
    if (new URL(w.url).origin === self.location.origin) {
      w.focus();
      w.navigate(url);
      return;
    }
  }
  return self.clients.openWindow(url);
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // 資料一律走網路

  // 導覽請求：network-first，離線回退到快取的 SPA 殼
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(() => caches.match('/')));
    return;
  }
  // worker 動態路由（密文 bundle／大附件下載／行事曆 feed）：完全不經快取層，交瀏覽器直接連網。
  // 「不讀」和「不寫」一樣重要——舊版 SW 可能已經存過，只停止寫入仍會端出過期的密文。
  if (isDynamicRoute(url)) return;
  // 靜態資產：stale-while-revalidate
  e.respondWith(
    caches.match(e.request).then((cached) => {
      const network = fetch(e.request)
        .then((res) => {
          // clone 必須「同步」做完：caches.open 是 async，等它 resolve 時 res 已交給頁面且 body 開始被消化
          // → 那時才 res.clone() 會拋 TypeError（body already used），結果是資產永遠沒進快取＋console 噴錯。
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});
