// 全域 tooltip：單一 portal 元素 + document 事件委派。
// 任何元素只要加 data-tooltip="文字" 就自動有精美提示，零額外程式碼、零額外節點。
// 設計：滑鼠停留 ~400ms 才顯示（暖手期內相鄰按鈕立即顯示）；移開/點擊/捲動/Esc 立即收；
// 預設置於按鈕上方，空間不足自動翻下方並夾在視窗內；鍵盤 focus 也顯示；觸控不觸發。
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const SHOW_DELAY = 400; // ms：刻意延遲，避免滑過就閃
const WARM_GRACE = 150; // ms：剛收起後移到相鄰按鈕即時顯示（同主流設計系統）
const FADE_MS = 160; // 與 CSS 淡出時間一致，淡出後才卸載節點
const POINTER_FOCUS_WINDOW = 350; // ms：此窗內的 focus 視為指標（滑鼠/觸控）觸發，不顯示，只留鍵盤
const GAP = 8; // tooltip 與按鈕的間距
const EDGE = 8; // 與視窗邊緣的最小留白

type Placement = 'top' | 'bottom';
interface Pos {
  x: number;
  y: number;
  placement: Placement;
  arrowLeft: number;
}

/** 掛在 app 根部一次即可（見 main.tsx）。本身不渲染任何可見內容，只負責提示層。 */
export function TooltipProvider() {
  const [content, setContent] = useState<string | null>(null);
  const [pos, setPos] = useState<Pos | null>(null);
  const [shown, setShown] = useState(false);
  const [nonce, setNonce] = useState(0); // 每次 present 遞增 → 即使文字相同也重新定位

  const tipRef = useRef<HTMLDivElement | null>(null);
  const anchorRef = useRef<HTMLElement | null>(null); // 目前對應的觸發元素（pending 或顯示中）
  const showTimer = useRef<number | null>(null);
  const hideTimer = useRef<number | null>(null);
  const lastHideAt = useRef(0);
  const lastPointerDownAt = useRef(0);
  const wantShown = useRef(false); // 真正想顯示嗎（hide 後攔截殘留的 rAF，避免回閃）
  const shownByFocus = useRef(false); // 由鍵盤 focus 顯示？是的話不因滑鼠離開而收（靠 focusout）

  const clearShowTimer = () => {
    if (showTimer.current != null) {
      clearTimeout(showTimer.current);
      showTimer.current = null;
    }
  };
  const clearHideTimer = () => {
    if (hideTimer.current != null) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  };

  // 立即顯示某元素的提示（已先在 anchorRef 標定）
  const present = useCallback((el: HTMLElement) => {
    // 觸發元素已消失或已被新的對象取代 → 放棄；若仍掛著它就清掉，避免卡住下一次 hover
    if (el !== anchorRef.current || !el.isConnected) {
      if (anchorRef.current === el) anchorRef.current = null;
      return;
    }
    const text = el.getAttribute('data-tooltip');
    if (!text || !text.trim()) {
      anchorRef.current = null;
      return;
    }
    clearHideTimer();
    wantShown.current = true;
    setContent(text);
    setPos(null); // 先以未定位狀態渲染 → useLayoutEffect 量到尺寸後才定位
    setShown(false);
    setNonce((n) => (n + 1) % 1_000_000);
  }, []);

  const hide = useCallback(() => {
    clearShowTimer();
    if (anchorRef.current) {
      anchorRef.current = null;
      lastHideAt.current = Date.now();
    }
    wantShown.current = false;
    setShown(false);
    clearHideTimer();
    hideTimer.current = window.setTimeout(() => {
      setContent(null);
      setPos(null);
    }, FADE_MS);
  }, []);

  // 量到 tooltip 真實尺寸後計算定位（依 nonce：每次 present 都重算）
  useLayoutEffect(() => {
    if (content == null || !anchorRef.current || !tipRef.current) return;
    const r = anchorRef.current.getBoundingClientRect();
    const tw = tipRef.current.offsetWidth;
    const th = tipRef.current.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let placement: Placement = 'top';
    let y = r.top - th - GAP;
    if (y < EDGE) {
      placement = 'bottom';
      y = r.bottom + GAP;
      if (y + th > vh - EDGE) y = Math.max(EDGE, vh - EDGE - th);
    }
    let x = r.left + r.width / 2 - tw / 2;
    x = Math.max(EDGE, Math.min(x, vw - EDGE - tw));
    let arrowLeft = r.left + r.width / 2 - x;
    arrowLeft = Math.max(12, Math.min(arrowLeft, tw - 12));

    setPos({ x, y, placement, arrowLeft });
  }, [nonce, content]);

  // 定位完成的下一影格才淡入（期間若已 hide 則不再顯示，避免殘留 rAF 回閃）
  useEffect(() => {
    if (!pos) return;
    const id = requestAnimationFrame(() => {
      if (wantShown.current) setShown(true);
    });
    return () => cancelAnimationFrame(id);
  }, [pos]);

  // 顯示中偵測 anchor 被 React 卸載（背景刷新/即時推播會 out-of-band 重繪列表，不會發 pointerout）
  useEffect(() => {
    if (content == null) return;
    const obs = new MutationObserver(() => {
      const a = anchorRef.current;
      if (a && !a.isConnected) hide();
    });
    obs.observe(document.body, { childList: true, subtree: true });
    return () => obs.disconnect();
  }, [content, hide]);

  // document 事件委派（掛載一次）
  useEffect(() => {
    const closestTip = (node: EventTarget | null): HTMLElement | null => {
      const el = node as Element | null;
      if (!el || typeof el.closest !== 'function') return null;
      return el.closest<HTMLElement>('[data-tooltip]');
    };

    const requestShow = (el: HTMLElement) => {
      if (el === anchorRef.current) return; // 已對此元素（pending 或顯示中）
      clearShowTimer();
      shownByFocus.current = false;
      anchorRef.current = el;
      const delay = Date.now() - lastHideAt.current < WARM_GRACE ? 0 : SHOW_DELAY;
      showTimer.current = window.setTimeout(() => {
        showTimer.current = null;
        present(el);
      }, delay);
    };

    const onOver = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return; // 觸控不觸發
      const t = closestTip(e.target);
      if (t) requestShow(t);
    };
    const onOut = (e: PointerEvent) => {
      const t = closestTip(e.target);
      if (!t || t !== anchorRef.current) return;
      const to = e.relatedTarget as Node | null;
      if (to && t.contains(to)) return; // 仍在同一按鈕內部移動
      hide();
    };
    // 安全網：anchor 已不被指標懸停 / 已停用 / 已卸載 → 收起
    // （補 pointerout 漏網：停用按鈕、滑入 iframe 信件、React 換掉節點等）
    // 注意：鍵盤 focus 顯示的提示，滑鼠不在按鈕上是正常的，不可因 :hover=false 而收（靠 focusout/Esc）
    const onMove = () => {
      const a = anchorRef.current;
      if (!a) return;
      if (!a.isConnected || (a as HTMLButtonElement).disabled) {
        hide();
        return;
      }
      if (!shownByFocus.current && !a.matches(':hover')) hide();
    };
    const onFocusIn = (e: FocusEvent) => {
      if (Date.now() - lastPointerDownAt.current < POINTER_FOCUS_WINDOW) return; // 指標觸發的 focus 不顯示
      const t = closestTip(e.target);
      if (!t) return;
      let kbd: boolean;
      try {
        kbd = t.matches(':focus-visible');
      } catch {
        kbd = false; // 不支援 :focus-visible 時保守不顯示（寧可沒提示，也不要點擊就跳）
      }
      if (!kbd) return;
      clearShowTimer();
      shownByFocus.current = true;
      anchorRef.current = t;
      present(t);
    };
    const onFocusOut = (e: FocusEvent) => {
      const t = closestTip(e.target);
      if (t && t === anchorRef.current) hide();
    };
    const onPointerDown = () => {
      lastPointerDownAt.current = Date.now();
      hide();
      lastHideAt.current = 0; // 點擊後再 hover 要等完整延遲，不套暖手
    };
    const onScrollResize = () => {
      hide();
      lastHideAt.current = 0; // 捲動/縮放關閉後不套暖手，避免靜止指標下 ping-pong 回閃
    };
    const onKey = (e: KeyboardEvent) => {
      // Esc 關閉；Enter/Space 觸發按鈕時收起，避免切換鈕顯示過時文字
      if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') hide();
    };

    document.addEventListener('pointerover', onOver);
    document.addEventListener('pointerout', onOut);
    document.addEventListener('pointermove', onMove, { passive: true });
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('scroll', onScrollResize, true); // capture：任何捲動容器都收
    window.addEventListener('resize', onScrollResize);
    window.addEventListener('blur', onScrollResize); // 切走分頁/焦點進 iframe 時收
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerover', onOver);
      document.removeEventListener('pointerout', onOut);
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('scroll', onScrollResize, true);
      window.removeEventListener('resize', onScrollResize);
      window.removeEventListener('blur', onScrollResize);
      document.removeEventListener('keydown', onKey);
      clearShowTimer();
      clearHideTimer();
    };
  }, [present, hide]);

  if (content == null) return null;
  return createPortal(
    <div
      ref={tipRef}
      className="tooltip"
      role="tooltip"
      data-placement={pos?.placement ?? 'top'}
      data-show={shown ? '' : undefined}
      style={
        {
          left: pos ? pos.x : -9999,
          top: pos ? pos.y : -9999,
          '--arrow-left': `${pos ? pos.arrowLeft : 16}px`,
        } as React.CSSProperties
      }>
      {content}
      <span className="tooltip-arrow" aria-hidden="true" />
    </div>,
    document.body,
  );
}
