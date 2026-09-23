// F21.1：新信提示音的「該不該響」閘。純邏輯，不碰 DOM/AudioContext。
import { describe, expect, it } from 'vitest';
import {
  CARD_DEVICE_QUERY,
  DEDUPE_WINDOW_MS,
  DEFAULT_SOUND_PREFS,
  SOUND_THROTTLE_MS,
  cardsAllowedFor,
  createNewMailGate,
  normalizeSoundPrefs,
} from '../../src/app/lib/notifySound';

/** 假的 matchMedia：只有 matching 裡列出的查詢會成立。 */
const env = (...matching: string[]) => (q: string) => matching.includes(q);

describe('cardsAllowedFor — 看裝置、不看視窗寬度（Hon 實測：並排縮到 468px 的電腦視窗沒有卡片）', () => {
  it('窄的電腦視窗（寬度 ≤ 920 成立，但有滑鼠）→ 出卡片（舊的寬度判斷在這裡會紅）', () => {
    expect(cardsAllowedFor(env('(max-width: 920px)', CARD_DEVICE_QUERY))).toBe(true);
  });
  it('寬的電腦視窗 → 出卡片', () => {
    expect(cardsAllowedFor(env(CARD_DEVICE_QUERY))).toBe(true);
  });
  it('手機／平板（觸控為主，不能懸停）→ 不出卡片', () => {
    expect(cardsAllowedFor(env('(max-width: 920px)'))).toBe(false);
    expect(cardsAllowedFor(env())).toBe(false);
  });
});

const ev = (over: Partial<Parameters<ReturnType<typeof createNewMailGate>['admit']>[0]> = {}) => ({
  id: 'm1',
  from: '陳柏翰',
  watching: false,
  visible: false,
  enabled: true,
  cardEnabled: true,
  now: 1_000_000,
  ...over,
});

describe('normalizeSoundPrefs', () => {
  it('預設是關的——不主動對使用者發出聲音', () => {
    expect(DEFAULT_SOUND_PREFS.on).toBe(false);
  });

  it('壞資料一律回預設，不丟例外', () => {
    expect(normalizeSoundPrefs(null)).toEqual(DEFAULT_SOUND_PREFS);
    expect(normalizeSoundPrefs('nope')).toEqual(DEFAULT_SOUND_PREFS);
    expect(normalizeSoundPrefs({})).toEqual(DEFAULT_SOUND_PREFS);
    expect(normalizeSoundPrefs({ on: 'yes' })).toEqual(DEFAULT_SOUND_PREFS);
  });

  it('音量夾在 0–1；NaN 退回預設', () => {
    expect(normalizeSoundPrefs({ on: true, vol: 5 }).vol).toBe(1);
    expect(normalizeSoundPrefs({ on: true, vol: -2 }).vol).toBe(0);
    expect(normalizeSoundPrefs({ on: true, vol: Number.NaN }).vol).toBe(DEFAULT_SOUND_PREFS.vol);
    expect(normalizeSoundPrefs({ on: true, vol: 0.7 })).toEqual({ on: true, vol: 0.7 });
  });
});

describe('createNewMailGate — 時機', () => {
  it('沒看著分頁 + 已開啟 → 響', () => {
    expect(createNewMailGate().admit(ev())).toEqual({ duplicate: false, sound: true, card: false });
  });

  it('正看著分頁 → 不響（Hon 2026-09-21 定案的時機規則）', () => {
    expect(createNewMailGate().admit(ev({ watching: true })).sound).toBe(false);
  });

  it('提示音關閉 → 不響', () => {
    expect(createNewMailGate().admit(ev({ enabled: false })).sound).toBe(false);
  });
});

describe('createNewMailGate — 只有留在收件匣的信才吵人', () => {
  // worker 的 notifyUser 對「規則自動歸檔／垃圾信／待審信」不帶 push payload，
  // 廣播裡就沒有 from —— 前端必須沿用同一條判準，否則垃圾信也會叮一聲。
  it('沒有寄件者（＝沒留在收件匣）→ 不響也不出卡片', () => {
    const g = createNewMailGate();
    expect(g.admit(ev({ from: undefined }))).toEqual({ duplicate: false, sound: false, card: false });
    expect(g.admit(ev({ id: 'x', from: undefined, watching: true, visible: true })).card).toBe(false);
  });

  it('被擋下的那封不佔用節流額度——下一封真的該響的仍然響', () => {
    const g = createNewMailGate();
    g.admit(ev({ id: 'spam', from: undefined, now: 1000 }));
    expect(g.admit(ev({ id: 'real', now: 1001 })).sound).toBe(true);
  });
});

