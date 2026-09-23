// 今日頁：把 行事曆事件 × 跟進 × Snooze 醒來的信 × 排程寄送 收斂成單一時間軸（後端 /agenda）。
import { useAgenda, type AgendaItem, type View } from '../api/mail';
import { EmptyState, Icon, timeAgo, type IconName } from './ui';

const KIND: Record<AgendaItem['kind'], { icon: IconName; label: string }> = {
  event: { icon: 'calendar', label: '會議' },
  followup: { icon: 'flag', label: '跟進' },
  snooze: { icon: 'snooze', label: '醒來' },
  scheduled: { icon: 'send', label: '排程寄送' },
};

function hhmm(ms: number): string {
  return new Date(ms).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function TodayPage({ onOpenMessage, onView, onMenu }: {
  onOpenMessage: (messageId: string) => void;
  onView: (v: View) => void;
  onMenu: () => void;
}) {
  const agenda = useAgenda();
  const items = agenda.data?.items ?? [];

  const open = (it: AgendaItem) => {
    if (it.messageId) onOpenMessage(it.messageId);
    else if (it.kind === 'event') onView({ type: 'calendar' });
    else if (it.kind === 'scheduled') onView({ type: 'folder', folder: 'sent' });
  };

  return (
    <main className="readpane">
      <div className="content-page">
        <div className="mobile-topbar">
          <button className="iconbtn mobile-only" aria-label="開啟選單" onClick={onMenu}><Icon name="menu" /></button>
          <span className="t">今日</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
          <h1 className="page-title" style={{ margin: 0 }}><Icon name="clock" size={20} /> 今日</h1>
          <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>{items.length ? `${items.length} 件` : ''}</span>
        </div>

        {agenda.isLoading ? (
          <div className="agenda-list">
            {[0, 1, 2].map((i) => <div key={i} className="skeleton" style={{ height: 54, borderRadius: 12 }} />)}
          </div>
        ) : items.length === 0 ? (
          <div style={{ marginTop: 24 }}>
            <EmptyState pose="happy" title="今天沒有安排" sub="會議、跟進、稍後處理醒來的信、排程要寄的信，都會在這裡依時間排好。" />
          </div>
        ) : (
          <div className="agenda-list">
            {items.map((it, i) => {
              const meta = KIND[it.kind];
              return (
                <button key={i} className="agenda-row" style={{ ['--i' as string]: i }} onClick={() => open(it)}>
                  <span className={`agenda-icon agenda-${it.kind}`}><Icon name={meta.icon} size={15} /></span>
                  <span className="agenda-main">
                    <span className="agenda-title">{it.title}</span>
                    <span className="agenda-meta">
                      <span className="agenda-kind">{meta.label}</span>
                      {it.sub && <span className="agenda-sub">· {it.sub}</span>}
                    </span>
                  </span>
                  <span className={it.overdue ? 'agenda-time over' : 'agenda-time'}>
                    {it.overdue ? `逾期 · ${timeAgo(it.at)}` : hhmm(it.at)}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}
