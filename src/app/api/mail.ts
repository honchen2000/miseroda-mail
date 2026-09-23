// 信箱資料層：TanStack Query hooks + 樂觀更新
import { useCallback } from 'react';
import { queryOptions, useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { api } from './client';
import { patchMessagePages, findMessageLocation, patchCountsUnread } from './optimistic';

export type View =
  | { type: 'folder'; folder: string }
  | { type: 'label'; id: string }
  | { type: 'contacts' }
  | { type: 'files' }
  | { type: 'calendar' }
  | { type: 'followups' }
  | { type: 'agenda' }
  | { type: 'settings' }
  | { type: 'admin' };

export interface CalEvent {
  id: string;
  summary: string;
  startMs: number;
  endMs: number | null;
  startText: string;
  allDay: boolean;
  floating: boolean;
  location: string;
  organizer: string;
  source: 'received' | 'created' | 'external';
  rsvpStatus: 'accepted' | 'tentative' | 'declined' | null;
  messageId: string | null;
  /** 重複事件的展開實例（顯示 🔁 標記）。 */
  recurring?: boolean;
  /** calendar_events 的原始列 id；重複事件的 id 帶了發生時間，確認移除/保留要用這個。
   *  生日與外部訂閱是虛擬事件（不在表裡）→ null。 */
  rowId: string | null;
  /** F16.2：有一封通過授權的 CANCEL 進來，等使用者確認是否移除。 */
  cancelPending: boolean;
  cancelBy: string | null;
  /** F16.1：有一封未通過授權的外來修改/取消被擋下（事件內容未被更動）。 */
  blockedAt: number | null;
  blockedBy: string | null;
}

/** F16.2：使用者確認後真正移除一筆行事曆事件（本樹唯一的刪除路徑）。 */
export function useRemoveCalEvent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<{ ok: true }>(`/calendar/events/${encodeURIComponent(id)}/remove`, { method: 'POST', body: {} }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['calendar'] }),
  });
}

/** F16.2：使用者選擇保留——清掉待確認取消與被拒警示，事件照常留著。 */
export function useKeepCalEvent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<{ ok: true }>(`/calendar/events/${encodeURIComponent(id)}/keep`, { method: 'POST', body: {} }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['calendar'] }),
  });
}
export function useCalendarEvents(from: number, to: number) {
  return useQuery({
    queryKey: ['calendar', from, to],
    queryFn: () => api<{ events: CalEvent[] }>(`/calendar/events?from=${from}&to=${to}`),
    staleTime: 60_000,
  });
}

/** 收件匣分類分頁（主要/社交/促銷/通知；後端 src/worker/email/categorize.ts 同形狀） */
export type InboxCategory = 'primary' | 'social' | 'promotions' | 'updates';
export const INBOX_CATEGORIES: InboxCategory[] = ['primary', 'social', 'promotions', 'updates'];
export const CATEGORY_LABEL: Record<InboxCategory, string> = {
  primary: '主要',
  social: '社交',
  promotions: '促銷',
  updates: '通知',
};

export interface Counts {
  folders: Record<string, { total: number; unread: number }>;
  starred: number;
  snoozed: number;
  followups: number;
  needsReply: number;
  waiting: number;
  pinned: number;
  newsletter: number;
  receipt: number;
  screening: number; // F5.3：待審夾
  labels: { id: string; name: string; color: string; count: number; parentId: string | null; sortOrder: number }[];
  inboxCategories: Record<InboxCategory, { total: number; unread: number }>;
}

export interface MsgListItem {
  id: string;
  threadId: string;
  from: { name: string; addr: string };
  subject: string;
  snippet: string;
  ts: number;
  unread: boolean;
  starred: boolean;
  hasAttachments: boolean;
  labels: string[];
  /** 工作流通道：needs_reply / waiting / null */
  status: 'needs_reply' | 'waiting' | null;
  pinned: boolean;
  /** F8.10：稍後處理到期時間戳（過去 = 已浮回收件匣）。null / undefined = 從未 snooze。 */
  snoozedUntil?: number | null;
  /** F9.7：顯示用主旨改寫（僅自己可見）。呈現層用 subjectOverride ?? subject；回覆引用一律用原 subject。 */
  subjectOverride?: string | null;
  /** F10.3：帳單/包裹卡（ingest AI 抽取，後端已清洗；null = 非收據信或未抽到）。 */
  receiptCard?: { kind: 'bill' | 'parcel'; amount?: string; dueDate?: string; trackingNo?: string; vendor?: string } | null;
}

