import { describe, it, expect } from 'vitest';
import { splitMbox } from '../../src/worker/jobs/importConsumer';

// F7.6：mbox 切分純函式 — 對抗式自審的核心修點（嚴格信封 regex 避 mboxo 誤切 + mboxrd unescape）。
describe('splitMbox', () => {
  it('切兩封標準 mbox', () => {
    const mbox = `From a@x.com Mon Jan  1 00:00:00 2024\nSubject: One\nFrom: a@x.com\n\nBody one.\n\nFrom b@y.com Tue Feb  2 00:00:00 2024\nSubject: Two\nFrom: b@y.com\n\nBody two.\n`;
    const parts = splitMbox(mbox);
    expect(parts.length).toBe(2);
    expect(parts[0]).toContain('Subject: One');
    expect(parts[1]).toContain('Subject: Two');
  });

  it('mboxo 內文「From …」行不被誤切（嚴格信封 regex）', () => {
    const mbox = `From a@x.com Mon Jan  1 00:00:00 2024\nSubject: One\nFrom: a@x.com\n\nFrom the desk of the CEO, here is a note.\nMore body.\n`;
    const parts = splitMbox(mbox);
    expect(parts.length).toBe(1); // 內文「From the desk」不可被當成信封行切開
    expect(parts[0]).toContain('From the desk of the CEO');
  });

  it('mboxrd >From 還原', () => {
    const mbox = `From a@x.com Mon Jan  1 00:00:00 2024\nSubject: One\n\n>From here, escaped line.\n`;
    const parts = splitMbox(mbox);
    expect(parts.length).toBe(1);
    expect(parts[0]).toContain('From here, escaped line.');
    expect(parts[0]).not.toContain('>From here');
  });

  it('空檔回 []', () => {
    expect(splitMbox('')).toEqual([]);
    expect(splitMbox('   \n  ')).toEqual([]);
  });
});
