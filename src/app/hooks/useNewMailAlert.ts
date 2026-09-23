// 新信提示的接線（批次二十一 F21.2 提示音 ＋ F21.4 站內卡片）。
// 新信事件會從**兩條路**進來，這支把兩路收斂到同一個閘：
//   ① WebSocket（useRealtime）—— 分頁前景、或剛隱藏不到 60 秒時
//   ② Service Worker push 的 postMessage —— 分頁隱藏超過 60 秒、WS 已被 F7.8 主動關掉時
//      （沒有這條，「只在沒看著分頁時才響」會在最需要的情境永遠不響）
//
// 卡片：畫面看得到就出（不看焦點；`sw.js` 對可見視窗會抑制系統通知，這張卡片補的正是那一格）。
// 聲音：沒在看（分頁隱藏、或焦點在別的 App）才響。判斷全在純模組 notifySound.ts 的閘裡，可單測。
import { useCallback, useEffect, useRef, useState } from 'react';
import { createNewMailGate, type NewMailGate } from '../lib/notifySound';
import { cardsEnabled, isTabVisible, isWatchingTab, loadSoundPrefs, playChime } from '../lib/notifySound.dom';
import type { NewMailWire } from './useRealtime';

export type { NewMailWire };

/** 卡片顯示時間。比吐司長一些——它帶兩顆動作鈕，太短會來不及按。 */
export const CARD_MS = 5_000;

export interface NewMailAlert {
  id?: string;
  from: string;
  subject: string;
  /** 這張卡片顯示期間又來了幾封。避免一口氣十封只看到最後一封。 */
  extra: number;
}

export function useNewMailAlert(): {
  onNewMail: (ev: NewMailWire) => void;
  alert: NewMailAlert | null;
  dismiss: () => void;
  /** 滑鼠移入時暫停倒數，移出再續——正在讀的卡片不該中途消失。 */
  hold: (on: boolean) => void;
} {
  const gateRef = useRef<NewMailGate | null>(null);
  if (!gateRef.current) gateRef.current = createNewMailGate();

  const [alert, setAlert] = useState<NewMailAlert | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const heldRef = useRef(false);

  const clearTimer = () => {
    if (timerRef.current !== undefined) {
      clearTimeout(timerRef.current);
      timerRef.current = undefined;
    }
  };

  const arm = useCallback(() => {
    clearTimer();
    if (heldRef.current) return;
    timerRef.current = setTimeout(() => {
      timerRef.current = undefined;
      setAlert(null);
    }, CARD_MS);
  }, []);

  const dismiss = useCallback(() => {
    clearTimer();
    setAlert(null);
  }, []);

  const hold = useCallback(
    (on: boolean) => {
      heldRef.current = on;
      if (on) clearTimer();
      else arm();
    },
    [arm],
  );

  const onNewMail = useCallback(
    (ev: NewMailWire) => {
      const prefs = loadSoundPrefs();
      const decision = gateRef.current!.admit({
        id: ev.id,
        from: ev.from,
        watching: isWatchingTab(),
        visible: isTabVisible(),
        enabled: prefs.on,
        cardEnabled: cardsEnabled(),
        now: Date.now(),
      });
      if (decision.sound) playChime(prefs.vol);
      if (decision.card && ev.from) {
        const from = ev.from;
        setAlert((prev) => ({ id: ev.id, from, subject: ev.subject || '(無主旨)', extra: prev ? prev.extra + 1 : 0 }));
        arm();
      }
    },
    [arm],
  );

  // SW push → 還活著的分頁。內容沿用推播 payload（title＝寄件者、body＝主旨）。
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    const onMessage = (ev: MessageEvent) => {
      const data = ev.data as { type?: string; id?: string; title?: string; body?: string } | null;
      if (!data || data.type !== 'new-mail') return;
      onNewMail({ id: data.id, from: data.title, subject: data.body });
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [onNewMail]);

  useEffect(() => clearTimer, []);

  return { onNewMail, alert, dismiss, hold };
}
