// 按需開啟的 Modal：自建會議邀請 + AI 草擬新信。從 mail.tsx barrel 抽出，
// 讓 App 可用 React.lazy 拆成獨立 chunk（這兩個 Modal 平時不開、不必進初始 bundle）。
import { useState } from 'react';
import { useAiCompose, useCreateInvite, type Recurrence } from '../api/mail';
import { Icon, Modal, fullTime } from './ui';
import { DateTimeField, Select } from './inputs';

const RECUR_OPTS: { value: Recurrence; label: string }[] = [
  { value: 'none', label: '不重複' },
  { value: 'daily', label: '每天' },
  { value: 'weekly', label: '每週' },
  { value: 'monthly', label: '每月' },
  { value: 'yearly', label: '每年' },
];
const REMIND_OPTS: { value: number | null; label: string }[] = [
  { value: null, label: '不提醒' },
  { value: 0, label: '開始時' },
  { value: 5, label: '5 分鐘前' },
  { value: 15, label: '15 分鐘前' },
  { value: 30, label: '30 分鐘前' },
  { value: 60, label: '1 小時前' },
  { value: 1440, label: '1 天前' },
];

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}
/** Date → datetime-local 的本地時間字串 YYYY-MM-DDThh:mm */
function toLocalInput(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function roundedHour(offsetH: number): string {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + offsetH);
  return toLocalInput(d);
}

/* ---------- 自建會議邀請 Modal ---------- */
export function MeetingModal({ onClose, pushToast }: { onClose: () => void; pushToast: (m: string) => void }) {
  const create = useCreateInvite();
  const [summary, setSummary] = useState('');
  const [start, setStart] = useState(() => roundedHour(1));
  const [end, setEnd] = useState(() => roundedHour(2));
  const [location, setLocation] = useState('');
  const [attendees, setAttendees] = useState('');
  const [description, setDescription] = useState('');
  const [recurrence, setRecurrence] = useState<Recurrence>('none');
  const [reminderMin, setReminderMin] = useState<number | null>(null);

  const emails = attendees.split(/[,，;\s]+/).map((s) => s.trim()).filter(Boolean);
  const validEmails = emails.filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  const timeOk = Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs;
  // 與會者可留空（= 個人事件，只入自己行事曆）；但填了就不能有格式錯的
  const emailsOk = validEmails.length === emails.length;
  const isPersonal = validEmails.length === 0;
  const canSend = !!summary.trim() && emailsOk && timeOk && !create.isPending;

  const submit = () => {
    if (!canSend) return;
    create.mutate(
      {
        summary: summary.trim(),
        attendees: validEmails,
        startMs,
        endMs,
        location: location.trim() || undefined,
        description: description.trim() || undefined,
        whenText: `${fullTime(startMs)} – ${fullTime(endMs)}`,
        recurrence,
        reminderMin,
      },
      {
        onSuccess: (r) => {
          pushToast(r.attendees > 0 ? `會議邀請已寄給 ${r.attendees} 位與會者 📅` : '事件已加入行事曆 📅');
          onClose();
        },
      },
    );
  };

  return (
    <Modal title="新增行程" desc="留空與會者 = 個人事件（只入自己行事曆）；填了則寄出 .ics 邀請。" onClose={onClose} width={540}>
      <div className="field">
        <label>標題</label>
        <input className="input" value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="例如：專案啟動會議" autoFocus />
      </div>
      <div style={{ display: 'flex', gap: 10 }}>
        <div className="field" style={{ flex: 1 }}>
          <label>開始</label>
          <DateTimeField value={start} onChange={setStart} ariaLabel="開始時間" />
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label>結束</label>
          <DateTimeField value={end} onChange={setEnd} ariaLabel="結束時間" />
        </div>
      </div>
      {!timeOk && (
        <div style={{ fontSize: 12, color: 'var(--danger)' }}>
          {!Number.isFinite(startMs) || !Number.isFinite(endMs) ? '請填寫開始與結束時間' : '結束時間需晚於開始時間'}
        </div>
      )}
      <div style={{ display: 'flex', gap: 10 }}>
        <div className="field" style={{ flex: 1 }}>
          <label>重複</label>
          <Select<Recurrence> value={recurrence} onChange={setRecurrence} options={RECUR_OPTS} ariaLabel="重複" style={{ width: '100%' }} />
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label>提醒</label>
          <Select<number | null> value={reminderMin} onChange={setReminderMin} options={REMIND_OPTS} ariaLabel="提醒" style={{ width: '100%' }} />
        </div>
      </div>
      <div className="field">
        <label>地點（選填）</label>
        <input className="input" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="會議室 / 視訊連結" />
      </div>
      <div className="field">
        <label>與會者 email（選填，可用逗號分隔）</label>
        <input className="input" value={attendees} onChange={(e) => setAttendees(e.target.value)} placeholder="a@example.com, b@example.com" />
      </div>
      {emails.length > validEmails.length && <div style={{ fontSize: 12, color: 'var(--danger)' }}>有 email 格式不正確</div>}
      <div className="field">
        <label>說明（選填）</label>
        <textarea className="input" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} style={{ resize: 'vertical' }} />
      </div>
      {create.isError && (
        <div style={{ fontSize: 12, color: 'var(--danger)', marginTop: 4 }}>寄送失敗，請確認與會者 email 是否正確後再試</div>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
        <button className="btn btn-ghost" onClick={onClose}>取消</button>
        <button className="btn btn-primary" disabled={!canSend} onClick={submit}>
          <Icon name={isPersonal ? 'clock' : 'send'} size={14} />{' '}
          {create.isPending ? (isPersonal ? '建立中…' : '寄送中…') : isPersonal ? '建立事件' : '寄出邀請'}
        </button>
      </div>
    </Modal>
  );
}

/* ---------- AI 草擬新信 Modal ---------- */
export function AiComposeModal({ onClose, onDraft }: { onClose: () => void; onDraft: (text: string) => void }) {
  const compose = useAiCompose();
  const [prompt, setPrompt] = useState('');
  const submit = () => {
    if (!prompt.trim() || compose.isPending) return;
    compose.mutate(prompt.trim(), { onSuccess: (r) => { onDraft(r.text); onClose(); } });
  };
  return (
    <Modal title="AI 草擬信件" desc="用一句話描述要寫什麼，AI 幫你擬好正文後開啟撰寫視窗。" onClose={onClose} width={520}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <textarea className="input" rows={4} autoFocus value={prompt} style={{ resize: 'vertical' }}
          placeholder="例如：跟客戶說這週的會議改到下週三下午三點，並為造成不便致歉"
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(); }} />
        {compose.isError && <div style={{ fontSize: 12, color: 'var(--danger)' }}>產生失敗，請再試一次</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn btn-ghost" onClick={onClose}>取消</button>
          <button className="btn btn-primary" disabled={!prompt.trim() || compose.isPending} onClick={submit}>
            <Icon name="sparkle" size={14} /> {compose.isPending ? '生成中…' : '生成草稿'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
