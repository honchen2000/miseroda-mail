import { useSyncExternalStore } from 'react';

export interface ThemePrefs {
  theme: 'dark' | 'light';
  accent: 'green' | 'cyan' | 'violet';
  style: 'dream' | 'crisp';
  density: 'comfortable' | 'compact';
  motion: 'on' | 'off';
  /** 捲軸：auto = 依系統（可能自動隱藏）；always = 永遠顯示（無障礙） */
  scrollbar: 'auto' | 'always';
  /** F6.3：對比。normal = 依系統；high = 手動高對比（拉亮 muted/實心邊框/關 glow，等同 prefers-contrast:more） */
  contrast: 'normal' | 'high';
}

export const THEME_DEFAULTS: ThemePrefs = {
  theme: 'dark',
  accent: 'green',
  style: 'dream',
  density: 'comfortable',
  motion: 'on',
  scrollbar: 'auto',
  contrast: 'normal',
};

const STORAGE_KEY = 'miseroda_theme_v1';

/** F8.3：使用者沒表態過 motion 時，尊重系統 prefers-reduced-motion（明確選擇仍優先——stored 值會蓋過）。 */
function systemDefaults(): ThemePrefs {
  const d = { ...THEME_DEFAULTS };
  try {
    if (typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches) d.motion = 'off';
  } catch {
    /* 無 matchMedia 的環境 → 用預設 */
  }
  return d;
}

function load(): ThemePrefs {
  try {
    return { ...systemDefaults(), ...(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<ThemePrefs>) };
  } catch {
    return systemDefaults();
  }
}

function applyTheme(prefs: ThemePrefs): void {
  const el = document.documentElement;
  el.setAttribute('data-theme', prefs.theme);
  el.setAttribute('data-accent', prefs.accent);
  el.setAttribute('data-style', prefs.style);
  el.setAttribute('data-density', prefs.density);
  el.setAttribute('data-motion', prefs.motion);
  el.setAttribute('data-scrollbar', prefs.scrollbar);
  el.setAttribute('data-contrast', prefs.contrast);
}

/* 模組層級共享 store：root 與設定頁雙向同步（useSyncExternalStore） */
let current: ThemePrefs = load();
applyTheme(current);
const listeners = new Set<() => void>();

export function getThemePrefs(): ThemePrefs {
  return current;
}

/* 主題切換圓形揭幕（動畫 2）：從最後一次點擊座標擴散 */
let lastPointer = { x: innerWidth / 2, y: innerHeight / 3 };
if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', (e) => {
    lastPointer = { x: e.clientX, y: e.clientY };
  }, { passive: true, capture: true });
}

function applyThemeWithReveal(prefs: ThemePrefs): void {
  const doc = document as Document & { startViewTransition?: (cb: () => void) => { ready: Promise<void> } };
  const motionOn = document.documentElement.getAttribute('data-motion') === 'on';
  if (!motionOn || typeof doc.startViewTransition !== 'function') {
    applyTheme(prefs);
    return;
  }
  const { x, y } = lastPointer;
  const r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  const vt = doc.startViewTransition(() => applyTheme(prefs));
  void vt.ready
    .then(() => {
      document.documentElement.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] },
        { duration: 480, easing: 'cubic-bezier(.22,1,.36,1)', pseudoElement: '::view-transition-new(root)' },
      );
    })
    .catch(() => {});
}

/** F8.10：換 accent/主題 → 從最後點擊座標擴散一圈極光漣漪（0.6s bouncy）。motion 關則不做。 */
function auroraRipple(): void {
  if (typeof document === 'undefined') return;
  if (document.documentElement.getAttribute('data-motion') !== 'on') return;
  const { x, y } = lastPointer;
  const el = document.createElement('div');
  el.className = 'aurora-ripple';
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  document.body.appendChild(el);
  el.addEventListener('animationend', () => el.remove(), { once: true });
  setTimeout(() => el.remove(), 900); // 保險：animationend 未觸發也清掉
}

export function setThemePrefs(patch: Partial<ThemePrefs>): void {
  const themeChanged = patch.theme !== undefined && patch.theme !== current.theme;
  const accentChanged = patch.accent !== undefined && patch.accent !== current.accent;
  current = { ...current, ...patch };
  if (themeChanged) applyThemeWithReveal(current);
  else applyTheme(current);
  if (accentChanged) auroraRipple(); // 換色的 delight 時刻（主題切換已有圓形揭幕）
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    /* private mode 等情況忽略 */
  }
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useTheme(): [ThemePrefs, (patch: Partial<ThemePrefs>) => void] {
  const prefs = useSyncExternalStore(subscribe, getThemePrefs);
  return [prefs, setThemePrefs];
}

/** 從伺服器 prefs 套用（登入後同步，server 值優先） */
export function applyServerPrefs(serverPrefs: Record<string, unknown>): void {
  const patch: Partial<ThemePrefs> = {};
  for (const key of ['theme', 'accent', 'style', 'density', 'motion', 'scrollbar', 'contrast'] as const) {
    const v = serverPrefs[key];
    if (typeof v === 'string') (patch as Record<string, string>)[key] = v;
  }
  if (Object.keys(patch).length) setThemePrefs(patch);
}
