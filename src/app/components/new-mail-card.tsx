// 站內新信卡片（F21.4）。畫面看得到就出現（不看焦點，Hon 2026-09-22 定案）——`sw.js` 對可見視窗會抑制系統通知，
// 這張卡片補的正是那一格；分頁隱藏時改由提示音負責（見 useNewMailAlert）。
// 手機不顯示（cardsEnabled 已擋，見 notifySound.dom.ts）。
import { Icon } from './ui';
import type { NewMailAlert } from '../hooks/useNewMailAlert';

export function NewMailCard({ alert, onOpen, onArchive, onDismiss, onHold }: {
  alert: NewMailAlert;
  onOpen: () => void;
  onArchive: () => void;
  onDismiss: () => void;
  onHold: (on: boolean) => void;
}) {
  const initial = alert.from.trim().charAt(0) || '?';
  return (
    <div
      className="newmail-card"
      role="status"
      aria-live="polite"
      onMouseEnter={() => onHold(true)}
      onMouseLeave={() => onHold(false)}
    >
      <div className="newmail-avatar" aria-hidden="true">{initial}</div>
      <div className="newmail-body">
        <div className="newmail-head">
          <span className="newmail-from">{alert.from}</span>
          <button type="button" className="newmail-x" aria-label="關閉新信提示" onClick={onDismiss}>
            <Icon name="x" size={13} />
          </button>
        </div>
        <div className="newmail-subject">{alert.subject}</div>
        {alert.extra > 0 && <div className="newmail-extra">另外還有 {alert.extra} 封新信</div>}
        <div className="newmail-actions">
          <button type="button" className="btn btn-secondary btn-sm" onClick={onOpen}>開啟</button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onArchive}>
            <Icon name="archive" size={13} /> 封存
          </button>
        </div>
      </div>
    </div>
  );
}
