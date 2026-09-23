// F19.3 / 2026-09-20 安全掃描 F10：List-Unsubscribe 解析的二次方回溯。
// 這段跑在未認證的 email() handler 裡、在 INGEST_QUEUE.send 之前 → 吃掉 CPU 配額
// 會讓整封信根本存不下來。原本的 /<([^>]+)>/g 在「有 < 卻沒有 >」時會吃光輸入再整個回溯。
import { describe, expect, it } from 'vitest';
import { parseListUnsubscribe } from '../../src/worker/email/list-unsubscribe';

describe('List-Unsubscribe 解析的回溯防線（F19.3）', () => {
  it('100 KB 全是 < 而無 > 的惡意標頭：毫秒級返回，不丟例外', () => {
    const evil = '<'.repeat(100_000);
    const t0 = Date.now();
    expect(parseListUnsubscribe(evil, null)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(500); // 舊實作在這裡是 ~10^10 次字元比較
  });

  it('交錯的 < 與無效內容同樣不爆（每組之間仍線性推進）', () => {
    const evil = `${'<a'.repeat(50_000)}>`;
    const t0 = Date.now();
    parseListUnsubscribe(evil, null);
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it('正常標頭的解析結果與過去完全一致', () => {
    expect(parseListUnsubscribe('<https://e.example/u?x=1>, <mailto:u@e.example>', null)).toEqual({
      httpUrl: 'https://e.example/u?x=1',
      mailto: 'mailto:u@e.example',
      oneClick: false,
    });
    expect(parseListUnsubscribe('<mailto:u@e.example>', 'List-Unsubscribe=One-Click')).toEqual({
      httpUrl: null, mailto: 'mailto:u@e.example', oneClick: false, // 無 https → 不算 one-click
    });
    expect(parseListUnsubscribe('<https://e.example/u>', 'List-Unsubscribe=One-Click')).toEqual({
      httpUrl: 'https://e.example/u', mailto: null, oneClick: true,
    });
    expect(parseListUnsubscribe('<http://insecure.example/u>', null)).toBeNull(); // 只收 https
    expect(parseListUnsubscribe(null, null)).toBeNull();
  });

  it('超過長度上限的部分被截斷——但截斷前的合法連結照常解析得到', () => {
    const header = `<https://e.example/u>, ${'x'.repeat(5000)} <mailto:late@e.example>`;
    const r = parseListUnsubscribe(header, null)!;
    expect(r.httpUrl).toBe('https://e.example/u');
    expect(r.mailto).toBeNull(); // 在 2048 字元之後 → 看不到，這是刻意的取捨
  });
});
