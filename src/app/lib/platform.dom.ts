// readPwaState：從瀏覽器 globals 算 PwaState。
// 刻意與純函式 platform.ts 分離 —— 這支碰 navigator/window，不可被 worker 測試 import
// （worker tsconfig 無 DOM lib，會讓 worker typecheck 紅）。純邏輯/單測在 platform.ts。
import { detectIOS, isIOSSafari, type PwaState } from './platform';

/** 從 runtime globals 計算 PwaState；無 navigator/window（SSR）時回全 false。 */
export function readPwaState(): PwaState {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') {
    return { ios: false, standalone: false, iosSafari: false };
  }
  const ua = navigator.userAgent;
  const platform = navigator.platform ?? '';
  const touch = navigator.maxTouchPoints ?? 0;
  const standalone =
    window.matchMedia?.('(display-mode: standalone)')?.matches === true ||
    (navigator as unknown as { standalone?: boolean }).standalone === true;
  return { ios: detectIOS(ua, platform, touch), standalone, iosSafari: isIOSSafari(ua, platform, touch) };
}
