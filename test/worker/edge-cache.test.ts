// R2 邊緣快取（src/worker/lib/edgeCache.ts）：命中路徑、授權在前、Range 繞過、頭像版本。
// 手法：先讀一次讓它進快取 → 刪掉 R2 物件 → 再讀。還拿得到位元組 = 命中快取；404 = 沒走快取。
import { describe, expect, it } from 'vitest';
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../../src/worker/index';
import {
  edgeCacheDelete,
  edgeCacheKey,
  edgeCacheMatch,
  edgeCachePut,
  HTML_CACHE_VER,
} from '../../src/worker/lib/edgeCache';
import { seedUser } from './helpers/fixtures';

// key 每次執行都不同：快取不受 isolatedStorage 回滾，避免跨 it()／跨次執行互相污染
const uniq = () => crypto.randomUUID().replace(/-/g, '').slice(0, 12);

type User = Awaited<ReturnType<typeof seedUser>>;
const cookie = (u: User) =>
  `__Host-session=${encodeURIComponent(u.cookies.session)}; __Host-csrf=${encodeURIComponent(u.cookies.csrf)}`;

async function call(u: User, path: string, headers: Record<string, string> = {}) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`https://mail.miseroda.com${path}`, { headers: { Cookie: cookie(u), ...headers } }),
    env,
    ctx,
  );
  const bytes = new Uint8Array(await res.arrayBuffer().catch(() => new ArrayBuffer(0)));
  await waitOnExecutionContext(ctx); // 等背景 cache.put 落地
  return { status: res.status, bytes, headers: res.headers };
}

async function addAtt(userId: string, id: string, mime: string, body: Uint8Array) {
  await env.MAIL_STORE.put(`att/${id}`, body);
  await env.DB.prepare(
    `INSERT INTO attachments (id, message_id, user_id, filename, mime_type, size_bytes, disposition, r2_key, created_at)
     VALUES (?, NULL, ?, ?, ?, ?, 'attachment', ?, 0)`,
  ).bind(id, userId, `${id}.bin`, mime, body.length, `att/${id}`).run();
}

