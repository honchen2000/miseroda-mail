// HTML 信件消毒：HTMLRewriter 白名單法（lol-html，規格級 HTML5 parser）
// 三層防禦之一 —— 之後還有 <iframe sandbox>（無 allow-scripts）與頁面 CSP。

const ALLOWED_TAGS = new Set([
  'a', 'abbr', 'article', 'aside', 'b', 'bdi', 'bdo', 'big', 'blockquote', 'br', 'caption',
  'center', 'cite', 'code', 'dd', 'del', 'details', 'dfn', 'div', 'dl', 'dt', 'em', 'figcaption',
  'figure', 'font', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'i', 'img',
  'ins', 'kbd', 'li', 'main', 'mark', 'nav', 'ol', 'p', 'pre', 'q', 's', 'samp', 'section',
  'small', 'span', 'strike', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot',
  'th', 'thead', 'tr', 'u', 'ul', 'wbr',
  // 結構性容器照常保留（body/html 由 transform 自然處理）
  'html', 'head', 'body', 'title',
]);

/** 內容也要一併移除的危險元素 */
const DROP_WITH_CONTENT = new Set(['script', 'style', 'iframe', 'object', 'embed', 'noscript', 'template', 'svg', 'math', 'frameset', 'frame', 'applet', 'audio', 'video', 'select', 'textarea', 'dialog', 'link', 'meta', 'base']);

/** 去殼但保留內容：合法郵件常把整封內容包在 <form>（ASP.NET WebForms / OutSystems）或用 <button> 當 CTA。
 *  若連內容一起 remove 會清空整封信；改 unwrap——表單提交行為自然消失（iframe 無腳本），內部釣魚 input 仍因不在白名單而被移除。 */
const UNWRAP_KEEP_CONTENT = new Set(['form', 'button']);

/** 全域允許屬性 */
const GLOBAL_ATTRS = new Set(['title', 'dir', 'lang', 'align', 'valign', 'width', 'height', 'border', 'cellpadding', 'cellspacing', 'colspan', 'rowspan', 'color', 'bgcolor', 'face', 'size', 'alt']);

