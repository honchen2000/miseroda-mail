// 信件內文被關進小框自己捲（Hon 2026-09-23 手機回報）——判斷哪些容器要解開高度限制。
import { describe, expect, it } from 'vitest';
import {
  EMPTY_FIT_WIDTH, FIT_WRAPPER, MIN_FIT_ZOOM, OSCILLATION_WINDOW_MS, SCROLLER_CANDIDATES, fitZoom, isTrappingScroller,
  isViewportRelativeLength, recordFitWidth, shouldRefitWidth, widthChanged, type FitWidthState,
} from '../../src/app/lib/emailFit';
import { buildSrcdoc } from '../../src/app/lib/emailSrcdoc';
import { sanitizeEmailHtml } from '../../src/worker/email/sanitize';

describe('isTrappingScroller', () => {
  it('overflow:auto 且內容超出可視高度 → 要解開（實機：326×124 的框裝 372 高的內容）', () => {
    expect(isTrappingScroller({ overflowY: 'auto', scrollHeight: 372, clientHeight: 124 })).toBe(true);
    expect(isTrappingScroller({ overflowY: 'scroll', scrollHeight: 500, clientHeight: 80 })).toBe(true);
  });

  it('overflow:hidden 不碰——常被用來藏預覽文字（max-height:0），解開會露出不該看到的字', () => {
    expect(isTrappingScroller({ overflowY: 'hidden', scrollHeight: 40, clientHeight: 0 })).toBe(false);
  });

  it('可捲但內容沒超出（只是左右寬）→ 不動', () => {
    expect(isTrappingScroller({ overflowY: 'auto', scrollHeight: 372, clientHeight: 372 })).toBe(false);
  });

  it('1px 以內的捨入誤差不算超出', () => {
    expect(isTrappingScroller({ overflowY: 'auto', scrollHeight: 201, clientHeight: 200 })).toBe(false);
    expect(isTrappingScroller({ overflowY: 'auto', scrollHeight: 202, clientHeight: 200 })).toBe(true);
  });

  it('visible 的元素內容超出會自然往外撐，量得到 → 不動', () => {
    expect(isTrappingScroller({ overflowY: 'visible', scrollHeight: 500, clientHeight: 80 })).toBe(false);
  });
});

describe('SCROLLER_CANDIDATES', () => {
  it('不分大小寫比對 style 屬性裡的 overflow（消毒器會把 <style> 規則內聯成 style 屬性）', () => {
    expect(SCROLLER_CANDIDATES).toBe('[style*="overflow" i]');
  });
});

describe('症狀的前半段：消毒後這種寫法仍會原樣送到前端', () => {
  // 消毒器只擋 <style> 裡的 body/html 規則；標籤上的 style 屬性照留，iframe 解析時會合併到我們的根元素。
  // 伺服器端不動它（已存的舊信也要能修）→ 由前端 unfoldEmailDocument 在量高度前解開。
  it('<html>/<body> 的 height:100% 與內層 overflow:auto 包裝都被保留', async () => {
    const src = '<html style="height:100%"><body style="height:100%;margin:0"><div style="height:100%;overflow:auto"><table width="600"><tr><td>Hello</td></tr></table></div></body></html>';
    const { html } = await sanitizeEmailHtml(src, new Map());
    expect(html).toMatch(/<html[^>]*style="[^"]*height:\s*100%/);
    expect(html).toMatch(/<body[^>]*style="[^"]*height:\s*100%/);
    expect(html).toMatch(/<div[^>]*style="[^"]*overflow:\s*auto/);
  });
});

describe('fitZoom — 寬版信縮放到閱讀區寬度（Hon 定案乙案）', () => {
  it('本來就放得下 → 不縮（含 1px 捨入）', () => {
    expect(fitZoom(343, 343)).toBe(1);
    expect(fitZoom(343, 344)).toBe(1);
    expect(fitZoom(343, 200)).toBe(1);
  });
  it('600px 版型放進 iPhone 內文區 → 等比縮到剛好一個寬度', () => {
    expect(fitZoom(326, 600)).toBeCloseTo(326 / 600, 5);
  });
  it('需要縮到下限以下 → 乾脆不縮（異常長字串別讓整封字都看不見；實測 0.3 時一般段落只剩約 4px）', () => {
    expect(MIN_FIT_ZOOM).toBe(0.4);
    expect(fitZoom(326, 4786)).toBe(1);
    expect(fitZoom(340, 850)).toBeCloseTo(0.4, 5);
  });
  it('還沒有版面（寬 0）→ 不縮', () => {
    expect(fitZoom(0, 600)).toBe(1);
  });
});

describe('widthChanged — 轉向／拖窗格才重算，自己改高度不算', () => {
  it('第一次有寬度 → 要算', () => {
    expect(widthChanged(null, 343)).toBe(true);
  });
  it('寬度沒變（我們設高度觸發的 ResizeObserver）→ 略過，不回授', () => {
    expect(widthChanged(343, 343)).toBe(false);
    expect(widthChanged(343, 343.4)).toBe(false);
  });
  it('轉向 → 要重算', () => {
    expect(widthChanged(343, 780)).toBe(true);
  });
  it('被藏起來（寬 0）→ 不算，等再顯示', () => {
    expect(widthChanged(343, 0)).toBe(false);
    expect(widthChanged(null, 0)).toBe(false);
  });
});