describe('R2 邊緣快取', () => {
  it('附件：第二次讀走快取（R2 已刪仍拿得到），且標頭集合完全不變', async () => {
    const u = await seedUser(env, `ec1-${uniq()}@miseroda.com`);
    const id = `ec${uniq()}`;
    await addAtt(u.userId, id, 'image/png', new Uint8Array([1, 2, 3, 4]));
    const first = await call(u, `/api/v1/attachments/${id}`);
    expect(first.status).toBe(200);
    await env.MAIL_STORE.delete(`att/${id}`);
    const second = await call(u, `/api/v1/attachments/${id}`);
    expect(second.status).toBe(200); // 命中：沒有 R2 物件也回得出來
    expect([...second.bytes]).toEqual([1, 2, 3, 4]);
    // 快取只存位元組，客戶端標頭一律重組 → 兩次必須一模一樣（含隱私用的 no-store）
    for (const h of ['Content-Type', 'Content-Disposition', 'X-Content-Type-Options', 'Cache-Control']) {
      expect(second.headers.get(h)).toBe(first.headers.get(h));
    }
    expect(second.headers.get('Cache-Control')).toBe('private, no-store, max-age=0');
  });

  it('授權在前：別人的附件即使已在快取裡，換一個使用者仍是 404', async () => {
    const owner = await seedUser(env, `ec2a-${uniq()}@miseroda.com`);
    const other = await seedUser(env, `ec2b-${uniq()}@miseroda.com`);
    const id = `ec${uniq()}`;
    await addAtt(owner.userId, id, 'image/png', new Uint8Array([5, 6, 7, 8]));
    expect((await call(owner, `/api/v1/attachments/${id}`)).status).toBe(200); // 先讓它進快取
    const stolen = await call(other, `/api/v1/attachments/${id}`);
    expect(stolen.status).toBe(404); // DB 擁有權檢查在 cache.match 之前
    expect(stolen.bytes.length).not.toBe(4);
    const stolenInline = await call(other, `/api/v1/attachments/${id}/inline`);
    expect(stolenInline.status).toBe(404);
  });

  it('Range 請求繞過快取（不查也不寫）', async () => {
    const u = await seedUser(env, `ec3-${uniq()}@miseroda.com`);
    const id = `ec${uniq()}`;
    await addAtt(u.userId, id, 'video/mp4', new Uint8Array([1, 2, 3, 4]));
    expect((await call(u, `/api/v1/attachments/${id}`, { Range: 'bytes=0-1' })).status).toBe(200);
    await env.MAIL_STORE.delete(`att/${id}`);
    // 沒寫進快取 → R2 沒了就是 404（若 Range 有寫快取，這裡會變 200）
    expect((await call(u, `/api/v1/attachments/${id}`, { Range: 'bytes=0-1' })).status).toBe(404);
  });

  it('信件 HTML：第二次開信走快取（R2 已刪仍讀得到內文）', async () => {
    const u = await seedUser(env, `ec5-${uniq()}@miseroda.com`);
    const id = `ecm${uniq()}`;
    const key = `html/${u.userId}/${id}.html`;
    await env.MAIL_STORE.put(key, '<p>邊緣快取內文</p>');
    await env.DB.prepare(
      `INSERT INTO messages (id, user_id, thread_id, direction, from_addr, from_name, subject, snippet, folder, r2_html_key, received_at, created_at)
       VALUES (?, ?, ?, 'inbound', 'a@x.com', '小明', '主旨', '', 'inbox', ?, 0, 0)`,
    ).bind(id, u.userId, `t-${id}`, key).run();
    const first = await call(u, `/api/v1/messages/${id}`);
    expect(first.status).toBe(200);
    expect(new TextDecoder().decode(first.bytes)).toContain('邊緣快取內文');
    await env.MAIL_STORE.delete(key);
    const second = await call(u, `/api/v1/messages/${id}`);
    expect(second.status).toBe(200);
    expect(new TextDecoder().decode(second.bytes)).toContain('邊緣快取內文'); // 命中快取
  });

  it('頭像：換頭像後 key 變 → 讀到新圖，不吃舊快取', async () => {
    const u = await seedUser(env, `ec4-${uniq()}@miseroda.com`);
    const k1 = `avatar/${u.userId}/${uniq()}`;
    const k2 = `avatar/${u.userId}/${uniq()}`;
    await env.MAIL_STORE.put(k1, new Uint8Array([1]), { httpMetadata: { contentType: 'image/png' } });
    await env.DB.prepare(`UPDATE users SET avatar_key = ? WHERE id = ?`).bind(k1, u.userId).run();
    const first = await call(u, `/api/v1/avatars/${u.userId}`);
    expect(first.status).toBe(200);
    expect(first.bytes.length).toBe(1);
    expect(first.headers.get('Content-Type')).toBe('image/png');
    // 換頭像：新 key + 舊物件刪除（比照 /profile/avatar 的行為）
    await env.MAIL_STORE.put(k2, new Uint8Array([2, 2]), { httpMetadata: { contentType: 'image/png' } });
    await env.DB.prepare(`UPDATE users SET avatar_key = ? WHERE id = ?`).bind(k2, u.userId).run();
    await env.MAIL_STORE.delete(k1);
    const second = await call(u, `/api/v1/avatars/${u.userId}`);
    expect(second.bytes.length).toBe(2); // 新圖，不是舊快取
    expect(second.headers.get('Content-Type')).toBe('image/png');
  });

  // (a) EDGE_CACHE_ENABLED 是 edgeCache.ts 頂層的 `export const`（模組即時繫結，唯讀）；
  // vitest-pool-workers 明確不支援 vi.mock（見 auth-flow.test.ts 檔頭註解），沒有辦法在測試裡
  // 把它真的切成 false 再驗證「四個呼叫端讀寫全部繞過」。改測 helper 本身在「等同停用」情境下
  // 的可觀察契約：未曾寫入的 key 一律回 null（不是丟例外），put/delete 對任何 key 都是安全的
  // no-op（呼叫端不必包 try/catch）——這正是 EDGE_CACHE_ENABLED=false 時呼叫端會觀察到的行為，
  // 只是沒有真的去撥那個開關。若要對開關本身做端對端驗證，只能改常數、跑一輪、再改回來。
  it('helper 的停用等效契約：未命中回 null、put/delete 皆為安全 no-op', async () => {
    const missKey = edgeCacheKey('html', `html/never-${uniq()}/x.html`);
    expect(await edgeCacheMatch(missKey)).toBeNull();
    const ctx = createExecutionContext();
    expect(() => edgeCachePut({ executionCtx: ctx }, missKey, new Response('x'), 60)).not.toThrow();
    await waitOnExecutionContext(ctx);
    await expect(edgeCacheDelete(missKey)).resolves.toBeUndefined();
  });

  // (b) 已知限制——寫成測試釘住，不是修掉：admin/messages/resanitize 用「相同 r2_html_key」
  // 覆寫 R2 內容（阻斷級問題的成因）。刻意不呼叫該端點本身：端點會呼叫 edgeCacheDelete 清掉
  // 「處理這次 admin 請求的那個 colo」，但單一測試進程只有一份模擬 Cache，呼叫端點會把這裡
  // 想釘住的限制「修好」，反而證明不了問題存在。這裡直接模擬「同 key 覆寫 R2」這個動作本身，
  // 藉此釘住「HTML_CACHE_VER 不變 = 使用者仍會讀到舊消毒結果」這個已知限制。
  it('已知限制：同 key 覆寫 R2 後，HTML_CACHE_VER 不變時舊快取繼續生效（陳舊直到 TTL 或撤回槓桿）', async () => {
    const u = await seedUser(env, `ec6-${uniq()}@miseroda.com`);
    const id = `ecm${uniq()}`;
    const key = `html/${u.userId}/${id}.html`;
    await env.MAIL_STORE.put(key, '<p>舊消毒結果</p>');
    await env.DB.prepare(
      `INSERT INTO messages (id, user_id, thread_id, direction, from_addr, from_name, subject, snippet, folder, r2_html_key, received_at, created_at)
       VALUES (?, ?, ?, 'inbound', 'a@x.com', '小明', '主旨', '', 'inbox', ?, 0, 0)`,
    ).bind(id, u.userId, `t-${id}`, key).run();
    const first = await call(u, `/api/v1/messages/${id}`);
    expect(first.status).toBe(200);
    expect(new TextDecoder().decode(first.bytes)).toContain('舊消毒結果'); // 進快取

    // 模擬 resanitize 的覆寫（不經過端點，理由見上）
    await env.MAIL_STORE.put(key, '<p>新消毒結果</p>');

    const second = await call(u, `/api/v1/messages/${id}`);
    const secondText = new TextDecoder().decode(second.bytes);
    expect(secondText).toContain('舊消毒結果'); // 陳舊：快取仍在，key 沒變
    expect(secondText).not.toContain('新消毒結果'); // 尚未撤回／未過 TTL 前讀不到新內容
  });

  // (c) 撤回槓桿的機制證明：html 命名空間的 key 內含 HTML_CACHE_VER 版本段，版本不同就是不同 key。
  // 常數本身固定為編譯期值（改版要改原始碼＋重新部署，見 edgeCache.ts 註解），無法在同一次測試
  // 執行中真的把它改成別的數字；這裡驗證的是「版本段確實決定 key」這個機制本身：字串替換模擬
  // 調高版本號後的 key，證明兩者不同——這正是「改數字重新部署＝全域撤回」成立的原因。
  it('HTML_CACHE_VER 是 key 的一部分：版本不同就是不同 key（撤回槓桿生效的機制）', () => {
    const r2Key = 'html/usr123/msg456.html';
    const currentUrl = edgeCacheKey('html', r2Key).url;
    expect(currentUrl).toContain(`/html/v${HTML_CACHE_VER}/`);
    const bumpedVerUrl = currentUrl.replace(`/html/v${HTML_CACHE_VER}/`, `/html/v${HTML_CACHE_VER + 1}/`);
    expect(bumpedVerUrl).not.toBe(currentUrl); // 版本一變，key 就變 → 舊 key 形同「查無此鍵」＝全域失效
    // att／avatar 命名空間沒有覆寫路徑（審查已確認），刻意不受這個版本段影響
    expect(edgeCacheKey('att', r2Key).url).not.toContain(`v${HTML_CACHE_VER}`);
    expect(edgeCacheKey('avatar', r2Key).url).not.toContain(`v${HTML_CACHE_VER}`);
  });
});
