// 設定頁 —— 簽名檔 / 外觀 / 標籤 / 自動規則 / 安全性 / 隱私（移植 settings.jsx）
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { startRegistration } from '@simplewebauthn/browser';
import { api, type Me } from '../api/client';
import { useTheme } from '../hooks/useTheme';
import { Icon, LabelChip, Modal, Pori, Switch, timeAgo } from './ui';
import { canSubscribePush, shouldShowIOSInstallGuide } from '../lib/platform';
import { readPwaState } from '../lib/platform.dom';
import { DateTimeField, Select } from './inputs';
import { confirmDialog, promptDialog } from './dialog';
import { useSignatures, useIdentities, uploadMbox, type ImportJob, type Signature } from '../api/send';
import { useSubscriptions, useUnsubscribe, useBlockSender, useBatchByView } from '../api/mail';
import { type CustomTheme } from '../lib/customTheme';
import { applyCustomTheme } from '../lib/customTheme.dom';
import { type SoundPrefs } from '../lib/notifySound';
import { loadSoundPrefs, playChime, saveSoundPrefs, unlockChime } from '../lib/notifySound.dom';
import { formatBytes } from '../lib/format';
import { generateSpeakeasy } from '../lib/speakeasy';

// iOS「分享」與「加入主畫面（＋）」字符 — 內嵌 SVG，幫使用者一眼認出 Safari 工具列上的鈕。
const IOS_SHARE_GLYPH = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" style={{ verticalAlign: '-2px', margin: '0 1px' }} aria-hidden="true">
    <path d="M12 15V3" /><path d="m8 7 4-4 4 4" /><path d="M5 11v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-8" />
  </svg>
);
const IOS_PLUS_GLYPH = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" style={{ verticalAlign: '-2px', margin: '0 1px' }} aria-hidden="true">
    <rect x="4" y="4" width="16" height="16" rx="4" /><path d="M12 9v6M9 12h6" />
  </svg>
);

type ClauseField = 'from' | 'subject' | 'to' | 'cc' | 'recipient';
type ClauseOp = 'contains' | 'notContains' | 'equals' | 'startsWith' | 'endsWith';
interface RuleClause {
  field: ClauseField;
  op: ClauseOp;
  value: string;
}
const FIELD_LABEL: Record<ClauseField, string> = { from: '寄件者', subject: '主旨', to: '收件地址', cc: '副本(cc)', recipient: '任一收件人' };
const OP_LABEL: Record<ClauseOp, string> = {
  contains: '包含',
  notContains: '不包含',
  equals: '等於',
  startsWith: '開頭為',
  endsWith: '結尾為',
};

interface Rule {
  id: string;
  name: string;
  conditions: {
    match?: 'all' | 'any';
    clauses?: RuleClause[];
    fromContains?: string;
    subjectContains?: string;
    toContains?: string;
    hasListUnsubscribe?: boolean;
    aiCategory?: string;
    authVerdict?: string;
    hasAttachment?: boolean;
    sizeOverKb?: number;
    olderThanDays?: number;
  };
  actions: { addLabelId?: string; moveToFolder?: string; star?: boolean; markRead?: boolean; snooze?: string; followUpAfterMin?: number; stopProcessing?: boolean; forward?: string };
  enabled: boolean;
}

interface Passkey {
  id: string;
  name: string | null;
  device_type: string | null;
  backed_up: number;
  created_at: number;
  last_used_at: number | null;
}

const FOLDER_NAMES: Record<string, string> = { archive: '封存', spam: '垃圾信', trash: '垃圾桶' };
const SNOOZE_NAMES: Record<string, string> = { evening: '今晚', tomorrow: '明早', weekend: '本週末' };
const AI_CATEGORIES = ['帳單', '工作', '朋友', '電子報', '通知', '其他']; // 對齊 worker ai.ts CATEGORIES

// 提示音音量三段。刻意不用 input[type=range]：全站沒有滑桿的樣式先例，
// 為了一個設定去補跨主題的 range CSS 不划算，三段也夠用。
const SOUND_VOL_OPTIONS: { value: number; label: string }[] = [
  { value: 0.25, label: '輕聲' },
  { value: 0.45, label: '適中' },
  { value: 0.8, label: '大聲' },
];

function describeRule(r: Rule, labels: { id: string; name: string }[]): { cond: string; act: string } {
  const conds: string[] = [];
  for (const cl of r.conditions.clauses ?? []) conds.push(`${FIELD_LABEL[cl.field]}${OP_LABEL[cl.op]}「${cl.value}」`);
  if (r.conditions.fromContains) conds.push(`寄件者包含「${r.conditions.fromContains}」`);
  if (r.conditions.subjectContains) conds.push(`主旨包含「${r.conditions.subjectContains}」`);
  if (r.conditions.toContains) conds.push(`收件地址包含「${r.conditions.toContains}」`);
  if (r.conditions.hasListUnsubscribe) conds.push('標頭含 List-Unsubscribe');
  if (r.conditions.aiCategory) conds.push(`AI 分類為「${r.conditions.aiCategory}」`);
  if (r.conditions.authVerdict) conds.push(r.conditions.authVerdict === 'fail' ? '寄件驗證未通過' : '寄件完全未驗證');
  if (r.conditions.hasAttachment !== undefined) conds.push(r.conditions.hasAttachment ? '有附件' : '無附件');
  if (r.conditions.sizeOverKb) conds.push(`大於 ${r.conditions.sizeOverKb} KB`);
  if (r.conditions.olderThanDays) conds.push(`收信超過 ${r.conditions.olderThanDays} 天`);
  const joiner = r.conditions.match === 'any' ? ' 或 ' : ' 且 ';
  const acts: string[] = [];
  if (r.actions.addLabelId) acts.push(`加標籤「${labels.find((l) => l.id === r.actions.addLabelId)?.name ?? '?'}」`);
  if (r.actions.moveToFolder) acts.push(`移至${FOLDER_NAMES[r.actions.moveToFolder] ?? r.actions.moveToFolder}`);
  if (r.actions.star) acts.push('加星標');
  if (r.actions.markRead) acts.push('標為已讀');
  if (r.actions.snooze) acts.push(`稍後處理（${SNOOZE_NAMES[r.actions.snooze] ?? r.actions.snooze}）`);
  if (r.actions.followUpAfterMin) acts.push(`${r.actions.followUpAfterMin} 分後提醒跟進`);
  if (r.actions.forward) acts.push(`自動轉寄給 ${r.actions.forward}`);
  if (r.actions.stopProcessing) acts.push('命中即停');
  return { cond: conds.join(joiner), act: acts.join('、') };
}

/** VAPID base64url 公鑰 → pushManager.subscribe 要的 Uint8Array */
function urlBase64ToUint8Array(b64url: string): Uint8Array {
  const padding = '='.repeat((4 - (b64url.length % 4)) % 4);
  const b64 = (b64url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  return Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
}

// 2026-09-22 依用途重整（Hon 定案乙案）：原「帳號」塞了安全性、通知、別名、行事曆四種不相干的東西，
// 通知藏在裡面導致新信提示音一直沒被找到；隱私放在「進階」也不對。現在每一類設定都有自己的分頁，
// 且設定頁預設開在「通知」。區塊在分頁內的先後＝下方 JSX 的先後。
type SettingsGroup = 'notify' | 'appearance' | 'compose' | 'mail' | 'security' | 'addresses' | 'data';
const SETTINGS_TABS: { key: SettingsGroup; label: string }[] = [
  { key: 'notify', label: '通知' },
  { key: 'appearance', label: '外觀' },
  { key: 'compose', label: '撰寫' },
  { key: 'mail', label: '信件整理' },
  { key: 'security', label: '隱私與安全' },
  { key: 'addresses', label: '地址與行事曆' },
  { key: 'data', label: '資料與進階' },
];

/** F4.4：單一簽名的可編輯列（名稱 + 內容 + 設預設 + 刪除）。 */
function SignatureRow({ sig, onPatch, onDelete }: {
  sig: Signature;
  onPatch: (body: { name?: string; content?: string; isDefault?: boolean }) => void;
  onDelete: () => void;
}) {
  const [name, setName] = useState(sig.name);
  const [content, setContent] = useState(sig.content);
  const dirty = name !== sig.name || content !== sig.content;
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input className="input" style={{ maxWidth: 220 }} value={name} placeholder="簽名名稱" onChange={(e) => setName(e.target.value)} />
        {sig.isDefault ? (
          <span style={{ fontSize: 12, color: 'var(--success)' }}>★ 預設</span>
        ) : (
          <button className="linklike" onClick={() => onPatch({ isDefault: true })}>設為預設</button>
        )}
        <button className="iconbtn" data-tooltip="刪除簽名" aria-label="刪除簽名" style={{ marginLeft: 'auto' }} onClick={onDelete}><Icon name="trash" size={15} /></button>
      </div>
      <textarea className="input" rows={3} style={{ resize: 'vertical', lineHeight: 1.6 }} value={content}
        placeholder="簽名內容（純文字）" onChange={(e) => setContent(e.target.value)} />
      {dirty && (
        <button className="btn btn-primary btn-sm" style={{ alignSelf: 'flex-start' }}
          onClick={() => onPatch({ name: name.trim() || sig.name, content })}>儲存</button>
      )}
    </div>
  );
}

