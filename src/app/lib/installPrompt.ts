// F7.5：Android/桌面 A2HS（Add to Home Screen）自訂安裝提示。
// 瀏覽器只在符合 PWA 安裝條件時觸發 beforeinstallprompt；我們攔下它、改由自家卡片在合適時機
// 呼叫 prompt()。iOS 不觸發此事件（走既有「加入主畫面」引導，shouldShowIOSInstallGuide）。
import { useSyncExternalStore } from 'react';

// 標準 DOM lib 尚未含此型別 → 本地宣告最小介面。
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const DISMISS_KEY = 'miseroda_install_dismissed';
const INSTALLED_KEY = 'miseroda_installed';

let deferred: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();
function emit(): void {
  for (const l of listeners) l();
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // 阻止瀏覽器預設 mini-infobar，改由我們的卡片觸發
    deferred = e as BeforeInstallPromptEvent;
    emit();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    try {
      localStorage.setItem(INSTALLED_KEY, '1');
    } catch {
      /* private mode */
    }
    emit();
  });
}

function lsFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}
function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    (navigator as { standalone?: boolean }).standalone === true
  );
}

/** 是否該顯示自訂安裝卡：有可用的 prompt + 尚未安裝 + 未被使用者關閉過。 */
export function canInstall(): boolean {
  return !!deferred && !isStandalone() && !lsFlag(INSTALLED_KEY) && !lsFlag(DISMISS_KEY);
}

export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  if (!deferred) return 'unavailable';
  const e = deferred;
  deferred = null; // beforeinstallprompt 一次性：prompt() 用過即失效
  emit();
  try {
    await e.prompt();
    const { outcome } = await e.userChoice;
    return outcome;
  } catch {
    return 'dismissed';
  }
}

export function dismissInstall(): void {
  try {
    localStorage.setItem(DISMISS_KEY, '1');
  } catch {
    /* private mode */
  }
  emit();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** React hook：是否可顯示安裝卡（隨 beforeinstallprompt / appinstalled / 關閉 即時變化）。 */
export function useCanInstall(): boolean {
  return useSyncExternalStore(subscribe, canInstall, () => false);
}
