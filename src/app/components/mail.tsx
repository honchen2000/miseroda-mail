// 側欄、信件列表、閱讀面板 —— 1:1 移植設計原型，資料接 API
import { createPortal } from 'react-dom';
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { parseSearch, useAiSearch, useAutoDraft, useGlobalSearch, useReact, useRsvp, useScreenDecision, useThreadSummary, useSavedSearches, useSaveSearch, useDeleteSavedSearch, usePinSavedSearch, useRuleHint, useCreateSenderRule, CATEGORY_LABEL, INBOX_CATEGORIES, type CalendarEvent, type Counts, type InboxCategory, type MsgListItem, type ThreadMessage, type View } from '../api/mail';
import type { OutboxItem } from '../api/send';
import { AppLogo, AvatarImg, EmptyState, Icon, LabelChip, Modal, AuroraSky, fullTime, highlight, timeAgo, useScrollFog } from './ui';
import { DateTimeField } from './inputs';
import { haptics } from '../lib/haptics';
import { attachmentRiskExt, attachmentWarning } from '../lib/attachmentRisk';
import { senderAvatarSources } from '../lib/avatarSources';
import { EMPTY_FIT_WIDTH, recordFitWidth, shouldRefitWidth } from '../lib/emailFit';
import { buildSrcdoc } from '../lib/emailSrcdoc';
import { fitEmailToWidth, unfoldEmailDocument } from '../lib/emailFit.dom';
import { buildLabelTree } from '../lib/labelTree';
import { coachHint } from '../lib/shortcut-coach';
import type { Me } from '../api/client';

// F6.x 手機 audit：swipe 封存/刪除閾值響應化——原固定 96px 在 ~390px 窄機佔 1/4 螢幕、單手難達。
// 改螢幕寬 18%（下限 64px），桌機（不 swipe）取值大無妨。
const SWIPE_THRESHOLD = Math.max(64, (typeof window !== 'undefined' ? window.innerWidth : 800) * 0.18);