export interface ThreadMessage extends MsgListItem {
  /** F11.1：站內信才有——emoji 反應（跨複本共享）。 */
  internal?: boolean;
  reactions?: { emoji: string; count: number; mine: boolean; names: string[] }[];
  to: string[];
  cc: string[];
  direction: 'inbound' | 'outbound';
  folder: string;
  html: string;
  /** F13.1：html 內含 data-quote 標記的回覆引文（前端摺疊；老信 serve 時同樣標到）。 */
  hasQuote?: boolean;
  remoteImages: boolean;
  /** 剛收到、ingest queue 尚未回填 html 的中間態（後端 r2_html_key 為 NULL）。此時 html 必為空字串。 */
  processing?: boolean;
  /** F19.1：這封有內文，但本次請求的對話串內文預算（份數／位元組）已用完 → 沒載。
   *  單獨開啟這封信時它會排在第一順位，必定載得到。 */
  htmlOmitted?: boolean;
  /** F2.8b：已退訂卻又寄來（ingest 自動歸檔時標記）。 */
  unsubResend?: boolean;
  /** F5.3：待審（陌生首觸 + 驗證 partial，被審核閘攔下）。 */
  screening?: boolean;
  /** 寄件者信任卡：SPF/DKIM/DMARC 結果（後端 src/worker/email/authVerdict.ts 同形狀）；null=無資訊。 */
  authVerdict: { spf: string | null; dkim: string | null; dmarc: string | null } | null;
  /** 首次來信：此 from 位址先前無更早的入站信（僅入站信為 true）。 */
  isNewSender: boolean;
  aiSummary: {
    summary: string;
    category: string;
    replies: string[];
    events?: { summary: string; startMs: number; endMs: number; location?: string }[];
    actions?: string[];
    model: string;
  } | null;
  aiTranslation: string | null;
  snoozedUntil: number | null;
  calendarEvent: CalendarEvent | null;
  /** 會議邀請出席回覆：accepted / tentative / declined / null（未回覆） */
  rsvpStatus: 'accepted' | 'tentative' | 'declined' | null;
  unsubscribe: Unsubscribe | null;
  attachments: { id: string; filename: string; mimeType: string; sizeBytes: number }[];
}

/** List-Unsubscribe 解析（後端 src/worker/email/list-unsubscribe.ts 同形狀） */
export interface Unsubscribe {
  httpUrl: string | null;
  mailto: string | null;
  oneClick: boolean;
}

/** 會議邀請（.ics 解析；後端 src/worker/email/calendar.ts 同形狀） */
export interface CalendarEvent {
  method: string | null;
  summary: string | null;
  startText: string | null;
  endText: string | null;
  startMs: number | null;
  endMs: number | null;
  allDay: boolean;
  location: string | null;
  description: string | null;
  organizer: { name: string | null; email: string | null } | null;
  uid: string | null;
}

// 效能迴圈 P10：選項抽成函式，讓 hook 與開機預抓（App.tsx）用**同一份**鍵與 queryFn——鍵不同預抓就白打。
export function countsQueryOptions() {
  return queryOptions({
    queryKey: ['counts'],
    queryFn: () => api<Counts>('/mailbox/counts'),
    // 9 支查詢的一支 API、邊緣在 PDX（單趟 ~165ms 起跳）→ 拉長到 60s；即時性交給 useRealtime WS + onMutate 樂觀更新頂住。
    staleTime: 60_000,
    refetchInterval: 120_000, // WS 即時為主，輪詢僅保底
  });
}

export function useCounts() {
  return useQuery(countsQueryOptions());
}

// 搜尋運算子解析已抽到純模組（無 DOM → 可被 worker vitest 直測）。匯入後再 re-export，維持既有 import 路徑。
import { parseSearch, searchParams, parseSize, parseDuration, type SearchSpec } from '../lib/search';
export { parseSearch, searchParams, parseSize, parseDuration, type SearchSpec };

