// 個人資料：顯示名稱、大頭貼上傳/讀取、聯絡人建議
import { describe, expect, it, vi } from 'vitest';
import { createExecutionContext, env } from 'cloudflare:test';
import worker from '../../src/worker/index';
import { newId } from '../../src/worker/lib/ids';
import { seedUser } from './helpers/fixtures';

const BASE = 'https://mail.miseroda.com/api/v1';

async function apiCall(
  path: string,
  cookies: { session: string; csrf: string },
  opts: { method?: string; body?: unknown; form?: FormData } = {},
) {
  const headers: Record<string, string> = {
    Cookie: `__Host-session=${encodeURIComponent(cookies.session)}; __Host-csrf=${encodeURIComponent(cookies.csrf)}`,
    'X-CSRF-Token': cookies.csrf,
  };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  return worker.fetch(
    new Request(`${BASE}${path}`, {
      method: opts.method ?? (opts.body !== undefined || opts.form ? 'POST' : 'GET'),
      headers,
      body: opts.form ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
    }),
    env,
    createExecutionContext(),
  );
}

/** 直接塞訊息列（測 contacts/suggest 用） */
async function seedMessage(userId: string, args: { direction: 'inbound' | 'outbound'; from?: string; to?: string[]; ts: number }) {
  await env.DB.prepare(
    `INSERT INTO messages (id, user_id, thread_id, direction, from_addr, to_addrs, subject, snippet, received_at, created_at, folder)
     VALUES (?, ?, ?, ?, ?, ?, 's', '', ?, ?, ?)`,
  )
    .bind(
      newId('msg'),
      userId,
      newId('thr'),
      args.direction,
      args.from ?? 'me@miseroda.com',
      JSON.stringify(args.to ?? []),
      args.ts,
      args.ts,
      args.direction === 'outbound' ? 'sent' : 'inbox',
    )
    .run();
}

