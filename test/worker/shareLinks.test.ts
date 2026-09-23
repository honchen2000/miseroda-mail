// 大附件下載連結附文（純函式 appendShareLinks）：含 HTML 轉義縱深防禦。
import { describe, expect, it } from 'vitest';
import { appendShareLinks, type ShareLink } from '../../src/app/api/shareLinks';

const link = (o: Partial<ShareLink> = {}): ShareLink => ({
  token: 't',
  url: 'https://mail.miseroda.com/dl/abc',
  filename: 'report.zip',
  sizeBytes: 10 * 1048576,
  expiresAt: 0,
  ...o,
});

describe('appendShareLinks', () => {
  it('無連結 → 原樣回傳', () => {
    expect(appendShareLinks({ body: 'hi', bodyHtml: '<p>hi</p>', linkFiles: [] })).toEqual({ text: 'hi', html: '<p>hi</p>' });
    expect(appendShareLinks({ body: 'hi', bodyHtml: null })).toEqual({ text: 'hi', html: null });
  });

  it('有連結 → text/html 附上下載區', () => {
    const out = appendShareLinks({ body: 'hi', bodyHtml: '<p>hi</p>', linkFiles: [link()] });
    expect(out.text).toContain('https://mail.miseroda.com/dl/abc');
    expect(out.text).toContain('report.zip');
    expect(out.html).toContain('<a href="https://mail.miseroda.com/dl/abc">report.zip</a>');
    expect(out.html).toContain('10.0 MB');
  });

  it('純文字信（html=null）不長出 html', () => {
    const out = appendShareLinks({ body: 'hi', bodyHtml: null, linkFiles: [link()] });
    expect(out.html).toBeNull();
    expect(out.text).toContain('/dl/abc');
  });

  it('filename 的 HTML 特殊字元被轉義（縱深防禦）', () => {
    const out = appendShareLinks({ body: '', bodyHtml: '<p></p>', linkFiles: [link({ filename: '<script>x</script>.zip' })] });
    expect(out.html).not.toContain('<script>');
    expect(out.html).toContain('&lt;script&gt;');
  });
});