/** 列表日期分組：今天 / 昨天 / 本週 / 這個月 / 2026年5月… */
function dateGroup(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const today = startOfDay(now);
  const t = startOfDay(d);
  if (t === today) return '今天';
  if (t === today - 86400_000) return '昨天';
  if (t > today - 7 * 86400_000) return '本週';
  if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) return '這個月';
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月`;
}

/** 寄件人頭像：站內使用者 → 上傳頭像；外部 → 字首圓圈（不對第三方查詢，見 lib/avatarSources.ts）。 */
export function SenderAvatar({ name, addr, size = '' }: { name: string; addr: string; size?: '' | 'sm' | 'lg' }) {
  return <AvatarImg name={name} sources={senderAvatarSources(addr)} size={size} />;
}

export const FOLDERS = [
  { id: 'inbox', name: '收件匣', icon: 'inbox' },
  { id: 'starred', name: '已加星標', icon: 'star' },
  { id: 'snoozed', name: '稍後處理', icon: 'snooze' },
  { id: 'needs_reply', name: '需回信', icon: 'reply' },
  { id: 'waiting', name: '等待中', icon: 'clock' },
  { id: 'pinned', name: '釘選', icon: 'pin' },
  { id: 'newsletter', name: '電子報', icon: 'globe' },
  { id: 'receipt', name: '收據', icon: 'pdf' },
  { id: 'screening', name: '待審', icon: 'shield' },
  { id: 'sent', name: '寄件備份', icon: 'send' },
  { id: 'drafts', name: '草稿', icon: 'draft' },
  { id: 'archive', name: '封存', icon: 'archive' },
  { id: 'spam', name: '垃圾信', icon: 'spam' },
  { id: 'trash', name: '垃圾桶', icon: 'trash' },
] as const;

// F8.7：側欄四組分組降噪（標籤樹另處理）。核心置頂無標題；清理預設收合、localStorage 記狀態。
const NAV_GROUPS: { key: string; label: string | null; ids: string[]; collapsible?: boolean }[] = [
  { key: 'core', label: null, ids: ['inbox', 'drafts', 'sent'] },
  { key: 'action', label: '行動', ids: ['starred', 'needs_reply', 'waiting', 'pinned', 'snoozed'] },
  { key: 'auto', label: '自動分流', ids: ['newsletter', 'receipt', 'screening'] },
  { key: 'cleanup', label: '清理', ids: ['archive', 'spam', 'trash'], collapsible: true },
];
// F8.7：徽章只留「未讀/待處理」類降噪；星標/釘選/寄件/封存/垃圾等為總數 → 不顯示徽章。
const BADGE_FOLDERS = new Set(['inbox', 'drafts', 'snoozed', 'needs_reply', 'waiting', 'newsletter', 'receipt', 'screening']);
const FOLDER_META: Record<string, (typeof FOLDERS)[number]> = Object.fromEntries(FOLDERS.map((f) => [f.id, f]));
const NAV_CLEANUP_KEY = 'miseroda_nav_cleanup';

/* ---------- 側欄 ---------- */
/** F8.2：通用計數徽章——數字「增加」時 bump 一下（原本只有收件匣有；動畫 5 的通用化）。 */
function BumpCount({ value }: { value: number | '' }) {
  const prev = useRef(value);
  const [bumping, setBumping] = useState(false);
  useEffect(() => {
    const was = prev.current;
    prev.current = value;
    if (typeof was === 'number' && typeof value === 'number' && value > was) {
      setBumping(true);
      const t = setTimeout(() => setBumping(false), 450); // ≥ --dur-xslow(.42s) 讓動畫跑完
      return () => clearTimeout(t);
    }
  }, [value]);
  return <span className={`count ${bumping ? 'bump' : ''}`}>{value}</span>;
}

export function Sidebar({ view, setView, counts, me, onCompose, onNewMeeting, onDropLabel, query, onRunSavedSearch }: {
  view: View;
  setView: (v: View) => void;
  counts: Counts | undefined;
  me: Me;
  onCompose: () => void;
  onNewMeeting: () => void;
  onDropLabel: (labelId: string, messageId: string) => void;
  query: string; // F5.6a：目前搜尋字串（釘選自訂視圖高亮用）
  onRunSavedSearch: (query: string) => void; // F5.6a：點側欄釘選 → 跑該搜尋
}) {
  const pinnedSearches = useSavedSearches().data?.searches.filter((s) => s.pinned) ?? [];
  // F5.6a：釘選搜尋正在跑（query 命中某釘選）→ 收件匣 nav 不該也亮（避免雙 active / pill 跑到收件匣）。
  const pinnedActive = view.type === 'folder' && view.folder === 'inbox' && !!query && pinnedSearches.some((s) => s.query === query);
  const navRef = useRef<HTMLElement>(null);
  const [pill, setPill] = useState<{ top: number; height: number } | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set()); // F4.5b：摺疊的父標籤
  // F8.7：清理組收合狀態（預設收合；localStorage 記憶使用者展開偏好）
  const [cleanupOpen, setCleanupOpen] = useState(() => { try { return localStorage.getItem(NAV_CLEANUP_KEY) === '1'; } catch { return false; } });

  const countFor = (fid: string): number | '' => {
    if (!counts) return '';
    if (fid === 'starred') return counts.starred || '';
    if (fid === 'snoozed') return counts.snoozed || '';
    if (fid === 'needs_reply') return counts.needsReply || '';
    if (fid === 'waiting') return counts.waiting || '';
    if (fid === 'pinned') return counts.pinned || '';
    if (fid === 'newsletter') return counts.newsletter || '';
    if (fid === 'receipt') return counts.receipt || '';
    if (fid === 'screening') return counts.screening || '';
    if (fid === 'drafts') return counts.folders.drafts?.total || '';
    return counts.folders[fid]?.unread || '';
  };
  const isFolder = (fid: string) => view.type === 'folder' && view.folder === fid;

  // active 滑塊：FLIP 量測選中項位置（動畫 3）
  useEffect(() => {
    const el = navRef.current?.querySelector<HTMLElement>('.nav-item.active');
    if (el) setPill({ top: el.offsetTop, height: el.offsetHeight });
    else setPill(null);
  }, [view, counts, cleanupOpen]);

  // F8.7：導覽到清理組資料夾（含 g 快捷鍵）時自動展開，別把正在看的資料夾藏起來（不寫入偏好）。
  useEffect(() => {
    if (view.type === 'folder' && (view.folder === 'archive' || view.folder === 'spam' || view.folder === 'trash')) {
      setCleanupOpen(true); // React 對相同值會 bail-out，不多一次 render
    }
  }, [view]);

  let navIdx = 0;

  return (
    <aside className="sidebar">
      <div className="sidebar-aurora"><AuroraSky bands={1} /></div>
      <div className="sidebar-head">
        <AppLogo size={40} />
        <div>
          <div className="sidebar-title">Miseroda Mail</div>
          <div className="sidebar-domain">mail.miseroda.com</div>
        </div>
      </div>
      {/* 唯讀 demo：隱藏所有寄送/建立入口（伺服器端亦硬擋；此處純為 UX 不留死按鈕） */}
      {!me.isDemo && (
        <>
          <button className="btn btn-primary compose-cta" onClick={onCompose}>
            <Icon name="pen" size={15} /> 寫信
          </button>
          <button className="btn btn-ghost" onClick={onNewMeeting} data-tooltip="建立會議邀請並寄給與會者"
            style={{ display: 'flex', margin: '-8px 14px 14px', justifyContent: 'center', gap: 6, fontSize: 13 }}>
            <Icon name="clock" size={14} /> 新會議
          </button>
        </>
      )}
      <nav className="nav" aria-label="信箱導覽" ref={navRef}>
        {pill && <span className="nav-pill" style={{ top: pill.top, height: pill.height }} aria-hidden="true"></span>}
        {/* F8.7：四組分組（核心／行動／自動分流／清理）；清理預設收合、徽章只留未讀類 */}
        {NAV_GROUPS.map((g) => {
          const groupCollapsed = g.collapsible && !cleanupOpen;
          return (
            <Fragment key={g.key}>
              {g.label && (g.collapsible ? (
                <button className="nav-section nav-section-btn" aria-expanded={cleanupOpen}
                  onClick={() => setCleanupOpen((v) => { const n = !v; try { localStorage.setItem(NAV_CLEANUP_KEY, n ? '1' : '0'); } catch { /* localStorage 不可用時僅本次生效 */ } return n; })}>
                  <span style={{ flex: 1 }}>{g.label}</span>
                  <span style={{ display: 'inline-flex', transition: 'transform var(--dur-fast) var(--ease-out)', transform: cleanupOpen ? 'none' : 'rotate(-90deg)' }}>
                    <Icon name="chevronDown" size={12} />
                  </span>
                </button>
              ) : (
                <div className="nav-section">{g.label}</div>
              ))}
              {!groupCollapsed && g.ids.map((fid) => {
                const f = FOLDER_META[fid];
                if (!f) return null;
                return (
                  <button key={f.id} className={`nav-item ${isFolder(f.id) && !(f.id === 'inbox' && pinnedActive) ? 'active' : ''}`}
                    style={{ ['--i' as string]: navIdx++ }}
                    onClick={() => setView({ type: 'folder', folder: f.id })}>
                    <Icon name={f.icon} size={16} /> {f.name}
                    {BADGE_FOLDERS.has(f.id) && <BumpCount value={countFor(f.id)} />}
                  </button>
                );
              })}
            </Fragment>
          );
        })}
        {(counts?.labels.length ?? 0) > 0 && <div className="nav-section">標籤</div>}
        {/* F4.5b：標籤 2 層樹——父標籤可摺疊，子標籤縮排。 */}
        {counts && buildLabelTree(counts.labels).map((node) => {
          const hasKids = node.children.length > 0;
          const isCollapsed = collapsed.has(node.id);
          const labelBtn = (l: { id: string; name: string; color: string; count: number }, child: boolean) => (
            <button key={l.id}
              className={`nav-item ${child ? 'nav-child' : ''} ${view.type === 'label' && view.id === l.id ? 'active' : ''} ${dragOver === l.id ? 'drop-target' : ''}`}
              style={{ ['--i' as string]: navIdx++, ...(child ? { paddingLeft: 34 } : {}) }}
              onClick={() => setView({ type: 'label', id: l.id })}
              onDragOver={(e) => { e.preventDefault(); setDragOver(l.id); }}
              onDragLeave={() => setDragOver((cur) => (cur === l.id ? null : cur))}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(null);
                const mid = e.dataTransfer.getData('text/x-miseroda-msg');
                if (mid) onDropLabel(l.id, mid);
              }}>
              {!child && hasKids && (
                <span role="button" tabIndex={0} aria-label={isCollapsed ? '展開' : '摺疊'} className="label-chevron"
                  onClick={(e) => { e.stopPropagation(); setCollapsed((s) => { const n = new Set(s); if (n.has(node.id)) n.delete(node.id); else n.add(node.id); return n; }); }}
                  style={{ transform: isCollapsed ? 'rotate(-90deg)' : 'none' }}>
                  <Icon name="chevronDown" size={13} />
                </span>
              )}
              <span className="label-dot" style={{ background: l.color }}></span> {l.name}
              <BumpCount value={l.count || ''} />
            </button>
          );
          return (
            <Fragment key={node.id}>
              {labelBtn(node, false)}
              {hasKids && !isCollapsed && node.children.map((ch) => labelBtn(ch, true))}
            </Fragment>
          );
        })}
        {/* F5.6a：釘到側欄的自訂視圖（儲存搜尋）。點擊 = 在收件匣跑該搜尋。 */}
        {pinnedSearches.length > 0 && <div className="nav-section">自訂視圖</div>}
        {pinnedSearches.map((s) => (
          <button key={s.id} className={`nav-item ${view.type === 'folder' && view.folder === 'inbox' && query === s.query ? 'active' : ''}`}
            style={{ ['--i' as string]: navIdx++ }} title={s.query}
            onClick={() => onRunSavedSearch(s.query)}>
            <Icon name="search" size={16} /> <span className="ss-nav-name">{s.name}</span>
          </button>
        ))}
        <div className="nav-section">工作空間</div>
        <button className={`nav-item nav-today ${view.type === 'agenda' ? 'active' : ''}`} style={{ ['--i' as string]: navIdx++ }}
          onClick={() => setView({ type: 'agenda' })}>
          <Icon name="clock" size={16} /> 今日
        </button>

        <button className={`nav-item ${view.type === 'calendar' ? 'active' : ''}`} style={{ ['--i' as string]: navIdx++ }}
          onClick={() => setView({ type: 'calendar' })}>
          <Icon name="clock" size={16} /> 行事曆
        </button>
        <button className={`nav-item ${view.type === 'followups' ? 'active' : ''}`} style={{ ['--i' as string]: navIdx++ }}
          onClick={() => setView({ type: 'followups' })}>
          <Icon name="flag" size={16} /> 跟進
          <span className="count">{counts?.followups || ''}</span>
        </button>
        <button className={`nav-item ${view.type === 'contacts' ? 'active' : ''}`} style={{ ['--i' as string]: navIdx++ }}
          onClick={() => setView({ type: 'contacts' })}>
          <Icon name="user" size={16} /> 聯絡人
        </button>
        <button className={`nav-item ${view.type === 'files' ? 'active' : ''}`} style={{ ['--i' as string]: navIdx++ }}
          onClick={() => setView({ type: 'files' })}>
          <Icon name="clip" size={16} /> 檔案
        </button>
        <div className="nav-section">系統</div>
        <button className={`nav-item ${view.type === 'settings' ? 'active' : ''}`} style={{ ['--i' as string]: navIdx++ }}
          onClick={() => setView({ type: 'settings' })}>
          <Icon name="settings" size={16} /> 設定
        </button>
        {me.user.role === 'admin' && (
          <button className={`nav-item ${view.type === 'admin' ? 'active' : ''}`} style={{ ['--i' as string]: navIdx++ }}
            onClick={() => setView({ type: 'admin' })}>
            <Icon name="shield" size={16} /> 管理後台
          </button>
        )}
      </nav>
    </aside>
  );
}

/* ---------- 寄送中/失敗 outbox 條（寄件備份頂部） ---------- */
function OutboxStrip({ items, onRetry, onCancel, onResolve }: {
  items: OutboxItem[];
  onRetry: (id: string) => void;
  onCancel: (id: string) => void;
  onResolve: (id: string, decision: 'resend' | 'sent' | 'discard') => void;
}) {
  if (!items.length) return null;
  return (
    <div className="outbox-strip">
      {items.map((o) => {
        const badge = o.status === 'review'
          ? { cls: 'amber', label: '外送待確認' }
          : o.status === 'failed'
            ? { cls: 'red', label: '寄送失敗' }
            : o.status === 'sending'
              ? { cls: 'amber', label: '寄送中' }
              : { cls: 'amber', label: '排程中' };
        return (
          <div key={o.id} className="outbox-item">
            <span className={`badge ${badge.cls}`} style={{ flex: 'none' }}>{badge.label}</span>
            <div className="ox-main">
              <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.subject || '（無主旨）'}</div>
              <div className="ox-sub">
                {o.status === 'review'
                  ? '外送中斷，結果未確認——這封外部信可能已送出，也可能沒有'
                  : o.status === 'failed' ? (o.lastError ?? '寄送失敗') : `致 ${o.to.join('、')}`}
                {o.status === 'scheduled' && ` · ${fullTime(o.scheduledAt)}`}
              </div>
            </div>
            {o.status === 'review' && (
              <div style={{ display: 'flex', gap: 4, flex: 'none' }}>
                <button className="btn btn-ghost btn-sm" data-tooltip="已向對方確認收到，只補寄件備份（不再外送）"
                  onClick={() => onResolve(o.id, 'sent')}>已送達</button>
                <button className="btn btn-ghost btn-sm" style={{ color: 'var(--danger)' }}
                  data-tooltip="確認對方沒收到才按——若其實已送出，對方會收到兩封"
                  onClick={() => onResolve(o.id, 'resend')}>未送達，重寄</button>
                <button className="btn btn-ghost btn-sm" data-tooltip="放棄外送、不再嘗試（站內副本已送達、不受影響）"
                  onClick={() => onResolve(o.id, 'discard')}>放棄外送</button>
              </div>
            )}
            {o.status === 'failed' && (
              <button className="iconbtn" data-tooltip="重寄" aria-label="重寄" onClick={() => onRetry(o.id)}><Icon name="refresh" size={15} /></button>
            )}
            {o.status === 'scheduled' && (
              <button className="iconbtn" data-tooltip="取消排程" aria-label="取消排程" onClick={() => onCancel(o.id)}><Icon name="x" size={14} /></button>
            )}
          </div>
        );
      })}
    </div>
  );
}

export interface BatchHandlers {
  selected: Set<string>;
  onToggleSelect: (id: string, shift: boolean) => void;
  onSelectAll: () => void;
  onClearSelect: () => void;
  onBatchArchive: () => void;
  onBatchTrash: () => void;
  onBatchRead: (read: boolean) => void;
  onBatchStar: (starred: boolean) => void;
}

/* ---------- 快速篩選 chips（搜尋運算子的視覺化入口） ---------- */
const QUICK_FILTERS: { token: string; label: string; icon: 'mail' | 'clip' | 'star' }[] = [
  { token: 'is:unread', label: '未讀', icon: 'mail' },
  { token: 'has:attachment', label: '附件', icon: 'clip' },
  { token: 'is:starred', label: '星標', icon: 'star' },
];

function toggleToken(query: string, token: string): string {
  const parts = query.split(/\s+/).filter(Boolean);
  return (parts.includes(token) ? parts.filter((p) => p !== token) : [...parts, token]).join(' ');
}

/* ---------- F2.6 全域搜尋分區（信件已在下方列表，這裡補聯絡人/會議/跟進） ---------- */
function GlobalSearchStrip({ q, onComposeTo, onGotoCalendar, onGotoFollowups }: {
  q: string;
  onComposeTo?: (email: string) => void;
  onGotoCalendar?: () => void;
  onGotoFollowups?: () => void;
}) {
  // 自帶 250ms debounce，避免逐字打字狂打端點
  const [dq, setDq] = useState(q);
  useEffect(() => {
    const t = setTimeout(() => setDq(q), 250);
    return () => clearTimeout(t);
  }, [q]);
  const res = useGlobalSearch(dq);
  const d = res.data;
  // 結果需對應「目前實際輸入 q」才顯示：打字中 dq 還沒追上、或新查詢 fetch 在途，都先不顯示舊結果（避免殘留）
  if (!d || d.q !== q) return null;
  if (!d.contacts.length && !d.events.length && !d.followUps.length) return null;
  return (
    <div className="gsearch">
      {d.contacts.length > 0 && (
        <div className="gsearch-sec">
          <div className="gsearch-head"><Icon name="user" size={12} /> 聯絡人</div>
          {d.contacts.map((ct) => (
            <button key={ct.email} className="gsearch-row" onClick={() => onComposeTo?.(ct.email)} title={`寫信給 ${ct.email}`}>
              <span className="gsearch-main">{ct.name || ct.email.split('@')[0]}</span>
              <span className="gsearch-meta">{ct.email}</span>
            </button>
          ))}
        </div>
      )}
      {d.events.length > 0 && (
        <div className="gsearch-sec">
          <div className="gsearch-head"><Icon name="calendar" size={12} /> 會議</div>
          {d.events.map((ev) => (
            <button key={ev.id} className="gsearch-row" onClick={() => onGotoCalendar?.()}>
              <span className="gsearch-main">{ev.summary || '(無標題)'}</span>
              <span className="gsearch-meta">{ev.floating || ev.allDay ? ev.startText : fullTime(ev.startMs)}</span>
            </button>
          ))}
        </div>
      )}
      {d.followUps.length > 0 && (
        <div className="gsearch-sec">
          <div className="gsearch-head"><Icon name="flag" size={12} /> 跟進</div>
          {d.followUps.map((f) => (
            <button key={f.id} className="gsearch-row" onClick={() => onGotoFollowups?.()}>
              <span className="gsearch-main">{f.subject || '(無主旨)'}</span>
              <span className="gsearch-meta">{fullTime(f.dueAt)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// F6.4：訊息列表 FLIP reflow——記錄每個 data-mid 的「內容相對」top，更新後算 delta，用 WAAPI 反推+play，
// 讓星標/刪除/規則套用後剩餘項平滑滑動非跳動。設計要點（皆 Codex 對抗式自審後定）：
//  - 位置用 content-relative（top - 容器 top + scrollTop）→ 捲動不會被誤判成位移（避免 bogus delta 亂跳）。
//  - 用 el.animate()（WAAPI）而非 inline transition → 不殘留 transition 拖累後續 swipe、不漏 transitionend、與 swipe 的 inline transform 不長期打架。
//  - 動效關 / >30 項：不動畫、不量測（省 forced reflow）、清基準（避免下次用過期基準算出 bogus delta）。
//  - READ 全量測完再 WRITE，避免 read/write 交錯的 layout thrash。
function useListFlip(containerRef: React.RefObject<HTMLDivElement | null>, dep: unknown) {
  const prev = useRef<Map<string, number>>(new Map());
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const motionOn = document.documentElement.getAttribute('data-motion') === 'on';
    const items = Array.from(container.querySelectorAll<HTMLElement>('.msg-item[data-mid]'));
    if (!motionOn || items.length > 30) { prev.current = new Map(); return; }
    const cTop = container.getBoundingClientRect().top;
    const scroll = container.scrollTop;
    const next = new Map<string, number>();
    const moves: { el: HTMLElement; delta: number }[] = [];
    for (const el of items) { // READ
      const mid = el.dataset.mid ?? '';
      const top = el.getBoundingClientRect().top - cTop + scroll; // content-relative，與捲動無關
      next.set(mid, top);
      const old = prev.current.get(mid);
      if (old !== undefined && Math.abs(old - top) > 1) moves.push({ el, delta: old - top });
    }
    prev.current = next;
    for (const { el, delta } of moves) { // WRITE（WAAPI：不留 inline 樣式、自動清理）
      el.animate?.([{ transform: `translateY(${delta}px)` }, { transform: 'none' }], { duration: 320, easing: 'cubic-bezier(.22,1,.36,1)' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dep]);
}

/* ---------- 信件列表 ---------- */
// F6.6：內容感知骨架——切資料夾/搜尋 loading 且無快取時，渲染數條與 msg-item 同形的骨架（頭像圈 + 三行 shimmer），
// 用同一 --i stagger 無縫接真實 item-in。shimmer 已由 [data-motion="on"] .skeleton 自動綁動效。
function MessageRowSkeleton({ i }: { i: number }) {
  return (
    <div className="msg-item sk-row" style={{ ['--i' as string]: i }} aria-hidden="true">
      <div className="skeleton sk-avatar"></div>
      <div className="sk-lines">
        <div className="skeleton" style={{ height: 11, width: '38%' }}></div>
        <div className="skeleton" style={{ height: 13, width: `${72 + ((i * 7) % 18)}%` }}></div>
        <div className="skeleton" style={{ height: 11, width: `${82 + ((i * 5) % 12)}%` }}></div>
      </div>
    </div>
  );
}

export function MessageList({ items, view, query, setQuery, morphId, selectedId, cursorId, onOpen, onToggleStar, inboxCategory, onSelectCategory, categoryCounts, glance, labelsById, contactNames, searchRef, searchHost, onMenu, loading, leavingIds, bouncingStarId, hasMore, loadingMore, onLoadMore, outbox, onRetrySend, onCancelScheduled, onResolveSend, batch, onSwipeArchive, onSwipeTrash, onSnooze, onSpam, onAddLabel, onComposeTo, onGotoCalendar, onGotoFollowups, onBatchByView, onRouteNewslettersOut, onRefresh, onPrefetch, pushToast }: {
  items: MsgListItem[];
  view: View;
  query: string;
  setQuery: (q: string) => void;
  morphId?: string | null; // F6.1：手機開信主旨 morph 進行中的信 id
  selectedId: string | null;
  cursorId: string | null;
  onOpen: (id: string) => void;
  onToggleStar: (m: MsgListItem) => void;
  inboxCategory: InboxCategory;
  onSelectCategory: (c: InboxCategory) => void;
  categoryCounts: Counts['inboxCategories'] | undefined;
  glance?: { unread: number; needsReply: number; bills: number }; // F7.9：今日未讀速覽
  labelsById: Record<string, { name: string; color: string }>;
  contactNames: Map<string, string>;
  searchRef: React.RefObject<HTMLInputElement | null>;
  searchHost?: HTMLElement | null;
  onMenu: () => void;
  loading: boolean;
  leavingIds: Set<string>;
  bouncingStarId: string | null;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  outbox: OutboxItem[];
  onRetrySend: (id: string) => void;
  onCancelScheduled: (id: string) => void;
  onResolveSend: (id: string, decision: 'resend' | 'sent' | 'discard') => void;
  batch: BatchHandlers;
  onSwipeArchive: (id: string) => void;
  onSwipeTrash: (id: string) => void;
  onSnooze: (id: string, until: number) => void; // F6.9：情境選單「稍後處理」
  onSpam: (id: string) => void; // F6.9：情境選單「回報垃圾」
  onAddLabel: (id: string, labelId: string) => void; // F6.9：情境選單「加標籤」
  onComposeTo?: (email: string) => void;
  onGotoCalendar?: () => void;
  onGotoFollowups?: () => void;
  onBatchByView?: (view: 'newsletter' | 'receipt', action: 'read' | 'archive') => void; // F4.7
  onRouteNewslettersOut?: () => void; // F5.6b：opt-in 電子報移出主收件匣
  onRefresh?: () => Promise<unknown> | void; // F14.4B：下拉刷新
  onPrefetch?: (id: string) => void; // 效能：滑過列表列先抓內容
  pushToast?: (text: string) => void; // 分類分頁未讀 badge「跳到第一封未讀」找不到時提示
}) {
  const listRef = useScrollFog<HTMLDivElement>();
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined); // 預取的停留去抖
  useListFlip(listRef, items); // F6.4：星標/刪除/規則套用後剩餘項平滑滑動（非跳動）

  // 分類分頁未讀 badge「跳到第一封未讀」：目前已載入的頁面找不到時，最多補抓 3 頁再找。
  const [unreadHunt, setUnreadHunt] = useState<{ cat: InboxCategory; attempts: number } | null>(null);
  // 追蹤上一輪的 loadingMore，只有觀察到 true→false 的轉換（=剛才那次 onLoadMore 真的跑完一頁）
  // 才允許累加 attempts；否則 setUnreadHunt(attempts+1) 與 onLoadMore() 同批送出時，loadingMore
  // 還沒轉 true，下一輪 effect 會誤判「這頁沒有未讀」而空轉扣掉一次 attempt，導致抓不到 3 頁就提早放棄。
  const wasLoadingMoreRef = useRef(loadingMore);
  useEffect(() => {
    const wasLoadingMore = wasLoadingMoreRef.current;
    wasLoadingMoreRef.current = loadingMore;
    if (!unreadHunt) return;
    if (inboxCategory !== unreadHunt.cat) return; // 分頁切換尚未套用到 items，等下一輪
    if (loading || loadingMore) return; // 資料還在載入中，先不判定，避免看到半頁就誤判「找不到」
    if (unreadHunt.attempts > 0 && !wasLoadingMore) return; // 剛觸發的 onLoadMore 還沒真的進入過載入中，再等一輪
    const target = items.find((m) => m.unread);
    if (target) {
      onOpen(target.id);
      const row = listRef.current?.querySelector<HTMLElement>(`[data-mid="${target.id}"]`);
      row?.scrollIntoView({ block: 'nearest' });
      setUnreadHunt(null);
      return;
    }
    if (unreadHunt.attempts >= 3 || !hasMore) {
      pushToast?.('未讀在更早的信件中，請繼續往下捲');
      setUnreadHunt(null);
      return;
    }
    setUnreadHunt((h) => (h ? { ...h, attempts: h.attempts + 1 } : h));
    onLoadMore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unreadHunt, items, loading, loadingMore, inboxCategory, hasMore]);
  // F14.4B：行動裝置下拉刷新——列表捲到頂 + 向下拉超過門檻 → onRefresh。resistance 0.5、上限 80px。
  const PULL_MAX = 80;
  const PULL_TRIGGER = 48;
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const pullStartY = useRef<number | null>(null);
  const onPullStart = (e: React.TouchEvent) => {
    if (!onRefresh || refreshing) return;
    const el = listRef.current;
    const coarse = !!window.matchMedia?.('(pointer: coarse)').matches;
    pullStartY.current = coarse && el && el.scrollTop <= 0 ? e.touches[0].clientY : null;
  };
  const onPullMove = (e: React.TouchEvent) => {
    if (pullStartY.current == null) return;
    const dy = e.touches[0].clientY - pullStartY.current;
    if (dy > 0 && (listRef.current?.scrollTop ?? 0) <= 0) setPull(Math.min(dy * 0.5, PULL_MAX));
    else { pullStartY.current = null; setPull(0); }
  };
  const onPullEnd = () => {
    if (pullStartY.current == null) return;
    const trigger = pull >= PULL_TRIGGER;
    pullStartY.current = null;
    if (trigger && onRefresh) {
      setRefreshing(true);
      setPull(PULL_TRIGGER);
      void Promise.resolve(onRefresh()).finally(() => { setRefreshing(false); setPull(0); });
    } else {
      setPull(0);
    }
  };
  // 新信抵達 glow（動畫 5）：refetch 後出現的新 id 標記 1.2s
  const prevIdsRef = useRef<Set<string> | null>(null);
  const [freshIds, setFreshIds] = useState<Set<string>>(() => new Set());
  // F8.10：剛從「稍後處理」到期浮回的信 → 給時鐘微動畫（有別於全新來信的極光脈衝）
  const [snoozeReturnIds, setSnoozeReturnIds] = useState<Set<string>>(() => new Set());
  const itemsKey = items.map((m) => m.id).join(',');
  useEffect(() => {
    const cur = new Set(items.map((m) => m.id));
    if (prevIdsRef.current && prevIdsRef.current.size > 0) {
      const freshItems = items.filter((m) => !prevIdsRef.current!.has(m.id));
      if (freshItems.length && freshItems.length < 10) {
        const now = Date.now();
        const brandNew = new Set<string>();
        const returned = new Set<string>();
        for (const m of freshItems) {
          // snoozedUntil 為過去且發生在近 12 小時內 → 判定為剛浮回（避免舊 snooze 因無關 refetch 誤判）
          if (m.snoozedUntil != null && m.snoozedUntil <= now && now - m.snoozedUntil < 12 * 3600_000) returned.add(m.id);
          else brandNew.add(m.id);
        }
        setFreshIds(brandNew);
        setSnoozeReturnIds(returned);
        const t = setTimeout(() => { setFreshIds(new Set()); setSnoozeReturnIds(new Set()); }, 1400);
        prevIdsRef.current = cur;
        return () => clearTimeout(t);
      }
    }
    prevIdsRef.current = cur;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemsKey]);

  // 手機滑動手勢：右滑封存 / 左滑刪除
  const swipeRef = useRef<{ id: string; startX: number; startY: number; dx: number; canceled: boolean; crossed: boolean } | null>(null);
  const [swipe, setSwipe] = useState<{ id: string; dx: number; snapping?: boolean } | null>(null);
  // F6.9：長按（手機）/ 右鍵（桌機）統一情境選單。與 swipe 互斥：位移 >10px 取消長按計時。
  const [menu, setMenu] = useState<{ msg: MsgListItem; x?: number; y?: number; sheet: boolean } | null>(null);
  const [menuSub, setMenuSub] = useState<null | 'snooze' | 'label'>(null);
  const [snoozeCustomFor, setSnoozeCustomFor] = useState<string | null>(null); // F9.6：自訂 snooze 的目標信
  const longPressRef = useRef<number | null>(null);
  const longPressFired = useRef(false); // 阻止長按後合成 click 又把信點開
  const clearLP = () => { if (longPressRef.current) { clearTimeout(longPressRef.current); longPressRef.current = null; } };
  const openMenu = (msg: MsgListItem, opts: { x?: number; y?: number; sheet: boolean }) => { setMenuSub(null); setMenu({ msg, ...opts }); };
  // 關閉時一併清 longPressFired：否則「長按A→scrim/Esc關→點B」會被殘留的 true 吃掉、B 打不開
  const closeMenu = () => { setMenu(null); setMenuSub(null); longPressFired.current = false; };
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); closeMenu(); } };
    document.addEventListener('keydown', onKey, true); // capture：搶在 App 全域 Esc 前關自己
    return () => document.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menu]);
  // 選單目標信若已離開列表（封存/刪除/換資料夾）→ 關掉殘留選單（只在該信真的消失時，不被背景刷新誤關）
  useEffect(() => {
    if (menu && !items.some((m) => m.id === menu.msg.id)) { setMenu(null); setMenuSub(null); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, menu]);
  const onTouchStart = (id: string) => (e: React.TouchEvent) => {
    // 觸控起點落在星標/勾選框 → 不啟動 swipe 也不啟動長按，讓按鈕自己的 onClick 處理（觸控事件不像 click 會被 stopPropagation 擋）。
    // 一併清掉殘留 swipeRef/計時器，避免後續 onTouchMove 讀到上一手勢的舊狀態誤觸發。
    if ((e.target as HTMLElement).closest('.star-btn, .msg-check')) { swipeRef.current = null; clearLP(); return; }
    const t = e.touches[0];
    swipeRef.current = { id, startX: t.clientX, startY: t.clientY, dx: 0, canceled: false, crossed: false };
    longPressFired.current = false;
    clearLP();
    longPressRef.current = window.setTimeout(() => {
      longPressRef.current = null;
      const s = swipeRef.current;
      if (!s || s.canceled || Math.abs(s.dx) > 10) return; // 已位移＝滑動/捲動，不是長按
      s.canceled = true;           // 阻止 touchend 的 swipe 判定
      longPressFired.current = true; // 阻止隨後合成 click
      setSwipe(null);
      haptics.impact();
      const msg = items.find((m) => m.id === id);
      if (msg) openMenu(msg, { sheet: true });
    }, 450);
  };
  const onTouchMove = (e: React.TouchEvent) => {
    const s = swipeRef.current;
    if (!s || s.canceled) return;
    const t = e.touches[0];
    const dx = t.clientX - s.startX;
    const dy = t.clientY - s.startY;
    if (Math.abs(dx) > 10 || Math.abs(dy) > 10) clearLP(); // 移動 → 取消長按
    if (Math.abs(dy) > 40 && Math.abs(dy) > Math.abs(dx)) {
      s.canceled = true;
      setSwipe(null);
      return;
    }
    s.dx = dx;
    // F3.4：跨過封存/刪除閾值的那一瞬給觸覺回饋（只觸發一次；退回再進可再觸發）
    const over = Math.abs(dx) > SWIPE_THRESHOLD;
    if (over && !s.crossed) haptics.tap();
    s.crossed = over;
    if (Math.abs(dx) > 8) setSwipe({ id: s.id, dx });
  };
  const onTouchEnd = () => {
    clearLP();
    const s = swipeRef.current;
    swipeRef.current = null;
    if (!s || s.canceled) { setSwipe(null); return; }
    const threshold = SWIPE_THRESHOLD;
    if (s.dx > threshold) { setSwipe(null); onSwipeArchive(s.id); }       // 達閾值：交給既有 msg-leave 滑出
    else if (s.dx < -threshold) { setSwipe(null); onSwipeTrash(s.id); }
    else if (Math.abs(s.dx) > 4) {
      // F3.5：未達閾值 → 加 snapping transition 優雅彈回 0，動畫結束後清除（只清自己、不蓋掉新的滑動）
      setSwipe({ id: s.id, dx: 0, snapping: true });
      window.setTimeout(() => setSwipe((cur) => (cur && cur.id === s.id && cur.snapping ? null : cur)), 280);
    } else {
      setSwipe(null);
    }
  };
  useEffect(() => {
    if (!cursorId || !listRef.current) return;
    const el = listRef.current.querySelector(`[data-mid="${cursorId}"]`);
    if (el) {
      const r = el.getBoundingClientRect(), pr = listRef.current.getBoundingClientRect();
      if (r.top < pr.top) listRef.current.scrollTop += r.top - pr.top - 8;
      else if (r.bottom > pr.bottom) listRef.current.scrollTop += r.bottom - pr.bottom + 8;
    }
  }, [cursorId, listRef]);

  // 無限捲動：底部 sentinel 進入視窗（含 400px 預取邊界）就載入下一頁。
  // 用 ref 持有最新 callback/旗標，IO 只在掛載時建立一次（避免每次 render 重建）。
  const sentinelRef = useRef<HTMLDivElement>(null);
  const loadMoreRef = useRef(onLoadMore);
  loadMoreRef.current = onLoadMore;
  const canLoadRef = useRef(false);
  canLoadRef.current = hasMore && !loadingMore;
  useEffect(() => {
    const root = listRef.current;
    const target = sentinelRef.current;
    if (!root || !target) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && canLoadRef.current) loadMoreRef.current();
      },
      { root, rootMargin: '400px 0px' },
    );
    io.observe(target);
    return () => io.disconnect();
  }, [listRef]);

  const selCount = batch.selected.size;
  const aiSearch = useAiSearch();
  const savedSearches = useSavedSearches();
  const saveSearch = useSaveSearch();
  const deleteSavedSearch = useDeleteSavedSearch();
  const pinSavedSearch = usePinSavedSearch();
  const allSelected = items.length > 0 && items.every((m) => batch.selected.has(m.id));
  const allUnread = items.filter((m) => batch.selected.has(m.id)).every((m) => m.unread);
  const listKey = view.type === 'folder' ? view.folder : view.type === 'label' ? view.id : '';
  const spec = parseSearch(query);
  const hl = spec.text; // 高亮只針對自由文字，不含運算子
  const fmtDay = (t: number) => { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()}`; };
  const filterChips: string[] = [];
  if (spec.from) filterChips.push(`寄件者：${spec.from}`);
  if (spec.to) filterChips.push(`收件者：${spec.to}`);
  if (spec.cc) filterChips.push(`副本：${spec.cc}`);
  if (spec.bcc) filterChips.push(`密件副本：${spec.bcc}`);
  if (spec.subject) filterChips.push(`主旨：${spec.subject}`);
  if (spec.hasAttachment) filterChips.push('含附件');
  if (spec.isUnread) filterChips.push('未讀');
  if (spec.isStarred) filterChips.push('已星標');
  if (spec.label) filterChips.push(`標籤：${spec.label}`);
  if (spec.before) filterChips.push(`早於 ${fmtDay(spec.before)}`);
  if (spec.after) filterChips.push(`晚於 ${fmtDay(spec.after)}`);

  const viewName = view.type === 'label'
    ? `標籤：${labelsById[view.id]?.name ?? ''}`
    : view.type === 'folder'
      ? (FOLDERS.find((f) => f.id === view.folder)?.name ?? '')
      : '';

  let empty: React.ReactNode = null;
  if (!items.length && !loading) {
    const folder = view.type === 'folder' ? view.folder : '';
    if (query) empty = <EmptyState pose="search" title="找不到符合的信件" sub={`沒有信件符合「${query}」，換個關鍵字試試？`}
      action={<button className="btn btn-secondary btn-sm" onClick={() => setQuery('')}><Icon name="x" size={14} /> 清除搜尋條件</button>} />;
    else if (folder === 'trash') empty = <EmptyState pose="sweep" title="這裡空空如也" sub="垃圾桶已清空，Pori 把地都掃乾淨了。" />;
    else if (folder === 'spam') empty = <EmptyState pose="sweep" title="沒有垃圾信" sub="SPF/DKIM 守門員今天零失誤。" />;
    else if (folder === 'snoozed') empty = <EmptyState pose="happy" title="沒有稍後處理的信" sub="在信件上按貪睡鈕，到點會自動回到收件匣。" />;
    else if (folder === 'inbox' && inboxCategory !== 'primary')
      empty = <EmptyState pose="happy" title={`「${CATEGORY_LABEL[inboxCategory]}」目前沒有信件`} sub="這個分類還沒有信，到其他分頁看看？"
        action={<button className="btn btn-secondary btn-sm" onClick={() => onSelectCategory('primary')}>回主要分頁</button>} />;
    else if (folder === 'inbox') empty = <EmptyState pose="wave" title="信箱乾乾淨淨，像剛下的雪 ❄️" sub="收件匣零負擔！要不要開始寫第一封？"
      action={onComposeTo ? <button className="btn btn-primary btn-sm" onClick={() => onComposeTo('')}><Icon name="pen" size={14} /> 寫信</button> : undefined} />;
    else empty = <EmptyState pose="happy" title="這裡沒有信件" />;
  }

  const searchBar = (
    <div className="mail-search" role="search" aria-label="搜尋郵件">
      <button className="iconbtn mobile-only" aria-label="開啟選單" onClick={onMenu}><Icon name="menu" /></button>
      <div className="searchbar" style={{ flex: 1 }}>
        <Icon name="search" size={15} />
        <input ref={searchRef} className="input" maxLength={500} placeholder="搜尋… from: subject: has:attachment larger:5m older_than:1y filename:（值用 | 表或），或 ✨ 自然語言找信" aria-describedby="mail-search-help"
          value={query} onChange={(e) => setQuery(e.target.value)} aria-label="搜尋信件" />
      </div>
      <button className="iconbtn" data-tooltip="AI 找信：把自然語言轉成搜尋（先在搜尋框輸入需求）" aria-label="AI 找信"
        disabled={!query.trim() || aiSearch.isPending}
        onClick={() => aiSearch.mutate(query.trim(), { onSuccess: (r) => r.query && setQuery(r.query) })}>
        <Icon name="sparkle" size={16} />
      </button>
      {query && <button className="iconbtn" aria-label="清除搜尋" onClick={() => { setQuery(''); searchRef.current?.focus(); }}><Icon name="x" size={15} /></button>}
      <span id="mail-search-help" className="sr-only">支援 from:、subject:、has:attachment 等條件，或輸入自然語言後按 AI 找信。</span>
      {query.trim() && (() => {
        const qv = query.trim();
        const alreadySaved = savedSearches.data?.searches.some((s) => s.query === qv) ?? false;
        const atLimit = (savedSearches.data?.searches.length ?? 0) >= 50;
        return (
          <button className="iconbtn" aria-label="儲存搜尋"
            data-tooltip={alreadySaved ? '此搜尋已儲存' : atLimit ? '儲存搜尋已達上限（50）' : '儲存目前搜尋'}
            disabled={saveSearch.isPending || alreadySaved || atLimit}
            onClick={() => saveSearch.mutate({ name: qv.slice(0, 80), query: qv })}>
            <Icon name="flag" size={16} />
          </button>
        );
      })()}
    </div>
  );

  return (
    <section className="listpane" aria-label="信件列表">
      <div className="listpane-head">
        {searchHost ? createPortal(searchBar, searchHost) : searchBar}
        <h2 className="mail-list-title">{viewName}</h2>
        <div className="filter-chips">
          {QUICK_FILTERS.map((f) => {
            const on = query.split(/\s+/).includes(f.token);
            return (
              <button key={f.token} type="button"
                className={`chip qf-chip ${on ? 'on' : ''}`} aria-pressed={on}
                onClick={() => setQuery(toggleToken(query, f.token))}>
                <Icon name={f.icon} size={11} /> {f.label}
              </button>
            );
          })}
          {filterChips.map((ch) => (
            <span key={ch} className="chip" style={{ background: 'var(--bg-elevated)', color: 'var(--text-secondary)' }}>{ch}</span>
          ))}
        </div>
        {(savedSearches.data?.searches.length ?? 0) > 0 && (
          <div className="filter-chips" style={{ marginTop: 2 }}>
            {savedSearches.data!.searches.map((s) => (
              <span key={s.id} className={`saved-chip${s.pinned ? ' pinned' : ''}`}>
                <button type="button" className="ss-go" onClick={() => setQuery(s.query)} title={s.query}>
                  <Icon name="flag" size={11} /> <span className="ss-name">{s.name}</span>
                </button>
                <button type="button" className="ss-pin" aria-label={s.pinned ? '從側欄取消釘選' : '釘到側欄'} data-tooltip={s.pinned ? '從側欄取消釘選' : '釘到側欄'}
                  onClick={() => pinSavedSearch.mutate({ id: s.id, pinned: !s.pinned })}>
                  <Icon name="pin" size={11} />
                </button>
                <button type="button" className="ss-x" aria-label="刪除儲存搜尋" onClick={() => deleteSavedSearch.mutate(s.id)}>
                  <Icon name="x" size={11} />
                </button>
              </span>
            ))}
          </div>
        )}
        {selCount > 0 ? (
          <div className="batch-bar">
            <button className="iconbtn" aria-label={allSelected ? '取消全選' : '全選'} data-tooltip={allSelected ? '取消全選' : '全選'}
              onClick={allSelected ? batch.onClearSelect : batch.onSelectAll}>
              <Icon name={allSelected ? 'checksquare' : 'square'} size={16} />
            </button>
            <span style={{ fontSize: 13, fontWeight: 600 }}>已選 {selCount}</span>
            <div style={{ flex: 1 }}></div>
            <button className="iconbtn" data-tooltip={allUnread ? '標為已讀' : '標為未讀'} aria-label="已讀切換"
              onClick={() => batch.onBatchRead(allUnread)}><Icon name="mail" size={16} /></button>
            <button className="iconbtn" data-tooltip="星標" aria-label="星標" onClick={() => batch.onBatchStar(true)}><Icon name="star" size={16} /></button>
            <button className="iconbtn" data-tooltip="封存" aria-label="封存" onClick={batch.onBatchArchive}><Icon name="archive" size={16} /></button>
            <button className="iconbtn" data-tooltip="刪除" aria-label="刪除" onClick={batch.onBatchTrash}><Icon name="trash" size={16} /></button>
            <button className="iconbtn" data-tooltip="取消選取" aria-label="取消選取" onClick={batch.onClearSelect}><Icon name="x" size={15} /></button>
          </div>
        ) : (
          <div className="listpane-meta">
            <span>{query ? `「${query}」的搜尋結果` : viewName}</span>
            <span style={{ fontFamily: 'var(--font-mono)' }}>{items.length} 封</span>
          </div>
        )}
      </div>
      {/* F3.2 專注回覆佇列：需回信 lane 進度條（回一封自動消一封） */}
      {view.type === 'folder' && view.folder === 'needs_reply' && !query && selCount === 0 && (
        <div className="focus-banner">
          {items.length > 0 ? (
            <><Icon name="reply" size={13} /> 專注回覆 · 還有 <b>{items.length}</b> 封需回信 · 回一封自動消一封</>
          ) : (
            <><Icon name="check" size={13} /> 需回信都回完了 🎉</>
          )}
        </div>
      )}
      {/* F4.7：電子報/收據虛擬夾——一鍵處理整個夾（非僅本頁） */}
      {view.type === 'folder' && (view.folder === 'newsletter' || view.folder === 'receipt') && !query && selCount === 0 && items.length > 0 && onBatchByView && (
        <div className="focus-banner" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <Icon name={view.folder === 'newsletter' ? 'globe' : 'pdf'} size={13} />
          <span>整個{view.folder === 'newsletter' ? '電子報' : '收據'}夾一鍵處理：</span>
          <button className="btn btn-ghost btn-sm" onClick={() => onBatchByView(view.folder as 'newsletter' | 'receipt', 'read')}>全部標已讀</button>
          <button className="btn btn-ghost btn-sm" onClick={() => onBatchByView(view.folder as 'newsletter' | 'receipt', 'archive')}>全部封存</button>
          {view.folder === 'newsletter' && onRouteNewslettersOut && (
            <button className="btn btn-ghost btn-sm" data-tooltip="建立自動規則：未來電子報自動歸檔、不進主收件匣（仍在此視圖）"
              onClick={onRouteNewslettersOut}>
              <Icon name="globe" size={13} /> 移出主收件匣（自動）
            </button>
          )}
        </div>
      )}
      {view.type === 'folder' && view.folder === 'inbox' && !query && selCount === 0 &&
        categoryCounts && categoryCounts.social.total + categoryCounts.promotions.total + categoryCounts.updates.total > 0 && (
        <div className="cat-tabs" role="tablist" aria-label="收件匣分類">
          {INBOX_CATEGORIES.map((cat) => {
            const active = inboxCategory === cat;
            const unread = categoryCounts[cat]?.unread ?? 0;
            return (
              <button key={cat} type="button" role="tab" aria-selected={active}
                className={`cat-tab ${active ? 'active' : ''}`}
                data-tooltip={active && unread > 0 ? '跳到第一封未讀' : undefined}
                aria-label={unread > 0 ? `${CATEGORY_LABEL[cat]}，${unread} 封未讀，再按一次跳到第一封未讀` : undefined}
                onClick={() => {
                  // 已在該分頁且有未讀 → 跳到第一封未讀；否則（或還沒切過去）先切分頁，第二下才跳未讀
                  if (active && unread > 0) setUnreadHunt({ cat, attempts: 0 });
                  else onSelectCategory(cat);
                }}>
                {CATEGORY_LABEL[cat]}
                {unread > 0 && <span className="cat-tab-badge">{unread > 99 ? '99+' : unread}</span>}
              </button>
            );
          })}
        </div>
      )}
      {/* F7.9：收件匣頂端「今日未讀速覽」（純前端聚合既有 counts，零 AI 成本；只在主要分類無搜尋無選取時） */}
      {view.type === 'folder' && view.folder === 'inbox' && inboxCategory === 'primary' && !query && selCount === 0 && glance && glance.unread > 0 && (
        <div className="inbox-glance" role="status">
          <Icon name="sparkle" size={13} />
          <span>
            {(() => {
              const parts: string[] = [];
              if (glance.needsReply) parts.push(`${glance.needsReply} 封需回信`);
              if (glance.bills) parts.push(`${glance.bills} 封促銷`);
              return parts.length
                ? `今日速覽：${parts.join('、')}，其餘可略過`
                : `今日 ${glance.unread} 封未讀`;
            })()}
          </span>
        </div>
      )}
      <div className="msg-list scroll-fog" ref={listRef}
        onTouchStart={onRefresh ? onPullStart : undefined}
        onTouchMove={onRefresh ? onPullMove : undefined}
        onTouchEnd={onRefresh ? onPullEnd : undefined}>
        {/* F14.4B：下拉刷新指示器 */}
        {(pull > 0 || refreshing) && (
          <div className="pull-refresh" style={{ height: pull, opacity: refreshing ? 1 : Math.min(pull / PULL_TRIGGER, 1) }} role="status" aria-live="polite">
            <span className={refreshing ? 'pull-spin' : undefined} style={{ display: 'inline-flex', transform: refreshing ? undefined : `rotate(${pull * 3}deg)` }}>
              <Icon name="refresh" size={18} />
            </span>
            <span>{refreshing ? '刷新中…' : pull >= PULL_TRIGGER ? '放開刷新' : '下拉刷新'}</span>
          </div>
        )}
        <OutboxStrip items={outbox} onRetry={onRetrySend} onCancel={onCancelScheduled} onResolve={onResolveSend} />
        {query.trim().length >= 2 && (
          <GlobalSearchStrip q={query.trim()} onComposeTo={onComposeTo} onGotoCalendar={onGotoCalendar} onGotoFollowups={onGotoFollowups} />
        )}
        {empty}
        {loading && !items.length && (
          <div className="msg-items" aria-busy="true" aria-label="載入中">
            {Array.from({ length: 7 }, (_, i) => <MessageRowSkeleton key={i} i={i} />)}
          </div>
        )}
        <div className="msg-items" key={listKey}>
          {items.map((msg, i) => {
            const isSel = batch.selected.has(msg.id);
            const displayName = contactNames.get(msg.from.addr.toLowerCase()) ?? msg.from.name;
            const sm = swipe?.id === msg.id ? swipe : null;
            const sw = sm && !sm.snapping ? sm.dx : 0;        // 拖曳中的位移（彈回時為 0）
            const snapping = !!sm?.snapping;                  // 放手後彈回中（走 transition）
            const sp = Math.min(Math.abs(sw) / SWIPE_THRESHOLD, 1);        // 拖曳進度 0..1（hint 漸進用）
            const grp = dateGroup(msg.ts);
            const showGroup = i === 0 || dateGroup(items[i - 1].ts) !== grp;
            return (
              <Fragment key={msg.id}>
              {showGroup && <div className="msg-group" aria-hidden="true">{grp}</div>}
              <div className="msg-swipe-wrap">
                {sw !== 0 && (
                  <div className={`swipe-hint ${sw > 0 ? 'right' : 'left'} ${Math.abs(sw) > SWIPE_THRESHOLD ? 'over' : ''}`} aria-hidden="true"
                    style={{ ['--p' as string]: sp }}>
                    <Icon name={sw > 0 ? 'archive' : 'trash'} size={18} />
                  </div>
                )}
                <div data-mid={msg.id}
                  className={`msg-item ${msg.unread ? 'unread' : ''} ${msg.id === selectedId ? 'selected' : ''} ${isSel ? 'checked' : ''} ${msg.id === cursorId && msg.id !== selectedId ? 'kbd-cursor' : ''} ${leavingIds.has(msg.id) ? 'leaving' : ''} ${freshIds.has(msg.id) ? 'fresh' : ''} ${snoozeReturnIds.has(msg.id) ? 'snooze-return' : ''} ${snapping ? 'snapping' : ''}`}
                  style={{ ['--i' as string]: Math.min(i, 10), transform: snapping ? 'translateX(0)' : sw ? `translateX(${sw}px)` : undefined }}
                  role="button" tabIndex={0}
                  // 效能：停留 120ms 才預取（滑鼠快速掃過整列表不會連發數十個請求）；聚焦則立即預取。
                  onMouseEnter={() => {
                    if (!onPrefetch) return;
                    clearTimeout(hoverTimer.current);
                    hoverTimer.current = setTimeout(() => onPrefetch(msg.id), 120);
                  }}
                  onMouseLeave={() => clearTimeout(hoverTimer.current)}
                  onFocus={() => onPrefetch?.(msg.id)}
                  onClick={() => { if (longPressFired.current) { longPressFired.current = false; return; } onOpen(msg.id); }}
                  onContextMenu={(e) => {
                    e.preventDefault(); // 兩平台都壓掉原生選單（含 Android 長按觸發的 contextmenu）
                    // 觸控長按由 onTouchStart 計時器開 sheet；此處只負責桌機右鍵開 popover，避免雙重開啟競態
                    if (typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches) return;
                    openMenu(msg, { x: e.clientX, y: e.clientY, sheet: false });
                  }}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData('text/x-miseroda-msg', msg.id);
                    e.dataTransfer.effectAllowed = 'link';
                  }}
                  onTouchStart={onTouchStart(msg.id)} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}
                  onKeyDown={(e) => { if (e.key === 'Enter') onOpen(msg.id); }}>
                  <span className="unread-bar"></span>
                  <button className="msg-check" aria-label={isSel ? '取消選取' : '選取'}
                    onClick={(e) => { e.stopPropagation(); batch.onToggleSelect(msg.id, (e as React.MouseEvent).shiftKey); }}>
                    <Icon name={isSel ? 'checksquare' : 'square'} size={16} />
                  </button>
                  <div className="msg-item-main">
                    <div className="msg-row1">
                      <span className="msg-from">{highlight(displayName, hl)}</span>
                      {snoozeReturnIds.has(msg.id) && (
                        <span className="snooze-back-chip" aria-hidden="true" data-tooltip="稍後處理到期，已浮回收件匣">
                          <Icon name="snooze" size={12} />
                        </span>
                      )}
                      <span className="msg-time">{timeAgo(msg.ts)}</span>
                    </div>
                    <div className="msg-subject"
                      style={morphId === msg.id && selectedId !== msg.id ? ({ viewTransitionName: `vt-subject-${msg.id}` } as React.CSSProperties) : undefined}>
                      {highlight(msg.subjectOverride ?? msg.subject, hl)}</div>
                    <div className="msg-snippet">{highlight(msg.snippet, hl)}</div>
                    {msg.receiptCard && <div style={{ marginTop: 3 }}><ReceiptBadge card={msg.receiptCard} /></div>}
                    {msg.labels.length > 0 && (
                      <div className="msg-chips">
                        {msg.labels.map((lid) => labelsById[lid] && <LabelChip key={lid} label={labelsById[lid]} />)}
                      </div>
                    )}
                  </div>
                  <div className="msg-flags">
                    {msg.status === 'needs_reply' && <span style={{ color: 'var(--accent)' }} data-tooltip="需回信"><Icon name="reply" size={13} /></span>}
                    {msg.status === 'waiting' && <span style={{ color: 'var(--text-muted)' }} data-tooltip="等待中"><Icon name="clock" size={13} /></span>}
                    {msg.pinned && <span style={{ color: 'var(--accent)' }} data-tooltip="已釘選"><Icon name="pin" size={13} /></span>}
                    <span className={`star-btn ${msg.id === bouncingStarId ? 'pop' : ''}`} role="button" tabIndex={-1}
                      aria-label={msg.starred ? '移除星標' : '加上星標'}
                      onClick={(e) => { e.stopPropagation(); haptics.tap(); onToggleStar(msg); }}
                      style={msg.starred ? { color: 'var(--warning)' } : undefined}>
                      <Icon name={msg.starred ? 'starFill' : 'star'} size={15} />
                    </span>
                    {msg.hasAttachments && <span style={{ color: 'var(--text-muted)' }}><Icon name="clip" size={13} /></span>}
                  </div>
                </div>
              </div>
              </Fragment>
            );
          })}
        </div>
        {/* 無限捲動哨兵 + 載入中提示（僅在還有更多時佔位） */}
        <div ref={sentinelRef} aria-hidden="true" style={{ height: 1 }}></div>
        {loadingMore && (
          <div className="msg-loadmore" aria-live="polite">
            <span className="spinner-sm" aria-hidden="true"></span> 載入更多…
          </div>
        )}
        {!hasMore && items.length >= 50 && !loading && (
          <div className="msg-loadmore msg-loadmore-end">沒有更多信件了</div>
        )}
      </div>
      <div className="kbd-hint">
        <span><kbd>j</kbd>/<kbd>k</kbd> 移動</span>
        <span><kbd>r</kbd> 回覆</span>
        <span><kbd>e</kbd> 封存</span>
        <span><kbd>/</kbd> 搜尋</span>
        <span><kbd>?</kbd> 全部</span>
      </div>
      {menu && (
        // F6.9：手機 = 底部 action-sheet；桌機 = 游標處 popover。scrim 點擊/右鍵都關閉。
        <div className="rowmenu-scrim" onClick={closeMenu} onContextMenu={(e) => { e.preventDefault(); closeMenu(); }}>
          <div role="menu" aria-label="信件動作"
            className={menu.sheet ? 'action-sheet' : 'row-menu'}
            style={menu.sheet ? undefined : {
              left: Math.max(8, Math.min(menu.x ?? 0, (typeof window !== 'undefined' ? window.innerWidth : 800) - 248)),
              top: Math.max(8, Math.min(menu.y ?? 0, (typeof window !== 'undefined' ? window.innerHeight : 600) - Math.min((typeof window !== 'undefined' ? window.innerHeight : 600) * 0.7, 320))),
            }}
            onClick={(e) => e.stopPropagation()}>
            {menu.sheet && <div className="sheet-grab" aria-hidden="true"></div>}
            {menuSub === null && (
              <>
                <button role="menuitem" onClick={() => { onToggleStar(menu.msg); closeMenu(); }}>
                  <Icon name={menu.msg.starred ? 'starFill' : 'star'} size={16} /> {menu.msg.starred ? '移除星標' : '加上星標'}
                </button>
                {Object.keys(labelsById).length > 0 && (
                  <button role="menuitem" onClick={() => setMenuSub('label')}><Icon name="tag" size={16} /> 加標籤 ›</button>
                )}
                <button role="menuitem" onClick={() => setMenuSub('snooze')}><Icon name="snooze" size={16} /> 稍後處理 ›</button>
                <div className="rowmenu-sep" aria-hidden="true"></div>
                <button role="menuitem" onClick={() => { onSwipeArchive(menu.msg.id); closeMenu(); }}><Icon name="archive" size={16} /> 封存</button>
                <button role="menuitem" onClick={() => { onSpam(menu.msg.id); closeMenu(); }}><Icon name="spam" size={16} /> 回報垃圾</button>
                <button role="menuitem" className="danger" onClick={() => { onSwipeTrash(menu.msg.id); closeMenu(); }}><Icon name="trash" size={16} /> 刪除</button>
              </>
            )}
            {menuSub === 'snooze' && (
              <>
                <button className="rowmenu-back" onClick={() => setMenuSub(null)}>‹ 稍後處理</button>
                {snoozePresets().map((p) => (
                  <button key={p.label} role="menuitem" onClick={() => { onSnooze(menu.msg.id, p.at); closeMenu(); }}><Icon name="snooze" size={16} /> {p.label}</button>
                ))}
                {/* F9.6：任意時間 snooze */}
                <button role="menuitem" onClick={() => { setSnoozeCustomFor(menu.msg.id); closeMenu(); }}><Icon name="clock" size={16} /> 自訂時間…</button>
              </>
            )}
            {menuSub === 'label' && (
              <>
                <button className="rowmenu-back" onClick={() => setMenuSub(null)}>‹ 加標籤</button>
                {Object.entries(labelsById).map(([lid, l]) => (
                  <button key={lid} role="menuitem" onClick={() => { onAddLabel(menu.msg.id, lid); closeMenu(); }}><Icon name="tag" size={16} /> {l.name}</button>
                ))}
              </>
            )}
          </div>
        </div>
      )}
      {/* F9.6：自訂 snooze 時間 */}
      {snoozeCustomFor && (
        <SnoozeCustomModal onClose={() => setSnoozeCustomFor(null)}
          onPick={(at) => onSnooze(snoozeCustomFor, at)} />
      )}
    </section>
  );
}

