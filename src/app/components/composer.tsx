// 寫信視窗 —— 收件人 chips（to/cc/bcc）、輕量富文本、罐頭範本、上傳/排程/守門
import { createPortal } from 'react-dom';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { api } from '../api/client';
import { uploadAttachment, uploadShareFile, deleteStagedAttachment, useIdentities, useSignatures, SHARE_MAX_BYTES, UploadAbortedError, type ComposerAttachment, type ComposerDraft, type ShareLink, type UploadProgress } from '../api/send';
import { signatureBlockHtml } from '../lib/signature';
import { useAiRewrite, useAiSubject, useAiCompose, type RewriteMode } from '../api/mail';
import { useContactGroups } from '../api/contacts';
import { Icon, Modal, timeAgo } from './ui';
import { DateTimeField, Select } from './inputs';
import { confirmDialog, promptDialog } from './dialog';
import { formatLocal } from '../lib/datetime';
import { fillTemplate, recipientDisplayName } from '../lib/template';
import { sendSchedulePresets } from '../lib/schedule';
import { haptics } from '../lib/haptics';

const AI_MODES: { mode: RewriteMode; label: string }[] = [
  { mode: 'polish', label: '潤飾' },
  { mode: 'formal', label: '更正式' },
  { mode: 'friendly', label: '更親切' },
  { mode: 'concise', label: '更精簡' },
];

/* ---------- 收件人 chips 欄（to / cc / bcc 共用） ---------- */
const COMMON_DOMAINS = [
  'gmail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'yahoo.com.tw',
  'icloud.com', 'proton.me', 'msn.com', 'live.com', 'miseroda.com',
];

const EMAIL_RE = /^[^\s@,，;]+@[^\s@,，;]+\.[^\s@,，;]+$/;

function splitChips(value: string): string[] {
  return value.split(/[,，;\s]+/).map((s) => s.trim()).filter(Boolean);
}

type RecipSug =
  | { kind: 'addr'; addr: string; lastUsed: number } // lastUsed=0 → 網域補全（不顯示時間）
  | { kind: 'group'; name: string; emails: string[] }; // F4.3b：聯絡人群組（選取＝一鍵展開成員）

