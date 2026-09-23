// 新信提示音的發聲層（批次二十一 F21.1）。碰 AudioContext / document → 不可被 worker 測試 import
// （worker tsconfig 無 DOM lib）。純邏輯與單測在 notifySound.ts。
//
// 音色：三音琶音 C6-E6-G6 上行（Hon 2026-09-21 從四個候選中選定）。
// **刻意用 Web Audio 即時合成，不放任何音檔**：不佔 bundle、離線可用、音量與音色可調；
// 代價是音色不如錄音豐富（合成出來就是純電子鐘琴）。
//
// 自動播放限制：瀏覽器規定頁面要先有使用者互動才能出聲。所以設定頁按下開關／試聽時
// 會呼叫 unlockChime() 建立並 resume AudioContext；之後同一個分頁就能在收信時直接發聲。
// Safari 較嚴，這條只能實機驗。
import { DEFAULT_SOUND_PREFS, SOUND_PREFS_KEY, cardsAllowedFor, normalizeSoundPrefs, type SoundPrefs } from './notifySound';

type AudioCtor = typeof AudioContext;

let ctx: AudioContext | null = null;

function audioCtor(): AudioCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as Window & { webkitAudioContext?: AudioCtor };
  return window.AudioContext ?? w.webkitAudioContext ?? null;
}

/**
 * 取得（必要時建立）AudioContext 並嘗試 resume。
 * 在使用者手勢裡呼叫才保證成功 —— 設定頁的開關／試聽鈕會呼叫，等於順手解鎖這個分頁。
 */
export function unlockChime(): void {
  const Ctor = audioCtor();
  if (!Ctor) return;
  try {
    if (!ctx) ctx = new Ctor();
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
  } catch {
    /* 不支援或被政策擋 → 安靜降級，收信時就是沒聲音 */
  }
}

/** 一個帶指數衰減包絡的正弦音（含泛音），用來合出鐘琴質感。 */
function tone(c: AudioContext, at: number, freq: number, dur: number, amp: number, partials: [number, number][]): void {
  for (const [mult, weight] of partials) {
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq * mult;
    const peak = amp * weight;
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(peak, at + 0.006);
    // 指數衰減不能收到 0（Web Audio 規範），收到極小值即可。
    gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    osc.connect(gain);
    gain.connect(c.destination);
    osc.start(at);
    osc.stop(at + dur + 0.02);
  }
}

/** C6 / E6 / G6，依序錯開 75ms。 */
const ARPEGGIO_HZ = [1046.5, 1318.5, 1568] as const;
const PARTIALS: [number, number][] = [
  [1, 1],
  [2, 0.28],
  [4, 0.1],
];

/** 播一次提示音。vol 0–1；未解鎖／不支援時安靜略過。 */
export function playChime(vol: number): void {
  const v = Math.min(1, Math.max(0, vol));
  if (v <= 0) return;
  unlockChime();
  const c = ctx;
  if (!c) return;
  try {
    const t0 = c.currentTime + 0.02;
    ARPEGGIO_HZ.forEach((hz, i) => {
      tone(c, t0 + i * 0.075, hz, 0.5, 0.32 * v, PARTIALS);
    });
  } catch {
    /* 發聲失敗不該影響收信流程 */
  }
}

/**
 * 使用者是不是正看著這個分頁。
 * `document.hidden` 只涵蓋切分頁／最小化，**不涵蓋「視窗還看得見但焦點在別的 App」** ——
 * 後者正是最需要提示音的情境，所以一併用 hasFocus()。
 */
export function isWatchingTab(): boolean {
  if (typeof document === 'undefined') return false;
  if (document.hidden) return false;
  return typeof document.hasFocus === 'function' ? document.hasFocus() : true;
}

/** 分頁畫面是否可見（不看焦點）。決定站內卡片要不要出（Hon 2026-09-22 定案：看得到就出）。 */
export function isTabVisible(): boolean {
  if (typeof document === 'undefined') return false;
  return !document.hidden;
}

/**
 * 站內新信卡片可不可以出現（F21.4）。手機／平板（以觸控為主）不出：有系統通知、手指操作易被擋到。
 * ⚠️ 看裝置、不看視窗寬度——窄的電腦視窗照樣出（判斷在 notifySound.ts 的 cardsAllowedFor）。
 */
export function cardsEnabled(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return cardsAllowedFor((q) => window.matchMedia(q).matches);
}

export function loadSoundPrefs(): SoundPrefs {
  try {
    const raw = localStorage.getItem(SOUND_PREFS_KEY);
    return raw ? normalizeSoundPrefs(JSON.parse(raw)) : { ...DEFAULT_SOUND_PREFS };
  } catch {
    return { ...DEFAULT_SOUND_PREFS };
  }
}

export function saveSoundPrefs(prefs: SoundPrefs): void {
  try {
    localStorage.setItem(SOUND_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* localStorage 不可用時僅本次生效 */
  }
}
