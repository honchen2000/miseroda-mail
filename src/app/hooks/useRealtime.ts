// 即時收件：WebSocket 連 worker 的 UserHub DO，新信抵達立即刷新查詢
// 斷線指數退避重連；30s ping 保活（配合 DO hibernation）；分頁隱藏時不重連省資源
import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';

/** 新信廣播的內容。沒有 `from` ＝這封沒留在收件匣（規則歸檔／垃圾／待審），不該吵人。 */
export interface NewMailWire {
  id?: string;
  from?: string;
  subject?: string;
}

export function useRealtime(enabled: boolean, onNewMail?: (ev: NewMailWire) => void): void {
  const qc = useQueryClient();
  const wsRef = useRef<WebSocket | null>(null);
  // 放 ref 而不是進 effect deps：呼叫端每次 render 給新函式也不該害我們重連。
  const onNewMailRef = useRef(onNewMail);
  onNewMailRef.current = onNewMail;

  useEffect(() => {
    if (!enabled) return;
    let closed = false;
    let retry = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let pingTimer: ReturnType<typeof setInterval> | undefined;
    let hideTimer: ReturnType<typeof setTimeout> | undefined;
    let intentionalClose = false; // F7.8：背景主動關 socket（非斷線）→ onclose 不要退避重連

    const connect = () => {
      if (closed) return;
      // 冪等：已有開啟/連線中的 socket 就不重複連（避免 onclose 等待前景重連 與 visibilitychange 重連 雙開）。
      const existing = wsRef.current;
      if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) return;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/api/v1/realtime`);
      wsRef.current = ws;

      ws.onopen = () => {
        retry = 0;
        pingTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send('ping');
        }, 30_000);
      };
      ws.onmessage = (ev) => {
        if (ev.data === 'pong') return;
        void qc.invalidateQueries({ queryKey: ['messages'] });
        void qc.invalidateQueries({ queryKey: ['counts'] });
        // 開著的那串也要重抓：① 同串來了新回信可即時出現；② 剛收到就被點開、內文還在 queue 裡
        // 消化的信（processing），consumer 做完推播時即可補上內容。
        void qc.invalidateQueries({ queryKey: ['thread'] });
        try {
          const msg = JSON.parse(String(ev.data)) as { type?: string } & NewMailWire;
          if (msg.type === 'refresh') void qc.invalidateQueries({ queryKey: ['outbox'] });
          if (msg.type === 'reaction') void qc.invalidateQueries({ queryKey: ['thread'] }); // F11.1：對方按了 emoji
          // F21.2：新信提示音。只有 new-mail 會出聲（snooze-wake / security 另有其通知管道）。
          if (msg.type === 'new-mail') onNewMailRef.current?.({ id: msg.id, from: msg.from, subject: msg.subject });
        } catch {
          /* 非 JSON 訊息一律當 refresh */
        }
      };
      ws.onclose = () => {
        if (pingTimer) clearInterval(pingTimer);
        if (closed) return;
        // F7.8：背景主動關閉 → 不退避重連；回前景由 visibilitychange 立即重連（省電）。
        if (intentionalClose) {
          intentionalClose = false;
          return;
        }
        // 退避 1s→2s→4s…上限 30s。可見才連；隱藏時不主動連，回前景由下方 onVisibility 重連
        // —— 不再於此各自註冊 visibilitychange listener（避免每次隱藏退避累積、卸載時殘留洩漏）。
        const delay = Math.min(30_000, 1000 * 2 ** retry);
        retry += 1;
        reconnectTimer = setTimeout(() => {
          if (document.visibilityState === 'visible') connect();
        }, delay);
      };
      ws.onerror = () => ws.close();
    };

    // F7.8：背景超過 60s 才真關 socket（短暫切分頁不斷線、避免重連開銷）；背景靠 push 通知，省電。
    const onVisibility = () => {
      if (document.hidden) {
        if (!hideTimer) {
          hideTimer = setTimeout(() => {
            hideTimer = undefined;
            const ws = wsRef.current;
            if (document.hidden && ws && ws.readyState === WebSocket.OPEN) {
              intentionalClose = true;
              retry = 0; // 主動關不算失敗，回前景立即重連
              ws.close();
            }
          }, 60_000);
        }
      } else {
        if (hideTimer) {
          clearTimeout(hideTimer);
          hideTimer = undefined;
        }
        const ws = wsRef.current;
        // 回前景且 socket 已關 → 立即重連；並順手 invalidate 一次，對齊斷線期間可能錯過的新信/計數
        if (!closed && (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING)) {
          connect();
          void qc.invalidateQueries({ queryKey: ['messages'] });
          void qc.invalidateQueries({ queryKey: ['counts'] });
          void qc.invalidateQueries({ queryKey: ['thread'] });
        }
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    connect();
    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (pingTimer) clearInterval(pingTimer);
      if (hideTimer) clearTimeout(hideTimer);
      document.removeEventListener('visibilitychange', onVisibility);
      wsRef.current?.close();
    };
  }, [enabled, qc]);
}