// F2.6 全域跨域搜尋：信 × 聯絡人 × 會議 × 跟進
export interface GlobalSearchResult {
  q: string;
  messages: { id: string; threadId: string; subject: string; fromName: string; fromAddr: string; receivedAt: number; folder: string; direction: string }[];
  contacts: { email: string; name: string; lastUsed: number }[];
  events: { id: string; summary: string; startMs: number; startText: string; location: string; allDay: boolean; floating: boolean }[];
  followUps: { id: string; subject: string; dueAt: number; awaitReply: boolean; threadId: string }[];
}
export function useGlobalSearch(q: string) {
  return useQuery({
    queryKey: ['globalSearch', q],
    queryFn: () => api<GlobalSearchResult>(`/search?q=${encodeURIComponent(q)}`),
    enabled: [...q].length >= 2,
    staleTime: 20_000,
  });
}

export function useMessages(view: View, q: string, category?: InboxCategory) {
  const spec = parseSearch(q);
  const params = searchParams(spec);
  if (view.type === 'label') params.set('label', view.id);
  else if (view.type === 'folder') params.set('folder', view.folder);
  // 分類分頁僅在收件匣、且非搜尋時套用（搜尋跨全部分類，與 Gmail 一致）；
  // primary 也明確送出（後端 primary 含 NULL），否則主要頁會漏顯示成全部收件匣。
  if (view.type === 'folder' && view.folder === 'inbox' && category && !q.trim()) {
    params.set('category', category);
  }
  const key = params.toString();
  return useInfiniteQuery({
    queryKey: ['messages', key],
    queryFn: ({ pageParam }) =>
      api<{ items: MsgListItem[]; nextCursor: string | null }>(
        `/messages?${key}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: view.type === 'folder' || view.type === 'label',
    // 切回 60s 內看過的資料夾直接吃快取、不重打網路；即時性交給 useRealtime WS + onMutate 樂觀更新頂住。
    staleTime: 60_000,
    refetchInterval: 120_000, // WS 即時為主，輪詢僅保底
    placeholderData: (prev) => prev,
  });
}

export interface SavedSearch {
  id: string;
  name: string;
  query: string;
  pinned: boolean; // F5.6a：是否釘到側欄
}

export function useSavedSearches() {
  return useQuery({
    queryKey: ['saved-searches'],
    queryFn: () => api<{ searches: SavedSearch[] }>('/saved-searches'),
    staleTime: 60_000,
  });
}

export function useSaveSearch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { name: string; query: string }) => api<{ id: string }>('/saved-searches', { body: v }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['saved-searches'] }),
  });
}

export function useDeleteSavedSearch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(`/saved-searches/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['saved-searches'] }),
  });
}

// F5.6b：opt-in 把電子報移出主收件匣 —— 建一條 hasListUnsubscribe→archive 規則（未來清單信自動歸檔，仍在電子報視圖）。
// 去重：已有同條件啟用中的歸檔規則就不再建（避免重複按產生多條）。
export function useRouteNewslettersOut() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { rules } = await api<{ rules: { conditions: { hasListUnsubscribe?: boolean }; actions: { moveToFolder?: string }; enabled: boolean }[] }>('/rules');
      const exists = rules.some((r) => r.enabled && r.conditions?.hasListUnsubscribe === true && r.actions?.moveToFolder === 'archive');
      if (exists) return { already: true };
      await api('/rules', {
        method: 'POST',
        body: { name: '電子報移出主收件匣', conditions: { hasListUnsubscribe: true }, actions: { moveToFolder: 'archive' } },
      });
      return { already: false };
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: ['rules'] }),
  });
}

// F5.6a：釘/取消釘 saved search 到側欄
export function usePinSavedSearch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; pinned: boolean }) => api(`/saved-searches/${v.id}`, { method: 'PATCH', body: { pinned: v.pinned } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['saved-searches'] }),
  });
}

