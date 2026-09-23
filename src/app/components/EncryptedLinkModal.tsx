import { useState } from 'react';
import { Modal, Icon } from './ui';
import { createEncryptedLink } from '../api/send';

// F7.7：建立訊息級加密連結。內容在瀏覽器端 AES-GCM 加密；伺服器只存密文，
// 金鑰由密碼 ‖ 連結 fragment 派生（站方無從解密）。複製連結給收件人，密碼另外私下給。
export function EncryptedLinkModal({
  onClose,
  pushToast,
  initialBody,
}: {
  onClose: () => void;
  pushToast: (m: string) => void;
  initialBody?: string;
}) {
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState(initialBody ?? '');
  const [password, setPassword] = useState('');
  const [days, setDays] = useState(7);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ url: string; expiresAt: number } | null>(null);

  const generate = async () => {
    if (!message.trim()) {
      pushToast('請輸入要加密的內容');
      return;
    }
    if (password.length < 6) {
      pushToast('密碼至少 6 個字');
      return;
    }
    setBusy(true);
    try {
      const r = await createEncryptedLink({ plaintext: message, password, subject: subject.trim() || undefined, expiresDays: days });
      setResult(r);
    } catch {
      pushToast('建立失敗，請再試一次');
    } finally {
      setBusy(false);
    }
  };

  const copy = () => {
    if (result) void navigator.clipboard.writeText(result.url).then(() => pushToast('連結已複製 📋')).catch(() => pushToast('複製失敗，請手動選取'));
  };

  return (
    <Modal title="建立加密訊息連結" desc="內容在你的瀏覽器加密，伺服器看不到明文" onClose={onClose} width={520}>
      {!result ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <input className="input" placeholder="標題（選填，不加密）" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} />
          <textarea
            className="input"
            placeholder="要加密的訊息內容…"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={6}
            style={{ resize: 'vertical', fontFamily: 'inherit' }}
          />
          <input
            className="input"
            type="password"
            placeholder="密碼（至少 6 字；另外私下告訴收件人）"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
          />
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-secondary)' }}>
            連結有效天數
            <select className="input" value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ width: 110 }}>
              {[1, 3, 7, 14, 30].map((d) => (
                <option key={d} value={d}>
                  {d} 天
                </option>
              ))}
            </select>
          </label>
          <button className="btn btn-primary" disabled={busy} onClick={() => void generate()}>
            {busy ? '加密中…' : '產生加密連結'}
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
            把這個連結傳給收件人，<strong>另外用別的管道告訴他們密碼</strong>。{new Date(result.expiresAt).toLocaleDateString()} 過期。
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input className="input" readOnly value={result.url} onFocus={(e) => e.currentTarget.select()} style={{ flex: 1 }} />
            <button className="btn btn-secondary" onClick={copy}>
              <Icon name="clip" size={14} /> 複製
            </button>
          </div>
          <button className="btn btn-ghost" onClick={onClose}>
            完成
          </button>
        </div>
      )}
    </Modal>
  );
}