/* ---------- 草稿列表（drafts 資料夾視圖） ---------- */
export function DraftsList({ drafts, onOpen, onDelete, onMenu, loading, selected, onToggleSelect, onClearSelect, onBatchSend, batchSending }: {
  drafts: { id: string; payload: { subject: string; body: string; to: string }; updatedAt: number }[];
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onMenu: () => void;
  loading: boolean;
  /** F17.3：依序寄出的勾選集合（由 App 持有，寄完清空）。 */
  selected: Set<string>;
  onToggleSelect: (id: string) => void;
  onClearSelect: () => void;
  onBatchSend: (intervalMin: number) => void;
  batchSending: boolean;
}) {
  // 間隔預設 2 分鐘：排程靠每分鐘的 cron，粒度最細就是分鐘；太密集也違背「別被判垃圾信」的用意。
  const [intervalMin, setIntervalMin] = useState(2);
  return (
    <section className="listpane" aria-label="草稿">
      <div className="listpane-head">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className="iconbtn mobile-only" aria-label="開啟選單" onClick={onMenu}><Icon name="menu" /></button>
          <div className="listpane-meta" style={{ flex: 1, padding: '8px 2px' }}>
            <span>草稿</span>
            <span style={{ fontFamily: 'var(--font-mono)' }}>{drafts.length} 封</span>
          </div>
        </div>
        {selected.size > 0 && (
          <div className="batch-bar" role="group" aria-label="依序寄出">
            <span style={{ fontSize: 13, fontWeight: 600 }}>已選 {selected.size}</span>
            <label className="draft-gap">
              間隔
              <select value={intervalMin} disabled={batchSending}
                onChange={(e) => setIntervalMin(Number(e.target.value))} aria-label="每封之間相隔幾分鐘">
                {[1, 2, 5, 10, 30].map((m) => <option key={m} value={m}>{m} 分</option>)}
              </select>
            </label>
            <div style={{ flex: 1 }}></div>
            <button className="btn btn-sm" disabled={batchSending} onClick={() => onBatchSend(intervalMin)}>
              {batchSending ? '排程中…' : '依序寄出'}
            </button>
            <button className="iconbtn" data-tooltip="取消選取" aria-label="取消選取"
              disabled={batchSending} onClick={onClearSelect}><Icon name="x" size={15} /></button>
          </div>
        )}
      </div>
      <div className="msg-list">
        {!drafts.length && !loading && (
          <EmptyState pose="happy" title="沒有草稿" sub="關閉寫信視窗時會自動保存到這裡。" />
        )}
        {drafts.map((d) => (
          <button key={d.id} className={`msg-item ${selected.has(d.id) ? 'checked' : ''}`} onClick={() => onOpen(d.id)}>
            {/* msg-item 是 <button>，不能再巢 <button>（DraftsList 既有的刪除鈕也是用 span role）；
                沿用 MessageList 的 .msg-check 視覺與 checksquare/square 圖示，不另造樣式。 */}
            <span className="msg-check" role="checkbox" aria-checked={selected.has(d.id)} tabIndex={-1}
              aria-label={selected.has(d.id) ? '取消選取' : '選取以便依序寄出'}
              onClick={(e) => { e.stopPropagation(); onToggleSelect(d.id); }}>
              <Icon name={selected.has(d.id) ? 'checksquare' : 'square'} size={16} />
            </span>
            <div className="msg-item-main">
              <div className="msg-row1">
                <span className="msg-from" style={{ color: 'var(--danger)' }}>草稿</span>
                <span className="msg-time">{timeAgo(d.updatedAt)}</span>
              </div>
              <div className="msg-subject">{d.payload.subject || '（無主旨）'}</div>
              <div className="msg-snippet">{d.payload.to ? `致 ${d.payload.to} — ` : ''}{d.payload.body.slice(0, 80)}</div>
            </div>
            <div className="msg-flags">
              <span className="star-btn" role="button" tabIndex={-1} aria-label="刪除草稿"
                onClick={(e) => { e.stopPropagation(); onDelete(d.id); }}>
                <Icon name="trash" size={15} />
              </span>
            </div>
          </button>
        ))}
      </div>
    </section>
  );
}

