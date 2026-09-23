// F2.7：範本佔位符代入（純函式）。template.ts 無 DOM 依賴 → worker env 可測。
import { describe, expect, it } from 'vitest';
import { fillTemplate, recipientDisplayName } from '../../src/app/lib/template';

describe('fillTemplate（F2.7 範本佔位符）', () => {
  it('{{name}} / {{firstName}} 代入（英文取第一個詞）', () => {
    expect(fillTemplate('您好 {{name}}，', '王經理')).toBe('您好 王經理，');
    expect(fillTemplate('Hi {{firstName}}!', 'John Smith')).toBe('Hi John!');
    expect(fillTemplate('Dear {{name}}', 'John Smith')).toBe('Dear John Smith');
  });
  it('中文姓名無空白 → firstName 用整名', () => {
    expect(fillTemplate('{{firstName}} 您好', '王經理')).toBe('王經理 您好');
  });
  it('大小寫 / 內側空白容忍', () => {
    expect(fillTemplate('{{ Name }} | {{ FIRSTNAME }}', 'Amy Lee')).toBe('Amy Lee | Amy');
  });
  it('無收件人 → 退回「您」', () => {
    expect(fillTemplate('{{name}} 您好', '')).toBe('您 您好');
  });
  it('多次出現全代入；無佔位符原樣', () => {
    expect(fillTemplate('{{name}}、{{name}}', '王')).toBe('王、王');
    expect(fillTemplate('沒有佔位符', '王')).toBe('沒有佔位符');
  });
});

describe('recipientDisplayName', () => {
  it('自訂名優先，否則 email local-part', () => {
    const m = new Map([['boss@corp.com', '王經理']]);
    expect(recipientDisplayName('boss@corp.com', m)).toBe('王經理');
    expect(recipientDisplayName('Amy@X.com', m)).toBe('Amy'); // local-part 保留原大小寫，查表用小寫
    expect(recipientDisplayName(undefined, m)).toBe('');
    expect(recipientDisplayName('王經理', m)).toBe(''); // 非 email（半成品 chip）→ 空 → 範本退回「您」
  });
});
