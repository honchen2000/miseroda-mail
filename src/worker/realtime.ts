// 每使用者 WebSocket hub（Durable Object）
// 新信抵達 → /notify 廣播給所有連線分頁，前端立即刷新
// 用 classic WS API 而非 hibernation：vitest-pool-workers 的 isolated storage
// 無法回收 hibernatable socket 的 DO；本系統使用者數小，常駐時長在免費額度內，
// 且 DO 重啟斷線時前端會自動退避重連。
export class UserHub {
  private sockets = new Set<WebSocket>();

  constructor(_ctx: DurableObjectState, _env: Env) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === '/connect') {
      if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
        return new Response('expected websocket', { status: 426 });
      }
      const pair = new WebSocketPair();
      const server = pair[1];
      server.accept();
      this.sockets.add(server);
      server.addEventListener('message', (ev) => {
        if (ev.data === 'ping') server.send('pong'); // 前端 30s 心跳保活
      });
      server.addEventListener('close', () => {
        this.sockets.delete(server);
        try {
          server.close(); // 回應 close 握手，讓對端的 close 事件能完成
        } catch {
          /* already closed */
        }
      });
      server.addEventListener('error', () => this.sockets.delete(server));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    if (url.pathname === '/notify' && req.method === 'POST') {
      const msg = await req.text();
      for (const ws of this.sockets) {
        try {
          ws.send(msg);
        } catch {
          this.sockets.delete(ws); // 壞 socket 順手清掉
        }
      }
      return new Response(null, { status: 204 });
    }

    return new Response('not found', { status: 404 });
  }
}
