// HTML 消毒器單元測試（直接跑 sanitizeEmailHtml，workerd HTMLRewriter）
import { describe, expect, it } from 'vitest';
import { sanitizeEmailHtml } from '../../src/worker/email/sanitize';

describe('sanitizeEmailHtml', () => {
  it('去殼 <form> 但保留整封內容（ASP.NET WebForms / OutSystems 把全文包在 form 裡）', async () => {
    const html = `<html><body style="font-family: &#39;graphik web&#39;, arial, sans-serif; color:#000000;">
      <form method="post" action="https://phish.example/x" id="WebForm1">
        <div class="aspNetHidden"><input name="__VIEWSTATE" value="abc"></div>
        <table><tr><td><h1>Please verify your email address</h1>
        <p>You've signed up. <a href="https://icbc.example/verify">Verify my email</a></p></td></tr></table>
      </form>
    </body></html>`;
    const { html: out } = await sanitizeEmailHtml(html, new Map());
    // 內容保留（不再整封被清空）
    expect(out).toContain('Please verify your email address');
    expect(out).toContain('https://icbc.example/verify');
    expect(out).toContain('<table');
    // form 外殼與釣魚 input 去除
    expect(out).not.toContain('<form');
    expect(out).not.toContain('<input');
    expect(out).not.toContain('phish.example');
    expect(out).not.toContain('__VIEWSTATE');
    // body 的 font-family inline style 不再被 &#39; 的 ; 切爛（字體名保留）
    expect(out).toContain('graphik web');
  });

  it('仍整段移除危險容器（script/style 內容不留）；<button> 去殼留 CTA 文字', async () => {
    const { html } = await sanitizeEmailHtml(
      `<body><script>alert(1)</script><style>.x{color:red}</style><p>正文</p><button onclick="x()">立即驗證</button></body>`,
      new Map(),
    );
    expect(html).not.toContain('alert(1)');
    expect(html).not.toContain('<style');
    expect(html).not.toContain('color:red'); // style 區塊內容整段移除
    expect(html).toContain('正文');
    expect(html).toContain('立即驗證'); // button 去殼留文字
    expect(html).not.toContain('onclick');
    expect(html).not.toContain('<button');
  });

  it('<style> 區塊內聯：tag/class 規則套到對應元素、display:none 生效、@media 略過', async () => {
    const html = `<html><head><style>
      .btn{background-color:#7c3aed;color:#ffffff;padding:10px}
      .hide{display:none}
      @media (max-width:600px){.btn{padding:4px}}
      p{font-size:15px}
    </style></head><body>
      <a class="btn" href="https://x.example">CTA</a>
      <div class="hide">preheader</div>
      <p>內文</p>
    </body></html>`;
    const { html: out } = await sanitizeEmailHtml(html, new Map());
    expect(out).toMatch(/<a[^>]+style="[^"]*background-color:#7c3aed/); // class 內聯
    expect(out).toContain('color:#ffffff');
    expect(out).toMatch(/<p[^>]+style="[^"]*font-size:15px/); // tag 規則內聯
    expect(out).toMatch(/<div[^>]+style="[^"]*display:none/); // 隱藏 preheader
    expect(out).toContain('padding:10px'); // 基準規則
    expect(out).not.toContain('padding:4px'); // @media 響應式覆蓋被略過
    expect(out).not.toContain('<style'); // style 標籤移除
    expect(out).not.toContain('class='); // class 屬性剝除（樣式已內聯）
  });

  it('<style>：元素自身 inline 排在 class 之後（自身優先）；<style> 內危險值仍擋', async () => {
    const html = `<head><style>.box{width:600px;background:url(https://t.example/x.png)}</style></head><body><div class="box" style="width:300px">x</div></body>`;
    const { html: out } = await sanitizeEmailHtml(html, new Map());
    expect(out).toMatch(/width:600px;width:300px/); // class 先、自身後 → 瀏覽器取後者(300)
    expect(out).not.toContain('url('); // <style> 內的遠端背景圖被擋
  });

  it('<style> 惡意超長內容不會拖垮消毒（ReDoS 防線），正常區塊照常內聯', async () => {
    // 舊實作的三個正則（區塊比對／去註解／規則比對）對這類輸入都會 O(n²) 回溯：
    // 512KB 無大括號內容要跑上百秒 → 燒穿 queue consumer 的 CPU 限額（此測試會直接逾時）。
    const html = `<head>
      <style>.btn{color:#123456}</style>
      <style>${'a'.repeat(512 * 1024)}</style>
      <style>${'/*'.repeat(64 * 1024)}</style>
    </head><body><p class="btn">CTA</p></body>`;
    const { html: out } = await sanitizeEmailHtml(html, new Map());
    expect(out).toMatch(/<p[^>]+style="[^"]*color:#123456/); // 正常規則仍內聯
    expect(out).not.toContain('<style');

    // 未收尾的 <style> 開頭洪水：區塊比對正則同樣是 O(n²)
    const { html: out2 } = await sanitizeEmailHtml(`<p>正文</p>${'<style>'.repeat(20000)}`, new Map());
    expect(out2).toContain('正文');
  });

  it('大量 @media／CSS 註解的模板：後段基準規則仍完整內聯（防呆上限不吃掉合法規則）', async () => {
    let media = '';
    while (media.length < 70 * 1024) media += `@media (max-width:600px){.m${media.length}{padding:4px}}\n`;
    let comments = '';
    while (comments.length < 200 * 1024) comments += '/* legacy ESP template filler */\n';
    const html = `<head><style>${comments}${media}.tail{color:#abcdef}</style></head><body><div class="tail">x</div></body>`;
    const { html: out } = await sanitizeEmailHtml(html, new Map());
    expect(out).toMatch(/<div[^>]+style="[^"]*color:#abcdef/); // @media/註解之後的基準規則沒被丟掉
    expect(out).not.toContain('padding:4px'); // @media 響應式覆蓋照舊略過
  });

  it('CSS 轉義寫法不能繞過危險值黑名單（\\75 rl(...) 追蹤圖）', async () => {
    // 瀏覽器會把 `\75 rl(` 讀成 `url(` → 開信即自動載入追蹤圖；字面比對抓不到，需先還原轉義
    const payloads = [
      'background:\\75 rl(https://t.example/p.png)',      // hex + 一個被吃掉的空白
      'background:\\75rl(https://t.example/p.png)',        // hex 後直接接非 hex 字元
      'background:\\000075rl(https://t.example/p.png)',    // 六位 hex
      'background:u\\rl(https://t.example/p.png)',         // `\r`＝字面 r（非 hex 的字面轉義）
      'background:&#92;75 rl(https://t.example/p.png)',    // 反斜線本身再用 HTML entity 包一層
      'width:\\65 xpression(alert(1))',                    // 同一招對 expression( 也適用
    ];
    for (const p of payloads) {
      const { html } = await sanitizeEmailHtml(`<div style="width:120px;${p}">x</div>`, new Map());
      expect(html, p).toContain('width:120px'); // 同一條 style 裡的合法宣告不受牽連
      expect(html, p).not.toContain('t.example');
      expect(html, p).not.toContain('rl(');
      expect(html, p).not.toContain('xpression(');
    }
  });

  it('url() 以外的取回函式（image-set/cross-fade…）也擋，含轉義寫法', async () => {
    // 這些函式吃裸字串 URL，值裡沒有 `url(` → 舊黑名單放行，開信即載入追蹤圖
    const payloads = [
      'background:image-set("https://t.example/p.png" 1x)',
      'background:-webkit-image-set("https://t.example/p.png" 1x)',
      'background:image("https://t.example/p.png")',
      'background:cross-fade("https://t.example/p.png" 50%, #fff)',
      'background:element(#x)',
      'font-family:src("https://t.example/f.woff2")',
      'background:\\69 mage-set("https://t.example/p.png" 1x)', // CSS 轉義（\69 = i）不能繞過
    ];
    for (const p of payloads) {
      const { html } = await sanitizeEmailHtml(`<div style="width:120px;${p}">x</div>`, new Map());
      expect(html, p).toContain('width:120px'); // 同一條 style 裡的合法宣告不受牽連
      expect(html, p).not.toContain('t.example');
      expect(html, p).not.toContain('image-set');
      expect(html, p).not.toContain('cross-fade');
      expect(html, p).not.toContain('element(');
    }
  });

  it('一般電子報排版（顏色/字體/間距/邊框/漸層）不受取回函式黑名單影響', async () => {
    const { html } = await sanitizeEmailHtml(
      `<div style="background:linear-gradient(180deg,#fff 0%,#eee 100%);border:1px solid #ddd;padding:12px;font-family:'Helvetica Neue',Arial,sans-serif;color:#333">x</div>`,
      new Map(),
    );
    expect(html).toContain('linear-gradient(180deg,#fff 0%,#eee 100%)');
    expect(html).toContain('border:1px solid #ddd');
    expect(html).toContain('padding:12px');
    expect(html).toContain('Helvetica Neue');
    expect(html).toContain('color:#333');
  });

  it('合法的 CSS 轉義（跳脫的 CJK 字體名）原樣保留', async () => {
    const { html } = await sanitizeEmailHtml(
      `<p style="font-family:\\5FAE\\8F6F\\96C5\\9ED1,'Microsoft YaHei',sans-serif;font-size:15px">內文</p>`,
      new Map(),
    );
    expect(html).toContain('\\5FAE\\8F6F\\96C5\\9ED1'); // 逐字保留（不改寫成解碼後的字元）
    expect(html).toContain('font-size:15px');
  });

  it('inline style 危險值即使用實體編碼也擋下（&lt; 解碼後被過濾）', async () => {
    const { html } = await sanitizeEmailHtml(
      `<div style="width:120px;background:url(https://t.example/p.png);font-family:&#39;Arial&#39;">x</div>`,
      new Map(),
    );
    expect(html).toContain('width:120px'); // 安全尺寸保留
    expect(html).toContain('Arial'); // 解碼後字體名保留
    expect(html).not.toContain('url('); // 遠端背景圖丟棄
    expect(html).not.toContain('t.example');
  });
});