type ThreadPayload = { id: string; threadId: string; thread: ThreadMessage[]; muted: boolean; note: string; noteUpdatedAt: number | null };
const threadQueryOpts = (id: string) => ({
  queryKey: ['thread', id],
  queryFn: () => api<ThreadPayload>(`/messages/${id}`),
  staleTime: 30_000,
});

export function useThread(id: string | null) {
  return useQuery({
    ...threadQueryOpts(id ?? ''),
    enabled: !!id,
    // 還在 ingest queue 裡消化的信（processing）短輪詢到內容就緒為止，就緒後回 false 即停。
    // 不單靠 WebSocket 事件的理由：consumer 對「已退訂自動歸檔」等情況刻意不推播
    // （jobs/ingestConsumer.ts），只等事件會讓「處理中」永遠卡住。
    refetchInterval: (query) => (query.state.data?.thread.some((m) => m.processing) ? 3000 : false),
  });
}

/**
 * 效能：D1 在 WNAM、使用者在台灣 → 冷開一封信要等數個跨太平洋來回（實測 ~2.5s）。
 * 在使用者「還沒點」時就先抓（滑過列表列、列表載入後的前幾封、選取後的上下封），
 * 點下去直接命中 30s 快取 → 體感即時。prefetchQuery 已有快取就不會重打。
 */
export function usePrefetchThread() {
  const qc = useQueryClient();
  return useCallback(
    (id: string | null | undefined) => {
      if (!id) return;
      void qc.prefetchQuery(threadQueryOpts(id));
    },
    [qc],
  );
}

/** F10.2：抵達即備稿——ingest 背景生成的回覆草稿（KV 7 天；無備稿回 null）。 */
export function useAutoDraft(id: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ['auto-draft', id],
    queryFn: () => api<{ draft: string | null; generatedAt: number | null }>(`/messages/${id}/auto-draft`),
    enabled: !!id && enabled,
    staleTime: 5 * 60_000,
  });
}

/** F11.1：站內信 emoji 反應 toggle。 */
export function useReact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, emoji }: { id: string; emoji: string }) =>
      api<{ ok: boolean; reacted: boolean }>(`/messages/${id}/react`, { method: 'POST', body: { emoji } }),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['thread'] }),
  });
}

/** F9.7：線程私有便利貼 upsert（空字串 = 刪除）。 */
export function useSetThreadNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ threadId, note }: { threadId: string; note: string }) =>
      api<{ ok: boolean; note: string }>(`/threads/${threadId}/note`, { method: 'PUT', body: { note } }),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['thread'] }),
  });
}

/** 靜音 / 取消靜音對話串：muted 串日後新信自動跳過收件匣；靜音時也封存目前在收件匣的信。 */
export function useMute() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, muted }: { id: string; muted: boolean }) =>
      api<{ ok: boolean; muted: boolean }>(`/messages/${id}/mute`, { method: 'POST', body: { muted } }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['thread'] });
      void qc.invalidateQueries({ queryKey: ['messages'] });
      void qc.invalidateQueries({ queryKey: ['counts'] });
    },
  });
}

/* ---------- 跟進提醒（稍後跟進 / 寄出等回覆） ---------- */
export interface FollowUp {
  id: string;
  messageId: string;
  subject: string;
  dueAt: number;
  awaitReply: boolean;
  status: 'pending' | 'fired';
}
export function useFollowups(enabled = true) {
  return useQuery({
    queryKey: ['followups'],
    queryFn: () => api<{ followups: FollowUp[] }>('/followups'),
    enabled,
    staleTime: 30_000,
  });
}

