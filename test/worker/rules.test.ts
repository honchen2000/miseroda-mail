// 純邏輯單元測試：規則條件比對（clauses × 運算子 × match all/any + 舊版相容）
import { describe, expect, it } from 'vitest';
import { matchesConditions, type MatchFields, type RuleConditions } from '../../src/worker/email/rulesEngine';

// 注意：引擎傳入的欄位已小寫化
const fields: MatchFields = {
  from: 'wang manager boss@acme.com',
  subject: '您的 5 月帳單已產生',
  to: 'hon+shop@miseroda.com',
  hasListUnsubscribe: true,
};
const m = (cond: RuleConditions) => matchesConditions(cond, fields);

describe('matchesConditions', () => {
  it('運算子：contains / equals / startsWith / endsWith / notContains', () => {
    expect(m({ clauses: [{ field: 'from', op: 'contains', value: 'boss@acme.com' }] })).toBe(true);
    expect(m({ clauses: [{ field: 'subject', op: 'contains', value: '帳單' }] })).toBe(true);
    expect(m({ clauses: [{ field: 'to', op: 'endsWith', value: '@miseroda.com' }] })).toBe(true);
    expect(m({ clauses: [{ field: 'to', op: 'startsWith', value: 'hon+' }] })).toBe(true);
    expect(m({ clauses: [{ field: 'subject', op: 'notContains', value: '促銷' }] })).toBe(true);
    expect(m({ clauses: [{ field: 'subject', op: 'notContains', value: '帳單' }] })).toBe(false);
    expect(m({ clauses: [{ field: 'from', op: 'equals', value: 'boss@acme.com' }] })).toBe(false); // from 是 name+addr 合併
  });

  it('大小寫不敏感（值會小寫化比對）', () => {
    expect(m({ clauses: [{ field: 'from', op: 'contains', value: 'BOSS@ACME.com' }] })).toBe(true);
  });

  it('match=all（預設）需全部符合；match=any 任一即可', () => {
    const two: RuleConditions = {
      clauses: [
        { field: 'subject', op: 'contains', value: '帳單' },
        { field: 'from', op: 'contains', value: '不存在' },
      ],
    };
    expect(m({ ...two })).toBe(false); // all：其一不符
    expect(m({ ...two, match: 'any' })).toBe(true); // any：帳單符合
  });

  it('hasListUnsubscribe 條件', () => {
    expect(m({ hasListUnsubscribe: true })).toBe(true);
    expect(m({ hasListUnsubscribe: false })).toBe(false);
  });

  it('舊版扁平欄位仍可用（等同 contains），可與 clauses 並存', () => {
    expect(m({ subjectContains: '帳單' })).toBe(true);
    expect(m({ fromContains: 'boss@acme.com', subjectContains: '帳單' })).toBe(true); // all
    expect(m({ match: 'any', fromContains: '不存在', subjectContains: '帳單' })).toBe(true);
  });

  it('無任何有效條件 → false（避免空條件誤觸全部信件）', () => {
    expect(m({})).toBe(false);
    expect(m({ clauses: [] })).toBe(false);
    expect(m({ clauses: [{ field: 'subject', op: 'contains', value: '' }] })).toBe(false); // 空值跳過
    expect(m({ match: 'any' })).toBe(false);
  });
});
