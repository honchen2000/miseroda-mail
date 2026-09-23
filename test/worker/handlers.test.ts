import { describe, expect, it } from 'vitest';
import { createExecutionContext, createScheduledController, env, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../../src/worker/index';

describe('fetch handler', () => {
  it('GET /api/v1/health returns ok', async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request('https://mail.miseroda.com/api/v1/health'), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean; service: string }>();
    expect(body.ok).toBe(true);
    expect(body.service).toBe('miseroda-mail');
  });

  it('unknown api path without session returns 401 (mail routes gate first)', async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request('https://mail.miseroda.com/api/v1/nope'), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(401);
  });
});

describe('email handler', () => {
  it('rejects mail for unknown recipient', async () => {
    const ctx = createExecutionContext();
    let rejected = '';
    const message = {
      from: 'someone@example.com',
      to: 'hon@miseroda.com',
      raw: new ReadableStream(),
      rawSize: 0,
      headers: new Headers(),
      setReject(reason: string) {
        rejected = reason;
      },
      forward: async () => {},
      reply: async () => {},
    } as unknown as ForwardableEmailMessage;
    await worker.email(message, env, ctx);
    expect(rejected).toContain('No such recipient');
  });
});

describe('scheduled handler stub', () => {
  it('runs without throwing', async () => {
    const ctx = createExecutionContext();
    const controller = createScheduledController({ scheduledTime: new Date(), cron: '* * * * *' });
    await worker.scheduled(controller, env, ctx);
    await waitOnExecutionContext(ctx);
  });
});