export interface AgendaItem {
  kind: 'event' | 'followup' | 'snooze' | 'scheduled';
  at: number;
  title: string;
  sub?: string;
  url: string;
  messageId?: string;
  overdue?: boolean;
}
/** 今日聚合（信×行事曆×跟進×排程）。本地當日窗口由前端算，避免伺服器時區假設。 */
export function useAgenda(enabled = true) {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const to = from + 86_400_000;
  return useQuery({
    queryKey: ['agenda', from],
    queryFn: () => api<{ items: AgendaItem[] }>(`/agenda?from=${from}&to=${to}`),
    enabled,
    staleTime: 60_000,
  });
}
/** 設定（或更新）某封信的跟進提醒。dueAt=提醒時間；awaitReply=僅在屆時仍無回覆才提醒。 */
export function useSetFollowup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, dueAt, awaitReply }: { id: string; dueAt: number; awaitReply: boolean }) =>
      api<{ ok: boolean }>(`/messages/${id}/followup`, { method: 'POST', body: { dueAt, awaitReply } }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['followups'] });
      void qc.invalidateQueries({ queryKey: ['counts'] });
    },
  });
}
/** 標記跟進完成（移出清單）。樂觀更新：點擊即時移除該列，失敗回滾。 */
export function useFollowupDone() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<{ ok: boolean }>(`/followups/${id}/done`, { method: 'POST', body: {} }),
    onMutate: async (id: string) => {
      await qc.cancelQueries({ queryKey: ['followups'] });
      const prev = qc.getQueryData<{ followups: FollowUp[] }>(['followups']);
      if (prev) {
        qc.setQueryData<{ followups: FollowUp[] }>(['followups'], {
          followups: prev.followups.filter((f) => f.id !== id),
        });
      }
      return { prev };
    },
    onError: (_e, _id, ctx) => {
      if (ctx?.prev) qc.setQueryData(['followups'], ctx.prev);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['followups'] });
      void qc.invalidateQueries({ queryKey: ['counts'] });
    },
  });
}

export function useAiSummarize() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<{ ai: NonNullable<ThreadMessage['aiSummary']>; cached: boolean }>(`/messages/${id}/ai`, {
        method: 'POST',
        body: {},
        timeoutMs: 60_000,
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['thread'] }),
  });
}

/** AI 依自然語言指示草擬新信正文。 */
export function useAiCompose() {
  return useMutation({
    mutationFn: (prompt: string) => api<{ text: string }>('/ai/compose', { method: 'POST', body: { prompt }, timeoutMs: 60_000 }),
  });
}

export type RewriteMode = 'polish' | 'formal' | 'friendly' | 'concise';
/** AI 改寫 / 調語氣正文。 */
export function useAiRewrite() {
  return useMutation({
    // F2.7：可選 context（收件人/原信摘要）→ 讓改寫貼合對象
    mutationFn: ({ text, mode, context }: { text: string; mode: RewriteMode; context?: string }) =>
      api<{ text: string }>('/ai/rewrite', { method: 'POST', body: { text, mode, ...(context ? { context } : {}) }, timeoutMs: 60_000 }),
  });
}

/** AI 依正文建議主旨。 */
export function useAiSubject() {
  return useMutation({
    mutationFn: (text: string) => api<{ subject: string }>('/ai/subject', { method: 'POST', body: { text }, timeoutMs: 60_000 }),
  });
}

/** AI 把自然語言找信需求轉成搜尋查詢字串。 */
export function useAiSearch() {
  return useMutation({
    mutationFn: (q: string) => api<{ query: string }>('/ai/search', { method: 'POST', body: { q }, timeoutMs: 60_000 }),
  });
}

/** AI 摘要整個對話串（多封信）。 */
export function useThreadSummary() {
  return useMutation({
    mutationFn: (id: string) => api<{ summary: string }>(`/messages/${id}/thread-summary`, { method: 'POST', body: {}, timeoutMs: 60_000 }),
  });
}

export function useTranslate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<{ translation: string; cached: boolean }>(`/messages/${id}/translate`, { method: 'POST', body: {}, timeoutMs: 60_000 }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['thread'] }),
  });
}

/** F9.3：訂閱管理儀表板——聚合電子報 lane by 寄件者。 */
export interface Subscription {
  addr: string;
  name: string;
  total: number;
  last30: number;
  unread: number;
  lastAt: number;
  latestId: string;
}
export function useSubscriptions(enabled: boolean) {
  return useQuery({
    queryKey: ['subscriptions'],
    queryFn: () => api<{ subscriptions: Subscription[] }>('/subscriptions'),
    enabled,
    staleTime: 60_000,
  });
}

