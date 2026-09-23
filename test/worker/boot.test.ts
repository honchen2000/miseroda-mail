// 效能迴圈 P1：開機驗身並行。驗「兩支同時出發」且「判定順序與結果不變」。
import { describe, expect, it } from 'vitest';
import { bootAuth, isWrongHost } from '../../src/app/lib/boot';
import { collectUnhandledRejections } from './helpers/unhandled';

/** 可手動 resolve/reject 的 promise，用來控制兩支請求的抵達順序。 */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('isWrongHost', () => {
  it('正式網域、localhost、127.0.0.1 都不算不符', () => {
    expect(isWrongHost('mail.miseroda.com', 'mail.miseroda.com')).toBe(false);
    expect(isWrongHost('localhost', 'mail.miseroda.com')).toBe(false);
    expect(isWrongHost('127.0.0.1', 'mail.miseroda.com')).toBe(false);
  });
  it('其他網域（例如 workers.dev 預覽）算不符', () => {
    expect(isWrongHost('miseroda.hon.workers.dev', 'mail.miseroda.com')).toBe(true);
  });
});

describe('bootAuth — 並行', () => {
  it('config 還沒回來時，/auth/me 就已經發出去了（這條在舊的串行寫法會紅）', async () => {
    const cfg = deferred<{ rpId: string }>();
    let meCalls = 0;
    const p = bootAuth({
      host: 'mail.miseroda.com',
      fetchConfig: () => cfg.promise,
      fetchMe: () => {
        meCalls += 1;
        return Promise.resolve({ id: 'u1' });
      },
    });
    await flush();
    expect(meCalls).toBe(1); // config 仍懸而未決
    cfg.resolve({ rpId: 'mail.miseroda.com' });
    const r = await p;
    expect(r.kind).toBe('proceed');
    if (r.kind === 'proceed') await expect(r.me).resolves.toEqual({ id: 'u1' });
    expect(meCalls).toBe(1); // 不會重打
  });

  it('me 比 config 先回來，也要等 config 判完網域才交出結果（判定順序不變）', async () => {
    const cfg = deferred<{ rpId: string }>();
    let settled = false;
    const p = bootAuth({
      host: 'mail.miseroda.com',
      fetchConfig: () => cfg.promise,
      fetchMe: () => Promise.resolve({ id: 'u1' }),
    }).then((r) => {
      settled = true;
      return r;
    });
    await flush();
    expect(settled).toBe(false);
    cfg.resolve({ rpId: 'mail.miseroda.com' });
    expect((await p).kind).toBe('proceed');
  });
});

describe('bootAuth — 結果與舊行為一致', () => {
  it('網域不符 → wrong-host，不把 me 交給呼叫端處理', async () => {
    const r = await bootAuth({
      host: 'evil.example',
      fetchConfig: async () => ({ rpId: 'mail.miseroda.com' }),
      fetchMe: async () => ({ id: 'u1' }),
    });
    expect(r).toEqual({ kind: 'wrong-host' });
  });

  // 更正（2026-09-22）：原本這裡寫「vitest 會把 unhandled rejection 判為失敗」——**錯的**，
  // vitest-pool-workers 不會（紅測實證）。改用 collectUnhandledRejections 明確攔截並斷言；
  // 拿掉 boot.ts 的 `me.catch(() => {})` 這則現在確實會紅。
  it('網域不符且 me 被拒（別的網域帶不上 cookie → 401）→ 不產生 unhandled rejection', async () => {
    let kind = '';
    const seen = await collectUnhandledRejections(async () => {
      const r = await bootAuth({
        host: 'evil.example',
        fetchConfig: async () => ({ rpId: 'mail.miseroda.com' }),
        fetchMe: () => Promise.reject(new Error('401')),
      });
      kind = r.kind;
    });
    expect(kind).toBe('wrong-host');
    expect(seen).toEqual([]);
  });

  it('config 失敗不擋開機（與舊行為一致）', async () => {
    const r = await bootAuth({
      host: 'mail.miseroda.com',
      fetchConfig: () => Promise.reject(new Error('config down')),
      fetchMe: async () => ({ id: 'u1' }),
    });
    expect(r.kind).toBe('proceed');
  });

  it('me 的失敗原樣傳給呼叫端（401／斷線的分支邏輯由呼叫端照舊處理，不被吞掉）', async () => {
    const err = new Error('401');
    const r = await bootAuth({
      host: 'mail.miseroda.com',
      fetchConfig: async () => ({ rpId: 'mail.miseroda.com' }),
      fetchMe: () => Promise.reject(err),
    });
    expect(r.kind).toBe('proceed');
    if (r.kind === 'proceed') await expect(r.me).rejects.toBe(err);
  });
});
