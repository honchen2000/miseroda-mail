// List-Unsubscribe 解析 + 公開 https 守門（純邏輯）
import { describe, expect, it } from 'vitest';
import { isPublicHttpsUrl, parseListUnsubscribe, postOneClickUnsubscribe } from '../../src/worker/email/list-unsubscribe';

describe('parseListUnsubscribe', () => {
  it('https + mailto + one-click', () => {
    const u = parseListUnsubscribe('<https://e.example/u?id=1>, <mailto:unsub@e.example>', 'List-Unsubscribe=One-Click')!;
    expect(u.httpUrl).toBe('https://e.example/u?id=1');
    expect(u.mailto).toBe('mailto:unsub@e.example');
    expect(u.oneClick).toBe(true);
  });
  it('只有 mailto → oneClick false', () => {
    const u = parseListUnsubscribe('<mailto:unsub@e.example?subject=unsub>', null)!;
    expect(u.httpUrl).toBeNull();
    expect(u.mailto).toBe('mailto:unsub@e.example?subject=unsub');
    expect(u.oneClick).toBe(false);
  });
  it('有 https 但無 one-click 標頭 → oneClick false', () => {
    expect(parseListUnsubscribe('<https://e.example/u>', null)!.oneClick).toBe(false);
  });
  it('http（非 https）被拒、僅留可用方式', () => {
    expect(parseListUnsubscribe('<http://e.example/u>', null)).toBeNull(); // 無 https/mailto
    const u = parseListUnsubscribe('<http://e.example/u>, <mailto:x@e.example>', null)!;
    expect(u.httpUrl).toBeNull();
    expect(u.mailto).toBe('mailto:x@e.example');
  });
  it('無標頭 → null', () => {
    expect(parseListUnsubscribe(null, null)).toBeNull();
    expect(parseListUnsubscribe('', null)).toBeNull();
  });
});

describe('isPublicHttpsUrl', () => {
  it('公開 https → true', () => {
    expect(isPublicHttpsUrl('https://list.example.com/unsub')).toBe(true);
  });
  it('http / localhost / 內網 IP / .local → false', () => {
    expect(isPublicHttpsUrl('http://e.example/u')).toBe(false);
    expect(isPublicHttpsUrl('https://localhost/u')).toBe(false);
    expect(isPublicHttpsUrl('https://10.0.0.1/u')).toBe(false);
    expect(isPublicHttpsUrl('https://192.168.1.1/u')).toBe(false);
    expect(isPublicHttpsUrl('https://169.254.1.1/u')).toBe(false);
    expect(isPublicHttpsUrl('https://intra.local/u')).toBe(false);
    expect(isPublicHttpsUrl('not a url')).toBe(false);
  });
  it('FQDN 尾點不得繞過 localhost/.local/.internal 比對', () => {
    expect(isPublicHttpsUrl('https://localhost./u')).toBe(false);
    expect(isPublicHttpsUrl('https://intra.local./u')).toBe(false);
    expect(isPublicHttpsUrl('https://svc.internal./u')).toBe(false);
    expect(isPublicHttpsUrl('https://list.example.com./u')).toBe(true); // 正常主機加尾點仍可用
  });
  it('IPv6 字面值 / 縮寫與整數形 IPv4 → false（URL 正規化後落入既有比對）', () => {
    expect(isPublicHttpsUrl('https://[::1]/u')).toBe(false);
    expect(isPublicHttpsUrl('https://[::ffff:127.0.0.1]/u')).toBe(false); // → [::ffff:7f00:1]
    expect(isPublicHttpsUrl('https://127.1/u')).toBe(false); // → 127.0.0.1
    expect(isPublicHttpsUrl('https://2130706433/u')).toBe(false); // → 127.0.0.1
    expect(isPublicHttpsUrl('https://0x7f.1/u')).toBe(false); // → 127.0.0.1
  });
});

describe('postOneClickUnsubscribe（SSRF：每一跳重驗）', () => {
  const redirect = (to: string, status = 302) => new Response(null, { status, headers: { location: to } });

  it('無轉址：POST + one-click body，回上游 ok', async () => {
    const seen: { url: string; method?: string; body?: unknown }[] = [];
    const ok = await postOneClickUnsubscribe('https://list.example.com/u', (async (url: string, init: RequestInit) => {
      seen.push({ url, method: init.method, body: init.body });
      return new Response('bye', { status: 200 });
    }) as unknown as typeof fetch);
    expect(ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe('POST');
    expect(seen[0].body).toBe('List-Unsubscribe=One-Click');
  });

  it('轉址到內網 → 擋下且不發出第二次請求', async () => {
    const seen: string[] = [];
    const impl = (async (url: string) => {
      seen.push(url);
      return redirect('https://169.254.169.254/latest/meta-data/');
    }) as unknown as typeof fetch;
    await expect(postOneClickUnsubscribe('https://attacker.example/u', impl)).rejects.toThrow('blocked url');
    expect(seen).toEqual(['https://attacker.example/u']); // 只打了第一跳
  });

  it('轉址到 localhost（相對 Location 亦然）→ 擋下', async () => {
    const impl = (async () => redirect('https://localhost/admin')) as unknown as typeof fetch;
    await expect(postOneClickUnsubscribe('https://attacker.example/u', impl)).rejects.toThrow('blocked url');
  });

  it('公開轉址：跟隨且 302 轉 GET（比照 fetch 預設語意，電子報確認頁照常）', async () => {
    const seen: { url: string; method?: string }[] = [];
    const impl = (async (url: string, init: RequestInit) => {
      seen.push({ url, method: init.method });
      return url.endsWith('/u') ? redirect('https://list.example.com/done') : new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;
    expect(await postOneClickUnsubscribe('https://list.example.com/u', impl)).toBe(true);
    expect(seen.map((s) => s.method)).toEqual(['POST', 'GET']);
    expect(seen[1].url).toBe('https://list.example.com/done');
  });

  it('307 維持 POST', async () => {
    const seen: string[] = [];
    const impl = (async (url: string, init: RequestInit) => {
      seen.push(init.method!);
      return url.endsWith('/u') ? redirect('https://list.example.com/done', 307) : new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;
    expect(await postOneClickUnsubscribe('https://list.example.com/u', impl)).toBe(true);
    expect(seen).toEqual(['POST', 'POST']);
  });

  it('轉址圈 → 超過跳數上限就停', async () => {
    let n = 0;
    const impl = (async () => {
      n++;
      return redirect('https://list.example.com/loop');
    }) as unknown as typeof fetch;
    await expect(postOneClickUnsubscribe('https://list.example.com/loop', impl)).rejects.toThrow('too many redirects');
    expect(n).toBe(4); // 首次 + 3 跳
  });

  it('上游 4xx → ok false（不 throw）', async () => {
    const impl = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch;
    expect(await postOneClickUnsubscribe('https://list.example.com/u', impl)).toBe(false);
  });
});