/* ---------- 信件內文（消毒後 HTML → 同源 sandbox iframe；srcdoc 組裝在 lib/emailSrcdoc.ts） ---------- */

/* ---------- 會議邀請卡（.ics 解析） ---------- */
const RSVP_LABEL = { accepted: '接受', tentative: '暫定', declined: '拒絕' } as const;

function InviteCard({ ev, messageId, status }: { ev: CalendarEvent; messageId: string; status: ThreadMessage['rsvpStatus'] }) {
  const rsvp = useRsvp();
  const cancelled = ev.method === 'CANCEL';
  // 可回覆出席：非取消通知、非他人的 REPLY、且有組織者可回信
  const canRsvp = !cancelled && ev.method !== 'REPLY' && !!ev.organizer?.email;
  // 點過即樂觀回顯，伺服器確認後與 prop 一致；但失敗時退回伺服器狀態（rsvp.variables 在 error 後仍保留，會誤亮）
  const current = rsvp.isError ? status : rsvp.variables?.status ?? status;
  const when = ev.startMs ? fullTime(ev.startMs) : ev.startText;
  // Google 日曆範本連結（需精確 epoch；TZID/floating 無 epoch 則不提供）
  const gcalUrl = (() => {
    if (!ev.startMs) return null;
    const utc = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const day = (ms: number) => new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');
    const endMs = ev.endMs ?? ev.startMs + 3600_000;
    const dates = ev.allDay ? `${day(ev.startMs)}/${day(endMs)}` : `${utc(ev.startMs)}/${utc(endMs)}`;
    const p = new URLSearchParams({ action: 'TEMPLATE', text: ev.summary ?? '(無標題)', dates });
    if (ev.location) p.set('location', ev.location);
    if (ev.description) p.set('details', ev.description);
    return `https://calendar.google.com/calendar/render?${p.toString()}`;
  })();
  return (
    <div className="invite-card" style={{
      border: '1px solid var(--border-subtle)', borderRadius: 12, padding: '14px 16px', margin: '0 0 12px',
      background: 'var(--bg-surface)', display: 'flex', flexDirection: 'column', gap: 4,
    }}>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
        📅 {cancelled ? '會議已取消' : '會議邀請'}{ev.organizer?.name ? ` · ${ev.organizer.name}` : ''}
      </div>
      <div style={{ fontWeight: 600, fontSize: 15, textDecoration: cancelled ? 'line-through' : 'none' }}>
        {ev.summary ?? '(無標題)'}
      </div>
      {when && <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>🕑 {when}</div>}
      {ev.location && <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>📍 {ev.location}</div>}
      {canRsvp && (
        <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {(['accepted', 'tentative', 'declined'] as const).map((s) => {
            const active = current === s;
            return (
              <button key={s} type="button" disabled={rsvp.isPending}
                className={`btn btn-sm ${active ? '' : 'btn-ghost'}`}
                aria-pressed={active}
                onClick={() => rsvp.mutate({ id: messageId, status: s })}>
                {RSVP_LABEL[s]}
              </button>
            );
          })}
          {current && (
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              你已{RSVP_LABEL[current]}
            </span>
          )}
          {rsvp.isError && (
            <span style={{ fontSize: 12, color: 'var(--danger)' }}>回覆失敗，請再試一次</span>
          )}
        </div>
      )}
      {!cancelled && (
        <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
          <a className="btn btn-sm" href={`/api/v1/messages/${messageId}/calendar.ics`} style={{ textDecoration: 'none' }}>加入行事曆</a>
          {gcalUrl && (
            <a className="btn btn-ghost btn-sm" href={gcalUrl} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'none' }}>
              Google 日曆
            </a>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------- AI 對話串摘要 ---------- */
function ThreadSummary({ messageId }: { messageId: string }) {
  const summarize = useThreadSummary();
  return (
    <div style={{ marginBottom: 12 }}>
      {!summarize.data && (
        <button className="btn btn-ghost btn-sm" disabled={summarize.isPending} onClick={() => summarize.mutate(messageId)}>
          <Icon name="sparkle" size={14} /> {summarize.isPending ? '摘要中…' : 'AI 摘要整串'}
        </button>
      )}
      {summarize.isError && <div style={{ fontSize: 12, color: 'var(--danger)', marginTop: 4 }}>摘要失敗，請再試一次</div>}
      {summarize.data && (
        <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 10, padding: '10px 12px', background: 'var(--bg-surface)' }}>
          <div style={{ fontSize: 12, color: 'var(--accent)', fontWeight: 600, marginBottom: 5, display: 'flex', alignItems: 'center', gap: 5 }}>
            <Icon name="sparkle" size={13} /> AI 對話串摘要
          </div>
          <div style={{ fontSize: 13, whiteSpace: 'pre-wrap', color: 'var(--text-secondary)', lineHeight: 1.55 }}>{summarize.data.summary}</div>
        </div>
      )}
    </div>
  );
}

export interface LinkHover {
  url: string;
  /** 顯示文字看似網址但與實際目的網域不同 → 可疑（釣魚樣式） */
  suspicious: boolean;
}

/**
 * 信件文件要多高才能整封攤開（見 lib/emailFit.ts）：
 * 先解開「把內容關在小框裡自己捲」的容器（信件自帶 html/body height:100% ＋ overflow:auto 包裝 →
 * 手機上只剩一小塊要用手指捲），再把比閱讀區寬的版型縮放到剛好一個寬度（Hon 定案乙案），最後量。
 */
function fitHeight(doc: Document): number {
  unfoldEmailDocument(doc);
  fitEmailToWidth(doc);
  return Math.min(Math.max(doc.body.scrollHeight + 8, 40), 20000);
}

export function EmailBody({ html, loadImages, onLinkHover, msgId, showQuotes = true }: {
  html: string;
  loadImages: boolean;
  onLinkHover?: (link: LinkHover | null) => void;
  msgId?: string; // F5.5：標記所屬訊息，讓回覆只引用「本封」選取
  showQuotes?: boolean; // F13.1：false = CSS 摺疊 data-quote 引文區塊
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(80);
  /** 上次／上上次在「有版面盒」下攤開／縮放時的 iframe 寬；寬度真的變了（轉向、拖窗格、從隱藏變顯示）才重算。 */
  const fitWidthRef = useRef(EMPTY_FIT_WIDTH);
  const srcdoc = useMemo(() => buildSrcdoc(html, loadImages, showQuotes), [html, loadImages, showQuotes]);
  const refit = () => {
    const el = ref.current;
    const doc = el?.contentDocument;
    if (!el || !doc?.body) return;
    setHeight(fitHeight(doc));
    fitWidthRef.current = recordFitWidth(fitWidthRef.current, el.offsetWidth, performance.now());
  };
  const measure = () => {
    refit();
    const doc = ref.current?.contentDocument;
    // 連結真實網址預覽：父層（同源）掛 hover 監聽，sandbox 內不需要 JS
    if (doc && onLinkHover) {
      doc.querySelectorAll('a[href]').forEach((a) => {
        const href = a.getAttribute('href') ?? '';
        if (!/^https?:/i.test(href)) return;
        a.addEventListener('mouseenter', () => {
          let suspicious = false;
          try {
            const realHost = new URL(href).hostname.replace(/^www\./, '');
            const text = (a.textContent ?? '').trim();
            const m = /^(?:https?:\/\/)?(?:www\.)?([a-z0-9.-]+\.[a-z]{2,})/i.exec(text);
            if (m && m[1].toLowerCase() !== realHost.toLowerCase()) suspicious = true;
          } catch {
            /* 壞 URL 不標 */
          }
          onLinkHover({ url: href, suspicious });
        });
        a.addEventListener('mouseleave', () => onLinkHover(null));
      });
    }
  };
  // 補量（2026-09-19 實測）：若 load 當下 iframe 沒有版面（任一祖先 display:none），scrollHeight 量到 0
  // → 高度鎖死 40px，之後父層顯示也不會再量 → 一封永遠空白的信。ResizeObserver 掛在 **iframe 元素本身**，
  // 它從「沒有版面盒」變成有的時候會觸發，補量即正確（實測：隱藏時量 0 → 40px；顯示後 → 513px）。
  // 2026-09-23 起改為**寬度變了就重算**、不再量一次就斷開：寬版信的縮放比例依寬度而定，轉向或拖窗格後要重縮；
  // 舊版在轉向後高度同樣失準（字重新換行變高 → 又被關進小框）。我們自己設高度也會觸發 RO，但寬度沒變就略過，
  // 不會回授；捲軸出現／消失造成的寬度來回由 shouldRefitWidth 擋下（讀信窗格另有 scrollbar-gutter: stable）。刻意不觀察內文件的 body：那會讓「我們設高度 → body 高度跟著變」形成回授，
  // 遇到 body{height:100%} 的信會每次 +8px 一路長到 20000 上限。srcdoc 變更（換信／按載入圖片）時重建。
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      // 寬度真的變了才重算；1 秒內彈回較寬的上上次寬度（捲軸出現／消失之類的振盪）略過——見 shouldRefitWidth
      if (shouldRefitWidth(fitWidthRef.current, ref.current?.offsetWidth ?? 0, performance.now())) refit();
    });
    ro.observe(el);
    return () => ro.disconnect();
    // refit 只讀 ref，不依賴 render 內的值
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [srcdoc]);
  return (
    <iframe
      ref={ref}
      title="信件內容"
      data-msg-id={msgId}
      // 無 allow-scripts：內容完全不能執行 JS；allow-same-origin 供量高 + cid 圖片帶 cookie
      //
      // allow-downloads 為何必要且安全（2026-07-24 實測）：Chrome 83+ 對 sandbox iframe
      // 一律禁止下載，沒有這個旗標時「大檔案下載」連結按下去，請求會照發（伺服器回 200 +
      // Content-Disposition，Network 看得到、download_count 也會跳）但**檔案不會存下來**，
      // 畫面上完全沒有回饋——使用者只會覺得「點了沒反應」。同一個連結從 Gmail 點就正常，
      // 因為那不在 sandbox 內。
      // 安全性：沒有 allow-scripts ⇒ 內文完全不能執行 JS；消毒器又把 meta/base/iframe/
      // object/embed/script/style 連內容一起刪掉（sanitize.ts DROP_WITH_CONTENT）⇒ 沒有
      // meta-refresh 之類的自動導覽手段。因此唯一能觸發下載的路徑，是使用者真的點一個
      // 通過 safeUrl() 白名單的 <a>——不存在自動/偷渡下載的攻擊面。
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-downloads"
      srcDoc={srcdoc}
      // 信件渲染在白色畫布上（郵件原生環境）：固定 light scheme + 白底圓角，視覺上是一張乾淨信件卡
      style={{ width: '100%', border: 'none', height, display: 'block', colorScheme: 'light', background: '#ffffff', borderRadius: 10 }}
      onLoad={measure}
    />
  );
}

