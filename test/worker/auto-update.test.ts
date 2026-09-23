// 背景自動更新的判斷（Hon 2026-09-22 定案甲案）。
import { describe, expect, it } from 'vitest';
import {
  CHUNK_RELOAD_GUARD_MS,
  RESUME_GRACE_MS,
  RESUME_UPDATE_AWAY_MS,
  resumeApplyAllowed,
  resumeUpdateAllowed,
  FALLBACK_PROMPT_AFTER_MS,
  MIN_CHECK_GAP_MS,
  chunkReloadAllowed,
  isSafeMoment,
  shouldCheckNow,
  shouldPromptFallback,
  shouldReloadNow,
} from '../../src/app/lib/autoUpdate';

const page = (over: Partial<{ hidden: boolean; online: boolean; busy: boolean }> = {}) => ({
  hidden: true,
  online: true,
  busy: false,
  ...over,
});

describe('isSafeMoment — 只有「沒被看著＋有網路＋沒在忙」才自動套用', () => {
  it('切走、有網路、沒在忙 → 安全', () => {
    expect(isSafeMoment(page())).toBe(true);
  });
  it('正看著分頁 → 不打擾', () => {
    expect(isSafeMoment(page({ hidden: false }))).toBe(false);
  });
  it('撰寫器開著／對話框／復原倒數（busy）→ 絕不自動更新，即使切走了', () => {
    expect(isSafeMoment(page({ busy: true }))).toBe(false);
  });
  it('離線 → 不重整（重整也載不到新版）', () => {
    expect(isSafeMoment(page({ online: false }))).toBe(false);
  });
});

describe('shouldReloadNow — 新 SW 接管後，每個分頁各自決定', () => {
  it('在這個分頁親手按「立即更新」→ 立刻重整（即使正看著）', () => {
    expect(shouldReloadNow({ ...page({ hidden: false }), userRequested: true })).toBe(true);
  });
  // 舊版：任一分頁接管，所有分頁一律立刻重整 → 另一個正在寫信的分頁會被重整掉。這則在舊邏輯下會紅。
  it('別的分頁觸發的接管、而這個分頁正在寫信 → 不重整，等安全時機', () => {
    expect(shouldReloadNow({ ...page({ hidden: false, busy: true }), userRequested: false })).toBe(false);
    expect(shouldReloadNow({ ...page({ hidden: true, busy: true }), userRequested: false })).toBe(false);
  });
  it('別的分頁觸發的接管、這個分頁正被看著 → 不打擾', () => {
    expect(shouldReloadNow({ ...page({ hidden: false }), userRequested: false })).toBe(false);
  });
  it('別的分頁觸發的接管、這個分頁也在背景且安全 → 一起換新版', () => {
    expect(shouldReloadNow({ ...page(), userRequested: false })).toBe(true);
  });
});

describe('shouldCheckNow — 主動檢查的節流', () => {
  it('從沒檢查過 → 檢查', () => {
    expect(shouldCheckNow(null, 1000)).toBe(true);
  });
  it('一分鐘內剛檢查過 → 不再打', () => {
    expect(shouldCheckNow(1000, 1000 + MIN_CHECK_GAP_MS - 1)).toBe(false);
    expect(shouldCheckNow(1000, 1000 + MIN_CHECK_GAP_MS)).toBe(true);
  });
});

describe('shouldPromptFallback — 一直等不到安全時機就退回手動提示', () => {
  it('沒有懸而未決的更新 → 不提示', () => {
    expect(shouldPromptFallback(null, 10 ** 12)).toBe(false);
  });
  it('懸而未決未滿門檻 → 不提示；滿了 → 提示', () => {
    expect(shouldPromptFallback(0, FALLBACK_PROMPT_AFTER_MS - 1)).toBe(false);
    expect(shouldPromptFallback(0, FALLBACK_PROMPT_AFTER_MS)).toBe(true);
  });
});

describe('chunkReloadAllowed — 動態載入失敗自動重整的防迴圈', () => {
  it('從沒因此重整過 → 可以', () => {
    expect(chunkReloadAllowed(null, 5000)).toBe(true);
  });
  it('防迴圈窗內剛重整過（例如網路真的斷了）→ 不再重整', () => {
    expect(chunkReloadAllowed(5000, 5000 + CHUNK_RELOAD_GUARD_MS - 1)).toBe(false);
    expect(chunkReloadAllowed(5000, 5000 + CHUNK_RELOAD_GUARD_MS)).toBe(true);
  });
});

describe('resumeUpdateAllowed — 主畫面 PWA 回到 App 時更新（Hon 2026-09-23 定案甲案）', () => {
  const ok = { standalone: true, awayMs: RESUME_UPDATE_AWAY_MS, online: true, busy: false };
  it('PWA、離開夠久、有網路、沒在忙 → 開啟寬限時間', () => {
    expect(resumeUpdateAllowed(ok)).toBe(true);
  });
  it('瀏覽器分頁不走這條（維持切走時更新）', () => {
    expect(resumeUpdateAllowed({ ...ok, standalone: false })).toBe(false);
  });
  it('只是短暫切出去（例如去複製驗證碼）→ 不打斷', () => {
    expect(resumeUpdateAllowed({ ...ok, awayMs: RESUME_UPDATE_AWAY_MS - 1 })).toBe(false);
  });
  it('撰寫器開著／對話框／復原倒數 → 絕不重整', () => {
    expect(resumeUpdateAllowed({ ...ok, busy: true })).toBe(false);
  });
  it('離線 → 重整也載不到新版', () => {
    expect(resumeUpdateAllowed({ ...ok, online: false })).toBe(false);
  });
});

describe('resumeApplyAllowed — 回來那一刻才查到的新版，寬限時間內下載好且還沒碰畫面才直接換', () => {
  const ok = { sinceResumeMs: 0, interacted: false, online: true, busy: false };
  it('剛回來、還沒碰畫面 → 直接換', () => {
    expect(resumeApplyAllowed(ok)).toBe(true);
    expect(resumeApplyAllowed({ ...ok, sinceResumeMs: RESUME_GRACE_MS })).toBe(true);
  });
  it('超過寬限時間 → 不打斷，留到下次回來', () => {
    expect(resumeApplyAllowed({ ...ok, sinceResumeMs: RESUME_GRACE_MS + 1 })).toBe(false);
  });
  it('已經開始操作（點了、捲了）→ 不打斷', () => {
    expect(resumeApplyAllowed({ ...ok, interacted: true })).toBe(false);
  });
  it('寬限時間內打開了撰寫器 → 不重整', () => {
    expect(resumeApplyAllowed({ ...ok, busy: true })).toBe(false);
  });
  it('離線 → 不重整（重整也載不到新版）', () => {
    expect(resumeApplyAllowed({ ...ok, online: false })).toBe(false);
  });
  it('時鐘倒退（寬限起點在未來）→ 不算在寬限內', () => {
    expect(resumeApplyAllowed({ ...ok, sinceResumeMs: -1 })).toBe(false);
  });
});