function safeUrl(value: string | null, allowMailto = false): string | null {
  if (!value) return null;
  const v = value.trim();
  if (/^https?:\/\//i.test(v)) return v;
  if (allowMailto && /^mailto:/i.test(v)) return v;
  return null;
}

/** 安全的 inline CSS 屬性白名單（尺寸/排版/字體/顏色/邊框/表格——郵件靠 inline style 排版，剝光會撐爆圖片與佈局）。
 *  刻意排除 position/top/left/z-index（防覆蓋釣魚）、content、cursor 等。 */
const SAFE_CSS_PROPS = new Set([
  'width', 'height', 'max-width', 'min-width', 'max-height', 'min-height',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'color', 'background-color', 'background',
  'text-align', 'text-decoration', 'text-transform', 'text-indent', 'text-overflow',
  'font', 'font-size', 'font-weight', 'font-family', 'font-style', 'font-variant',
  'line-height', 'letter-spacing', 'word-spacing', 'white-space', 'word-break', 'overflow-wrap', 'word-wrap',
  'border', 'border-top', 'border-right', 'border-bottom', 'border-left',
  'border-color', 'border-width', 'border-style', 'border-radius', 'border-collapse', 'border-spacing',
  'vertical-align', 'display', 'float', 'clear', 'overflow',
  'list-style', 'list-style-type', 'list-style-position',
  'table-layout', 'caption-side', 'empty-cells', 'direction', 'opacity', 'box-sizing',
]);

/** 危險 CSS 值：remote 載入（追蹤）/老 IE expression XSS/@import/IE behavior/XBL binding/標籤注入 → 整條丟棄。
 *  會取回資源的函式不只 `url()`——`image-set()`／`image()`／`cross-fade()`／`src()` 直接吃裸字串 URL，
 *  在允許的 `background` 上就能在開信當下載入遠端圖（＝追蹤像素，洩漏開信時間/IP/UA），繞過 data-blocked-src；
 *  `element()`／`paint()` 同屬會拉外部內容的函式，一併擋。函式名以子字串比對，順帶涵蓋 `-webkit-image-set(`
 *  這類前綴寫法。`linear-gradient()` 等純繪製函式不在此列，一般電子報的顏色/字體/間距/邊框/漸層照舊。 */
const DANGEROUS_CSS = /(?:url|image-set|image|cross-fade|element|src|paint)\s*\(|expression\s*\(|javascript:|@import|behavior|binding|[<>]/i;

/** 還原 CSS 轉義序列（CSS Syntax L3 §4.3.7）——只供上面的黑名單「比對」用。
 *  `\75 rl(`、`\75rl(`、`\000075rl(`、`u\rl(` 瀏覽器都讀成 `url(`，字面比對卻抓不到（追蹤圖直接載入）。
 *  比對用的正規化字串不會寫回輸出：通過檢查的宣告仍逐字保留原值（合法信件如轉義的 CJK 字體名不受影響）。 */
function decodeCssEscapes(s: string): string {
  if (!s.includes('\\')) return s; // 絕大多數合法宣告無反斜線 → 原字串直出
  // 1~6 個 hex（後面可再吃掉一個空白）→ 該碼位；`\`+換行＝字串續行（去除）；`\x`＝字面 x；結尾孤立 `\` → 去除
  return s.replace(
    /\\(?:([0-9a-f]{1,6})(?:\r\n|[ \t\r\n\f])?|(?:\r\n|[\n\r\f])|([\s\S]))?/gi,
    (_m: string, hex: string | undefined, ch: string | undefined) => {
      if (hex === undefined) return ch ?? '';
      const cp = parseInt(hex, 16);
      // NULL／代理碼位／超出 Unicode 範圍 → U+FFFD（與瀏覽器一致，也避免 fromCodePoint 丟例外）
      return cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) ? '\uFFFD' : String.fromCodePoint(cp);
    },
  );
}

/** 解碼常見 HTML entity。HTMLRewriter 的 getAttribute 回傳「未解碼」原始屬性值，
 *  而 &#39; 等實體尾端帶 ; 會切爛 sanitizeStyle 的 split(';')，故先解碼；也讓 &lt; 還原成 < 後能被危險值過濾抓到。 */
function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(Number(d)); } catch { return ''; } })
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; } })
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&');
}

/* ---- <style> 區塊內聯：合法郵件常把版型放在 <head> 的 class 規則，整段丟棄會塌版。
 *      解析「簡單選擇器」(單一 tag / .class / #id) 內聯到對應元素；保守略過 @media/複合/偽選擇器。 ---- */
interface CssRule {
  tag?: string;
  cls?: string;
  id?: string;
  decls: string;
}

/** 惡意信件防呆上限（真實郵件遠遠用不到——Gmail 光是整封信超過 102KB 就會裁切，版型 CSS 通常 <100KB）。
 *  收件端的 <style> 內容完全由寄件者控制，這裡是 queue consumer 的 CPU/記憶體天花板：
 *  - CSS_CHARS：所有 <style> 區塊合計送進解析的字元數（界定解析成本與中間字串的記憶體）。
 *  - RULES：抽出的規則條數——規則數才是驅動記憶體與「規則×元素」放大的量。
 *  - INLINED：內聯階段（cascade → sanitizeStyle）累計處理的字元數，界定「規則數×元素數」的乘積放大。 */
const MAX_STYLE_CSS_CHARS = 1024 * 1024;
const MAX_STYLE_RULES = 20_000;
const MAX_INLINED_CSS_CHARS = 4 * 1024 * 1024;

/** 以平衡括號移除 @media / @font-face / @supports 等 at-rule 區塊與 @import 行（不臆測響應式覆蓋，取桌面基準）。
 *  保留字元用 slice 分段收集再 join：逐字元 `out += css[i]` 在 1MB 輸入就要吃掉數十 MB heap（cons string）。 */