/* ---------- AI 摘要面板 ---------- */
function fmtEventTime(ms: number): string {
  return new Date(ms).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}
export function AiPanel({ msg, pending, onGenerate, onAddEvent, onTrackTodo }: {
  msg: ThreadMessage;
  pending: boolean;
  onGenerate: (id: string) => void;
  onAddEvent?: (ev: { summary: string; startMs: number; endMs: number; location?: string }) => void | Promise<boolean>;
  onTrackTodo?: (msgId: string) => void;
}) {
  // 一鍵晶片的「已加入/已設」狀態（防重複點＝防重複建事件；AiPanel 以 selected.id 為 key → 換信自動重置）
  const [expanded, setExpanded] = useState(false);
  const [doneEvents, setDoneEvents] = useState<Set<number>>(() => new Set());
  const [doneTodos, setDoneTodos] = useState<Set<number>>(() => new Set());
  if (msg.direction === 'outbound') return null;
  if (!msg.aiSummary && !pending) {
    return (
      <button className="ai-generate" onClick={() => { setExpanded(true); onGenerate(msg.id); }}>
        <Icon name="sparkle" size={15} />
        <span>用 AI 摘要這封信</span>
        <span className="ai-tag" style={{ marginLeft: 'auto' }}>Workers AI · 免費額度內</span>
      </button>
    );
  }
  if (pending && !msg.aiSummary) {
    return (
      <div className="ai-card" aria-busy="true">
        <div className="ai-head"><Icon name="sparkle" size={15} /> AI 摘要生成中…</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginTop: 10 }}>
          <div className="skeleton" style={{ height: 12, width: '92%' }}></div>
          <div className="skeleton" style={{ height: 12, width: '64%' }}></div>
        </div>
      </div>
    );
  }
  const ai = msg.aiSummary!;
  const staleBefore = Date.now() - 86_400_000;
  const events = (ai.events ?? []).filter((ev) => ev.startMs > staleBefore); // 過期（>1 天前）的快取事件不顯示死晶片（會被 /calendar/invite 擋）
  const addEvent = (i: number, ev: { summary: string; startMs: number; endMs: number; location?: string }) => {
    void Promise.resolve(onAddEvent?.(ev)).then((ok) => {
      if (ok !== false) setDoneEvents((s) => new Set(s).add(i)); // 成功才鎖；失敗保留可重試
    });
  };
  return (
    <details className="ai-card ai-disclosure" open={expanded} onToggle={(e) => setExpanded(e.currentTarget.open)}>
      <summary className="ai-head">
        <Icon name="sparkle" size={15} /> AI 摘要
        <span className="chip" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>{ai.category}</span>
        <span className="ai-tag">{ai.model}</span>
        <span className="ai-chev" aria-hidden="true"><Icon name="chevronDown" size={12} /></span>
      </summary>
      <p className="ai-summary">{ai.summary}</p>
      {events.length > 0 && (
        <div className="ai-chips">
          {events.map((ev, i) => {
            const done = doneEvents.has(i);
            return (
              <button key={`ev${i}`} className="ai-chip" disabled={done} onClick={() => addEvent(i, ev)} title={`${ev.summary}${ev.location ? ` · ${ev.location}` : ''}`}>
                <Icon name={done ? 'check' : 'calendar'} size={13} />
                {done ? ' 已加入行事曆' : <> 加入行事曆：{ev.summary}<span className="ai-chip-time"> · {fmtEventTime(ev.startMs)}</span></>}
              </button>
            );
          })}
        </div>
      )}
      {ai.actions && ai.actions.length > 0 && (
        <div className="ai-chips">
          {ai.actions.map((t, i) => {
            const done = doneTodos.has(i);
            return (
              <button
                key={`ac${i}`}
                className="ai-chip"
                disabled={done}
                onClick={() => { onTrackTodo?.(msg.id); setDoneTodos((s) => new Set(s).add(i)); }}
                title={t}
              >
                <Icon name={done ? 'check' : 'flag'} size={13} /> {done ? '已設跟進' : `設為跟進：${t}`}
              </button>
            );
          })}
        </div>
      )}
    </details>
  );
}

