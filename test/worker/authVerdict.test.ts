// 寄件者信任卡：Authentication-Results 解析 + 信任等級衍生（純函式）。
import { describe, expect, it } from 'vitest';
import { parseAuthVerdict, trustLevel } from '../../src/worker/email/authVerdict';

describe('parseAuthVerdict', () => {
  it('解析一般 Gmail 風格標頭的 spf/dkim/dmarc', () => {
    const ar = 'mx.google.com; spf=pass smtp.mailfrom=a@x.com; dkim=pass header.d=x.com; dmarc=pass (p=none)';
    expect(parseAuthVerdict(ar.toLowerCase())).toEqual({ spf: 'pass', dkim: 'pass', dmarc: 'pass' });
  });

  it('無任何驗證資訊時回 null', () => {
    expect(parseAuthVerdict('')).toBeNull();
    expect(parseAuthVerdict('received: from somewhere by mx')).toBeNull();
  });

  it('部分結果：缺 dmarc 時該欄為 null', () => {
    expect(parseAuthVerdict('spf=fail; dkim=none')).toEqual({ spf: 'fail', dkim: 'none', dmarc: null });
  });

  it('多個 A-R 標頭合併時取第一個（最可信邊界 MTA）', () => {
    expect(parseAuthVerdict('spf=pass; dkim=pass ; spf=fail; dkim=fail')).toEqual({
      spf: 'pass',
      dkim: 'pass',
      dmarc: null,
    });
  });
});

describe('trustLevel', () => {
  it('DMARC pass → pass；SPF+DKIM 皆 pass（無 dmarc）→ pass', () => {
    expect(trustLevel({ spf: 'fail', dkim: 'fail', dmarc: 'pass' })).toBe('pass');
    expect(trustLevel({ spf: 'pass', dkim: 'pass', dmarc: null })).toBe('pass');
  });

  it('DMARC fail 即使 SPF/DKIM 各自 pass 也判 fail（對齊失敗＝偽冒）', () => {
    expect(trustLevel({ spf: 'pass', dkim: 'pass', dmarc: 'fail' })).toBe('fail');
    expect(trustLevel({ spf: 'softfail', dkim: 'fail', dmarc: null })).toBe('fail');
  });

  it('其餘為 partial；null 透傳', () => {
    expect(trustLevel({ spf: 'pass', dkim: 'none', dmarc: null })).toBe('partial');
    expect(trustLevel({ spf: 'neutral', dkim: 'neutral', dmarc: 'none' })).toBe('partial');
    expect(trustLevel(null)).toBeNull();
  });
});
