// 純邏輯單元測試：貝氏垃圾分類器的 tokenize + scoreSpam
import { describe, expect, it } from 'vitest';
import { scoreSpam, tokenize, type TokenStat } from '../../src/worker/email/spamFilter';

describe('tokenize', () => {
  it('英數單詞（小寫、去重）+ 中文字元 bigram', () => {
    const t = tokenize('限時優惠 SALE', 'buy buy now 折扣折扣');
    expect(t).toContain('w:sale'); // 小寫
    expect(t).toContain('w:buy'); // 去重（只一個）
    expect(t.filter((x) => x === 'w:buy')).toHaveLength(1);
    expect(t).toContain('c:限時');
    expect(t).toContain('c:優惠');
    expect(t).toContain('c:折扣');
  });
  it('過短英數忽略、上限截斷', () => {
    expect(tokenize('a', '')).not.toContain('w:a'); // 單字元不成詞
    const many = tokenize(Array.from({ length: 200 }, (_, i) => `word${i}`).join(' '), '');
    expect(many.length).toBeLessThanOrEqual(80);
  });
});

describe('scoreSpam', () => {
  const corpus = { spamMsgs: 10, hamMsgs: 10 };
  const stats = new Map<string, TokenStat>([
    ['w:viagra', { spam: 9, ham: 0 }], // 強 spam 訊號
    ['w:meeting', { spam: 0, ham: 9 }], // 強 ham 訊號
    ['w:the', { spam: 8, ham: 8 }], // 中性
  ]);

  it('強 spam token → 高分；強 ham token → 低分', () => {
    expect(scoreSpam(['w:viagra'], stats, corpus)).toBeGreaterThan(0.9);
    expect(scoreSpam(['w:meeting'], stats, corpus)).toBeLessThan(0.1);
  });
  it('未見過的 token → 中性（約 0.4），不會高分誤判', () => {
    const s = scoreSpam(['w:unknownword'], stats, corpus);
    expect(s).toBeGreaterThan(0.3);
    expect(s).toBeLessThan(0.5);
  });
  it('出現次數太少（< 3）的 token 視為中性，不給 0.99（冷啟動防誤判）', () => {
    const rare = new Map<string, TokenStat>([['w:rare', { spam: 1, ham: 0 }]]);
    const s = scoreSpam(['w:rare'], rare, { spamMsgs: 5, hamMsgs: 5 });
    expect(s).toBeGreaterThan(0.3);
    expect(s).toBeLessThan(0.5); // 若無 hapax 防護會是 ~0.99
  });
  it('中性 token 不影響太多；混合時 spam 訊號主導', () => {
    expect(scoreSpam(['w:viagra', 'w:the', 'w:unknownword'], stats, corpus)).toBeGreaterThan(0.8);
  });
  it('無 token → 0', () => {
    expect(scoreSpam([], stats, corpus)).toBe(0);
  });
});
