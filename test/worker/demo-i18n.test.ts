// Demo 雙語偵測：中文語系→zh，其餘（含非 en 語系）→ fallback en。
import { describe, expect, it } from 'vitest';
import { demoLang, dt } from '../../src/app/lib/demoI18n';

describe('demoLang', () => {
  it('中文語系 → zh', () => {
    for (const n of ['zh', 'zh-TW', 'zh-Hant', 'zh-Hant-TW', 'zh-CN', 'ZH-tw']) {
      expect(demoLang(n), n).toBe('zh');
    }
  });
  it('英文與其他語系 → en（fallback）', () => {
    for (const n of ['en', 'en-US', 'en-GB', 'ja', 'ja-JP', 'fr-FR', 'ko', 'de', 'zhosa-fake', '', undefined]) {
      expect(demoLang(n), String(n)).toBe('en');
    }
  });
  it('dt 依語言二選一', () => {
    expect(dt('中', 'EN', 'zh-TW')).toBe('中');
    expect(dt('中', 'EN', 'en-US')).toBe('EN');
    expect(dt('中', 'EN', 'ja')).toBe('EN'); // 非中非英 → 英
  });
});
