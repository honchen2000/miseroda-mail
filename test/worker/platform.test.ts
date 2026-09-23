// F1.1：平台偵測純函式（iOS / standalone / Safari）→ 決定是否顯示 iOS 推播安裝引導。
// 這些是純字串/物件邏輯，可在 worker env 測；platform.ts 刻意不碰 navigator/window。
import { describe, expect, it } from 'vitest';
import {
  detectIOS,
  isIOSSafari,
  canSubscribePush,
  shouldShowIOSInstallGuide,
} from '../../src/app/lib/platform';

const UA = {
  iphoneSafari:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  iphoneChrome:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.0.0 Mobile/15E148 Safari/604.1',
  iphoneFirefox:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/124.0 Mobile/15E148 Safari/604.1',
  macSafari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  androidChrome:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
};

describe('platform 偵測（F1.1）', () => {
  it('detectIOS：iPhone / iPadOS(偽 Mac) → true；桌機 Mac / Android → false', () => {
    expect(detectIOS(UA.iphoneSafari, 'iPhone', 5)).toBe(true);
    // iPadOS 13+ 桌面模式：UA 變 Macintosh、platform=MacIntel、有觸控
    expect(detectIOS(UA.macSafari, 'MacIntel', 5)).toBe(true);
    // 真桌機 Mac：MacIntel 但無觸控
    expect(detectIOS(UA.macSafari, 'MacIntel', 0)).toBe(false);
    expect(detectIOS(UA.androidChrome, 'Linux armv8l', 0)).toBe(false);
  });

  it('isIOSSafari：iPhone/iPad Safari → true；iOS 上 Chrome/Firefox 及非 iOS 桌機/Android → false', () => {
    expect(isIOSSafari(UA.iphoneSafari, 'iPhone', 5)).toBe(true);
    expect(isIOSSafari(UA.macSafari, 'MacIntel', 5)).toBe(true); // iPadOS 桌面模式
    expect(isIOSSafari(UA.iphoneChrome, 'iPhone', 5)).toBe(false);
    expect(isIOSSafari(UA.iphoneFirefox, 'iPhone', 5)).toBe(false);
    // 自帶 iOS 守門：UA 含 "Safari" 字串的桌機 Mac / Android Chrome 也不誤判
    expect(isIOSSafari(UA.macSafari, 'MacIntel', 0)).toBe(false); // 真桌機 Mac（無觸控）
    expect(isIOSSafari(UA.androidChrome, 'Linux armv8l', 0)).toBe(false);
  });

  it('canSubscribePush：iOS 未安裝 → false；iOS 已安裝 / 非 iOS → true', () => {
    expect(canSubscribePush({ ios: true, standalone: false, iosSafari: true })).toBe(false);
    expect(canSubscribePush({ ios: true, standalone: true, iosSafari: true })).toBe(true);
    expect(canSubscribePush({ ios: false, standalone: false, iosSafari: false })).toBe(true);
  });

  it('shouldShowIOSInstallGuide：只有 iOS 未安裝才顯示引導', () => {
    expect(shouldShowIOSInstallGuide({ ios: true, standalone: false, iosSafari: true })).toBe(true);
    expect(shouldShowIOSInstallGuide({ ios: true, standalone: true, iosSafari: true })).toBe(false);
    expect(shouldShowIOSInstallGuide({ ios: false, standalone: false, iosSafari: false })).toBe(false);
  });
});
