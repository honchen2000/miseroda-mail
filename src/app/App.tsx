import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { api, ApiError, setUnauthorizedHandler, type Me } from './api/client';
import { setConnectionErrorHandler, inConnectionErrorWindow } from './api/netstatus';
import { dt } from './lib/demoI18n';
import { OFFLINE_MAX_AGE, countPendingSends, enqueuePendingSend, listPendingSends, loadPersistedMe, offlinePersister, purgeOfflineCache, removePendingSend, savePersistedMe, shouldDehydrateOfflineQuery } from './lib/offline';
import { dismissInstall, promptInstall, useCanInstall } from './lib/installPrompt';
import { useOnline } from './hooks/useOnline';
import { CATEGORY_LABEL, countsQueryOptions, useAiSummarize, useBatch, useBatchByView, useBlockSender, useCounts, useMessages, useMute, usePatchMessage, useRouteNewslettersOut, useSetFollowup, useSetThreadNote, useFollowups, useThread, usePrefetchThread, useTranslate, useUnsubscribe, type InboxCategory, type MsgListItem, type ThreadMessage, type View } from './api/mail';
import { useContactNames } from './api/contacts';
import { historyMode, pathToRoute, routeToPath, withQueryParam } from './lib/route';
// F17.1：展開上限的純邏輯抽成無 DOM 模組，讓 worker 測試 import 得到（test/worker/composer-wins.test.ts）
import { enforceExpandLimit } from './composerWins';
import {
  deleteDraft, saveDraft, useCancelSend, useDrafts, useOutbox, useResolveSend, useRetrySend, useSendMessage, type ComposerDraft, type ComposerAttachment,
  type ServerDraft,
} from './api/send';
import { LoginScreen, InviteFlow, AuthShell, MfaEnroll, RecoverFlow, DemoLanding } from './components/auth';
import { CommandPalette, type PaletteAction } from './components/palette';
import { Composer } from './components/composer';
import { DraftsList, FOLDERS, MessageList, ReadingPane, Sidebar } from './components/mail';
import { UserMenu } from './components/user-menu';
import { NotifBell } from './components/notif-bell';
import { EmptyState, Icon, Lightbox, Modal, Pori, UndoRing, fullTime, type LightboxAtt } from './components/ui';
import { confirmDialog, promptDialog, DialogHost } from './components/dialog';

// 按需路由 / Modal：拆成獨立 chunk，縮小初始 bundle（首屏只載入收件匣三欄）
const AdminPage = lazy(() => import('./components/admin').then((m) => ({ default: m.AdminPage })));
const CalendarPage = lazy(() => import('./components/calendar').then((m) => ({ default: m.CalendarPage })));
const ContactsPage = lazy(() => import('./components/contacts').then((m) => ({ default: m.ContactsPage })));
const Contact360Modal = lazy(() => import('./components/contacts').then((m) => ({ default: m.Contact360Modal }))); // F5.4：閱讀窗點寄件人開往來脈絡
const FilesPage = lazy(() => import('./components/files').then((m) => ({ default: m.FilesPage })));
const FollowupsPage = lazy(() => import('./components/followups').then((m) => ({ default: m.FollowupsPage })));
const TodayPage = lazy(() => import('./components/today').then((m) => ({ default: m.TodayPage })));
const SettingsPage = lazy(() => import('./components/settings').then((m) => ({ default: m.SettingsPage })));
const AiComposeModal = lazy(() => import('./components/modals').then((m) => ({ default: m.AiComposeModal })));
const EncryptedLinkModal = lazy(() => import('./components/EncryptedLinkModal').then((m) => ({ default: m.EncryptedLinkModal })));
const Onboarding = lazy(() => import('./components/onboarding').then((m) => ({ default: m.Onboarding }))); // F8.9：首登導覽
const AskMailModal = lazy(() => import('./components/AskMailModal').then((m) => ({ default: m.AskMailModal }))); // F10.1：問信箱
const MeetingModal = lazy(() => import('./components/modals').then((m) => ({ default: m.MeetingModal })));
import { applyServerPrefs, setThemePrefs, useTheme } from './hooks/useTheme';
import { detectDomainTypos, looksLikeForgotAttachment } from './lib/compose-hints';
import { applyCustomTheme } from './lib/customTheme.dom';
import { computeReplyAllCc } from './lib/recipients';
import { buildQuotedReply, stripQuoteMarks } from './lib/quote';
import { signatureBlockHtml, signatureText } from './lib/signature';
import { haptics } from './lib/haptics';
import { applyAppBadge } from './lib/appBadge';
import { bootAuth } from './lib/boot';
import { ignoreSkippedTransition, type TransitionLike } from './lib/viewTransition';
import { applyFaviconBadge } from './lib/favicon.dom';
import { reaffirmPushSubscription, releasePushSubscription } from './lib/pushSync';
import { applySwUpdate, onUpdatePromptDue } from './lib/swUpdate';
import { useRealtime } from './hooks/useRealtime';
import { useNewMailAlert } from './hooks/useNewMailAlert';
import { NewMailCard } from './components/new-mail-card';

type Screen = 'loading' | 'login' | 'invite' | 'recover' | 'app' | 'wrong-host';

interface Toast {
  id: string;
  text: string;
  leaving?: boolean;
  countdown?: { total: number; left: number };
  action?: { label: string; run: () => void };
}

export function App() {
  useTheme();
  const queryClient = useQueryClient();
  const [screen, setScreen] = useState<Screen>('loading');
  const [me, setMe] = useState<Me | null>(null);
  const [offlineBoot, setOfflineBoot] = useState(false); // 以已快取身分進入（離線唯讀）
  const [demoPath, setDemoPath] = useState(() => location.pathname === '/demo'); // /demo 落地頁
  const screenRef = useRef(screen);
  screenRef.current = screen;
  const lastUserIdRef = useRef<string | null>(null); // 偵測同分頁換到不同使用者（多分頁共用 cookie）→ 清快取

  // 邀請連結（/#invite=CODE）直接帶碼進註冊流程；救援連結（/#recover=TOKEN）重新綁定 passkey
  const inviteCode = useMemo(() => new URLSearchParams(location.hash.slice(1)).get('invite'), []);
  const recoverToken = useMemo(() => new URLSearchParams(location.hash.slice(1)).get('recover'), []);

  // pending：開機時由 bootAuth 預先發出的 /auth/me（效能迴圈 P1）；其餘呼叫端不傳，照舊現打一支。
  const refreshMe = useCallback(async (pending?: Promise<Me>) => {
    try {
      const data = await (pending ?? api<Me>('/auth/me'));
      // 若這次的身分與上次不同（如另一分頁登入別人、覆蓋了共用 cookie）→ 先清掉前一人的快取
      if (lastUserIdRef.current && lastUserIdRef.current !== data.user.id) await purgeOfflineCache(queryClient);
      lastUserIdRef.current = data.user.id;
      setMe(data);
      setOfflineBoot(false);
      savePersistedMe(data); // 離線開機用
      applyServerPrefs(data.prefs);
      setScreen('app');
    } catch (e) {
      // 401＝工作階段失效（必須重新登入）；非 ApiError＝fetch 連不上（離線）
      const authFailed = e instanceof ApiError && e.status === 401;
      const networkDown = !(e instanceof ApiError);
      const cachedMe = loadPersistedMe();
      if (networkDown && cachedMe) {
        // 離線：以最近一次成功登入的身分進入唯讀模式，持久化的快取會顯示已載入過的信
        setMe(cachedMe);
        setOfflineBoot(true);
        applyServerPrefs(cachedMe.prefs);
        setScreen('app');
        return;
      }
      if (authFailed) await purgeOfflineCache(queryClient); // 工作階段失效：清掉記憶體+持久化快取（防同分頁換人讀到舊資料）
      setMe(null);
      setScreen(recoverToken ? 'recover' : inviteCode ? 'invite' : 'login');
      if (!authFailed && !networkDown) console.error(e);
    }
  }, [inviteCode, recoverToken, queryClient]);

  // 全域 401：任一查詢/操作回 401 時，以 /auth/me 重新驗證工作階段（僅在已進入信箱時；
  // 真失效→refreshMe 的 401 分支會 purge+掉登入，誤觸→/auth/me 回 200 維持登入，不誤登出）。
  useEffect(() => {
    setUnauthorizedHandler(() => {
      if (screenRef.current === 'app') void refreshMe();
    });
    return () => setUnauthorizedHandler(null);
  }, [refreshMe]);

  // 效能迴圈 P1：config 與 me 同時出發（原本串行，平白多等一整趟往返），判定順序不變——見 lib/boot.ts。
  // 效能迴圈 P10：這台裝置上次是登入身分時（localStorage 的 miseroda_me，只當「要不要花這支請求」的提示），
  // 信箱計數與 /auth/me 同一刻出發，不必等 /auth/me 回來、再等 React 渲染完信箱外殼（本機實測空窗 104–133 ms）。
  // 安全：只是把 MailShell 稍後一定會送的同一支請求提早送；伺服器端照樣驗 session（未登入 401 不帶資料），
  // 結果只進記憶體快取、在 /auth/me 確認前不顯示也不持久化（持久化訂閱要等 PersistQueryClientProvider 掛載，
  // 而它只在 refreshMe 成功後才掛）；/auth/me 401 → 既有 purgeOfflineCache 的 qc.clear() 會取消並丟掉它。
  // ⚠️ 刻意**不**預抓信件清單（useInfiniteQuery）：預抓時快取是空的只會抓 1 頁，完成後會把 IndexedDB
  // 還原的多頁清單整包蓋回 1 頁並寫回持久層，離線可讀深度變淺（審查鏡頭 C 指出，已核實，見 docs/perf-startup-log.md D3-1）。
  useEffect(() => {
    if (loadPersistedMe() !== null) void queryClient.prefetchQuery(countsQueryOptions());
    void (async () => {
      const boot = await bootAuth({
        host: location.hostname,
        fetchConfig: () => api<{ rpId: string }>('/auth/config'),
        fetchMe: () => api<Me>('/auth/me'),
      });
      if (boot.kind === 'wrong-host') {
        setScreen('wrong-host');
        return;
      }
      await refreshMe(boot.me);
    })();
  }, [refreshMe, queryClient]);

  if (screen === 'loading') {
    return (
      <div className="auth-wrap">
        <div style={{ color: 'var(--text-muted)', fontSize: 13, fontFamily: 'var(--font-mono)' }}>載入中…</div>
      </div>
    );
  }

  if (screen === 'wrong-host') {
    return (
      <AuthShell>
        <h1 className="auth-title">網域不符</h1>
        <p className="auth-sub">
          Passkey 與正式網域綁定。請改用 <span style={{ fontFamily: 'var(--font-mono)' }}>https://mail.miseroda.com</span>
          ，在這裡註冊的 passkey 將無法在正式站使用。
        </p>
      </AuthShell>
    );
  }

  // /demo 落地頁：一鍵進唯讀 demo（未登入時）
  if (screen === 'login' && demoPath) {
    return <DemoLanding
      onEntered={() => { history.replaceState(null, '', '/'); void refreshMe(); }}
      onGoLogin={() => { history.replaceState(null, '', '/'); setDemoPath(false); }} />;
  }
  if (screen === 'login') return <LoginScreen onLogin={() => void refreshMe()} onGoInvite={() => setScreen('invite')} />;
  if (screen === 'invite') {
    return <InviteFlow onDone={() => { location.hash = ''; void refreshMe(); }} onBack={() => setScreen('login')}
      initialCode={inviteCode ?? undefined} />;
  }
  if (screen === 'recover' && recoverToken) {
    return <RecoverFlow token={recoverToken} onBack={() => { location.hash = ''; setScreen('login'); }}
      onDone={() => { location.hash = ''; setScreen('login'); }} />;
  }
  if (!me) return null;

  // 伺服器端強制兩步驟驗證：尚未啟用 TOTP 者一律先走設定精靈，無法進入信箱
  // （唯讀 demo 帳號豁免——無 passkey/TOTP，且伺服器端已擋死所有變更，直接進唯讀信箱）
  if (!me.totpEnabled && !me.isDemo) {
    return (
      <MfaEnroll
        email={me.user.email}
        onDone={() => void refreshMe()}
        onLogout={() => {
          void api('/auth/logout', { method: 'POST' }).catch(() => {});
          void purgeOfflineCache(queryClient);
          setMe(null);
          setScreen('login');
        }}
      />
    );
  }

  // 信件相關查詢持久化到 IndexedDB（離線閱讀）；buster 綁使用者 id → 換人即丟棄
  return (
    <PersistQueryClientProvider
      key={me.user.id}
      client={queryClient}
      persistOptions={{
        persister: offlinePersister,
        maxAge: OFFLINE_MAX_AGE,
        buster: me.user.id,
        dehydrateOptions: { shouldDehydrateQuery: shouldDehydrateOfflineQuery },
      }}>
      <MailShell
        me={me}
        offlineBoot={offlineBoot}
        onRefreshMe={() => void refreshMe()}
        onLoggedOut={() => { void purgeOfflineCache(queryClient); setMe(null); setScreen('login'); }}
      />
    </PersistQueryClientProvider>
  );
}

/* ================= 主畫面（三欄 shell） ================= */

/** 按需路由頁載入中的骨架（lazy chunk 抓取期間，通常一瞬） */
function PageFallback() {
  return (
    <main className="readpane">
      <div className="content-page">
        <div className="skeleton" style={{ height: 28, width: 200, marginBottom: 18 }} />
        <div className="skeleton" style={{ height: 120, borderRadius: 12 }} />
      </div>
    </main>
  );
}

