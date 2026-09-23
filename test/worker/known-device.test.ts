// F12.3：新裝置偵測（coarseUa 純函式 + recordDevice 判定）+ 單一 session 撤銷端點。
import { describe, expect, it } from 'vitest';
import { createExecutionContext, env } from 'cloudflare:test';
import worker from '../../src/worker/index';
import { coarseUa, recordDevice } from '../../src/worker/lib/knownDevice';
import { sha256Hex } from '../../src/worker/lib/crypto';
import { seedUser } from './helpers/fixtures';

const BASE = 'https://mail.miseroda.com/api/v1';

describe('F12.3 coarseUa（去版本號）', () => {
  it('抽出瀏覽器/OS，忽略版本號', () => {
    expect(coarseUa('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120.0.0 Safari/537.36')).toBe('Chrome / macOS');
    expect(coarseUa('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Version/17 Mobile/15E Safari/604.1')).toBe('Safari / iOS');
    expect(coarseUa('Mozilla/5.0 (Windows NT 10.0) Gecko Firefox/121.0')).toBe('Firefox / Windows');
    expect(coarseUa('Mozilla/5.0 (Macintosh) AppleWebKit Edg/120.0')).toBe('Edge / macOS');
    // 版本升級不改變粗粒度（Chrome 120 vs 121 → 同名）
    expect(coarseUa('X Chrome/120 Safari/537')).toBe(coarseUa('X Chrome/121 Safari/537'));
    expect(coarseUa(null)).toBe('未知裝置');
  });
});

describe('F12.3 recordDevice（新裝置判定）', () => {
  it('第一台裝置不算新（不對唯一裝置警報）；第二台不同裝置算新；同裝置再登入不算新', async () => {
    const hon = await seedUser(env, 'hon@miseroda.com');
    const chrome = 'Mozilla/5.0 (Macintosh) Chrome/120 Safari/537';
    const safariPhone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/604.1';
    // 第一台
    expect((await recordDevice(env, hon.userId, chrome)).isNew).toBe(false);
    // 同一台再登入
    expect((await recordDevice(env, hon.userId, chrome)).isNew).toBe(false);
    // 換一台新裝置 → 算新
    const r = await recordDevice(env, hon.userId, safariPhone);
    expect(r.isNew).toBe(true);
    expect(r.coarse).toBe('Safari / iOS');
    // 記錄後再登入同台 → 不再算新
    expect((await recordDevice(env, hon.userId, safariPhone)).isNew).toBe(false);
    // 使用者隔離：另一人第一台也不算新
    const kai = await seedUser(env, 'kai@miseroda.com');
    expect((await recordDevice(env, kai.userId, chrome)).isNew).toBe(false);
  });
});

describe('F12.3 POST /sessions/:id/revoke', () => {
  async function post(path: string, cookies: { session: string; csrf: string }) {
    return worker.fetch(
      new Request(`${BASE}${path}`, {
        method: 'POST',
        headers: {
          Cookie: `__Host-session=${encodeURIComponent(cookies.session)}; __Host-csrf=${encodeURIComponent(cookies.csrf)}`,
          'X-CSRF-Token': cookies.csrf,
          'Content-Type': 'application/json',
        },
        body: '{}',
      }),
      env,
      createExecutionContext(),
    );
  }

  it('撤銷自己的另一台 session；擋撤當前；擋撤他人的；未知 404', async () => {
    const hon = await seedUser(env, 'hon@miseroda.com');
    const kai = await seedUser(env, 'kai@miseroda.com');
    // 幫 hon 手動加第二個 session（另一台裝置）
    const otherToken = 'other-device-token-xyz';
    const otherId = await sha256Hex(otherToken);
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO sessions (id, user_id, client, user_agent, ip, created_at, expires_at) VALUES (?, ?, 'web', 'UA', '1.2.3.4', ?, ?)`,
    )
      .bind(otherId, hon.userId, now, now + 86400_000)
      .run();

    // 當前 session（hon.cookies.session 的 hash）不能被自撤
    const currentId = await sha256Hex(hon.cookies.session);
    const cur = await post(`/auth/sessions/${currentId}/revoke`, hon.cookies);
    expect(cur.status).toBe(400); // cannot_revoke_current

    // kai 不能撤 hon 的 otherId（self-scoped）
    const cross = await post(`/auth/sessions/${otherId}/revoke`, kai.cookies);
    expect(cross.status).toBe(404);
    // otherId 仍未被撤
    expect((await env.DB.prepare(`SELECT revoked_at FROM sessions WHERE id = ?`).bind(otherId).first<{ revoked_at: number | null }>())!.revoked_at).toBeNull();

    // hon 撤自己的 otherId → 成功且 revoked_at 被設
    const ok = await post(`/auth/sessions/${otherId}/revoke`, hon.cookies);
    expect(ok.status).toBe(200);
    expect((await env.DB.prepare(`SELECT revoked_at FROM sessions WHERE id = ?`).bind(otherId).first<{ revoked_at: number | null }>())!.revoked_at).not.toBeNull();

    // 未知 id → 404
    const unknown = await post(`/auth/sessions/nonexistent/revoke`, hon.cookies);
    expect(unknown.status).toBe(404);
  });
});