/** F4.4：多重簽名管理 + 綁寄件身分。 */
function SignaturesSection({ hidden, pushToast }: { hidden: boolean; pushToast: (t: string) => void }) {
  const qc = useQueryClient();
  const sigs = useSignatures();
  const idents = useIdentities();
  const [newName, setNewName] = useState('');
  const inval = () => {
    void qc.invalidateQueries({ queryKey: ['signatures'] });
    void qc.invalidateQueries({ queryKey: ['me'] });
  };
  const create = useMutation({
    mutationFn: (name: string) => api('/signatures', { method: 'POST', body: { name, content: '' } }),
    onSuccess: () => { inval(); pushToast('已新增簽名 ✍️'); },
  });
  const patch = useMutation({
    mutationFn: (v: { id: string; body: { name?: string; content?: string; isDefault?: boolean } }) => api(`/signatures/${v.id}`, { method: 'PATCH', body: v.body }),
    onSuccess: inval,
  });
  const del = useMutation({
    mutationFn: (id: string) => api(`/signatures/${id}`, { method: 'DELETE' }),
    onSuccess: () => { inval(); void qc.invalidateQueries({ queryKey: ['identities'] }); pushToast('已刪除簽名'); },
  });
  const bind = useMutation({
    mutationFn: (v: { aliasId: string; signatureId: string | null }) => api('/signatures/bind', { method: 'PUT', body: v }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['identities'] }),
  });
  const list = sigs.data?.signatures ?? [];
  const aliases = idents.data?.aliases ?? [];

  return (
    <section className="settings-section" hidden={hidden}>
      <h3>多重簽名 + 綁寄件身分</h3>
      <p className="desc">建立多份簽名，並把不同寄件別名綁到不同簽名（如工作別名用正式簽名、私人用輕鬆簽名）。撰寫時切換寄件身分會自動帶對應簽名；上面「簽名檔」是未設預設時的後備。</p>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, maxWidth: 420 }}>
        <input className="input" placeholder="新簽名名稱（例：工作）" value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && newName.trim()) { create.mutate(newName.trim()); setNewName(''); } }} />
        <button className="btn btn-primary btn-sm" disabled={!newName.trim() || create.isPending}
          onClick={() => { create.mutate(newName.trim()); setNewName(''); }}>新增簽名</button>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {list.map((s) => (
          <SignatureRow key={s.id} sig={s} onPatch={(body) => patch.mutate({ id: s.id, body })} onDelete={() => del.mutate(s.id)} />
        ))}
      </div>
      {aliases.length > 0 && list.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <h4 style={{ margin: '0 0 8px' }}>別名 → 簽名綁定</h4>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {aliases.map((a) => (
              <div key={a.id} style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <span style={{ minWidth: 200, fontSize: 13 }}>{a.address}</span>
                <Select<string> value={a.signatureId ?? ''} ariaLabel={`${a.address} 的簽名`} style={{ flex: 'none', maxWidth: 240 }}
                  options={[{ value: '', label: '（用預設簽名）' }, ...list.map((s) => ({ value: s.id, label: s.name }))]}
                  onChange={(v) => bind.mutate({ aliasId: a.id, signatureId: v || null })} />
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

export function SettingsPage({ me, labels, onMeChanged, pushToast, onMenu }: {
  me: Me;
  labels: { id: string; name: string; color: string; parentId?: string | null; sortOrder?: number }[]; // F4.5：含階層/排序
  onMeChanged: () => void;
  pushToast: (t: string) => void;
  onMenu: () => void;
}) {
  const qc = useQueryClient();
  const [theme, setTheme] = useTheme();
  const [sigDraft, setSigDraft] = useState(me.signature);
  const [saved, setSaved] = useState(false);
  const [digestOn, setDigestOn] = useState(!!me.prefs.dailyDigest);
  // F11.4：自訂配色（prefs.customTheme；null=用預設主色）
  const [custom, setCustom] = useState<CustomTheme>((me.prefs.customTheme as CustomTheme | undefined) ?? {});
  const saveCustom = async (next: CustomTheme | null) => {
    const prev = custom;
    setCustom(next ?? {});
    applyCustomTheme(next);
    try {
      await api('/settings', { method: 'PATCH', body: { prefs: { customTheme: next } } });
      onMeChanged();
    } catch {
      setCustom(prev);
      applyCustomTheme(Object.keys(prev).length ? prev : null);
      pushToast('設定儲存失敗');
    }
  };

  // F9.1：spam/trash 30 天自動清（預設開；只有明確設 false 才關）
  const [purgeOn, setPurgeOn] = useState(me.prefs.purgeSpamTrash !== false);
  const savePurge = async (on: boolean) => {
    try {
      await api('/settings', { method: 'PATCH', body: { prefs: { purgeSpamTrash: on } } });
      onMeChanged();
      pushToast(on ? '已開啟 30 天自動清理' : '已關閉自動清理');
    } catch {
      setPurgeOn(!on);
      pushToast('設定儲存失敗');
    }
  };
  // F9.2：保留規則（0=永久；prefs 是頂層淺合併 → 每次送完整 retention 物件）
  type RetentionDays = 0 | 30 | 90 | 365;
  const rawRet = (me.prefs.retention as { archive?: number; newsletter?: number } | undefined) ?? {};
  const [retention, setRetention] = useState<{ archive: RetentionDays; newsletter: RetentionDays }>({
    archive: ([0, 30, 90, 365].includes(rawRet.archive ?? 0) ? rawRet.archive ?? 0 : 0) as RetentionDays,
    newsletter: ([0, 30, 90, 365].includes(rawRet.newsletter ?? 0) ? rawRet.newsletter ?? 0 : 0) as RetentionDays,
  });
  const RETENTION_OPTIONS: { value: RetentionDays; label: string }[] = [
    { value: 0, label: '永久保留' },
    { value: 30, label: '30 天' },
    { value: 90, label: '90 天' },
    { value: 365, label: '1 年' },
  ];
  const saveRetention = async (next: { archive: RetentionDays; newsletter: RetentionDays }) => {
    const prev = retention;
    setRetention(next);
    try {
      await api('/settings', { method: 'PATCH', body: { prefs: { retention: next } } });
      onMeChanged();
      pushToast('保留規則已更新');
    } catch {
      setRetention(prev);
      pushToast('設定儲存失敗');
    }
  };
  // F9.5：守門暗號（Speakeasy）——主旨帶暗號的陌生來信繞過待審
  const [speakeasy, setSpeakeasy] = useState<string>((me.prefs.speakeasy as string | undefined) ?? '');
  const saveSpeakeasy = async (code: string | null) => {
    const prev = speakeasy;
    setSpeakeasy(code ?? '');
    try {
      await api('/settings', { method: 'PATCH', body: { prefs: { speakeasy: code } } });
      onMeChanged();
      pushToast(code ? '暗號已更新 🤫' : '已停用暗號');
    } catch {
      setSpeakeasy(prev);
      pushToast('設定儲存失敗');
    }
  };
  const genSpeakeasy = () => {
    void saveSpeakeasy(generateSpeakeasy());
  };

  // F9.3：訂閱管理儀表板（郵件分頁才載入）
  const unsubMut = useUnsubscribe();
  const blockMut = useBlockSender();
  const batchMut = useBatchByView();
  const doUnsubscribe = (latestId: string, addr: string) => {
    unsubMut.mutate(latestId, {
      onSuccess: (r) => {
        if (r.method === 'one-click') pushToast(r.ok ? `已送出退訂 ${addr} ✅` : '退訂請求未成功，可改用寄件者頁面退訂');
        else if (r.url) window.open(r.url, '_blank', 'noopener,noreferrer');
        else if (r.mailto) window.location.href = r.mailto;
        else pushToast('這封信沒有可用的退訂方式');
      },
      onError: () => pushToast('退訂失敗，請再試一次'),
    });
  };
  const doBlock = (addr: string) => {
    blockMut.mutate(
      { name: `封鎖 ${addr}`, value: addr },
      { onSuccess: () => pushToast(`已封鎖 ${addr}，日後來信自動進垃圾信 🚫`), onError: () => pushToast('封鎖失敗，請再試一次') },
    );
  };
  const clearHistory = async (addr: string, total: number) => {
    const ok = await confirmDialog({
      title: '清除訂閱歷史',
      body: `將把 ${addr} 的 ${total} 封電子報移到垃圾桶（可復原；星標/釘選不動，30 天後自動永久清除）。`,
      confirmText: '移到垃圾桶',
      danger: true,
    });
    if (!ok) return;
    batchMut.mutate(
      { view: 'newsletter', action: 'trash', fromAddr: addr },
      {
        onSuccess: (r) => { pushToast(`已移 ${r.changes} 封到垃圾桶 🗑️`); void qc.invalidateQueries({ queryKey: ['subscriptions'] }); },
        onError: () => pushToast('清除失敗，請再試一次'),
      },
    );
  };

  /* 範本 */
  interface Tpl { id: string; name: string; body: string }
  const [templates, setTemplates] = useState<Tpl[]>((me.prefs.templates as Tpl[] | undefined) ?? []);
  const [tplModal, setTplModal] = useState<null | { id?: string; name: string; body: string }>(null);
  const saveTemplates = async (next: Tpl[]) => {
    setTemplates(next);
    await api('/settings', { method: 'PATCH', body: { prefs: { templates: next } } });
    onMeChanged();
  };

  /* 假期自動回覆 */
  const vac = (me.prefs.vacation as { on?: boolean; until?: number | null; body?: string } | undefined) ?? {};
  const [vacOn, setVacOn] = useState(!!vac.on);
  // 用「本地」日期欄位（與儲存時的 new Date(`${vacUntil}T23:59:59`) 本地解析一致）；
  // 不可用 toISOString()（UTC）—— 否則負時區 round-trip 會位移一天。
  const [vacUntil, setVacUntil] = useState(() => {
    if (!vac.until) return '';
    const d = new Date(vac.until);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  });
  const [vacBody, setVacBody] = useState(vac.body ?? '');
  const saveVacation = async (on: boolean) => {
    const until = vacUntil ? new Date(`${vacUntil}T23:59:59`).getTime() : null;
    await api('/settings', { method: 'PATCH', body: { prefs: { vacation: { on, until, body: vacBody } } } });
    onMeChanged();
    pushToast(on ? '假期自動回覆已開啟 🏝️' : '假期自動回覆已關閉');
  };

  /* Plus 別名 */
  const aliases = useQuery({
    queryKey: ['aliases'],
    queryFn: () => api<{ aliases: { address: string; tag: string; count: number; lastUsed: number }[] }>('/aliases'),
  });
  const [aliasRuleFor, setAliasRuleFor] = useState<string | null>(null);

  /* F9.4：Masked Email（隨機別名） */
  interface MaskedAlias { id: string; address: string; note: string | null; disabled: boolean; selfServe: boolean; createdAt: number }
  const masked = useQuery({
    queryKey: ['masked-aliases'],
    queryFn: () => api<{ aliases: MaskedAlias[] }>('/masked-aliases'),
  });
  const genMasked = useMutation({
    mutationFn: (note?: string) => api<{ id: string; address: string }>('/masked-aliases', { method: 'POST', body: { note } }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['masked-aliases'] });
      void qc.invalidateQueries({ queryKey: ['identities'] });
      void navigator.clipboard?.writeText(r.address).catch(() => {});
      pushToast(`已產生 ${r.address}（已複製）📋`);
    },
    onError: () => pushToast('產生失敗，請再試一次'),
  });
  const patchMasked = useMutation({
    mutationFn: ({ id, ...body }: { id: string; disabled?: boolean; note?: string | null }) =>
      api(`/masked-aliases/${id}`, { method: 'PATCH', body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['masked-aliases'] });
      void qc.invalidateQueries({ queryKey: ['identities'] });
    },
    onError: () => pushToast('儲存失敗，請再試一次'),
  });
  const genWithNote = async () => {
    const note = await promptDialog({ title: '產生 Masked 別名', label: '用途備註（選填，例如「某購物網站」）', placeholder: '這個別名要給誰用？' });
    if (note === null) return; // 取消
    genMasked.mutate(note.trim() || undefined);
  };
  /* F11.2：行事曆 ICS 訂閱 feed */
  const calFeed = useQuery({
    queryKey: ['cal-feed'],
    queryFn: () => api<{ active: boolean; createdAt: number | null }>('/calendar/feed'),
  });
  const [feedUrl, setFeedUrl] = useState<string | null>(null); // 明碼 URL 只在產生當下顯示一次
  const genFeed = useMutation({
    mutationFn: () => api<{ url: string }>('/calendar/feed', { method: 'POST', body: {} }),
    onSuccess: (r) => {
      setFeedUrl(r.url);
      void qc.invalidateQueries({ queryKey: ['cal-feed'] });
      void navigator.clipboard?.writeText(r.url).catch(() => {});
      pushToast('訂閱網址已產生並複製 📋');
    },
    onError: () => pushToast('產生失敗，請再試一次'),
  });
  const revokeFeed = useMutation({
    mutationFn: () => api('/calendar/feed', { method: 'DELETE' }),
    onSuccess: () => { setFeedUrl(null); void qc.invalidateQueries({ queryKey: ['cal-feed'] }); pushToast('已撤銷訂閱網址'); },
    onError: () => pushToast('撤銷失敗，請再試一次'),
  });

  /* F14.1：外部行事曆訂閱（反向；≤5 條 https ICS URL，cron 每 6h 拉成唯讀事件） */
  interface IcsSub { url: string; label: string }
  const [icsSubs, setIcsSubs] = useState<IcsSub[]>((me.prefs.icsSubscriptions as IcsSub[] | undefined) ?? []);
  const [icsUrl, setIcsUrl] = useState('');
  const [icsLabel, setIcsLabel] = useState('');
  const saveIcsSubs = async (next: IcsSub[]) => {
    const prev = icsSubs;
    setIcsSubs(next);
    try {
      await api('/settings', { method: 'PATCH', body: { prefs: { icsSubscriptions: next } } });
      onMeChanged();
    } catch {
      setIcsSubs(prev); // 伺服器拒收（如非 https/超量）→ 回滾
      pushToast('訂閱網址無效（需 https 公開網址，最多 5 條）');
    }
  };
  const addIcsSub = () => {
    const url = icsUrl.trim();
    if (!/^https:\/\/.+/i.test(url)) { pushToast('請輸入 https:// 開頭的訂閱網址'); return; }
    if (icsSubs.length >= 5) { pushToast('最多 5 條訂閱'); return; }
    void saveIcsSubs([...icsSubs, { url, label: icsLabel.trim().slice(0, 60) }]);
    setIcsUrl(''); setIcsLabel('');
  };

  const editMaskedNote = async (a: MaskedAlias) => {
    const note = await promptDialog({ title: '編輯備註', label: '用途備註', placeholder: '這個別名要給誰用？', initial: a.note ?? '' });
    if (note === null) return;
    patchMasked.mutate({ id: a.id, note: note.trim() || null });
  };

  const exportMbox = () => {
    const a = document.createElement('a');
    a.href = '/api/v1/export/mbox';
    a.click();
    pushToast('匯出已開始，請稍候下載完成 📦');
  };

  // F7.6：MBOX 匯入舊信（背景處理，輪詢進度）
  const importJobs = useQuery({
    queryKey: ['import-jobs'],
    queryFn: () => api<{ jobs: ImportJob[] }>('/import/jobs'),
    refetchInterval: (q) => (q.state.data?.jobs?.some((j) => j.status === 'pending' || j.status === 'running') ? 2000 : false),
  });
  const [importing, setImporting] = useState(false);
  const importFileRef = useRef<HTMLInputElement>(null);
  const doImportMbox = async (file: File) => {
    setImporting(true);
    try {
      await uploadMbox(file);
      pushToast('已收到，背景匯入中… 📥');
      void importJobs.refetch();
    } catch (e) {
      pushToast(e instanceof Error && e.message.includes('too_large') ? 'mbox 超過 25 MB 上限' : '匯入上傳失敗');
    } finally {
      setImporting(false);
      if (importFileRef.current) importFileRef.current.value = '';
    }
  };
  const activeImport = importJobs.data?.jobs.find((j) => j.status === 'pending' || j.status === 'running');

  const saveDigest = async (on: boolean) => {
    try {
      await api('/settings', { method: 'PATCH', body: { prefs: { dailyDigest: on } } });
      onMeChanged();
      pushToast(on ? '已開啟每日晨報 🐧' : '已關閉每日晨報');
    } catch {
      setDigestOn(!on);
      pushToast('設定儲存失敗');
    }
  };
  // F10.2：抵達即備稿（預設開；明確設 false 才關）
  const [autoDraftsOn, setAutoDraftsOn] = useState(me.prefs.autoDrafts !== false);
  const saveAutoDrafts = async (on: boolean) => {
    try {
      await api('/settings', { method: 'PATCH', body: { prefs: { autoDrafts: on } } });
      onMeChanged();
      pushToast(on ? '已開啟 AI 備稿 ✨' : '已關閉 AI 備稿');
    } catch {
      setAutoDraftsOn(!on);
      pushToast('設定儲存失敗');
    }
  };

  /* 新信提示音（F21.1）。存 localStorage 不存伺服器——要不要出聲是「這台裝置」的事。
     每次變更都順手播一次：既是試聽，也是在使用者手勢裡解鎖 AudioContext（瀏覽器禁止未互動就出聲）。 */
  const [sound, setSound] = useState(loadSoundPrefs);
  const applySound = (next: SoundPrefs, preview: boolean) => {
    setSound(next);
    saveSoundPrefs(next);
    unlockChime();
    if (preview && next.on) playChime(next.vol);
  };

  /* Web Push 推播 */
  const pushSupported = typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window;
  const [pwa] = useState(readPwaState); // 只在 mount 算一次（iOS/安裝狀態在分頁生命週期內不變）
  const iosNeedsInstall = shouldShowIOSInstallGuide(pwa); // iOS 未加主畫面 → 不能推播，改顯示引導
  const [pushOn, setPushOn] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [notifPerm, setNotifPerm] = useState<NotificationPermission | 'unsupported'>(() =>
    typeof Notification !== 'undefined' ? Notification.permission : 'unsupported',
  );
  const notifDenied = notifPerm === 'denied'; // 被永久拒絕 → 系統不再彈框，改引導手動解鎖
  useEffect(() => {
    if (!pushSupported) return;
    void navigator.serviceWorker.ready
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => setPushOn(!!sub))
      .catch(() => {});
  }, [pushSupported]);
  const togglePush = async (on: boolean) => {
    setPushBusy(true);
    try {
      const reg = await navigator.serviceWorker.ready;
      if (on) {
        if (!canSubscribePush(pwa)) {
          // iOS 未加入主畫面：subscribe 會失敗，先攔下並給正確原因（而非泛用「設定失敗」）
          pushToast('iPhone/iPad 請先把 Miseroda 加入主畫面，再從主畫面開啟才能開推播');
          setPushOn(false);
          return;
        }
        if (Notification.permission === 'denied') {
          // 已永久拒絕：requestPermission 不會再彈框 → 切換到「手動解鎖」引導（render 也會跟著換）。
          setNotifPerm('denied');
          setPushOn(false);
          return;
        }
        if (Notification.permission === 'default') {
          // 軟詢問：先用 App 內 Modal 講價值，使用者同意才要系統權限（避免一次性系統框被誤拒而永久卡死）。
          const ok = await confirmDialog({
            title: '開啟新信通知？',
            body: '有新信時 Miseroda 會在這台裝置跳出系統通知（可隨時關閉）。接著瀏覽器會問你要不要允許。',
            confirmText: '好，開啟',
            cancelText: '先不要',
          });
          if (!ok) {
            setPushOn(false);
            return;
          }
        }
        const perm = await Notification.requestPermission();
        setNotifPerm(perm);
        if (perm !== 'granted') {
          pushToast(perm === 'denied' ? '你選擇了不允許通知，可隨時在瀏覽器設定改回' : '尚未授權通知');
          setPushOn(false);
          return;
        }
        const cfg = await api<{ vapidPublicKey: string | null }>('/auth/config');
        if (!cfg.vapidPublicKey) {
          pushToast('伺服器尚未設定推播金鑰');
          setPushOn(false);
          return;
        }
        const sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(cfg.vapidPublicKey).buffer as ArrayBuffer,
        });
        const json = sub.toJSON();
        await api('/push/subscribe', {
          method: 'POST',
          body: { endpoint: sub.endpoint, p256dh: json.keys?.p256dh ?? '', auth: json.keys?.auth ?? '' },
        });
        setPushOn(true);
        pushToast('新信推播已開啟 🔔');
      } else {
        const sub = await reg.pushManager.getSubscription();
        if (sub) {
          await api('/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => {});
          await sub.unsubscribe();
        }
        setPushOn(false);
        pushToast('新信推播已關閉');
      }
    } catch {
      setPushOn(!on);
      pushToast('推播設定失敗，請再試一次');
    } finally {
      setPushBusy(false);
    }
  };
  const [labelModal, setLabelModal] = useState<null | { id?: string; name: string; color: string; parentId?: string | null; sortOrder?: number }>(null);
  const [ruleModal, setRuleModal] = useState(false);
  const [editingRule, setEditingRule] = useState<Rule | null>(null);
  const [applyPreview, setApplyPreview] = useState<
    { rule: Rule; matched: number; sample: { id: string; from: string; subject: string }[]; truncated: boolean; applying: boolean } | null
  >(null);

  const rules = useQuery({ queryKey: ['rules'], queryFn: () => api<{ rules: Rule[] }>('/rules') });
  const passkeys = useQuery({ queryKey: ['passkeys'], queryFn: () => api<{ passkeys: Passkey[] }>('/auth/passkeys') });
  const deliverability = useQuery({
    queryKey: ['deliverability'],
    queryFn: () =>
      api<{
        domain: string;
        spf: { status: 'present' | 'absent' | 'unknown'; record: string | null };
        dmarc: { status: 'present' | 'absent' | 'unknown'; policy: string | null };
        dkim: { managed: boolean };
        outbound: { sent: number; failed: number; review: number; total: number; windowDays: number };
      }>('/deliverability'),
    staleTime: 300_000,
  });

  // 主題變更 → 同步到伺服器 prefs（debounce，跳過初始）
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const t = setTimeout(() => {
      void api('/settings', { method: 'PATCH', body: { prefs: theme } }).catch(() => {});
    }, 800);
    return () => clearTimeout(t);
  }, [theme]);

  const saveSignature = async () => {
    await api('/settings', { method: 'PATCH', body: { signature: sigDraft } });
    setSaved(true);
    onMeChanged();
  };

  const saveLabel = useMutation({
    mutationFn: async (m: { id?: string; name: string; color: string; parentId?: string | null; sortOrder?: number }) => {
      const body = { name: m.name, color: m.color, parentId: m.parentId ?? null, sortOrder: m.sortOrder ?? 0 };
      return m.id ? api(`/labels/${m.id}`, { method: 'PATCH', body }) : api('/labels', { body });
    },
    onSuccess: () => {
      setLabelModal(null);
      void qc.invalidateQueries({ queryKey: ['counts'] });
    },
    onError: () => pushToast('標籤儲存失敗（名稱重複？）'),
  });

  const deleteLabel = useMutation({
    mutationFn: (id: string) => api(`/labels/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['counts'] });
      void qc.invalidateQueries({ queryKey: ['messages'] });
      pushToast('標籤已刪除');
    },
  });

  // F4.5：標籤 2 層樹排序（頂層→其子；孤兒視為頂層）。labels 已由後端依 sort_order 排序。
  const topLabelIds = new Set(labels.filter((l) => !l.parentId).map((l) => l.id));
  const orderedLabels: { l: (typeof labels)[number]; child: boolean }[] = [];
  for (const l of labels) {
    if (!l.parentId || !topLabelIds.has(l.parentId)) {
      orderedLabels.push({ l, child: false });
      if (!l.parentId) for (const ch of labels.filter((x) => x.parentId === l.id)) orderedLabels.push({ l: ch, child: true });
    }
  }

  const toggleRule = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api(`/rules/${id}`, { method: 'PATCH', body: { enabled } }),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['rules'] }),
  });

  const deleteRule = useMutation({
    mutationFn: (id: string) => api(`/rules/${id}`, { method: 'DELETE' }),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['rules'] }),
  });

  // 套用到既有信：先 dryRun 預覽符合數（不異動）→ 使用者確認 → 實際套用。
  const previewApplyRule = async (r: Rule) => {
    try {
      const res = await api<{ matched: number; sample: { id: string; from: string; subject: string }[]; truncated: boolean }>(
        `/rules/${r.id}/run`,
        { body: { dryRun: true } },
      );
      if (res.matched === 0) {
        pushToast(res.truncated ? '最新 5000 封中沒有符合的信件' : '收件匣沒有符合這條規則的信件');
        return;
      }
      setApplyPreview({ rule: r, matched: res.matched, sample: res.sample, truncated: res.truncated, applying: false });
    } catch {
      pushToast('預覽失敗，請再試一次');
    }
  };
  const confirmApplyRule = async () => {
    if (!applyPreview) return;
    setApplyPreview((p) => (p ? { ...p, applying: true } : p));
    try {
      const res = await api<{ applied: number }>(`/rules/${applyPreview.rule.id}/run`, { body: { dryRun: false } });
      pushToast(`已套用到 ${res.applied} 封信 ✅`);
      void qc.invalidateQueries({ queryKey: ['messages'] });
      void qc.invalidateQueries({ queryKey: ['counts'] });
      setApplyPreview(null);
    } catch {
      pushToast('套用失敗，請再試一次');
      setApplyPreview((p) => (p ? { ...p, applying: false } : p));
    }
  };

  const addPasskey = async () => {
    try {
      const { challengeId, options } = await api<{ challengeId: string; options: never }>('/auth/passkey/add/options', { body: {} });
      const response = await startRegistration({ optionsJSON: options });
      await api('/auth/passkey/add/verify', { body: { challengeId, response } });
      void qc.invalidateQueries({ queryKey: ['passkeys'] });
      pushToast('Passkey 已新增 🔑');
    } catch {
      pushToast('Passkey 新增未完成');
    }
  };

  const removePasskey = async (id: string) => {
    try {
      await api(`/auth/passkeys/${id}`, { method: 'DELETE' });
      void qc.invalidateQueries({ queryKey: ['passkeys'] });
      pushToast('Passkey 已移除');
    } catch {
      pushToast('至少需保留一把 Passkey');
    }
  };

  const revokeAll = async () => {
    await api('/auth/sessions/revoke-all', { method: 'POST', body: {} });
    location.reload();
  };

  const [group, setGroup] = useState<SettingsGroup>('notify');
  // F12.3(b)：活躍 session 裝置清單（只在「隱私與安全」分頁載入）
  interface SessionRow { id: string; user_agent: string | null; ip: string | null; created_at: number }
  const sessions = useQuery({
    queryKey: ['sessions'],
    queryFn: () => api<{ sessions: SessionRow[]; current: string }>('/auth/sessions'),
    enabled: group === 'security',
  });
  const revokeOne = useMutation({
    mutationFn: (id: string) => api(`/auth/sessions/${id}/revoke`, { method: 'POST', body: {} }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['sessions'] }); pushToast('已登出該裝置'); },
    onError: () => pushToast('撤銷失敗，請再試一次'),
  });
  // 粗粒度裝置名（與後端 coarseUa 同精神；純顯示用）
  const deviceName = (ua: string | null): string => {
    if (!ua) return '未知裝置';
    const os = /iphone|ipad|ipod/i.test(ua) ? 'iOS' : /android/i.test(ua) ? 'Android' : /mac os x|macintosh/i.test(ua) ? 'macOS' : /windows/i.test(ua) ? 'Windows' : /cros/i.test(ua) ? 'ChromeOS' : /linux/i.test(ua) ? 'Linux' : '未知系統';
    const br = /edg\//i.test(ua) ? 'Edge' : /opr\/|opera/i.test(ua) ? 'Opera' : /firefox|fxios/i.test(ua) ? 'Firefox' : /chrome|crios/i.test(ua) ? 'Chrome' : /safari/i.test(ua) ? 'Safari' : '未知瀏覽器';
    return `${br} · ${os}`;
  };
  // F9.3：訂閱儀表板資料（只在「郵件」分頁載入）
  const subs = useSubscriptions(group === 'mail');
  // F4.6a：使用者端儲存用量（唯讀，只在「資料與進階」分頁載入）
  const storage = useQuery({
    queryKey: ['storage'],
    queryFn: () => api<{ totalBytes: number; messageBytes: number; attachmentBytes: number; messageCount: number; largest: { id: string; subject: string; from: string; sizeBytes: number; folder: string; hasAttachments: boolean }[] }>('/storage'),
    enabled: group === 'data',
    staleTime: 60_000,
  });
  // F4.6b：分享連結清單 + 一鍵延長；大信「移到垃圾桶」（走既有 trash 流程，可復原）
  const shares = useQuery({
    queryKey: ['shares'],
    queryFn: () => api<{ shares: { id: string; filename: string; sizeBytes: number; downloadCount: number; expiresAt: number; url: string }[] }>('/share'),
    enabled: group === 'data',
    staleTime: 60_000,
  });
  const extendShare = useMutation({
    mutationFn: (id: string) => api(`/share/${id}/extend`, { method: 'POST' }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['shares'] }); pushToast('分享連結已延長 🔗'); },
    onError: () => pushToast('延長失敗（連結可能已過期）'),
  });
  const trashBig = useMutation({
    mutationFn: (id: string) => api('/messages/batch', { method: 'POST', body: { ids: [id], patch: { folder: 'trash' } } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['storage'] });
      void qc.invalidateQueries({ queryKey: ['messages'] });
      void qc.invalidateQueries({ queryKey: ['counts'] });
      pushToast('已移到垃圾桶（可在垃圾桶復原）🗑️');
    },
  });

  /* 自助重新產生備援碼（覆蓋舊碼） */
  const [newBackupCodes, setNewBackupCodes] = useState<string[] | null>(null);
  const regenBackup = async () => {
    if (!(await confirmDialog({
      title: '重新產生備援碼？',
      body: '舊的 8 組備援碼會立即失效，請改用新的一組並妥善保存。',
      confirmText: '重新產生',
    }))) return;
    try {
      const r = await api<{ backupCodes: string[] }>('/backup-codes/regenerate', { method: 'POST', body: {} });
      setNewBackupCodes(r.backupCodes);
      onMeChanged();
    } catch {
      pushToast('重新產生備援碼失敗');
    }
  };

  return (
    <main className="readpane">
      <div className="content-page">
        <div className="mobile-topbar">
          <button className="iconbtn mobile-only" aria-label="開啟選單" onClick={onMenu}><Icon name="menu" /></button>
          <span className="t">設定</span>
        </div>
        <h1 className="page-title">設定</h1>
        <p className="page-sub">個人偏好只影響你自己的帳號，變更即時生效。</p>

        <div className="settings-nav cat-tabs" role="tablist" aria-label="設定分類">
          {SETTINGS_TABS.map((t) => (
            <button key={t.key} role="tab" aria-selected={group === t.key}
              className={`cat-tab ${group === t.key ? 'active' : ''}`} onClick={() => setGroup(t.key)}>
              {t.label}
            </button>
          ))}
        </div>

        <section className="settings-section" hidden={group !== 'compose'}>
          <h3>簽名檔</h3>
          <p className="desc">寄出與回覆的信件會自動附上簽名。</p>
          <textarea className="input" rows={3} value={sigDraft} style={{ resize: 'vertical', lineHeight: 1.6 }}
            onChange={(e) => { setSigDraft(e.target.value); setSaved(false); }}></textarea>
          <div style={{ display: 'flex', gap: 10, marginTop: 12, alignItems: 'center' }}>
            <button className="btn btn-primary btn-sm" onClick={() => void saveSignature()}>儲存簽名檔</button>
            {saved && <span style={{ fontSize: 13, color: 'var(--success)', display: 'inline-flex', alignItems: 'center', gap: 5 }}><Icon name="check" size={14} /> 已儲存</span>}
          </div>
        </section>

        <SignaturesSection hidden={group !== 'compose'} pushToast={pushToast} />

        <section className="settings-section" hidden={group !== 'appearance'}>
          <h3>外觀</h3>
          <p className="desc">主題偏好會記住在這台裝置與你的帳號，隨心情切換。</p>
          <div className="setting-row">
            <div>
              <div className="label">深色模式</div>
              <div className="hint">夜空與極光的最佳舞台</div>
            </div>
            <Switch on={theme.theme === 'dark'} ariaLabel="深色模式"
              onChange={(v) => setTheme({ theme: v ? 'dark' : 'light' })} />
          </div>
          <div className="setting-row">
            <div>
              <div className="label">極光主色</div>
              <div className="hint">影響按鈕、未讀指示與強調色</div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              {([['green', '#5FF6C2'], ['cyan', '#38BDF8'], ['violet', '#A78BFA']] as const).map(([key, color]) => (
                <button key={key} aria-label={`主色 ${key}`}
                  onClick={() => setTheme({ accent: key })}
                  style={{
                    width: 28, height: 28, borderRadius: '50%', background: color, cursor: 'pointer',
                    border: theme.accent === key ? '2px solid var(--text-primary)' : '2px solid transparent',
                    boxShadow: theme.accent === key ? '0 0 0 2px var(--bg-surface) inset' : 'none',
                  }}></button>
              ))}
            </div>
          </div>
          {/* F11.4：自訂配色——取色器覆寫 accent / 背景（存 prefs 跨裝置同步） */}
          <div className="setting-row">
            <div>
              <div className="label">自訂配色</div>
              <div className="hint">用取色器調出自己的極光；背景請保持夠深以維持可讀性。重置即回到上方預設主色。</div>
            </div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <label className="hint" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                主色
                <input type="color" aria-label="自訂主色" value={custom.accent ?? '#5FF6C2'}
                  onChange={(e) => void saveCustom({ ...custom, accent: e.target.value })} />
              </label>
              <label className="hint" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                背景
                <input type="color" aria-label="自訂背景色" value={custom.bg ?? '#0A0E1A'}
                  onChange={(e) => void saveCustom({ ...custom, bg: e.target.value })} />
              </label>
              {(custom.accent || custom.bg) && (
                <button className="btn btn-ghost btn-sm" onClick={() => void saveCustom(null)}>重置</button>
              )}
            </div>
          </div>
          <div className="setting-row">
            <div>
              <div className="label">風格方向</div>
              <div className="hint">夢幻：柔光漸層、圓潤邊角；冷冽：鐵青色調、銳利線條</div>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              {([['dream', '夢幻'], ['crisp', '冷冽']] as const).map(([key, name]) => (
                <button key={key} className={`btn btn-sm ${theme.style === key ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => setTheme({ style: key })}>{name}</button>
              ))}
            </div>
          </div>
          <div className="setting-row">
            <div>
              <div className="label">極光流動動效</div>
              <div className="hint">關閉後仍保留靜態漸層（prefers-reduced-motion 時自動停用）</div>
            </div>
            <Switch on={theme.motion === 'on'} ariaLabel="極光流動動效"
              onChange={(v) => setTheme({ motion: v ? 'on' : 'off' })} />
          </div>
          <div className="setting-row">
            <div>
              <div className="label">列表密度</div>
              <div className="hint">緊湊模式隱藏摘要與標籤列</div>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              {([['comfortable', '舒適'], ['compact', '緊湊']] as const).map(([key, name]) => (
                <button key={key} className={`btn btn-sm ${theme.density === key ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => setTheme({ density: key })}>{name}</button>
              ))}
            </div>
          </div>
          <div className="setting-row">
            <div>
              <div className="label">永遠顯示捲軸</div>
              <div className="hint">預設依系統可能自動隱藏；開啟後捲軸常駐顯示（無障礙）</div>
            </div>
            <Switch on={theme.scrollbar === 'always'} ariaLabel="永遠顯示捲軸"
              onChange={(v) => setTheme({ scrollbar: v ? 'always' : 'auto' })} />
          </div>
          <div className="setting-row">
            <div>
              <div className="label">高對比</div>
              <div className="hint">拉亮淡色文字、加強邊框、關閉外發光（系統設高對比/forced-colors 時也會自動套用）</div>
            </div>
            <Switch on={theme.contrast === 'high'} ariaLabel="高對比"
              onChange={(v) => setTheme({ contrast: v ? 'high' : 'normal' })} />
          </div>
        </section>

        <section className="settings-section" hidden={group !== 'data'}>
          <h3>儲存用量</h3>
          <p className="desc">看看你的信件與附件佔了多少空間，找出最大的信件。</p>
          {storage.isLoading && <p className="hint">載入中…</p>}
          {storage.data && (
            <>
              <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 16 }}>
                <div><div style={{ fontSize: 26, fontWeight: 700 }}>{formatBytes(storage.data.totalBytes)}</div><div className="hint">總用量</div></div>
                <div><div style={{ fontSize: 18 }}>{formatBytes(storage.data.messageBytes)}</div><div className="hint">信件內文（{storage.data.messageCount} 封）</div></div>
                <div><div style={{ fontSize: 18 }}>{formatBytes(storage.data.attachmentBytes)}</div><div className="hint">附件</div></div>
              </div>
              <h4 style={{ margin: '4px 0 8px' }}>最大的信件</h4>
              {storage.data.largest.length === 0 ? (
                <p className="hint">還沒有信件。</p>
              ) : (
                <table className="table">
                  <thead><tr><th>主旨</th><th>寄件者</th><th>資料夾</th><th style={{ textAlign: 'right' }}>大小</th><th></th></tr></thead>
                  <tbody>
                    {storage.data.largest.map((m) => (
                      <tr key={m.id}>
                        <td style={{ maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.hasAttachments && '📎 '}{m.subject || '(無主旨)'}</td>
                        <td style={{ maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.from}</td>
                        <td className="hint">{FOLDER_NAMES[m.folder] ?? m.folder}</td>
                        <td className="mono" style={{ textAlign: 'right' }}>{formatBytes(m.sizeBytes)}</td>
                        <td style={{ textAlign: 'right' }}>
                          {m.folder !== 'trash' && (
                            <button className="btn btn-ghost btn-sm" style={{ color: 'var(--danger)' }} disabled={trashBig.isPending}
                              onClick={() => trashBig.mutate(m.id)}>移到垃圾桶</button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <p className="hint" style={{ marginTop: 10 }}>「移到垃圾桶」可在垃圾桶復原；清空垃圾桶後才真正釋出空間。</p>
            </>
          )}

          {/* F9.1：spam/trash 30 天自動清（誠實文案：永久刪除、無法復原） */}
          <div className="setting-row" style={{ marginTop: 16 }}>
            <div>
              <div className="label">垃圾信 / 垃圾桶 30 天自動清理</div>
              <div className="hint">進入垃圾信或垃圾桶超過 30 天的郵件（含附件；<strong>星標/釘選也會清</strong>）將自動<strong>永久刪除，無法復原</strong>。天數從移入當天起算。</div>
            </div>
            <Switch on={purgeOn} ariaLabel="垃圾信 / 垃圾桶 30 天自動清理"
              onChange={(v) => { setPurgeOn(v); void savePurge(v); }} />
          </div>

          {/* F9.2：每資料夾保留規則（opt-in，預設永久；星標/釘選永不清） */}
          <h4 style={{ margin: '20px 0 8px' }}>自動清理保留規則</h4>
          <p className="hint">超過保留期的郵件（含附件）將<strong>永久刪除，無法復原</strong>；天數從進入該資料夾起算。此區規則下，<strong>星標、釘選、稍後處理中、標記工作流或有跟進提醒的郵件永不清理</strong>；mbox 匯入的歷史信也不受封存保留期影響（僅限本功能上線後的匯入——更早匯入的舊信無法自動辨識，設定前請留意）。收據匣以主旨判定、可能誤判，故不提供自動清理。</p>
          <div className="setting-row">
            <div>
              <div className="label">封存</div>
              <div className="hint">進入封存超過保留期即清除（匯入的歷史信除外）</div>
            </div>
            <Select value={retention.archive} ariaLabel="封存保留期" options={RETENTION_OPTIONS}
              onChange={(v) => void saveRetention({ ...retention, archive: v })} />
          </div>
          <div className="setting-row">
            <div>
              <div className="label">電子報</div>
              <div className="hint">帶退訂標頭、<strong>已讀且你未回覆過</strong>的信（收件匣＋封存）超過保留期即清除——未讀或參與過的對話串永不清</div>
            </div>
            <Select value={retention.newsletter} ariaLabel="電子報保留期" options={RETENTION_OPTIONS}
              onChange={(v) => void saveRetention({ ...retention, newsletter: v })} />
          </div>

          <h4 style={{ margin: '20px 0 8px' }}>分享連結</h4>
          {shares.isLoading && <p className="hint">載入中…</p>}
          {shares.data && (shares.data.shares.length === 0 ? (
            <p className="hint">還沒有分享連結。寄大附件時會自動轉成連結。</p>
          ) : (
            <table className="table">
              <thead><tr><th>檔案</th><th>大小</th><th>下載</th><th>到期</th><th></th></tr></thead>
              <tbody>
                {shares.data.shares.map((s) => {
                  const days = Math.ceil((s.expiresAt - Date.now()) / 86400000);
                  return (
                    <tr key={s.id}>
                      <td style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        <a href={s.url} target="_blank" rel="noopener noreferrer">{s.filename}</a>
                      </td>
                      <td className="mono">{formatBytes(s.sizeBytes)}</td>
                      <td className="hint">{s.downloadCount} 次</td>
                      <td className="hint">{days <= 0 ? '已過期' : `${days} 天後`}</td>
                      <td style={{ textAlign: 'right' }}>
                        {days > 0 && (
                          <button className="btn btn-ghost btn-sm" disabled={extendShare.isPending} onClick={() => extendShare.mutate(s.id)}>延長</button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ))}
        </section>

        <section className="settings-section" hidden={group !== 'mail'}>
          {/* F9.3：訂閱管理儀表板——一頁看清所有電子報來源並處置 */}
          <h3>訂閱管理</h3>
          <p className="desc">彙整所有帶退訂標頭的寄件者（電子報匣）。退訂走寄件者提供的 List-Unsubscribe；封鎖會建規則把日後來信送進垃圾信；清除歷史把既有信移到垃圾桶（可復原）。</p>
          {subs.isLoading && <p className="hint">載入中…</p>}
          {subs.data && (subs.data.subscriptions.length === 0 ? (
            <p className="hint">目前沒有訂閱來源。</p>
          ) : (
            <table className="table">
              <thead><tr><th>寄件者</th><th style={{ textAlign: 'right' }}>近 30 天</th><th style={{ textAlign: 'right' }}>未讀 / 總數</th><th>最後一封</th><th style={{ width: 200 }}></th></tr></thead>
              <tbody>
                {subs.data.subscriptions.map((s) => (
                  <tr key={s.addr}>
                    <td style={{ maxWidth: 240 }}>
                      <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 }}>{s.name}</div>
                      <div className="hint mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.addr}</div>
                    </td>
                    <td className="mono" style={{ textAlign: 'right' }}>{s.last30}</td>
                    <td className="mono" style={{ textAlign: 'right' }}>{s.unread} / {s.total}</td>
                    <td className="hint" style={{ whiteSpace: 'nowrap' }}>{timeAgo(s.lastAt)}</td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button className="btn btn-ghost btn-sm" disabled={unsubMut.isPending}
                        data-tooltip="向寄件者送出退訂請求" onClick={() => doUnsubscribe(s.latestId, s.addr)}>退訂</button>
                      <button className="btn btn-ghost btn-sm" disabled={blockMut.isPending}
                        data-tooltip="日後來信自動進垃圾信" onClick={() => doBlock(s.addr)}>封鎖</button>
                      <button className="btn btn-ghost btn-sm" style={{ color: 'var(--danger)' }} disabled={batchMut.isPending}
                        data-tooltip="既有信移到垃圾桶（可復原）" onClick={() => void clearHistory(s.addr, s.total)}>清除</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ))}
        </section>

        {/* F9.5：守門暗號——告訴對方暗號即可繞過首次來信守門 */}
        <section className="settings-section" hidden={group !== 'mail'}>
          <h3>守門暗號</h3>
          <p className="desc">陌生寄件者若驗證未完全通過會先進「待審」。把暗號告訴信任的人，對方在<strong>主旨</strong>放上暗號即可直接進收件匣（不分大小寫）。</p>
          {speakeasy ? (
            <div className="setting-row">
              <div>
                <div className="label mono">{speakeasy}</div>
                <div className="hint">例如主旨：「聚餐時間（{speakeasy}）」</div>
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="btn btn-ghost btn-sm"
                  onClick={() => void navigator.clipboard?.writeText(speakeasy).then(() => pushToast('已複製 📋')).catch(() => pushToast('複製失敗'))}>複製</button>
                <button className="btn btn-ghost btn-sm" onClick={genSpeakeasy}>換一組</button>
                <button className="btn btn-ghost btn-sm" style={{ color: 'var(--danger)' }} onClick={() => void saveSpeakeasy(null)}>停用</button>
              </div>
            </div>
          ) : (
            <button className="btn btn-secondary btn-sm" onClick={genSpeakeasy}>
              <Icon name="shield" size={14} /> 產生暗號
            </button>
          )}
        </section>

        <section className="settings-section" hidden={group !== 'mail'}>
          <h3>標籤</h3>
          <p className="desc">標籤可在規則中自動套用，也會顯示在列表與側欄。可設父標籤建巢狀（如帳單／水電），排序值小的置頂。</p>
          <table className="table">
            <thead><tr><th>名稱</th><th>排序</th><th>顏色</th><th style={{ width: 160 }}></th></tr></thead>
            <tbody>
              {orderedLabels.map(({ l, child }) => (
                <tr key={l.id}>
                  <td style={child ? { paddingLeft: 28 } : undefined}>{child && <span style={{ color: 'var(--text-muted)', marginRight: 4 }}>↳</span>}<LabelChip label={l} /></td>
                  <td className="mono">{l.sortOrder ?? 0}</td>
                  <td className="mono">{l.color}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button className="btn btn-ghost btn-sm" onClick={() => setLabelModal({ id: l.id, name: l.name, color: l.color, parentId: l.parentId ?? null, sortOrder: l.sortOrder ?? 0 })}>編輯</button>
                    <button className="btn btn-ghost btn-sm" style={{ color: 'var(--danger)' }} onClick={() => void deleteLabel.mutateAsync(l.id)}>刪除</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button className="btn btn-secondary btn-sm" style={{ marginTop: 12 }}
            onClick={() => setLabelModal({ name: '', color: '#5FF6C2' })}>
            <Icon name="tag" size={14} /> 新增標籤
          </button>
        </section>

        <section className="settings-section" hidden={group !== 'mail'}>
          <h3>自動規則</h3>
          <p className="desc">信件落地（ingest）時依優先序套用，由上而下。</p>
          {(rules.data?.rules ?? []).map((r) => {
            const d = describeRule(r, labels);
            return (
              <div className="setting-row" key={r.id}>
                <div style={{ minWidth: 0 }}>
                  <div className="label">{r.name}</div>
                  <div className="hint">若 {d.cond} → {d.act}</div>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <Switch on={r.enabled} ariaLabel={`規則 ${r.name}`}
                    onChange={(v) => toggleRule.mutate({ id: r.id, enabled: v })} />
                  <button className="iconbtn" aria-label="套用到既有信" data-tooltip="套用到收件匣現有信" onClick={() => void previewApplyRule(r)}>
                    <Icon name="refresh" size={14} />
                  </button>
                  <button className="iconbtn" aria-label="編輯規則" data-tooltip="編輯" onClick={() => setEditingRule(r)}>
                    <Icon name="pen" size={14} />
                  </button>
                  <button className="iconbtn" aria-label="刪除規則" data-tooltip="刪除" onClick={() => deleteRule.mutate(r.id)}>
                    <Icon name="trash" size={14} />
                  </button>
                </div>
              </div>
            );
          })}
          <button className="btn btn-secondary btn-sm" style={{ marginTop: 12 }} onClick={() => setRuleModal(true)}>新增規則</button>
        </section>

        <section className="settings-section" hidden={group !== 'security'}>
          <h3>安全性</h3>
          <p className="desc">本系統不使用密碼，登入完全依賴 Passkey 與 TOTP。</p>
          <div className="setting-row">
            <div>
              <div className="label">Passkeys</div>
              <div className="hint">
                {(passkeys.data?.passkeys ?? []).map((p) =>
                  `${p.name ?? (p.device_type === 'multiDevice' ? '可同步裝置' : '單一裝置')}（${p.last_used_at ? `上次 ${timeAgo(p.last_used_at)}` : '未使用'}）`,
                ).join(' · ') || '—'}
              </div>
            </div>
            <button className="btn btn-secondary btn-sm" onClick={() => void addPasskey()}><Icon name="key" size={14} /> 新增 Passkey</button>
          </div>
          {(passkeys.data?.passkeys ?? []).length > 1 && (
            <div className="setting-row">
              <div className="hint" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {(passkeys.data?.passkeys ?? []).map((p) => (
                  <button key={p.id} className="btn btn-ghost btn-sm" style={{ color: 'var(--danger)' }}
                    onClick={() => void removePasskey(p.id)}>
                    移除 {p.name ?? p.id.slice(0, 8)}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="setting-row">
            <div>
              <div className="label">TOTP 驗證器</div>
              <div className="hint" style={me.totpEnabled && me.backupCodesLeft <= 2 ? { color: 'var(--warning)' } : undefined}>
                {me.totpEnabled
                  ? `已啟用 · 備援碼剩餘 ${me.backupCodesLeft} 組${me.backupCodesLeft <= 2 ? '（偏少，建議重新產生並保存好）' : ''}`
                  : '尚未設定（建議啟用）'}
              </div>
            </div>
            {me.totpEnabled ? (
              <div style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                <button className="btn btn-ghost btn-sm" onClick={() => void regenBackup()}>重新產生備援碼</button>
                <span className="badge green">已啟用</span>
              </div>
            ) : <span className="badge amber">未設定</span>}
          </div>
          <div className="setting-row">
            <div>
              <div className="label">登入工作階段</div>
              <div className="hint">登出所有裝置後需要重新以 Passkey 登入。新裝置登入時會推播提醒你。</div>
            </div>
            <button className="btn btn-danger btn-sm" onClick={() => void revokeAll()}>登出所有裝置</button>
          </div>
          {/* F12.3(b)：活躍裝置清單 + 單一撤銷 */}
          {(sessions.data?.sessions?.length ?? 0) > 0 && (
            <ul style={{ listStyle: 'none', padding: 0, margin: '4px 0 0', display: 'flex', flexDirection: 'column', gap: 6 }}>
              {sessions.data!.sessions.map((sn) => {
                const isCurrent = sn.id === sessions.data!.current;
                return (
                  <li key={sn.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', background: 'var(--bg-elevated)', borderRadius: 8 }}>
                    <Icon name={/iphone|ipad|android/i.test(sn.user_agent ?? '') ? 'snooze' : 'command'} size={15} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600 }}>
                        {deviceName(sn.user_agent)}
                        {isCurrent && <span className="badge green" style={{ marginLeft: 8 }}>目前裝置</span>}
                      </div>
                      <div className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                        {sn.ip ?? '—'} · {timeAgo(sn.created_at)}登入
                      </div>
                    </div>
                    {!isCurrent && (
                      <button className="btn btn-ghost btn-sm" style={{ color: 'var(--danger)' }}
                        disabled={revokeOne.isPending}
                        aria-label={`登出 ${deviceName(sn.user_agent)}`}
                        onClick={() => revokeOne.mutate(sn.id)}>登出</button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="settings-section" hidden={group !== 'notify'}>
          <h3>通知</h3>
          <p className="desc">新信的系統推播與提示音。<b>每台裝置各自設定</b>——在手機上要另外開一次。</p>
          {iosNeedsInstall ? (
            <div className="ios-push-guide">
              <div className="ios-push-guide-pori"><Pori size={72} pose="wave" /></div>
              <div className="ios-push-guide-body">
                <div className="label">在 iPhone／iPad 上開啟推播</div>
                <div className="hint" style={{ margin: '2px 0 10px' }}>
                  iOS 規定：要先把 Miseroda「加入主畫面」當成 App，才能收到新信通知。
                </div>
                <ol className="ios-push-steps">
                  <li>點 Safari 底部的「分享」{IOS_SHARE_GLYPH} 鈕</li>
                  <li>選「加入主畫面」{IOS_PLUS_GLYPH}</li>
                  <li>從主畫面開啟 Miseroda，回到這裡開啟推播</li>
                </ol>
                {!pwa.iosSafari && (
                  <div className="hint" style={{ marginTop: 8, color: 'var(--warning, var(--accent))' }}>
                    請改用 <b>Safari</b> 開啟本站才能「加入主畫面」（其他瀏覽器在 iOS 上不支援）。
                  </div>
                )}
              </div>
            </div>
          ) : pushSupported && notifDenied ? (
            <div className="ios-push-guide">
              <div className="ios-push-guide-pori"><Pori size={72} pose="wave" /></div>
              <div className="ios-push-guide-body">
                <div className="label">通知被封鎖了，手動開回來</div>
                <div className="hint" style={{ margin: '2px 0 10px' }}>
                  這台裝置先前選了「不允許」，瀏覽器不會再自動詢問 —— 手動改一下就能收到新信通知：
                </div>
                <ol className="ios-push-steps">
                  {pwa.ios ? (
                    <>
                      <li>iPhone「設定」→「通知」</li>
                      <li>找到「Miseroda」→ 開啟「允許通知」</li>
                      <li>回到這裡，重新開啟推播</li>
                    </>
                  ) : (
                    <>
                      <li>點網址列左側的鎖頭 / 設定圖示</li>
                      <li>把「通知」改成「允許」</li>
                      <li>重新整理本頁，再開啟推播</li>
                    </>
                  )}
                </ol>
              </div>
            </div>
          ) : (
            <div className="setting-row">
              <div>
                <div className="label">新信系統推播</div>
                <div className="hint">
                  {pushSupported
                    ? '關閉分頁也能收到新信通知（此裝置）'
                    : '此瀏覽器不支援推播通知'}
                </div>
              </div>
              <Switch on={pushOn} disabled={!pushSupported || pushBusy} ariaLabel="新信系統推播"
                onChange={(v) => { setPushOn(v); void togglePush(v); }} />
            </div>
          )}
          {/* 提示音與推播各自獨立：分頁開著就靠它出聲，不需要推播權限。故放在上面那組條件式之外。 */}
          <div className="setting-row">
            <div>
              <div className="label">新信提示音</div>
              <div className="hint">
                只在你沒看著這個分頁時響（切到別的分頁／別的視窗／最小化）。分頁關掉時改由系統通知音負責。
                {sound.on && pushSupported && !pushOn && (
                  <>
                    <br />
                    分頁離開超過一分鐘後會自動斷線省電，屆時要靠推播才叫得醒它 —— 建議一併開啟上面的「新信系統推播」。
                  </>
                )}
              </div>
            </div>
            <Switch on={sound.on} ariaLabel="新信提示音"
              onChange={(v) => applySound({ ...sound, on: v }, true)} />
          </div>
          {sound.on && (
            <div className="setting-row">
              <div>
                <div className="label">音量</div>
                <div className="hint">三音琶音，約半秒</div>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flex: 'none' }}>
                <Select<number> value={sound.vol} ariaLabel="提示音音量" options={SOUND_VOL_OPTIONS}
                  style={{ flex: 'none', minWidth: 104 }}
                  onChange={(v) => applySound({ ...sound, vol: v }, true)} />
                <button type="button" className="btn btn-secondary btn-sm"
                  onClick={() => { unlockChime(); playChime(sound.vol); }}>試聽</button>
              </div>
            </div>
          )}
        </section>

        {/* 2026-09-22 從「通知」拆出：這兩項是 AI 幫你整理信件，不是通知 */}
        <section className="settings-section" hidden={group !== 'mail'}>
          <h3>AI 助理</h3>
          <p className="desc">由企鵝 Pori 在每天早上 8 點（台北時間）整理的晨報，以及抵達即備稿。</p>
          <div className="setting-row">
            <div>
              <div className="label">每日 AI 晨報</div>
              <div className="hint">彙整過去 24 小時的未讀重點，自動放進收件匣最上方</div>
            </div>
            <Switch on={digestOn} ariaLabel="每日 AI 晨報"
              onChange={(v) => { setDigestOn(v); void saveDigest(v); }} />
          </div>
          <div className="setting-row">
            <div>
              <div className="label">抵達即備稿（AI Auto Drafts）</div>
              <div className="hint">看起來在等你回覆的私人信，抵達時先幫你擬好回覆草稿——打開信就能一鍵帶入撰寫器</div>
            </div>
            <Switch on={autoDraftsOn} ariaLabel="抵達即備稿"
              onChange={(v) => { setAutoDraftsOn(v); void saveAutoDrafts(v); }} />
          </div>
        </section>

        <section className="settings-section" hidden={group !== 'compose'}>
          <h3>罐頭範本</h3>
          <p className="desc">寫信時按 <kbd>/</kbd> 或工具列「範本」快速插入。</p>
          {templates.map((t) => (
            <div className="setting-row" key={t.id}>
              <div style={{ minWidth: 0 }}>
                <div className="label">{t.name}</div>
                <div className="hint" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.body.slice(0, 60)}</div>
              </div>
              <div style={{ display: 'flex', gap: 4 }}>
                <button className="btn btn-ghost btn-sm" onClick={() => setTplModal({ id: t.id, name: t.name, body: t.body })}>編輯</button>
                <button className="btn btn-ghost btn-sm" style={{ color: 'var(--danger)' }}
                  onClick={() => void saveTemplates(templates.filter((x) => x.id !== t.id))}>刪除</button>
              </div>
            </div>
          ))}
          <button className="btn btn-secondary btn-sm" style={{ marginTop: 12 }}
            onClick={() => setTplModal({ name: '', body: '' })}>
            <Icon name="draft" size={14} /> 新增範本
          </button>
        </section>

        <section className="settings-section" hidden={group !== 'compose'}>
          <h3>假期自動回覆</h3>
          <p className="desc">期間內每位寄件人 4 天最多收到一次；電子報與系統信不會觸發。</p>
          <div className="setting-row">
            <div>
              <div className="label">啟用自動回覆</div>
              <div className="hint">{vacUntil ? `至 ${vacUntil} 止` : '未設結束日（手動關閉為止）'}</div>
            </div>
            <Switch on={vacOn} ariaLabel="假期自動回覆"
              onChange={(v) => { setVacOn(v); void saveVacation(v); }} />
          </div>
          <div className="field" style={{ marginTop: 8 }}>
            <label htmlFor="vac-until">結束日期（選填）</label>
            <DateTimeField id="vac-until" mode="date" clearable value={vacUntil} onChange={setVacUntil} ariaLabel="結束日期"
              className="uidate-narrow" />
          </div>
          <div className="field" style={{ marginTop: 10 }}>
            <label htmlFor="vac-body">回覆內容</label>
            <textarea id="vac-body" className="input" rows={3} value={vacBody} style={{ resize: 'vertical' }}
              placeholder="我目前不在辦公室，將於回來後盡快回覆。" onChange={(e) => setVacBody(e.target.value)}></textarea>
          </div>
          <button className="btn btn-primary btn-sm" style={{ marginTop: 12 }} onClick={() => void saveVacation(vacOn)}>儲存</button>
        </section>

        <section className="settings-section" hidden={group !== 'addresses'}>
          <h3>Plus 別名</h3>
          <p className="desc">給不同服務不同地址（{me.user.email.split('@')[0]}+網站名@miseroda.com），這裡看誰寄給哪個別名。</p>
          {(aliases.data?.aliases ?? []).length === 0 ? (
            <p className="hint" style={{ fontSize: 13, color: 'var(--text-muted)' }}>還沒有別名來信。下次註冊網站時試試 +別名 吧。</p>
          ) : (
            <table className="table">
              <thead><tr><th>別名</th><th>收信數</th><th>最近</th><th></th></tr></thead>
              <tbody>
                {aliases.data!.aliases.map((a) => (
                  <tr key={a.address}>
                    <td className="mono">{a.address}</td>
                    <td className="mono">{a.count}</td>
                    <td className="mono">{timeAgo(a.lastUsed)}</td>
                    <td style={{ textAlign: 'right' }}>
                      <button className="btn btn-ghost btn-sm" onClick={() => setAliasRuleFor(a.address)}>建立規則</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        {/* F9.4：Masked Email——一鍵生成隨機別名，髒了單獨關 */}
        <section className="settings-section" hidden={group !== 'addresses'}>
          <h3>Masked 別名</h3>
          <p className="desc">註冊網站時用隨機別名（如 frost-otter-42@miseroda.com）代替真實地址；開始收垃圾信就把該別名停用——對外像「查無此人」，其他信箱不受影響。停用中的別名也不能當寄件身分。</p>
          <button className="btn btn-secondary btn-sm" disabled={genMasked.isPending} onClick={() => void genWithNote()}>
            <Icon name="shield" size={14} /> {genMasked.isPending ? '產生中…' : '產生別名'}
          </button>
          {(masked.data?.aliases ?? []).length > 0 && (
            <table className="table" style={{ marginTop: 12 }}>
              <thead><tr><th>別名</th><th>備註</th><th>狀態</th><th style={{ width: 150 }}></th></tr></thead>
              <tbody>
                {masked.data!.aliases.map((a) => (
                  <tr key={a.id} style={a.disabled ? { opacity: 0.55 } : undefined}>
                    <td className="mono" style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.address}</td>
                    <td className="hint" style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {a.note || (a.selfServe ? '—' : 'admin 指派')}
                    </td>
                    <td>{a.disabled ? <span style={{ color: 'var(--danger)' }}>已停用</span> : <span style={{ color: 'var(--success)' }}>使用中</span>}</td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button className="btn btn-ghost btn-sm" data-tooltip="複製地址"
                        onClick={() => void navigator.clipboard?.writeText(a.address).then(() => pushToast('已複製 📋')).catch(() => pushToast('複製失敗'))}>複製</button>
                      <button className="btn btn-ghost btn-sm" onClick={() => void editMaskedNote(a)}>備註</button>
                      <button className="btn btn-ghost btn-sm" style={a.disabled ? undefined : { color: 'var(--danger)' }}
                        disabled={patchMasked.isPending}
                        onClick={() => patchMasked.mutate({ id: a.id, disabled: !a.disabled })}>
                        {a.disabled ? '啟用' : '停用'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        {/* F11.2：行事曆 ICS 訂閱 feed */}
        <section className="settings-section" hidden={group !== 'addresses'}>
          <h3>行事曆訂閱網址</h3>
          <p className="desc">產生唯讀 ICS 訂閱網址給家人（iOS／Google 日曆「訂閱行事曆」貼上即可）。網址等同這顆行事曆的鑰匙，只交給信任的人；覺得外流就撤銷或重新產生（舊網址立即失效）。</p>
          {feedUrl && (
            <div className="hint mono" style={{ wordBreak: 'break-all', marginBottom: 10, padding: '8px 10px', background: 'var(--bg-elevated)', borderRadius: 8 }}>
              {feedUrl}
              <button className="btn btn-ghost btn-sm" style={{ marginLeft: 8 }}
                onClick={() => void navigator.clipboard?.writeText(feedUrl).then(() => pushToast('已複製 📋')).catch(() => pushToast('複製失敗'))}>複製</button>
            </div>
          )}
          {!feedUrl && calFeed.data?.active && (
            <p className="hint">訂閱網址使用中（{calFeed.data.createdAt ? timeAgo(calFeed.data.createdAt) : ''}產生）。基於安全不重複顯示網址；忘了就重新產生。</p>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-secondary btn-sm" disabled={genFeed.isPending} onClick={() => genFeed.mutate()}>
              <Icon name="calendar" size={14} /> {calFeed.data?.active ? '重新產生（舊網址失效）' : '產生訂閱網址'}
            </button>
            {calFeed.data?.active && (
              <button className="btn btn-ghost btn-sm" style={{ color: 'var(--danger)' }} disabled={revokeFeed.isPending}
                onClick={() => revokeFeed.mutate()}>撤銷</button>
            )}
          </div>
        </section>

        {/* F14.1：外部行事曆訂閱（反向）——把別人的 ICS 拉進來唯讀顯示 */}
        <section className="settings-section" hidden={group !== 'addresses'}>
          <h3>外部行事曆訂閱</h3>
          <p className="desc">貼上別人的 ICS 網址（家人共享行事曆、球隊賽程、國定假日等），系統每 6 小時同步一次，以唯讀事件顯示在你的行事曆（紫色）。僅 https 公開網址，最多 5 條。</p>
          {icsSubs.length > 0 && (
            <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
              {icsSubs.map((s, i) => (
                <li key={`${s.url}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', background: 'var(--bg-elevated)', borderRadius: 8 }}>
                  <Icon name="calendar" size={14} />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ fontWeight: 600, fontSize: 13 }}>{s.label || '(未命名)'}</span>
                    <span className="mono" style={{ display: 'block', fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.url}</span>
                  </span>
                  <button className="btn btn-ghost btn-sm" style={{ color: 'var(--danger)' }}
                    aria-label={`移除訂閱 ${s.label || s.url}`}
                    onClick={() => void saveIcsSubs(icsSubs.filter((_, j) => j !== i))}>移除</button>
                </li>
              ))}
            </ul>
          )}
          {icsSubs.length < 5 && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <input className="input" placeholder="https://…/calendar.ics" value={icsUrl} onChange={(e) => setIcsUrl(e.target.value)}
                style={{ flex: '2 1 240px' }} inputMode="url" aria-label="訂閱網址" />
              <input className="input" placeholder="名稱（選填）" value={icsLabel} onChange={(e) => setIcsLabel(e.target.value)}
                style={{ flex: '1 1 120px' }} aria-label="訂閱名稱" />
              <button className="btn btn-secondary btn-sm" onClick={addIcsSub}>新增</button>
            </div>
          )}
        </section>

        <section className="settings-section" hidden={group !== 'data'}>
          <h3>資料自主</h3>
          <div className="setting-row">
            <div>
              <div className="label">匯出整個信箱（.mbox）</div>
              <div className="hint">所有保存的原始郵件打包下載，可匯入 Thunderbird / Apple Mail</div>
            </div>
            <button className="btn btn-secondary btn-sm" onClick={exportMbox}><Icon name="download" size={14} /> 匯出</button>
          </div>
          <div className="setting-row">
            <div>
              <div className="label">匯入舊信（.mbox）</div>
              <div className="hint">從 Thunderbird / Apple Mail / Gmail Takeout 匯出的 mbox 上傳（≤25 MB），背景逐封匯入到「封存」並可搜尋。<strong>一次性匯入，非即時同步</strong>；不含附件。</div>
            </div>
            <button className="btn btn-secondary btn-sm" disabled={importing || !!activeImport} onClick={() => importFileRef.current?.click()}>
              <span style={{ display: 'inline-flex', transform: 'rotate(180deg)' }}><Icon name="download" size={14} /></span> {importing ? '上傳中…' : '匯入'}
            </button>
            <input ref={importFileRef} type="file" accept=".mbox,application/mbox,message/rfc822,.eml" hidden
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void doImportMbox(f); }} />
          </div>
          {activeImport && (
            <div className="setting-row" style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
              匯入中：{activeImport.done}{activeImport.total ? ` / ${activeImport.total}` : ''} 封
              {activeImport.skipped ? `（跳過重複 ${activeImport.skipped}）` : ''}
              {activeImport.failed ? `（失敗 ${activeImport.failed}）` : ''}…
            </div>
          )}
          {importJobs.data?.jobs.filter((j) => j.status === 'done' || j.status === 'error').slice(0, 1).map((j) => (
            <div key={j.id} className="setting-row" style={{ fontSize: 13, color: 'var(--text-muted)' }}>
              {j.status === 'error' ? '上次匯入失敗' : `上次匯入完成：${j.done} 封`}
              {j.skipped ? `，跳過重複 ${j.skipped}` : ''}{j.failed ? `，失敗 ${j.failed}` : ''}
            </div>
          ))}
        </section>

        <section className="settings-section" hidden={group !== 'data'}>
          <h3>送達率與網域驗證</h3>
          {deliverability.isLoading && <p className="desc">檢查中…</p>}
          {deliverability.data && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <p className="desc" style={{ margin: 0 }}>
                網域 <b>{deliverability.data.domain}</b> 的寄信驗證狀態
              </p>
              {(() => {
                const auth = (label: string, status: 'present' | 'absent' | 'unknown', okText: string, badText: string) => {
                  const c = status === 'present' ? 'var(--success)' : status === 'unknown' ? 'var(--text-muted)' : 'var(--danger)';
                  const mark = status === 'present' ? '✓' : status === 'unknown' ? '–' : '✗';
                  const text = status === 'present' ? okText : status === 'unknown' ? '無法檢查（DNS 查詢失敗，稍後再試）' : badText;
                  return <li><b style={{ color: c }}>{mark}</b> {label} — {text}</li>;
                };
                const d = deliverability.data;
                return (
                  <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
                    {auth('SPF', d.spf.status, '已設定', '未設定（外寄可能被退或進對方垃圾信）')}
                    {auth('DMARC', d.dmarc.status === 'present' ? 'present' : d.dmarc.status,
                      `已設定（政策 p=${d.dmarc.policy ?? '?'}）`, '未設定（建議加上以防網域被偽冒）')}
                    <li><b style={{ color: 'var(--success)' }}>✓</b> DKIM — 由 Cloudflare 代管，寄出信自動簽署</li>
                  </ul>
                );
              })()}
              <p className="desc" style={{ margin: '6px 0 0' }}>近 {deliverability.data.outbound.windowDays} 天寄送結果（含站內直送）</p>
              <div style={{ display: 'flex', gap: 18, fontSize: 13, flexWrap: 'wrap' }}>
                <span>已送出 <b>{deliverability.data.outbound.sent}</b></span>
                <span>失敗 <b style={{ color: deliverability.data.outbound.failed ? 'var(--danger)' : 'inherit' }}>{deliverability.data.outbound.failed}</b></span>
                <span>待確認 <b style={{ color: deliverability.data.outbound.review ? 'var(--warning)' : 'inherit' }}>{deliverability.data.outbound.review}</b></span>
                {deliverability.data.outbound.total > 0 && (
                  <span>成功率 <b>{Math.round((deliverability.data.outbound.sent / deliverability.data.outbound.total) * 100)}%</b></span>
                )}
              </div>
            </div>
          )}
        </section>

        <section className="settings-section" hidden={group !== 'security'}>
          <h3>隱私</h3>
          <div className="setting-row">
            <div>
              <div className="label">封鎖遠端圖片</div>
              <div className="hint">防止 tracking pixel，可逐封選擇載入</div>
            </div>
            <Switch on={true} ariaLabel="封鎖遠端圖片" onChange={() => pushToast('預設啟用，逐封載入')} />
          </div>
          <div className="setting-row">
            <div>
              <div className="label">讀取回條</div>
              <div className="hint">預設關閉（隱私考量）</div>
            </div>
            <Switch on={false} ariaLabel="讀取回條" onChange={() => pushToast('本系統不發送讀取回條')} />
          </div>
        </section>
      </div>

      {labelModal && (
        <Modal title={labelModal.id ? '重新命名標籤' : '新增標籤'} onClose={() => setLabelModal(null)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div className="field">
              <label htmlFor="label-name">名稱</label>
              <input id="label-name" className="input" value={labelModal.name} autoFocus
                onChange={(e) => setLabelModal({ ...labelModal, name: e.target.value })} />
            </div>
            <div className="field">
              <label>顏色</label>
              <div style={{ display: 'flex', gap: 8 }}>
                {['#5FF6C2', '#38BDF8', '#A78BFA', '#FBD46D', '#FF6B8A', '#F0A6E8'].map((color) => (
                  <button key={color} aria-label={`顏色 ${color}`}
                    onClick={() => setLabelModal({ ...labelModal, color })}
                    style={{
                      width: 26, height: 26, borderRadius: '50%', background: color, cursor: 'pointer',
                      border: labelModal.color === color ? '2px solid var(--text-primary)' : '2px solid transparent',
                    }}></button>
                ))}
              </div>
            </div>
            <div className="field">
              <label>父標籤（巢狀，限 2 層）</label>
              <Select<string> value={labelModal.parentId ?? ''} ariaLabel="父標籤"
                options={[{ value: '', label: '（無，頂層）' }, ...labels.filter((l) => !l.parentId && l.id !== labelModal.id).map((l) => ({ value: l.id, label: l.name }))]}
                onChange={(v) => setLabelModal({ ...labelModal, parentId: v || null })} />
            </div>
            <div className="field">
              <label htmlFor="label-sort">排序（數字小→置前，常用置頂）</label>
              <input id="label-sort" type="number" min={0} className="input" style={{ maxWidth: 120 }} value={labelModal.sortOrder ?? 0}
                onChange={(e) => setLabelModal({ ...labelModal, sortOrder: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} />
            </div>
            <button className="btn btn-primary" disabled={!labelModal.name.trim()}
              onClick={() => saveLabel.mutate(labelModal)}>儲存</button>
          </div>
        </Modal>
      )}

      {ruleModal && (
        <RuleModal labels={labels} onClose={() => setRuleModal(false)}
          onSaved={() => { setRuleModal(false); void qc.invalidateQueries({ queryKey: ['rules'] }); }} />
      )}

      {aliasRuleFor && (
        <RuleModal labels={labels} onClose={() => setAliasRuleFor(null)}
          initial={{ name: `別名 ${/\+([^@]+)@/.exec(aliasRuleFor)?.[1] ?? ''} 歸檔`, clauses: [{ field: 'to', op: 'contains', value: aliasRuleFor }] }}
          onSaved={() => { setAliasRuleFor(null); void qc.invalidateQueries({ queryKey: ['rules'] }); pushToast('別名規則已建立 🏷️'); }} />
      )}

      {editingRule && (
        <RuleModal labels={labels} editing={editingRule} onClose={() => setEditingRule(null)}
          onSaved={() => { setEditingRule(null); void qc.invalidateQueries({ queryKey: ['rules'] }); pushToast('規則已更新 ✏️'); }} />
      )}

      {applyPreview && (
        <Modal title="套用到既有信"
          desc={`收件匣中有 ${applyPreview.matched} 封信符合「${applyPreview.rule.name}」`}
          onClose={() => setApplyPreview(null)} width={520}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0 }}>
              將套用：{describeRule(applyPreview.rule, labels).act}。只影響收件匣現有信。
            </p>
            {applyPreview.truncated && (
              <p style={{ fontSize: 12.5, color: 'var(--warning)', margin: 0 }}>
                收件匣過大，僅掃描了最新 5000 封；較舊的符合信未納入。套用後可再執行一次以涵蓋更多。
              </p>
            )}
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: 4 }}>
              {applyPreview.sample.map((s) => (
                <li key={s.id}><span style={{ color: 'var(--text-primary)' }}>{s.from}</span> — {s.subject || '（無主旨）'}</li>
              ))}
              {applyPreview.matched > applyPreview.sample.length && <li>…還有 {applyPreview.matched - applyPreview.sample.length} 封</li>}
            </ul>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-secondary" onClick={() => setApplyPreview(null)} disabled={applyPreview.applying}>取消</button>
              <button className="btn btn-primary" disabled={applyPreview.applying} onClick={() => void confirmApplyRule()}>
                {applyPreview.applying ? '套用中…' : `套用到 ${applyPreview.matched} 封`}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {tplModal && (
        <Modal title={tplModal.id ? '編輯範本' : '新增範本'} onClose={() => setTplModal(null)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div className="field">
              <label htmlFor="tpl-name">名稱</label>
              <input id="tpl-name" className="input" value={tplModal.name} autoFocus
                onChange={(e) => setTplModal({ ...tplModal, name: e.target.value })} placeholder="例：會議改期" />
            </div>
            <div className="field">
              <label htmlFor="tpl-body">內容</label>
              <textarea id="tpl-body" className="input" rows={5} value={tplModal.body} style={{ resize: 'vertical' }}
                onChange={(e) => setTplModal({ ...tplModal, body: e.target.value })}></textarea>
            </div>
            <button className="btn btn-primary" disabled={!tplModal.name.trim() || !tplModal.body.trim()}
              onClick={() => {
                const next = tplModal.id
                  ? templates.map((t) => (t.id === tplModal.id ? { ...t, name: tplModal.name.trim(), body: tplModal.body } : t))
                  : [...templates, { id: Math.random().toString(36).slice(2), name: tplModal.name.trim(), body: tplModal.body }];
                void saveTemplates(next);
                setTplModal(null);
              }}>
              儲存範本
            </button>
          </div>
        </Modal>
      )}

      {newBackupCodes && (
        <Modal title="新的備援碼" desc="舊備援碼已失效。每組僅能用一次，請存放在安全的地方。" onClose={() => setNewBackupCodes(null)} width={420}>
          <div className="mono" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, margin: '6px 0 12px', fontSize: 15 }}>
            {newBackupCodes.map((code) => (
              <div key={code} style={{ padding: '7px 10px', background: 'var(--bg-elevated)', borderRadius: 8, textAlign: 'center' }}>{code}</div>
            ))}
          </div>
          <button className="btn btn-secondary btn-sm" onClick={() => void navigator.clipboard?.writeText(newBackupCodes.join('\n'))}>複製全部</button>
          <button className="btn btn-primary" style={{ width: '100%', marginTop: 10 }} onClick={() => setNewBackupCodes(null)}>我已保存</button>
        </Modal>
      )}
    </main>
  );
}

