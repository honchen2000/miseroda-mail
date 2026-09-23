// 右上角使用者選單：頭像 chip → 下拉卡（上傳大頭貼、編輯顯示名稱、快捷鍵、登出）
import { useRef, useState } from 'react';
import { api, type Me } from '../api/client';
import { AvatarImg, Icon } from './ui';
import { AvatarCropModal } from './avatar-crop';
import { BUILD_LABEL } from '../lib/buildInfo';

function csrfFromCookie(): string {
  for (const part of document.cookie.split(/;\s*/)) {
    const eq = part.indexOf('=');
    if (part.slice(0, eq) === '__Host-csrf' || part.slice(0, eq) === 'csrf') {
      return decodeURIComponent(part.slice(eq + 1));
    }
  }
  return '';
}

export function UserMenu({ me, onMeChanged, onLogout, onShowKbd, pushToast }: {
  me: Me;
  onMeChanged: () => void;
  onLogout: () => void;
  onShowKbd: () => void;
  pushToast: (t: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(me.user.displayName);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const sources = me.avatarUrl ? [me.avatarUrl] : [];

  // 選檔後先進裁切彈窗；真正送出的是它輸出的 512×512 方圖（數十 KB），
  // 所以這裡不再用原檔大小擋人——手機隨手拍的照片都遠超過 1 MB。
  const [cropFile, setCropFile] = useState<File | null>(null);

  const pickAvatar = (file: File) => {
    if (!file.type.startsWith('image/')) {
      pushToast('請選擇圖片檔');
      return;
    }
    setCropFile(file);
  };

  const uploadAvatar = async (file: File) => {
    setUploading(true);
    try {
      const form = new FormData();
      form.set('file', file);
      const res = await fetch('/api/v1/profile/avatar', {
        method: 'POST',
        headers: { 'X-CSRF-Token': csrfFromCookie() },
        credentials: 'same-origin',
        body: form,
      });
      if (!res.ok) {
        // 讓失敗說得出原因——舊版一律「頭像上傳失敗」，SVG 被擋、超過上限、網路斷線看起來全一樣。
        const code = (await res.json().catch(() => null) as { error?: string } | null)?.error;
        throw new Error(code ?? `http_${res.status}`);
      }
      onMeChanged();
      pushToast('頭像已更新 🐧');
    } catch (e) {
      const code = e instanceof Error ? e.message : '';
      pushToast(
        code === 'not_an_image' ? '這個圖片格式不能當頭像，請改用 JPG 或 PNG'
          : code === 'too_large' ? '圖片太大，請換一張'
            : code === 'demo_readonly' ? 'Demo 帳號無法變更資料'
              : '頭像上傳失敗，請再試一次',
      );
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const saveName = async () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === me.user.displayName) return;
    setSaving(true);
    try {
      await api('/profile', { method: 'PATCH', body: { displayName: trimmed } });
      onMeChanged();
      pushToast('顯示名稱已更新（寄信時對方會看到這個名字）');
    } catch {
      pushToast('名稱儲存失敗');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <button className="user-chip" aria-label="帳號選單" data-tooltip={me.user.email}
        onClick={() => { setName(me.user.displayName); setOpen(!open); }}>
        <AvatarImg name={me.user.displayName} sources={sources} />
      </button>
      {open && (
        <>
          <button className="user-pop-backdrop" aria-label="關閉帳號選單" onClick={() => setOpen(false)}></button>
          <div className="user-pop" role="dialog" aria-label="帳號">
            <div className="user-pop-head">
              <button className="user-pop-avatar" aria-label="更換頭像" data-tooltip="更換頭像（可裁切縮放）"
                onClick={() => fileRef.current?.click()} disabled={uploading}>
                <AvatarImg name={me.user.displayName} sources={sources} size="lg" />
                <span className="cam"><Icon name={uploading ? 'clock' : 'img'} size={13} /></span>
              </button>
              <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  // 先清空，否則連續選同一個檔案不會再觸發 change
                  e.target.value = '';
                  if (f) pickAvatar(f);
                }} />
              <div>
                <div style={{ fontWeight: 700, fontSize: 15 }}>
                  {me.user.displayName}
                  {me.user.role === 'admin' && (
                    <span className="badge green" style={{ marginLeft: 6, fontSize: 10, padding: '1px 7px' }}>admin</span>
                  )}
                </div>
                <div className="mail">{me.user.email}</div>
              </div>
            </div>
            <div className="user-pop-row">
              <input className="input" value={name} maxLength={40} aria-label="顯示名稱"
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void saveName(); }} />
              <button className="btn btn-primary btn-sm" disabled={saving || !name.trim() || name.trim() === me.user.displayName}
                onClick={() => void saveName()}>
                儲存
              </button>
            </div>
            <p style={{ fontSize: 11.5, color: 'var(--text-muted)', margin: '8px 0 0' }}>
              顯示名稱會出現在你寄出信件的寄件人欄位。頭像用於站內顯示；
              要讓 Gmail 等外部信箱顯示頭像，需到 Gravatar 以此地址註冊。
            </p>
            <div className="user-pop-foot">
              <button className="btn btn-ghost btn-sm" onClick={() => { setOpen(false); onShowKbd(); }}>
                <Icon name="keyboard" size={14} /> 快捷鍵
              </button>
              <button className="btn btn-danger btn-sm" onClick={onLogout}>
                <Icon name="logout" size={14} /> 登出
              </button>
            </div>
            {/* 目前執行的版本（對照每次上線回報的 commit 編號；PWA 確認有沒有更新到） */}
            <div className="user-pop-ver">{BUILD_LABEL}</div>
          </div>
        </>
      )}
      {cropFile && (
        <AvatarCropModal file={cropFile} pushToast={pushToast}
          onCancel={() => setCropFile(null)}
          onDone={(out) => { setCropFile(null); void uploadAvatar(out); }} />
      )}
    </>
  );
}
