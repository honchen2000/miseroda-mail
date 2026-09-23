// Durable Object 即時通道（獨立 project：isolatedStorage 關閉，見 vitest.config.ts）
import { describe, expect, it } from 'vitest';
import { createExecutionContext, env } from 'cloudflare:test';
import worker from '../../src/worker/index';
import { notifyUser } from '../../src/worker/lib/notify';
import { seedUser } from '../worker/helpers/fixtures';

const BASE = 'https://mail.miseroda.com/api/v1';

describe('UserHub DO + /realtime', () => {
  it('WS 連線 → notifyUser 廣播 → 多分頁收到；ping/pong；跨使用者隔離', async () => {
    const hon = await seedUser(env, 'hon-ws@miseroda.com', 'admin');
    const tom = await seedUser(env, 'tom-ws@miseroda.com', 'user');

    // 未帶 session → 401
    const anon = await worker.fetch(
      new Request(`${BASE}/realtime`, { headers: { Upgrade: 'websocket' } }),
      env,
      createExecutionContext(),
    );
    expect(anon.status).toBe(401);

    // 帶 session 但非 WS 升級 → 426
    const cookieHeader = (c: { session: string; csrf: string }) =>
      `__Host-session=${encodeURIComponent(c.session)}; __Host-csrf=${encodeURIComponent(c.csrf)}`;
    const plain = await worker.fetch(
      new Request(`${BASE}/realtime`, { headers: { Cookie: cookieHeader(hon.cookies) } }),
      env,
      createExecutionContext(),
    );
    expect(plain.status).toBe(426);

    // 錯誤 Origin → 403（防跨站 WS 劫持）
    const badOrigin = await worker.fetch(
      new Request(`${BASE}/realtime`, {
        headers: { Upgrade: 'websocket', Origin: 'https://evil.example', Cookie: cookieHeader(hon.cookies) },
      }),
      env,
      createExecutionContext(),
    );
    expect(badOrigin.status).toBe(403);

    // 兩個分頁連上 hon 的 hub + 一個 tom 的
    const connect = async (cookies: { session: string; csrf: string }) => {
      const res = await worker.fetch(
        new Request(`${BASE}/realtime`, {
          headers: {
            Upgrade: 'websocket',
            Origin: 'https://mail.miseroda.com',
            Cookie: cookieHeader(cookies),
          },
        }),
        env,
        createExecutionContext(),
      );
      expect(res.status).toBe(101);
      const ws = res.webSocket!;
      ws.accept();
      return ws;
    };
    const honTab1 = await connect(hon.cookies);
    const honTab2 = await connect(hon.cookies);
    const tomTab = await connect(tom.cookies);

    const inbox = (ws: WebSocket) => {
      const msgs: string[] = [];
      ws.addEventListener('message', (ev) => msgs.push(String(ev.data)));
      return msgs;
    };
    const m1 = inbox(honTab1);
    const m2 = inbox(honTab2);
    const mt = inbox(tomTab);

    // ping → pong
    honTab1.send('ping');
    await new Promise((r) => setTimeout(r, 50));
    expect(m1).toContain('pong');

    // notifyUser(hon) → hon 兩個分頁都收到、tom 沒有
    await notifyUser(env, hon.userId, { type: 'new-mail' });
    await new Promise((r) => setTimeout(r, 50));
    expect(m1.filter((x) => x !== 'pong')).toEqual(['{"type":"new-mail"}']);
    expect(m2).toEqual(['{"type":"new-mail"}']);
    expect(mt).toEqual([]);

    // F21.2/F21.4：帶 push payload（＝這封留在收件匣）時，廣播多帶寄件者與主旨，
    // 前端才能決定要不要出聲／出卡片。沒有 push（規則歸檔/垃圾/待審）時維持上面那個最小形狀。
    await notifyUser(env, hon.userId, {
      type: 'new-mail',
      push: { title: '陳柏翰', body: '下週三的報價單', url: '/m/abc', id: 'abc' },
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(JSON.parse(m2[1])).toEqual({ type: 'new-mail', id: 'abc', from: '陳柏翰', subject: '下週三的報價單' });
    expect(mt).toEqual([]);

    const closed = (ws: WebSocket) => new Promise<void>((r) => ws.addEventListener('close', () => r()));
    const allClosed = Promise.all([closed(honTab1), closed(honTab2), closed(tomTab)]);
    honTab1.close();
    honTab2.close();
    tomTab.close();
    await allClosed;
  });
});
