// 登入（Passkey + TOTP）與邀請註冊流程 —— 接真實 WebAuthn ceremony
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { haptics } from '../lib/haptics';
import QRCode from 'qrcode';
import { api, ApiError } from '../api/client';
import { dt } from '../lib/demoI18n';
import { AppLogo, AuroraSky, Icon, Pori } from './ui';

/* ---------- TOTP 六碼輸入 ---------- */
export function TotpInput({ onComplete, autoFocus }: { onComplete: (code: string) => void; autoFocus?: boolean }) {
  const [vals, setVals] = useState(['', '', '', '', '', '']);
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  useEffect(() => {
    if (autoFocus) refs.current[0]?.focus();
  }, [autoFocus]);
  const set = (i: number, v: string) => {
    const digit = v.replace(/\D/g, '').slice(-1);
    const next = [...vals];
    next[i] = digit;
    setVals(next);
    if (digit && i < 5) refs.current[i + 1]?.focus();
    if (next.every((d) => d !== '')) {
      onComplete(next.join(''));
      setVals(['', '', '', '', '', '']);
      refs.current[0]?.focus();
    }
  };
  const onKey = (i: number, e: React.KeyboardEvent) => {
    if (e.key === 'Backspace' && !vals[i] && i > 0) refs.current[i - 1]?.focus();
  };
  const onPaste = (e: React.ClipboardEvent) => {
    const digits = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
    if (digits.length === 6) {
      e.preventDefault();
      setVals(digits.split(''));
      onComplete(digits);
    }
  };
  return (
    <div className="totp-boxes" onPaste={onPaste}>
      {vals.map((v, i) => (
        <input key={i} className="totp-box" value={v} inputMode="numeric" aria-label={`第 ${i + 1} 碼`}
          ref={(el) => { refs.current[i] = el; }}
          onChange={(e) => set(i, e.target.value)} onKeyDown={(e) => onKey(i, e)} />
      ))}
    </div>
  );
}

/* ---------- Passkey ceremony 動畫（scanning / ok / error） ---------- */
export type CeremonyPhase = 'scanning' | 'ok' | 'error';

export function PasskeyAnim({ phase, label, doneLabel, errorMessage, onRetry }: {
  phase: CeremonyPhase;
  label: string;
  doneLabel: string;
  errorMessage?: string;
  onRetry?: () => void;
}) {
  return (
    <div className="passkey-anim">
      <div className={`passkey-ring ${phase === 'ok' ? 'ok' : phase === 'error' ? '' : 'scanning'}`}
        style={phase === 'error' ? { background: 'rgba(255,107,138,.12)', color: 'var(--danger)' } : undefined}>
        <Icon name={phase === 'ok' ? 'check' : phase === 'error' ? 'x' : 'fingerprint'} size={34} />
      </div>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontWeight: 600, fontSize: 14 }}>
          {phase === 'ok' ? doneLabel : phase === 'error' ? '驗證未完成' : label}
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 2 }}>
          {phase === 'ok' ? '驗證成功' : phase === 'error' ? errorMessage ?? '請再試一次' : '請在裝置上完成生物辨識（Touch ID / Face ID）'}
        </div>
        {phase === 'error' && onRetry && (
          <button className="btn btn-secondary btn-sm" style={{ marginTop: 14 }} onClick={onRetry}>重試</button>
        )}
      </div>
    </div>
  );
}

