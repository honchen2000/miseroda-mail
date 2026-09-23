// 取代瀏覽器原生 <select> 與 <input type=date/datetime-local> 的精美元件，對齊全站風格。
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Icon } from './ui';
import { displayLocal, formatLocal, monthGrid, parseLocal, type DateParts, type GridCell } from '../lib/datetime';

const pad = (n: number) => String(n).padStart(2, '0');

/* ============================ 精美下拉 Select ============================ */
export interface SelectOption<T> {
  value: T;
  label: string;
}
export function Select<T>({ value, onChange, options, ariaLabel, className, style, disabled }: {
  value: T;
  onChange: (v: T) => void;
  options: SelectOption<T>[];
  ariaLabel?: string;
  className?: string;
  style?: CSSProperties;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = options.find((o) => o.value === value);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  return (
    <div className={`uiselect ${className ?? ''}`} ref={ref} style={style}>
      <button type="button" className="uiselect-btn input" aria-haspopup="listbox" aria-expanded={open}
        aria-label={ariaLabel} disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => { if (e.key === 'Escape' && open) { e.stopPropagation(); setOpen(false); } }}>
        <span className="uiselect-label">{current?.label ?? ''}</span>
        <Icon name="chevronDown" size={14} />
      </button>
      {open && (
        <div className="uiselect-pop" role="listbox">
          {options.map((o) => (
            <button key={String(o.value)} type="button" role="option" aria-selected={o.value === value}
              className={`uiselect-item ${o.value === value ? 'active' : ''}`}
              onClick={() => { onChange(o.value); setOpen(false); }}>
              <span>{o.label}</span>
              {o.value === value && <Icon name="check" size={14} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ============================ 精美日期 / 日期時間選擇器 ============================ */
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
const HOURS: SelectOption<number>[] = Array.from({ length: 24 }, (_, h) => ({ value: h, label: pad(h) }));
function minuteOptions(cur: number): SelectOption<number>[] {
  const steps = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55];
  const vals = steps.includes(cur) ? steps : [cur, ...steps].sort((a, b) => a - b);
  return vals.map((m) => ({ value: m, label: pad(m) }));
}
function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function DateTimeField({ value, onChange, mode = 'datetime', ariaLabel, className, id, clearable }: {
  value: string;
  onChange: (v: string) => void;
  mode?: 'date' | 'datetime';
  ariaLabel?: string;
  className?: string;
  id?: string;
  clearable?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const parsed = parseLocal(value);
  const [view, setView] = useState(() => {
    const p = parseLocal(value);
    const base = p ? new Date(p.y, p.mo - 1, 1) : new Date();
    return { y: base.getFullYear(), m0: base.getMonth() };
  });
  // 開啟時把月曆對齊目前值
  useEffect(() => {
    if (open && parsed) setView({ y: parsed.y, m0: parsed.mo - 1 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const emit = (patch: Partial<DateParts>) => {
    const cur: DateParts = parsed ?? { y: view.y, mo: view.m0 + 1, d: 1, h: 9, mi: 0 };
    onChange(formatLocal({ ...cur, ...patch }, mode));
  };
  const pickDay = (c: GridCell) => {
    emit({ y: c.y, mo: c.mo, d: c.d });
    if (mode === 'date') setOpen(false);
  };
  const stepMonth = (dir: number) => setView((v) => {
    const idx = v.y * 12 + v.m0 + dir;
    return { y: Math.floor(idx / 12), m0: ((idx % 12) + 12) % 12 };
  });

  const grid = monthGrid(view.y, view.m0);
  const tKey = todayKey();
  const selKey = parsed ? `${parsed.y}-${pad(parsed.mo)}-${pad(parsed.d)}` : '';

  return (
    <div className={`uidate ${className ?? ''}`} ref={ref}>
      <button type="button" id={id} className="uidate-btn input" aria-haspopup="dialog" aria-expanded={open} aria-label={ariaLabel}
        onClick={() => setOpen((v) => !v)}>
        <Icon name={mode === 'date' ? 'calendar' : 'clock'} size={14} />
        <span className={parsed ? '' : 'uidate-ph'}>{displayLocal(parsed, mode) || (mode === 'date' ? '選擇日期' : '選擇日期與時間')}</span>
      </button>
      {open && (
        <div className="uidate-pop" role="dialog" aria-label={ariaLabel ?? '日期選擇器'}>
          <div className="uidate-head">
            <button type="button" className="iconbtn" aria-label="上個月" onClick={() => stepMonth(-1)}><Icon name="back" size={15} /></button>
            <span className="uidate-title">{view.y} 年 {view.m0 + 1} 月</span>
            <button type="button" className="iconbtn" aria-label="下個月" style={{ transform: 'scaleX(-1)' }} onClick={() => stepMonth(1)}><Icon name="back" size={15} /></button>
          </div>
          <div className="uidate-grid">
            {WEEKDAYS.map((w) => <div key={w} className="uidate-dow">{w}</div>)}
            {grid.map((c) => (
              <button key={c.key} type="button"
                className={`uidate-cell${c.inMonth ? '' : ' dim'}${c.key === selKey ? ' sel' : ''}${c.key === tKey ? ' today' : ''}`}
                onClick={() => pickDay(c)}>{c.d}</button>
            ))}
          </div>
          {mode === 'datetime' && (
            <div className="uidate-time">
              <span className="uidate-time-label">時間</span>
              <Select value={parsed?.h ?? 9} onChange={(h) => emit({ h })} options={HOURS} ariaLabel="小時" className="uidate-time-sel" />
              <span>:</span>
              <Select value={parsed?.mi ?? 0} onChange={(mi) => emit({ mi })} options={minuteOptions(parsed?.mi ?? 0)} ariaLabel="分鐘" className="uidate-time-sel" />
            </div>
          )}
          {clearable && parsed && (
            <button type="button" className="linklike uidate-clear" onClick={() => { onChange(''); setOpen(false); }}>清除</button>
          )}
        </div>
      )}
    </div>
  );
}
