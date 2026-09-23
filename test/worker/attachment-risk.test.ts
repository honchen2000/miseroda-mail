// F13.3：危險附件副檔名判定純函式（正/反例）。
import { describe, expect, it } from 'vitest';
import { attachmentRiskExt, attachmentWarning } from '../../src/app/lib/attachmentRisk';

describe('F13.3 attachmentRiskExt', () => {
  it('可執行/腳本/巨集/網頁/壓縮命中；大小寫不敏感；雙重副檔名取尾段', () => {
    expect(attachmentRiskExt('setup.exe')).toBe('exe');
    expect(attachmentRiskExt('macro.DOCM')).toBe('docm');
    expect(attachmentRiskExt('page.Html')).toBe('html');
    expect(attachmentRiskExt('photos.zip')).toBe('zip');
    expect(attachmentRiskExt('run.ps1')).toBe('ps1');
    expect(attachmentRiskExt('invoice.pdf.exe')).toBe('exe'); // 偽裝雙副檔名
    expect(attachmentRiskExt('backup.tar.gz')).toBe('gz'); // tarball 壓縮尾段
  });

  it('反例：一般文件/圖片/無副檔名/尾點不命中', () => {
    expect(attachmentRiskExt('報告.pdf')).toBeNull();
    expect(attachmentRiskExt('照片.jpg')).toBeNull();
    expect(attachmentRiskExt('會議記錄.docx')).toBeNull(); // 無巨集的 docx 不警示
    expect(attachmentRiskExt('README')).toBeNull();
    expect(attachmentRiskExt('怪檔名.')).toBeNull();
  });

  it('attachmentWarning：彙整去重、全安全回 null、文案含誠實聲明', () => {
    const w = attachmentWarning(['a.exe', 'b.exe', 'c.zip', 'd.pdf']);
    expect(w).toContain('.exe');
    expect(w).toContain('.zip');
    expect(w).not.toContain('.pdf');
    expect((w!.match(/\.exe/g) ?? []).length).toBe(1); // 去重
    expect(w).toContain('不掃毒');
    expect(attachmentWarning(['a.pdf', 'b.jpg'])).toBeNull();
    expect(attachmentWarning([])).toBeNull();
  });
});
