// F3.1：全部回覆 cc 計算（純函式，無 DOM）。
import { describe, expect, it } from 'vitest';
import { computeReplyAllCc } from '../../src/app/lib/recipients';

describe('computeReplyAllCc（F3.1）', () => {
  it('收到的信全部回覆：cc = 其他收件人，去掉自己與原寄件者', () => {
    // alice 寄給 [me, bob]，cc carol；我全部回覆 → to=alice、cc=[bob, carol]（me 自己剔除）
    expect(
      computeReplyAllCc({ to: ['me@x.com', 'bob@x.com'], cc: ['carol@x.com'], fromAddr: 'alice@x.com', selfEmail: 'me@x.com', direction: 'inbound' }),
    ).toEqual(['bob@x.com', 'carol@x.com']);
  });
  it('剔除自己（大小寫不敏感）+ 去重', () => {
    expect(
      computeReplyAllCc({ to: ['Me@X.com', 'bob@x.com', 'BOB@x.com'], cc: ['me@x.com'], fromAddr: 'alice@x.com', selfEmail: 'me@x.com', direction: 'inbound' }),
    ).toEqual(['bob@x.com']);
  });
  it('寄出的信全部回覆：to 用第一收件人，cc 排除它', () => {
    // 我寄給 [bob, carol]；全部回覆 → to=bob、cc=[carol]
    expect(
      computeReplyAllCc({ to: ['bob@x.com', 'carol@x.com'], cc: [], fromAddr: 'me@x.com', selfEmail: 'me@x.com', direction: 'outbound' }),
    ).toEqual(['carol@x.com']);
  });
  it('空白與空字串過濾', () => {
    expect(
      computeReplyAllCc({ to: ['  ', 'bob@x.com '], cc: [''], fromAddr: 'alice@x.com', selfEmail: 'me@x.com', direction: 'inbound' }),
    ).toEqual(['bob@x.com']);
  });
});
