// F2.8a：規則 authVerdict 條件（fail/none）。auth_verdict 落信即有 → 第一趟即可評估。
import { describe, expect, it } from 'vitest';
import { createExecutionContext, env } from 'cloudflare:test';
import worker from '../../src/worker/index';
import { seedUser } from './helpers/fixtures';
import { applyRules, matchesConditions, authVerdictField } from '../../src/worker/email/rulesEngine';

let n = 0;
async function addRule(userId: string, conditions: unknown, actions: unknown) {
  n += 1;
  await env.DB.prepare(
    `INSERT INTO rules (id, user_id, name, conditions, actions, enabled, priority, created_at) VALUES (?, ?, 'r', ?, ?, 1, ?, 0)`,
  )
    .bind(`av-${n}`, userId, JSON.stringify(conditions), JSON.stringify(actions), n)
    .run();
}
async function addMsg(userId: string, id: string, authVerdict: string | null) {
  await env.DB.prepare(
    `INSERT INTO messages (id, user_id, thread_id, direction, from_addr, from_name, subject, snippet, folder, auth_verdict, received_at, created_at)
     VALUES (?, ?, ?, 'inbound', 'spoof@evil.com', '偽冒', '中獎通知', '', 'inbox', ?, 0, 0)`,
  )
    .bind(id, userId, `t-${id}`, authVerdict)
    .run();
  return { id, user_id: userId, from_addr: 'spoof@evil.com', from_name: '偽冒', subject: '中獎通知', folder: 'inbox', to_addrs: '' };
}

describe('authVerdictField（F2.8a 衍生）', () => {
  it('DMARC / SPF+DKIM / NULL / 壞 JSON → 等級', () => {
    expect(authVerdictField('{"spf":"pass","dkim":"pass","dmarc":"pass"}')).toBe('pass');
    expect(authVerdictField('{"dmarc":"fail"}')).toBe('fail');
    expect(authVerdictField('{"spf":"fail","dkim":"fail"}')).toBe('fail');
    expect(authVerdictField('{"spf":"pass","dkim":"fail"}')).toBe('partial');
    expect(authVerdictField(null)).toBe('none');
    expect(authVerdictField('not json')).toBe('none');
  });
});

describe('matchesConditions authVerdict（F2.8a）', () => {
  const base = { from: '', subject: '', to: '', hasListUnsubscribe: false };
  it('等值比對；欄位未提供 → 不成立（保守）', () => {
    expect(matchesConditions({ authVerdict: 'fail' }, { ...base, authVerdict: 'fail' })).toBe(true);
    expect(matchesConditions({ authVerdict: 'fail' }, { ...base, authVerdict: 'pass' })).toBe(false);
    expect(matchesConditions({ authVerdict: 'none' }, { ...base, authVerdict: 'none' })).toBe(true);
    expect(matchesConditions({ authVerdict: 'fail' }, base)).toBe(false);
  });
});

describe('applyRules authVerdict（F2.8a 落信第一趟）', () => {
  it('DMARC fail 信 → 規則把它移到 archive', async () => {
    const u = await seedUser(env, 'u@miseroda.com');
    await addRule(u.userId, { authVerdict: 'fail' }, { moveToFolder: 'archive' });
    const msg = await addMsg(u.userId, 'av1', '{"dmarc":"fail"}');
    await applyRules(env, msg, { hasListUnsubscribe: false, firstInsert: true, authVerdict: authVerdictField('{"dmarc":"fail"}') });
    expect((await env.DB.prepare(`SELECT folder FROM messages WHERE id='av1'`).first<{ folder: string }>())?.folder).toBe('archive');
  });

  it('已驗證(pass)信 → 同規則不誤觸', async () => {
    const u = await seedUser(env, 'u2@miseroda.com');
    await addRule(u.userId, { authVerdict: 'fail' }, { moveToFolder: 'archive' });
    const msg = await addMsg(u.userId, 'av2', '{"dmarc":"pass"}');
    await applyRules(env, msg, { hasListUnsubscribe: false, firstInsert: true, authVerdict: authVerdictField('{"dmarc":"pass"}') });
    expect((await env.DB.prepare(`SELECT folder FROM messages WHERE id='av2'`).first<{ folder: string }>())?.folder).toBe('inbox');
  });
});

describe('規則 API：authVerdict 條件能存進去（F2.8a）', () => {
  it('POST /rules 帶 authVerdict 不被 schema 剝掉', async () => {
    const u = await seedUser(env, 'api@miseroda.com');
    const res = await worker.fetch(
      new Request('https://mail.miseroda.com/api/v1/rules', {
        method: 'POST',
        headers: {
          Cookie: `__Host-session=${encodeURIComponent(u.cookies.session)}; __Host-csrf=${encodeURIComponent(u.cookies.csrf)}`,
          'X-CSRF-Token': u.cookies.csrf,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'DMARC fail 降級', conditions: { authVerdict: 'fail' }, actions: { moveToFolder: 'spam' } }),
      }),
      env,
      createExecutionContext(),
    );
    expect(res.status).toBe(200);
    const stored = await env.DB.prepare(`SELECT conditions FROM rules WHERE user_id = ?`).bind(u.userId).first<{ conditions: string }>();
    expect((JSON.parse(stored!.conditions) as { authVerdict?: string }).authVerdict).toBe('fail');
  });
});