/** 一鍵退訂：one-click 由伺服器代送 POST；否則回 url/mailto 供前端開啟 */
export function useUnsubscribe() {
  return useMutation({
    mutationFn: (id: string) =>
      api<{ ok: boolean; method: string; url?: string | null; mailto?: string | null }>(
        `/messages/${id}/unsubscribe`,
        { method: 'POST', body: {} },
      ),
  });
}

/** 會議邀請 RSVP：寄出 iCalendar REPLY 給組織者並記錄出席狀態，成功後刷新對話串以回顯。 */
export function useRsvp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'accepted' | 'tentative' | 'declined' }) =>
      api<{ ok: boolean; status: string }>(`/messages/${id}/rsvp`, { method: 'POST', body: { status } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['thread'] }),
  });
}

/** 自建會議邀請：寄 METHOD:REQUEST .ics 給與會者（複用寄信管線）。成功後刷新寄件備份/計數。 */
export type Recurrence = 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly';
export interface CreateInviteBody {
  summary: string;
  attendees: string[];
  startMs: number;
  endMs: number;
  location?: string;
  description?: string;
  whenText?: string;
  recurrence?: Recurrence;
  /** 提醒提前分鐘數（0=開始時，null=不提醒）。 */
  reminderMin?: number | null;
}
export function useCreateInvite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateInviteBody) =>
      api<{ ok: boolean; attendees: number }>('/calendar/invite', { method: 'POST', body }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['messages'] });
      void qc.invalidateQueries({ queryKey: ['counts'] });
      void qc.invalidateQueries({ queryKey: ['calendar'] });
    },
  });
}

// F14.3：規則建議 nudge —— 讀信時查此寄件者是否值得建自動歸檔規則（懶載，無 AI）。
export interface RuleHint { fromAddr: string; fromName: string; archived: number; total: number }
export function useRuleHint(msgId: string | null) {
  return useQuery({
    queryKey: ['rule-hint', msgId],
    queryFn: () => api<{ hint: RuleHint | null }>(`/messages/${msgId}/rule-hint`),
    enabled: !!msgId,
    staleTime: 5 * 60_000,
  });
}

/** F14.3：一鍵為寄件者建「自動歸檔」規則（沿用 rules POST；from contains → archive）。 */
export function useCreateSenderRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ fromAddr, fromName }: { fromAddr: string; fromName: string }) =>
      api('/rules', {
        method: 'POST',
        body: {
          name: `${fromName || fromAddr} 自動歸檔`,
          conditions: { clauses: [{ field: 'from', op: 'contains', value: fromAddr }] },
          actions: { moveToFolder: 'archive' },
        },
      }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['rules'] });
      void qc.invalidateQueries({ queryKey: ['rule-hint'] }); // 整個 family：建規則後該寄件者的信重查會被 covered 抑制
    },
  });
}

/** 封鎖寄件者：建立一條「寄件者包含 X → 移至垃圾信」的自動規則。 */
export function useBlockSender() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, value }: { name: string; value: string }) =>
      api('/rules', {
        method: 'POST',
        body: {
          name,
          conditions: { clauses: [{ field: 'from', op: 'contains', value }] },
          actions: { moveToFolder: 'spam' },
        },
      }),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['rules'] }),
  });
}

// F5.3：待審決策（放行/永遠擋）。後端以寄件者為單位處理其所有待審信並更新聯絡人/規則。
export function useScreenDecision() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: 'allow' | 'block' }) =>
      api(`/messages/${id}/screen`, { method: 'POST', body: { decision } }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['messages'] });
      void qc.invalidateQueries({ queryKey: ['counts'] });
    },
  });
}

export function useBatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { ids: string[]; patch?: MsgPatch; addLabelId?: string; removeLabelId?: string }) =>
      api('/messages/batch', { method: 'POST', body }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['messages'] });
      void qc.invalidateQueries({ queryKey: ['counts'] });
    },
  });
}

// F4.7：依目前虛擬夾（newsletter/receipt）批次處理全部符合的信（標已讀/封存；F9.3 加 trash＝移垃圾桶可復原）。
export function useBatchByView() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { view: 'newsletter' | 'receipt'; action: 'read' | 'archive' | 'trash'; fromAddr?: string }) =>
      api<{ changes: number }>('/messages/batch-by-view', { method: 'POST', body }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['messages'] });
      void qc.invalidateQueries({ queryKey: ['counts'] });
    },
  });
}

