// 新信提示音的「該不該響」判斷（批次二十一 F21.1）。
// 純函式、不碰 window/document/AudioContext → 可在 worker vitest 單測
// （CLAUDE.md：被 worker 測試 import 的邏輯要抽純模組；先例 platform.ts / platform.dom.ts）。
// 實際發聲與「有沒有在看分頁」的偵測在 notifySound.dom.ts。
//
// 為什麼需要一個閘：新信事件會從**兩條路**進來 ——
//   ① WebSocket（useRealtime，分頁前景時）
//   ② Service Worker push 的 postMessage（分頁隱藏超過 60 秒、WS 已被 F7.8 主動關掉時）
// 兩路可能同時送同一封信，所以要去重；同一批進來十封信也不該響十次，所以要節流。

/** 提示音偏好。存 localStorage（「要不要出聲」是這台裝置的事，不是帳號設定）。 */
export interface SoundPrefs {
  /** 開關。預設關 —— 不主動對使用者發出聲音。 */
  on: boolean;
  /** 音量 0–1。 */
  vol: number;
}

export const SOUND_PREFS_KEY = 'miseroda_sound_v1';

export const DEFAULT_SOUND_PREFS: SoundPrefs = { on: false, vol: 0.45 };

/** 同一批信連續抵達時，最短出聲間隔。 */
export const SOUND_THROTTLE_MS = 2_000;

/** 同一封信在這個窗內重複抵達（WS 與 SW 兩路）視為重複。 */
export const DEDUPE_WINDOW_MS = 3_000;

/** 去重表上限：避免長時間開著的分頁無上限長大。超過就丟最舊的。 */
const DEDUPE_MAX_ENTRIES = 200;

/** 從 localStorage 讀到的任意值 → 合法偏好（壞資料一律回預設，不丟例外）。 */
export function normalizeSoundPrefs(raw: unknown): SoundPrefs {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_SOUND_PREFS };
  const o = raw as Record<string, unknown>;
  const vol = typeof o.vol === 'number' && Number.isFinite(o.vol) ? Math.min(1, Math.max(0, o.vol)) : DEFAULT_SOUND_PREFS.vol;
  return { on: o.on === true, vol };
}

/**
 * 站內卡片看「裝置」不看「視窗寬度」（2026-09-22 修正，Hon 實測抓到）。
 * 原本用 `(max-width: 920px)` 判斷「手機」→ 電腦視窗並排縮到 468px 也被當成手機、卡片不出。
 * 真正要排除的是「以觸控為主的裝置」（手機／平板有系統通知、手指操作易被卡片擋到），
 * 所以改問主要指標裝置：能懸停且精細（滑鼠／觸控板）＝電腦，不論視窗多窄都出卡片。
 */
export const CARD_DEVICE_QUERY = '(hover: hover) and (pointer: fine)';

/** 傳入 matchMedia 的判斷函式（純函式，方便以假環境單測）。 */
export function cardsAllowedFor(matches: (query: string) => boolean): boolean {
  return matches(CARD_DEVICE_QUERY);
}

export interface NewMailEvent {
  /** 信件 id。兩路去重靠它；沒有 id（舊版推播）就不去重，只走節流。 */
  id?: string;
  /**
   * 寄件者顯示名。**沒有值＝這封信沒有留在收件匣**（規則自動歸檔／垃圾信／待審），
   * 一律不出聲也不出卡片 —— 沿用 worker `notifyUser` 既有的「push 有值才吵人」判準。
   */
  from?: string;
  /** 使用者是不是正看著這個分頁（由 dom 層算：!hidden && hasFocus）。決定**聲音**。 */
  watching: boolean;
  /**
   * 分頁畫面是否可見（由 dom 層算：!hidden，**不看焦點**）。決定**卡片**。
   * 2026-09-22 Hon 定案（甲）：「看得到信箱、但焦點在別的 App」也要出卡片——原本卡片跟聲音共用 watching，
   * 這種情況判成沒在看 → 不出卡片；提示音又預設關 → 什麼都沒有（Hon 實際遇到）。
   */
  visible: boolean;
  /** 提示音是否開啟。 */
  enabled: boolean;
  /** 站內卡片是否可用（手機直接關掉：畫面太窄，且手機有系統通知）。 */
  cardEnabled: boolean;
  now: number;
}

export interface NewMailDecision {
  /** 同一封信在去重窗內重複抵達 → 整個事件忽略。 */
  duplicate: boolean;
  /** 該播提示音。 */
  sound: boolean;
  /** 該顯示站內卡片。 */
  card: boolean;
}

export interface NewMailGate {
  admit(ev: NewMailEvent): NewMailDecision;
}

/**
 * 建立新信事件閘。狀態封裝在閉包裡（每個分頁一個實例）。
 *
 * 時機規則（Hon 2026-09-21 定案）：**只在「沒看著分頁」時才出聲**。
 * 「沒看著」＝分頁隱藏 **或** 視窗沒有焦點 —— 後者是刻意的：瀏覽器視窗還露在螢幕上、
 * 但人在別的 App 裡，`document.hidden` 仍是 false，那正是最需要提示音的情境。
 */
export function createNewMailGate(opts: { throttleMs?: number; dedupeMs?: number } = {}): NewMailGate {
  const throttleMs = opts.throttleMs ?? SOUND_THROTTLE_MS;
  const dedupeMs = opts.dedupeMs ?? DEDUPE_WINDOW_MS;
  const seen = new Map<string, number>();
  let lastSoundAt = Number.NEGATIVE_INFINITY;

  return {
    admit(ev: NewMailEvent): NewMailDecision {
      if (ev.id) {
        const prev = seen.get(ev.id);
        if (prev !== undefined && ev.now - prev < dedupeMs) return { duplicate: true, sound: false, card: false };
        // 先剪掉過期項，再記這一筆；仍超量就丟最舊的（Map 保序）。
        for (const [k, t] of seen) {
          if (ev.now - t >= dedupeMs) seen.delete(k);
        }
        seen.set(ev.id, ev.now);
        while (seen.size > DEDUPE_MAX_ENTRIES) {
          const oldest = seen.keys().next();
          if (oldest.done) break;
          seen.delete(oldest.value);
        }
      }
      // 沒有寄件者＝沒留在收件匣（規則歸檔／垃圾／待審）→ 只刷新列表，不吵人。
      if (!ev.from) return { duplicate: false, sound: false, card: false };
      // 卡片：畫面看得到就出（不看焦點）；聲音：沒在看（隱藏或焦點在別處）才響。
      // 所以「看得到但焦點在別處」兩者都會出；分頁隱藏時只出聲（看不到的東西沒必要畫）。
      const card = ev.cardEnabled && ev.visible;
      if (!ev.enabled || ev.watching) return { duplicate: false, sound: false, card };
      if (ev.now - lastSoundAt < throttleMs) return { duplicate: false, sound: false, card };
      lastSoundAt = ev.now;
      return { duplicate: false, sound: true, card };
    },
  };
}
