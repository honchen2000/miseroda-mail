// 收信是兩段式：email() handler 先同步 INSERT 中繼資料（含 snippet），sanitize → 寫 R2 →
// 回填 r2_html_key/remote_images 由 INGEST_QUEUE consumer 稍後做（src/worker/jobs/ingestConsumer.ts
// 的同一行 UPDATE）。在這個空檔開信，舊行為是回一封 html:'' 的信 —— 前端照常渲染就是一張空白卡，
// 而且連「已封鎖遠端資源」提示都沒有（remote_images 同樣還沒回填），使用者以為信壞了。
// 2026-09-19 實測確認此為成因，本測試釘住「中間態要誠實回報 processing」的新行為。
import { describe, expect, it } from 'vitest';
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../../src/worker/index';
import { seedUser } from './helpers/fixtures';

const uniq = () => crypto.randomUUID().replace(/-/g, '').slice(0, 12);

describe('收信中間態（ingest queue 尚未回填內文）', () => {
  it('r2_html_key 為 NULL → processing:true；consumer 回填後 → processing:false 且拿得到內文', async () => {
    const u = await seedUser(env, `pend-${uniq()}@miseroda.com`);
    const id = `msg-pend-${uniq()}`;
    const cookie = `__Host-session=${encodeURIComponent(u.cookies.session)}; __Host-csrf=${encodeURIComponent(u.cookies.csrf)}`;

    // 第一段：email() handler 寫下的樣子 —— 有 snippet（列表看得到字），但沒有 r2_html_key
    await env.DB.prepare(
      `INSERT INTO messages (id, user_id, thread_id, direction, from_addr, from_name, to_addrs, subject, snippet, folder, received_at, created_at)
       VALUES (?, ?, ?, 'inbound', 'no-reply@signup.aws', 'AWS', '[]', 'Verify your email address', '驗證碼摘要', 'inbox', 1, 1)`,
    ).bind(id, u.userId, `t-${id}`).run();

    const read = async () => {
      const ctx = createExecutionContext();
      const res = await worker.fetch(
        new Request(`https://mail.miseroda.com/api/v1/messages/${id}`, { headers: { Cookie: cookie } }),
        env,
        ctx,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        thread: { id: string; html: string; processing?: boolean; remoteImages: boolean }[];
      };
      await waitOnExecutionContext(ctx);
      const m = body.thread.find((x) => x.id === id);
      expect(m).toBeTruthy();
      return m!;
    };

    const before = await read();
    expect(before.processing).toBe(true);
    expect(before.html).toBe(''); // 就是這個空字串讓前端畫出一張空白卡
    expect(before.remoteImages).toBe(false); // 同一行 UPDATE 還沒跑 → 封鎖提示也不會出現

    // 第二段：consumer 做完 —— 寫 R2 + 回填兩個欄位
    const key = `html/${u.userId}/${id}.html`;
    await env.MAIL_STORE.put(key, '<p>驗證碼在這裡</p>');
    await env.DB.prepare(`UPDATE messages SET r2_html_key = ?, remote_images = 1 WHERE id = ?`).bind(key, id).run();

    const after = await read();
    expect(after.processing).toBe(false);
    expect(after.html).toContain('驗證碼在這裡');
    expect(after.remoteImages).toBe(true);
  });
});