/* ---------- F11.1：站內 emoji 反應 ---------- */
const REACTION_SET = ['👍', '❤️', '😂', '🎉', '😮', '🙏'];

/* ---------- F10.3：帳單/包裹卡 ---------- */
/** 到期倒數文案 + 緊急度（純函式）。過期 = danger、今天/3 天內 = danger/warn。 */
export function dueCountdown(dueDate: string, now = Date.now()): { label: string; tone: 'danger' | 'warn' | 'normal' } {
  const due = new Date(`${dueDate}T23:59:59`).getTime();
  const days = Math.ceil((due - now) / 86400_000);
  if (days < 0) return { label: `已逾期 ${-days} 天`, tone: 'danger' };
  if (days === 0) return { label: '今天到期', tone: 'danger' };
  if (days <= 3) return { label: `${days} 天後到期`, tone: 'warn' };
  return { label: `${days} 天後到期`, tone: 'normal' };
}

function ReceiptBadge({ card }: { card: NonNullable<MsgListItem['receiptCard']> }) {
  if (card.kind === 'parcel') {
    return <span className="receipt-badge normal"><Icon name="clip" size={11} /> 包裹{card.trackingNo ? ` · ${card.trackingNo.slice(0, 12)}` : ''}</span>;
  }
  const due = card.dueDate ? dueCountdown(card.dueDate) : null;
  return (
    <span className={`receipt-badge ${due?.tone ?? 'normal'}`}>
      <Icon name="pdf" size={11} /> {card.amount ?? '帳單'}{due ? ` · ${due.label}` : ''}
    </span>
  );
}

/* ---------- F9.6：自訂 snooze 時間（重用自製日期時間選擇器；只接受未來時間） ---------- */
function SnoozeCustomModal({ onClose, onPick }: { onClose: () => void; onPick: (at: number) => void }) {
  const [val, setVal] = useState('');
  const at = val ? new Date(val).getTime() : 0;
  const valid = at > Date.now();
  return (
    <Modal title="自訂稍後處理時間" desc="到點會自動回到收件匣並標為未讀。" onClose={onClose} width={420}>
      <div className="field">
        <label htmlFor="snooze-custom-at">回到收件匣的時間</label>
        <DateTimeField id="snooze-custom-at" value={val} ariaLabel="稍後處理時間" onChange={setVal} />
      </div>
      <button className="btn btn-primary" style={{ width: '100%', marginTop: 14 }} disabled={!valid}
        onClick={() => { onPick(at); onClose(); }}>
        <Icon name="snooze" size={14} /> 確認
      </button>
    </Modal>
  );
}

/* ---------- Snooze 預設選項 ---------- */
export function snoozePresets(): { label: string; at: number }[] {
  const now = new Date();
  const at = (addDays: number, h: number, m = 0) => {
    const d = new Date(now);
    d.setDate(d.getDate() + addDays);
    d.setHours(h, m, 0, 0);
    return d.getTime();
  };
  const laterToday = Date.now() + 3 * 3600_000;
  const tonight = now.getHours() < 19 ? at(0, 19) : at(1, 8);
  const tomorrow = at(now.getHours() < 8 ? 0 : 1, 8);
  // 本週六早上 8 點（已過則下週六）
  const daysToSat = (6 - now.getDay() + 7) % 7 || 7;
  const weekend = at(daysToSat, 8);
  return [
    { label: '稍晚（3 小時後）', at: laterToday },
    { label: '今晚', at: tonight },
    { label: '明天早上', at: tomorrow },
    { label: '本週末', at: weekend },
  ];
}

/* ---------- 閱讀面板 ---------- */
// 寄件者信任卡：由 SPF/DKIM/DMARC 衍生信任等級（鏡像 src/worker/email/authVerdict.ts trustLevel）。
type SenderTrust = 'pass' | 'fail' | 'partial';
function senderTrust(v: ThreadMessage['authVerdict']): SenderTrust | null {
  if (!v) return null;
  if (v.dmarc === 'pass') return 'pass';
  if (v.dmarc === 'fail') return 'fail';
  if (v.spf === 'pass' && v.dkim === 'pass') return 'pass';
  if ((v.spf === 'fail' || v.spf === 'softfail') && v.dkim === 'fail') return 'fail';
  return 'partial';
}
const TRUST_LABEL: Record<SenderTrust, string> = { pass: '已驗證寄件者', fail: '驗證未通過', partial: '部分驗證' };
function verdictTip(v: NonNullable<ThreadMessage['authVerdict']>): string {
  const f = (k: string, val: string | null) => `${k} ${val ?? '—'}`;
  return `${f('SPF', v.spf)} · ${f('DKIM', v.dkim)} · ${f('DMARC', v.dmarc)}`;
}

