// 取代瀏覽器原生 confirm()/prompt() 的 promise 式精美彈窗。
// 模組層 queue + useSyncExternalStore，任何地方都能 await confirmDialog()/promptDialog()，
// 由掛在 App 根的 <DialogHost/> 統一渲染。
import { useState, useSyncExternalStore } from 'react';
import { Modal } from './ui';

interface ConfirmReq {
  kind: 'confirm';
  id: number;
  title: string;
  body?: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  resolve: (v: boolean) => void;
}
interface PromptReq {
  kind: 'prompt';
  id: number;
  title: string;
  body?: string;
  label?: string;
  placeholder?: string;
  initial?: string;
  confirmText?: string;
  validate?: (v: string) => boolean;
  resolve: (v: string | null) => void;
}
type DialogReq = ConfirmReq | PromptReq;

let queue: DialogReq[] = [];
let seq = 0; // 每個 req 唯一 id → DialogHost 以此當 key，確保排隊的下一個 prompt 重新掛載、不沿用上一個輸入
const listeners = new Set<() => void>();
function emit() { for (const l of listeners) l(); }
function subscribe(cb: () => void) { listeners.add(cb); return () => { listeners.delete(cb); }; }
function snapshot(): DialogReq | null { return queue[0] ?? null; }

export function confirmDialog(opts: Omit<ConfirmReq, 'kind' | 'resolve' | 'id'>): Promise<boolean> {
  return new Promise((resolve) => { queue = [...queue, { kind: 'confirm', id: ++seq, ...opts, resolve }]; emit(); });
}
export function promptDialog(opts: Omit<PromptReq, 'kind' | 'resolve' | 'id'>): Promise<string | null> {
  return new Promise((resolve) => { queue = [...queue, { kind: 'prompt', id: ++seq, ...opts, resolve }]; emit(); });
}

function finishConfirm(req: ConfirmReq, v: boolean) {
  queue = queue.filter((q) => q !== req);
  emit();
  req.resolve(v);
}
function finishPrompt(req: PromptReq, v: string | null) {
  queue = queue.filter((q) => q !== req);
  emit();
  req.resolve(v);
}

const ACTIONS: React.CSSProperties = { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 };

function ConfirmModal({ req }: { req: ConfirmReq }) {
  return (
    <Modal title={req.title} onClose={() => finishConfirm(req, false)} width={440}>
      {req.body && <p style={{ whiteSpace: 'pre-wrap', color: 'var(--text-secondary)', lineHeight: 1.6, margin: '4px 0 0' }}>{req.body}</p>}
      <div style={ACTIONS}>
        <button className="btn btn-ghost" onClick={() => finishConfirm(req, false)}>{req.cancelText ?? '取消'}</button>
        <button className="btn btn-primary" autoFocus
          style={req.danger ? { background: 'var(--danger)', borderColor: 'var(--danger)' } : undefined}
          onClick={() => finishConfirm(req, true)}>{req.confirmText ?? '確定'}</button>
      </div>
    </Modal>
  );
}

function PromptModal({ req }: { req: PromptReq }) {
  const [val, setVal] = useState(req.initial ?? '');
  const ok = req.validate ? req.validate(val) : val.trim().length > 0;
  return (
    <Modal title={req.title} onClose={() => finishPrompt(req, null)} width={440}>
      {req.body && <p style={{ color: 'var(--text-secondary)', lineHeight: 1.6, margin: '4px 0 10px' }}>{req.body}</p>}
      <div className="field">
        {req.label && <label>{req.label}</label>}
        <input className="input" autoFocus value={val} placeholder={req.placeholder}
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && ok) finishPrompt(req, val); }} />
      </div>
      <div style={ACTIONS}>
        <button className="btn btn-ghost" onClick={() => finishPrompt(req, null)}>取消</button>
        <button className="btn btn-primary" disabled={!ok} onClick={() => finishPrompt(req, val)}>{req.confirmText ?? '確定'}</button>
      </div>
    </Modal>
  );
}

export function DialogHost() {
  const req = useSyncExternalStore(subscribe, snapshot, snapshot);
  if (!req) return null;
  // key={req.id}：排隊的下一個對話框重新掛載，不沿用上一個的本地輸入狀態
  return req.kind === 'confirm' ? <ConfirmModal key={req.id} req={req} /> : <PromptModal key={req.id} req={req} />;
}