describe('profile & contacts', () => {
  it('display name, avatar lifecycle, contact suggestions', async () => {
    const hon = await seedUser(env, 'hon@miseroda.com', 'admin');
    const kai = await seedUser(env, 'kai@miseroda.com');

    /* ---- 顯示名稱 ---- */
    const badName = await apiCall('/profile', hon.cookies, { method: 'PATCH', body: { displayName: '' } });
    expect(badName.status).toBe(400);
    const okName = await apiCall('/profile', hon.cookies, { method: 'PATCH', body: { displayName: '陳小翰' } });
    expect(okName.status).toBe(200);
    const me = await (await apiCall('/auth/me', hon.cookies)).json<{ user: { displayName: string }; avatarUrl: string | null }>();
    expect(me.user.displayName).toBe('陳小翰');
    expect(me.avatarUrl).toBeNull();

    /* ---- 頭像：型別/大小守門 ---- */
    const badForm = new FormData();
    badForm.set('file', new File(['hello'], 'note.txt', { type: 'text/plain' }));
    const badType = await apiCall('/profile/avatar', hon.cookies, { form: badForm });
    expect(badType.status).toBe(400);

    /* ---- 頭像：上傳 → 讀取 → 替換刪舊 ---- */
    const form1 = new FormData();
    form1.set('file', new File([new Uint8Array([137, 80, 78, 71])], 'me.png', { type: 'image/png' }));
    const up1 = await apiCall('/profile/avatar', hon.cookies, { form: form1 });
    expect(up1.status).toBe(200);
    const { avatarUrl } = await up1.json<{ avatarUrl: string }>();
    expect(avatarUrl).toContain(`/api/v1/avatars/${hon.userId}`);

    const firstKey = (await env.DB.prepare(`SELECT avatar_key FROM users WHERE id = ?`)
      .bind(hon.userId)
      .first<{ avatar_key: string }>())!.avatar_key;

    // 本人與其他登入者都讀得到（站內顯示用）
    const got = await apiCall(`/avatars/${hon.userId}`, kai.cookies);
    expect(got.status).toBe(200);
    expect(got.headers.get('Content-Type')).toBe('image/png');
    expect((await got.arrayBuffer()).byteLength).toBe(4);

    // by-email（網域內限定）
    const byEmail = await apiCall(`/avatars/by-email?email=hon%40miseroda.com`, kai.cookies);
    expect(byEmail.status).toBe(200);
    await byEmail.arrayBuffer();
    const external = await apiCall(`/avatars/by-email?email=x%40gmail.com`, kai.cookies);
    expect(external.status).toBe(404);
    await external.arrayBuffer();
    const noAvatar = await apiCall(`/avatars/${kai.userId}`, hon.cookies);
    expect(noAvatar.status).toBe(404);
    await noAvatar.arrayBuffer();

    // 替換 → 舊物件刪除
    const form2 = new FormData();
    form2.set('file', new File([new Uint8Array([1, 2, 3])], 'me2.jpg', { type: 'image/jpeg' }));
    const up2 = await apiCall('/profile/avatar', hon.cookies, { form: form2 });
    expect(up2.status).toBe(200);
    await up2.json();
    expect(await env.MAIL_STORE.head(firstKey)).toBeNull();

    /* ---- 聯絡人建議 ---- */
    const now = Date.now();
    await seedMessage(hon.userId, { direction: 'outbound', to: ['firefly@example.org', 'kai@miseroda.com'], ts: now - 1000 });
    await seedMessage(hon.userId, { direction: 'outbound', to: ['firefly@example.org'], ts: now });
    await seedMessage(hon.userId, { direction: 'inbound', from: 'newsletter@firefly-news.io', ts: now - 5000 });
    // 垃圾信寄件者不該出現
    await env.DB.prepare(
      `INSERT INTO messages (id, user_id, thread_id, direction, from_addr, to_addrs, subject, snippet, received_at, created_at, folder)
       VALUES (?, ?, ?, 'inbound', 'scam@evil.io', '[]', 's', '', ?, ?, 'spam')`,
    )
      .bind(newId('msg'), hon.userId, newId('thr'), now, now)
      .run();

    // F2.5：suggestions 改回 { addr, lastUsed } 物件
    const sug = await (await apiCall('/contacts/suggest?q=fire', hon.cookies)).json<{ suggestions: { addr: string; lastUsed: number }[] }>();
    const sugAddrs = sug.suggestions.map((s) => s.addr);
    expect(sugAddrs[0]).toBe('firefly@example.org'); // 最近使用優先
    expect(typeof sug.suggestions[0].lastUsed).toBe('number');
    expect(sugAddrs).toContain('newsletter@firefly-news.io');
    expect(sugAddrs).not.toContain('scam@evil.io');

    // 隔離：kai 查不到 hon 的聯絡人
    const kaiSug = await (await apiCall('/contacts/suggest?q=fire', kai.cookies)).json<{ suggestions: { addr: string; lastUsed: number }[] }>();
    expect(kaiSug.suggestions).toHaveLength(0);
  });

  it('頭像：SVG 不收；既存 SVG 降級成下載；其他影像型別照舊', async () => {
    const hon = await seedUser(env, 'hon@miseroda.com', 'admin');

    // SVG 是可執行腳本的同源文件 → 上傳直接擋
    const svgForm = new FormData();
    svgForm.set(
      'file',
      new File(['<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>'], 'x.svg', { type: 'image/svg+xml' }),
    );
    const svgUp = await apiCall('/profile/avatar', hon.cookies, { form: svgForm });
    expect(svgUp.status).toBe(400);
    await svgUp.json();

    // 其他影像型別（tiff/ico/apng…）仍照收、照原型別 inline 回送（勿誤傷既有頭像）
    const tiffForm = new FormData();
    tiffForm.set('file', new File([new Uint8Array([73, 73, 42, 0])], 'me.tiff', { type: 'image/tiff' }));
    const tiffUp = await apiCall('/profile/avatar', hon.cookies, { form: tiffForm });
    expect(tiffUp.status).toBe(200);
    await tiffUp.json();
    const tiffGot = await apiCall(`/avatars/${hon.userId}`, hon.cookies);
    expect(tiffGot.headers.get('Content-Type')).toBe('image/tiff');
    expect(tiffGot.headers.get('Content-Disposition')).toBe('inline');
    expect(tiffGot.headers.get('Content-Security-Policy')).toBe("sandbox; default-src 'none'");
    await tiffGot.arrayBuffer();

    // 守門加嚴前就存在 R2 的 SVG：不得以 image/svg+xml inline 回送
    const legacyKey = `avatar/${hon.userId}/legacy`;
    await env.MAIL_STORE.put(legacyKey, new Uint8Array([60, 115, 118, 103]), {
      httpMetadata: { contentType: 'image/svg+xml' },
    });
    await env.DB.prepare(`UPDATE users SET avatar_key = ? WHERE id = ?`).bind(legacyKey, hon.userId).run();
    const legacyGot = await apiCall(`/avatars/${hon.userId}`, hon.cookies);
    expect(legacyGot.status).toBe(200);
    expect(legacyGot.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(legacyGot.headers.get('Content-Disposition')).toBe('attachment');
    expect(legacyGot.headers.get('Content-Security-Policy')).toBe("sandbox; default-src 'none'");
    await legacyGot.arrayBuffer();
  });

  // 同一毫秒內連續兩次上傳（雙擊／重送）：第二次讀到的舊 key 會等於自己剛寫的新 key，
  // 刪舊那一步就把剛寫好的物件刪掉 → avatar_key 指向不存在的 R2 物件、頭像無聲消失。
  it('avatar survives a same-millisecond double submit', async () => {
    const hon = await seedUser(env, 'hon@miseroda.com', 'admin');
    const pngForm = () => {
      const f = new FormData();
      f.set('file', new File([new Uint8Array([137, 80, 78, 71])], 'me.png', { type: 'image/png' }));
      return f;
    };

    // 凍結在「現在」：只抹掉兩次上傳之間的時間差，session 期限等其他時間判斷照樣成立。
    const frozen = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(frozen);
    let key1: string;
    let key2: string;
    try {
      const up1 = await apiCall('/profile/avatar', hon.cookies, { form: pngForm() });
      expect(up1.status).toBe(200);
      await up1.json();
      key1 = (await env.DB.prepare(`SELECT avatar_key FROM users WHERE id = ?`)
        .bind(hon.userId)
        .first<{ avatar_key: string }>())!.avatar_key;

      const up2 = await apiCall('/profile/avatar', hon.cookies, { form: pngForm() });
      expect(up2.status).toBe(200);
      await up2.json();
      key2 = (await env.DB.prepare(`SELECT avatar_key FROM users WHERE id = ?`)
        .bind(hon.userId)
        .first<{ avatar_key: string }>())!.avatar_key;
    } finally {
      nowSpy.mockRestore();
    }

    // DB 指到的物件必須真的還在 R2（存在性檢查用 .head()，別用 .get()）
    expect(await env.MAIL_STORE.head(key2)).not.toBeNull();
    const got = await apiCall(`/avatars/${hon.userId}`, hon.cookies);
    expect(got.status).toBe(200);
    await got.arrayBuffer();
    // 時戳相同也必須是不同的 key（key 即版本，邊緣快取靠它辨新舊）
    expect(key2).not.toBe(key1);
  });
});
