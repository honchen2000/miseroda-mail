// 純邏輯單元測試：收件匣分類啟發式
import { describe, expect, it } from 'vitest';
import { categorizeMessage } from '../../src/worker/email/categorize';

const base = { hasListUnsubscribe: false, listId: null, precedence: null, autoSubmitted: null };

describe('categorizeMessage', () => {
  it('直接 1:1 信（無批量/自動訊號）→ 主要，主旨關鍵字不影響', () => {
    expect(categorizeMessage({ ...base, fromAddr: 'jane@gmail.com', subject: '午餐約一下？' })).toBe('primary');
    // 即使主旨有「優惠/特賣」，只要是直接信就留在主要（避免誤移）
    expect(categorizeMessage({ ...base, fromAddr: 'boss@company.com', subject: '這檔特賣的合約請看一下' })).toBe('primary');
    // sales@ 但無 List-Unsubscribe / 非 no-reply → 可能是真人業務 → 主要
    expect(categorizeMessage({ ...base, fromAddr: 'sales@vendor.com', subject: '報價單' })).toBe('primary');
  });

  it('社交網域 → 社交（高信心，優先於其他）', () => {
    expect(categorizeMessage({ ...base, fromAddr: 'notify@facebookmail.com', subject: '你有 3 則新通知', hasListUnsubscribe: true })).toBe('social');
    expect(categorizeMessage({ ...base, fromAddr: 'jobs-noreply@linkedin.com', subject: '5 jobs for you', hasListUnsubscribe: true })).toBe('social');
    expect(categorizeMessage({ ...base, fromAddr: 'info@notifications.x.com', subject: 'New follower' })).toBe('social');
  });

  it('批量 + 行銷字眼 / 行銷寄件者 → 促銷', () => {
    expect(categorizeMessage({ ...base, fromAddr: 'shop@store.com', subject: '限時 5 折優惠！', hasListUnsubscribe: true })).toBe('promotions');
    expect(categorizeMessage({ ...base, fromAddr: 'newsletter@brand.com', subject: 'This week at Brand', hasListUnsubscribe: true })).toBe('promotions');
    expect(categorizeMessage({ ...base, fromAddr: 'x@store.com', subject: 'Save 30% off everything', hasListUnsubscribe: true })).toBe('promotions');
  });

  it('自動 / no-reply + 交易型主旨 → 通知', () => {
    expect(categorizeMessage({ ...base, fromAddr: 'no-reply@bank.com', subject: '您的對帳單已產生' })).toBe('updates');
    expect(categorizeMessage({ ...base, fromAddr: 'receipts@shop.com', subject: 'Your receipt #12345', hasListUnsubscribe: true })).toBe('updates');
    expect(categorizeMessage({ ...base, fromAddr: 'noreply@service.com', subject: '請驗證您的電子郵件', autoSubmitted: 'auto-generated' })).toBe('updates');
  });

  it('no-reply 無行銷/交易字眼 → 通知；純 List-Unsubscribe 電子報 → 促銷', () => {
    expect(categorizeMessage({ ...base, fromAddr: 'no-reply@app.com', subject: '系統公告' })).toBe('updates');
    expect(categorizeMessage({ ...base, fromAddr: 'hello@substack.com', subject: '本週精選', hasListUnsubscribe: true })).toBe('promotions');
    // Precedence: bulk 也算批量訊號
    expect(categorizeMessage({ ...base, fromAddr: 'list@forum.com', subject: '討論串更新', precedence: 'bulk' })).toBe('promotions');
  });

  it('交易型主旨優先於行銷字眼：出貨/物流通知夾帶折扣 → 通知（非促銷）', () => {
    expect(categorizeMessage({ ...base, fromAddr: 'no-reply@shop.com', subject: '您的訂單已出貨，下次再享 20% off', hasListUnsubscribe: true })).toBe('updates');
    expect(categorizeMessage({ ...base, fromAddr: 'noreply@bank.com', subject: 'Your statement is ready — save with 0% APR offer' })).toBe('updates');
  });

  it('病態超長主旨（純數字）不會卡住（ReDoS 防護）', () => {
    const evil = '9'.repeat(100000) + ' off off off';
    const t0 = Date.now();
    const cat = categorizeMessage({ ...base, fromAddr: 'no-reply@notify.acme.com', subject: evil });
    expect(Date.now() - t0).toBeLessThan(200); // 限長 + 收斂量詞後應為毫秒級
    expect(cat).toBe('updates'); // no-reply 自動信、無行銷/交易字眼
  });
});