describe('FIT_WRAPPER', () => {
  it('是自訂標籤：信件多出來的 </div> 關不掉它；消毒器會拆掉未知標籤，信件偽造不出同名元素', async () => {
    expect(FIT_WRAPPER).toBe('mr-fit');
    const { html } = await sanitizeEmailHtml('<mr-fit style="zoom:9">x</mr-fit></div><p>y</p>', new Map());
    expect(html).not.toContain('mr-fit');
  });
});

describe('buildSrcdoc', () => {
  it('信件內容包在縮放外層裡，外層是 flow-root（把浮動的 table／img 包進來）', () => {
    const doc = buildSrcdoc('<p>hi</p>', false);
    expect(doc).toContain('<body><mr-fit><p>hi</p></mr-fit></body>');
    // 只是 block 的話，<table align="left"> 這種浮動內容不撐高也不算寬 → iframe 卡在 40px、不縮放（NameSilo 信）
    expect(doc).toContain('mr-fit{display:flow-root}');
  });

  it('Hon 的 NameSilo 信（<TABLE WIDTH="600" ALIGN="left">）消毒後 align 仍在 → 瀏覽器當 float', async () => {
    const src = '<HTML>\n<TABLE WIDTH="600" ALIGN="left">\n<TR>\n<TD>\n<font face="arial" size="2">Hello,<br /><p>Thank you for reporting domain: example.cc</font>\n</TD>\n</TR>\n</TABLE>\n</HTML>';
    const { html } = await sanitizeEmailHtml(src, new Map());
    expect(html).toMatch(/<table[^>]*align="left"/i);
  });
  it('關掉 iOS 文字自動放大（600px 版型會被放大到 23px）', () => {
    expect(buildSrcdoc('', false)).toContain('-webkit-text-size-adjust:100%');
  });
  it('既有行為不變：載入圖片才還原 src、引文摺疊只在螢幕', () => {
    expect(buildSrcdoc('<img data-blocked-src="x">', true)).toContain('<img src="x">');
    expect(buildSrcdoc('<img data-blocked-src="x">', false)).toContain('data-blocked-src="x"');
    expect(buildSrcdoc('', false, false)).toContain('@media screen{[data-quote]{display:none}}');
    expect(buildSrcdoc('', false, true)).not.toContain('[data-quote]');
  });
});

describe('isViewportRelativeLength — 以視窗為單位的高度要歸零（iframe 依內容定高 → 循環定義）', () => {
  it('vh 系列、vmin/vmax、calc 裡的都算', () => {
    for (const v of ['100vh', '100VH', '50.5vh', '100dvh', '100svh', '100lvh', '40vmin', '60vmax', '100vb', 'calc(100vh - 20px)']) {
      expect(isViewportRelativeLength(v)).toBe(true);
    }
  });
  it('px／%／vw／auto／空值不算（vw 只跟寬度有關，我們不改寬）', () => {
    for (const v of ['600px', '100%', '50vw', 'auto', '', 'inherit']) {
      expect(isViewportRelativeLength(v)).toBe(false);
    }
  });
});

describe('shouldRefitWidth — 捲軸出現／消失造成的寬度振盪不會無限重算（審查 HIGH）', () => {
  // 模擬 ResizeObserver：寬度變了 → 問要不要重算 → 要的話記下，回傳重算次數
  const run = (widths: number[], stepMs = 50) => {
    let st: FitWidthState = EMPTY_FIT_WIDTH;
    let now = 0;
    let refits = 0;
    const fittedAt: number[] = [];
    for (const w of widths) {
      now += stepMs;
      if (shouldRefitWidth(st, w, now)) {
        refits++;
        fittedAt.push(w);
        st = recordFitWidth(st, w, now);
      }
    }
    return { refits, fittedAt, st };
  };

  it('從寬的開始：寬→窄（捲軸出現）重算，彈回寬的略過 → 停住，比例用窄的（放得下）', () => {
    const r = run([358, 346, 358, 346, 358, 346, 358]);
    expect(r.refits).toBe(2);
    expect(r.st.last).toBe(346);
  });

  it('從窄的開始：最多 3 次重算就停住，最後一次用的是窄的寬度', () => {
    const r = run([346, 358, 346, 358, 346, 358, 346, 358]);
    expect(r.refits).toBe(3);
    expect(r.fittedAt[r.fittedAt.length - 1]).toBe(346);
  });

  it('快速轉回直向（變窄）照常重算——不然直向會套到橫向的比例而被切', () => {
    const r = run([358, 812, 358]);
    expect(r.fittedAt).toEqual([358, 812, 358]);
  });

  it('超過振盪時間窗才彈回寬的 → 是真的改變，照常重算', () => {
    const r = run([358, 346, 358], OSCILLATION_WINDOW_MS + 1);
    expect(r.refits).toBe(3);
  });

  it('拖拉窗格（寬度單調變化）每一步都重算', () => {
    const r = run([600, 590, 580, 570, 560]);
    expect(r.refits).toBe(5);
  });

  it('寬度沒變、或被藏起來（0）→ 不重算、不記', () => {
    const st = recordFitWidth(EMPTY_FIT_WIDTH, 358, 0);
    expect(shouldRefitWidth(st, 358, 10)).toBe(false);
    expect(shouldRefitWidth(st, 0, 10)).toBe(false);
    expect(recordFitWidth(st, 0, 10)).toBe(st);
  });
});