function draftKey(d: ComposerDraft): string {
  return JSON.stringify({
    to: d.to, cc: d.cc, bcc: d.bcc, subject: d.subject, body: d.body, html: d.bodyHtml,
    att: d.attachments.map((a) => a.id), fromAlias: d.fromAlias ?? null,
    links: (d.linkFiles ?? []).map((f) => f.token),
  });
}

/**
 * F17.1：一扇撰寫視窗。
 * key 是本地穩定 id——**不能用 draftRowId**，那要第一次自動儲存成功後才有值，
 * 而視窗在那之前就已經存在（使用者一按「寫信」就有一扇）。
 */
interface ComposerWin {
  key: string;
  draft: ComposerDraft;
  minimized: boolean;
  autosave: 'idle' | 'saving' | 'saved';
  /** 最近互動時間：展開數超過上限時，決定先收起哪一扇。 */
  activeAt: number;
}

const newWinKey = () => Math.random().toString(36).slice(2);

/**
 * F17.2：同時展開的上限依視窗寬度。
 * 寬視窗 2 扇（主寫 ＋ 對照，就是 Hon 要的情境）；窄視窗 1 扇——
 * 兩扇並排需要 24＋580＋16＋580 ≈ 1200px，低於 1280px 會被擠出畫面。
 * 手機（≤920px）的 .composer 是 inset:0 全螢幕，本來就只能一扇，故同樣走 NARROW。
 */
const MAX_EXPANDED_WIDE = 2;
const MAX_EXPANDED_NARROW = 1;
const WIDE_QUERY = '(min-width: 1280px)';

/**
 * F17.1：每扇視窗自己的自動儲存計時器。
 * 刻意做成獨立元件、而不是在 App 裡管一張 timer Map——每個實例有自己的 useEffect，
 * 在 A 視窗打字不會重置 B 視窗的計時器，也不會有「key 對不上而互相蓋掉 draftRowId」的風險。
 * contentKey 是草稿內容指紋：只有內容真的變了才重排計時器。
 */
function DraftAutosave({ winKey, contentKey, run }: { winKey: string; contentKey: string; run: (key: string) => void }) {
  useEffect(() => {
    const t = setTimeout(() => run(winKey), 1500);
    return () => clearTimeout(t);
  }, [winKey, contentKey, run]);
  return null;
}

