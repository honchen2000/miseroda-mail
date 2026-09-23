// 行事曆頁：月 / 週檢視。事件來自收到的邀請 + 自建會議（後端 calendar_events 表）。
// 時區處理：UTC/日期事件以本地時間分桶與顯示；帶 TZID 的浮動事件以牆鐘字串（start_text）顯示、以 UTC 日期分桶。
import { useMemo, useState } from 'react';
import { useCalendarEvents, useKeepCalEvent, useRemoveCalEvent, type CalEvent } from '../api/mail';
import { EmptyState, Icon } from './ui';

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

function ymdLocal(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function ymdUtc(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
function startOfWeek(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - x.getDay()); // 週日為週首
  return x;
}
function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
/** 事件落在哪一天（YYYY-MM-DD）：浮動 / 全天事件用 UTC 日期（其 start_ms 即牆鐘日的 UTC 午夜），
 *  其餘（精確時點）用本地日期。全天若用本地日期，UTC 以西時區會早一天。 */
function bucketKey(e: CalEvent): string {
  return e.floating || e.allDay ? ymdUtc(e.startMs) : ymdLocal(new Date(e.startMs));
}
/** 事件顯示時間：全天→全天；浮動→start_text 取時間；其餘→本地 HH:MM。 */
function timeLabel(e: CalEvent): string {
  if (e.allDay) return '全天';
  if (e.floating) return /\d{1,2}:\d{2}/.exec(e.startText)?.[0] ?? '';
  const d = new Date(e.startMs);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function eventColor(e: CalEvent): string {
  if (e.rsvpStatus === 'declined') return 'var(--text-muted)';
  if (e.source === 'external') return 'var(--aurora-violet)'; // F14.1：外部訂閱（唯讀）自成一色
  if (e.source === 'created') return 'var(--accent)';
  if (e.rsvpStatus === 'accepted') return 'var(--success)';
  if (e.rsvpStatus === 'tentative') return 'var(--warning)';
  return 'var(--text-secondary)';
}

export function CalendarPage({ onOpenMessage, onNewMeeting, onMenu }: {
  onOpenMessage: (messageId: string) => void;
  onNewMeeting: () => void;
  onMenu: () => void;
}) {
  const [mode, setMode] = useState<'month' | 'week'>('month');
  const [anchor, setAnchor] = useState(() => new Date());

  // 可視範圍（月：含跨月補滿的 6 週；週：7 天）
  const { gridStart, days } = useMemo(() => {
    if (mode === 'week') {
      const s = startOfWeek(anchor);
      return { gridStart: s, days: Array.from({ length: 7 }, (_, i) => addDays(s, i)) };
    }
    const firstOfMonth = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const s = startOfWeek(firstOfMonth);
    return { gridStart: s, days: Array.from({ length: 42 }, (_, i) => addDays(s, i)) };
  }, [mode, anchor]);

  const rangeFrom = gridStart.getTime() - 86400_000;
  const rangeTo = addDays(gridStart, days.length).getTime() + 86400_000;
  const events = useCalendarEvents(rangeFrom, rangeTo);

  const byDay = useMemo(() => {
    const map = new Map<string, CalEvent[]>();
    for (const e of events.data?.events ?? []) {
      const k = bucketKey(e);
      (map.get(k) ?? map.set(k, []).get(k)!).push(e);
    }
    for (const list of map.values()) list.sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.startMs - b.startMs);
    return map;
  }, [events.data]);

  // F16.1/F16.2：需要使用者處理的事件——通過授權的取消（待確認）、或被擋下的外來修改。
  // 重複事件會展開成多個實例，依原始列 id 去重，同一筆只提示一次。
  const removeEvent = useRemoveCalEvent();
  const keepEvent = useKeepCalEvent();
  const attention = useMemo(() => {
    const seen = new Set<string>();
    const out: CalEvent[] = [];
    for (const e of events.data?.events ?? []) {
      if (!e.rowId || (!e.cancelPending && !e.blockedAt)) continue;
      if (seen.has(e.rowId)) continue;
      seen.add(e.rowId);
      out.push(e);
    }
    return out;
  }, [events.data]);

  const todayKey = ymdLocal(new Date());
  const title =
    mode === 'week'
      ? `${gridStart.getFullYear()} 年 ${gridStart.getMonth() + 1} 月 ${gridStart.getDate()} 日 那週`
      : `${anchor.getFullYear()} 年 ${anchor.getMonth() + 1} 月`;
  const step = (dir: number) => setAnchor((a) => (mode === 'week' ? addDays(a, dir * 7) : new Date(a.getFullYear(), a.getMonth() + dir, 1)));

  const chip = (e: CalEvent) => (
    <button key={e.id} type="button" className="cal-event" style={{ color: eventColor(e) }}
      data-tooltip={`${timeLabel(e)} ${e.summary}${e.recurring ? '（重複）' : ''}${e.location ? ` · ${e.location}` : ''}`}
      onClick={() => e.messageId && onOpenMessage(e.messageId)}>
      <span className="cal-event-dot" style={{ background: eventColor(e) }} />
      <span className="cal-event-time">{timeLabel(e)}</span>
      <span className="cal-event-title" style={{ textDecoration: e.rsvpStatus === 'declined' || e.cancelPending ? 'line-through' : 'none' }}>{e.summary || '(無標題)'}</span>
      {e.recurring && <span className="cal-event-recur" aria-label="重複事件">🔁</span>}
      {e.cancelPending && <span className="cal-event-recur" aria-label="待確認取消">⚠</span>}
    </button>
  );

  return (
    <main className="readpane">
      <div className="content-page">
        <div className="mobile-topbar">
          <button className="iconbtn mobile-only" aria-label="開啟選單" onClick={onMenu}><Icon name="menu" /></button>
          <span className="t">行事曆</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
          <h1 className="page-title" style={{ margin: 0, minWidth: 160 }}>{title}</h1>
          <div style={{ display: 'flex', gap: 4 }}>
            <button className="iconbtn" data-tooltip="上一頁" aria-label="上一頁" onClick={() => step(-1)}><Icon name="back" /></button>
            <button className="btn btn-ghost btn-sm" onClick={() => setAnchor(new Date())}>今天</button>
            <button className="iconbtn" data-tooltip="下一頁" aria-label="下一頁" onClick={() => step(1)} style={{ transform: 'scaleX(-1)' }}><Icon name="back" /></button>
          </div>
          <div style={{ flex: 1 }} />
          <div className="cat-tabs" role="tablist" aria-label="檢視" style={{ border: 'none' }}>
            <button className={`cat-tab ${mode === 'month' ? 'active' : ''}`} onClick={() => setMode('month')}>月</button>
            <button className={`cat-tab ${mode === 'week' ? 'active' : ''}`} onClick={() => setMode('week')}>週</button>
          </div>
          <button className="btn btn-primary btn-sm" onClick={onNewMeeting}><Icon name="clock" size={14} /> 新會議</button>
        </div>

        {attention.length > 0 && (
          <div className="cal-attention" role="status">
            {attention.map((e) => (
              <div key={e.rowId!} className="cal-attention-row">
                <Icon name="shield" size={15} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  {e.cancelPending ? (
                    <><b>{e.cancelBy || '主辦人'}</b> 要求取消「{e.summary || '(無標題)'}」——要從行事曆移除嗎？<span style={{ color: 'var(--text-muted)' }}>（在你確認之前，提醒仍會照常發送）</span></>
                  ) : (
                    <>有人（<b>{e.blockedBy || '不明寄件者'}</b>）試圖修改或取消「{e.summary || '(無標題)'}」，已被擋下——<b>事件內容沒有被更動</b>。</>
                  )}
                </span>
                {e.cancelPending && (
                  <button className="btn btn-danger btn-sm" disabled={removeEvent.isPending}
                    onClick={() => removeEvent.mutate(e.rowId!)}>移除</button>
                )}
                <button className="btn btn-ghost btn-sm" disabled={keepEvent.isPending}
                  onClick={() => keepEvent.mutate(e.rowId!)}>{e.cancelPending ? '保留' : '知道了'}</button>
              </div>
            ))}
          </div>
        )}

        {mode === 'month' ? (
          <div className="cal-grid">
            {WEEKDAYS.map((w) => <div key={w} className="cal-weekday">{w}</div>)}
            {days.map((d) => {
              const key = ymdLocal(d);
              const evs = byDay.get(key) ?? [];
              const inMonth = d.getMonth() === anchor.getMonth();
              return (
                <div key={key} className={`cal-cell ${inMonth ? '' : 'cal-cell-dim'} ${key === todayKey ? 'cal-cell-today' : ''}`}>
                  <div className="cal-date">{d.getDate()}</div>
                  <div className="cal-events">
                    {evs.slice(0, 3).map(chip)}
                    {evs.length > 3 && <div className="cal-more">還有 {evs.length - 3} 個</div>}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="cal-week">
            {days.map((d) => {
              const key = ymdLocal(d);
              const evs = byDay.get(key) ?? [];
              return (
                <div key={key} className={`cal-week-day ${key === todayKey ? 'cal-cell-today' : ''}`}>
                  <div className="cal-week-head">{WEEKDAYS[d.getDay()]} {d.getMonth() + 1}/{d.getDate()}</div>
                  <div className="cal-events">
                    {evs.length ? evs.map(chip) : <div className="cal-more">—</div>}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {!events.isLoading && !(events.data?.events.length) && (
          <div style={{ marginTop: 24 }}>
            <EmptyState pose="happy" title="這段時間沒有行程" sub="收到會議邀請或按「新會議」建立後，會出現在這裡。" />
          </div>
        )}
      </div>
    </main>
  );
}