export function AuthShell({ children, step = 0, totalSteps = 1 }: {
  children: ReactNode; step?: number; totalSteps?: number;
}) {
  return (
    <div className="auth-wrap">
      <AuroraSky />
      <div className="auth-card">
        <div className="auth-logo">
          <AppLogo size={52} />
          <div>
            <div style={{ fontWeight: 700, fontSize: 16, letterSpacing: '-0.01em' }}>Miseroda Mail</div>
            <div className="auth-domain">mail.miseroda.com</div>
          </div>
        </div>
        {totalSteps > 1 && (
          <div className="auth-steps" aria-label={`步驟 ${step + 1} / ${totalSteps}`}>
            {Array.from({ length: totalSteps }, (_, i) => (
              <span key={i} className={`auth-step-dot ${i <= step ? 'done' : ''}`}></span>
            ))}
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

function errText(e: unknown): string {
  if (e instanceof ApiError) {
    const map: Record<string, string> = {
      verification_failed: 'Passkey 驗證失敗，請再試一次',
      challenge_expired: '驗證逾時（步驟之間隔太久），請重新開始',
      invalid_invite: '邀請碼無效或已過期',
      invalid_code: '代碼不正確',
      too_many_attempts: '嘗試次數過多，請重新登入',
      email_exists: '這個信箱已經註冊過了。若你失去了 passkey，請向管理員索取「救援連結」重新綁定，不要用邀請碼。',
      invalid_token: '救援連結無效或已過期，請向管理員索取新的連結',
      token_mismatch: '救援連結與此步驟不符，請重新開啟救援連結',
      totp_not_enabled: '這個帳號尚未啟用兩步驟驗證，無法用救援連結重綁。請聯絡管理員以其他方式處理。',
    };
    return map[e.code] ?? `發生錯誤（${e.code}）`;
  }
  // WebAuthn 瀏覽器端錯誤（DOMException）
  if (e instanceof Error) {
    if (e.name === 'NotAllowedError') return '已取消或逾時，請再試一次';
    if (e.name === 'InvalidStateError') return '這個裝置上似乎已經有這個帳號的 Passkey 了';
    if (e.name === 'NotSupportedError') return '此瀏覽器或裝置不支援 Passkey';
    if (e.name === 'SecurityError') return '網域安全性檢查失敗，請確認網址是 mail.miseroda.com';
  }
  return '發生未預期的錯誤，請再試一次';
}

/* ---------- 登入 ---------- */
export function LoginScreen({ onLogin, onGoInvite }: { onLogin: () => void; onGoInvite: () => void }) {
  const [stage, setStage] = useState<'start' | 'passkey' | 'totp'>('start');
  const [email, setEmail] = useState(() => localStorage.getItem('miseroda_last_email') ?? '');
  const [phase, setPhase] = useState<CeremonyPhase>('scanning');
  const [error, setError] = useState('');
  const [totpToken, setTotpToken] = useState('');
  const [totpErr, setTotpErr] = useState('');
  const [backupMode, setBackupMode] = useState(false);
  const [backupCode, setBackupCode] = useState('');
  const [trustDevice, setTrustDevice] = useState(false);

  const doPasskey = async () => {
    setStage('passkey');
    setPhase('scanning');
    setError('');
    try {
      localStorage.setItem('miseroda_last_email', email);
      const { challengeId, options } = await api<{ challengeId: string; options: never }>(
        '/auth/login/options',
        { body: { email: email.trim().toLowerCase() } },
      );
      const response = await startAuthentication({ optionsJSON: options });
      const result = await api<{ ok?: boolean; totpRequired?: boolean; totpToken?: string }>(
        '/auth/login/verify',
        { body: { challengeId, response } },
      );
      haptics.success(); // F3.4：passkey 驗證成功
      setPhase('ok');
      setTimeout(() => {
        if (result.totpRequired && result.totpToken) {
          setTotpToken(result.totpToken);
          setStage('totp');
        } else {
          onLogin();
        }
      }, 650);
    } catch (e) {
      setPhase('error');
      setError(errText(e));
    }
  };

  const submitSecondFactor = async (code: string) => {
    setTotpErr('');
    try {
      await api('/auth/totp/challenge', { body: { totpToken, code, trustDevice } });
      haptics.success(); // F3.4：登入 TOTP 填滿驗證成功
      onLogin();
    } catch (e) {
      if (e instanceof ApiError && (e.code === 'challenge_expired' || e.code === 'too_many_attempts')) {
        setStage('start');
        setError('');
        setTotpErr('');
      } else {
        setTotpErr(errText(e));
      }
    }
  };

  return (
    <AuthShell>
      {stage === 'start' && (
        <div>
          <h1 className="auth-title">歡迎回來</h1>
          <p className="auth-sub">使用 Passkey 登入，不需要密碼，也不需要收信。</p>
          <form onSubmit={(e) => { e.preventDefault(); if (email.includes('@')) void doPasskey(); }}>
            <div className="field" style={{ marginBottom: 16 }}>
              <label htmlFor="login-email">電子郵件地址</label>
              <input id="login-email" className="input" value={email} spellCheck={false} autoComplete="username webauthn"
                onChange={(e) => setEmail(e.target.value)} placeholder="you@miseroda.com" />
            </div>
            <button type="submit" className="btn btn-primary btn-lg" style={{ width: '100%' }} disabled={!email.includes('@')}>
              <Icon name="key" /> 使用 Passkey 登入
            </button>
          </form>
          <div className="auth-foot">
            <span>沒有帳號？採邀請制</span>
            <button className="linklike" onClick={onGoInvite}>我有邀請碼</button>
          </div>
        </div>
      )}
      {stage === 'passkey' && (
        <div>
          <h1 className="auth-title">驗證身分</h1>
          <p className="auth-sub">{email}</p>
          <PasskeyAnim phase={phase} label="正在等待 Passkey…" doneLabel="Passkey 已確認"
            errorMessage={error} onRetry={doPasskey} />
          {phase === 'error' && (
            <div className="auth-foot">
              <span></span>
              <button className="linklike" onClick={() => setStage('start')}>返回</button>
            </div>
          )}
        </div>
      )}
      {stage === 'totp' && (
        <div>
          <h1 className="auth-title">兩步驟驗證</h1>
          <p className="auth-sub">請輸入驗證器 App 的 6 位數代碼。</p>
          {!backupMode ? (
            <TotpInput autoFocus onComplete={(code) => void submitSecondFactor(code)} />
          ) : (
            <form onSubmit={(e) => { e.preventDefault(); void submitSecondFactor(backupCode.trim()); }}>
              <div className="field">
                <label htmlFor="backup-code">備援碼</label>
                <input id="backup-code" className="input mono" value={backupCode} placeholder="xxxx-xxxx"
                  onChange={(e) => setBackupCode(e.target.value)} autoFocus spellCheck={false} />
              </div>
              <button type="submit" className="btn btn-primary" style={{ width: '100%', marginTop: 12 }}>驗證</button>
            </form>
          )}
          {totpErr && <p style={{ color: 'var(--danger)', fontSize: 13, textAlign: 'center', marginTop: 12 }}>{totpErr}</p>}
          <label className="trust-device">
            <input type="checkbox" checked={trustDevice} onChange={(e) => setTrustDevice(e.target.checked)} />
            <span>30 天內信任這台裝置（下次登入免輸入驗證碼）</span>
          </label>
          <div className="auth-foot" style={{ justifyContent: 'center' }}>
            <button type="button" className="linklike" onClick={() => setBackupMode(!backupMode)}>
              {backupMode ? '改回輸入驗證器 6 位數代碼' : '遺失驗證器？改用備援碼'}
            </button>
          </div>
          {backupMode && (
            <p style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', marginTop: 8 }}>
              連備援碼也遺失了？請聯絡管理員為你重設兩步驟驗證。
            </p>
          )}
        </div>
      )}
    </AuthShell>
  );
}

/* ---------- 唯讀 Demo 一鍵進場（/demo；求職招募方免註冊參觀。雙語：中文語系顯繁中，其餘 fallback 英文） ---------- */
export function DemoLanding({ onEntered, onGoLogin }: { onEntered: () => void; onGoLogin: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const enter = async () => {
    setBusy(true);
    setError('');
    try {
      await api('/auth/demo-login', { body: {} });
      onEntered();
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 404
          ? dt('Demo 目前未開放，請稍後再試。', "The demo isn't available right now. Please try again later.")
          : dt('進入失敗，請再試一次。', "Couldn't enter the demo. Please try again."),
      );
      setBusy(false);
    }
  };
  return (
    <AuthShell>
      <h1 className="auth-title">{dt('唯讀 Demo', 'Read-only demo')}</h1>
      <p className="auth-sub">
        {dt(
          '不需註冊、不需 Passkey，一鍵進來參觀 Miseroda Mail。這是唯讀環境——你可以自由瀏覽信箱與各項功能，但無法寄信或變更任何資料。',
          'No sign-up, no passkey — jump right in and explore Miseroda Mail. This is a read-only environment: browse the mailbox and every feature freely, but you can’t send mail or change any data.',
        )}
      </p>
      <button className="btn btn-primary btn-lg" style={{ width: '100%', marginTop: 8 }} disabled={busy} onClick={() => void enter()}>
        {busy ? dt('進入中…', 'Entering…') : dt('進入 Demo', 'Enter demo')}
      </button>
      {error && <p className="auth-sub" style={{ color: 'var(--danger)', marginTop: 10 }}>{error}</p>}
      <button className="linklike" style={{ marginTop: 14, fontSize: 13 }} onClick={onGoLogin}>
        {dt('用 Passkey 登入 →', 'Sign in with a passkey →')}
      </button>
    </AuthShell>
  );
}

/* ---------- 邀請註冊（5 步） ---------- */
export function InviteFlow({ onDone, onBack, initialCode }: { onDone: () => void; onBack: () => void; initialCode?: string }) {
  const [step, setStep] = useState(0); // 0 code, 1 passkey, 2 totp, 3 backup, 4 done
  const [code, setCode] = useState(initialCode ?? '');
  const [boundEmail, setBoundEmail] = useState('');
  const [checkErr, setCheckErr] = useState('');
  const [phase, setPhase] = useState<CeremonyPhase>('scanning');
  const [regErr, setRegErr] = useState('');
  const [otpauth, setOtpauth] = useState('');
  const [secret, setSecret] = useState('');
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [totpErr, setTotpErr] = useState('');
  const [totpSetupErr, setTotpSetupErr] = useState('');
  const [backupCodes, setBackupCodes] = useState<string[]>([]);

  const checkCode = async () => {
    setCheckErr('');
    try {
      const res = await api<{ email: string }>('/auth/invite/check', { body: { code } });
      setBoundEmail(res.email);
      setStep(1);
      void runRegister();
    } catch (e) {
      setCheckErr(errText(e));
    }
  };

  const runRegister = async () => {
    setPhase('scanning');
    setRegErr('');
    try {
      const { challengeId, options } = await api<{ challengeId: string; options: never }>(
        '/auth/register/options',
        { body: { code } },
      );
      const response = await startRegistration({ optionsJSON: options });
      await api('/auth/register/verify', { body: { code, challengeId, response } });
      setPhase('ok');
      setTimeout(() => {
        setStep(2);
        void setupTotp();
      }, 650);
    } catch (e) {
      setPhase('error');
      setRegErr(errText(e));
    }
  };

  const setupTotp = async () => {
    setTotpSetupErr('');
    try {
      const res = await api<{ secret: string; otpauth: string }>('/auth/totp/setup', { body: {} });
      setSecret(res.secret);
      setOtpauth(res.otpauth);
      setQrDataUrl(await QRCode.toDataURL(res.otpauth, { margin: 1, width: 296 }));
    } catch (e) {
      setTotpSetupErr(errText(e)); // 失敗不再卡在「產生中…」，顯示錯誤 + 重試
    }
  };

  const verifyTotpCode = async (totp: string) => {
    setTotpErr('');
    try {
      const res = await api<{ backupCodes: string[] }>('/auth/totp/verify', { body: { code: totp } });
      haptics.success(); // F3.4：TOTP 設定驗證成功
      setBackupCodes(res.backupCodes);
      setStep(3);
    } catch (e) {
      setTotpErr(errText(e));
    }
  };

  const downloadBackup = () => {
    const blob = new Blob(
      [`Miseroda Mail 備援碼 — ${boundEmail}\n每組僅能使用一次，請妥善保存。\n\n${backupCodes.join('\n')}\n`],
      { type: 'text/plain' },
    );
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'miseroda-backup-codes.txt';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  // 結尾鼓勵再綁一把「備用 passkey」（手機/第二裝置）—— 大幅降低未來「裝置遺失就被鎖死」。
  // 重用 /passkey/add（不強制 platform → 可掃 QR 綁手機上可同步的 passkey）。此時已有 session。
  const [addingBackup, setAddingBackup] = useState(false);
  const [backupAdded, setBackupAdded] = useState(false);
  const [backupErr, setBackupErr] = useState('');
  const addBackupPasskey = async () => {
    setAddingBackup(true);
    setBackupErr('');
    try {
      const { challengeId, options } = await api<{ challengeId: string; options: never }>('/auth/passkey/add/options', { body: {} });
      const response = await startRegistration({ optionsJSON: options });
      await api('/auth/passkey/add/verify', { body: { challengeId, response, name: '備用裝置' } });
      setBackupAdded(true);
    } catch (e) {
      setBackupErr(errText(e));
    } finally {
      setAddingBackup(false);
    }
  };

  return (
    <AuthShell step={step} totalSteps={5}>
      {step === 0 && (
        <div>
          <h1 className="auth-title">接受邀請</h1>
          <p className="auth-sub">輸入管理員提供的邀請碼，建立你的 @miseroda.com 信箱。</p>
          <form onSubmit={(e) => { e.preventDefault(); void checkCode(); }}>
            <div className="field" style={{ marginBottom: 16 }}>
              <label htmlFor="inv-code">邀請碼</label>
              <input id="inv-code" className="input mono" value={code} spellCheck={false} placeholder="XXXX-XXXX-XXXX"
                onChange={(e) => setCode(e.target.value.toUpperCase())} autoFocus />
            </div>
            {checkErr && <p style={{ color: 'var(--danger)', fontSize: 13, margin: '0 0 12px' }}>{checkErr}</p>}
            <button type="submit" className="btn btn-primary btn-lg" style={{ width: '100%' }}
              disabled={code.replace(/[^A-Z0-9]/g, '').length < 12}>
              驗證邀請碼
            </button>
          </form>
          <div className="auth-foot">
            <span>已經有帳號？</span>
            <button className="linklike" onClick={onBack}>返回登入</button>
          </div>
        </div>
      )}
      {step === 1 && (
        <div>
          <h1 className="auth-title">建立 Passkey</h1>
          <p className="auth-sub">{boundEmail} — 這是你日後登入的主要方式，不會有密碼。</p>
          <PasskeyAnim phase={phase} label="正在建立 Passkey…" doneLabel="Passkey 已建立"
            errorMessage={regErr} onRetry={() => void runRegister()} />
        </div>
      )}
      {step === 2 && (
        <div>
          <h1 className="auth-title">設定 TOTP 備援</h1>
          <p className="auth-sub">用驗證器 App（如 Authy、Google Authenticator）掃描 QR code。</p>
          {qrDataUrl ? (
            <img src={qrDataUrl} alt="TOTP QR code" style={{ width: 148, height: 148, display: 'block', margin: '0 auto', borderRadius: 12 }} />
          ) : totpSetupErr ? (
            <div style={{ textAlign: 'center' }}>
              <p style={{ color: 'var(--danger)', fontSize: 13 }}>產生 QR code 失敗：{totpSetupErr}</p>
              <button className="btn btn-secondary btn-sm" onClick={() => void setupTotp()}>重試</button>
            </div>
          ) : (
            <div className="qr-placeholder">QR code 產生中…</div>
          )}
          <p style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', margin: '10px 0 18px', fontFamily: 'var(--font-mono)', wordBreak: 'break-all' }}>
            {secret.replace(/(.{4})/g, '$1 ').trim()}
          </p>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', textAlign: 'center', margin: '0 0 10px' }}>輸入 App 顯示的 6 位數代碼確認</p>
          <TotpInput autoFocus onComplete={(c) => void verifyTotpCode(c)} />
          {totpErr && <p style={{ color: 'var(--danger)', fontSize: 13, textAlign: 'center', marginTop: 12 }}>{totpErr}</p>}
          {otpauth && (
            <p style={{ fontSize: 11.5, color: 'var(--text-muted)', textAlign: 'center', marginTop: 14 }}>
              無法掃描？把上方代碼手動輸入驗證器 App。
            </p>
          )}
        </div>
      )}
      {step === 3 && (
        <div>
          <h1 className="auth-title">保存備援碼</h1>
          <p className="auth-sub">遺失裝置時，每組備援碼可使用一次。請存放在安全的地方。</p>
          <div className="backup-codes">
            {backupCodes.map((c) => <span key={c}>{c}</span>)}
          </div>
          <button className="btn btn-secondary" style={{ width: '100%', marginTop: 14 }} onClick={downloadBackup}>
            <Icon name="download" size={15} /> 下載 backup-codes.txt
          </button>
          <button className="btn btn-primary btn-lg" style={{ width: '100%', marginTop: 10 }} onClick={() => setStep(4)}>
            我已保存，繼續
          </button>
        </div>
      )}
      {step === 4 && (
        <div style={{ textAlign: 'center' }}>
          <div style={{ color: 'var(--text-secondary)', margin: '6px 0' }}><Pori pose="happy" size={120} /></div>
          <h1 className="auth-title" style={{ marginTop: 4 }}>歡迎加入 🎉</h1>
          <p className="auth-sub">{boundEmail} 已啟用。<br />Pori 已經幫你把信箱鋪好雪了。</p>
          <div className="backup-nudge">
            <div className="bn-head"><Icon name="key" size={15} /> 強烈建議：再綁一把備用 passkey</div>
            <p className="bn-sub">在你的<b>手機或另一台裝置</b>多綁一把，萬一這台裝置不見或重置，也不會被鎖在信箱外。</p>
            {backupAdded ? (
              <div className="bn-ok"><Icon name="check" size={15} /> 已新增備用 passkey，安全多了！</div>
            ) : (
              <>
                <button className="btn btn-secondary" style={{ width: '100%' }} disabled={addingBackup} onClick={() => void addBackupPasskey()}>
                  {addingBackup ? '請在裝置上確認…' : '現在新增備用 passkey'}
                </button>
                {backupErr && <p style={{ color: 'var(--danger)', fontSize: 12.5, margin: '8px 0 0' }}>{backupErr}</p>}
              </>
            )}
          </div>
          <button className="btn btn-primary btn-lg" style={{ width: '100%', marginTop: 12 }} onClick={onDone}>
            {backupAdded ? '完成，進入收件匣' : '先略過，進入收件匣'}
          </button>
        </div>
      )}
    </AuthShell>
  );
}

/* ---------- 救援：用 admin 核發的連結重新綁定 passkey（失去所有 passkey 時） ---------- */
export function RecoverFlow({ token, onDone, onBack }: { token: string; onDone: () => void; onBack: () => void }) {
  const [step, setStep] = useState<'check' | 'passkey' | 'done'>('check');
  const [email, setEmail] = useState('');
  const [checkErr, setCheckErr] = useState('');
  const [phase, setPhase] = useState<CeremonyPhase>('scanning');
  const [regErr, setRegErr] = useState('');

  useEffect(() => {
    void (async () => {
      try {
        const res = await api<{ email: string }>('/auth/recover/check', { body: { token } });
        setEmail(res.email);
      } catch (e) {
        setCheckErr(errText(e));
      }
    })();
  }, [token]);

  const runRecover = async () => {
    setStep('passkey');
    setPhase('scanning');
    setRegErr('');
    try {
      const { challengeId, options } = await api<{ challengeId: string; options: never }>('/auth/recover/options', {
        body: { token },
      });
      const response = await startRegistration({ optionsJSON: options });
      await api('/auth/recover/verify', { body: { token, challengeId, response } });
      setPhase('ok');
      setTimeout(() => setStep('done'), 650);
    } catch (e) {
      setPhase('error');
      setRegErr(errText(e));
    }
  };

  return (
    <AuthShell>
      {step === 'check' && (
        <div>
          <h1 className="auth-title">重新綁定 Passkey</h1>
          {checkErr ? (
            <>
              <p className="auth-sub">這個救援連結無效或已過期，請向管理員索取新的連結。</p>
              <p style={{ color: 'var(--danger)', fontSize: 13 }}>{checkErr}</p>
            </>
          ) : email ? (
            <>
              <p className="auth-sub">
                {email} — 在這台裝置建立一把新的 passkey。完成後請用新 passkey + 你的 TOTP（或備援碼）登入。
              </p>
              <button className="btn btn-primary btn-lg" style={{ width: '100%' }} onClick={() => void runRecover()}>
                建立新的 Passkey
              </button>
            </>
          ) : (
            <p className="auth-sub">驗證救援連結中…</p>
          )}
          <div className="auth-foot">
            <button className="linklike" onClick={onBack}>返回登入</button>
          </div>
        </div>
      )}
      {step === 'passkey' && (
        <div>
          <h1 className="auth-title">建立 Passkey</h1>
          <p className="auth-sub">{email}</p>
          <PasskeyAnim phase={phase} label="正在建立 Passkey…" doneLabel="Passkey 已建立"
            errorMessage={regErr} onRetry={() => void runRecover()} />
        </div>
      )}
      {step === 'done' && (
        <div style={{ textAlign: 'center' }}>
          <div style={{ color: 'var(--text-secondary)', margin: '6px 0' }}><Pori pose="happy" size={120} /></div>
          <h1 className="auth-title" style={{ marginTop: 4 }}>綁定完成 🎉</h1>
          <p className="auth-sub">{email} 已綁定新的 passkey。<br />請用新 passkey + 你的 TOTP（或備援碼）登入。</p>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: -4 }}>
            救援只重綁 passkey，不會重設兩步驟驗證。若你的驗證器與備援碼都遺失，請聯絡管理員為你重設兩步驟驗證。
          </p>
          <button className="btn btn-primary btn-lg" style={{ width: '100%' }} onClick={onDone}>前往登入</button>
        </div>
      )}
    </AuthShell>
  );
}

/* ---------- 強制兩步驟驗證設定（已登入但尚未啟用 TOTP 者必經） ---------- */
export function MfaEnroll({ email, onDone, onLogout }: { email: string; onDone: () => void; onLogout: () => void }) {
  const [step, setStep] = useState<'totp' | 'backup'>('totp');
  const [secret, setSecret] = useState('');
  const [otpauth, setOtpauth] = useState('');
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [totpErr, setTotpErr] = useState('');
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void (async () => {
      try {
        const res = await api<{ secret: string; otpauth: string }>('/auth/totp/setup', { body: {} });
        setSecret(res.secret);
        setOtpauth(res.otpauth);
        setQrDataUrl(await QRCode.toDataURL(res.otpauth, { margin: 1, width: 296 }));
      } catch (e) {
        // 已啟用（競態）→ 直接放行
        if (e instanceof ApiError && e.code === 'totp_already_enabled') onDone();
        else setTotpErr(errText(e));
      }
    })();
  }, [onDone]);

  const verify = async (code: string) => {
    setTotpErr('');
    try {
      const res = await api<{ backupCodes: string[] }>('/auth/totp/verify', { body: { code } });
      setBackupCodes(res.backupCodes);
      setStep('backup');
    } catch (e) {
      setTotpErr(errText(e));
    }
  };

  const downloadBackup = () => {
    const blob = new Blob(
      [`Miseroda Mail 備援碼 — ${email}\n每組僅能使用一次，請妥善保存。\n\n${backupCodes.join('\n')}\n`],
      { type: 'text/plain' },
    );
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'miseroda-backup-codes.txt';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <AuthShell step={step === 'totp' ? 0 : 1} totalSteps={2}>
      {step === 'totp' && (
        <div>
          <h1 className="auth-title">啟用兩步驟驗證</h1>
          <p className="auth-sub">{email} — 本信箱規定必須設定 TOTP 才能使用。用驗證器 App 掃描下方 QR code。</p>
          {qrDataUrl
            ? <img src={qrDataUrl} alt="TOTP QR code" style={{ width: 148, height: 148, display: 'block', margin: '0 auto', borderRadius: 12 }} />
            : <div className="qr-placeholder">QR code 產生中…</div>}
          {secret && (
            <p style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', margin: '10px 0 18px', fontFamily: 'var(--font-mono)', wordBreak: 'break-all' }}>
              {secret.replace(/(.{4})/g, '$1 ').trim()}
            </p>
          )}
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', textAlign: 'center', margin: '0 0 10px' }}>輸入 App 顯示的 6 位數代碼確認</p>
          <TotpInput autoFocus onComplete={(c) => void verify(c)} />
          {totpErr && <p style={{ color: 'var(--danger)', fontSize: 13, textAlign: 'center', marginTop: 12 }}>{totpErr}</p>}
          {otpauth && (
            <p style={{ fontSize: 11.5, color: 'var(--text-muted)', textAlign: 'center', marginTop: 14 }}>
              無法掃描？把上方代碼手動輸入驗證器 App。
            </p>
          )}
          <div className="auth-foot">
            <span>不是你的帳號？</span>
            <button className="linklike" onClick={onLogout}>登出</button>
          </div>
        </div>
      )}
      {step === 'backup' && (
        <div>
          <h1 className="auth-title">保存備援碼</h1>
          <p className="auth-sub">遺失裝置時，每組備援碼可使用一次。請存放在安全的地方。</p>
          <div className="backup-codes">
            {backupCodes.map((c) => <span key={c}>{c}</span>)}
          </div>
          <button className="btn btn-secondary" style={{ width: '100%', marginTop: 14 }} onClick={downloadBackup}>
            <Icon name="download" size={15} /> 下載 backup-codes.txt
          </button>
          <button className="btn btn-primary btn-lg" style={{ width: '100%', marginTop: 10 }} onClick={onDone}>
            我已保存，進入收件匣
          </button>
        </div>
      )}
    </AuthShell>
  );
}