/** 伺服器草稿列 → 撰寫器草稿。openDraftRow 與 F17.3 批次寄出共用，避免兩處轉換漂移。 */
function rowToDraft(row: ServerDraft): ComposerDraft {
  return {
    to: row.payload.to,
    cc: row.payload.cc,
    bcc: row.payload.bcc ?? '',
    subject: row.payload.subject,
    body: row.payload.body,
    bodyHtml: row.payload.bodyHtml ?? null,
    attachments: row.payload.attachments ?? [],
    replyToMessageId: row.payload.replyToMessageId,
    draftRowId: row.id,
    fromAlias: row.payload.fromAlias ?? null,
    linkFiles: row.payload.linkFiles ?? [],
  };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// F5.5：讀「被回覆的那封信」iframe 內目前選取的純文字（內文在 sandbox iframe[allow-same-origin] 內）。
// 限定 data-msg-id 對應的 iframe → 不會把對話串裡別封信的選取誤引用（Codex MED 修）。無選取/跨源/未就緒 → 空字串。
function readReadpaneSelection(msgId: string): string {
  try {
    const f = document.querySelector<HTMLIFrameElement>(`.readpane-scroll iframe[data-msg-id="${CSS.escape(msgId)}"]`);
    return f?.contentWindow?.getSelection?.()?.toString().trim() ?? '';
  } catch {
    return ''; /* 跨源/未就緒 → 視為無選取 */
  }
}

function MailShell({ me, offlineBoot, onRefreshMe, onLoggedOut }: { me: Me; offlineBoot: boolean; onRefreshMe: () => void; onLoggedOut: () => void }) {
  const qc = useQueryClient();
  // F20.2／F20.3：初始視圖與開啟中的信都直接由網址決定，而不是先進收件匣再同步——
  // 後者會在歷史紀錄裡多一筆，也會讓「在封存匣重整」先閃一下收件匣。
  // 非法路徑回落收件匣，由下方的 effect 用 replaceState 收斂。
  const initialRoute = useRef(pathToRoute(location.pathname));
  const [view, setViewRaw] = useState<View>(() => initialRoute.current?.view ?? { type: 'folder', folder: 'inbox' });
  /** 初次掛載時網址是否合法。非法時第一次同步用 replaceState（不要在歷史裡留下那個壞網址）。 */
  const pathWasValidRef = useRef(initialRoute.current !== null);
  const [inboxCategory, setInboxCategory] = useState<InboxCategory>('primary'); // 收件匣分類分頁（主要/社交/促銷/通知）
  // F20.4：搜尋字串也由網址決定，帶 ?q= 的連結可以直接加書籤／分享。
  const [query, setQuery] = useState(() => new URLSearchParams(location.search).get('q') ?? '');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(() => initialRoute.current?.messageId ?? null);
  const [cursorId, setCursorId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [showKbd, setShowKbd] = useState(false);
  const [meetingOpen, setMeetingOpen] = useState(false); // 自建會議邀請 Modal
  const [aiComposeOpen, setAiComposeOpen] = useState(false); // AI 草擬信件 Modal
  const [encrypt, setEncrypt] = useState<{ initialBody?: string } | null>(null); // F7.7：建立加密訊息連結 Modal（F8.4：帶入正文）
  // F8.9：首登 60 秒導覽——localStorage 無標記才顯示（完成/跳過即寫入）
  const [showOnboard, setShowOnboard] = useState(() => { try { return !localStorage.getItem('miseroda_onboarded_v1'); } catch { return false; } });
  const [askOpen, setAskOpen] = useState(false); // F10.1：問信箱（AI 問答）
  // F11.4：登入後套用自訂配色（prefs 跨裝置同步；null/缺省即預設主色）
  useEffect(() => {
    applyCustomTheme((me.prefs.customTheme as { accent?: string; bg?: string } | undefined) ?? null);
  }, [me.prefs.customTheme]);
  const [profileEmail, setProfileEmail] = useState<string | null>(null); // F5.4：閱讀窗點寄件人開往來脈絡
  const [morphId, setMorphId] = useState<string | null>(null); // F6.1：手機 list→read 主旨 morph 進行中的信 id
  const [showPalette, setShowPalette] = useState(false);
  const [quickPick, setQuickPick] = useState<PaletteAction[] | null>(null); // F3.1：l=標籤 / v=移動 快選（重用 CommandPalette）
  const gPendingRef = useRef(0);
  const [toasts, setToasts] = useState<Toast[]>([]);
  // F17.1：撰寫器由單例改成多實例。每扇視窗自帶草稿、收合與自動儲存狀態。
  // 收合一律是 CSS 隱藏（.composer.minimized 是 opacity:0），**絕不可改成卸載**——
  // React 19 的 contentEditable 只能在 mount 時用 ref 播種一次，卸載再掛回來游標與 undo 歷史就沒了。
  const [wins, setWins] = useState<ComposerWin[]>([]);
  const [wideEnough, setWideEnough] = useState(() => window.matchMedia(WIDE_QUERY).matches);
  // F17.3：草稿匣的批次勾選與依序寄出。
  const [draftSel, setDraftSel] = useState<Set<string>>(() => new Set());
  const [batchSending, setBatchSending] = useState(false);
  /** 批次排程後盯著 outbox 到這個時間點為止（讓失敗能主動冒出來，而不是等你自己逛到寄件備份）。 */
  const [watchOutboxUntil, setWatchOutboxUntil] = useState(0);
  const [lightbox, setLightbox] = useState<LightboxAtt | null>(null);
  const [leavingIds, setLeavingIds] = useState<Set<string>>(() => new Set());
  const [bouncingStarId, setBouncingStarId] = useState<string | null>(null);
  const [selectedSet, setSelectedSet] = useState<Set<string>>(() => new Set());
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [searchHost, setSearchHost] = useState<HTMLElement | null>(null);
  const [replyMount, setReplyMount] = useState<HTMLDivElement | null>(null);
  const undoTimers = useRef<Record<string, ReturnType<typeof setInterval>>>({});
  // 每扇視窗各自的「已存內容指紋」。用 Map 而非單一值，否則 A 存檔後會把 B 誤判成已存而漏存。
  const lastSavedRef = useRef<Map<string, string>>(new Map());
  const winsRef = useRef<ComposerWin[]>([]);
  winsRef.current = wins; // 鏡像 → 讓 in-flight 的自動儲存能偵測該扇是否已被送出/關閉
  // F17.2：展開上限隨視窗寬度變動；用 ref 讓 setWins 的 updater 讀得到最新值（不吃閉包舊值）。
  const maxExpanded = wideEnough ? MAX_EXPANDED_WIDE : MAX_EXPANDED_NARROW;
  const maxExpandedRef = useRef(maxExpanded);
  maxExpandedRef.current = maxExpanded;
  const lastClickIdxRef = useRef(-1);
  const swUpdateShownRef = useRef(false); // 「有新版」提示只顯示一次

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  const isDraftsView = view.type === 'folder' && view.folder === 'drafts';
  const isSentView = view.type === 'folder' && view.folder === 'sent';
  // F21.2/F21.4：WS 與 SW push 兩路共用同一個閘——沒看著分頁 → 出聲；看著 → 出卡片。
  const newMail = useNewMailAlert();
  useRealtime(true, newMail.onNewMail); // WS 即時收件（輪詢降為保底）
  const counts = useCounts();
  const followupsQ = useFollowups(); // F14.4A：通知鈴鐺的跟進清單
  // 效能：D1 跨區，冷開一封信要等數個來回。先把「最可能被點的」抓進快取 → 點下去即時。
  const prefetchThread = usePrefetchThread();
  const online = useOnline();
  // 重新連線：若是以離線快取身分進入，回線後重新驗證工作階段並刷新資料
  const wasOnline = useRef(online);
  useEffect(() => {
    if (online && !wasOnline.current && offlineBoot) onRefreshMe();
    wasOnline.current = online;
  }, [online, offlineBoot, onRefreshMe]);

  // 整條分類分頁列收起時（社交/促銷/通知全空 → 沒有非主要分頁可點）才自動回「主要」，
  // 避免被困在不存在的分頁。注意：只看「整列是否收起」，不看「目前這個分類是否為空」——
  // 否則使用者點一個剛好沒信的分類會被立刻彈回，看不到該分類的空狀態。
  useEffect(() => {
    const cc = counts.data?.inboxCategories;
    if (!cc) return;
    const stripVisible = cc.social.total + cc.promotions.total + cc.updates.total > 0;
    if (inboxCategory !== 'primary' && !stripVisible) {
      setInboxCategory('primary');
    }
  }, [counts.data, inboxCategory]);

  // 分頁標題未讀徽章：(3) Miseroda Mail
  const inboxUnread = counts.data?.folders.inbox?.unread ?? 0;
  useEffect(() => {
    document.title = inboxUnread > 0 ? `(${inboxUnread}) Miseroda Mail` : 'Miseroda Mail';
    return () => {
      document.title = 'Miseroda Mail';
    };
  }, [inboxUnread]);
  // PWA：前景時把 OS 圖示角標同步到收件匣未讀（背景由 sw.js push handler 設）。
  // F21.3：分頁圖示紅點同源於同一個未讀數——標題 `(3)`、OS 角標、favicon 三者永遠一致。
  useEffect(() => {
    applyAppBadge(inboxUnread);
    applyFaviconBadge(inboxUnread);
  }, [inboxUnread]);
  const messages = useMessages(view, debouncedQ, inboxCategory);
  const thread = useThread(selectedId);
  const drafts = useDrafts(isDraftsView);
  // 平常只有在寄件備份才輪詢 outbox（省請求）；批次排程期間額外盯著，好即時回報失敗。
  const watchingOutbox = watchOutboxUntil > Date.now();
  const outbox = useOutbox(isSentView || watchingOutbox);
  const patchMsg = usePatchMessage();
  // F9.7：線程便利貼 + 改顯示主旨
  const setThreadNote = useSetThreadNote();
  const renameSubject = useCallback(
    async (m: ThreadMessage) => {
      const v = await promptDialog({
        title: '改顯示主旨',
        body: '只影響你自己看到的列表與讀信畫面；搜尋與回覆引用仍用原主旨。清空即還原。',
        label: `原主旨：${m.subject || '（無主旨）'}`,
        initial: m.subjectOverride ?? m.subject,
        placeholder: '輸入新的顯示主旨…',
      });
      if (v === null) return;
      patchMsg.mutate({ id: m.id, patch: { subjectOverride: v.trim() || null } });
    },
    [patchMsg],
  );
  const sendMutation = useSendMessage();
  const cancelMutation = useCancelSend();
  const retryMutation = useRetrySend();
  const resolveMutation = useResolveSend();
  // F7.3：離線送信待送匣（手動補送）
  const [pendingSends, setPendingSends] = useState(0);
  const [flushingOutbox, setFlushingOutbox] = useState(false);
  const refreshPending = useCallback(() => { void countPendingSends().then(setPendingSends).catch(() => {}); }, []);
  const canInstallNow = useCanInstall(); // F7.5：Android/桌面 A2HS 安裝提示可顯示？
  const aiMutation = useAiSummarize();
  const translateMutation = useTranslate();
  const unsubscribeMutation = useUnsubscribe();
  const batchMutation = useBatch();
  const batchByView = useBatchByView(); // F4.7
  const routeNewslettersOut = useRouteNewslettersOut(); // F5.6b：opt-in 電子報移出主收件匣

  // 攤平分頁；以 id 去重——新信抵達後重抓各頁，分頁邊界可能出現同一封信橫跨兩頁（重複 key）
  const items = useMemo(() => {
    const seen = new Set<string>();
    return (messages.data?.pages ?? []).flatMap((p) => p.items).filter((m) => (seen.has(m.id) ? false : seen.add(m.id)));
  }, [messages.data]);
  const labelsById = useMemo(
    () => Object.fromEntries((counts.data?.labels ?? []).map((l) => [l.id, l])),
    [counts.data],
  );
  const contactNames = useContactNames();

  // 效能預熱：列表一到手就先抓前 3 封（最可能被點的），並在選取後預抓上下一封（j/k 導航即時）。
  // prefetchQuery 對已快取的 id 不會重打，成本受 staleTime 控制。
  // 前 3 封的 prefetch 延後到瀏覽器空檔（requestIdleCallback，不支援時 setTimeout 300ms）執行，
  // 避免和列表首次渲染搶頻寬拖長切資料夾的尾延遲；cleanup 取消尚未執行的排程，避免快速連切資料夾時堆積。
  useEffect(() => {
    if (!items.length) return;
    const top3 = items.slice(0, 3);
    const run = () => { for (const m of top3) prefetchThread(m.id); };
    let idleId: number | undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    if (typeof requestIdleCallback === 'function') idleId = requestIdleCallback(run);
    else timeoutId = setTimeout(run, 300);

    const anchor = selectedId ?? cursorId;
    if (anchor) {
      const i = items.findIndex((m) => m.id === anchor);
      if (i >= 0) {
        prefetchThread(items[i + 1]?.id);
        prefetchThread(items[i - 1]?.id);
      }
    }
    return () => {
      if (idleId !== undefined && typeof cancelIdleCallback === 'function') cancelIdleCallback(idleId);
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    };
  }, [items, selectedId, cursorId, prefetchThread]);

  /* ---- Toasts（通用：可帶 undo 動作或寄送倒數環） ---- */
  const dismissToast = useCallback((id: string) => {
    setToasts((ts) => ts.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
    setTimeout(() => {
      setToasts((ts) => ts.filter((t) => t.id !== id));
      const timer = undoTimers.current[id];
      if (timer) {
        clearInterval(timer);
        delete undoTimers.current[id];
      }
    }, 180);
  }, []);

  // rawToast 一定顯示（連線 toast、離線入待送匣等關鍵提示用）。
  const rawToast = useCallback(
    (text: string, opts: { action?: { label: string; run: () => void }; duration?: number } = {}) => {
      const id = Math.random().toString(36).slice(2);
      setToasts((ts) => [...ts, { id, text, action: opts.action }]);
      setTimeout(() => dismissToast(id), opts.duration ?? (opts.action ? 6000 : 3200));
      return id;
    },
    [dismissToast],
  );
  // pushToast：一般領域提示。剛發生連線層錯誤的短窗內、且「線上」時才抑制——此時全域「連線逾時」會統一提示，
  // 避免雙 toast。硬離線時全域 toast 不彈（見 main.tsx onLine 閘），故不抑制領域提示，否則點擊零回饋。
  const pushToast = useCallback(
    (text: string, opts: { action?: { label: string; run: () => void }; duration?: number } = {}) => {
      if (inConnectionErrorWindow() && navigator.onLine) return '';
      return rawToast(text, opts);
    },
    [rawToast],
  );

  // 連線層失敗（逾時/斷線）→ 統一 toast（去抖在 netstatus）。用 rawToast 繞過連線窗抑制（它就是那一則）。
  useEffect(() => {
    setConnectionErrorHandler((msg) => rawToast(msg));
    return () => setConnectionErrorHandler(null);
  }, [rawToast]);

  // PWA：新版平常在背景自動套用（切走分頁且沒在寫信時，見 lib/swUpdate）；
  // 只有一直等不到安全時機（60 分鐘）才退回「立即更新」提示，點擊後這個分頁立刻換新版。
  // 用 rawToast：這是一次性提示，不能被 pushToast 的「連線錯誤短窗」抑制吃掉（吃掉就再也不會提示）。
  useEffect(() => {
    return onUpdatePromptDue(() => {
      if (swUpdateShownRef.current) return;
      swUpdateShownRef.current = true;
      rawToast('Miseroda 有新版本可用', {
        action: { label: '立即更新', run: applySwUpdate },
        duration: 3_600_000, // 常駐到使用者點更新或自行關閉
      });
    });
  }, [rawToast]);

  // 通知動作鈕（SW 在背景封存/標已讀後 postMessage）→ 刷新列表與計數，避免開著的分頁殘留舊狀態。
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    const onMsg = (e: MessageEvent) => {
      if (e.data?.type === 'mail-changed') {
        void qc.invalidateQueries({ queryKey: ['messages'] });
        void qc.invalidateQueries({ queryKey: ['counts'] });
      }
    };
    navigator.serviceWorker.addEventListener('message', onMsg);
    return () => navigator.serviceWorker.removeEventListener('message', onMsg);
  }, [qc]);

  // PWA：登入後重新回報目前 push 訂閱（補背景 pushsubscriptionchange 沒處理到的輪換）。
  useEffect(() => {
    void reaffirmPushSubscription();
  }, []);

  /* ---- F20.2／F20.3：視圖＋開啟中的信 ↔ 網址雙向同步 ----
     防迴圈完全靠「路徑比對」，不需要旗標：popstate 進來時 location.pathname 已經是新值，
     setState 之後算出來的路徑與它相同 → 下面那個 effect 直接 return，不會再 push 回去。 */
  /** 這一筆「開著信」的歷史是不是我們自己 push 的。決定 UI 關閉窗格時要 back() 還是 replaceState()。 */
  const pushedMessageRef = useRef(false);
  useEffect(() => {
    const path = routeToPath({ view, messageId: selectedId });
    if (location.pathname === path) return;
    const url = path + location.search + location.hash;

    if (!pathWasValidRef.current) {
      pathWasValidRef.current = true;
      history.replaceState(null, '', url); // 開場就是壞網址 → 就地修正，不佔一筆歷史
      return;
    }

    // push 還是 replace 由 route.ts 的 historyMode 決定（純函式，有測試釘住）：
    // 同一視圖內換信要 replace，歷史裡才永遠只有一筆「開著信」。
    const mode = historyMode(location.pathname, { view, messageId: selectedId });
    history[mode === 'replace' ? 'replaceState' : 'pushState'](null, '', url);
    pushedMessageRef.current = !!selectedId;
  }, [view, selectedId]);

  useEffect(() => {
    const onPop = () => {
      const r = pathToRoute(location.pathname);
      if (!r) return;
      // 走 Raw：上一頁不該觸發 setView 的那串重置（query/選取/抽屜…）
      setViewRaw(r.view);
      setSelectedId(r.messageId);
      setQuery(new URLSearchParams(location.search).get('q') ?? ''); // F20.4：搜尋也要跟著回去
      pushedMessageRef.current = false; // 這一筆是瀏覽器帶我們來的，不是我們 push 的
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  /* ---- F20.4：搜尋字串 → 網址 ----
     用 **debounced** 值而不是每個按鍵，且一律 replaceState：搜尋是連續輸入，
     每打一個字就 push 一筆的話，返回鍵會被搜尋紀錄塞滿，Hon 定的「返回鍵關窗格」就沒了。
     只動 ?q= 這一個參數（withQueryParam），其餘保留——見該函式的註解。 */
  useEffect(() => {
    const current = new URLSearchParams(location.search).get('q') ?? '';
    if (current === debouncedQ) return;
    const search = withQueryParam(location.search, 'q', debouncedQ);
    history.replaceState(null, '', location.pathname + search + location.hash);
  }, [debouncedQ]);

  /**
   * F20.3：關閉讀信窗格。Hon 定案「返回鍵＝關窗格」，所以 UI 的返回鍵也要和瀏覽器返回一致：
   * 是我們 push 進去的就 back() 把那一筆吃掉（否則歷史會一直累積開信紀錄）；
   * 若是直接從深連結進來的（沒有上一筆可退），back() 會把人帶離站 → 改用 replaceState 就地收斂。
   */
  const closeReadingPane = useCallback(() => {
    if (!pushedMessageRef.current) {
      setSelectedId(null);
      return;
    }
    pushedMessageRef.current = false;
    history.back(); // popstate 會接手把 selectedId 清掉
    // 保險絲：手機上讀信窗格是 position:fixed;inset:0，蓋滿整個畫面——一旦 back() 沒生效
    // （history 被別的東西動過、瀏覽器擋下、或這一筆根本不在我們手上），使用者就被關在裡面、
    // 沒有任何出口。300ms 後若網址仍停在信件路徑，就直接清掉 selectedId：
    // 寧可留下一筆多餘的歷史，也不要把人困住。back() 正常時這裡是 no-op。
    window.setTimeout(() => {
      if (pathToRoute(location.pathname)?.messageId) setSelectedId(null);
    }, 300);
  }, []);

  const setView = (v: View) => {
    const apply = () => {
      setViewRaw(v);
      setQuery('');
      setSelectedId(null);
      setCursorId(null);
      setDrawerOpen(false);
      setSelectedSet(new Set());
      setInboxCategory('primary'); // 切換視圖回到「主要」分頁
    };
    // 資料夾切換 crossfade（動畫 1）：View Transitions API，舊瀏覽器自動降級
    const motionOn = document.documentElement.getAttribute('data-motion') === 'on';
    const startVT = (document as Document & { startViewTransition?: (cb: () => void) => TransitionLike }).startViewTransition;
    if (motionOn && typeof startVT === 'function') {
      ignoreSkippedTransition(startVT.call(document, apply)); // 連點被略過不是錯誤（見 lib/viewTransition.ts）
    } else {
      apply();
    }
  };

  // F5.6a：點側欄釘選的自訂視圖 → 在收件匣跑該儲存搜尋（直接 setViewRaw 避免 setView 的 query 重置；
  // 但要鏡像 setView 的其餘重置，否則殘留的批次選取/游標/抽屜會跟著切換漂過去）。
  const runSavedSearch = (q: string) => {
    setViewRaw({ type: 'folder', folder: 'inbox' });
    setQuery(q);
    setSelectedId(null);
    setCursorId(null);
    setDrawerOpen(false);
    setSelectedSet(new Set());
    setInboxCategory('primary');
  };

  /* ---- 批次選取 ---- */
  const toggleSelect = useCallback(
    (id: string, shift: boolean) => {
      const curIdx = items.findIndex((m) => m.id === id);
      setSelectedSet((prev) => {
        const next = new Set(prev);
        if (shift && lastClickIdxRef.current >= 0 && curIdx >= 0) {
          const [a, b] = [lastClickIdxRef.current, curIdx].sort((x, y) => x - y);
          for (let i = a; i <= b; i++) if (items[i]) next.add(items[i].id);
        } else if (next.has(id)) {
          next.delete(id);
        } else {
          next.add(id);
        }
        return next;
      });
      lastClickIdxRef.current = curIdx;
    },
    [items],
  );
  const selectAll = useCallback(() => setSelectedSet(new Set(items.map((m) => m.id))), [items]);
  const clearSelect = useCallback(() => setSelectedSet(new Set()), []);

  const runBatch = useCallback(
    (body: { patch?: { folder?: string; unread?: boolean; starred?: boolean }; addLabelId?: string }, toast: string) => {
      const ids = [...selectedSet];
      if (!ids.length) return;
      batchMutation.mutate({ ids, ...body });
      clearSelect();
      pushToast(toast);
    },
    [selectedSet, batchMutation, clearSelect, pushToast],
  );

  // F17.3：Hon 選的失敗語意是「照排下去、失敗留在 outbox」，不中斷整批。
  // 那個選擇的代價是「可能沒注意到中間漏了一封」，所以這條主動提示是它的必要配套。
  const notifiedFailedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!watchingOutbox) return;
    for (const it of outbox.data?.items ?? []) {
      if (it.status !== 'failed' || notifiedFailedRef.current.has(it.id)) continue;
      notifiedFailedRef.current.add(it.id);
      pushToast(`排程信寄出失敗：「${it.subject || '（無主旨）'}」→ 到寄件備份重試`);
    }
  }, [outbox.data, watchingOutbox, pushToast]);

  /* ---- Composer（F17.1：多實例） ---- */
  const patchWin = useCallback((key: string, patch: Partial<ComposerWin> | ((w: ComposerWin) => Partial<ComposerWin>)) => {
    setWins((ws) => ws.map((w) => (w.key === key ? { ...w, ...(typeof patch === 'function' ? patch(w) : patch) } : w)));
  }, []);

  /** 開一扇新視窗。savedFingerprint：'__new__' = 全新草稿（避免空內容觸發儲存）；載入既有草稿則傳其 draftKey。 */
  const openWin = useCallback((d: ComposerDraft, savedFingerprint: string) => {
    const key = newWinKey();
    lastSavedRef.current.set(key, savedFingerprint);
    setWins((ws) => enforceExpandLimit([...ws, { key, draft: d, minimized: false, autosave: 'idle', activeAt: Date.now() }], maxExpandedRef.current));
    return key;
  }, []);

  /** 把某扇拉回展開並記為最近互動；超過上限時由 enforceExpandLimit 收起最久沒動的那扇。 */
  const focusWin = useCallback((key: string) => {
    setWins((ws) => enforceExpandLimit(ws.map((w) => (w.key === key ? { ...w, minimized: false, activeAt: Date.now() } : w)), maxExpandedRef.current));
  }, []);

  // F17.2：訂閱視窗寬度。縮窄 → 上限降到 1 → 立刻把超出的那扇收起（不會留在畫面外）。
  useEffect(() => {
    const mq = window.matchMedia(WIDE_QUERY);
    const on = () => setWideEnough(mq.matches);
    mq.addEventListener('change', on);
    on();
    return () => mq.removeEventListener('change', on);
  }, []);
  useEffect(() => {
    setWins((ws) => enforceExpandLimit(ws, maxExpanded));
  }, [maxExpanded]);

  const openCompose = useCallback(
    (preset?: Partial<ComposerDraft>) => {
      if (me.isDemo) { pushToast(dt('唯讀 Demo：無法寄信或回信 🔒', 'Read-only demo: sending and replying are disabled 🔒')); return; } // demo 全面擋開啟撰寫器（按鈕/鍵盤/palette/回覆皆涵蓋）
      openWin({
        to: '',
        cc: '',
        bcc: '',
        subject: '',
        body: signatureText(me.signature),
        // F4.4：新信也把預設簽名包成 [data-sig] 區塊，撰寫器切身分才有區塊可抽換。
        bodyHtml: me.signature.trim() ? `<p><br></p>${signatureBlockHtml(me.signature)}` : null,
        attachments: [],
        replyToMessageId: null,
        draftRowId: null,
        ...preset,
      }, '__new__'); // '__new__' = 全新草稿，避免空白內容觸發儲存
      setDrawerOpen(false);
    },
    [me.signature, me.isDemo, pushToast, openWin],
  );

  // F7.1：PWA 圖示長按捷徑（manifest shortcuts）。?launch=compose|unread|search|starred
  // → 登入後（MailShell 已掛載）開對應視圖；用後即清掉 query 避免重整再觸發。
  useEffect(() => {
    const launch = new URLSearchParams(location.search).get('launch');
    if (!launch) return;
    history.replaceState(null, '', location.pathname + location.hash);
    if (launch === 'compose') openCompose();
    else if (launch === 'starred') setView({ type: 'folder', folder: 'starred' });
    else if (launch === 'unread') { setView({ type: 'folder', folder: 'inbox' }); setQuery('is:unread'); }
    else if (launch === 'search') { setView({ type: 'folder', folder: 'inbox' }); setTimeout(() => searchRef.current?.focus(), 80); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // F7.2：Web Share Target 還原。share_target 端點已暫存 payload 並 302 到 /?share=<token>；
  // 這裡用 token 取回（session-gated、單次）→ 開 compose 帶入主旨/內文/附件；用後清 query。
  useEffect(() => {
    const shareToken = new URLSearchParams(location.search).get('share');
    if (!shareToken) return;
    history.replaceState(null, '', location.pathname + location.hash);
    void api<{ subject: string; body: string; attachments: ComposerAttachment[] }>(`/share-target/${encodeURIComponent(shareToken)}`)
      .then((payload) => {
        const sig = signatureText(me.signature);
        const sigHtml = signatureBlockHtml(me.signature);
        openCompose({
          subject: payload.subject,
          body: `${payload.body}${payload.body ? '\n\n' : ''}${sig}`,
          bodyHtml: `<p>${escapeHtml(payload.body).replace(/\n/g, '<br>')}</p><p><br></p>${sigHtml}`,
          attachments: payload.attachments ?? [],
        });
      })
      .catch(() => {/* token 過期/已用/非本人 → 靜默忽略，不打擾 */});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const replyToMsg = useCallback(
    (m: ThreadMessage, prefillText?: string, all?: boolean, useSelection = true) => {
      const doc = new DOMParser().parseFromString(m.html, 'text/html');
      const text = (doc.body.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim();
      // F5.5：閱讀窗若有選取段落 → 只引用該段（限本封 iframe）。AI 智慧回覆不吃選取（useSelection=false）。
      const selection = useSelection ? readReadpaneSelection(m.id) : '';
      const { quotedText: quoted, quoteHtml, fromSelection } = buildQuotedReply({ fullText: text, fullHtml: m.html, selection });
      const sig = signatureText(me.signature);
      const sigHtml = signatureBlockHtml(me.signature);
      const quoteIntro = `於 ${fullTime(m.ts)}，${m.from.name} 寫道${fromSelection ? '（節錄）' : ''}：`;
      // F3.1 全部回覆：cc = 原信所有收件人 ∪ cc，去掉自己與已在 to 的人；去重（純函式）
      const ccAll = all
        ? computeReplyAllCc({ to: m.to, cc: m.cc, fromAddr: m.from.addr, selfEmail: me.user.email, direction: m.direction }).join(', ')
        : '';
      openCompose({
        to: m.direction === 'outbound' ? m.to.join(', ') : m.from.addr,
        cc: ccAll,
        subject: m.subject.startsWith('Re:') ? m.subject : `Re: ${m.subject}`,
        body: `${prefillText ?? ''}${sig}\n\n${quoteIntro}\n${quoted}`,
        // 富文本引文：整封用原信 HTML（已消毒）；選取段落則用選取純文字（buildQuotedReply 已組好 blockquote）
        bodyHtml: `<p>${escapeHtml(prefillText ?? '')}</p><p><br></p>${sigHtml}<p>${escapeHtml(quoteIntro)}</p>${quoteHtml}`,
        replyToMessageId: m.id,
        // F2.7：原信情境 → 供 AI 改寫貼合（不寄出、不入草稿欄位）
        aiContext: `原信主旨「${m.subject}」。原信內容摘要：${text.slice(0, 500)}`,
        // F3.2：原信若標「需回信」，回覆寄出後自動清除其標記（專注佇列回一封消一封）
        replyClearStatus: m.status === 'needs_reply',
      });
    },
    [me.signature, me.user.email, openCompose],
  );

  // F3.1 轉發：把原信引在內文（不含原附件——附件需後端重新轉存，列為待議）；收件人留空。
  const forwardMsg = useCallback(
    (m: ThreadMessage) => {
      const doc = new DOMParser().parseFromString(m.html, 'text/html');
      const text = (doc.body.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim();
      const sig = signatureText(me.signature);
      const sigHtml = signatureBlockHtml(me.signature);
      const head = `---------- 轉寄郵件 ----------\n寄件者：${m.from.name} <${m.from.addr}>\n主旨：${m.subject}\n時間：${fullTime(m.ts)}`;
      openCompose({
        to: '',
        subject: m.subject.startsWith('Fwd:') ? m.subject : `Fwd: ${m.subject}`,
        body: `${sig}\n\n${head}\n\n${text}`,
        bodyHtml: `${sigHtml}<p>---------- 轉寄郵件 ----------</p><p>寄件者：${escapeHtml(m.from.name)} &lt;${escapeHtml(m.from.addr)}&gt;<br>主旨：${escapeHtml(m.subject)}<br>時間：${escapeHtml(fullTime(m.ts))}</p><blockquote>${stripQuoteMarks(m.html)}</blockquote>`,
        replyToMessageId: null,
      });
    },
    [me.signature, openCompose],
  );

  const hasDraftContent = useCallback(
    (d: ComposerDraft) =>
      !!(d.to.trim() || d.cc.trim() || d.bcc.trim() || d.subject.trim() || d.body.replace(me.signature ?? '', '').trim() ||
        d.attachments.length || (d.linkFiles?.length ?? 0)),
    [me.signature],
  );

  /* ---- 草稿自動儲存（每扇視窗各自停頓 1.5s 後 debounce；計時器由 DraftAutosave 持有） ---- */
  const runAutosave = useCallback(
    (winKey: string) => {
      const w = winsRef.current.find((x) => x.key === winKey);
      if (!w) return;
      const d = w.draft;
      const key = draftKey(d);
      if (!hasDraftContent(d) || lastSavedRef.current.get(winKey) === key) return;
      patchWin(winKey, { autosave: 'saving' });
      void (async () => {
        try {
          const hadRowId = !!d.draftRowId; // 已存在的草稿 → saveDraft 回同一 rowId，絕不可刪
          const id = await saveDraft(d);
          if (!winsRef.current.some((x) => x.key === winKey) && !hadRowId) {
            // 「全新草稿（原本無 rowId）」在儲存期間被送出/關閉 → 剛新建的列是孤兒 → 刪除。
            // 既有草稿（hadRowId）由 finalizeSend/closeComposer 自己收尾，這裡絕不碰，避免誤刪真草稿。
            void deleteDraft(id).then(() => {
              void qc.invalidateQueries({ queryKey: ['drafts'] });
              void qc.invalidateQueries({ queryKey: ['counts'] });
            });
            return;
          }
          lastSavedRef.current.set(winKey, key);
          patchWin(winKey, (cur) => (cur.draft.draftRowId ? { autosave: 'saved' } : { draft: { ...cur.draft, draftRowId: id }, autosave: 'saved' }));
          void qc.invalidateQueries({ queryKey: ['drafts'] });
          void qc.invalidateQueries({ queryKey: ['counts'] });
        } catch {
          patchWin(winKey, { autosave: 'idle' });
        }
      })();
    },
    [hasDraftContent, patchWin, qc],
  );

  const closeComposer = useCallback(async (winKey: string) => {
    const d = winsRef.current.find((x) => x.key === winKey)?.draft;
    const savedFingerprint = lastSavedRef.current.get(winKey);
    setWins((ws) => ws.filter((x) => x.key !== winKey));
    lastSavedRef.current.delete(winKey);
    if (!d) return;
    try {
      if (hasDraftContent(d) && draftKey(d) !== savedFingerprint) {
        await saveDraft(d);
        pushToast('草稿已儲存 ✏️');
      } else if (!hasDraftContent(d) && d.draftRowId) {
        await deleteDraft(d.draftRowId);
      }
      void qc.invalidateQueries({ queryKey: ['drafts'] });
      void qc.invalidateQueries({ queryKey: ['counts'] });
    } catch {
      pushToast('草稿儲存失敗');
    }
  }, [hasDraftContent, pushToast, qc]);

  const finalizeSend = useCallback(
    async (winKey: string, scheduleAt?: number, andArchive?: boolean) => {
      const d = winsRef.current.find((x) => x.key === winKey)?.draft;
      if (!d) return;
      // 撰寫防呆（寄前確認）：忘附件 + 收件人網域疑似拼錯
      if (looksLikeForgotAttachment(d.subject, d.body, d.attachments.length)) {
        if (!(await confirmDialog({
          title: '可能忘了附件',
          body: '看起來你提到了附件，但沒有附加任何檔案。仍要寄出嗎？',
          confirmText: '仍要寄出',
        }))) return;
      }
      const typos = detectDomainTypos([d.to, d.cc, d.bcc].flatMap((s) => s.split(/[,，;\s]+/)).filter(Boolean));
      if (typos.length) {
        const lines = typos.map((t) => `・${t.recipient} → ${t.suggested}`).join('\n');
        if (!(await confirmDialog({
          title: '收件人網域可能拼錯',
          body: `${lines}\n\n仍要照原樣寄出嗎？`,
          confirmText: '照原樣寄出',
        }))) return;
      }
      try {
        const res = await sendMutation.mutateAsync({ draft: d, scheduleAt: scheduleAt ?? null });
        const track = res.trackReply ? ' · 將追蹤回覆 🔔' : ''; // F2.3：問句信寄成後自動追蹤回覆（用「將」：排程/undo 時尚未建立）
        // F3.2：回覆「需回信」的信寄出 → 自動清掉該原信的工作流標記（專注佇列回一封消一封；靜默，不另跳 toast）
        if (d.replyClearStatus && d.replyToMessageId) {
          patchMsg.mutate({ id: d.replyToMessageId, patch: { status: null } });
          void qc.invalidateQueries({ queryKey: ['counts'] });
        }
        // F3.3：傳送並封存 → 寄成後把被回覆的原信移到封存（用 patchMsg 直接設 folder，避免引用稍後才宣告的 archiveMsg）
        if (andArchive && d.replyToMessageId) {
          patchMsg.mutate({ id: d.replyToMessageId, patch: { folder: 'archive' } });
          void qc.invalidateQueries({ queryKey: ['counts'] });
        }
        setWins((ws) => ws.filter((x) => x.key !== winKey));
        lastSavedRef.current.delete(winKey);
        if (d.draftRowId) {
          void deleteDraft(d.draftRowId).then(() => {
            void qc.invalidateQueries({ queryKey: ['drafts'] });
            void qc.invalidateQueries({ queryKey: ['counts'] });
          });
        }
        if (scheduleAt) {
          pushToast(`已排程：${fullTime(scheduleAt)} 寄出 ⏰${track}`);
          void qc.invalidateQueries({ queryKey: ['outbox'] });
          return;
        }
        const total = res.undoWindowSec;
        if (total <= 0) {
          pushToast(`已寄出 🐧${track}`);
          return;
        }
        // Undo toast 倒數環
        const toastId = Math.random().toString(36).slice(2);
        setToasts((ts) => [
          ...ts,
          {
            id: toastId,
            text: `已寄出 🐧${track}`,
            countdown: { total, left: total },
            action: { label: '復原', run: () => { haptics.impact(); void undoSendById(toastId, res.id, d); } },
          },
        ]);
        undoTimers.current[toastId] = setInterval(() => {
          setToasts((ts) =>
            ts.flatMap((x) => {
              if (x.id !== toastId || !x.countdown) return [x];
              const left = x.countdown.left - 1;
              if (left <= 0) {
                clearInterval(undoTimers.current[toastId]);
                delete undoTimers.current[toastId];
                setTimeout(() => {
                  void qc.invalidateQueries({ queryKey: ['messages'] });
                  void qc.invalidateQueries({ queryKey: ['counts'] });
                }, 2500);
                return [];
              }
              return [{ ...x, countdown: { ...x.countdown, left } }];
            }),
          );
        }, 1000);
      } catch (e) {
        // F7.3：明確離線（navigator.onLine=false）→ 存入待送匣、關閉撰寫窗，連線後手動補送；
        // 其餘（線上但伺服器/其他錯誤）維持原本「寄出失敗」提示，不入列（避免把可能已處理的請求重送）。
        if (!navigator.onLine) {
          const id = (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`);
          await enqueuePendingSend({ id, draft: d, scheduleAt: scheduleAt ?? null, andArchive: !!andArchive, queuedAt: Date.now() });
          setWins((ws) => ws.filter((x) => x.key !== winKey));
          lastSavedRef.current.delete(winKey);
          if (d.draftRowId) void deleteDraft(d.draftRowId).then(() => { void qc.invalidateQueries({ queryKey: ['drafts'] }); });
          refreshPending();
          rawToast('離線中，已存入待送匣 📭 連線後可補送'); // 關鍵提示：繞過連線窗抑制
        } else if (e instanceof ApiError) {
          pushToast(e.code === 'too_large' ? '超過 5 MiB 上限' : '寄出失敗，請再試一次');
        }
        // NetworkError（線上但逾時/斷線）→ 全域連線處理器已統一提示，這裡不重複彈
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sendMutation, pushToast, qc, patchMsg, refreshPending],
  );

  // F7.3：手動補送待送匣。逐封回放 send；成功才移除、失敗留著下次再補；中途又離線就停。
  const flushPending = useCallback(async () => {
    if (flushingOutbox) return;
    setFlushingOutbox(true);
    try {
      const items = await listPendingSends();
      let sent = 0;
      let failed = 0;
      for (const item of items) {
        if (!navigator.onLine) break; // 中途又離線 → 停，剩的留著
        // 已過期的排程降級為「立即寄」——否則 server 回 bad_schedule，永遠補不出去、卡死佇列。
        const sched = item.scheduleAt && item.scheduleAt > Date.now() ? item.scheduleAt : null;
        try {
          await sendMutation.mutateAsync({ draft: item.draft, scheduleAt: sched });
        } catch {
          failed++; // 送信本身失敗 → 留在佇列下次再補
          continue;
        }
        // 送成功 → 補做原本 finalizeSend 的回覆副作用（補送略過了一般送信路徑）
        if (item.draft.replyClearStatus && item.draft.replyToMessageId) {
          patchMsg.mutate({ id: item.draft.replyToMessageId, patch: { status: null } });
        }
        if (item.andArchive && item.draft.replyToMessageId) {
          patchMsg.mutate({ id: item.draft.replyToMessageId, patch: { folder: 'archive' } });
        }
        // 移除為 best-effort：刪失敗（罕見 IDB 錯誤）下次補送會再送一次＝已接受的重送邊界（無 client 冪等鍵）。
        try { await removePendingSend(item.id); } catch { /* 留著下次再刪/再送 */ }
        sent++;
      }
      refreshPending();
      if (sent) {
        void qc.invalidateQueries({ queryKey: ['messages'] });
        void qc.invalidateQueries({ queryKey: ['counts'] });
        pushToast(`已補送 ${sent} 封 🐧${failed ? `，${failed} 封仍未送` : ''}`);
      } else if (failed) {
        pushToast('補送失敗，請稍後再試');
      }
    } finally {
      setFlushingOutbox(false);
    }
  }, [flushingOutbox, sendMutation, refreshPending, qc, pushToast, patchMsg]);

  // 開機 + 連線狀態變化 → 刷新待送匣計數（回線後 banner 才冒出來）
  useEffect(() => { refreshPending(); }, [online, refreshPending]);

  const undoSendById = useCallback(
    async (toastId: string, sendId: string, snapshot: ComposerDraft) => {
      dismissToast(toastId);
      try {
        await cancelMutation.mutateAsync(sendId);
        openWin(snapshot, '__new__'); // 復原 → 開回一扇新視窗（不覆蓋其他正在寫的草稿）
        pushToast('已復原，信件未寄出');
      } catch {
        pushToast('來不及收回，信件已寄出');
      }
    },
    [cancelMutation, dismissToast, pushToast, openWin],
  );

  const openDraftRow = useCallback(
    (id: string) => {
      const row = drafts.data?.drafts.find((d) => d.id === id);
      if (!row) return;
      const d = rowToDraft(row);
      // 同一列草稿已經開著 → 聚焦既有視窗，絕不開第二扇：兩扇共用同一個 draftRowId 會互相蓋存檔。
      const already = winsRef.current.find((w) => w.draft.draftRowId === id);
      if (already) {
        focusWin(already.key);
        return;
      }
      // 新開一扇（key 唯一 → Composer 全新掛載，寄件身分選擇器會依還原的 fromAlias 初始化）。
      openWin(d, draftKey(d)); // 載入內容視為已儲存，避免立即回寫
    },
    [drafts.data, openWin, focusWin],
  );

  /* ---- F17.3：草稿依序寄出 ----
     後端零改動：就是對 N 封各呼叫既有的 /messages/send 帶遞增的 scheduleAt，
     取消／重試／failed 全部沿用現成的 send_queue 與 outbox。
     排程由每分鐘的 cron 撿件（wrangler.jsonc 的 * * * * *）→ 間隔粒度最細只能到分鐘。 */
  const batchSendDrafts = useCallback(
    async (intervalMin: number) => {
      if (me.isDemo) { pushToast('唯讀 Demo：無法寄信 🔒'); return; }
      const rows = (drafts.data?.drafts ?? []).filter((r) => draftSel.has(r.id));
      if (!rows.length) return;
      const willSend = rows.filter((r) => r.payload.to.trim()); // 沒收件人的會被 /send 擋成 400，先剔掉
      if (!willSend.length) { pushToast('選取的草稿都沒有收件人'); return; }
      // 寄前防呆只問一次：批次情境逐封跳對話框沒人受得了，所以把問題彙總成一則。
      const skipped = rows.length - willSend.length;
      const typos = detectDomainTypos(
        willSend.flatMap((r) => [r.payload.to, r.payload.cc ?? ''].flatMap((s) => s.split(/[,，;\s]+/))).filter(Boolean),
      );
      const firstAt = Date.now() + 60_000; // cron 每分鐘掃一次 → 第一封最快就是下一個整分
      const lastAt = firstAt + (willSend.length - 1) * intervalMin * 60_000;
      const warn = [
        skipped ? `・${skipped} 封沒有收件人，會略過` : '',
        typos.length ? `・收件人網域可能拼錯：${typos.map((t) => `${t.recipient} → ${t.suggested}`).join('、')}` : '',
      ].filter(Boolean).join('\n');
      if (!(await confirmDialog({
        title: `依序寄出 ${willSend.length} 封`,
        body: `${warn ? `${warn}\n\n` : ''}每 ${intervalMin} 分鐘一封：第一封約 ${fullTime(firstAt)}、最後一封約 ${fullTime(lastAt)}。\n排程後可在「寄件備份」逐封取消。`,
        confirmText: '開始排程',
      }))) return;
      setBatchSending(true);
      let ok = 0;
      const failed: string[] = [];
      for (let i = 0; i < willSend.length; i++) {
        const row = willSend[i];
        try {
          await sendMutation.mutateAsync({ draft: rowToDraft(row), scheduleAt: firstAt + i * intervalMin * 60_000 });
          ok++;
          void deleteDraft(row.id); // 已進 send_queue → 草稿列不再需要（取消要去 outbox）
        } catch {
          // Hon 2026-09-19 裁定的失敗語意：照排下去，不因一封失敗中斷整批。
          failed.push(row.payload.subject || '（無主旨）');
        }
      }
      setBatchSending(false);
      setDraftSel(new Set());
      setWatchOutboxUntil(lastAt + 5 * 60_000); // 盯到最後一封寄出後 5 分鐘
      void qc.invalidateQueries({ queryKey: ['drafts'] });
      void qc.invalidateQueries({ queryKey: ['counts'] });
      void qc.invalidateQueries({ queryKey: ['outbox'] });
      pushToast(
        failed.length
          ? `已排程 ${ok} 封，最後一封約 ${fullTime(lastAt)}；${failed.length} 封沒排進去（${failed.join('、')}）`
          : `已排程 ${ok} 封，最後一封約 ${fullTime(lastAt)} 寄出 ⏰`,
      );
    },
    [drafts.data, draftSel, me.isDemo, pushToast, qc, sendMutation],
  );

  const deleteDraftRow = useCallback(
    async (id: string) => {
      await deleteDraft(id);
      void qc.invalidateQueries({ queryKey: ['drafts'] });
      void qc.invalidateQueries({ queryKey: ['counts'] });
      pushToast('草稿已刪除');
    },
    [qc, pushToast],
  );

  /* ---- 信件操作 ---- */
  const openMsg = useCallback(
    (id: string) => {
      const apply = () => { setSelectedId(id); setCursorId(id); };
      const item = items.find((m) => m.id === id);
      // F6.1：手機單欄 list→read「主旨」共享元素 morph（VT named）。降級保底——非手機/motion off/不支援 → 直接套用（不影響功能）。
      const mobile = typeof window !== 'undefined' && !!window.matchMedia?.('(max-width: 920px)').matches;
      const motionOn = document.documentElement.getAttribute('data-motion') === 'on';
      const startVT = (document as Document & { startViewTransition?: (cb: () => void) => TransitionLike }).startViewTransition;
      if (mobile && motionOn && typeof startVT === 'function') {
        try {
          flushSync(() => setMorphId(id)); // 同步：OLD 快照讓被點 .msg-subject 拿到 vt name
          const t = startVT.call(document, () => flushSync(apply)); // NEW 快照：.read-subject 拿到同名 → 瀏覽器 morph
          ignoreSkippedTransition(t); // 連續換信被略過不是錯誤
          void t.finished?.finally(() => setMorphId(null)); // 收尾移除 name（成敗皆清，避免殘留）
        } catch {
          setMorphId(null); // VT 起不來 → 清旗標 + 退回直接套用，確保開信絕不失敗
          apply();
        }
      } else if (!mobile && motionOn && typeof startVT === 'function') {
        // F14.4C：桌機開信——讀信區（named readpane-content）crossfade/morph 過場，不設 morphId 避免主旨名衝突。
        try {
          ignoreSkippedTransition(startVT.call(document, () => flushSync(apply))); // j/k 連續換信被略過不是錯誤
        } catch {
          apply(); // VT 起不來 → 直接套用，開信絕不失敗
        }
      } else {
        apply();
      }
      // demo 唯讀：不送標已讀 PATCH（會被伺服器 403，且造成「已讀彈回未讀」閃爍）
      if (item?.unread && !me.isDemo) patchMsg.mutate({ id, patch: { unread: false } });
    },
    [items, patchMsg, me.isDemo],
  );

  const selectNextAfter = useCallback(
    (id: string) => {
      const idx = items.findIndex((m) => m.id === id);
      const next = items[idx + 1] ?? items[idx - 1] ?? null;
      setSelectedId(next ? next.id : null);
      setCursorId(next ? next.id : null);
    },
    [items],
  );

  // 從其他視圖（行事曆/跟進/推播深連結）跳到收件匣並開啟指定信件。
  // 直接 setViewRaw（不走 setView 的 View Transition 延後套用，否則其 apply() 會把 selectedId 清回 null）。
  const openMessageById = useCallback((id: string) => {
    setViewRaw({ type: 'folder', folder: 'inbox' });
    setQuery('');
    setInboxCategory('primary');
    setDrawerOpen(false);
    setSelectedSet(new Set());
    setSelectedId(id);
    setCursorId(id);
  }, []);

  // F20.1：登入態進到 app 之後，把已經用不到的邀請／救援參數從網址清掉。
  // 原本只有 InviteFlow／RecoverFlow 的回呼會清（上面的 onDone／onBack），而那兩條路只有
  // 「登出狀態下走完流程」才會經過——已註冊的人每次開 app 都是走 /auth/me 成功 → setScreen('app')，
  // 於是 #invite=<碼> 會**永遠**留在網址列（2026-09-20 Hon 回報）。
  // 這不只是難看：邀請碼常駐網址列，等於每次分享畫面或截圖都把它外流一次。
  // 只清 invite／recover 兩個鍵——#msg-<id> 推播深連結由它自己的 effect 負責（就在下面）。
  // 這個 effect 在 MailShell 裡，而 MailShell 只有登入後才掛載，所以不需要再判斷登入狀態。
  //（第一版寫了 `if (screen !== 'app')`，但 React 的 screen state 不在這個作用域——那個識別字會
  // 解析到全域的 window.screen，在 JS 裡會恆真而靜默失效。typecheck 抓到了。）
  useEffect(() => {
    const p = new URLSearchParams(location.hash.slice(1));
    if (!p.has('invite') && !p.has('recover')) return;
    history.replaceState(null, '', location.pathname + location.search);
  }, []);

  // 跟進提醒推播深連結：/#msg-<id>（含冷啟動開窗與既有視窗 hashchange）→ 開啟該信
  useEffect(() => {
    const openFromHash = () => {
      const m = /^#msg-([a-z0-9_]+)$/i.exec(location.hash);
      if (!m) return;
      // 先清掉 hash，避免重整 / 返回時重複觸發
      history.replaceState(null, '', location.pathname + location.search);
      openMessageById(m[1]);
    };
    openFromHash();
    window.addEventListener('hashchange', openFromHash);
    return () => window.removeEventListener('hashchange', openFromHash);
  }, [openMessageById]);

  const toggleStar = useCallback(
    (m: MsgListItem | ThreadMessage) => {
      patchMsg.mutate({ id: m.id, patch: { starred: !m.starred } });
      void qc.invalidateQueries({ queryKey: ['thread', selectedId] });
      if (!m.starred) {
        setBouncingStarId(m.id);
        setTimeout(() => setBouncingStarId((cur) => (cur === m.id ? null : cur)), 340);
      }
    },
    [patchMsg, qc, selectedId],
  );

  // 工作流通道（需回信/等待中）：原地標記，不移出視圖；counts 由 patchMsg onSettled 刷新。
  const setStatus = useCallback(
    (m: { id: string }, status: 'needs_reply' | 'waiting' | null) => {
      patchMsg.mutate({ id: m.id, patch: { status } });
      void qc.invalidateQueries({ queryKey: ['thread', selectedId] });
      pushToast(status === 'needs_reply' ? '已標記需回信 ↩️' : status === 'waiting' ? '已標記等待中 ⏳' : '已清除工作流標記');
    },
    [patchMsg, qc, selectedId, pushToast],
  );
  const togglePin = useCallback(
    (m: { id: string; pinned: boolean }) => {
      patchMsg.mutate({ id: m.id, patch: { pinned: !m.pinned } });
      void qc.invalidateQueries({ queryKey: ['thread', selectedId] });
      pushToast(!m.pinned ? '已釘選 📌' : '已取消釘選');
    },
    [patchMsg, qc, selectedId, pushToast],
  );

  // 封存/刪除/垃圾信：退場動畫 + 通用復原 toast
  const moveTo = useCallback(
    (m: { id: string }, toFolder: string, toastText: string) => {
      const fromFolder = view.type === 'folder' && view.folder !== 'starred' ? view.folder : 'inbox';
      selectNextAfter(m.id);
      setLeavingIds((s) => new Set(s).add(m.id));
      setTimeout(() => {
        patchMsg.mutate({ id: m.id, patch: { folder: toFolder } });
        setLeavingIds((s) => {
          const n = new Set(s);
          n.delete(m.id);
          return n;
        });
      }, 220);
      pushToast(toastText, {
        action: {
          label: '復原',
          run: () => {
            patchMsg.mutate({ id: m.id, patch: { folder: fromFolder } });
            void qc.invalidateQueries({ queryKey: ['messages'] });
            void qc.invalidateQueries({ queryKey: ['counts'] });
          },
        },
      });
    },
    [view, selectNextAfter, patchMsg, pushToast, qc],
  );

  const archiveMsg = useCallback((m: { id: string }) => moveTo(m, 'archive', '已封存 📦'), [moveTo]);
  const moveToInbox = useCallback((m: { id: string }) => moveTo(m, 'inbox', '已移到收件匣 📥'), [moveTo]);
  const deleteMsg = useCallback((m: { id: string }) => moveTo(m, 'trash', '已移至垃圾桶 🗑️'), [moveTo]);
  const spamMsg = useCallback((m: { id: string }) => moveTo(m, 'spam', '已回報為垃圾信'), [moveTo]);

  // 手動移到其他收件匣分類（主要/社交/促銷/通知）：退場動畫 + 樂觀移出當前分頁
  const moveToCategory = useCallback(
    (m: { id: string }, cat: InboxCategory) => {
      selectNextAfter(m.id);
      setLeavingIds((s) => new Set(s).add(m.id));
      setTimeout(() => {
        patchMsg.mutate({ id: m.id, patch: { category: cat } });
        setLeavingIds((s) => {
          const n = new Set(s);
          n.delete(m.id);
          return n;
        });
      }, 220);
      pushToast(`已移到「${CATEGORY_LABEL[cat]}」分類`);
    },
    [selectNextAfter, patchMsg, pushToast],
  );

  const snoozeMsg = useCallback(
    (id: string, until: number) => {
      selectNextAfter(id);
      setLeavingIds((s) => new Set(s).add(id));
      setTimeout(() => {
        patchMsg.mutate({ id, patch: { snoozedUntil: until } });
        setLeavingIds((s) => {
          const n = new Set(s);
          n.delete(id);
          return n;
        });
      }, 220);
      pushToast(`已貪睡到 ${fullTime(until)} 💤`, {
        action: {
          label: '復原',
          run: () => {
            patchMsg.mutate({ id, patch: { snoozedUntil: null } });
            void qc.invalidateQueries({ queryKey: ['messages'] });
            void qc.invalidateQueries({ queryKey: ['counts'] });
          },
        },
      });
    },
    [selectNextAfter, patchMsg, pushToast, qc],
  );

  const translateMsg = useCallback(
    (id: string) => {
      translateMutation.mutate(id, {
        onError: (err) => {
          const p = (err as { payload?: { reason?: string; detail?: string } })?.payload;
          if (p?.reason === 'quota') pushToast('AI 今日免費額度可能已用完，明天再試 🪫');
          else pushToast(`翻譯失敗：${p?.detail ?? '請稍後再試'}`);
        },
      });
    },
    [translateMutation, pushToast],
  );

  const downloadAttachment = useCallback((att: { id: string; filename: string }) => {
    const a = document.createElement('a');
    a.href = `/api/v1/attachments/${att.id}`;
    a.download = att.filename;
    a.click();
  }, []);

  const downloadRaw = useCallback((id: string) => {
    const a = document.createElement('a');
    a.href = `/api/v1/messages/${id}/raw`;
    a.click();
  }, []);

  const previewAttachment = useCallback(
    (att: LightboxAtt) => {
      if (att.mimeType.startsWith('image/') || att.mimeType === 'application/pdf') setLightbox(att);
      else downloadAttachment(att);
    },
    [downloadAttachment],
  );

  const generateAi = useCallback(
    (id: string) => {
      aiMutation.mutate(id, {
        onError: (err) => {
          const p = (err as { payload?: { reason?: string; detail?: string } })?.payload;
          if (p?.reason === 'quota') pushToast('AI 今日免費額度可能已用完，明天再試 🪫');
          else pushToast(`AI 摘要失敗：${p?.detail ?? '請稍後再試'}`);
        },
      });
    },
    [aiMutation, pushToast],
  );

  const smartReply = useCallback(
    (m: ThreadMessage, text: string) => replyToMsg(m, `${text}\n`, false, false), // AI 智慧回覆：不吃閱讀窗選取
    [replyToMsg],
  );

  const onUnsubscribe = useCallback(
    (m: ThreadMessage) => {
      const u = m.unsubscribe;
      if (!u) return;
      if (u.oneClick) {
        // 一鍵退訂：伺服器代送 RFC 8058 POST
        unsubscribeMutation.mutate(m.id, {
          onSuccess: (r) => pushToast(r.ok ? '已送出退訂 ✅' : '退訂請求未成功，可改用寄件者頁面退訂'),
          onError: () => pushToast('退訂失敗，請再試一次'),
        });
      } else if (u.httpUrl) {
        window.open(u.httpUrl, '_blank', 'noopener,noreferrer');
      } else if (u.mailto) {
        window.location.href = u.mailto;
      }
    },
    [unsubscribeMutation, pushToast],
  );

  // 封鎖寄件者：建一條「寄件者含此地址 → 垃圾信」規則（套用於日後來信），並把目前這封移到垃圾信
  const blockSenderMutation = useBlockSender();
  const onBlockSender = useCallback(
    (m: ThreadMessage) => {
      const addr = m.from.addr;
      if (!addr) return;
      blockSenderMutation.mutate(
        { name: `封鎖 ${addr}`, value: addr },
        {
          // 規則建立成功才把當前信移垃圾信，避免「規則沒建成卻已移信」的不一致
          onSuccess: () => {
            spamMsg(m);
            pushToast(`已封鎖 ${addr}，日後來信自動進垃圾信 🚫`);
          },
          onError: () => pushToast('封鎖失敗，請再試一次'),
        },
      );
    },
    [blockSenderMutation, spamMsg, pushToast],
  );

  // 跟進提醒（稍後跟進 / 寄出等回覆）
  const followupMutation = useSetFollowup();
  const followupMsg = useCallback(
    (id: string, dueAt: number, awaitReply: boolean) => {
      followupMutation.mutate(
        { id, dueAt, awaitReply },
        {
          onSuccess: () =>
            pushToast(
              awaitReply ? `已設定：${fullTime(dueAt)} 若仍無回覆會提醒你 🚩` : `已設定跟進：${fullTime(dueAt)} 提醒你 🚩`,
            ),
          onError: () => pushToast('設定跟進失敗，請再試一次'),
        },
      );
    },
    [followupMutation, pushToast],
  );

  // F2.4：AI 從信件抽到的「加入行事曆」/「設為跟進」一鍵晶片
  const aiAddEvent = useCallback(
    (ev: { summary: string; startMs: number; endMs: number; location?: string }): Promise<boolean> =>
      api('/calendar/invite', {
        method: 'POST',
        body: { summary: ev.summary, attendees: [], startMs: ev.startMs, endMs: ev.endMs, ...(ev.location ? { location: ev.location } : {}), recurrence: 'none', reminderMin: 15 },
      })
        .then(() => {
          pushToast('已加入行事曆 📅');
          void qc.invalidateQueries({ queryKey: ['calendar'] });
          void qc.invalidateQueries({ queryKey: ['agenda'] });
          return true;
        })
        .catch(() => {
          pushToast('加入行事曆失敗，請再試一次');
          return false;
        }),
    [pushToast, qc],
  );
  const aiTrackTodo = useCallback(
    (msgId: string) => {
      const d = new Date();
      d.setDate(d.getDate() + 1);
      d.setHours(9, 0, 0, 0); // 預設明早 9 點提醒（可在跟進頁改）
      followupMsg(msgId, d.getTime(), false);
    },
    [followupMsg],
  );

  // 靜音 / 取消靜音對話串
  const muteMutation = useMute();
  const onToggleMute = useCallback(
    (m: ThreadMessage, muted: boolean) => {
      muteMutation.mutate(
        { id: m.id, muted },
        { onSuccess: () => pushToast(muted ? '已靜音對話串，日後新信自動封存 🔕' : '已取消靜音') },
      );
    },
    [muteMutation, pushToast],
  );

  const retrySend = useCallback(
    (id: string) => {
      retryMutation.mutate(id, {
        onSuccess: () => pushToast('已重新排入寄送佇列'),
        onError: () => pushToast('重寄失敗'),
      });
    },
    [retryMutation, pushToast],
  );

  const cancelScheduled = useCallback(
    (id: string) => {
      void cancelMutation.mutateAsync(id).then(
        () => {
          void qc.invalidateQueries({ queryKey: ['outbox'] });
          pushToast('排程已取消');
        },
        () => pushToast('已開始寄送，無法取消'),
      );
    },
    [cancelMutation, qc, pushToast],
  );

  const resolveSend = useCallback(
    (id: string, decision: 'resend' | 'sent' | 'discard') => {
      resolveMutation.mutate(
        { id, decision },
        {
          onSuccess: () =>
            pushToast(
              decision === 'resend'
                ? '已重新寄出 📤'
                : decision === 'sent'
                  ? '已標記為送達，補上寄件備份'
                  : '已放棄這封外送',
            ),
          onError: () => pushToast('操作失敗，請再試一次'),
        },
      );
    },
    [resolveMutation, pushToast],
  );

  const logout = useCallback(async () => {
    try {
      // F5：先撤本機的 push 訂閱（此時 session 仍有效），再登出——否則這台瀏覽器登出後
      // 仍會為每封新信跳出寄件者＋主旨。best-effort，內部吞掉所有錯誤，不影響登出。
      await releasePushSubscription();
      await api('/auth/logout', { body: {} });
    } finally {
      qc.clear();
      onLoggedOut();
    }
  }, [qc, onLoggedOut]);

  const selected = useMemo(() => items.find((m) => m.id === selectedId) ?? null, [items, selectedId]);
  const replyTarget = useMemo(() => {
    const list = thread.data?.thread ?? [];
    return list.find((m) => m.id === selectedId) ?? list[list.length - 1] ?? null;
  }, [thread.data, selectedId]);
  const isContentView =
    view.type === 'settings' || view.type === 'admin' || view.type === 'contacts' || view.type === 'files' ||
    view.type === 'calendar' || view.type === 'followups' || view.type === 'agenda';

  /** F17.1：鍵盤焦點所指的那扇撰寫視窗（展開中、最近互動者）；沒有展開的就是 null。 */
  const expandedWin = useMemo(
    () => wins.filter((w) => !w.minimized).sort((a, b) => b.activeAt - a.activeAt)[0] ?? null,
    [wins],
  );
  /** 內嵌回覆的掛載點一次只能給一扇：取「展開中且正在回覆目前選取那封信」的第一扇。 */
  const inlineWinKey = useMemo(() => {
    if (isContentView || isDraftsView || !replyMount || !selectedId) return null;
    return wins.find((w) => !w.minimized && w.draft.replyToMessageId === selectedId)?.key ?? null;
  }, [wins, isContentView, isDraftsView, replyMount, selectedId]);
  /**
   * F17.2：並排槽位。slot 0 最靠右（＝單扇時的原位置），slot 1 在它左邊。
   * 內嵌回覆那扇要排除——它是 position:relative 停在閱讀窗格裡，不佔右下角的浮動槽位，
   * 若把它算進去會讓真正浮動的那扇平白往左偏一格。
   */
  const expandedKeys = useMemo(
    () => wins.filter((w) => !w.minimized && w.key !== inlineWinKey).map((w) => w.key),
    [wins, inlineWinKey],
  );

  /* ---- ⌘K 指令面板動作 ---- */
  const paletteActions = useMemo<PaletteAction[]>(() => {
    const acts: PaletteAction[] = [
      { id: 'compose', name: '寫信', hint: 'c', icon: 'pen', run: () => openCompose() },
      // F2.6：搜尋所有信件/聯絡人/會議/跟進 → 切到收件匣並聚焦搜尋框
      { id: 'search-all', name: '搜尋所有（信件 / 聯絡人 / 會議 / 跟進）', hint: '/', icon: 'search', run: () => { setView({ type: 'folder', folder: 'inbox' }); setTimeout(() => searchRef.current?.focus(), 60); } },
      ...FOLDERS.map((f) => ({
        id: `go-${f.id}`,
        name: `前往 ${f.name}`,
        hint: f.id === 'inbox' ? 'g i' : f.id === 'starred' ? 'g s' : f.id === 'drafts' ? 'g d' : undefined,
        icon: f.icon,
        run: () => setView({ type: 'folder', folder: f.id }),
      })),
      ...(counts.data?.labels ?? []).map((l) => ({
        id: `label-${l.id}`,
        name: `標籤：${l.name}`,
        icon: 'tag' as const,
        run: () => setView({ type: 'label', id: l.id }),
      })),
      { id: 'agenda', name: '今日', icon: 'clock', run: () => setView({ type: 'agenda' }) },
      { id: 'calendar', name: '行事曆', icon: 'clock', run: () => setView({ type: 'calendar' }) },
      { id: 'followups', name: '跟進', icon: 'flag', run: () => setView({ type: 'followups' }) },
      { id: 'contacts', name: '聯絡人', icon: 'user', run: () => setView({ type: 'contacts' }) },
      { id: 'files', name: '檔案', hint: 'g f', icon: 'clip', run: () => setView({ type: 'files' }) },
      { id: 'settings', name: '設定', icon: 'settings', run: () => setView({ type: 'settings' }) },
      ...(me.user.role === 'admin'
        ? [{ id: 'admin', name: '管理後台', icon: 'shield' as const, run: () => setView({ type: 'admin' }) }]
        : []),
      {
        id: 'theme',
        name: '切換深色／亮色模式',
        icon: 'moon',
        run: () => {
          const cur = document.documentElement.getAttribute('data-theme');
          setThemePrefs({ theme: cur === 'dark' ? 'light' : 'dark' });
        },
      },
      { id: 'search', name: '聚焦搜尋', hint: '/', icon: 'search', run: () => searchRef.current?.focus() },
      { id: 'meeting', name: '新會議邀請', icon: 'clock', run: () => setMeetingOpen(true) },
      { id: 'ai-compose', name: 'AI 草擬信件', icon: 'sparkle', run: () => setAiComposeOpen(true) },
      { id: 'ask-mail', name: '問信箱（AI 從你的信裡找答案）', icon: 'sparkle', run: () => setAskOpen(true) },
      { id: 'encrypt-link', name: '建立加密訊息連結', icon: 'shield', run: () => setEncrypt({}) },
      { id: 'kbd', name: '鍵盤快捷鍵', hint: '?', icon: 'keyboard', run: () => setShowKbd(true) },
    ];
    return acts;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [counts.data, me.user.role, openCompose]);

  /* ---- 鍵盤快捷鍵 ---- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const tag = target.tagName?.toLowerCase();
      const typing = tag === 'input' || tag === 'textarea' || target.isContentEditable;
      // ⌘K / Ctrl+K：指令面板（任何情境可開）
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setShowPalette((v) => !v);
        return;
      }
      if (e.key === 'Escape') {
        if (quickPick) setQuickPick(null);
        else if (showPalette) setShowPalette(false);
        else if (lightbox) setLightbox(null);
        else if (showKbd) setShowKbd(false);
        else if (drawerOpen) setDrawerOpen(false);
        else if (expandedWin) void closeComposer(expandedWin.key);
        else if (typing) target.blur();
        else if (selectedId) setSelectedId(null);
        return;
      }
      // 草稿最小化成 chip 時，列表快捷鍵照常運作
      if (typing || expandedWin || showPalette || quickPick || e.metaKey || e.ctrlKey || e.altKey) return;
      // g 系列：g+i 收件匣 / g+s 星標 / g+d 草稿（1.2 秒內接續）
      if (e.key === 'g') {
        gPendingRef.current = Date.now();
        return;
      }
      if (gPendingRef.current && Date.now() - gPendingRef.current < 1200) {
        gPendingRef.current = 0;
        const go: Record<string, string> = { i: 'inbox', s: 'starred', d: 'drafts', a: 'archive', t: 'trash' };
        if (go[e.key]) {
          e.preventDefault();
          setView({ type: 'folder', folder: go[e.key] });
          return;
        }
        if (e.key === 'f') {
          e.preventDefault();
          setView({ type: 'files' });
          return;
        }
        if (e.key === 'y') {
          e.preventDefault();
          setView({ type: 'agenda' });
          return;
        }
      }
      const ci = items.findIndex((m) => m.id === (cursorId ?? selectedId));
      switch (e.key) {
        case 'j':
        case 'k': {
          e.preventDefault();
          const ni = e.key === 'j' ? Math.min(ci + 1, items.length - 1) : Math.max(ci - 1, 0);
          if (items[ni]) openMsg(items[ni].id);
          break;
        }
        case 'r':
          if (replyTarget) { e.preventDefault(); replyToMsg(replyTarget); }
          break;
        case 'R': // Shift+R：全部回覆
          if (replyTarget) { e.preventDefault(); replyToMsg(replyTarget, undefined, true); }
          break;
        case 'f': // 轉發開啟中的信（需完整內文 → 用 replyTarget）
          if (replyTarget) { e.preventDefault(); forwardMsg(replyTarget); }
          break;
        case 'e':
          if (selected) { e.preventDefault(); archiveMsg(selected); }
          break;
        case 'x': { // 勾選游標所在信（沿用批次狀態機）
          const cur = items[ci];
          if (cur) { e.preventDefault(); toggleSelect(cur.id, false); }
          break;
        }
        case 'X': { // Shift+X：自上次勾選/點選到游標範圍勾選（沿用 toggleSelect 的 shift 範圍邏輯）
          const cur = items[ci];
          if (cur) { e.preventDefault(); toggleSelect(cur.id, true); }
          break;
        }
        case 'l': { // 加標籤快選
          const cur = items[ci];
          if (!cur) break;
          e.preventDefault();
          const labels = Object.values(labelsById);
          if (!labels.length) { pushToast('還沒有任何標籤'); break; }
          setQuickPick(labels.map((l) => ({ id: `lbl-${l.id}`, name: `標籤：${l.name}`, icon: 'tag' as const, run: () => { batchMutation.mutate({ ids: [cur.id], addLabelId: l.id }); pushToast(`已套用標籤「${l.name}」🏷️`); } })));
          break;
        }
        case 'v': { // 移到資料夾快選
          const cur = items[ci];
          if (!cur) break;
          e.preventDefault();
          const dests = [
            { folder: 'inbox', name: '收件匣', icon: 'inbox' as const },
            { folder: 'archive', name: '封存', icon: 'archive' as const },
            { folder: 'spam', name: '垃圾信', icon: 'spam' as const },
            { folder: 'trash', name: '垃圾桶', icon: 'trash' as const },
          ];
          setQuickPick(dests.map((d) => ({ id: `mv-${d.folder}`, name: `移到：${d.name}`, icon: d.icon, run: () => moveTo({ id: cur.id }, d.folder, `已移到「${d.name}」`) })));
          break;
        }
        case '[':
        case ']': { // 封存游標所在信並跳上一封/下一封（Gmail 風）
          const cur = items[ci];
          if (!cur) break;
          e.preventDefault();
          const ni = e.key === ']' ? ci + 1 : ci - 1;
          archiveMsg(cur);
          if (items[ni]) openMsg(items[ni].id);
          break;
        }
        case 's':
          if (selected) { e.preventDefault(); toggleStar(selected); }
          break;
        case '#':
          if (selected) { e.preventDefault(); deleteMsg(selected); }
          break;
        case 'c':
          e.preventDefault();
          // 有停駐中的草稿 → 先還原最近開的那扇（不覆蓋）；都沒有才開新的一扇
          if (wins.length) focusWin(wins[wins.length - 1].key);
          else openCompose();
          break;
        case '/':
          e.preventDefault();
          searchRef.current?.focus();
          break;
        case '?':
          e.preventDefault();
          setShowKbd(true);
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div
      className={`shell ${!isContentView && !isDraftsView ? 'mail-workspace' : ''} ${isContentView ? 'wide-main' : ''} ${drawerOpen ? 'drawer-open' : ''} ${selectedId && !isContentView ? 'read-open' : ''} ${me.isDemo ? 'demo-shift' : ''}`}>
      {drawerOpen && <button className="drawer-backdrop" aria-label="關閉選單" onClick={() => setDrawerOpen(false)}></button>}
      {me.isDemo && (
        <div className="offline-banner demo-banner" role="status">
          <Icon name="shield" size={13} /> {dt('唯讀 Demo · 你可以自由參觀，但無法寄信或變更任何資料', 'Read-only demo · Look around freely — you can’t send mail or change any data')}
        </div>
      )}
      {!online && (
        <div className="offline-banner" role="status">
          <Icon name="globe" size={13} /> 離線模式 · 顯示已快取的郵件（無法收發新信）
        </div>
      )}
      {online && pendingSends > 0 && (
        // F7.3：回線後提示離線時寫的待送信，手動補送（不自動背景送 → 不會雙寄）
        <div className="offline-banner pending-banner" role="status">
          <Icon name="send" size={13} /> 有 {pendingSends} 封離線時寫的信待送
          <button type="button" className="pending-flush-btn" onClick={() => void flushPending()} disabled={flushingOutbox}>
            {flushingOutbox ? '補送中…' : '補送'}
          </button>
        </div>
      )}
      {canInstallNow && (
        // F7.5：Android/桌面 A2HS 自訂安裝引導（iOS 不觸發 beforeinstallprompt → 不顯示，走既有加主畫面引導）
        <div className="install-banner" role="status">
          <Pori pose="happy" size={32} />
          <span>把 Miseroda 安裝到主畫面，開信更快、可離線閱讀</span>
          <button type="button" className="install-btn" onClick={() => void promptInstall()}>安裝</button>
          <button type="button" className="install-dismiss" aria-label="不再提示" onClick={dismissInstall}><Icon name="x" size={14} /></button>
        </div>
      )}
      <Sidebar view={view} setView={setView} counts={counts.data} me={me} onCompose={() => openCompose()} onNewMeeting={() => setMeetingOpen(true)}
        onDropLabel={(labelId, messageId) => {
          batchMutation.mutate({ ids: [messageId], addLabelId: labelId });
          pushToast(`已套用標籤「${labelsById[labelId]?.name ?? ''}」🏷️`);
        }}
        query={query} onRunSavedSearch={runSavedSearch} />
      {/* 方案 C：鈴鐺與帳號 chip 收進共同的 fixed 容器（見 .topright-actions），
          順序維持不變——鈴鐺在左、頭像在右 */}
      <div className="topright-actions">
        <NotifBell followups={followupsQ.data?.followups} needsReply={counts.data?.needsReply} userId={me.user.id}
          onOpenMessage={(id) => { setView({ type: 'folder', folder: 'inbox' }); openMsg(id); }}
          onGotoFollowups={() => setView({ type: 'followups' })} />
        <UserMenu me={me} onMeChanged={onRefreshMe} onLogout={() => void logout()}
          onShowKbd={() => setShowKbd(true)} pushToast={pushToast} />
      </div>
      {!isContentView && !isDraftsView && <header className="mail-topbar" ref={setSearchHost} />}
      {!isContentView && isDraftsView && (
        <DraftsList drafts={drafts.data?.drafts ?? []} onOpen={openDraftRow}
          onDelete={(id) => void deleteDraftRow(id)} onMenu={() => setDrawerOpen(true)} loading={drafts.isLoading}
          selected={draftSel} batchSending={batchSending}
          onToggleSelect={(id) => setDraftSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; })}
          onClearSelect={() => setDraftSel(new Set())}
          onBatchSend={(min) => void batchSendDrafts(min)} />
      )}
      {!isContentView && !isDraftsView && (
        <MessageList items={items} view={view} query={query} setQuery={setQuery} morphId={morphId}
          onRefresh={() => Promise.all([messages.refetch(), counts.refetch()])}
          onPrefetch={prefetchThread} pushToast={pushToast}
          selectedId={selectedId} cursorId={cursorId} onOpen={openMsg} onToggleStar={toggleStar}
          inboxCategory={inboxCategory} onSelectCategory={setInboxCategory} categoryCounts={counts.data?.inboxCategories}
          glance={counts.data ? { unread: counts.data.folders.inbox?.unread ?? 0, needsReply: counts.data.needsReply ?? 0, bills: counts.data.inboxCategories.promotions?.unread ?? 0 } : undefined}
          labelsById={labelsById} contactNames={contactNames} searchRef={searchRef} searchHost={searchHost} onMenu={() => setDrawerOpen(true)}
          loading={messages.isLoading} leavingIds={leavingIds} bouncingStarId={bouncingStarId}
          hasMore={messages.hasNextPage} loadingMore={messages.isFetchingNextPage}
          onLoadMore={() => { if (messages.hasNextPage && !messages.isFetchingNextPage) void messages.fetchNextPage(); }}
          outbox={isSentView ? outbox.data?.items ?? [] : []} onRetrySend={retrySend} onCancelScheduled={cancelScheduled} onResolveSend={resolveSend}
          onSwipeArchive={(id) => archiveMsg({ id })} onSwipeTrash={(id) => deleteMsg({ id })}
          onSnooze={snoozeMsg} onSpam={(id) => spamMsg({ id })}
          onAddLabel={(id, labelId) => { batchMutation.mutate({ ids: [id], addLabelId: labelId }); pushToast(`已套用標籤「${labelsById[labelId]?.name ?? ''}」🏷️`); }}
          onComposeTo={(email) => openCompose({ to: email })} onGotoCalendar={() => setView({ type: 'calendar' })} onGotoFollowups={() => setView({ type: 'followups' })}
          onBatchByView={(v, action) => void batchByView.mutateAsync({ view: v, action })
            .then((r) => pushToast(`已${action === 'read' ? '標記已讀' : '封存'} ${r.changes} 封`))
            .catch(() => pushToast('操作失敗'))}
          onRouteNewslettersOut={() => {
            if (routeNewslettersOut.isPending) return; // 防連點併發建立重複規則（Codex LOW）
            void routeNewslettersOut.mutateAsync()
              .then((r) => pushToast(r.already ? '已設定過：電子報自動移出主收件匣' : '已設定：新電子報自動歸檔、不進主收件匣（仍在此視圖）'))
              .catch(() => pushToast('設定失敗，請再試一次'));
          }}
          batch={{
            selected: selectedSet,
            onToggleSelect: toggleSelect,
            onSelectAll: selectAll,
            onClearSelect: clearSelect,
            onBatchArchive: () => runBatch({ patch: { folder: 'archive' } }, `已封存 ${selectedSet.size} 封 📦`),
            onBatchTrash: () => runBatch({ patch: { folder: 'trash' } }, `已刪除 ${selectedSet.size} 封 🗑️`),
            onBatchRead: (read) => runBatch({ patch: { unread: !read } }, read ? '已標為已讀' : '已標為未讀'),
            onBatchStar: (starred) => runBatch({ patch: { starred } }, '已加星標'),
          }} />
      )}
      {!isContentView && !isDraftsView && (
        <ReadingPane onReplyMount={setReplyMount} onOpenMessage={setSelectedId} thread={thread.data?.thread ?? []} muted={thread.data?.muted ?? false} selectedId={selectedId} labelsById={labelsById}
          contactNames={contactNames}
          onArchive={archiveMsg} onMoveToInbox={moveToInbox} onDelete={deleteMsg} onSpam={spamMsg} onToggleStar={toggleStar}
          onReply={(m) => replyToMsg(m)} onBack={closeReadingPane} onPreview={previewAttachment}
          onDownloadRaw={downloadRaw} onSnooze={snoozeMsg} onFollowup={followupMsg} onTranslate={translateMsg}
          translatingId={translateMutation.isPending ? (translateMutation.variables ?? null) : null}
          loading={thread.isLoading} offline={!online} bouncingStarId={bouncingStarId}
          aiPendingId={aiMutation.isPending ? (aiMutation.variables ?? null) : null}
          onGenerateAi={generateAi} onAddEvent={aiAddEvent} onTrackTodo={aiTrackTodo} onSmartReply={smartReply} onUnsubscribe={onUnsubscribe} onBlockSender={onBlockSender} onToggleMute={onToggleMute}
          inInboxView={view.type === 'folder' && view.folder === 'inbox' && !query}
          currentCategory={inboxCategory} onMoveToCategory={moveToCategory}
          onSetStatus={setStatus} onTogglePin={togglePin} onOpenProfile={setProfileEmail}
          onEncryptLink={() => setEncrypt({})} pushToast={pushToast}
          note={thread.data?.note ?? ''}
          onSaveNote={(n) => { const tid = thread.data?.threadId; if (tid) setThreadNote.mutate({ threadId: tid, note: n }); }}
          onRenameSubject={(m) => void renameSubject(m)}
          morphId={morphId} morphSubject={morphId ? items.find((m) => m.id === morphId)?.subject : undefined} />
      )}
      {isDraftsView && (
        <main className="readpane">
          <EmptyState pose="happy" title="點一份草稿繼續編輯" sub="或按 c 開新郵件。" />
        </main>
      )}
      {isContentView && (
        <Suspense fallback={<PageFallback />}>
          {view.type === 'files' && (
            <FilesPage onPreview={previewAttachment} onMenu={() => setDrawerOpen(true)}
              onOpenMessage={(messageId, folder) => {
                setView({ type: 'folder', folder });
                setSelectedId(messageId);
              }} />
          )}
          {view.type === 'contacts' && (
            <ContactsPage onCompose={(email) => openCompose({ to: `${email}, ` })}
              pushToast={pushToast} onMenu={() => setDrawerOpen(true)} />
          )}
          {view.type === 'calendar' && (
            <CalendarPage onNewMeeting={() => setMeetingOpen(true)} onMenu={() => setDrawerOpen(true)}
              onOpenMessage={openMessageById} />
          )}
          {view.type === 'followups' && (
            <FollowupsPage onMenu={() => setDrawerOpen(true)} onOpenMessage={openMessageById} />
          )}
          {view.type === 'agenda' && (
            <TodayPage onMenu={() => setDrawerOpen(true)} onOpenMessage={openMessageById} onView={setView} />
          )}
          {view.type === 'settings' && (
            <SettingsPage me={me} labels={counts.data?.labels ?? []} onMeChanged={onRefreshMe}
              pushToast={pushToast} onMenu={() => setDrawerOpen(true)} />
          )}
          {view.type === 'admin' && (
            <AdminPage pushToast={pushToast} onMenu={() => setDrawerOpen(true)} />
          )}
        </Suspense>
      )}

      {/* F17.1：每扇視窗一個自動儲存計時器（獨立元件 → 互不重置、互不蓋存檔）。 */}
      {wins.map((w) => (
        <DraftAutosave key={`as-${w.key}`} winKey={w.key} contentKey={draftKey(w.draft)} run={runAutosave} />
      ))}
      {/* 收合中的視窗仍然掛載（.composer.minimized 是 opacity:0）——卸載會毀掉 contentEditable 的游標與 undo 歷史。 */}
      {wins.map((w) => (
        <Composer key={w.key} draft={w.draft}
          slotIndex={Math.max(0, expandedKeys.indexOf(w.key))}
          inlineTarget={w.key === inlineWinKey ? replyMount : null}
          onChange={(d) => patchWin(w.key, { draft: d })}
          onSend={() => void finalizeSend(w.key)}
          onSchedule={(at) => void finalizeSend(w.key, at)}
          onSendAndArchive={() => void finalizeSend(w.key, undefined, true)}
          onClose={() => void closeComposer(w.key)}
          autosave={w.autosave}
          minimized={w.minimized}
          onMinimize={() => patchWin(w.key, { minimized: true })}
          templates={(me.prefs.templates as { id: string; name: string; body: string }[] | undefined) ?? []}
          pushToast={pushToast} userEmail={me.user.email} contactNames={contactNames} defaultSignature={me.signature}
          onEncryptLink={(body) => setEncrypt({ initialBody: body })} />
      ))}
      {wins.some((w) => w.minimized) && (
        <div className="composer-chips">
          {wins.filter((w) => w.minimized).map((w) => (
            <button key={w.key} className="composer-chip" onClick={() => focusWin(w.key)} aria-label="展開草稿">
              <Icon name="pen" size={14} />
              <span className="composer-chip-title">{w.draft.subject.trim() || (w.draft.replyToMessageId ? '回覆' : '新郵件')}</span>
              {w.autosave === 'saved' && <Icon name="check" size={12} />}
              <span className="composer-chip-x" role="button" aria-label="關閉草稿"
                onClick={(e) => { e.stopPropagation(); void closeComposer(w.key); }}>
                <Icon name="x" size={12} />
              </span>
            </button>
          ))}
        </div>
      )}

      {newMail.alert && (
        <NewMailCard
          alert={newMail.alert}
          onHold={newMail.hold}
          onDismiss={newMail.dismiss}
          onOpen={() => { const id = newMail.alert?.id; newMail.dismiss(); if (id) openMessageById(id); }}
          onArchive={() => {
            const id = newMail.alert?.id;
            newMail.dismiss();
            if (id) { patchMsg.mutate({ id, patch: { folder: 'archive' } }); pushToast('已封存 📦'); }
          }}
        />
      )}

      <div className="toast-wrap">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.leaving ? 'leaving' : ''}`} role="status" aria-live="polite" aria-atomic="true">
            {toast.countdown && <UndoRing total={toast.countdown.total} left={toast.countdown.left} />}
            <span>{toast.text}</span>
            {toast.action ? (
              <button className="linklike" style={{ fontWeight: 600 }} onClick={() => toast.action!.run()}>{toast.action.label}</button>
            ) : (
              <button className="iconbtn" style={{ width: 24, height: 24 }} aria-label="關閉"
                onClick={() => dismissToast(toast.id)}><Icon name="x" size={12} /></button>
            )}
          </div>
        ))}
      </div>

      {showPalette && <CommandPalette actions={paletteActions} onClose={() => setShowPalette(false)} />}
      {quickPick && <CommandPalette actions={quickPick} onClose={() => setQuickPick(null)} />}

      <DialogHost />

      {lightbox && <Lightbox att={lightbox} onClose={() => setLightbox(null)} onDownload={downloadAttachment} />}

      {/* lazy modal 一律「自己的 gate ＋ 自己的 Suspense」：共用外層 gate 會漏掉沒列進去的 modal
          （F7.7 加密連結、F10.1 問信箱曾被夾在 meetingOpen||aiComposeOpen 底下而靜默失效） */}
      {meetingOpen && (
        <Suspense fallback={null}>
          <MeetingModal onClose={() => setMeetingOpen(false)} pushToast={pushToast} />
        </Suspense>
      )}
      {aiComposeOpen && (
        <Suspense fallback={null}>
          <AiComposeModal onClose={() => setAiComposeOpen(false)} onDraft={(text) => openCompose({ body: text })} />
        </Suspense>
      )}
      {encrypt && (
        <Suspense fallback={null}>
          <EncryptedLinkModal onClose={() => setEncrypt(null)} pushToast={pushToast} initialBody={encrypt.initialBody} />
        </Suspense>
      )}
      {askOpen && (
        <Suspense fallback={null}>
          <AskMailModal onClose={() => setAskOpen(false)} onOpenMessage={openMessageById} />
        </Suspense>
      )}

      {/* F5.4：閱讀窗點寄件人 → 往來脈絡（重用 F2.5 聯絡人 360；lazy 載入不進主包） */}
      {profileEmail && (
        <Suspense fallback={null}>
          <Contact360Modal
            email={profileEmail}
            onClose={() => setProfileEmail(null)}
            onCompose={(email) => { setProfileEmail(null); openCompose({ to: `${email}, ` }); }}
          />
        </Suspense>
      )}

      {/* F8.9：首登 60 秒導覽（lazy；完成/跳過寫 localStorage 標記，不再顯示） */}
      {showOnboard && (
        <Suspense fallback={null}>
          <Onboarding onDone={() => { try { localStorage.setItem('miseroda_onboarded_v1', '1'); } catch { /* localStorage 不可用時本次仍關閉 */ } setShowOnboard(false); }} />
        </Suspense>
      )}

      {showKbd && (
        <Modal title="鍵盤快捷鍵" desc="在列表與閱讀視圖中可用" onClose={() => setShowKbd(false)}>
          <div className="kbd-grid">
            {[['j / k', '下一封 / 上一封'], ['r / R', '回覆 / 全部回覆'], ['f', '轉發'], ['e', '封存'], ['s', '星標'],
              ['x / ⇧x', '勾選 / 範圍勾選'], ['l', '加標籤'], ['v', '移到資料夾'], ['[ / ]', '封存並跳上/下一封'],
              ['#', '刪除'], ['c', '寫信'], ['⌘↵', '寄出（撰寫中）'], ['/', '搜尋'], ['⌘K', '指令面板'], ['Esc', '關閉視窗']].map(([k, desc]) => (
              <div className="kbd-row" key={k}><span>{desc}</span><kbd>{k}</kbd></div>
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}
