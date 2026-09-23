// 全域 401 處理（client.ts noteUnauthorized）：去抖合併、排除 /auth/*、僅 401。
import { describe, it, expect } from 'vitest';
import { noteUnauthorized, setUnauthorizedHandler } from '../../src/app/api/unauthorized';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('global 401 handler', () => {
  it('coalesces a burst of non-auth 401s into a single revalidation', async () => {
    let calls = 0;
    setUnauthorizedHandler(() => {
      calls++;
    });
    noteUnauthorized('/messages', 401);
    noteUnauthorized('/mailbox/counts', 401);
    noteUnauthorized('/messages/abc', 401);
    expect(calls).toBe(0); // 去抖：尚未觸發
    await sleep(350);
    expect(calls).toBe(1); // 一波多個 401 → 合併為一次
    setUnauthorizedHandler(null);
  });

  it('ignores /auth/* paths and non-401 statuses', async () => {
    let calls = 0;
    setUnauthorizedHandler(() => {
      calls++;
    });
    noteUnauthorized('/auth/me', 401); // 排除：避免迴圈
    noteUnauthorized('/auth/login', 401);
    noteUnauthorized('/messages', 403); // 非 401 不觸發（端點合法 403）
    noteUnauthorized('/messages', 500);
    await sleep(350);
    expect(calls).toBe(0);
    setUnauthorizedHandler(null);
  });

  it('re-arms after firing and is a no-op once unregistered', async () => {
    let calls = 0;
    setUnauthorizedHandler(() => {
      calls++;
    });
    noteUnauthorized('/messages', 401);
    await sleep(350);
    expect(calls).toBe(1);
    noteUnauthorized('/mailbox/counts', 401); // 重新排程
    await sleep(350);
    expect(calls).toBe(2);
    setUnauthorizedHandler(null);
    noteUnauthorized('/messages', 401); // 無 handler → 不觸發、不報錯
    await sleep(350);
    expect(calls).toBe(2);
  });
});
