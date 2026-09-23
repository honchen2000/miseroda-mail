// Send-as 寄件身分：isOwnSendIdentity 安全閘門 + 寄送整合（合法別名套用到外送 From + 寄件備份；冒用 → 400）。
import { describe, expect, it } from 'vitest';
import { createExecutionContext, createMessageBatch, env, getQueueResult } from 'cloudflare:test';
import worker from '../../src/worker/index';
import { seedUser } from './helpers/fixtures';
import { isOwnSendIdentity } from '../../src/worker/api/send';

const BASE = 'https://mail.miseroda.com/api/v1';

describe('isOwnSendIdentity', () => {
  const ue = 'hon@miseroda.com';
  it('canonical 本身 → true', () => {
    expect(isOwnSendIdentity('hon@miseroda.com', ue)).toBe(true);
    expect(isOwnSendIdentity('HON@miseroda.com', ue)).toBe(true);
  });
  it('本人 +tag 別名 → true', () => {
    expect(isOwnSendIdentity('hon+sales@miseroda.com', ue)).toBe(true);
    expect(isOwnSendIdentity('hon+News.2026@miseroda.com', ue)).toBe(true);
  });
  it('他網域 / 他人 local / 無 + → false（防冒用）', () => {
    expect(isOwnSendIdentity('hon@evil.com', ue)).toBe(false);
    expect(isOwnSendIdentity('hon+sales@evil.com', ue)).toBe(false);
    expect(isOwnSendIdentity('boss@miseroda.com', ue)).toBe(false);
    expect(isOwnSendIdentity('boss+x@miseroda.com', ue)).toBe(false);
    expect(isOwnSendIdentity('attacker@gmail.com', ue)).toBe(false);
  });
  it('危險 tag 字元 → false', () => {
    expect(isOwnSendIdentity('hon+a b@miseroda.com', ue)).toBe(false);
    expect(isOwnSendIdentity('hon+a@b@miseroda.com', ue)).toBe(false);
  });
});

type SendCall = Record<string, unknown> & { to: string[]; from?: { email: string; name: string } };

function stubSendEnv() {
  const calls: SendCall[] = [];
  const envSend = {
    ...env,
    SEND_EMAIL: {
      async send(opts: SendCall) {
        calls.push(opts);
        return { messageId: `<provider-${calls.length}@cf>` };
      },
    },
    SEND_QUEUE: { send: async () => {} },
    INGEST_QUEUE: { send: async () => {} },
  } as unknown as typeof env;
  return { calls, envSend };
}

async function apiCall(path: string, cookies: { session: string; csrf: string }, targetEnv: typeof env, body: unknown) {
  return worker.fetch(
    new Request(`${BASE}${path}`, {
      method: 'POST',
      headers: {
        Cookie: `__Host-session=${encodeURIComponent(cookies.session)}; __Host-csrf=${encodeURIComponent(cookies.csrf)}`,
        'X-CSRF-Token': cookies.csrf,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
    targetEnv,
    createExecutionContext(),
  );
}

function getCall(path: string, cookies: { session: string; csrf: string }, targetEnv: typeof env) {
  return worker.fetch(
    new Request(`${BASE}${path}`, {
      headers: {
        Cookie: `__Host-session=${encodeURIComponent(cookies.session)}; __Host-csrf=${encodeURIComponent(cookies.csrf)}`,
        'X-CSRF-Token': cookies.csrf,
      },
    }),
    targetEnv,
    createExecutionContext(),
  );
}

async function runSendConsumer(sendQueueId: string, targetEnv: typeof env) {
  const batch = createMessageBatch('miseroda-send', [
    { id: crypto.randomUUID(), timestamp: new Date(), body: { kind: 'send', sendQueueId }, attempts: 1 },
  ]);
  const ctx = createExecutionContext();
  await worker.queue(batch, targetEnv, ctx);
  return getQueueResult(batch, ctx);
}

describe('send-as integration', () => {
  it('合法別名 → 外送 From 與寄件備份 from_addr 皆為別名', async () => {
    const { calls, envSend } = stubSendEnv();
    const hon = await seedUser(env, 'hon@miseroda.com', 'admin');
    const res = await apiCall('/messages/send', hon.cookies, envSend, {
      to: ['out@external.com'],
      subject: '報價',
      text: 'hi',
      fromAlias: 'hon+sales@miseroda.com',
      undoWindowSec: 0,
    });
    expect(res.status).toBe(200);
    const { id } = await res.json<{ id: string }>();
    await runSendConsumer(id, envSend);

    expect(calls.length).toBe(1);
    expect(calls[0].from?.email).toBe('hon+sales@miseroda.com');

    const sent = await env.DB.prepare(
      `SELECT from_addr FROM messages WHERE user_id = ? AND folder = 'sent' ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(hon.userId)
      .first<{ from_addr: string }>();
    expect(sent?.from_addr).toBe('hon+sales@miseroda.com');
  });

  it('冒用任意地址 → 400，不入佇列', async () => {
    const { envSend } = stubSendEnv();
    const hon = await seedUser(env, 'hon@miseroda.com', 'admin');
    const res = await apiCall('/messages/send', hon.cookies, envSend, {
      to: ['out@external.com'],
      subject: 'spoof',
      text: 'hi',
      fromAlias: 'ceo@bigbank.com',
      undoWindowSec: 0,
    });
    expect(res.status).toBe(400);
    const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM send_queue WHERE user_id = ?`)
      .bind(hon.userId)
      .first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it('草稿存取保留 fromAlias（後端 schema 不 strip）', async () => {
    const { envSend } = stubSendEnv();
    const hon = await seedUser(env, 'hon@miseroda.com', 'admin');
    const created = await apiCall('/drafts', hon.cookies, envSend, {
      to: 'x@y.com',
      subject: '草稿',
      body: '內容',
      fromAlias: 'hon+sales@miseroda.com',
    });
    expect(created.status).toBe(200);
    const list = await (await getCall('/drafts', hon.cookies, envSend)).json<{
      drafts: { payload: { fromAlias?: string | null } }[];
    }>();
    expect(list.drafts.length).toBe(1);
    expect(list.drafts[0].payload.fromAlias).toBe('hon+sales@miseroda.com');
  });
});
