// 批次二十 F20.2：網址 ↔ 視圖對應（src/app/lib/route.ts）。
// 最重要的一條是「保留路徑不得被前端路由接管」——那些前綴由 worker 直接處理
//（wrangler.jsonc 的 run_worker_first），被蓋掉就是把後端端點弄壞。
import { describe, expect, it } from 'vitest';
import { historyMode, isReservedPath, pathToRoute, pathToView, routeToPath, viewToPath, withQueryParam, type View } from '../../src/app/lib/route';

const ALL_VIEWS: View[] = [
  { type: 'folder', folder: 'inbox' },
  { type: 'folder', folder: 'archive' },
  { type: 'folder', folder: 'needs_reply' },
  { type: 'folder', folder: 'trash' },
  { type: 'label', id: 'lbl_abc123' },
  { type: 'contacts' },
  { type: 'files' },
  { type: 'calendar' },
  { type: 'followups' },
  { type: 'agenda' },
  { type: 'settings' },
  { type: 'admin' },
];

describe('網址 ↔ 視圖（F20.2）', () => {
  it('每一種視圖都能來回轉換且完全還原', () => {
    for (const v of ALL_VIEWS) {
      expect(pathToView(viewToPath(v)), `${JSON.stringify(v)} → ${viewToPath(v)}`).toEqual(v);
    }
  });

  it('收件匣用根路徑，不是 /f/inbox（預設視圖不該讓網址多一段）', () => {
    expect(viewToPath({ type: 'folder', folder: 'inbox' })).toBe('/');
    expect(pathToView('/')).toEqual({ type: 'folder', folder: 'inbox' });
  });

  it('保留路徑一律不接管——那些是 worker 的端點', () => {
    const reserved = ['/api', '/api/v1/messages', '/dl/abc', '/share-target', '/cal/token', '/e/xyz', '/e-decrypt.js'];
    for (const p of reserved) {
      expect(isReservedPath(p), p).toBe(true);
      expect(pathToView(p), p).toBeNull();
    }
    // 只是**開頭像**保留字但其實是獨立路徑的，不該誤判
    expect(isReservedPath('/calendar')).toBe(false);
    expect(isReservedPath('/eagle')).toBe(false);
    expect(pathToView('/calendar')).toEqual({ type: 'calendar' });
  });

  it('未知資料夾與未知路徑回 null（呼叫端回落收件匣並收斂網址）', () => {
    expect(pathToView('/f/not_a_folder')).toBeNull();
    expect(pathToView('/bogus')).toBeNull();
    expect(pathToView('/f')).toBeNull();
    expect(pathToView('/f/')).toBeNull();
    expect(pathToView('/l/')).toBeNull();
    expect(pathToView('/a/b/c')).toBeNull();
  });

  it('畸形的百分號編碼回 null 而不是丟例外（網址是使用者可控的）', () => {
    expect(() => pathToView('/l/%')).not.toThrow();
    expect(pathToView('/l/%')).toBeNull();
    expect(pathToView('/f/%E0%A4%A')).toBeNull();
  });

  it('標籤 id 含特殊字元能正確編碼與還原', () => {
    const v: View = { type: 'label', id: 'a/b c#d' };
    expect(viewToPath(v)).toBe('/l/a%2Fb%20c%23d');
    expect(pathToView(viewToPath(v))).toEqual(v);
  });

  it('尾端斜線正規化', () => {
    expect(pathToView('/settings/')).toEqual({ type: 'settings' });
    expect(pathToView('/f/archive/')).toEqual({ type: 'folder', folder: 'archive' });
    expect(pathToView('//')).toEqual({ type: 'folder', folder: 'inbox' });
  });
});

