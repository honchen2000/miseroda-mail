// 寄件者信任卡：收信時把 Authentication-Results 的 SPF/DKIM/DMARC 落地到 messages.auth_verdict。
import { describe, expect, it } from 'vitest';
import { createExecutionContext, env } from 'cloudflare:test';
import worker from '../../src/worker/index';
import { mockEmailMessage, plainEmail, seedUser } from './helpers/fixtures';

function quietEnv() {
  return { ...env, INGEST_QUEUE: { send: async () => {} } } as unknown as typeof env;
}

async function latestVerdict(userId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT auth_verdict FROM messages WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(userId)
    .first<{ auth_verdict: string | null }>();
  return row?.auth_verdict ?? null;
}

describe('sender trust card — auth verdict persistence', () => {
  it('收信時把 Authentication-Results 的 spf/dkim/dmarc 存進 messages.auth_verdict', async () => {
    const qenv = quietEnv();
    const hon = await seedUser(env, 'hon@miseroda.com', 'admin');
    const raw = plainEmail({
      to: 'hon@miseroda.com',
      subject: '信任卡測試',
      extraHeaders: [
        'Authentication-Results: mx.miseroda.com; spf=pass smtp.mailfrom=a@x.com; dkim=pass header.d=x.com; dmarc=pass (p=none)',
      ],
    });
    await worker.email(mockEmailMessage(raw).message, qenv, createExecutionContext());
    const verdict = await latestVerdict(hon.userId);
    expect(verdict).toBeTruthy();
    expect(JSON.parse(verdict!)).toEqual({ spf: 'pass', dkim: 'pass', dmarc: 'pass' });
  });

  it('防偽造：只採信最上方（邊界 MTA）那份 A-R，忽略信體內偽造的第二份', async () => {
    const qenv = quietEnv();
    const hon = await seedUser(env, 'hon@miseroda.com', 'admin');
    const raw = plainEmail({
      to: 'hon@miseroda.com',
      subject: '偽造 A-R',
      extraHeaders: [
        // 最上方 = 可信邊界 MTA：驗證失敗
        'Authentication-Results: mx.miseroda.com; spf=fail; dkim=fail; dmarc=fail',
        // 寄件者在信體內偽造的第二份：謊稱全 pass，必須被忽略
        'Authentication-Results: forged.by-sender; spf=pass; dkim=pass; dmarc=pass',
      ],
    });
    await worker.email(mockEmailMessage(raw).message, qenv, createExecutionContext());
    const verdict = await latestVerdict(hon.userId);
    expect(JSON.parse(verdict!)).toEqual({ spf: 'fail', dkim: 'fail', dmarc: 'fail' });
  });

  it('無 Authentication-Results 標頭時 auth_verdict 為 NULL（誠實留白）', async () => {
    const qenv = quietEnv();
    const hon = await seedUser(env, 'hon@miseroda.com', 'admin');
    await worker.email(
      mockEmailMessage(plainEmail({ to: 'hon@miseroda.com', subject: '無驗證' })).message,
      qenv,
      createExecutionContext(),
    );
    expect(await latestVerdict(hon.userId)).toBeNull();
  });
});
