// 管理後台 —— 使用者 / 邀請 / 稽核日誌 + 用量統計（移植 admin.jsx）
import { useLayoutEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api/client';
import { SenderAvatar } from './mail';
import { EmptyState, Icon, Modal, timeAgo } from './ui';
import { Select } from './inputs';
import { confirmDialog } from './dialog';

/** tab 列含滑動底線（動畫 17） */
function Tabs<T extends string>({ tabs, active, onChange }: {
  tabs: readonly (readonly [T, string])[];
  active: T;
  onChange: (t: T) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [bar, setBar] = useState({ left: 0, width: 0 });
  useLayoutEffect(() => {
    const el = ref.current?.querySelector<HTMLElement>('.tab.active');
    if (el) setBar({ left: el.offsetLeft, width: el.offsetWidth });
  }, [active, tabs]);
  return (
    <div className="tabs" role="tablist" ref={ref}>
      {tabs.map(([key, name]) => (
        <button key={key} className={`tab ${active === key ? 'active' : ''}`} role="tab" aria-selected={active === key}
          onClick={() => onChange(key)}>{name}</button>
      ))}
      <span className="tab-underline" style={{ left: bar.left, width: bar.width }}></span>
    </div>
  );
}

interface AdminAlias {
  id: string;
  address: string;
  name: string | null;
  user_id: string;
  owner_email: string;
  created_at: number;
}

interface AdminUser {
  id: string;
  email: string;
  display_name: string;
  role: 'admin' | 'user';
  status: 'active' | 'disabled';
  last_login_at: number | null;
  passkeys: number;
  synced_passkeys: number;
  totp: number | null;
}

/** 由救援連結綁定的 passkey（重設 TOTP 前要 admin 逐一承認）。name 已由伺服器壓成單行。 */
interface RecoveryPasskey {
  id: string;
  name: string | null;
  createdAt: number;
}

interface AdminInvite {
  id: string;
  email: string;
  role: string;
  created_at: number;
  expires_at: number;
}

interface AuditEntry {
  id: string;
  user_email: string | null;
  action: string;
  target_id: string | null;
  ip: string | null;
  meta: string | null;
  created_at: number;
}

interface ErrorEntry {
  id: string;
  scope: string;
  message: string;
  meta: string | null;
  created_at: number;
}

interface Stats {
  users: { total: number; active: number };
  messages: { total: number };
  sentThisMonth: number;
  failedSends: number;
  monthlyQuota: number;
  storageBytes: number;
}

function fmtGB(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

export function AdminPage({ pushToast, onMenu }: { pushToast: (t: string) => void; onMenu: () => void }) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<'users' | 'invites' | 'aliases' | 'audit' | 'system'>('users');
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [invEmail, setInvEmail] = useState('');
  const [invRole, setInvRole] = useState<'user' | 'admin'>('user');
  const [createdCode, setCreatedCode] = useState<string | null>(null);

  const stats = useQuery({ queryKey: ['admin-stats'], queryFn: () => api<Stats>('/admin/stats') });
  const users = useQuery({ queryKey: ['admin-users'], queryFn: () => api<{ users: AdminUser[] }>('/admin/users') });
  const invites = useQuery({ queryKey: ['admin-invites'], queryFn: () => api<{ invites: AdminInvite[] }>('/admin/invites') });
  const auditLog = useQuery({
    queryKey: ['admin-audit'],
    queryFn: () => api<{ entries: AuditEntry[] }>('/admin/audit-log?limit=100'),
    enabled: tab === 'audit',
  });
  const errorLog = useQuery({
    queryKey: ['admin-errors'],
    queryFn: () => api<{ recent: ErrorEntry[]; byScope: { scope: string; n: number; last_at: number }[] }>('/admin/errors?limit=100'),
    enabled: tab === 'system',
  });

  const createInvite = useMutation({
    mutationFn: () => api<{ code: string }>('/admin/invites', { body: { email: invEmail.trim().toLowerCase(), role: invRole } }),
    onSuccess: (res) => {
      setCreatedCode(res.code);
      void qc.invalidateQueries({ queryKey: ['admin-invites'] });
      void qc.invalidateQueries({ queryKey: ['admin-users'] });
    },
    onError: () => pushToast('建立邀請失敗（已有帳號或邀請？）'),
  });

  const [aliasUser, setAliasUser] = useState('');
  const [aliasPrefix, setAliasPrefix] = useState('');
  const aliases = useQuery({
    queryKey: ['admin-aliases'],
    queryFn: () => api<{ aliases: AdminAlias[] }>('/admin/aliases'),
    enabled: tab === 'aliases',
  });
  const createAlias = useMutation({
    mutationFn: (v: { userId: string; address: string }) => api<{ id: string }>('/admin/aliases', { body: v }),
    onSuccess: () => {
      setAliasPrefix('');
      pushToast('別名已新增 🏷️');
      void qc.invalidateQueries({ queryKey: ['admin-aliases'] });
    },
    // 連線層失敗由全域處理器統一提示（「連線逾時…」）；只有伺服器真的回錯才顯示領域訊息，避免自相矛盾。
    onError: (e) => { if (e instanceof ApiError) pushToast('新增失敗：別名重複、為保留字、或不在網域內'); },
  });
  const deleteAlias = useMutation({
    mutationFn: (id: string) => api(`/admin/aliases/${id}`, { method: 'DELETE' }),
    onError: () => pushToast('刪除別名失敗，請再試一次'),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['admin-aliases'] }),
  });

  const revokeInvite = useMutation({
    mutationFn: (id: string) => api(`/admin/invites/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-invites'] });
      pushToast('邀請已撤銷');
    },
  });

  const toggleUser = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'active' | 'disabled' }) =>
      api(`/admin/users/${id}`, { method: 'PATCH', body: { status } }),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['admin-users'] }),
  });

  /* 核發 passkey 救援連結（使用者失去所有 passkey 時用） */
  const [recoveryLink, setRecoveryLink] = useState<{ email: string; url: string; expiresAt: number } | null>(null);
  const issueRecovery = useMutation({
    mutationFn: (id: string) =>
      api<{ email: string; url: string; expiresAt: number }>(`/admin/users/${id}/recovery`, { method: 'POST', body: {} }),
    onSuccess: (r) => setRecoveryLink(r),
    onError: () => pushToast('核發救援連結失敗'),
  });

  /* 重設 TOTP（使用者連 TOTP/備援碼都遺失時的無損解鎖）
     伺服器對「有救援連結綁定的 passkey」的帳號會回 409 + 清單：TOTP 一拆，那些 passkey 就能免 TOTP
     登入並自行重設 TOTP＝完整接管，而伺服器分不出是本人綁的還是攔截連結者綁的 → 由 admin 逐一承認。 */
  const [resetAck, setResetAck] = useState<{ user: AdminUser; passkeys: RecoveryPasskey[] } | null>(null);
  const resetTotp = useMutation({
    mutationFn: ({ id, acknowledge }: { id: string; acknowledge?: string[] }) =>
      api<{ email: string }>(`/admin/users/${id}/totp/reset`, {
        method: 'POST',
        body: acknowledge ? { acknowledgeRecoveryPasskeys: acknowledge } : {},
      }),
    onSuccess: (r) => {
      setResetAck(null);
      pushToast(`已重設 ${r.email} 的 TOTP，對方用 passkey 登入後會被要求重新設定`);
    },
    onError: (e, vars) => {
      const user = (users.data?.users ?? []).find((u) => u.id === vars.id);
      if (e instanceof ApiError && e.status === 409 && e.code === 'recovery_passkeys_unconfirmed' && user) {
        setResetAck({ user, passkeys: (e.payload as { passkeys?: RecoveryPasskey[] } | null)?.passkeys ?? [] });
        return;
      }
      pushToast('重設 TOTP 失敗');
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: ['admin-users'] }),
  });

  /* 編輯帳號（email 前綴 + 顯示名稱） */
  const [editUser, setEditUser] = useState<AdminUser | null>(null);
  const [editLocal, setEditLocal] = useState('');
  const [editName, setEditName] = useState('');
  const openEdit = (u: AdminUser) => {
    setEditUser(u);
    setEditLocal(u.email.split('@')[0] ?? '');
    setEditName(u.display_name);
  };
  const saveEdit = useMutation({
    mutationFn: () =>
      api(`/admin/users/${editUser!.id}`, {
        method: 'PATCH',
        body: { emailLocal: editLocal.trim().toLowerCase(), displayName: editName.trim() },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-users'] });
      pushToast('帳號已更新 ✅');
      setEditUser(null);
    },
    onError: (err) => {
      const code = (err as Error).message;
      pushToast(
        code.includes('email_taken') ? '這個前綴已被使用'
        : code.includes('reserved') ? '這是系統保留地址，換一個吧'
        : code.includes('invite_pending') ? '這個地址有待使用的邀請'
        : code.includes('bad_email_local') ? '前綴格式不正確（小寫英數，可含 . _ -）'
        : '儲存失敗',
      );
    },
  });

  /* 刪除帳號（停用中才可刪；輸入完整 email 二次確認） */
  const [deleteUser, setDeleteUser] = useState<AdminUser | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const usage = useQuery({
    queryKey: ['admin-user-usage', deleteUser?.id],
    queryFn: () => api<{ messages: number; attachments: number; attachmentBytes: number }>(`/admin/users/${deleteUser!.id}/usage`),
    enabled: !!deleteUser,
  });
  const doDelete = useMutation({
    mutationFn: () => api(`/admin/users/${deleteUser!.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-users'] });
      void qc.invalidateQueries({ queryKey: ['admin-stats'] });
      pushToast(`已永久刪除 ${deleteUser?.email} 🗑️`);
      setDeleteUser(null);
      setDeleteConfirm('');
    },
    onError: () => pushToast('刪除失敗（帳號需先停用）'),
  });

  const closeModal = () => {
    setShowInviteModal(false);
    setCreatedCode(null);
    setInvEmail('');
    setInvRole('user');
  };

  const copyInviteLink = async (code: string) => {
    await navigator.clipboard.writeText(`${location.origin}/#invite=${encodeURIComponent(code)}`);
    pushToast('邀請連結已複製 📋');
  };

  const quotaPct = stats.data ? Math.round((stats.data.sentThisMonth / stats.data.monthlyQuota) * 100) : 0;

  return (
    <main className="readpane">
      <div className="content-page">
        <div className="mobile-topbar">
          <button className="iconbtn mobile-only" aria-label="開啟選單" onClick={onMenu}><Icon name="menu" /></button>
          <span className="t">管理後台</span>
        </div>
        <h1 className="page-title">管理後台</h1>
        <p className="page-sub">miseroda.com 網域的使用者、邀請與稽核紀錄。租戶隔離：admin 也無法讀取他人信件。</p>

        <div className="stat-grid">
          <div className="stat-card">
            <div className="k">使用者</div>
            <div className="v">{stats.data?.users.active ?? '—'}<span style={{ fontSize: 14, color: 'var(--text-muted)' }}> / {stats.data?.users.total ?? '—'}</span></div>
            <div className="s">啟用中 / 全部</div>
          </div>
          <div className="stat-card">
            <div className="k">本月寄送</div>
            <div className="v">{stats.data?.sentThisMonth?.toLocaleString() ?? '—'}</div>
            <div className="s">
              免費額度 {stats.data?.monthlyQuota.toLocaleString()} 封 / 月（{quotaPct}%）
              {(stats.data?.failedSends ?? 0) > 0 && (
                <span style={{ color: 'var(--danger)' }}> · ⚠ {stats.data!.failedSends} 封失敗</span>
              )}
            </div>
          </div>
          <div className="stat-card">
            <div className="k">儲存用量</div>
            <div className="v" style={{ fontSize: 22 }}>{stats.data ? fmtGB(stats.data.storageBytes) : '—'}</div>
            <div className="s">.eml + 附件（R2 egress $0）</div>
          </div>
          <div className="stat-card">
            <div className="k">信件總數</div>
            <div className="v">{stats.data?.messages.total?.toLocaleString() ?? '—'}</div>
            <div className="s">D1 中繼資料 · 上限 10 GB</div>
          </div>
        </div>

        <Tabs tabs={[['users', '使用者'], ['invites', '邀請'], ['aliases', '別名'], ['audit', '稽核日誌'], ['system', '系統']] as const}
          active={tab} onChange={setTab} />

        {tab === 'users' && (
          <section className="settings-section" style={{ padding: '8px 12px' }}>
            <table className="table">
              <thead>
                <tr><th>使用者</th><th>角色</th><th>狀態</th><th>Passkeys</th><th>TOTP</th><th>最近登入</th><th></th></tr>
              </thead>
              <tbody>
                {(users.data?.users ?? []).map((u) => (
                  <tr key={u.id}>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <SenderAvatar name={u.display_name} addr={u.email} size="sm" />
                        <div>
                          <div style={{ fontWeight: 600 }}>{u.display_name}</div>
                          <div className="mono">{u.email}</div>
                        </div>
                      </div>
                    </td>
                    <td>{u.role === 'admin' ? <span className="badge green">admin</span> : <span style={{ color: 'var(--text-secondary)' }}>user</span>}</td>
                    <td>{u.status === 'active' ? <span className="badge green">啟用</span> : <span className="badge red">停用</span>}</td>
                    <td className="mono">
                      {u.passkeys}
                      {u.passkeys > 0 && u.synced_passkeys === 0 && (
                        <span data-tooltip="全部都是裝置綁定 passkey（不會同步）；裝置遺失就會被鎖死，建議請對方加一把可同步的手機 passkey"
                          style={{ marginLeft: 5, color: 'var(--warning)', cursor: 'help' }}>⚠</span>
                      )}
                      {u.synced_passkeys > 0 && (
                        <span data-tooltip={`其中 ${u.synced_passkeys} 把可跨裝置同步（較不易鎖死）`}
                          style={{ marginLeft: 5, color: 'var(--success)', cursor: 'help' }}>☁</span>
                      )}
                    </td>
                    <td>{u.totp ? <span style={{ color: 'var(--success)', display: 'inline-flex' }}><Icon name="check" size={15} /></span> : <span style={{ color: 'var(--text-muted)' }}>—</span>}</td>
                    <td className="mono">{u.last_login_at ? timeAgo(u.last_login_at) : '—'}</td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button className="btn btn-ghost btn-sm" onClick={() => openEdit(u)}>編輯</button>
                      {u.status === 'active' && !!u.totp && (
                        <button className="btn btn-ghost btn-sm" data-tooltip="核發重新綁定 passkey 的救援連結"
                          disabled={issueRecovery.isPending}
                          onClick={() => issueRecovery.mutate(u.id)}>救援</button>
                      )}
                      {u.status === 'active' && !!u.totp && u.role !== 'admin' && (
                        <button className="btn btn-ghost btn-sm" data-tooltip="清掉此人 TOTP/備援碼/信任裝置，讓他用 passkey 登入後重新設定"
                          disabled={resetTotp.isPending}
                          onClick={async () => {
                            if (await confirmDialog({
                              title: `重設 ${u.email} 的兩步驟驗證？`,
                              body: '會清除他的 TOTP、備援碼、信任裝置並登出所有 session。對方下次用 passkey 登入時會被要求重新設定 TOTP。用於他連驗證器與備援碼都遺失時。',
                              confirmText: '重設 2FA',
                              danger: true,
                            })) resetTotp.mutate({ id: u.id });
                          }}>重設 2FA</button>
                      )}
                      {u.role !== 'admin' && (
                        <button className="btn btn-ghost btn-sm"
                          onClick={() => toggleUser.mutate({ id: u.id, status: u.status === 'active' ? 'disabled' : 'active' })}>
                          {u.status === 'active' ? '停用' : '重新啟用'}
                        </button>
                      )}
                      {u.status === 'disabled' && (
                        <button className="btn btn-ghost btn-sm" style={{ color: 'var(--danger)' }}
                          onClick={() => { setDeleteUser(u); setDeleteConfirm(''); }}>
                          刪除
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        {tab === 'invites' && (
          <section className="settings-section">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
              <div>
                <h3 style={{ margin: 0 }}>待使用的邀請</h3>
                <p className="desc" style={{ margin: '2px 0 0' }}>邀請碼以雜湊存放，7 天內有效，每組僅能使用一次。</p>
              </div>
              <button className="btn btn-primary btn-sm" onClick={() => setShowInviteModal(true)}>建立邀請</button>
            </div>
            {(invites.data?.invites ?? []).length === 0
              ? <EmptyState pose="happy" title="沒有待使用的邀請" sub="按「建立邀請」為新成員開信箱。" />
              : (
                <table className="table">
                  <thead><tr><th>Email</th><th>角色</th><th>有效期限</th><th></th></tr></thead>
                  <tbody>
                    {(invites.data?.invites ?? []).map((inv) => (
                      <tr key={inv.id}>
                        <td className="mono">{inv.email}</td>
                        <td>{inv.role}</td>
                        <td className="mono">{Math.max(1, Math.ceil((inv.expires_at - Date.now()) / 86400000))} 天後</td>
                        <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                          <button className="btn btn-ghost btn-sm" style={{ color: 'var(--danger)' }}
                            onClick={() => revokeInvite.mutate(inv.id)}>撤銷</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
          </section>
        )}

        {tab === 'aliases' && (() => {
          const domain = users.data?.users[0]?.email.split('@')[1] ?? 'miseroda.com';
          return (
            <section className="settings-section">
              <div style={{ marginBottom: 14 }}>
                <h3 style={{ margin: 0 }}>網域別名</h3>
                <p className="desc" style={{ margin: '2px 0 0' }}>
                  把 prefix@{domain} 指派給使用者：對方可收到寄往此別名的信，也能用它當寄件身分。
                </p>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14 }}>
                <Select<string> value={aliasUser} onChange={setAliasUser} ariaLabel="指派給使用者" style={{ maxWidth: 240 }}
                  options={[
                    { value: '', label: '指派給…' },
                    ...(users.data?.users ?? []).filter((u) => u.status === 'active').map((u) => ({ value: u.id, label: u.email })),
                  ]} />
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                  <input className="input" style={{ width: 150 }} placeholder="prefix" value={aliasPrefix}
                    onChange={(e) => setAliasPrefix(e.target.value.replace(/[^a-zA-Z0-9._-]/g, '').toLowerCase())} />
                  <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>@{domain}</span>
                </span>
                <button className="btn btn-primary btn-sm" disabled={!aliasUser || !aliasPrefix || createAlias.isPending}
                  onClick={() => createAlias.mutate({ userId: aliasUser, address: `${aliasPrefix}@${domain}` })}>新增別名</button>
              </div>
              {(aliases.data?.aliases ?? []).length === 0 ? (
                <EmptyState pose="happy" title="尚無別名" sub="指派一個 prefix@網域 給使用者。" />
              ) : (
                <table className="table">
                  <thead><tr><th>別名</th><th>擁有者</th><th></th></tr></thead>
                  <tbody>
                    {(aliases.data?.aliases ?? []).map((a) => (
                      <tr key={a.id}>
                        <td className="mono">{a.address}</td>
                        <td className="mono">{a.owner_email}</td>
                        <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                          <button className="btn btn-ghost btn-sm" style={{ color: 'var(--danger)' }}
                            onClick={() => deleteAlias.mutate(a.id)}>刪除</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          );
        })()}

        {tab === 'audit' && (
          <section className="settings-section" style={{ padding: '8px 12px' }}>
            <table className="table">
              <thead><tr><th>時間</th><th>使用者</th><th>動作</th><th>細節</th><th>IP</th></tr></thead>
              <tbody>
                {(auditLog.data?.entries ?? []).map((a) => (
                  <tr key={a.id}>
                    <td className="mono" style={{ whiteSpace: 'nowrap' }}>{timeAgo(a.created_at)}</td>
                    <td className="mono">{a.user_email ?? 'system'}</td>
                    <td><span className="chip" style={{ background: 'var(--bg-elevated)', color: 'var(--info)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>{a.action}</span></td>
                    <td style={{ color: 'var(--text-secondary)', maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {a.meta ?? a.target_id ?? '—'}
                    </td>
                    <td className="mono">{a.ip ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        {tab === 'system' && (
          <section className="settings-section" style={{ padding: '8px 12px' }}>
            <h3 style={{ marginTop: 0 }}>近 7 天錯誤分類</h3>
            {(errorLog.data?.byScope ?? []).length === 0 && <p className="hint">近期沒有記錄到錯誤 🎉</p>}
            {(errorLog.data?.byScope ?? []).length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
                {(errorLog.data?.byScope ?? []).map((s2) => (
                  <span key={s2.scope} className="chip" style={{ background: 'var(--bg-elevated)', color: s2.n > 5 ? 'var(--danger)' : 'var(--warning)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                    {s2.scope} · {s2.n}
                  </span>
                ))}
              </div>
            )}
            <h3>最近錯誤</h3>
            <table className="table">
              <thead><tr><th>時間</th><th>來源</th><th>訊息</th></tr></thead>
              <tbody>
                {(errorLog.data?.recent ?? []).map((e) => (
                  <tr key={e.id}>
                    <td className="mono" style={{ whiteSpace: 'nowrap' }}>{timeAgo(e.created_at)}</td>
                    <td><span className="chip" style={{ background: 'var(--bg-elevated)', color: 'var(--danger)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>{e.scope}</span></td>
                    <td style={{ color: 'var(--text-secondary)', maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'var(--font-mono)', fontSize: 11 }} title={e.message}>
                      {e.message}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        {showInviteModal && (
          <Modal title={createdCode ? '邀請已建立' : '建立邀請'}
            desc={createdCode ? '把邀請碼或連結傳給新成員。基於安全，關閉後不會再顯示完整碼。' : '為新成員建立 @miseroda.com 信箱邀請。'}
            onClose={closeModal}>
            {!createdCode ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div className="field">
                  <label htmlFor="inv-email">Email 地址</label>
                  <input id="inv-email" className="input" placeholder="newuser@miseroda.com" value={invEmail}
                    onChange={(e) => {
                      // 按 @ 自動補上網域（信箱一律 @miseroda.com）
                      const v = e.target.value;
                      setInvEmail(/^[^@]+@$/.test(v) ? `${v}miseroda.com` : v);
                    }}
                    spellCheck={false} autoFocus />
                </div>
                <div className="field">
                  <label>角色</label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {(['user', 'admin'] as const).map((r) => (
                      <button key={r} className={`btn btn-sm ${invRole === r ? 'btn-primary' : 'btn-secondary'}`}
                        onClick={() => setInvRole(r)}>{r}</button>
                    ))}
                  </div>
                </div>
                <button className="btn btn-primary" disabled={!invEmail.includes('@miseroda.com') || createInvite.isPending}
                  onClick={() => createInvite.mutate()}>
                  產生邀請碼
                </button>
                {invEmail && !invEmail.includes('@miseroda.com') && (
                  <p style={{ fontSize: 12.5, color: 'var(--warning)', margin: 0 }}>地址必須是 @miseroda.com 結尾</p>
                )}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14, textAlign: 'center' }}>
                <div className="backup-codes" style={{ gridTemplateColumns: '1fr', fontSize: 18, letterSpacing: 2, justifyItems: 'center' }}>
                  <span>{createdCode}</span>
                </div>
                <button className="btn btn-primary" onClick={() => { void copyInviteLink(createdCode); closeModal(); }}>
                  複製邀請連結
                </button>
              </div>
            )}
          </Modal>
        )}

        {editUser && (
          <Modal title="編輯帳號" desc="改前綴後站內互寄立即生效；對方信箱裡的歷史信件仍顯示舊地址。" onClose={() => setEditUser(null)}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div className="field">
                <label>Email 前綴</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input className="input" value={editLocal} spellCheck={false} autoFocus
                    onChange={(e) => setEditLocal(e.target.value.toLowerCase())} />
                  <span className="mono" style={{ color: 'var(--text-muted)', flex: 'none' }}>@miseroda.com</span>
                </div>
              </div>
              <div className="field">
                <label>顯示名稱</label>
                <input className="input" value={editName} onChange={(e) => setEditName(e.target.value)} />
              </div>
              <button className="btn btn-primary"
                disabled={!editLocal.trim() || !editName.trim() || saveEdit.isPending}
                onClick={() => saveEdit.mutate()}>
                儲存變更
              </button>
            </div>
          </Modal>
        )}

        {deleteUser && (
          <Modal title="永久刪除帳號" desc="信件、附件、passkey、設定將全部清除，無法復原。" onClose={() => { setDeleteUser(null); setDeleteConfirm(''); }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div className="setting-row" style={{ border: '1px solid var(--border-subtle)', borderRadius: 10, padding: '10px 14px' }}>
                <div>
                  <div className="label mono">{deleteUser.email}</div>
                  <div className="hint">
                    {usage.data
                      ? `${usage.data.messages} 封信件 · ${usage.data.attachments} 個附件（${fmtGB(usage.data.attachmentBytes)}）將被刪除`
                      : '統計中…'}
                  </div>
                </div>
              </div>
              <div className="field">
                <label>輸入完整 email 以確認</label>
                <input className="input mono" placeholder={deleteUser.email} value={deleteConfirm}
                  spellCheck={false} onChange={(e) => setDeleteConfirm(e.target.value)} />
              </div>
              <button className="btn btn-danger"
                disabled={deleteConfirm.trim().toLowerCase() !== deleteUser.email || doDelete.isPending}
                onClick={() => doDelete.mutate()}>
                {doDelete.isPending ? '刪除中…' : '永久刪除這個帳號'}
              </button>
            </div>
          </Modal>
        )}

        {recoveryLink && (
          <Modal title="passkey 救援連結" desc="把這條連結私下交給使用者（如 LINE）。連結 2 小時內有效、僅能用一次。" onClose={() => setRecoveryLink(null)}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div className="field">
                <label>{recoveryLink.email} 的救援連結</label>
                <textarea className="input mono" readOnly rows={3} value={recoveryLink.url}
                  style={{ resize: 'none', wordBreak: 'break-all' }} onFocus={(e) => e.currentTarget.select()} />
              </div>
              <button className="btn btn-primary"
                onClick={() => { void navigator.clipboard?.writeText(recoveryLink.url); pushToast('已複製救援連結 📋'); }}>
                <Icon name="clip" size={14} /> 複製連結
              </button>
              <p className="hint" style={{ margin: 0 }}>
                使用者開啟後可在他自己的裝置重新綁定一把 passkey；綁定後仍需用他原本的 TOTP（或備援碼）登入。
              </p>
            </div>
          </Modal>
        )}

        {/* 重設 TOTP 的第二道確認：列出所有「用救援連結綁定」的 passkey，逐一由 admin 承認後才送出。
            每一把獨立成一個節點（不把名稱串進整段敘述）——名稱是綁定者自訂的，串起來會被拿來偽造說明文字。 */}
        {resetAck && (
          <Modal title={`重設 ${resetAck.user.email} 的兩步驟驗證？`}
            desc="這個帳號有用救援連結綁定的 passkey。TOTP 一旦重設，它們全都能免 TOTP 直接登入並自行重新設定 TOTP（＝完整接管信箱）。"
            onClose={() => setResetAck(null)} width={520}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <p style={{ margin: 0, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                請先向本人確認：下面每一把都是他自己綁的嗎？
              </p>
              <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8 }}>
                {resetAck.passkeys.map((p) => (
                  <li key={p.id}>
                    <div style={{ fontWeight: 600 }}>{p.name ?? '（未命名）'}</div>
                    <div className="mono" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                      綁定於 {new Date(p.createdAt).toLocaleString('zh-TW')} · {p.id.slice(0, 16)}…
                    </div>
                  </li>
                ))}
              </ul>
              <p className="hint" style={{ margin: 0 }}>
                名稱由綁定者自行輸入，可能是假的。只要有一把說不出來歷，就先取消——改用「停用」凍結帳號再查。
              </p>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <button className="btn btn-ghost" onClick={() => setResetAck(null)}>取消</button>
                <button className="btn btn-danger" disabled={resetTotp.isPending}
                  onClick={() => resetTotp.mutate({ id: resetAck.user.id, acknowledge: resetAck.passkeys.map((p) => p.id) })}>
                  {resetTotp.isPending ? '重設中…' : '都是本人綁的，重設 2FA'}
                </button>
              </div>
            </div>
          </Modal>
        )}
      </div>
    </main>
  );
}
