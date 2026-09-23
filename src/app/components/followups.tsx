// 跟進頁：列出待跟進 / 已到期的提醒（後端 follow_ups 表）。
// 兩種來源：閱讀面板「跟進提醒」設定的稍後跟進、寄出信「僅在未收到回覆時提醒」。
import { useFollowups, useFollowupDone, type FollowUp } from '../api/mail';
import { EmptyState, Icon, fullTime, timeAgo } from './ui';

function dueLabel(due: number, now: number): { text: string; overdue: boolean } {
  if (due <= now) return { text: `已到期 · ${timeAgo(due)}`, overdue: true };
  return { text: fullTime(due), overdue: false };
}

export function FollowupsPage({ onOpenMessage, onMenu }: {
  onOpenMessage: (messageId: string) => void;
  onMenu: () => void;
}) {
  const followups = useFollowups();
  const done = useFollowupDone();
  const now = Date.now();
  const items = followups.data?.followups ?? [];
  const fired = items.filter((f) => f.status === 'fired');
  const pending = items.filter((f) => f.status === 'pending');

  const row = (f: FollowUp) => {
    const due = dueLabel(f.dueAt, now);
    return (
      <div key={f.id} className="followup-row">
        <button className={`iconbtn followup-flag ${f.status === 'fired' ? 'fired' : ''}`}
          data-tooltip="標記完成（移出清單）" aria-label="標記完成"
          disabled={done.isPending && done.variables === f.id}
          onClick={() => done.mutate(f.id)}>
          <Icon name="check" size={15} />
        </button>
        <button className="followup-main" onClick={() => onOpenMessage(f.messageId)}>
          <div className="followup-subject">{f.subject || '（無主旨）'}</div>
          <div className="followup-meta">
            <span className={due.overdue ? 'followup-due-over' : 'followup-due'}>
              <Icon name="clock" size={12} /> {due.text}
            </span>
            {f.awaitReply && (
              <span className="chip" style={{ background: 'var(--bg-elevated)', color: 'var(--text-secondary)', fontSize: 11 }}>
                等回覆
              </span>
            )}
          </div>
        </button>
      </div>
    );
  };

  return (
    <main className="readpane">
      <div className="content-page">
        <div className="mobile-topbar">
          <button className="iconbtn mobile-only" aria-label="開啟選單" onClick={onMenu}><Icon name="menu" /></button>
          <span className="t">跟進</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
          <h1 className="page-title" style={{ margin: 0 }}><Icon name="flag" size={20} /> 跟進</h1>
          <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>
            {items.length ? `${items.length} 件待跟進` : ''}
          </span>
        </div>

        {followups.isLoading ? (
          <div className="followup-list">
            {[0, 1, 2].map((i) => <div key={i} className="skeleton" style={{ height: 56, borderRadius: 12 }} />)}
          </div>
        ) : items.length === 0 ? (
          <div style={{ marginTop: 24 }}>
            <EmptyState pose="sweep" title="沒有待跟進的事項"
              sub="在閱讀一封信時點旗標圖示，就能設定「稍後跟進」或「寄出後若沒收到回覆才提醒」。" />
          </div>
        ) : (
          <div className="followup-list">
            {fired.length > 0 && (
              <>
                <div className="followup-section">該跟進了</div>
                {fired.map(row)}
              </>
            )}
            {pending.length > 0 && (
              <>
                <div className="followup-section">排程中</div>
                {pending.map(row)}
              </>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