function stripAtRules(css: string): string {
  if (!css.includes('@')) return css;
  const parts: string[] = [];
  let keepFrom = 0;
  for (let i = 0; i < css.length; i++) {
    if (css[i] !== '@') continue;
    let j = i;
    while (j < css.length && css[j] !== '{' && css[j] !== ';') j++;
    if (j >= css.length || css[j] === ';') {
      parts.push(css.slice(keepFrom, i)); // @import ...;
      keepFrom = j + 1;
      i = j;
      continue;
    }
    let depth = 0; // 區塊 at-rule：跳過平衡括號
    for (; j < css.length; j++) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}' && --depth === 0) break;
    }
    parts.push(css.slice(keepFrom, i));
    keepFrom = j + 1;
    i = j;
  }
  parts.push(css.slice(keepFrom));
  return parts.join('');
}

/** 去 CSS 註解。等價於原本的單趟正則 replace（沒有收尾的 `/*` 一樣原樣保留），
 *  但改用 indexOf 線性掃描：那個 lazy 正則遇到「大量 `/*` 卻無收尾」會從每個起點重掃到尾 → O(n²) 回溯。 */
function stripCssComments(css: string): string {
  let open = css.indexOf('/*');
  if (open < 0) return css;
  const parts: string[] = [];
  let keepFrom = 0;
  while (open >= 0) {
    const close = css.indexOf('*/', open + 2);
    if (close < 0) break; // 未收尾 → 與 replace 一致：整段保留
    parts.push(css.slice(keepFrom, open));
    keepFrom = close + 2;
    open = css.indexOf('/*', keepFrom);
  }
  parts.push(css.slice(keepFrom));
  return parts.join('');
}

/** 在 s 的 at 位置比對小寫 needle（大小寫不敏感）——避免為了找標籤而複製整份 html 做 toLowerCase。 */
function matchesAt(s: string, at: number, lowerNeedle: string): boolean {
  if (at + lowerNeedle.length > s.length) return false;
  for (let k = 0; k < lowerNeedle.length; k++) {
    const c = s.charCodeAt(at + k);
    if ((c >= 65 && c <= 90 ? c + 32 : c) !== lowerNeedle.charCodeAt(k)) return false;
  }
  return true;
}

/** 掃出 `選擇器{宣告}` 規則。等價於原本的 `/([^{}]+)\{([^{}]*)\}/g`，但單趟不回溯：
 *  該正則對「不含大括號的長內容」會從每個起點重試（貪婪的 [^{}]+ 逐字回吐）→ O(n²)，
 *  一段 <style> 塞 1MB 無括號字元就能燒穿 queue consumer 的 CPU 限額。 */
