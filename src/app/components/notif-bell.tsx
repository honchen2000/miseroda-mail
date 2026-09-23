// F14.4A：通知中心——鈴鐺 + 下拉。誠實設計：不假造事件流，只彙整「已在追蹤的待辦」
// （跟進到期、待回覆數）。資料源是既有 /followups 與 counts，無新後端。
import { useEffect, useState } from 'react';
import { Icon } from './ui';
import type { FollowUp } from '../api/mail';
import { EMPTY_BELL_SEEN, lowerNeedsReply, markBellSeen, normalizeBellSeen, unseenBadge, type BellSeen } from '../lib/bellSeen';

// 「看過」存本機、依使用者分開（同一台裝置換人登入不會混用）。內容只有跟進 id 與到期時間，不含信件資料。
const seenStorageKey = (userId: string) => `miseroda_bell_seen_v1:${userId}`;
function loadSeen(userId: string): BellSeen {
  try {
    return normalizeBellSeen(JSON.parse(localStorage.getItem(seenStorageKey(userId)) ?? 'null'));
  } catch {
    return { ...EMPTY_BELL_SEEN, keys: [] };
  }
}
function saveSeen(userId: string, seen: BellSeen): void {
  try {
    localStorage.setItem(seenStorageKey(userId), JSON.stringify(seen));
  } catch {
    /* localStorage 不可用時僅本次生效 */
  }
}

function timeLabel(ms: number): string {
  const diff = Date.now() - ms;
  const past = diff >= 0;
  const a = Math.abs(diff);
  const m = Math.round(a / 60000);
  if (m < 60) return past ? `${m} 分前` : `${m} 分後`;
  const h = Math.round(m / 60);
  if (h < 24) return past ? `${h} 小時前` : `${h} 小時後`;
  const d = Math.round(h / 24);
  return past ? `${d} 天前` : `${d} 天後`;
}

export function NotifBell({ followups: followupsIn, needsReply: needsReplyIn, userId, onOpenMessage, onGotoFollowups }: {
  /** undefined＝跟進還沒載入。 */
  followups: FollowUp[] | undefined;
  /** undefined＝計數還沒載入（lowerNeedsReply 不可拿載入中的 0 去調低門檻）。 */
  needsReply: number | undefined;
  userId: string;
  onOpenMessage: (id: string) => void;
  onGotoFollowups: () => void;
}) {
  const [open, setOpen] = useState(false);
  const followups = followupsIn ?? [];
  const needsReply = needsReplyIn ?? 0;
  // 到期（含已 fired 或已過 dueAt）的跟進優先；未到期的也列但不計入紅點
  const now = Date.now();
  const due = followups.filter((f) => f.status === 'fired' || f.dueAt <= now);
  // 2026-09-22 Hon 定案：點開就算看過（見 lib/bellSeen.ts）。清單內容不變，只有數字改成「沒看過的」。
  const [seen, setSeen] = useState<BellSeen>(() => loadSeen(userId));
  const badge = unseenBadge(due, needsReply, seen);
  useEffect(() => {
    const next = lowerNeedsReply(seen, needsReplyIn);
    if (next) {
      setSeen(next);
      saveSeen(userId, next);
    }
  }, [needsReplyIn, seen, userId]);
  const toggle = () => {
    if (!open) {
      const next = markBellSeen(due, needsReply);
      setSeen(next);
      saveSeen(userId, next);
    }
    setOpen(!open);
  };

  return (
    <>
      <button className="notif-bell" aria-label={badge > 0 ? `通知（${badge} 則）` : '通知'}
        data-tooltip="提醒" onClick={toggle}>
        <Icon name="bell" size={18} />
        {badge > 0 && <span className="notif-dot" aria-hidden="true">{badge > 9 ? '9+' : badge}</span>}
      </button>
      {open && (
        <>
          <button className="user-pop-backdrop" aria-label="關閉通知" onClick={() => setOpen(false)}></button>
          <div className="notif-pop" role="dialog" aria-label="提醒">
            <div className="notif-pop-head">提醒</div>
            {needsReply > 0 && (
              <button className="notif-item" onClick={() => { setOpen(false); onGotoFollowups(); }}>
                <Icon name="flag" size={15} />
                <span className="notif-item-body"><b>{needsReply} 封</b>信等你回覆</span>
              </button>
            )}
            {followups.length === 0 && needsReply === 0 && (
              <p className="notif-empty">目前沒有新提醒 🎉</p>
            )}
            {followups.map((f) => (
              <button key={f.id} className="notif-item" onClick={() => { setOpen(false); onOpenMessage(f.messageId); }}>
                <Icon name={f.awaitReply ? 'clock' : 'flag'} size={15} />
                <span className="notif-item-body">
                  <span className="notif-item-sub">{f.subject || '(無主旨)'}</span>
                  <span className="notif-item-time">{f.awaitReply ? '等待回覆 · ' : '跟進 · '}{timeLabel(f.dueAt)}</span>
                </span>
              </button>
            ))}
            {followups.length > 0 && (
              <button className="notif-foot" onClick={() => { setOpen(false); onGotoFollowups(); }}>查看全部跟進</button>
            )}
          </div>
        </>
      )}
    </>
  );
}
