import { Hono } from 'hono';
import { allowedOrigins } from '../auth/webauthn';
import { authRoutes } from './auth';
import { adminRoutes } from './admin';
import { aiRoutes } from './ai';
import { mailRoutes } from './mail';
import { sendRoutes } from './send';
import { settingsRoutes } from './settings';
import { dbSession, originCheck, requireSession, type Vars } from './middleware';

export type ApiEnv = { Bindings: Env; Variables: Vars };

export function createApi() {
  const app = new Hono<ApiEnv>().basePath('/api/v1');

  app.use('*', originCheck);
  // 每請求一個 D1 session（讀取複本的一致性機制）。必須在 requireSession 之前，
  // 讓所有 handler 都拿得到 c.var.db；auth 自身仍走主庫（見 middleware 內註解）。
  app.use('*', dbSession);

  app.get('/health', (c) =>
    c.json({ ok: true, service: 'miseroda-mail', ts: Date.now() }),
  );

  // 即時收件 WebSocket：session 驗證後轉交該使用者的 UserHub DO
  app.get('/realtime', requireSession, (c) => {
    if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') {
      return c.json({ error: 'expected_websocket' }, 426);
    }
    // WS 握手不在 originCheck 的變更名單內，這裡補同源檢查
    const origin = c.req.header('Origin');
    if (origin && !allowedOrigins(c.env).includes(origin)) {
      return c.json({ error: 'bad_origin' }, 403);
    }
    const stub = c.env.USER_HUB.get(c.env.USER_HUB.idFromName(c.var.user.id));
    return stub.fetch(new Request('https://hub/connect', c.req.raw));
  });

  app.route('/auth', authRoutes());
  app.route('/admin', adminRoutes());
  app.route('/', sendRoutes());
  app.route('/', settingsRoutes());
  app.route('/', aiRoutes());
  app.route('/', mailRoutes());

  app.notFound((c) => c.json({ error: 'not_found' }, 404));
  app.onError((err, c) => {
    console.error('api error', err);
    return c.json({ error: 'internal_error' }, 500);
  });

  return app;
}
