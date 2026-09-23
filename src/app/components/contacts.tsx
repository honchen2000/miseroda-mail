// 聯絡人頁：通信對象聚合 + 手動新增 + 自訂名稱/電話/備註 + vCard 匯入匯出
import { useRef, useState, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useContacts, useContact360, useContactGroups, type ContactRow, type ContactGroup } from '../api/contacts';
import { SenderAvatar } from './mail';
import { EmptyState, Icon, Modal, timeAgo, fullTime, type IconName } from './ui';

export type { ContactRow } from '../api/contacts';
export { useContacts, useContactNames } from '../api/contacts';

function ContactCard({ ct, onCompose, onOpen360, pushToast }: {
  ct: ContactRow;
  onCompose: (email: string) => void;
  onOpen360: (email: string) => void;
  pushToast: (t: string) => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState(ct.customName);
  const [note, setNote] = useState(ct.note);
  const [phone, setPhone] = useState(ct.phone);
  const [company, setCompany] = useState(ct.company);
  const [title, setTitle] = useState(ct.title);
  const [birthday, setBirthday] = useState(ct.birthday);
  const [address, setAddress] = useState(ct.address);
  const dirty =
    name !== ct.customName || note !== ct.note || phone !== ct.phone ||
    company !== ct.company || title !== ct.title || birthday !== ct.birthday || address !== ct.address;

  const save = useMutation({
    mutationFn: () =>
      api(`/contacts/${encodeURIComponent(ct.email)}`, {
        method: 'PUT',
        body: { customName: name.trim(), note: note.trim(), phone: phone.trim(), company: company.trim(), title: title.trim(), birthday: birthday.trim(), address: address.trim() },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['contacts'] });
      pushToast('聯絡人已更新');
    },
  });
  const del = useMutation({
    mutationFn: () => api(`/contacts/${encodeURIComponent(ct.email)}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['contacts'] });
      // 有往來紀錄者刪除只是清掉自訂欄位（仍會以往來對象顯示）；手動聯絡人才是真的移除
      pushToast(ct.count > 0 ? '已清除自訂資料' : '已移除聯絡人');
    },
  });

  return (
    <div className="contact-card">
      <SenderAvatar name={name || ct.knownName || ct.email} addr={ct.email} size="lg" />
      <div className="contact-main">
        <input className="contact-name" value={name} placeholder={ct.knownName || ct.email.split('@')[0]}
          aria-label="自訂名稱" onChange={(e) => setName(e.target.value)} />
        <div className="contact-email">{ct.email}</div>
        <input className="contact-note" value={phone} placeholder="電話…" aria-label="電話"
          onChange={(e) => setPhone(e.target.value)} />
        <input className="contact-note" value={company} placeholder="公司…" aria-label="公司"
          onChange={(e) => setCompany(e.target.value)} />
        <input className="contact-note" value={title} placeholder="職稱…" aria-label="職稱"
          onChange={(e) => setTitle(e.target.value)} />
        <input className="contact-note" value={birthday} placeholder="生日 YYYY-MM-DD…" aria-label="生日"
          onChange={(e) => setBirthday(e.target.value)} />
        <input className="contact-note" value={address} placeholder="地址…" aria-label="地址"
          onChange={(e) => setAddress(e.target.value)} />
        <input className="contact-note" value={note} placeholder="備註…" aria-label="備註"
          onChange={(e) => setNote(e.target.value)} />
      </div>
      <div className="contact-side">
        <div className="contact-stats">{ct.count > 0 ? `${ct.count} 封 · ${timeAgo(ct.lastUsed)}` : '手動新增'}</div>
        <div style={{ display: 'flex', gap: 4 }}>
          <button className="iconbtn" data-tooltip="查看往來" aria-label="查看往來" onClick={() => onOpen360(ct.email)}>
            <Icon name="mail" size={15} />
          </button>
          <button className="iconbtn" data-tooltip="寫信給他" aria-label="寫信" onClick={() => onCompose(ct.email)}>
            <Icon name="pen" size={15} />
          </button>
          <button className="iconbtn" data-tooltip="移除聯絡人" aria-label="移除聯絡人" disabled={del.isPending} onClick={() => del.mutate()}>
            <Icon name="trash" size={15} />
          </button>
          {dirty && (
            <button className="btn btn-primary btn-sm" disabled={save.isPending} onClick={() => save.mutate()}>儲存</button>
          )}
        </div>
      </div>
    </div>
  );
}

/** 寄件驗證 → 信任標籤（鏡像 mail.tsx senderTrust） */
function trustLabel(v: { spf?: string; dkim?: string; dmarc?: string }): string {
  if (v.dmarc === 'pass') return '✓ 已驗證寄件者';
  if (v.dmarc === 'fail') return '⚠ 驗證未通過';
  if (v.spf === 'pass' && v.dkim === 'pass') return '✓ 已驗證寄件者';
  if ((v.spf === 'fail' || v.spf === 'softfail') && v.dkim === 'fail') return '⚠ 驗證未通過';
  return '部分驗證';
}

function C360Section({ title, icon, empty, emptyText, children }: {
  title: string; icon: IconName; empty: boolean; emptyText: string; children: ReactNode;
}) {
  return (
    <div className="c360-sec">
      <div className="c360-sec-head"><Icon name={icon} size={14} /> {title}</div>
      {empty ? <div className="c360-empty">{emptyText}</div> : <div className="c360-list">{children}</div>}
    </div>
  );
}

/** 聯絡人 360 抽屜：最近往來 × 未來會議 × 待回覆 × 寄件信任（F2.5，純讀） */
export function Contact360Modal({ email, onClose, onCompose }: {
  email: string;
  onClose: () => void;
  onCompose: (email: string) => void;
}) {
  const q = useContact360(email);
  const d = q.data;
  const trust = d?.authVerdict ? trustLabel(d.authVerdict) : null;
  return (
    <Modal title="聯絡人往來" onClose={onClose} width={560}>
      {q.isLoading && <div className="c360-empty">載入中…</div>}
      {q.isError && <div className="c360-empty">載入失敗，請再試一次</div>}
      {d && (
        <div className="c360">
          <div className="c360-head">
            <SenderAvatar name={d.customName || d.email} addr={d.email} size="lg" />
            <div className="c360-id">
              <div className="c360-name">{d.customName || d.email.split('@')[0]}</div>
              <div className="contact-email">{d.email}</div>
              <div className="c360-stats">
                {d.totalMessages > 0 ? `${d.totalMessages} 封往來` : '尚無往來'}
                {d.lastContactedAt ? ` · 最近 ${timeAgo(d.lastContactedAt)}` : ''}
                {trust ? ` · ${trust}` : ''}
              </div>
            </div>
            <button className="btn btn-primary btn-sm" onClick={() => { onCompose(d.email); onClose(); }}>
              <Icon name="pen" size={14} /> 寫信
            </button>
          </div>
          {d.note && <div className="c360-note">{d.note}</div>}

          <C360Section title="待回覆" icon="flag" empty={!d.followUps.length} emptyText="沒有待處理的跟進">
            {d.followUps.map((f) => (
              <div key={f.id} className="c360-row">
                <span className="c360-row-main">{f.subject || '(無主旨)'}</span>
                <span className="c360-row-meta">{f.awaitReply ? '等回覆 · ' : ''}{fullTime(f.dueAt)}</span>
              </div>
            ))}
          </C360Section>

          <C360Section title="近期會議" icon="calendar" empty={!d.events.length} emptyText="沒有與他相關的近期會議">
            {d.events.map((ev) => (
              <div key={ev.id} className="c360-row">
                <span className="c360-row-main">{ev.summary || '(無標題)'}</span>
                <span className="c360-row-meta">{ev.floating || ev.allDay ? ev.startText : fullTime(ev.startMs)}{ev.location ? ` · ${ev.location}` : ''}</span>
              </div>
            ))}
          </C360Section>

          <C360Section title="最近往來" icon="mail" empty={!d.messages.length} emptyText="還沒有往來信件">
            {d.messages.map((m) => (
              <div key={m.id} className="c360-row">
                <span className={`c360-dir ${m.direction === 'outbound' ? 'out' : 'in'}`}>{m.direction === 'outbound' ? '寄' : '收'}</span>
                <span className="c360-row-main">{m.subject || '(無主旨)'}</span>
                <span className="c360-row-meta">{timeAgo(m.receivedAt)}</span>
              </div>
            ))}
          </C360Section>
        </div>
      )}
    </Modal>
  );
}

/** 新增聯絡人 Modal */
function AddContactModal({ onClose, pushToast }: { onClose: () => void; pushToast: (t: string) => void }) {
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const emailOk = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim());

  const save = useMutation({
    mutationFn: () =>
      api(`/contacts/${encodeURIComponent(email.trim().toLowerCase())}`, {
        method: 'PUT',
        body: { customName: name.trim(), note: note.trim(), phone: phone.trim() },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['contacts'] });
      pushToast('已新增聯絡人 👤');
      onClose();
    },
    onError: () => setErr('新增失敗，請再試一次'),
  });

  return (
    <Modal title="新增聯絡人" onClose={onClose} width={460}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="field"><label>Email</label><input className="input" value={email} autoFocus placeholder="someone@example.com" onChange={(e) => setEmail(e.target.value)} /></div>
        <div className="field"><label>名稱（選填）</label><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div className="field"><label>電話（選填）</label><input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} /></div>
        <div className="field"><label>備註（選填）</label><input className="input" value={note} onChange={(e) => setNote(e.target.value)} /></div>
        {err && <p style={{ color: 'var(--danger)', fontSize: 13, margin: 0 }}>{err}</p>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn btn-ghost" onClick={onClose}>取消</button>
          <button className="btn btn-primary" disabled={!emailOk || save.isPending} onClick={() => save.mutate()}>新增</button>
        </div>
      </div>
    </Modal>
  );
}

/** 聯絡人群組（F4.3b）：建立群組、管理成員、一鍵寫信給整個群組。 */
function GroupsSection({ pushToast, onCompose }: { pushToast: (t: string) => void; onCompose: (email: string) => void }) {
  const qc = useQueryClient();
  const groups = useContactGroups();
  const [newName, setNewName] = useState('');
  const [memberInput, setMemberInput] = useState<Record<string, string>>({});
  const inval = () => void qc.invalidateQueries({ queryKey: ['contact-groups'] });
  const create = useMutation({
    mutationFn: (name: string) => api<{ id: string }>('/contact-groups', { method: 'POST', body: { name } }),
    onSuccess: () => { inval(); pushToast('已建立群組 👪'); },
  });
  const patch = useMutation({
    mutationFn: (v: { id: string; body: { name?: string; emails?: string[] } }) => api(`/contact-groups/${v.id}`, { method: 'PATCH', body: v.body }),
    onSuccess: inval,
  });
  const del = useMutation({
    mutationFn: (id: string) => api(`/contact-groups/${id}`, { method: 'DELETE' }),
    onSuccess: () => { inval(); pushToast('已刪除群組'); },
  });
  const list = groups.data?.groups ?? [];
  const addMember = (g: ContactGroup, raw: string) => {
    const e = raw.trim().toLowerCase();
    setMemberInput((m) => ({ ...m, [g.id]: '' }));
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) || g.emails.includes(e)) return;
    patch.mutate({ id: g.id, body: { emails: [...g.emails, e] } });
  };

  return (
    <section style={{ marginBottom: 24 }}>
      <h2 className="page-title" style={{ fontSize: 18, marginBottom: 4 }}>群組</h2>
      <p className="page-sub" style={{ marginBottom: 10 }}>把常一起寄信的人組成群組；撰寫時在收件人欄打群組名即可一鍵展開全部成員。</p>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, maxWidth: 420 }}>
        <input className="input" placeholder="新群組名稱（例：家人）" value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && newName.trim()) { create.mutate(newName.trim()); setNewName(''); } }} />
        <button className="btn btn-primary btn-sm" disabled={!newName.trim() || create.isPending}
          onClick={() => { create.mutate(newName.trim()); setNewName(''); }}>新增群組</button>
      </div>
      <div className="contact-grid">
        {list.map((g) => (
          <div key={g.id} className="contact-card" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <strong>👪 {g.name}　<span style={{ color: 'var(--muted)', fontWeight: 400, fontSize: 13 }}>{g.emails.length} 人</span></strong>
              <div style={{ display: 'flex', gap: 4 }}>
                <button className="iconbtn" data-tooltip="寫信給整個群組" aria-label="寫信給群組" disabled={!g.emails.length}
                  onClick={() => onCompose(g.emails.join(', '))}><Icon name="pen" size={15} /></button>
                <button className="iconbtn" data-tooltip="刪除群組" aria-label="刪除群組" disabled={del.isPending}
                  onClick={() => del.mutate(g.id)}><Icon name="trash" size={15} /></button>
              </div>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {g.emails.map((e) => (
                <span key={e} className="addr-chip">{e}
                  <button type="button" aria-label={`移除 ${e}`}
                    onClick={() => patch.mutate({ id: g.id, body: { emails: g.emails.filter((x) => x !== e) } })}><Icon name="x" size={11} /></button>
                </span>
              ))}
            </div>
            <input className="input" placeholder="加入成員 email，按 Enter…" value={memberInput[g.id] ?? ''}
              onChange={(e) => setMemberInput((m) => ({ ...m, [g.id]: e.target.value }))}
              onKeyDown={(e) => { if (e.key === 'Enter') addMember(g, memberInput[g.id] ?? ''); }} />
          </div>
        ))}
      </div>
    </section>
  );
}

export function ContactsPage({ onCompose, pushToast, onMenu }: {
  onCompose: (email: string) => void;
  pushToast: (t: string) => void;
  onMenu: () => void;
}) {
  const qc = useQueryClient();
  const contacts = useContacts();
  const [q, setQ] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [profile360, setProfile360] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const list = (contacts.data?.contacts ?? []).filter(
    (ct) =>
      !q ||
      ct.email.includes(q.toLowerCase()) ||
      ct.customName.toLowerCase().includes(q.toLowerCase()) ||
      ct.knownName.toLowerCase().includes(q.toLowerCase()) ||
      ct.phone.includes(q),
  );

  const importVcf = useMutation({
    mutationFn: (vcf: string) => api<{ ok: boolean; imported: number }>('/contacts/import', { method: 'POST', body: { vcf } }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['contacts'] });
      pushToast(`已匯入 ${r.imported} 位聯絡人 📇`);
    },
    onError: () => pushToast('匯入失敗，請確認檔案格式'),
  });

  const onPickFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) return pushToast('檔案過大（上限 5MB）');
    importVcf.mutate(await file.text());
  };

  return (
    <main className="readpane">
      <div className="content-page">
        <div className="mobile-topbar">
          <button className="iconbtn mobile-only" aria-label="開啟選單" onClick={onMenu}><Icon name="menu" /></button>
          <span className="t">聯絡人</span>
        </div>
        <h1 className="page-title">聯絡人</h1>
        <p className="page-sub">從通信紀錄自動整理，也可手動新增或以 vCard 匯入。自訂名稱會取代寄件人原始名稱顯示。</p>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 18 }}>
          <div className="searchbar" style={{ maxWidth: 360, flex: 1, minWidth: 200 }}>
            <Icon name="search" size={15} />
            <input className="input" placeholder="搜尋聯絡人…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <button className="btn btn-primary btn-sm" onClick={() => setAddOpen(true)}><Icon name="user" size={14} /> 新增</button>
          <button className="btn btn-secondary btn-sm" disabled={importVcf.isPending} onClick={() => fileRef.current?.click()}>
            <Icon name="download" size={14} /> 匯入 vCard
          </button>
          <a className="btn btn-secondary btn-sm" href="/api/v1/contacts/export.vcf" style={{ textDecoration: 'none' }}>
            <Icon name="download" size={14} /> 匯出 vCard
          </a>
          <input ref={fileRef} type="file" accept=".vcf,text/vcard" style={{ display: 'none' }}
            onChange={(e) => { void onPickFile(e.target.files?.[0]); e.target.value = ''; }} />
        </div>
        <GroupsSection pushToast={pushToast} onCompose={onCompose} />
        {!list.length && !contacts.isLoading && (
          <EmptyState pose="search" title={q ? '找不到聯絡人' : '還沒有聯絡人'} sub="寄出或收到第一封信後對象會自動出現，或按「新增」手動加入。" />
        )}
        <div className="contact-grid">
          {list.map((ct) => (
            <ContactCard key={ct.email} ct={ct} onCompose={onCompose} onOpen360={setProfile360} pushToast={pushToast} />
          ))}
        </div>
      </div>
      {addOpen && <AddContactModal onClose={() => setAddOpen(false)} pushToast={pushToast} />}
      {profile360 && <Contact360Modal email={profile360} onClose={() => setProfile360(null)} onCompose={onCompose} />}
    </main>
  );
}
