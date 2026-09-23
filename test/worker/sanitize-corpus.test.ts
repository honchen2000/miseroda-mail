// F18.2：真實郵件語料回歸——把「消毒後合法內容還在不在」變成可量測的數字。
// 動機：sanitize.ts 歷來三次修正全是「合法內容被刪光」（2026-06：form 去殼／<style> 內聯／inline style），
// 但既有 11 個單測都是 CSS 邊角案例，沒有任何一個「整封典型信件」的斷言。這裡補上各寄件端家族的結構樣本
// 加一封真實 AWS 驗證信（helpers/corpus.ts），每封斷言：可見文字保留率 ≥ 門檻、輸出非空、無腳本殘留、家族特徵結構仍在。
// 想知道白名單改動有沒有誤傷：改完跑這支，紅了就是。
import { describe, expect, it } from 'vitest';
import { sanitizeEmailHtml, textToHtml } from '../../src/worker/email/sanitize';
import { CORPUS, visibleText } from './helpers/corpus';

describe('sanitize 語料回歸（可見文字保留率）', () => {
  for (const fx of CORPUS) {
    it(`${fx.name}：保留率 ≥ ${((fx.minKeep ?? 0.95) * 100).toFixed(0)}%，家族結構仍在`, async () => {
      const src = fx.text ? textToHtml(fx.html) : fx.html;
      const { html: out } = await sanitizeEmailHtml(src, new Map());
      expect(out.trim().length).toBeGreaterThan(0);
      expect(out).not.toMatch(/<script|javascript:|\son\w+=/i);
      const a = visibleText(src);
      const b = visibleText(out);
      const keep = a.length ? b.length / a.length : 1;
      expect(keep, `可見文字 ${a.length} → ${b.length} 字`).toBeGreaterThanOrEqual(fx.minKeep ?? 0.95);
      for (const s of fx.mustContain ?? []) expect(out, `應保留：${s}`).toContain(s);
      for (const s of fx.mustNotContain ?? []) expect(out, `應移除：${s}`).not.toContain(s);
      for (const re of fx.mustMatch ?? []) expect(out).toMatch(re);
    });
  }

  it('語料總表：沒有任何一封被消毒成空白（有文字、或至少留下一張圖）', async () => {
    const outs = await Promise.all(
      CORPUS.map(async (fx) => (await sanitizeEmailHtml(fx.text ? textToHtml(fx.html) : fx.html, new Map())).html),
    );
    // 純圖片信的可見文字本來就是 0（alt 是屬性）→ 「非空白」的定義是：有文字，或至少一張被封鎖待載的圖。
    expect(outs.map((o) => visibleText(o).length > 0 || /data-blocked-src=/.test(o))).toEqual(CORPUS.map(() => true));
  });
});