describe('信件深連結（F20.3）', () => {
  it('信件段掛在視圖後面，收件匣則直接是 /m/<id>', () => {
    expect(routeToPath({ view: { type: 'folder', folder: 'inbox' }, messageId: 'msg_abc' })).toBe('/m/msg_abc');
    expect(routeToPath({ view: { type: 'folder', folder: 'archive' }, messageId: 'msg_abc' })).toBe('/f/archive/m/msg_abc');
    expect(routeToPath({ view: { type: 'label', id: 'lbl_1' }, messageId: 'msg_abc' })).toBe('/l/lbl_1/m/msg_abc');
  });

  it('沒開信時與 viewToPath 完全一致', () => {
    for (const v of ALL_VIEWS) {
      expect(routeToPath({ view: v, messageId: null })).toBe(viewToPath(v));
    }
  });

  it('每一種視圖 × 開信都能來回轉換且完全還原（重整後清單與信都回得來）', () => {
    for (const v of ALL_VIEWS) {
      if (v.type !== 'folder' && v.type !== 'label') continue; // 內容頁沒有讀信窗格
      const r = { view: v, messageId: 'msg_9f3a1b' };
      expect(pathToRoute(routeToPath(r)), routeToPath(r)).toEqual(r);
    }
  });

  it('不合法的信件 id 一律不認（網址是使用者可控的）', () => {
    expect(pathToRoute('/m/')).toBeNull();
    expect(pathToRoute('/m/has space')).toBeNull();
    expect(pathToRoute('/m/a.b')).toBeNull();
    expect(pathToRoute('/m/%')).toBeNull();
    expect(pathToRoute('/m/' + 'x'.repeat(200))).toBeNull();
  });

  it('信件段掛在非法視圖上也回 null，不會只認後半段', () => {
    expect(pathToRoute('/f/not_a_folder/m/msg_abc')).toBeNull();
    expect(pathToRoute('/bogus/m/msg_abc')).toBeNull();
  });

  it('保留路徑即使長得像信件深連結也不接管', () => {
    expect(pathToRoute('/api/v1/m/msg_abc')).toBeNull();
    expect(pathToRoute('/cal/token/m/msg_abc')).toBeNull();
  });

  it('內容頁（行事曆等）不帶信件段時仍正常解析', () => {
    expect(pathToRoute('/calendar')).toEqual({ view: { type: 'calendar' }, messageId: null });
    expect(pathToRoute('/')).toEqual({ view: { type: 'folder', folder: 'inbox' }, messageId: null });
  });
});

describe('歷史紀錄該 push 還是 replace（F20.3）', () => {
  const inbox = { type: 'folder', folder: 'inbox' } as const;
  const archive = { type: 'folder', folder: 'archive' } as const;

  it('網址已經對了 → 什麼都不做（popstate 進來就是這條，防迴圈全靠它）', () => {
    expect(historyMode('/', { view: inbox, messageId: null })).toBe('none');
    expect(historyMode('/m/msg_a', { view: inbox, messageId: 'msg_a' })).toBe('none');
    expect(historyMode('/f/archive', { view: archive, messageId: null })).toBe('none');
  });

  it('同一視圖內換一封信 → replace（歷史裡永遠只留一筆開著信）', () => {
    expect(historyMode('/m/msg_a', { view: inbox, messageId: 'msg_b' })).toBe('replace');
    expect(historyMode('/f/archive/m/msg_a', { view: archive, messageId: 'msg_b' })).toBe('replace');
  });

  it('從清單開第一封信 → push（這一筆就是返回鍵要吃掉的）', () => {
    expect(historyMode('/', { view: inbox, messageId: 'msg_a' })).toBe('push');
    expect(historyMode('/f/archive', { view: archive, messageId: 'msg_a' })).toBe('push');
  });

  it('關掉信 → push（退回清單）', () => {
    expect(historyMode('/m/msg_a', { view: inbox, messageId: null })).toBe('push');
  });

  it('跨視圖即使兩邊都開著信也要 push，不能 replace 掉來源視圖', () => {
    expect(historyMode('/m/msg_a', { view: archive, messageId: 'msg_b' })).toBe('push');
    expect(historyMode('/f/archive/m/msg_a', { view: inbox, messageId: 'msg_b' })).toBe('push');
  });

  it('目前網址無法解析（例如保留路徑或壞網址）→ push，不會誤判成同視圖換信', () => {
    expect(historyMode('/bogus', { view: inbox, messageId: 'msg_a' })).toBe('push');
    expect(historyMode('/api/v1/x', { view: inbox, messageId: 'msg_a' })).toBe('push');
  });
});

describe('搜尋字串進網址（F20.4）', () => {
  it('設定與移除 q', () => {
    expect(withQueryParam('', 'q', 'from:boss')).toBe('?q=from%3Aboss');
    expect(withQueryParam('?q=old', 'q', 'new')).toBe('?q=new');
    expect(withQueryParam('?q=old', 'q', '')).toBe('');
    expect(withQueryParam('', 'q', '')).toBe('');
  });

  it('**保留其餘參數** —— share/launch 是掛載後才從 location.search 讀的，不能被搜尋同步清掉', () => {
    expect(withQueryParam('?share=tok123', 'q', 'hello')).toBe('?share=tok123&q=hello');
    expect(withQueryParam('?launch=compose&q=old', 'q', '')).toBe('?launch=compose');
    expect(withQueryParam('?share=tok123&q=x', 'q', 'y')).toBe('?share=tok123&q=y');
  });

  it('搜尋語法的特殊字元能正確編碼與還原', () => {
    const raw = 'from:boss@x.com has:attachment larger:5m';
    const search = withQueryParam('', 'q', raw);
    expect(new URLSearchParams(search).get('q')).toBe(raw);
  });

  it('前導問號有無都吃得下（location.search 空字串時是 \'\'）', () => {
    expect(new URLSearchParams(withQueryParam('?a=1', 'q', 'z')).get('a')).toBe('1');
    expect(new URLSearchParams(withQueryParam('a=1', 'q', 'z')).get('a')).toBe('1');
  });
});