function RecipientChips({ label, value, onChange, autoFocusId, suggestHistory, groups }: {
  label: string;
  value: string; // 逗號串（與草稿/寄送 schema 相容）
  onChange: (v: string) => void;
  autoFocusId?: string;
  suggestHistory?: boolean;
  groups?: { id: string; name: string; emails: string[] }[]; // F4.3b
}) {
  const chips = useMemo(() => splitChips(value), [value]);
  const [token, setToken] = useState('');
  const [sugs, setSugs] = useState<RecipSug[]>([]);
  const [hi, setHi] = useState(0);
  const [show, setShow] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const commit = (addr: string) => {
    const a = addr.trim().replace(/[,，;]+$/, '');
    if (!a) return;
    onChange([...chips, a].join(', '));
    setToken('');
    setShow(false);
  };
  // F4.3b：群組展開——把成員地址一次加入（不分大小寫去重，跳過已在 chips 的）。
  const commitEmails = (emails: string[]) => {
    const seen = new Set(chips.map((c) => c.toLowerCase()));
    const merged = [...chips];
    for (const e of emails) {
      if (seen.has(e.toLowerCase())) continue;
      merged.push(e);
      seen.add(e.toLowerCase());
    }
    onChange(merged.join(', '));
    setToken('');
    setShow(false);
  };
  const choose = (s: RecipSug) => (s.kind === 'group' ? commitEmails(s.emails) : commit(s.addr));

  const removeChip = (i: number) => onChange(chips.filter((_, j) => j !== i).join(', '));

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!token) {
      setSugs([]);
      setShow(false);
      return;
    }
    const at = token.indexOf('@');
    if (at > 0) {
      const local = token.slice(0, at);
      const domPart = token.slice(at + 1).toLowerCase();
      const list: RecipSug[] = COMMON_DOMAINS.filter((d) => d.startsWith(domPart) && d !== domPart)
        .slice(0, 6)
        .map((d) => ({ kind: 'addr' as const, addr: `${local}@${d}`, lastUsed: 0 }));
      setSugs(list);
      setShow(list.length > 0);
      setHi(0);
      return;
    }
    // F4.3b：群組名比對（無 '@' 時）→ 置頂，選取即展開成員。
    const tl = token.toLowerCase();
    const groupSugs: RecipSug[] = (groups ?? [])
      .filter((g) => g.emails.length && g.name.toLowerCase().includes(tl))
      .slice(0, 4)
      .map((g) => ({ kind: 'group' as const, name: g.name, emails: g.emails }));
    if (suggestHistory === false) {
      setSugs(groupSugs);
      setShow(groupSugs.length > 0);
      setHi(0);
      return;
    }
    debounceRef.current = setTimeout(() => {
      void api<{ suggestions: { addr: string; lastUsed: number }[] }>(`/contacts/suggest?q=${encodeURIComponent(token)}`)
        .then((res) => {
          const addrSugs: RecipSug[] = res.suggestions.filter((s) => !chips.includes(s.addr)).map((s) => ({ kind: 'addr' as const, ...s }));
          const combined = [...groupSugs, ...addrSugs];
          setSugs(combined);
          setShow(combined.length > 0);
          setHi(0);
        })
        .catch(() => setSugs(groupSugs.length ? groupSugs : []));
    }, 200);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (show && sugs.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => (h + 1) % sugs.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => (h - 1 + sugs.length) % sugs.length); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); choose(sugs[hi]); return; }
      if (e.key === 'Escape') { e.stopPropagation(); setShow(false); return; }
    }
    if ((e.key === 'Enter' || e.key === 'Tab' || e.key === ',' || e.key === ' ') && token.trim()) {
      if (EMAIL_RE.test(token.trim())) {
        e.preventDefault();
        commit(token);
      } else if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault(); // 不完整的地址先留著
      }
    } else if (e.key === 'Backspace' && !token && chips.length) {
      removeChip(chips.length - 1);
    }
  };

  return (
    <div className="composer-fieldrow">
      <span className="tag">{label}</span>
      <div className="chips-box" onClick={() => inputRef.current?.focus()}>
        {chips.map((c, i) => (
          <span key={`${c}-${i}`} className={`addr-chip ${EMAIL_RE.test(c) ? '' : 'bad'}`}>
            {c}
            <button type="button" aria-label={`移除 ${c}`} onClick={() => removeChip(i)}><Icon name="x" size={11} /></button>
          </span>
        ))}
        <input id={autoFocusId} ref={inputRef} value={token} placeholder={chips.length ? '' : 'name@example.com'}
          spellCheck={false} autoComplete="off"
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => {
            setTimeout(() => setShow(false), 150);
            if (token.trim() && EMAIL_RE.test(token.trim())) commit(token);
          }} />
      </div>
      {show && sugs.length > 0 && (
        <div className="suggest-pop" role="listbox">
          {sugs.map((s, i) => (
            <button key={s.kind === 'group' ? `g:${s.name}` : s.addr} type="button" role="option" aria-selected={i === hi}
              className={`suggest-item ${i === hi ? 'hi' : ''}`}
              onMouseDown={(e) => { e.preventDefault(); choose(s); }}
              onMouseEnter={() => setHi(i)}>
              {s.kind === 'group' ? (
                <>
                  <span className="suggest-addr">👪 {s.name}</span>
                  <span className="suggest-meta">群組 · {s.emails.length} 人</span>
                </>
              ) : (
                <>
                  <span className="suggest-addr">{s.addr}</span>
                  {s.lastUsed > 0 && <span className="suggest-meta">{timeAgo(s.lastUsed)}聯絡過</span>}
                </>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------- 輕量富文本編輯器 ---------- */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function plainToHtml(text: string): string {
  return text.split(/\n{2,}/).map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('');
}

interface Template {
  id: string;
  name: string;
  body: string;
}

/** F8.4：讓撰寫器 footer 的「AI 草擬」鈕能把生成內容寫進 contentEditable（不能靠 dSIH 重播種）。 */
export interface EditorApi { insertDraft: (html: string) => void }

function RichBody({ seedHtml, onSync, templates, pushToast, recipientName, aiContext, sigContent, editorApi }: {
  seedHtml: string;
  onSync: (text: string, html: string) => void;
  templates: Template[];
  pushToast: (m: string) => void;
  recipientName: string; // F2.7：範本 {{name}} 代入 + AI 改寫稱謂
  aiContext?: string | null; // F2.7：回覆原信情境（供 AI 改寫貼合）
  sigContent?: string; // F4.4：目前寄件身分對應的簽名內容（變更時抽換 [data-sig] 區塊）
  editorApi?: MutableRefObject<EditorApi | null>; // F8.4：footer AI 草擬 → 命令式插入
}) {
  const ref = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [showTpl, setShowTpl] = useState(false);
  const [showAi, setShowAi] = useState(false);
  // F6.8：選取浮動格式泡泡的位置（null = 隱藏）。below=選取在編輯區頂端、無空間時改置於下方。
  const [bubble, setBubble] = useState<{ top: number; left: number; below: boolean } | null>(null);
  const rewrite = useAiRewrite();

  // 初始內容只在掛載時用 ref 播種一次，之後 DOM 完全交給 contentEditable。
  // 不能用 dangerouslySetInnerHTML：React 19 在每次 re-render 都會把它重寫回去
  // （物件字面量 identity 每次都新），輸入的字會在 onSync→setState 的 re-render 中被清掉。
  useLayoutEffect(() => {
    if (ref.current) ref.current.innerHTML = seedHtml;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // F4.4：切寄件身分 → 命令式抽換 [data-sig] 區塊（非 render-loop dSIH，只在 sigContent 變更時動，不重設游標）。
  const prevSig = useRef<string | null>(null);
  useEffect(() => {
    if (sigContent === undefined) return;
    if (prevSig.current === null) { prevSig.current = sigContent; return; } // 掛載基準：seed 已含正確簽名，不抽換
    if (prevSig.current === sigContent) return;
    prevSig.current = sigContent;
    const el = ref.current;
    if (!el) return;
    const block = el.querySelector('[data-sig]');
    const html = signatureBlockHtml(sigContent);
    if (block) {
      if (html) block.outerHTML = html;
      else block.remove();
    } else if (html) {
      el.insertAdjacentHTML('beforeend', html); // 被刪過 → 補在末尾
    }
    onSync(el.innerText, el.innerHTML);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sigContent]);

  // F6.8：選字就地浮現格式泡泡（粗體/斜體/底線/連結/引用）。僅桌機（pointer:fine）：
  // 觸控裝置的 OS 原生選取選單已含 B/I/U，疊自訂泡泡會雙選單競態，故觸控不註冊 listener。
  // （桌機無 navigator.vibrate → 不綁 haptic，省去 dead code。）
  useEffect(() => {
    if (typeof window === 'undefined' || window.matchMedia('(pointer: coarse)').matches) return;
    const scroller = ref.current; // .composer-body.rich 自身就是 overflow:auto 捲動容器
    const onSel = () => {
      const el = ref.current;
      const wrap = wrapRef.current;
      const hide = () => setBubble(null);
      if (!el || !wrap || !el.isConnected) return hide(); // re-key 卸載後殘留事件的防禦
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return hide();
      const range = sel.getRangeAt(0);
      if (!el.contains(range.commonAncestorContainer)) return hide(); // 選取不在本編輯區
      const br = range.getBoundingClientRect();
      if (!br.width || !br.height) return hide(); // 任一維度為 0（退化 range）就不顯示
      const wrapRect = wrap.getBoundingClientRect();
      if (wrapRect.width < 120) return hide(); // 容器過窄 → clamp 會反轉成負值、泡泡飄出畫面
      const relTop = br.top - wrapRect.top;
      const roomAbove = relTop > 44; // 頂端無空間 → 改置選取下方
      const top = roomAbove ? relTop : br.bottom - wrapRect.top;
      const left = Math.min(Math.max(br.left - wrapRect.left + br.width / 2, 56), wrapRect.width - 56);
      setBubble({ top, left, below: !roomAbove });
    };
    document.addEventListener('selectionchange', onSel);
    scroller?.addEventListener('scroll', onSel, { passive: true }); // 內捲不觸發 selectionchange → 補捲動重算，泡泡不脫鉤
    return () => {
      document.removeEventListener('selectionchange', onSel);
      scroller?.removeEventListener('scroll', onSel);
    };
  }, []);

  const sync = () => {
    const el = ref.current;
    if (el) onSync(el.innerText, el.innerHTML);
  };

  // F8.4：對外開放命令式插入（footer「AI 草擬」用）。onSync 存 ref 避免 effect 捕捉到過期閉包。
  const onSyncRef = useRef(onSync);
  onSyncRef.current = onSync;
  useEffect(() => {
    if (!editorApi) return;
    editorApi.current = {
      insertDraft(html: string) {
        const el = ref.current;
        if (!el) return;
        el.focus();
        if (!el.innerText.trim()) el.innerHTML = html; // 空白正文 → 直接置入
        else document.execCommand('insertHTML', false, html); // 有內容 → 於游標插入，不覆蓋
        onSyncRef.current(el.innerText, el.innerHTML);
      },
    };
    return () => { editorApi.current = null; };
  }, [editorApi]);

  const exec = (cmd: string, value?: string) => {
    ref.current?.focus();
    document.execCommand(cmd, false, value);
    sync();
  };

  const addLink = async () => {
    // promptDialog 的輸入框 autofocus 會搶走焦點、collapse 編輯區選取 → 先存 range，
    // 確認後還原再 createLink，否則 execCommand 套到空游標、選取文字不會變成連結。
    const sel0 = window.getSelection();
    const saved = sel0 && sel0.rangeCount ? sel0.getRangeAt(0).cloneRange() : null;
    const url = await promptDialog({
      title: '插入連結',
      label: '連結網址',
      placeholder: 'https://…',
      validate: (v) => /^https?:\/\/.+/i.test(v.trim()),
    });
    if (url && /^https?:\/\//i.test(url.trim())) {
      ref.current?.focus();
      if (saved) { const s = window.getSelection(); s?.removeAllRanges(); s?.addRange(saved); }
      document.execCommand('createLink', false, url.trim());
      sync();
    }
  };

  const insertTemplate = (t: Template) => {
    setShowTpl(false);
    ref.current?.focus();
    // F2.7：{{name}}/{{firstName}} 即時代入收件人顯示名
    document.execCommand('insertHTML', false, plainToHtml(fillTemplate(t.body, recipientName)));
    sync();
  };

  const applyRewrite = async (mode: RewriteMode) => {
    setShowAi(false);
    const el = ref.current;
    const text = (el?.innerText ?? '').trim();
    if (!text) { pushToast('先寫點內容再用 AI 改寫'); return; }
    // AI 改寫以純文字進出 → 會攤平既有格式（粗體/清單/連結），且連結網址會消失。
    // 偵測到富格式時先確認，避免無聲資料遺失（含瀏覽器 execCommand 的標籤差異）。
    if (/<(b|strong|i|em|u|a|ul|ol|li|blockquote)\b/i.test(el?.innerHTML ?? '') &&
        !(await confirmDialog({
          title: 'AI 改寫會清除格式',
          body: '內容含有格式（粗體／清單／連結等）。AI 改寫會轉成純文字並遺失這些格式，連結網址也會消失。確定繼續？',
          confirmText: '繼續改寫',
        }))) {
      return;
    }
    // F2.7：把收件人 + 回覆原信情境一起給 AI → 改寫後稱謂/語氣貼合對象
    const ctx = [recipientName ? `收件人：${recipientName}` : '', aiContext ? `原信情境：${aiContext}` : '']
      .filter(Boolean)
      .join('\n');
    rewrite.mutate(
      { text, mode, context: ctx || undefined },
      {
        onSuccess: (r) => {
          // 重新播種整段（比照初始：直接寫 innerHTML，不走 dSIH），再同步回 draft
          if (ref.current) { ref.current.innerHTML = plainToHtml(r.text); sync(); }
          pushToast('已用 AI 改寫 ✨');
        },
        onError: () => pushToast('AI 改寫失敗，請再試一次'),
      },
    );
  };

  return (
    <div className="rich-wrap" ref={wrapRef}>
      <div className="rich-toolbar" role="toolbar" aria-label="格式">
        <button type="button" aria-label="粗體" data-tooltip="粗體" onMouseDown={(e) => { e.preventDefault(); exec('bold'); }}><b>B</b></button>
        <button type="button" aria-label="斜體" data-tooltip="斜體" onMouseDown={(e) => { e.preventDefault(); exec('italic'); }}><i>I</i></button>
        <button type="button" aria-label="底線" data-tooltip="底線" onMouseDown={(e) => { e.preventDefault(); exec('underline'); }}><u>U</u></button>
        <span className="sep"></span>
        <button type="button" aria-label="插入連結" data-tooltip="連結" onMouseDown={(e) => { e.preventDefault(); addLink(); }}><Icon name="clip" size={13} /></button>
        <button type="button" aria-label="項目清單" data-tooltip="項目清單" onMouseDown={(e) => { e.preventDefault(); exec('insertUnorderedList'); }}>•≡</button>
        <button type="button" aria-label="編號清單" data-tooltip="編號清單" onMouseDown={(e) => { e.preventDefault(); exec('insertOrderedList'); }}>1≡</button>
        <button type="button" aria-label="引用" data-tooltip="引用" onMouseDown={(e) => { e.preventDefault(); exec('formatBlock', 'blockquote'); }}>❝</button>
        <span className="sep"></span>
        {templates.length > 0 && (
          <span className="rich-menuwrap">
            <button type="button" data-tooltip="插入範本（/）" onMouseDown={(e) => { e.preventDefault(); setShowTpl((v) => !v); }}>
              <Icon name="draft" size={13} /> 範本
            </button>
            {showTpl && (
              // 選單錨定在按鈕上（relative 包裹），由按鈕左緣下拉；避免 right:0 釘在工具列邊緣而跑版
              <div className="suggest-pop" style={{ left: 0, right: 'auto', minWidth: 200 }}>
                {templates.map((t) => (
                  <button key={t.id} type="button" className="suggest-item" onMouseDown={(e) => { e.preventDefault(); insertTemplate(t); }}>
                    {t.name}
                  </button>
                ))}
              </div>
            )}
          </span>
        )}
        <span className="rich-menuwrap">
          <button type="button" data-tooltip="AI 改寫 / 調語氣" disabled={rewrite.isPending}
            onMouseDown={(e) => { e.preventDefault(); setShowAi((v) => !v); }}>
            <Icon name="sparkle" size={13} /> {rewrite.isPending ? '改寫中…' : 'AI'}
          </button>
          {showAi && (
            // 選單由按鈕右緣下拉（向左展開），緊貼 AI 按鈕、不再飄到工具列最右側
            <div className="suggest-pop" style={{ right: 0, left: 'auto', minWidth: 140 }}>
              {AI_MODES.map((m) => (
                <button key={m.mode} type="button" className="suggest-item" onMouseDown={(e) => { e.preventDefault(); applyRewrite(m.mode); }}>
                  {m.label}
                </button>
              ))}
            </div>
          )}
        </span>
      </div>
      <div ref={ref} className="composer-body rich" role="textbox" aria-label="郵件正文" aria-multiline="true" contentEditable suppressContentEditableWarning
        data-placeholder="寫點什麼…（/ 插入範本）"
        onInput={sync}
        onKeyDown={(e) => {
          if (e.key === '/' && (ref.current?.innerText ?? '').trim() === '' && templates.length) {
            e.preventDefault();
            setShowTpl(true);
          } else if (e.key === 'Escape' && (showTpl || showAi)) {
            // stopPropagation：別讓 Escape 冒泡到 App 的全域 handler 把整個撰寫視窗收掉
            e.stopPropagation();
            setShowTpl(false);
            setShowAi(false);
          }
        }} />
      {bubble && (
        // mousedown preventDefault：保住編輯區的選取（不讓焦點/selection 因點按鈕而消失）
        <div className="sel-bubble" role="toolbar" aria-label="選取格式"
          style={{ top: bubble.top, left: bubble.left, transform: bubble.below ? 'translate(-50%, 8px)' : 'translate(-50%, calc(-100% - 8px))' }}>
          <button type="button" aria-label="粗體" data-tooltip="粗體" onMouseDown={(e) => { e.preventDefault(); exec('bold'); }}><b>B</b></button>
          <button type="button" aria-label="斜體" data-tooltip="斜體" onMouseDown={(e) => { e.preventDefault(); exec('italic'); }}><i>I</i></button>
          <button type="button" aria-label="底線" data-tooltip="底線" onMouseDown={(e) => { e.preventDefault(); exec('underline'); }}><u>U</u></button>
          <span className="sep"></span>
          <button type="button" aria-label="插入連結" data-tooltip="連結" onMouseDown={(e) => { e.preventDefault(); addLink(); }}><Icon name="clip" size={12} /></button>
          <button type="button" aria-label="引用" data-tooltip="引用" onMouseDown={(e) => { e.preventDefault(); exec('formatBlock', 'blockquote'); }}>❝</button>
        </div>
      )}
    </div>
  );
}

export const SEND_MAX_BYTES = 5 * 1024 * 1024;

export function composerBytes(draft: ComposerDraft): number {
  const textBytes = new TextEncoder().encode(draft.body + draft.subject).byteLength;
  return textBytes + draft.attachments.reduce((s, a) => s + a.sizeBytes, 0);
}

/** 上傳中的單一檔案。完成後這筆會消失，改由 draft.attachments / draft.linkFiles 承接。 */
interface InflightUpload {
  key: string;
  file: File;
  /** true = 走 R2 下載連結（>5 MiB）；false = 內嵌附件。 */
  asShare: boolean;
  loaded: number;
  bytesPerSec: number;
  etaSec: number | null;
  status: 'uploading' | 'error';
  /** 失敗原因（伺服器錯誤碼或 network）。 */
  error?: string;
  abort?: () => void;
}

function fmtSpeed(bps: number): string {
  if (bps <= 0) return '';
  const mb = bps / (1024 * 1024);
  return mb >= 0.1 ? `${mb.toFixed(1)} MB/s` : `${Math.max(1, Math.round(bps / 1024))} KB/s`;
}

function fmtEta(sec: number | null): string {
  if (sec === null) return '';
  if (sec <= 0) return '即將完成';
  if (sec < 60) return `剩 ${sec} 秒`;
  return `剩 ${Math.ceil(sec / 60)} 分`;
}

const UPLOAD_ERROR_TEXT: Record<string, string> = {
  network: '連線中斷',
  too_large: '檔案超過上限',
  bad_response: '伺服器回應異常',
};

/** 寄件冷靜守門：回傳需要使用者確認的警告（null = 直接放行） */
function sendWarning(draft: ComposerDraft): string | null {
  const mentionsAttach = /附件|附上|夾帶|檢附|附檔|attach(ed|ment)|enclosed/i.test(draft.body + draft.subject);
  if (mentionsAttach && draft.attachments.length === 0) {
    return '信件內容提到附件，但沒有夾帶任何檔案。仍要寄出嗎？';
  }
  const recipients = splitChips(draft.to);
  const hasExternal = recipients.some((r) => r.includes('@') && !r.toLowerCase().endsWith('@miseroda.com'));
  if (!draft.subject.trim() && hasExternal) {
    return '主旨是空白的，寄給站外收件人通常需要主旨。仍要寄出嗎？';
  }
  return null;
}

export function Composer({ draft, onChange, onSend, onSchedule, onSendAndArchive, onClose, autosave, templates, pushToast, minimized, onMinimize, userEmail, contactNames, defaultSignature, onEncryptLink, inlineTarget, slotIndex }: {
  inlineTarget?: HTMLElement | null;
  /** F17.2：右下角並排槽位。0 = 最靠右（單扇時的原位置），1 = 往左讓開一個視窗寬。內嵌／手機不適用。 */
  slotIndex?: number;
  draft: ComposerDraft;
  onChange: (d: ComposerDraft) => void;
  onSend: () => void;
  onSchedule: (at: number) => void;
  /** F3.3：傳送並封存原對話串（僅回覆時提供）。 */
  onSendAndArchive?: () => void;
  onClose: () => void;
  autosave: 'idle' | 'saving' | 'saved';
  templates: Template[];
  pushToast: (text: string) => void;
  minimized: boolean;
  onMinimize: () => void;
  /** 使用者 canonical email，供 Send-as 寄件身分組合 +tag 別名 */
  userEmail: string;
  /** F2.7：email→自訂名對照，供範本 {{name}} 與 AI 稱謂取顯示名 */
  contactNames: Map<string, string>;
  /** F4.4：預設簽名內容（= me.signature，已解析為預設簽名或舊單一簽名）。 */
  defaultSignature?: string;
  /** F8.4：把「建立加密訊息連結」外露到 footer 更多選單（帶入目前正文明文）。 */
  onEncryptLink?: (initialBody?: string) => void;
}) {
  // Keep one portal container while moving between inline reply and floating
  // composition, so editor history, uncommitted recipient text and uploads survive.
  const [portalRoot] = useState(() => document.createElement('div'));
  useLayoutEffect(() => {
    (inlineTarget ?? document.body).appendChild(portalRoot);
    return () => { portalRoot.remove(); };
  }, [inlineTarget, portalRoot]);
  useEffect(() => {
    if (inlineTarget && !minimized) {
      inlineTarget.scrollIntoView({ block: 'start' });
      inlineTarget.querySelector<HTMLElement>('[contenteditable="true"]')?.focus({ preventScroll: true });
    }
  }, [inlineTarget, minimized]);
  // 寄件身分：custom（+tag）模式 iff fromAlias 含 +；plain owned 別名走下拉、null 走 canonical。
  const [fromCustom, setFromCustom] = useState(() => !!draft.fromAlias && /\+/.test(draft.fromAlias));
  const identities = useIdentities();
  const signatures = useSignatures().data?.signatures ?? []; // F4.4
  // F4.4：目前寄件身分對應的簽名內容——綁定別名用其簽名，否則用預設（canonical/+tag/未綁）。
  const sigContent = useMemo(() => {
    const fallback = defaultSignature ?? '';
    if (!draft.fromAlias || fromCustom) return fallback;
    const alias = identities.data?.aliases.find((a) => a.address === draft.fromAlias);
    if (!alias?.signatureId) return fallback;
    return signatures.find((s) => s.id === alias.signatureId)?.content ?? fallback;
  }, [draft.fromAlias, fromCustom, identities.data, signatures, defaultSignature]);
  // F2.7：第一個收件人的顯示名（自訂名 > local-part）→ 範本 {{name}} 與 AI 稱謂用
  const recipientName = recipientDisplayName(splitChips(draft.to)[0], contactNames);
  // 別名被 admin 刪除後，草稿殘留的 fromAlias 送出時會被後端 400；身分清單載入後對不上就清掉、回 canonical。
  useEffect(() => {
    if (!fromCustom && draft.fromAlias && identities.data && !identities.data.aliases.some((a) => a.address === draft.fromAlias)) {
      onChange({ ...draft, fromAlias: null });
    }
  }, [identities.data, draft.fromAlias, fromCustom, draft, onChange]);
  const fileRef = useRef<HTMLInputElement>(null);
  const aiSubject = useAiSubject();
  const suggestSubject = () => {
    const text = draft.body.trim();
    if (!text) { pushToast('先寫點內容再讓 AI 建議主旨'); return; }
    aiSubject.mutate(text, {
      onSuccess: (r) => { onChange({ ...draft, subject: r.subject }); pushToast('已建議主旨 ✨'); },
      onError: () => pushToast('建議主旨失敗，請再試一次'),
    });
  };
  // 上傳中的檔案（每檔一列，含真實進度）。上傳完成即從這裡移除、進 draft.attachments / linkFiles。
  const [inflight, setInflight] = useState<InflightUpload[]>([]);
  // ⚠️ 上傳完成的回呼可能在好幾次 render 之後才觸發（大檔案要傳很久），若直接用 closure 裡的
  // `draft`，會拿到「開始上傳當下」的快照 → 把使用者上傳期間打的字整段回捲。一律讀這個 ref。
  const draftRef = useRef(draft);
  draftRef.current = draft;
  // 已取消的上傳 key。abort() 是在 state 落地後才拿得到的，使用者若在那之前就按取消，
  // 光靠 abort 會漏掉；而漏掉的那筆若之後上傳成功，附件會「取消了還是跑出來」。
  const cancelledRef = useRef<Set<string>>(new Set());
  const uploading = inflight.some((u) => u.status === 'uploading');
  const [dragging, setDragging] = useState(false); // F6.5：拖檔到撰寫器中
  const [showSchedule, setShowSchedule] = useState(false);
  const [scheduleVal, setScheduleVal] = useState('');
  const [showCc, setShowCc] = useState(!!(draft.cc || draft.bcc));
  const [guard, setGuard] = useState<{ msg: string; run: () => void } | null>(null);
  const groups = useContactGroups().data?.groups; // F4.3b：收件人欄群組展開（一鍵寄給家人）
  const [shake, setShake] = useState(false);
  // 富文本初始內容只在掛載時 seed 一次（避免每次輸入打斷游標）
  const [seedHtml] = useState(() => draft.bodyHtml ?? plainToHtml(draft.body));
  // F8.4：footer「AI 草擬」與「更多」選單
  const editorApi = useRef<EditorApi | null>(null);
  const aiCompose = useAiCompose();
  const [aiDraftOpen, setAiDraftOpen] = useState(false);
  const [aiPrompt, setAiPrompt] = useState('');
  const [footMore, setFootMore] = useState(false);
  const runAiDraft = () => {
    const p = aiPrompt.trim();
    if (!p || aiCompose.isPending) return;
    aiCompose.mutate(p, {
      onSuccess: (r) => {
        editorApi.current?.insertDraft(plainToHtml(r.text));
        setAiDraftOpen(false);
        setAiPrompt('');
        pushToast('已插入 AI 草稿 ✨');
      },
      onError: () => pushToast('生成失敗，請再試一次'),
    });
  };

  /** 寄出紙飛機（動畫 4）：send 圖示沿 45° 飛出淡化 */
  const flyPlane = () => {
    if (document.documentElement.getAttribute('data-motion') !== 'on') return;
    const btn = document.getElementById('composer-send-btn');
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    const el = document.createElement('div');
    el.setAttribute('aria-hidden', 'true');
    el.style.cssText = `position:fixed;left:${r.left + 10}px;top:${r.top + 6}px;z-index:120;color:var(--accent);pointer-events:none`;
    el.innerHTML = '<svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 1.5 7.2 8.8"/><path d="M14.5 1.5 9.8 14.5l-2.6-5.7-5.7-2.6Z"/></svg>';
    document.body.appendChild(el);
    el.animate(
      [
        { transform: 'translate(0,0) scale(1) rotate(0deg)', opacity: 1 },
        { transform: 'translate(130px,-150px) scale(.55) rotate(12deg)', opacity: 0 },
      ],
      { duration: 650, easing: 'cubic-bezier(.22,1,.36,1)' },
    ).onfinish = () => el.remove();
  };

  // action 預設為一般寄出；F3.3「傳送並封存」傳 onSendAndArchive。守門確認後執行同一個 action。
  const trySend = (action: () => void = onSend) => {
    const warn = sendWarning(draft);
    if (warn) {
      haptics.warn(); // F3.4：被守門擋下（shake）給警示觸覺
      setGuard({ msg: warn, run: () => { flyPlane(); action(); } });
      return;
    }
    flyPlane();
    action();
  };

  // 上限提示要算「會落地的總量」：已提交的內嵌附件 ＋ 正在傳的內嵌檔案（走下載連結的不佔額度）。
  // 舊版只算已提交的，所以傳 17 MB 時底部顯示「上傳中… · 1 KB / 5 MiB」，數字與正在發生的事無關。
  const pendingInlineBytes = inflight.reduce((s, u) => (u.asShare ? s : s + u.file.size), 0);
  const totalBytes = composerBytes(draft) + pendingInlineBytes;
  const mib = totalBytes / (1024 * 1024);
  const overLimit = totalBytes > SEND_MAX_BYTES;
  const fmtSize = mib >= 0.1 ? `${mib.toFixed(1)} MiB` : `${Math.ceil(totalBytes / 1024)} KB`;
  const canSend = splitChips(draft.to).length > 0 && (draft.subject.trim() || draft.body.trim()) && !overLimit && !uploading;

  // 頂端聚合細線：所有在傳檔案的加總進度。
  const aggTotal = inflight.reduce((s, u) => (u.status === 'uploading' ? s + u.file.size : s), 0);
  const aggLoaded = inflight.reduce((s, u) => (u.status === 'uploading' ? s + u.loaded : s), 0);
  const aggPct = aggTotal > 0 ? Math.min(100, Math.round((aggLoaded / aggTotal) * 100)) : 0;

  const pickFiles = () => fileRef.current?.click();

  /** 單一檔案的上傳（新加入或重試共用）。進度寫回該筆 inflight；完成即移出 inflight 進 draft。 */
  const startUpload = (key: string, file: File, asShare: boolean) => {
    const onProgress = (p: UploadProgress) =>
      setInflight((list) =>
        list.map((u) => (u.key === key ? { ...u, loaded: p.loaded, bytesPerSec: p.bytesPerSec, etaSec: p.etaSec } : u)),
      );
    const handle = asShare ? uploadShareFile(file, onProgress) : uploadAttachment(file, onProgress);
    setInflight((list) =>
      list.map((u) => (u.key === key ? { ...u, status: 'uploading', error: undefined, loaded: 0, abort: handle.abort } : u)),
    );
    handle.promise
      .then((result) => {
        setInflight((list) => list.filter((u) => u.key !== key));
        // 使用者已按取消（可能發生在 abort 還沒接上之前）→ 丟棄結果，別讓附件「取消了還是跑出來」
        if (cancelledRef.current.delete(key)) return;
        const cur = draftRef.current; // 見上方註解：絕不用 closure 裡的 draft
        if (asShare) {
          const linkFiles = [...(cur.linkFiles ?? []), result as ShareLink];
          draftRef.current = { ...cur, linkFiles };
          onChange(draftRef.current);
          pushToast('大檔案已轉為下載連結 🔗');
        } else {
          const attachments = [...cur.attachments, result as ComposerAttachment];
          draftRef.current = { ...cur, attachments };
          onChange(draftRef.current);
        }
      })
      .catch((err: unknown) => {
        // 使用者按取消 → 該列直接消失，不當成錯誤打擾他。
        if (err instanceof UploadAbortedError || cancelledRef.current.delete(key)) {
          setInflight((list) => list.filter((u) => u.key !== key));
          return;
        }
        const code = err instanceof Error ? err.message : 'unknown';
        setInflight((list) => list.map((u) => (u.key === key ? { ...u, status: 'error', error: code, abort: undefined } : u)));
      });
  };

  const retryUpload = (key: string) => {
    const item = inflight.find((u) => u.key === key);
    if (item) startUpload(key, item.file, item.asShare);
  };

  const cancelUpload = (key: string) => {
    cancelledRef.current.add(key); // 先記，再 abort——順序反過來會有漏網之魚（見宣告處註解）
    inflight.find((u) => u.key === key)?.abort?.();
    setInflight((list) => list.filter((u) => u.key !== key));
  };

  const onFiles = (files: FileList | File[] | null) => {
    if (!files?.length) return;
    try {
      // 先算好每個檔案該走哪條路：已提交 ＋ 這一批前面的檔案都要計入額度，否則多檔一起拖會誤判。
      let projected = composerBytes(draft) + pendingInlineBytes;
      for (const file of [...files]) {
        if (file.size > SHARE_MAX_BYTES) {
          pushToast('檔案超過 25 MiB，無法上傳');
          continue;
        }
        // 太大無法內嵌（5 MiB）→ 改存 R2 + 下載連結（寄信時附在內文）
        const asShare = projected + file.size > SEND_MAX_BYTES;
        if (!asShare) projected += file.size;
        const key = `up_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        setInflight((list) => [...list, { key, file, asShare, loaded: 0, bytesPerSec: 0, etaSec: null, status: 'uploading' }]);
        startUpload(key, file, asShare);
      }
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const removeAttachment = async (id: string) => {
    onChange({ ...draft, attachments: draft.attachments.filter((a) => a.id !== id) });
    try {
      await deleteStagedAttachment(id);
    } catch {
      /* staged 清除失敗無妨，寄出時仍以列表為準 */
    }
  };

  // F6.5：拖檔到撰寫器 / 貼上圖片 → 走既有 onFiles 上傳。只認檔案拖放（types 含 'Files'），與自訂 MIME 標籤拖放天然隔離。
  const onDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    if (!dragging) setDragging(true);
  };
  const onDragLeave = (e: React.DragEvent) => {
    // 只在真的離開 composer 邊界才關 overlay（子元素間移動不算）
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
    setDragging(false);
  };
  const onDrop = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    setDragging(false);
    void onFiles(e.dataTransfer.files);
  };
  // capture 階段攔截：貼上含圖片 → 改為附加（preventDefault 阻止 contentEditable 內嵌 base64）；純文字/HTML 照常貼。
  const onPasteCapture = (e: React.ClipboardEvent) => {
    const imgs = [...(e.clipboardData?.items ?? [])]
      .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
      .map((it) => it.getAsFile())
      .filter((f): f is File => !!f);
    if (imgs.length) {
      e.preventDefault();
      void onFiles(imgs);
    }
  };

  const fmtAtt = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

  const minSchedule = () => {
    // 本地牆鐘字串（與 DateTimeField/parseLocal 一致）。
    // 不可用 toISOString()——那是 UTC，在 UTC+8 會把預設值推到 8 小時前的過去，
    // 觸發 at > Date.now() 守門失敗、排程鈕看似失效。
    const d = new Date(Date.now() + 5 * 60_000);
    return formatLocal({ y: d.getFullYear(), mo: d.getMonth() + 1, d: d.getDate(), h: d.getHours(), mi: d.getMinutes() }, 'datetime');
  };

  const content = (
    <div className={`composer ${inlineTarget ? 'composer-inline' : ''} ${shake ? 'shake' : ''} ${minimized ? 'minimized' : ''}`} role={inlineTarget ? 'region' : 'dialog'} aria-label={draft.replyToMessageId ? '回覆郵件' : '寫信'}
      aria-hidden={minimized}
      data-slot={slotIndex ?? 0}
      onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop} onPasteCapture={onPasteCapture}
      onKeyDown={(e) => {
        // F3.1：⌘/Ctrl+Enter 直接寄出（可寄才寄）
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && canSend) {
          e.preventDefault();
          onSend();
        }
      }}>
      {dragging && (
        <div className="composer-dropzone" aria-hidden="true">
          <div className="composer-dropzone-inner">
            <Icon name="clip" size={28} />
            <div>放開以附加檔案</div>
          </div>
        </div>
      )}
      <div className="composer-titlebar">
        <span>{draft.replyToMessageId ? '回覆' : '新郵件'}</span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span className="autosave-ind">
            {autosave === 'saving' ? '儲存中…' : autosave === 'saved' ? <><Icon name="check" size={12} /> 已自動儲存</> : ''}
          </span>
          <button className="iconbtn" data-tooltip="最小化" aria-label="最小化" onClick={onMinimize}><Icon name="minus" size={15} /></button>
          <button className="iconbtn" data-tooltip="儲存草稿並關閉" aria-label="關閉" onClick={onClose}><Icon name="x" size={15} /></button>
        </div>
      </div>
      {/* 聚合進度細線：一眼知道「整批還在傳」，不搶注意力；細節在下方每檔卡片內。 */}
      {uploading && (
        <div className="upload-agg" role="progressbar" aria-label="附件上傳進度" aria-valuenow={aggPct} aria-valuemin={0} aria-valuemax={100}>
          <i style={{ width: `${aggPct}%` }} />
        </div>
      )}
      <div className="composer-fields">
        {(() => {
          const at = userEmail.indexOf('@');
          const local = at > 0 ? userEmail.slice(0, at) : userEmail;
          const domain = at > 0 ? userEmail.slice(at + 1) : '';
          const tag = draft.fromAlias ? (/\+([^@]+)@/.exec(draft.fromAlias)?.[1] ?? '') : '';
          const owned = identities.data?.aliases ?? [];
          const selValue = fromCustom ? 'custom' : draft.fromAlias && owned.some((a) => a.address === draft.fromAlias) ? draft.fromAlias : 'self';
          return (
            <div className="composer-fieldrow">
              <span className="tag">寄件</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0, fontSize: 13 }}>
                <Select<string> value={selValue} ariaLabel="寄件身分" style={{ flex: 'none', maxWidth: 240 }}
                  options={[
                    { value: 'self', label: userEmail },
                    ...owned.map((a) => ({ value: a.address, label: a.address })),
                    { value: 'custom', label: '自訂別名 +tag…' },
                  ]}
                  onChange={(v) => {
                    if (v === 'self') { setFromCustom(false); onChange({ ...draft, fromAlias: null }); }
                    else if (v === 'custom') { setFromCustom(true); onChange({ ...draft, fromAlias: null }); }
                    else { setFromCustom(false); onChange({ ...draft, fromAlias: v }); }
                  }} />
                {fromCustom && (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, color: 'var(--text-secondary)', minWidth: 0 }}>
                    {local}+
                    <input value={tag} placeholder="標籤" aria-label="別名標籤" style={{ width: 96 }}
                      onChange={(e) => {
                        const t = e.target.value.replace(/[^a-zA-Z0-9._-]/g, '').toLowerCase();
                        onChange({ ...draft, fromAlias: t ? `${local}+${t}@${domain}` : null });
                      }} />
                    @{domain}
                  </span>
                )}
              </div>
            </div>
          );
        })()}
        <div style={{ position: 'relative' }}>
          <RecipientChips label="收件者" value={draft.to} onChange={(v) => onChange({ ...draft, to: v })} autoFocusId="comp-to" groups={groups} />
          {!showCc && (
            <button type="button" className="linklike cc-toggle" onClick={() => setShowCc(true)}>副本/密件</button>
          )}
        </div>
        {showCc && (
          <>
            <RecipientChips label="副本" value={draft.cc} onChange={(v) => onChange({ ...draft, cc: v })} groups={groups} />
            <RecipientChips label="密件" value={draft.bcc} onChange={(v) => onChange({ ...draft, bcc: v })} groups={groups} />
          </>
        )}
        <div className="composer-fieldrow">
          <span className="tag">主旨</span>
          <input value={draft.subject} placeholder="主旨"
            onChange={(e) => onChange({ ...draft, subject: e.target.value })} />
          <button type="button" className="iconbtn btn-sm" data-tooltip="AI 建議主旨" disabled={aiSubject.isPending}
            onClick={suggestSubject} style={{ flex: 'none' }}>
            <Icon name="sparkle" size={14} />
          </button>
        </div>
      </div>
      <RichBody seedHtml={seedHtml} templates={templates} pushToast={pushToast} recipientName={recipientName} aiContext={draft.aiContext}
        sigContent={sigContent} editorApi={editorApi}
        onSync={(text, html) => onChange({ ...draft, body: text, bodyHtml: html })} />
      {inflight.length > 0 && (
        <div className="attach-row" style={{ padding: '0 18px 10px' }}>
          {inflight.map((u) => {
            const pct = u.file.size > 0 ? Math.min(100, Math.round((u.loaded / u.file.size) * 100)) : 0;
            const failed = u.status === 'error';
            return (
              <div key={u.key} className="attach-card upload-card" data-failed={failed ? '' : undefined}>
                <span className="attach-icon" style={{ color: failed ? 'var(--danger)' : undefined }}>
                  <Icon name={failed ? 'spam' : u.file.type.startsWith('image/') ? 'img' : 'pdf'} size={16} />
                </span>
                <div>
                  <div>{u.file.name}</div>
                  <div className="size" style={failed ? { color: 'var(--danger)' } : undefined}>
                    {failed
                      ? `上傳失敗 · ${UPLOAD_ERROR_TEXT[u.error ?? ''] ?? u.error ?? '未知原因'}`
                      : [`${fmtAtt(u.loaded)} / ${fmtAtt(u.file.size)}`, fmtSpeed(u.bytesPerSec), fmtEta(u.etaSec)].filter(Boolean).join(' · ')}
                  </div>
                  {!failed && <span className="upload-bar"><i style={{ width: `${pct}%` }} /></span>}
                </div>
                {failed ? (
                  <button className="btn-retry" onClick={() => retryUpload(u.key)}>重試</button>
                ) : (
                  <span className="size" style={{ fontVariantNumeric: 'tabular-nums', minWidth: 34, textAlign: 'right' }}>{pct}%</span>
                )}
                <button className="iconbtn" style={{ width: 26, height: 26 }}
                  aria-label={`${failed ? '移除' : '取消上傳'} ${u.file.name}`} onClick={() => cancelUpload(u.key)}>
                  <Icon name="x" size={13} />
                </button>
              </div>
            );
          })}
        </div>
      )}
      {draft.attachments.length > 0 && (
        <div className="attach-row" style={{ padding: '0 18px 10px' }}>
          {draft.attachments.map((a) => (
            <div key={a.id} className="attach-card">
              <span className="attach-icon"><Icon name={a.mimeType.startsWith('image/') ? 'img' : 'pdf'} size={16} /></span>
              <div>
                <div>{a.filename}</div>
                <div className="size">{fmtAtt(a.sizeBytes)}</div>
              </div>
              <button className="iconbtn" style={{ width: 26, height: 26 }} aria-label={`移除附件 ${a.filename}`}
                onClick={() => void removeAttachment(a.id)}>
                <Icon name="x" size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
      {(draft.linkFiles?.length ?? 0) > 0 && (
        <div className="attach-row" style={{ padding: '0 18px 10px' }}>
          {draft.linkFiles!.map((f) => (
            <div key={f.token} className="attach-card" data-tooltip="寄出時以下載連結附在內文（7 天到期）">
              <span className="attach-icon" style={{ color: 'var(--accent)' }}><Icon name="clip" size={16} /></span>
              <div>
                <div>{f.filename} <span style={{ color: 'var(--accent)', fontSize: 11 }}>🔗 連結</span></div>
                <div className="size">{fmtAtt(f.sizeBytes)} · 下載連結</div>
              </div>
              <button className="iconbtn" style={{ width: 26, height: 26 }} aria-label={`移除 ${f.filename}`}
                onClick={() => onChange({ ...draft, linkFiles: draft.linkFiles!.filter((x) => x.token !== f.token) })}>
                <Icon name="x" size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
      {overLimit && (
        <div className="remote-img-notice" style={{ margin: '0 18px 10px', borderColor: 'var(--danger)', color: 'var(--danger)' }}>
          <Icon name="spam" size={15} />
          <span>超過寄信上限 5 MiB（含附件），請移除部分附件</span>
        </div>
      )}
      <div className="composer-foot">
        <button id="composer-send-btn" className="btn btn-primary" disabled={!canSend} onClick={() => trySend()}>
          <Icon name="send" size={14} /> 寄出
        </button>
        {draft.replyToMessageId && onSendAndArchive && (
          <button className="btn btn-secondary" disabled={!canSend} data-tooltip="寄出並封存原對話串" aria-label="傳送並封存"
            onClick={() => trySend(onSendAndArchive)}>
            <Icon name="archive" size={14} /> 傳送並封存
          </button>
        )}
        <input ref={fileRef} type="file" multiple style={{ display: 'none' }} onChange={(e) => void onFiles(e.target.files)} />
        <button className="iconbtn" data-tooltip="附加檔案" aria-label="附加檔案" onClick={pickFiles} disabled={uploading}>
          <Icon name="clip" />
        </button>
        <button className="iconbtn" data-tooltip="排程寄送" aria-label="排程寄送" onClick={() => { setScheduleVal(minSchedule()); setShowSchedule(true); }}>
          <Icon name="clock" />
        </button>
        {/* F8.4：AI 草擬正文——不再只藏在 ⌘K，撰寫時一鍵可達 */}
        <button className="iconbtn" data-tooltip="AI 草擬正文" aria-label="AI 草擬正文" onClick={() => { setAiPrompt(''); setAiDraftOpen(true); }}>
          <Icon name="sparkle" />
        </button>
        {/* F8.4：更多——收納「以加密連結分享」等低頻功能 */}
        {onEncryptLink && (
          <div style={{ position: 'relative', display: 'inline-flex' }}>
            <button className="iconbtn" data-tooltip="更多" aria-label="更多" onClick={() => setFootMore((v) => !v)}>
              <Icon name="more" />
            </button>
            {footMore && (
              <>
                <button className="user-pop-backdrop" aria-label="關閉選單" onClick={() => setFootMore(false)}></button>
                {/* 靠「更多」鈕的**右緣**對齊、往左展開。原本寫 left:0 從左緣往右長 200px，
                    在窄螢幕上會直接衝出畫面右側被切掉（2026-09-20 Hon 實機回報）。 */}
                <div className="more-menu" style={{ right: 0, left: 'auto', bottom: 42, top: 'auto', minWidth: 200 }}>
                  <button onClick={() => { setFootMore(false); onEncryptLink(draft.body.trim() || undefined); }}>
                    <Icon name="shield" size={15} /> 以加密連結分享
                  </button>
                </div>
              </>
            )}
          </div>
        )}
        <span className="composer-size" style={overLimit ? { color: 'var(--danger)' } : undefined}>
          {uploading ? '上傳中… · ' : ''}{fmtSize} / 5 MiB
        </span>
      </div>

      {aiDraftOpen && (
        <Modal title="AI 草擬正文" desc="用一句話描述要寫什麼，AI 幫你擬好草稿插入目前信件。" onClose={() => setAiDraftOpen(false)} width={520}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <textarea className="input" rows={4} autoFocus value={aiPrompt} style={{ resize: 'vertical', fontFamily: 'inherit' }}
              placeholder="例如：跟客戶說這週的會議改到下週三下午三點，並為造成不便致歉"
              onChange={(e) => setAiPrompt(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) runAiDraft(); }} />
            {aiCompose.isError && <div style={{ fontSize: 12, color: 'var(--danger)' }}>產生失敗，請再試一次</div>}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button className="btn btn-ghost" onClick={() => setAiDraftOpen(false)}>取消</button>
              <button className="btn btn-primary" disabled={!aiPrompt.trim() || aiCompose.isPending} onClick={runAiDraft}>
                <Icon name="sparkle" size={14} /> {aiCompose.isPending ? '生成中…' : '生成並插入'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {showSchedule && (
        <Modal title="排程寄送" desc="到點後由系統自動寄出（伺服器每分鐘掃描）。" onClose={() => setShowSchedule(false)}>
          {/* F3.3：常用相對時間快捷（純函式 sendSchedulePresets 算、只給未來時間） */}
          <div className="schedule-presets">
            {sendSchedulePresets(Date.now()).map((p) => (
              <button key={p.label} type="button" className="btn btn-secondary btn-sm" disabled={!canSend}
                onClick={() => { setShowSchedule(false); onSchedule(p.at); }}>
                <Icon name="clock" size={12} /> {p.label}
              </button>
            ))}
          </div>
          <div className="field">
            <label htmlFor="schedule-at">或自訂時間</label>
            <DateTimeField id="schedule-at" value={scheduleVal} ariaLabel="寄出時間"
              onChange={setScheduleVal} />
          </div>
          <button className="btn btn-primary" style={{ width: '100%', marginTop: 14 }}
            disabled={!scheduleVal || !canSend}
            onClick={() => {
              const at = new Date(scheduleVal).getTime();
              if (at > Date.now()) {
                setShowSchedule(false);
                onSchedule(at);
              }
            }}>
            <Icon name="clock" size={14} /> 確認排程
          </button>
        </Modal>
      )}

      {guard && (
        <Modal title="再確認一下" desc={guard.msg} onClose={() => { setGuard(null); setShake(true); setTimeout(() => setShake(false), 320); }}>
          <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
            <button className="btn btn-secondary" style={{ flex: 1 }}
              onClick={() => { setGuard(null); setShake(true); setTimeout(() => setShake(false), 320); }}>
              返回修改
            </button>
            <button className="btn btn-primary" style={{ flex: 1 }} onClick={() => { const r = guard.run; setGuard(null); r(); }}>
              <Icon name="send" size={14} /> 仍要寄出
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
  return createPortal(content, portalRoot);
}
