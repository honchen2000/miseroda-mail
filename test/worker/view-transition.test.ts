// View Transition 被略過時 ready 會 reject AbortError——接住它，但不吞 finished 的真錯誤。
// ⚠️ vitest-pool-workers 不會因 unhandled rejection 讓測試失敗，所以用 collectUnhandledRejections 自己攔、自己斷言。
import { describe, expect, it } from 'vitest';
import { ignoreSkippedTransition } from '../../src/app/lib/viewTransition';
import { collectUnhandledRejections } from './helpers/unhandled';

const skipped = () => Object.assign(new Error('Transition was skipped'), { name: 'AbortError' });

describe('collectUnhandledRejections（先證明攔截器本身有效，否則下面全是假綠）', () => {
  it('故意漏接的 rejection 必須被攔到', async () => {
    const seen = await collectUnhandledRejections(() => {
      void Promise.reject(new Error('deliberately unhandled'));
    });
    expect(seen).toHaveLength(1);
  });
});

describe('ignoreSkippedTransition', () => {
  it('過場被略過（ready reject AbortError）→ 不產生 unhandled rejection', async () => {
    const seen = await collectUnhandledRejections(() => {
      ignoreSkippedTransition({ ready: Promise.reject(skipped()), finished: Promise.resolve() });
    });
    expect(seen).toEqual([]);
  });

  it('不吞 finished 的真錯誤——畫面更新本身出錯時呼叫端仍拿得到 rejection', async () => {
    const boom = new Error('apply failed');
    const t = { ready: Promise.reject(skipped()), finished: Promise.reject(boom) };
    ignoreSkippedTransition(t);
    await expect(t.finished).rejects.toBe(boom);
  });

  it('不支援 View Transition（回傳 undefined）或沒有 ready 屬性 → 安靜略過', () => {
    expect(() => ignoreSkippedTransition(undefined)).not.toThrow();
    expect(() => ignoreSkippedTransition({})).not.toThrow();
  });
});
