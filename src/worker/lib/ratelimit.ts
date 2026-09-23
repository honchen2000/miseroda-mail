// KV 固定視窗限流（defense-in-depth 的煞車；之後可換 Workers Rate Limiting binding）
// KV 最終一致 → 極端併發下可能略放行超量，可接受：真正的暴力破解防線是
// 高熵邀請碼/備援碼、TOTP 嘗試上限、WebAuthn 本身。
import { createMiddleware } from 'hono/factory';

export async function checkRateLimit(env: Env, key: string, limit: number, windowSec: number): Promise<boolean> {
  const windowStart = Math.floor(Date.now() / (windowSec * 1000));
  const kvKey = `rl:${key}:${windowStart}`;
  const current = Number((await env.KV.get(kvKey)) ?? '0');
  if (current >= limit) return false;
  await env.KV.put(kvKey, String(current + 1), { expirationTtl: Math.max(60, windowSec * 2) });
  return true;
}

export function rateLimitMw(scope: string, limit: number, windowSec: number) {
  return createMiddleware<{ Bindings: Env }>(async (c, next) => {
    const ip = c.req.header('CF-Connecting-IP') ?? 'unknown';
    if (!(await checkRateLimit(c.env, `${scope}:${ip}`, limit, windowSec))) {
      return c.json({ error: 'rate_limited' }, 429);
    }
    await next();
  });
}

/** 以登入使用者為鍵的限流（成本歸屬正確、防換 IP 繞過）；須在 requireSession 之後使用。 */
export function rateLimitUserMw(scope: string, limit: number, windowSec: number) {
  return createMiddleware<{ Bindings: Env; Variables: { user?: { id: string } } }>(async (c, next) => {
    const uid = c.get('user')?.id ?? c.req.header('CF-Connecting-IP') ?? 'unknown';
    if (!(await checkRateLimit(c.env, `${scope}:u:${uid}`, limit, windowSec))) {
      return c.json({ error: 'rate_limited' }, 429);
    }
    await next();
  });
}