describe('createNewMailGate — 站內卡片（F21.4；2026-09-22 改為「看得到就出」）', () => {
  it('看著分頁（可見＋有焦點）→ 出卡片、不出聲', () => {
    expect(createNewMailGate().admit(ev({ watching: true, visible: true }))).toEqual({ duplicate: false, sound: false, card: true });
  });

  // Hon 實際遇到：看得到信箱、但焦點在別的 App → 舊規則判成沒在看 → 不出卡片；提示音又預設關 → 什麼都沒有。
  // 舊邏輯（card = watching）這則會紅。
  it('看得到但焦點在別處 → 卡片與聲音都出', () => {
    expect(createNewMailGate().admit(ev({ watching: false, visible: true }))).toEqual({ duplicate: false, sound: true, card: true });
  });

  it('同上但提示音沒開 → 仍然出卡片（不會再「什麼都沒有」）', () => {
    expect(createNewMailGate().admit(ev({ watching: false, visible: true, enabled: false }))).toEqual({ duplicate: false, sound: false, card: true });
  });

  it('分頁隱藏 → 只出聲、不出卡片（看不到的東西沒必要畫）', () => {
    expect(createNewMailGate().admit(ev({ watching: false, visible: false }))).toEqual({ duplicate: false, sound: true, card: false });
  });

  it('手機（cardEnabled=false）→ 永遠不出卡片', () => {
    expect(createNewMailGate().admit(ev({ watching: true, visible: true, cardEnabled: false })).card).toBe(false);
  });

  it('提示音關著也照出卡片——兩者是獨立的開關', () => {
    expect(createNewMailGate().admit(ev({ watching: true, visible: true, enabled: false })).card).toBe(true);
  });
});

describe('createNewMailGate — 去重（WS 與 SW 兩路）', () => {
  it('同一封信在窗內重複抵達 → 第二次判為 duplicate 且不響', () => {
    const g = createNewMailGate();
    expect(g.admit(ev({ now: 1000 })).sound).toBe(true);
    const second = g.admit(ev({ now: 1000 + DEDUPE_WINDOW_MS - 1 }));
    expect(second).toEqual({ duplicate: true, sound: false, card: false });
  });

  it('超過去重窗的同一封信不再算重複', () => {
    const g = createNewMailGate();
    g.admit(ev({ now: 1000 }));
    const later = g.admit(ev({ now: 1000 + DEDUPE_WINDOW_MS + 1 }));
    expect(later.duplicate).toBe(false);
  });

  it('不同信件 id 不互相去重', () => {
    const g = createNewMailGate();
    expect(g.admit(ev({ id: 'a', now: 1000 })).duplicate).toBe(false);
    expect(g.admit(ev({ id: 'b', now: 1000 })).duplicate).toBe(false);
  });

  it('沒有 id（舊版推播）→ 不去重，只走節流', () => {
    const g = createNewMailGate();
    expect(g.admit(ev({ id: undefined, now: 1000 })).duplicate).toBe(false);
    expect(g.admit(ev({ id: undefined, now: 1001 })).duplicate).toBe(false);
  });

  it('重複事件不會吃掉節流額度——去重先判，lastSoundAt 不被推進', () => {
    const g = createNewMailGate();
    g.admit(ev({ id: 'a', now: 1000 })); // 響
    g.admit(ev({ id: 'a', now: 1500 })); // 重複，忽略
    // 另一封信在節流窗內 → 仍該被節流擋下（證明重複那次沒有重設計時器）
    expect(g.admit(ev({ id: 'b', now: 1000 + SOUND_THROTTLE_MS - 1 })).sound).toBe(false);
    expect(g.admit(ev({ id: 'c', now: 1000 + SOUND_THROTTLE_MS })).sound).toBe(true);
  });
});

describe('createNewMailGate — 節流', () => {
  it('同一批十封信只響一次', () => {
    const g = createNewMailGate();
    const played = Array.from({ length: 10 }, (_, i) => g.admit(ev({ id: `m${i}`, now: 1000 + i * 10 })).sound);
    expect(played.filter(Boolean)).toHaveLength(1);
    expect(played[0]).toBe(true);
  });

  it('節流窗過了就能再響', () => {
    const g = createNewMailGate();
    g.admit(ev({ id: 'a', now: 1000 }));
    expect(g.admit(ev({ id: 'b', now: 1000 + SOUND_THROTTLE_MS })).sound).toBe(true);
  });

  it('被時機擋下（正在看）不會佔用節流額度', () => {
    const g = createNewMailGate();
    expect(g.admit(ev({ id: 'a', watching: true, now: 1000 })).sound).toBe(false);
    expect(g.admit(ev({ id: 'b', now: 1001 })).sound).toBe(true);
  });
});