export interface MsgPatch {
  unread?: boolean;
  starred?: boolean;
  folder?: string;
  snoozedUntil?: number | null;
  category?: InboxCategory;
  status?: 'needs_reply' | 'waiting' | null;
  pinned?: boolean;
  /** F9.7：顯示用主旨改寫（null/空字串 = 還原原主旨） */
  subjectOverride?: string | null;
}

type MsgPage = InfiniteData<{ items: MsgListItem[]; nextCursor: string | null }>;

export function usePatchMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: MsgPatch }) =>
      api(`/messages/${id}`, { method: 'PATCH', body: patch }),
    onMutate: async ({ id, patch }) => {
      await qc.cancelQueries({ queryKey: ['messages'] });
      // 只捕捉「這封信」且「本次真的有改」的原地欄位原值 → 失敗時僅回滾自己動到的欄位，
      // 不覆蓋同一封信上其他並發樂觀更新（例：A 改星標失敗，不該蓋掉 B 剛標的已讀）。
      let before: MsgPatch | null = null;
      for (const [, data] of qc.getQueriesData<MsgPage>({ queryKey: ['messages'] })) {
        const m = data?.pages?.flatMap((p) => p.items).find((it) => it.id === id);
        if (m) {
          before = {};
          if (patch.unread !== undefined) before.unread = m.unread;
          if (patch.starred !== undefined) before.starred = m.starred;
          if (patch.status !== undefined) before.status = m.status;
          if (patch.pinned !== undefined) before.pinned = m.pinned;
          break;
        }
      }
      // 樂觀更新所有列表快取（infinite-query 的 pages 結構；純函式 + 守門，永不 throw）
      qc.setQueriesData<MsgPage>({ queryKey: ['messages'] }, (data) => patchMessagePages(data, id, patch) as MsgPage);
      // folder/snooze/category 會「移出視圖」→ 無法精準復位，失敗時走 refetch 還原（不覆蓋他人）。
      const removesFromView = patch.folder !== undefined || patch.snoozedUntil !== undefined || patch.category !== undefined;

      // counts 樂觀更新：標已讀/取消已讀同步反映側欄數字與分頁 badge，不等 onSettled 的 /mailbox/counts
      // 重抓（跨太平洋一支查詢，1–2 秒才回來，體感明顯卡）。從剛剛的列表快取找出這封信所在的 folder/category。
      let countsPatch: { loc: { folder: string | null; category: string | null }; delta: 1 | -1 } | null = null;
      if (patch.unread !== undefined) {
        const loc = findMessageLocation(qc.getQueriesData<MsgPage>({ queryKey: ['messages'] }), id);
        if (loc.folder || loc.category) {
          const delta = patch.unread ? 1 : -1;
          countsPatch = { loc, delta };
          qc.setQueriesData<Counts>({ queryKey: ['counts'] }, (data) => patchCountsUnread(data, loc, delta));
        }
      }

      return { before, removesFromView, countsPatch };
    },
    onError: (_e, { id }, ctx) => {
      if (ctx?.removesFromView || !ctx?.before) {
        void qc.invalidateQueries({ queryKey: ['messages'] }); // 移出視圖型：refetch 取回真實狀態
      } else {
        // 原地型（星標/已讀/狀態/釘選）：只還原這封信，保留其他並發更新
        qc.setQueriesData<MsgPage>({ queryKey: ['messages'] }, (data) => patchMessagePages(data, id, ctx.before!) as MsgPage);
      }
      // counts 只反向套用「本次自己加/減的那一格」delta（比照上面 messages 的作法），
      // 不整份覆蓋 —— 否則連續操作時，第一個失敗會把其他並發樂觀更新已經動過的數字一起蓋掉。
      if (ctx?.countsPatch) {
        const { loc, delta } = ctx.countsPatch;
        qc.setQueriesData<Counts>({ queryKey: ['counts'] }, (data) => patchCountsUnread(data, loc, -delta as 1 | -1));
      }
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['messages'] });
      void qc.invalidateQueries({ queryKey: ['counts'] });
    },
  });
}
