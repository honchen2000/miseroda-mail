// F10.1：Ask AI 信箱問答——自然語言問自己的信箱（RAG），答案附來源信連結。
import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api } from '../api/client';
import { Icon, Modal, timeAgo } from './ui';

interface AskResult {
  answer: string | null;
  keywords: string[];
  sources: { id: string; subject: string; from: string; receivedAt: number }[];
  reason?: string;
  cached?: boolean;
}

const EXAMPLES = ['上次的水電費是多少？', '包裹寄到了嗎？', '報稅的截止日期是哪天？'];

export function AskMailModal({ onClose, onOpenMessage }: {
  onClose: () => void;
  onOpenMessage: (id: string) => void;
}) {
  const [q, setQ] = useState('');
  const ask = useMutation({
    mutationFn: (question: string) => api<AskResult>('/ai/ask', { method: 'POST', body: { question }, timeoutMs: 60_000 }),
  });
  const submit = () => {
    const question = q.trim();
    if (question.length < 2 || ask.isPending) return;
    ask.mutate(question);
  };
  const r = ask.data;
  return (
    <Modal title="問信箱" desc="用一句話問自己的信箱，AI 檢索相關信件後回答並附上來源。" onClose={onClose} width={560}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <input className="input" autoFocus value={q} style={{ flex: 1 }}
            placeholder="例如：上次水電費多少？"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} />
          <button className="btn btn-primary" disabled={q.trim().length < 2 || ask.isPending} onClick={submit}>
            <Icon name="sparkle" size={14} /> {ask.isPending ? '思考中…' : '提問'}
          </button>
        </div>
        {!r && !ask.isPending && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {EXAMPLES.map((ex) => (
              <button key={ex} className="btn btn-ghost btn-sm" onClick={() => { setQ(ex); ask.mutate(ex); }}>{ex}</button>
            ))}
          </div>
        )}
        {ask.isError && <div style={{ fontSize: 12, color: 'var(--danger)' }}>回答失敗，請再試一次（AI 額度可能已用罄）</div>}
        {r && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {r.answer ? (
              <div className="ai-summary" style={{ whiteSpace: 'pre-wrap', fontSize: 13.5, lineHeight: 1.7 }}>{r.answer}</div>
            ) : (
              <p className="hint">在信箱裡找不到相關的信（檢索關鍵字：{r.keywords.join('、') || '—'}）。換個說法再試試？</p>
            )}
            {r.sources.length > 0 && (
              <div>
                <div className="hint" style={{ fontWeight: 600, marginBottom: 4 }}>來源信件</div>
                {r.sources.map((s, i) => (
                  <button key={s.id} className="linklike" style={{ display: 'block', width: '100%', textAlign: 'left', padding: '4px 0', fontSize: 13 }}
                    onClick={() => { onOpenMessage(s.id); onClose(); }}>
                    [{i + 1}] {s.subject || '（無主旨）'}
                    <span className="hint" style={{ marginLeft: 6 }}>{s.from} · {timeAgo(s.receivedAt)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