function collectSimpleRules(css: string, rules: CssRule[]): void {
  const n = css.length;
  let i = 0;
  while (i < n && rules.length < MAX_STYLE_RULES) {
    let s = i; // 選擇器起點：正則的 [^{}]+ 只能從非大括號字元起算
    while (s < n && (css[s] === '{' || css[s] === '}')) s++;
    let e = s; // 選擇器結尾＝下一個大括號
    while (e < n && css[e] !== '{' && css[e] !== '}') e++;
    if (e >= n) break;
    if (css[e] === '}') {
      i = e + 1; // 選擇器段被 } 收尾 → 此起點無法成規則
      continue;
    }
    let f = e + 1; // 宣告段結尾
    while (f < n && css[f] !== '{' && css[f] !== '}') f++;
    if (f >= n) break;
    if (css[f] === '{') {
      i = e + 1; // 宣告段內又見 { → 此起點失敗，從內層 { 之後重試
      continue;
    }
    i = f + 1;
    const decls = css.slice(e + 1, f).trim();
    if (!decls) continue;
    for (const sel of css.slice(s, e).split(',')) {
      if (rules.length >= MAX_STYLE_RULES) return;
      const t = sel.trim();
      if (/^\.[-\w]+$/.test(t)) rules.push({ cls: t.slice(1), decls });
      else if (/^#[-\w]+$/.test(t)) rules.push({ id: t.slice(1), decls });
      else if (/^[a-z][-\w]*$/i.test(t)) rules.push({ tag: t.toLowerCase(), decls });
      // 複合/後代/屬性/偽選擇器 → 保守略過
    }
  }
}

/** 抽出所有 <style> 區塊內的簡單規則。
 *  區塊定位改用 indexOf 線性掃描（原本的 `/<style[^>]*>([\s\S]*?)<\/style>/gi` 在缺 `>` 或缺收尾標籤時同樣是 O(n²)）。 */
function extractStyleRules(rawHtml: string): CssRule[] {
  const rules: CssRule[] = [];
  let budget = MAX_STYLE_CSS_CHARS;
  let pos = 0;
  while (pos < rawHtml.length && budget > 0 && rules.length < MAX_STYLE_RULES) {
    const lt = rawHtml.indexOf('<', pos);
    if (lt < 0) break;
    if (!matchesAt(rawHtml, lt, '<style')) {
      pos = lt + 1;
      continue;
    }
    const gt = rawHtml.indexOf('>', lt + 6); // 對應 <style[^>]*>
    if (gt < 0) break; // 開頭標籤不完整 → 之後的 <style 也不可能有 `>`
    let close = -1;
    for (let k = rawHtml.indexOf('<', gt + 1); k >= 0; k = rawHtml.indexOf('<', k + 1)) {
      if (matchesAt(rawHtml, k, '</style>')) {
        close = k;
        break;
      }
    }
    if (close < 0) break; // 無收尾標籤 → 與原本的 lazy 正則一致：不成區塊（之後也不會有）
    const raw = rawHtml.slice(gt + 1, Math.min(close, gt + 1 + budget));
    budget -= raw.length;
    collectSimpleRules(stripAtRules(stripCssComments(raw)), rules);
    pos = close + 8;
  }
  return rules;
}

/** 過濾 inline style：先解碼實體 → 只留安全屬性、丟危險值（字面值與「還原 CSS 轉義後」的值都要過黑名單，
 *  否則 `\75 rl(...)` 這類轉義寫法能繞過）；超長值防呆。HTMLRewriter setAttribute 會再轉義屬性內容。 */
function sanitizeStyle(value: string): string {
  const out: string[] = [];
  for (const decl of decodeEntities(value).split(';')) {
    const idx = decl.indexOf(':');
    if (idx < 0) continue;
    const prop = decl.slice(0, idx).trim().toLowerCase();
    const val = decl.slice(idx + 1).trim();
    if (!prop || !val || val.length > 200) continue;
    if (!SAFE_CSS_PROPS.has(prop)) continue;
    if (DANGEROUS_CSS.test(val) || DANGEROUS_CSS.test(decodeCssEscapes(val))) continue;
    out.push(`${prop}:${val}`); // 保留原值（未還原轉義）——通過檢查者輸出與過去逐字相同
  }
  return out.join(';');
}

export interface SanitizeResult {
  html: string;
  hasRemoteImages: boolean;
}

/**
 * @param cidMap content-id（去角括號）→ 已授權的附件 inline URL
 */
export async function sanitizeEmailHtml(rawHtml: string, cidMap: Map<string, string>): Promise<SanitizeResult> {
  let hasRemoteImages = false;
  let inlineBudget = MAX_INLINED_CSS_CHARS; // 規則數×元素數 的乘積放大天花板

  // <style> 規則預先索引（tag/class/id）→ 套用時內聯
  const byTag = new Map<string, string[]>();
  const byClass = new Map<string, string[]>();
  const byId = new Map<string, string[]>();
  const push = (map: Map<string, string[]>, key: string, v: string) => {
    const arr = map.get(key);
    if (arr) arr.push(v);
    else map.set(key, [v]);
  };
  for (const r of extractStyleRules(rawHtml)) {
    // 不把 <style> 的 body/html 規則內聯到根元素——根畫布由 srcdoc 控制，
    // 且可防惡意/意外的 `body{display:none}` 把整封信變空白（class/id 規則仍照常套用）。
    if (r.tag && r.tag !== 'body' && r.tag !== 'html') push(byTag, r.tag, r.decls);
    if (r.cls) push(byClass, r.cls, r.decls);
    if (r.id) push(byId, r.id, r.decls);
  }

  const rewriter = new HTMLRewriter().on('*', {
    element(el) {
      const tag = el.tagName.toLowerCase();
      if (DROP_WITH_CONTENT.has(tag)) {
        el.remove();
        return;
      }
      if (UNWRAP_KEEP_CONTENT.has(tag) || !ALLOWED_TAGS.has(tag)) {
        // <form>/<button> 去殼留內容（合法信常用 form 包覆全文）；其餘未知標籤同樣去殼留內容
        el.removeAndKeepContent();
        return;
      }

      // 屬性白名單
      const keep = new Map<string, string>();
      for (const [name, value] of el.attributes) {
        const n = name.toLowerCase();
        if (GLOBAL_ATTRS.has(n)) keep.set(n, value);
      }

      // style cascade：<style> 規則(tag→class→id) 依序疊加，最後接元素自身 inline（自身最高優先、保留 !important），
      // 整串過安全白名單再內聯。郵件靠 inline/class 排版，這層讓 class-based 版型不致塌掉、也保住圖片尺寸。
      const styleRules: string[] = [];
      for (const d of byTag.get(tag) ?? []) styleRules.push(d);
      const clsAttr = el.getAttribute('class');
      if (clsAttr) for (const c of clsAttr.split(/\s+/)) for (const d of byClass.get(c) ?? []) styleRules.push(d);
      const idAttr = el.getAttribute('id');
      if (idAttr) for (const d of byId.get(idAttr) ?? []) styleRules.push(d);
      const cascade: string[] = [];
      if (styleRules.length) {
        // 內聯量累計超過上限 → 這個元素放棄 <style> 規則（自身 inline 不受影響），
        // 讓「規則數×元素數」的乘積放大有天花板；正常郵件遠遠達不到。
        const joined = styleRules.join(';');
        if (joined.length <= inlineBudget) {
          inlineBudget -= joined.length;
          cascade.push(joined);
        }
      }
      const ownStyle = el.getAttribute('style');
      if (ownStyle) cascade.push(ownStyle);
      if (cascade.length) {
        const safeStyle = sanitizeStyle(cascade.join(';'));
        if (safeStyle) keep.set('style', safeStyle);
      }

      if (tag === 'a') {
        const href = safeUrl(el.getAttribute('href'), true);
        if (href) {
          keep.set('href', href);
          keep.set('target', '_blank');
          keep.set('rel', 'noopener noreferrer');
        }
      }

      if (tag === 'img') {
        const src = el.getAttribute('src')?.trim() ?? '';
        const cid = /^cid:(.+)$/i.exec(src);
        if (cid) {
          const url = cidMap.get(cid[1].replace(/[<>]/g, ''));
          if (url) keep.set('src', url);
        } else {
          const remote = safeUrl(src);
          if (remote) {
            // 遠端圖片預設封鎖（tracking pixel）：改放 data-blocked-src，前端點擊載入
            hasRemoteImages = true;
            keep.set('data-blocked-src', remote);
          } else if (src.startsWith('data:image/')) {
            keep.set('src', src);
          }
        }
        keep.set('loading', 'lazy');
      }

      // 重設屬性：先全清再放行
      const names: string[] = [];
      for (const [name] of el.attributes) names.push(name);
      for (const name of names) el.removeAttribute(name);
      for (const [k, v] of keep) el.setAttribute(k, v);
    },
    comments(c) {
      c.remove();
    },
  });

  const html = await rewriter.transform(new Response(rawHtml)).text();
  return { html, hasRemoteImages };
}

/** 純文字信轉簡單 HTML（無 html part 時用） */
export function textToHtml(text: string): string {
  const esc = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const paras = esc.split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`);
  return paras.join('\n');
}

/** 從 HTML 萃取純文字（FTS 索引用，已消毒的輸入） */
export async function htmlToText(html: string): Promise<string> {
  let out = '';
  const rewriter = new HTMLRewriter().on('*', {
    text(t) {
      out += t.text;
    },
  });
  await rewriter.transform(new Response(html)).text();
  return out.replace(/\s+/g, ' ').trim();
}
