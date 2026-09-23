// ⌘K 指令面板：模糊比對 + 鍵盤導覽 + spring 進場
import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon, type IconName } from './ui';

export interface PaletteAction {
  id: string;
  name: string;
  hint?: string;
  icon: IconName;
  run: () => void;
}

/** 簡易模糊比對：子序列命中給分，連續命中加權 */
function fuzzyScore(query: string, target: string): number {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (!q) return 1;
  if (t.includes(q)) return 100 - t.indexOf(q);
  let qi = 0;
  let score = 0;
  let streak = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      qi++;
      streak++;
      score += streak * 2;
    } else {
      streak = 0;
    }
  }
  return qi === q.length ? score : -1;
}

export function CommandPalette({ actions, onClose }: { actions: PaletteAction[]; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [hi, setHi] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const matched = useMemo(() => {
    return actions
      .map((a) => ({ a, score: fuzzyScore(q, a.name) }))
      .filter((x) => x.score >= 0)
      .sort((x, y) => y.score - x.score)
      .map((x) => x.a);
  }, [actions, q]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => setHi(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector('.hi')?.scrollIntoView({ block: 'nearest' });
  }, [hi]);

  const run = (a: PaletteAction) => {
    onClose();
    // 等面板關閉再執行（避免焦點/捲動互搶）
    setTimeout(() => a.run(), 0);
  };

  return (
    <div className="modal-backdrop palette-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="palette" role="dialog" aria-label="指令面板">
        <div className="palette-input">
          <Icon name="command" size={16} />
          <input ref={inputRef} value={q} placeholder="輸入指令或目的地…"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(h + 1, matched.length - 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
              else if (e.key === 'Enter' && matched[hi]) { e.preventDefault(); run(matched[hi]); }
              else if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
            }} />
          <kbd>esc</kbd>
        </div>
        <div className="palette-list" ref={listRef}>
          {matched.length === 0 && <div className="palette-empty">沒有符合「{q}」的指令</div>}
          {matched.map((a, i) => (
            <button key={a.id} className={`palette-item ${i === hi ? 'hi' : ''}`}
              onMouseEnter={() => setHi(i)}
              onMouseDown={(e) => { e.preventDefault(); run(a); }}>
              <Icon name={a.icon} size={15} />
              <span style={{ flex: 1, textAlign: 'left' }}>{a.name}</span>
              {a.hint && <kbd>{a.hint}</kbd>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