// F13.5(A)：讀信卡片「信件資訊」可收合列——把寄件驗證/首次來信/已退訂/帳單包裹併成一條，
// 預設收合只顯示摘要，點開才見完整徽章與收據明細（減少讀信頁的卡片堆疊噪音）。
function MessageInfoStrip({ tm, pushToast }: { tm: ThreadMessage; pushToast?: (t: string) => void }) {
  const [open, setOpen] = useState(false);
  const trust = senderTrust(tm.authVerdict);
  const r = tm.receiptCard;
  if (!trust && !tm.isNewSender && !tm.unsubResend && !r) return null; // 無任何訊號 → 不顯示
  return (
    <div className="msg-info">
      <button type="button" className="msg-info-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="shield" size={13} />
        <span className="msg-info-sum">
          {trust && <span className={`ms-tag ${trust}`}>{TRUST_LABEL[trust]}</span>}
          {r && <span className="ms-tag">{r.kind === 'bill' ? '🧾 帳單' : '📦 包裹'}{r.amount ? ` ${r.amount}` : ''}</span>}
          {tm.isNewSender && <span className="ms-tag">首次來信</span>}
          {tm.unsubResend && <span className="ms-tag fail">已退訂仍寄送</span>}
        </span>
        <span className="msg-info-chev" aria-hidden="true"><Icon name="chevronDown" size={12} /></span>
      </button>
      {open && (
        <div className="msg-info-detail">
          {trust && tm.authVerdict && (
            <span className={`trust-badge ${trust}`} data-tooltip={verdictTip(tm.authVerdict)}>
              <Icon name={trust === 'fail' ? 'flag' : 'shield'} size={12} /> {TRUST_LABEL[trust]}
            </span>
          )}
          {tm.isNewSender && (
            <span className="new-sender-pill" data-tooltip="這個位址先前沒寄過信給你">
              <Icon name="user" size={12} /> 首次來信
            </span>
          )}
          {tm.unsubResend && (
            <span className="trust-badge fail" data-tooltip="你已對此寄件者退訂，但對方又寄來了 —— 已自動歸檔">
              <Icon name="flag" size={12} /> 已退訂仍寄送
            </span>
          )}
          {r && (
            <div className="receipt-card-top" style={{ marginTop: 4 }}>
              <span className="receipt-card-kind">{r.kind === 'bill' ? '🧾 帳單' : '📦 包裹'}</span>
              {r.vendor && <span className="receipt-card-item">{r.vendor}</span>}
              {r.amount && <span className="receipt-card-item mono">{r.amount}</span>}
              {r.dueDate && (() => {
                const due = dueCountdown(r.dueDate);
                return <span className={`receipt-badge ${due.tone}`}>{r.dueDate}（{due.label}）</span>;
              })()}
              {r.trackingNo && (
                <span className="receipt-card-item mono">
                  {r.trackingNo}
                  <button type="button" className="linklike" style={{ marginLeft: 6, fontSize: 12 }}
                    onClick={() => void navigator.clipboard?.writeText(r.trackingNo!).then(() => pushToast?.('已複製追蹤號 📋')).catch(() => {})}>複製</button>
                  <a className="linklike" style={{ marginLeft: 6, fontSize: 12 }} target="_blank" rel="noopener noreferrer"
                    href={`https://www.google.com/search?q=${encodeURIComponent(r.trackingNo)}`}>查詢</a>
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
// 已封鎖的遠端資源數（追蹤器計數）：純前端，數 sanitize 改寫出的 data-blocked-src 屬性。
// 用 DOM 解析而非字串比對——否則信件內文或 title/alt 屬性值裡的字面 "data-blocked-src=" 會灌大數字。
function blockedCount(html: string): number {
  try {
    return new DOMParser().parseFromString(html, 'text/html').querySelectorAll('[data-blocked-src]').length;
  } catch {
    return 0;
  }
}

export function ReadingPane({ thread, muted, selectedId, labelsById, contactNames, onArchive, onMoveToInbox, onDelete, onSpam, onToggleStar, onReply, onBack, onPreview, onDownloadRaw, onSnooze, onFollowup, onTranslate, translatingId, loading, bouncingStarId, aiPendingId, onGenerateAi, onAddEvent, onTrackTodo, onSmartReply, onUnsubscribe, onBlockSender, onToggleMute, inInboxView, currentCategory, onMoveToCategory, onSetStatus, onTogglePin, onOpenProfile, onEncryptLink, pushToast, note, onSaveNote, onRenameSubject, morphId, morphSubject, offline, onReplyMount, onOpenMessage }: {
  onReplyMount?: (node: HTMLDivElement | null) => void;
  /** F19.1：把對話串中的某一封設為選取（內文因預算沒載時，用它單獨開啟該封）。 */
  onOpenMessage?: (id: string) => void;
  thread: ThreadMessage[];
  muted: boolean;
  selectedId: string | null;
  labelsById: Record<string, { name: string; color: string }>;
  contactNames: Map<string, string>;
  onArchive: (m: ThreadMessage) => void;
  onMoveToInbox: (m: ThreadMessage) => void;
  onDelete: (m: ThreadMessage) => void;
  onSpam: (m: ThreadMessage) => void;
  onToggleStar: (m: ThreadMessage) => void;
  onReply: (m: ThreadMessage) => void;
  onBack: () => void;
  onPreview: (att: { id: string; filename: string; mimeType: string; sizeBytes: number }) => void;
  onDownloadRaw: (id: string) => void;
  onSnooze: (id: string, until: number) => void;
  onFollowup: (id: string, dueAt: number, awaitReply: boolean) => void;
  onTranslate: (id: string) => void;
  translatingId: string | null;
  loading: boolean;
  offline?: boolean; // F7.10：離線且本機未快取此信 → 顯示提示
  bouncingStarId: string | null;
  aiPendingId: string | null;
  onGenerateAi: (id: string) => void;
  onAddEvent?: (ev: { summary: string; startMs: number; endMs: number; location?: string }) => void | Promise<boolean>;
  onTrackTodo?: (msgId: string) => void;
  onSmartReply: (m: ThreadMessage, text: string) => void;
  onUnsubscribe: (m: ThreadMessage) => void;
  onBlockSender: (m: ThreadMessage) => void;
  onToggleMute: (m: ThreadMessage, muted: boolean) => void;
  inInboxView: boolean;
  currentCategory: InboxCategory;
  onMoveToCategory: (m: ThreadMessage, cat: InboxCategory) => void;
  onSetStatus: (m: ThreadMessage, status: 'needs_reply' | 'waiting' | null) => void;
  onTogglePin: (m: ThreadMessage) => void;
  onOpenProfile?: (email: string) => void; // F5.4：點寄件人 → 往來脈絡
  onEncryptLink?: () => void; // F8.4：以加密連結分享（不再只藏在 ⌘K）
  pushToast?: (text: string) => void; // F8.8：快捷鍵漸進教學 toast
  note?: string; // F9.7：線程便利貼內容
  onSaveNote?: (note: string) => void; // F9.7：儲存便利貼（空字串=刪除）
  onRenameSubject?: (m: ThreadMessage) => void; // F9.7：改顯示主旨
  morphId?: string | null; // F6.1：手機開信主旨 morph 進行中的信 id
  morphSubject?: string; // F6.1：morph 目標主旨（載入中先用列表主旨當佔位，讓 cold open 也能 morph）
}) {
  const [loadedImgs, setLoadedImgs] = useState<string[]>([]);
  const [moreOpen, setMoreOpen] = useState(false);
  // F8.6：稍後/跟進收進「更多」選單，用手風琴子區塊展開 presets（null = 皆收合）
  const [menuSec, setMenuSec] = useState<'snooze' | 'followup' | null>(null);
  const [snoozeCustomOpen, setSnoozeCustomOpen] = useState(false); // F9.6：自訂 snooze 時間
  const [noteOpen, setNoteOpen] = useState(false); // F9.7：便利貼輸入框（尚無內容時手動展開）
  const [followupAwait, setFollowupAwait] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [quotesShown, setQuotesShown] = useState<Set<string>>(() => new Set()); // F13.1：引文展開（預設摺疊）
  const [hoverLink, setHoverLink] = useState<LinkHover | null>(null);
  const scrollRef = useScrollFog<HTMLDivElement>();
  const screenMut = useScreenDecision(); // F5.3：待審放行/永遠擋
  const selected = thread.find((m) => m.id === selectedId) ?? thread[thread.length - 1] ?? null;
  // F10.2：抵達即備稿——只對入站信查（無備稿回 null，卡片不現）
  const autoDraft = useAutoDraft(selected?.id ?? null, selected?.direction === 'inbound');
  const reactMut = useReact(); // F11.1：站內 emoji 反應
  // F14.3：規則建議 nudge——只對入站信查；有建議才顯示 chip
  const ruleHint = useRuleHint(selected?.direction === 'inbound' ? (selected?.id ?? null) : null);
  const createRule = useCreateSenderRule();
  const [ruleHintDone, setRuleHintDone] = useState(false);
  useEffect(() => { setMoreOpen(false); setMenuSec(null); setExpanded(new Set()); setHoverLink(null); setRuleHintDone(false); }, [selectedId]);
  const nameOf = (m: ThreadMessage) => contactNames.get(m.from.addr.toLowerCase()) ?? m.from.name;

  if (!selectedId) {
    return (
      <main className="readpane">
        <EmptyState pose="happy" title="選一封信來閱讀" sub="或按 j / k 用鍵盤瀏覽列表。" />
      </main>
    );
  }
  if (!loading && !selected && offline) {
    // F7.10：離線開到「從未在本機快取過」的信 → 明確提示，而非永遠轉圈的骨架。
    return (
      <main className="readpane">
        {/* 手機上 .readpane 是 position:fixed;inset:0 蓋滿整個畫面。這兩個分支（離線未快取／載入中或
            找不到信）原本沒有返回鍵 → 一旦卡在這裡就**完全沒有可見的出口**，只能重整或關掉分頁。
            2026-09-20 Hon 在手機上回報「按了新信件之後就關不掉了」即是此處。 */}
        <div className="readpane-toolbar">
          <button className="iconbtn mobile-only" data-tooltip="返回列表" aria-label="返回列表" onClick={onBack}><Icon name="back" /></button>
        </div>
        <EmptyState pose="error" title="離線，這封尚未下載" sub="這封信還沒在這台裝置快取過，回到連線後即可閱讀。" />
      </main>
    );
  }
  if (loading || !selected) {
    return (
      <main className="readpane">
        {/* 手機上 .readpane 是 position:fixed;inset:0 蓋滿整個畫面。這兩個分支（離線未快取／載入中或
            找不到信）原本沒有返回鍵 → 一旦卡在這裡就**完全沒有可見的出口**，只能重整或關掉分頁。
            2026-09-20 Hon 在手機上回報「按了新信件之後就關不掉了」即是此處。 */}
        <div className="readpane-toolbar">
          <button className="iconbtn mobile-only" data-tooltip="返回列表" aria-label="返回列表" onClick={onBack}><Icon name="back" /></button>
        </div>
        <div className="readpane-scroll">
          {/* F6.1：cold open 時先用列表主旨當 morph 目標（同位置），讓主旨 morph 在內容載入前就成立 */}
          {morphId === selectedId && morphSubject ? (
            <h1 className="read-subject" style={{ viewTransitionName: `vt-subject-${selectedId}` } as React.CSSProperties}>{morphSubject}</h1>
          ) : (
            <div className="skeleton" style={{ height: 24, width: '60%', marginBottom: 16 }}></div>
          )}
          <div className="skeleton" style={{ height: 120 }}></div>
        </div>
      </main>
    );
  }

  const fmtSize = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

  return (
    <main className="readpane">
      <div className="readpane-toolbar">
        <button className="iconbtn mobile-only" data-tooltip="返回列表" aria-label="返回列表" onClick={onBack}><Icon name="back" /></button>
        {selected.folder === 'inbox' ? (
          <button className="iconbtn" data-tooltip="封存 (e)" aria-label="封存" onClick={() => { const h = coachHint('archive'); if (h) pushToast?.(h); onArchive(selected); }}><Icon name="archive" /></button>
        ) : (
          <button className="iconbtn" data-tooltip="移到收件匣" aria-label="移到收件匣" onClick={() => onMoveToInbox(selected)}><Icon name="inbox" /></button>
        )}
        <button className="iconbtn" data-tooltip="刪除 (#)" aria-label="刪除" onClick={() => { const h = coachHint('delete'); if (h) pushToast?.(h); onDelete(selected); }}><Icon name="trash" /></button>
        <button className={`iconbtn star-btn ${selected.starred ? 'active' : ''} ${selected.id === bouncingStarId ? 'pop' : ''}`}
          data-tooltip="星標 (s)" aria-label="星標"
          style={selected.starred ? { color: 'var(--warning)' } : undefined}
          onClick={() => { haptics.tap(); onToggleStar(selected); }}><Icon name={selected.starred ? 'starFill' : 'star'} /></button>
        <button className="btn btn-ghost btn-sm snooze-direct" aria-label="稍後處理" aria-expanded={moreOpen && menuSec === 'snooze'}
          onClick={() => { setMoreOpen(true); setMenuSec('snooze'); }}><Icon name="snooze" size={15} /> 稍後</button>
        {/* F8.6：低頻動作（稍後/跟進/翻譯/釘選/分類/靜音…）全收進「更多」，一層可達；桌機 hover 也可展開 */}
        <div className="more-wrap" style={{ position: 'relative', display: 'inline-flex' }}>
          <button className="iconbtn" data-tooltip="更多" aria-label="更多動作" onClick={() => { setMoreOpen((v) => !v); setMenuSec(null); }}><Icon name="more" /></button>
          {moreOpen && (
            <>
              <button className="user-pop-backdrop" aria-label="關閉選單" onClick={() => { setMoreOpen(false); setMenuSec(null); }}></button>
              <div className="more-menu" style={{ right: 0, left: 'auto', top: 42, minWidth: 240 }}>
                {/* 稍後處理（手風琴） */}
                <button aria-expanded={menuSec === 'snooze'} onClick={(e) => { e.stopPropagation(); setMenuSec((s) => (s === 'snooze' ? null : 'snooze')); }}>
                  <Icon name="snooze" size={15} /> <span style={{ flex: 1 }}>稍後處理</span>
                  <span className="menu-chev" style={{ display: 'inline-flex', transition: 'transform var(--dur-fast) var(--ease-out)', transform: menuSec === 'snooze' ? 'none' : 'rotate(-90deg)' }}><Icon name="chevronDown" size={13} /></span>
                </button>
                {menuSec === 'snooze' && (
                  <>
                    {snoozePresets().map((p) => (
                      <button key={p.label} style={{ paddingLeft: 34 }} onClick={() => { setMoreOpen(false); setMenuSec(null); onSnooze(selected.id, p.at); }}>
                        <span style={{ flex: 1 }}>{p.label}</span>
                        <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{fullTime(p.at).slice(5)}</span>
                      </button>
                    ))}
                    {/* F9.6：任意時間 snooze */}
                    <button style={{ paddingLeft: 34 }} onClick={() => { setMoreOpen(false); setMenuSec(null); setSnoozeCustomOpen(true); }}>
                      <span style={{ flex: 1 }}>自訂時間…</span>
                    </button>
                  </>
                )}
                {/* 跟進提醒（手風琴） */}
                <button aria-expanded={menuSec === 'followup'}
                  onClick={(e) => { e.stopPropagation(); setFollowupAwait(selected.direction === 'outbound'); setMenuSec((s) => (s === 'followup' ? null : 'followup')); }}>
                  <Icon name="flag" size={15} /> <span style={{ flex: 1 }}>跟進提醒</span>
                  <span className="menu-chev" style={{ display: 'inline-flex', transition: 'transform var(--dur-fast) var(--ease-out)', transform: menuSec === 'followup' ? 'none' : 'rotate(-90deg)' }}><Icon name="chevronDown" size={13} /></span>
                </button>
                {menuSec === 'followup' && (
                  <>
                    {snoozePresets().map((p) => (
                      <button key={p.label} style={{ paddingLeft: 34 }} onClick={() => { setMoreOpen(false); setMenuSec(null); onFollowup(selected.id, p.at, followupAwait); }}>
                        <span style={{ flex: 1 }}>{p.label}</span>
                        <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{fullTime(p.at).slice(5)}</span>
                      </button>
                    ))}
                    <button style={{ paddingLeft: 34, color: followupAwait ? 'var(--accent)' : 'var(--text-secondary)' }}
                      data-tooltip="勾選後：屆時若這串已收到新回覆，就自動取消提醒"
                      onClick={(e) => { e.stopPropagation(); setFollowupAwait((v) => !v); }}>
                      <Icon name={followupAwait ? 'checksquare' : 'square'} size={15} />
                      <span style={{ flex: 1 }}>僅在仍未收到回覆時提醒</span>
                    </button>
                  </>
                )}
                {selected.direction === 'inbound' && (
                  <button disabled={translatingId === selected.id} onClick={() => { setMoreOpen(false); setMenuSec(null); onTranslate(selected.id); }}>
                    <Icon name="globe" size={15} /> 翻譯成繁體中文
                  </button>
                )}
                <button onClick={() => { setMoreOpen(false); setMenuSec(null); onTogglePin(selected); }}
                  style={selected.pinned ? { color: 'var(--accent)' } : undefined}>
                  <Icon name="pin" size={15} /> {selected.pinned ? '取消釘選' : '釘選'}
                </button>
                <div style={{ borderTop: '1px solid var(--border-subtle)', margin: '4px 0' }}></div>
                {inInboxView && (
                  <>
                    <div style={{ padding: '8px 14px 4px', fontSize: 11, color: 'var(--text-muted)', fontWeight: 600 }}>移到分類</div>
                    {INBOX_CATEGORIES.filter((cat) => cat !== currentCategory).map((cat) => (
                      <button key={cat} onClick={() => { setMoreOpen(false); setMenuSec(null); onMoveToCategory(selected, cat); }}>
                        <Icon name="inbox" size={15} /> {CATEGORY_LABEL[cat]}
                      </button>
                    ))}
                    <div style={{ borderTop: '1px solid var(--border-subtle)', margin: '4px 0' }}></div>
                  </>
                )}
                <div style={{ padding: '8px 14px 4px', fontSize: 11, color: 'var(--text-muted)', fontWeight: 600 }}>標記工作流</div>
                <button onClick={() => { setMoreOpen(false); setMenuSec(null); onSetStatus(selected, selected.status === 'needs_reply' ? null : 'needs_reply'); }}>
                  <Icon name="reply" size={15} /> 需回信{selected.status === 'needs_reply' ? ' ✓' : ''}
                </button>
                <button onClick={() => { setMoreOpen(false); setMenuSec(null); onSetStatus(selected, selected.status === 'waiting' ? null : 'waiting'); }}>
                  <Icon name="clock" size={15} /> 等待回覆{selected.status === 'waiting' ? ' ✓' : ''}
                </button>
                <div style={{ borderTop: '1px solid var(--border-subtle)', margin: '4px 0' }}></div>
                <button onClick={() => { setMoreOpen(false); setMenuSec(null); onToggleMute(selected, !muted); }}>
                  <Icon name="bell" size={15} /> {muted ? '取消靜音對話串' : '靜音對話串'}
                </button>
                <button onClick={() => { setMoreOpen(false); setMenuSec(null); onDownloadRaw(selected.id); }}>
                  <Icon name="download" size={15} /> 下載原始郵件 (.eml)
                </button>
                <button onClick={() => { setMoreOpen(false); setMenuSec(null); setTimeout(() => window.print(), 80); }}>
                  <Icon name="download" size={15} /> 列印 / 存 PDF
                </button>
                {onEncryptLink && (
                  <button onClick={() => { setMoreOpen(false); setMenuSec(null); onEncryptLink(); }}>
                    <Icon name="shield" size={15} /> 以加密連結分享
                  </button>
                )}
                <button onClick={() => { setMoreOpen(false); setMenuSec(null); onSpam(selected); }}>
                  <Icon name="spam" size={15} /> 回報垃圾信
                </button>
                {selected.direction === 'inbound' && (
                  <button onClick={() => { setMoreOpen(false); setMenuSec(null); onBlockSender(selected); }}>
                    <Icon name="x" size={15} /> 封鎖此寄件者
                  </button>
                )}
              </div>
            </>
          )}
        </div>
        <div style={{ flex: 1 }}></div>
        <button className="btn btn-secondary btn-sm toolbar-reply" onClick={() => { const h = coachHint('reply'); if (h) pushToast?.(h); onReply(selected); }}><Icon name="reply" size={14} /> 回覆 (r)</button>
      </div>
      {/* F9.6：自訂 snooze 時間 */}
      {snoozeCustomOpen && (
        <SnoozeCustomModal onClose={() => setSnoozeCustomOpen(false)}
          onPick={(at) => onSnooze(selected.id, at)} />
      )}
      <div className="readpane-scroll scroll-fog" ref={scrollRef}>
        <h1 className="read-subject"
          style={morphId === selected.id ? ({ viewTransitionName: `vt-subject-${selected.id}` } as React.CSSProperties) : undefined}>
          {selected.subjectOverride ?? (selected.subject || '（無主旨）')}
          {/* F9.7：改顯示主旨（僅自己可見；回覆引用仍用原主旨） */}
          {onRenameSubject && (
            <button type="button" className="iconbtn subject-edit" data-tooltip={selected.subjectOverride ? `原主旨：${selected.subject}` : '改顯示主旨（僅自己可見）'}
              aria-label="改顯示主旨" onClick={() => onRenameSubject(selected)}>
              <Icon name="pen" size={13} />
            </button>
          )}
        </h1>
        <div className="read-meta-row">
          {selected.labels.map((lid) => labelsById[lid] && <LabelChip key={lid} label={labelsById[lid]} />)}
          {thread.length > 1 && <span className="chip" style={{ background: 'var(--bg-elevated)', color: 'var(--text-secondary)' }}>對話串 · {thread.length} 封</span>}
        </div>
        {/* F13.5(A)：帳單/包裹卡已併入各信卡片的「信件資訊」收合列（見 MessageInfoStrip） */}
        {/* F9.7：線程私有便利貼（僅自己可見） */}
        {onSaveNote && (note || noteOpen ? (
          <div className="thread-note">
            <textarea className="thread-note-input" rows={2} placeholder="寫點只有你看得到的備註…"
              defaultValue={note} key={`${selected.threadId}:${note}`}
              onBlur={(e) => { const v = e.target.value.trim(); if (v !== (note ?? '')) onSaveNote(v); if (!v) setNoteOpen(false); }} />
          </div>
        ) : (
          <button type="button" className="linklike thread-note-add" onClick={() => setNoteOpen(true)}>
            <Icon name="pen" size={12} /> 加便利貼
          </button>
        ))}
        {selected.screening && (
          <div className="screen-banner" role="alert">
            <div className="screen-banner-text">
              <Icon name="shield" size={16} />
              <span>這位寄件者<strong>首次來信</strong>且寄件驗證未完全通過，已暫放<strong>待審</strong>（未進收件匣、不通知）。要放行還是永遠擋掉？</span>
            </div>
            <div className="screen-banner-actions">
              <button
                className="btn btn-secondary btn-sm"
                disabled={screenMut.isPending}
                onClick={() => screenMut.mutate({ id: selected.id, decision: 'allow' })}
              >
                <Icon name="check" size={14} /> 放行（加入聯絡人）
              </button>
              <button
                className="btn btn-danger btn-sm"
                disabled={screenMut.isPending}
                onClick={() => screenMut.mutate({ id: selected.id, decision: 'block' })}
              >
                <Icon name="x" size={14} /> 永遠擋（移垃圾）
              </button>
            </div>
          </div>
        )}
        {/* key 必須帶 ts- 前綴：同層的 <AiPanel> 也用 selected.id 當 key，兩個兄弟節點同 key 是
            React 的未定義行為——reconcile 時 mapRemainingChildren 以 key 建 Map，後者會覆蓋前者，
            被覆蓋的那個舊 fiber 就再也不會被刪除，它的 DOM 於是每換一封信就多疊一層
            （2026-09-20 實測：點一封多一顆「AI 摘要整串」，且全程沒有任何 removeChild）。
            前綴不可拿掉，兩邊也不可改成相同字串。 */}
        {thread.length > 1 && <ThreadSummary key={`ts-${selected.id}`} messageId={selected.id} />}
        {/* F14.3：規則建議 nudge——此寄件者多數信已被歸檔，建議一鍵建自動歸檔規則 */}
        {ruleHint.data?.hint && !ruleHintDone && (
          <div className="rule-hint-chip" role="status">
            <Icon name="sparkle" size={14} />
            <span style={{ flex: 1 }}>
              <b>{ruleHint.data.hint.fromName || ruleHint.data.hint.fromAddr}</b> 的信有 {ruleHint.data.hint.archived} 封在封存匣——要以後自動歸檔嗎？
            </span>
            <button className="btn btn-secondary btn-sm" disabled={createRule.isPending}
              onClick={() => createRule.mutate(
                { fromAddr: ruleHint.data!.hint!.fromAddr, fromName: ruleHint.data!.hint!.fromName },
                { onSuccess: () => { setRuleHintDone(true); pushToast?.('已建立自動歸檔規則 📥'); } },
              )}>建立規則</button>
            <button className="iconbtn" style={{ width: 26, height: 26 }} aria-label="略過建議" onClick={() => setRuleHintDone(true)}>
              <Icon name="x" size={14} />
            </button>
          </div>
        )}
        {/* key 的 ai- 前綴同上：不可與同層 <ThreadSummary> 的 key 相同（見上方註解）。 */}
        <AiPanel key={`ai-${selected.id}`} msg={selected} pending={aiPendingId === selected.id} onGenerate={onGenerateAi} onAddEvent={onAddEvent} onTrackTodo={onTrackTodo} />
        {thread.map((tm, idx) => {
          const isLast = idx === thread.length - 1;
          const collapsed = thread.length > 2 && !isLast && !tm.unread && tm.id !== selectedId && !expanded.has(tm.id);
          if (collapsed) {
            return (
              <button key={tm.id} className="mail-collapsed" onClick={() => setExpanded((s) => new Set(s).add(tm.id))}>
                <SenderAvatar name={nameOf(tm)} addr={tm.from.addr} size="sm" />
                <span className="mc-name">{nameOf(tm)}</span>
                <span className="mc-snippet">{tm.snippet}</span>
                <span className="mc-time">{timeAgo(tm.ts)}</span>
              </button>
            );
          }
          return (
            <article key={tm.id} className="mail-card" style={tm.id === selected.id ? undefined : { opacity: 0.9 }}>
              <header className="mail-card-head">
                {/* F5.4：僅入站信的寄件人可點看脈絡（外寄信的「寄件人」是自己，點了只會開自己 360 → 不給點） */}
                {onOpenProfile && tm.direction === 'inbound' ? (
                  <button type="button" className="sender-profile-btn" onClick={() => onOpenProfile(tm.from.addr)} data-tooltip="查看往來脈絡" aria-label={`查看與 ${nameOf(tm)} 的往來脈絡`}>
                    <SenderAvatar name={nameOf(tm)} addr={tm.from.addr} />
                  </button>
                ) : (
                  <SenderAvatar name={nameOf(tm)} addr={tm.from.addr} />
                )}
                <div className="mail-card-sender">
                  {onOpenProfile && tm.direction === 'inbound' ? (
                    <button type="button" className="mail-card-name as-link" data-tooltip="查看往來紀錄" onClick={() => onOpenProfile(tm.from.addr)}>{nameOf(tm)}</button>
                  ) : (
                    <div className="mail-card-name">{nameOf(tm)}</div>
                  )}
                  <div className="mail-card-addr">{tm.from.addr}</div>
                  {/* F8.5：收件人 email 同樣可點看往來紀錄（to_addrs 為純位址；Contact360 已建好） */}
                  <div className="mail-card-to">收件者：{
                    onOpenProfile && tm.to.length
                      ? tm.to.map((addr, i) => (
                          <span key={`${addr}-${i}`}>
                            {i > 0 && '、'}
                            <button type="button" className="recip-link" data-tooltip="查看往來紀錄" onClick={() => onOpenProfile(addr)}>{addr}</button>
                          </span>
                        ))
                      : (tm.to.join('、') || '—')
                  }</div>
                </div>
                <div className="mail-card-time">{fullTime(tm.ts)}</div>
                {tm.unsubscribe && (
                  <button className="linklike" style={{ fontSize: 12, alignSelf: 'flex-start', whiteSpace: 'nowrap' }}
                    data-tooltip="退訂此寄件者的清單郵件" onClick={() => onUnsubscribe(tm)}>退訂</button>
                )}
              </header>
              {/* F13.5(A)：信件資訊收合列（驗證/首次來信/帳單包裹併成一條，預設收合） */}
              <MessageInfoStrip tm={tm} pushToast={pushToast} />
              {tm.remoteImages && !loadedImgs.includes(tm.id) && (
                <div className="remote-img-notice">
                  <Icon name="img" size={15} />
                  <span style={{ flex: 1 }}>
                    {(() => {
                      const n = blockedCount(tm.html);
                      return n > 0
                        ? `已封鎖 ${n} 個遠端資源以保護你的隱私（防 tracking pixel）`
                        : '已封鎖遠端圖片以保護你的隱私（防 tracking pixel）';
                    })()}
                  </span>
                  <button className="linklike" onClick={() => setLoadedImgs((l) => [...l, tm.id])}>載入圖片</button>
                </div>
              )}
              {tm.calendarEvent && <InviteCard ev={tm.calendarEvent} messageId={tm.id} status={tm.rsvpStatus} />}
              <div className="mail-card-body">
                {tm.processing ? (
                  // 剛收到、ingest queue 還沒回填 html 的信：誠實顯示處理中，而不是一張看起來壞掉的空白卡。
                  // useThread 會每 3 秒重抓直到就緒（src/app/api/mail.ts），使用者不必手動重新整理。
                  <div className="body-processing" aria-busy="true">
                    <div className="body-processing-hint">信件內容處理中…剛收到的信要先消毒與建索引，通常幾秒內完成</div>
                    <div className="skeleton" style={{ height: 12, width: '94%' }}></div>
                    <div className="skeleton" style={{ height: 12, width: '88%' }}></div>
                    <div className="skeleton" style={{ height: 12, width: '61%' }}></div>
                  </div>
                ) : tm.htmlOmitted ? (
                  // F19.1：這一串太大，本封內文超出本次請求的預算而沒載。說清楚並給一條明路，
                  // 不要留一張空白卡讓人以為信壞了——單獨開這封時它排第一順位，必定載得到。
                  <div className="body-processing">
                    <div className="body-processing-hint">
                      這個對話串很大，這封的內文沒有一起載入。<button type="button" className="linklike" onClick={() => onOpenMessage?.(tm.id)}>單獨開啟這封</button>即可看到完整內容。
                    </div>
                  </div>
                ) : (
                  <EmailBody html={tm.html} loadImages={loadedImgs.includes(tm.id)} onLinkHover={setHoverLink} msgId={tm.id}
                    showQuotes={!tm.hasQuote || quotesShown.has(tm.id)} />
                )}
                {tm.hasQuote && (
                  <button type="button" className="quote-toggle" aria-expanded={quotesShown.has(tm.id)}
                    onClick={() => setQuotesShown((s) => { const n = new Set(s); if (n.has(tm.id)) n.delete(tm.id); else n.add(tm.id); return n; })}>
                    <span className="quote-toggle-chevron"><Icon name="chevronDown" size={12} /></span>
                    {quotesShown.has(tm.id) ? '收合引文' : '⋯ 顯示引文'}
                  </button>
                )}
              </div>
              {(tm.aiTranslation || translatingId === tm.id) && (
                <div className="translate-card">
                  <div className="ai-head"><Icon name="globe" size={15} /> 繁體中文翻譯 <span className="ai-tag">Workers AI</span></div>
                  {tm.aiTranslation ? (
                    <p className="ai-summary" style={{ whiteSpace: 'pre-wrap' }}>{tm.aiTranslation}</p>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginTop: 10 }}>
                      <div className="skeleton" style={{ height: 12, width: '94%' }}></div>
                      <div className="skeleton" style={{ height: 12, width: '80%' }}></div>
                    </div>
                  )}
                </div>
              )}
              {tm.attachments.length > 0 && (
                <>
                  {/* F13.3：危險附件警示（副檔名判定；只警示不阻擋、誠實不宣稱掃毒） */}
                  {(() => {
                    const warn = attachmentWarning(tm.attachments.map((a) => a.filename));
                    return warn ? (
                      <div className="attach-warn" role="status">
                        <Icon name="flag" size={15} />
                        <span>{warn}</span>
                      </div>
                    ) : null;
                  })()}
                  <div className="attach-row">
                    {tm.attachments.map((a) => (
                      <div key={a.id} className={`attach-card${attachmentRiskExt(a.filename) ? ' attach-risk' : ''}`} role="button" tabIndex={0}
                        onClick={() => onPreview(a)}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPreview(a); } }}>
                        <span className="attach-icon"><Icon name={a.mimeType.startsWith('image/') ? 'img' : 'pdf'} size={16} /></span>
                        <div>
                          <div>{a.filename}</div>
                          <div className="size">{fmtSize(a.sizeBytes)}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
              {/* F11.1：站內信 emoji 反應（對外信不顯示——收件人根本看不到） */}
              {tm.internal && (
                <div className="reaction-row">
                  {REACTION_SET.map((e) => {
                    const r = tm.reactions?.find((x) => x.emoji === e);
                    return (
                      <button key={e} type="button" className={`reaction-chip ${r?.mine ? 'mine' : ''}`}
                        data-tooltip={r?.names.length ? r.names.join('、') : '按一下回應'}
                        aria-pressed={!!r?.mine}
                        aria-label={`以 ${e} 回應${r ? `，目前 ${r.count} 人${r.mine ? '（含你）' : ''}` : ''}`}
                        disabled={reactMut.isPending}
                        onClick={() => reactMut.mutate({ id: tm.id, emoji: e })}>
                        {e}{r ? ` ${r.count}` : ''}
                      </button>
                    );
                  })}
                </div>
              )}
            </article>
          );
        })}
        {/* F10.2：抵達即備稿——ingest 已擬好的完整回覆草稿，一鍵帶入撰寫器 */}
        {autoDraft.data?.draft && (
          <div className="auto-draft-card">
            <div className="auto-draft-head">
              <Icon name="sparkle" size={13} /> AI 已備好回覆草稿
              <button className="btn btn-secondary btn-sm" style={{ marginLeft: 'auto' }}
                onClick={() => onSmartReply(selected, autoDraft.data!.draft!)}>
                <Icon name="reply" size={13} /> 帶入撰寫器
              </button>
            </div>
            <div className="auto-draft-body">{autoDraft.data.draft}</div>
          </div>
        )}
        {selected.aiSummary && selected.aiSummary.replies.length > 0 && (
          <div className="smart-replies">
            <span className="sr-label"><Icon name="sparkle" size={13} /> 智慧回覆</span>
            {selected.aiSummary.replies.map((r) => (
              <button key={r} className="smart-reply" onClick={() => onSmartReply(selected, r)}>{r}</button>
            ))}
          </div>
        )}
        <div className="inline-reply-mount" ref={onReplyMount} />
        <div className="read-actions">
          <button className="btn btn-primary" onClick={() => onReply(selected)}><Icon name="reply" size={14} /> 回覆</button>
          <button className="btn btn-ghost" onClick={() => onArchive(selected)}><Icon name="archive" size={14} /> 封存</button>
        </div>
      </div>
      {/* 手機固定底列：回覆／封存隨手可及（桌機隱藏，由捲動內的 read-actions 負責） */}
      <div className="readpane-mobilebar">
        <button className="btn btn-primary" onClick={() => onReply(selected)}><Icon name="reply" size={15} /> 回覆</button>
        <button className="btn btn-ghost" onClick={() => onArchive(selected)}><Icon name="archive" size={15} /> 封存</button>
      </div>
      {hoverLink && (
        <div className={`link-status ${hoverLink.suspicious ? 'sus' : ''}`} role="status">
          {hoverLink.suspicious && <Icon name="spam" size={13} />}
          <span className="ls-url">{hoverLink.url}</span>
          {hoverLink.suspicious && <span className="ls-warn">顯示文字與實際網域不符</span>}
        </div>
      )}
    </main>
  );
}
