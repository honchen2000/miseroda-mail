// 2026-09-20 安全掃描 F2：寄件者頭像不得把通信對象的地址送給第三方。
// 這支測試釘住「來源清單只能是同源路徑」這條鐵則——日後有人想再加一個
// unavatar/gravatar 之類的聚合服務回來，會在這裡撞紅燈而不是靜靜上線。
import { describe, expect, it } from 'vitest';
import { senderAvatarSources } from '../../src/app/lib/avatarSources';

describe('寄件者頭像來源', () => {
  it('任何輸入產生的來源都必須是同源路徑，永遠不得出現第三方 URL', () => {
    const addrs = ['hon@miseroda.com', 'alice@example.com', ' BOB@Example.COM ', 'no-at-sign', '', 'a@b@miseroda.com'];
    for (const addr of addrs) {
      for (const s of senderAvatarSources(addr)) {
        expect(s.startsWith('/api/'), `${JSON.stringify(addr)} 產生了非同源來源 ${s}`).toBe(true);
        expect(s, `${JSON.stringify(addr)} 產生了絕對網址 ${s}`).not.toMatch(/^https?:|^\/\//);
      }
    }
  });

  it('站內地址走內部端點，且大小寫與前後空白已正規化', () => {
    expect(senderAvatarSources(' Hon@Miseroda.com ')).toEqual(['/api/v1/avatars/by-email?email=hon%40miseroda.com']);
  });

  it('外部地址不產生任何來源（退回字首圓圈，不對外發請求）', () => {
    expect(senderAvatarSources('alice@example.com')).toEqual([]);
    expect(senderAvatarSources('someone@gmail.com')).toEqual([]);
  });
});