export function RuleModal({ labels, onClose, onSaved, initial, editing }: {
  labels: { id: string; name: string }[];
  onClose: () => void;
  onSaved: () => void;
  initial?: { name?: string; clauses?: RuleClause[] };
  editing?: Rule;
}) {
  const [name, setName] = useState(editing?.name ?? initial?.name ?? '');
  const [clauses, setClauses] = useState<RuleClause[]>(() => {
    if (editing) {
      // 既有規則 → 把舊版扁平條件併成子句一起呈現，讓使用者統一在子句列編輯。
      const cs = [...(editing.conditions.clauses ?? [])];
      if (editing.conditions.fromContains) cs.push({ field: 'from', op: 'contains', value: editing.conditions.fromContains });
      if (editing.conditions.subjectContains) cs.push({ field: 'subject', op: 'contains', value: editing.conditions.subjectContains });
      if (editing.conditions.toContains) cs.push({ field: 'to', op: 'contains', value: editing.conditions.toContains });
      if (cs.length) return cs;
    }
    return initial?.clauses ?? [{ field: 'from', op: 'contains', value: '' }];
  });
  const [matchAny, setMatchAny] = useState(editing?.conditions.match === 'any');
  const [hasUnsub, setHasUnsub] = useState(!!editing?.conditions.hasListUnsubscribe);
  const [aiCategory, setAiCategory] = useState(editing?.conditions.aiCategory ?? '');
  const [authVerdict, setAuthVerdict] = useState(editing?.conditions.authVerdict ?? '');
  const [hasAtt, setHasAtt] = useState(editing?.conditions.hasAttachment === undefined ? '' : editing.conditions.hasAttachment ? 'yes' : 'no'); // F4.1a：''=不限 / yes / no
  const [sizeKb, setSizeKb] = useState(editing?.conditions.sizeOverKb ? String(editing.conditions.sizeOverKb) : '');
  const [olderDays, setOlderDays] = useState(editing?.conditions.olderThanDays ? String(editing.conditions.olderThanDays) : '');
  const [stopProc, setStopProc] = useState(!!editing?.actions.stopProcessing);
  const [labelId, setLabelId] = useState(editing?.actions.addLabelId ?? '');
  const [folder, setFolder] = useState(editing?.actions.moveToFolder ?? '');
  const [star, setStar] = useState(!!editing?.actions.star);
  const [markRead, setMarkRead] = useState(!!editing?.actions.markRead);
  const [snooze, setSnooze] = useState(editing?.actions.snooze ?? '');
  const [followUpMin, setFollowUpMin] = useState(editing?.actions.followUpAfterMin ? String(editing.actions.followUpAfterMin) : '');
  const [fwd, setFwd] = useState(editing?.actions.forward ?? ''); // F4.1b：自動轉寄目標（限聯絡人/站內）
  const [err, setErr] = useState('');

  const setClause = (i: number, patch: Partial<RuleClause>) =>
    setClauses((cs) => cs.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));
  const addClause = () => setClauses((cs) => [...cs, { field: 'subject', op: 'contains', value: '' }]);
  const removeClause = (i: number) => setClauses((cs) => cs.filter((_, idx) => idx !== i));

  const save = async () => {
    setErr('');
    const validClauses = clauses.filter((c) => c.value.trim()).map((c) => ({ ...c, value: c.value.trim() }));
    const conditions: Record<string, unknown> = {};
    if (validClauses.length) conditions.clauses = validClauses;
    if (hasUnsub) conditions.hasListUnsubscribe = true;
    if (aiCategory) conditions.aiCategory = aiCategory;
    if (authVerdict) conditions.authVerdict = authVerdict;
    if (hasAtt) conditions.hasAttachment = hasAtt === 'yes';
    const sizeKbN = Math.floor(Number(sizeKb));
    if (Number.isFinite(sizeKbN) && sizeKbN > 0) conditions.sizeOverKb = sizeKbN;
    const olderN = Math.floor(Number(olderDays));
    if (Number.isFinite(olderN) && olderN > 0) conditions.olderThanDays = olderN;
    if (matchAny) conditions.match = 'any';
    const actions: Record<string, unknown> = {};
    if (labelId) actions.addLabelId = labelId;
    if (folder) actions.moveToFolder = folder;
    if (star) actions.star = true;
    if (markRead) actions.markRead = true;
    if (snooze) actions.snooze = snooze;
    const fuMin = Math.floor(Number(followUpMin));
    if (Number.isFinite(fuMin) && fuMin > 0) actions.followUpAfterMin = fuMin;
    const fwdTrim = fwd.trim();
    if (fwdTrim) actions.forward = fwdTrim;
    if (stopProc) actions.stopProcessing = true;
    const condCount = validClauses.length + (hasUnsub ? 1 : 0) + (aiCategory ? 1 : 0) + (authVerdict ? 1 : 0)
      + (hasAtt ? 1 : 0) + (sizeKbN > 0 ? 1 : 0) + (olderN > 0 ? 1 : 0);
    if (!name.trim() || condCount === 0 || !Object.keys(actions).length) {
      setErr('請填寫名稱、至少一個條件與一個動作');
      return;
    }
    try {
      if (editing) {
        await api(`/rules/${editing.id}`, { method: 'PATCH', body: { name: name.trim(), conditions, actions } });
      } else {
        await api('/rules', { body: { name: name.trim(), conditions, actions } });
      }
      onSaved();
    } catch {
      setErr(fwdTrim ? '儲存失敗（若設了轉寄，目標須為你的聯絡人或站內地址）' : '儲存失敗');
    }
  };

  return (
    <Modal title={editing ? '編輯規則' : '新增規則'} desc="信件落地時自動套用。" onClose={onClose} width={560}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div className="field">
          <label htmlFor="rule-name">規則名稱</label>
          <input id="rule-name" className="input" value={name} autoFocus onChange={(e) => setName(e.target.value)}
            placeholder="例：帳單自動歸檔" />
        </div>
        <div className="field">
          <label>
            條件
            {clauses.length > 1 && (
              <span style={{ fontWeight: 400, color: 'var(--text-muted)', marginLeft: 6 }}>
                （
                <button type="button" className="linklike" style={{ fontWeight: matchAny ? 400 : 700 }} onClick={() => setMatchAny(false)}>全部符合</button>
                {' / '}
                <button type="button" className="linklike" style={{ fontWeight: matchAny ? 700 : 400 }} onClick={() => setMatchAny(true)}>任一符合</button>
                ）
              </span>
            )}
          </label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {clauses.map((c, i) => (
              <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <Select<ClauseField> value={c.field} ariaLabel="條件欄位" style={{ flex: 'none' }}
                  options={(['from', 'subject', 'to', 'cc', 'recipient'] as ClauseField[]).map((f) => ({ value: f, label: FIELD_LABEL[f] }))}
                  onChange={(field) => {
                    // to 是多地址 JSON：只支援包含/不包含，其餘運算子永遠不中 → 切到 to 時重設
                    const op = field === 'to' && c.op !== 'contains' && c.op !== 'notContains' ? 'contains' : c.op;
                    setClause(i, { field, op });
                  }} />
                <Select<ClauseOp> value={c.op} ariaLabel="條件運算子" style={{ flex: 'none' }}
                  options={(c.field === 'to'
                    ? (['contains', 'notContains'] as ClauseOp[])
                    : (['contains', 'notContains', 'equals', 'startsWith', 'endsWith'] as ClauseOp[])
                  ).map((o) => ({ value: o, label: OP_LABEL[o] }))}
                  onChange={(op) => setClause(i, { op })} />
                <input className="input" style={{ flex: 1, minWidth: 0 }} value={c.value}
                  onChange={(e) => setClause(i, { value: e.target.value })} placeholder="關鍵字" />
                {clauses.length > 1 && (
                  <button type="button" className="iconbtn" aria-label="移除條件" data-tooltip="移除條件" onClick={() => removeClause(i)}>
                    <Icon name="x" size={14} />
                  </button>
                )}
              </div>
            ))}
            <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
              <button type="button" className="linklike" onClick={addClause}>+ 新增條件</button>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                <input type="checkbox" checked={hasUnsub} onChange={(e) => setHasUnsub(e.target.checked)} /> 標頭含 List-Unsubscribe（電子報）
              </label>
              <Select<string> value={aiCategory} ariaLabel="AI 分類" style={{ flex: 'none' }}
                options={[{ value: '', label: '（不依 AI 分類）' }, ...AI_CATEGORIES.map((c) => ({ value: c, label: `AI 分類：${c}` }))]}
                onChange={setAiCategory} />
              <Select<string> value={authVerdict} ariaLabel="寄件驗證" style={{ flex: 'none' }}
                options={[{ value: '', label: '（不依寄件驗證）' }, { value: 'fail', label: '寄件驗證未通過' }, { value: 'none', label: '寄件完全未驗證' }]}
                onChange={setAuthVerdict} />
              {/* F4.1a：附件 / 大小 / 信齡 */}
              <Select<string> value={hasAtt} ariaLabel="附件" style={{ flex: 'none' }}
                options={[{ value: '', label: '（不依附件）' }, { value: 'yes', label: '有附件' }, { value: 'no', label: '無附件' }]}
                onChange={setHasAtt} />
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                大於
                <input className="input" style={{ width: 70 }} inputMode="numeric" value={sizeKb} placeholder="—"
                  aria-label="大於 N KB" onChange={(e) => setSizeKb(e.target.value.replace(/\D/g, ''))} /> KB
              </label>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                收信超過
                <input className="input" style={{ width: 60 }} inputMode="numeric" value={olderDays} placeholder="—"
                  aria-label="收信超過 N 天" onChange={(e) => setOlderDays(e.target.value.replace(/\D/g, ''))} /> 天
              </label>
            </div>
          </div>
        </div>
        <div className="field">
          <label>動作</label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <Select<string> value={labelId} ariaLabel="加標籤" style={{ flex: 'none', maxWidth: 220 }}
              options={[{ value: '', label: '（不加標籤）' }, ...labels.map((l) => ({ value: l.id, label: `加標籤：${l.name}` }))]}
              onChange={setLabelId} />
            <Select<string> value={folder} ariaLabel="搬移到" style={{ flex: 'none' }}
              options={[
                { value: '', label: '（不搬移）' },
                { value: 'archive', label: '移至封存' },
                { value: 'spam', label: '移至垃圾信' },
                { value: 'trash', label: '移至垃圾桶' },
              ]}
              onChange={setFolder} />
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
              <input type="checkbox" checked={star} onChange={(e) => setStar(e.target.checked)} /> 加星標
            </label>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
              <input type="checkbox" checked={markRead} onChange={(e) => setMarkRead(e.target.checked)} /> 標為已讀
            </label>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13 }} data-tooltip="此規則命中後，後續較低優先序的規則不再套用">
              <input type="checkbox" checked={stopProc} onChange={(e) => setStopProc(e.target.checked)} /> 命中即停（不再套用後續規則）
            </label>
            <Select<string> value={snooze} ariaLabel="稍後處理" style={{ flex: 'none' }}
              options={[
                { value: '', label: '（不稍後處理）' },
                { value: 'evening', label: '稍後處理：今晚' },
                { value: 'tomorrow', label: '稍後處理：明早' },
                { value: 'weekend', label: '稍後處理：本週末' },
              ]}
              onChange={setSnooze} />
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
              跟進
              <input className="input" type="number" min="0" placeholder="分鐘後" value={followUpMin}
                onChange={(e) => setFollowUpMin(e.target.value)} style={{ width: 92 }} />
            </label>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13 }}
              data-tooltip="僅限你的聯絡人或站內地址；轉寄信不會再被轉寄。只對之後收到的新信生效（不回溯既有信）。">
              自動轉寄給
              <input className="input" type="email" placeholder="聯絡人或 @miseroda.com" value={fwd}
                onChange={(e) => setFwd(e.target.value)} style={{ width: 210 }} />
            </label>
          </div>
        </div>
        {err && <p style={{ color: 'var(--danger)', fontSize: 13, margin: 0 }}>{err}</p>}
        <button className="btn btn-primary" onClick={() => void save()}>{editing ? '儲存變更' : '建立規則'}</button>
      </div>
    </Modal>
  );
}
