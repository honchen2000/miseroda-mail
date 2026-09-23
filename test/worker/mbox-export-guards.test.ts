// F19.4 / 2026-09-20 安全掃描 F11：mbox 匯出沒做 From_ 跳脫 → 寄件者可在受害者的備份裡偽造整封信。
// 一併釘住兩件事：① 偽造的 From 行在往返後不會被切成獨立訊息；② 分隔符改用 asctime 之後，
// 匯出檔才真的能被本專案自己的 splitMbox 切開（原本的 toUTCString 產生 "Mon," ——逗號讓 regex 不匹配）。
import { describe, expect, it } from 'vitest';
import { mboxFromLine, mboxrdQuote } from '../../src/worker/lib/mbox';
import { splitMbox } from '../../src/worker/jobs/importConsumer';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

describe('mbox 匯出的 From_ 跳脫（F19.4）', () => {
  it('行首的 From / >From / >>From 各自多加一個 >，其餘位元組原封不動', () => {
    const out = dec(mboxrdQuote(enc('hi\nFrom boss@x Mon\n>From a\n>>From b\nnot From here\n')));
    expect(out).toBe('hi\n>From boss@x Mon\n>>From a\n>>>From b\nnot From here\n');
  });

  it('檔案第一個位元組就是 From 也要跳脫（沒有前導換行）', () => {
    expect(dec(mboxrdQuote(enc('From evil@x Mon Jan  1 00:00:00 2026\nbody')))).toBe('>From evil@x Mon Jan  1 00:00:00 2026\nbody');
  });

  it('不解碼：非 UTF-8 的原始位元組完整保留（Big5 之類的信不可被毀掉）', () => {
    const raw = new Uint8Array([0xa7, 0x41, 0xa6, 0x6e, 0x0a, ...enc('From x@y Mon'), 0x0a, 0xff, 0xfe]);
    const out = mboxrdQuote(raw);
    expect([...out.slice(0, 5)]).toEqual([0xa7, 0x41, 0xa6, 0x6e, 0x0a]); // 前段逐位元組不變
    expect([...out.slice(-2)]).toEqual([0xff, 0xfe]);                      // 尾端 0xff 0xfe 沒被換成 U+FFFD
    expect(out.length).toBe(raw.length + 1);                               // 只多插入一個 '>'
  });

  it('沒有 From 行時回傳原陣列參考（不做無謂複製）', () => {
    const raw = enc('hello\nworld\n');
    expect(mboxrdQuote(raw)).toBe(raw);
  });

  it('分隔符用 asctime，且能被本專案自己的 splitMbox 匹配（toUTCString 的逗號會讓它切不開）', () => {
    const line = mboxFromLine('boss@example.com', Date.UTC(2026, 0, 1, 9, 30, 15));
    expect(line).toBe('From boss@example.com Thu Jan  1 09:30:15 2026\n');
    expect(line.trimEnd()).toMatch(/^From \S+ (?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) /);
    // 舊格式的反證：逗號在星期幾後面 → 同一條 regex 不匹配
    expect(`From boss@example.com ${new Date(Date.UTC(2026, 0, 1)).toUTCString()}`).not.toMatch(/^From \S+ (?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) /);
  });

  it('端到端：內文偽造的 From 行不會在往返後變成獨立訊息', () => {
    const forged = 'Subject: 真信\n\n本文開始\nFrom boss@company.example Mon Jan  1 09:00:00 2026\nSubject: 偽造的信\n\n假內容\n';
    const mbox = (mboxFromLine('attacker@evil.example', Date.UTC(2026, 0, 2, 8, 0, 0))) + dec(mboxrdQuote(enc(forged))) + '\n\n';
    const blocks = splitMbox(mbox);
    expect(blocks.length).toBe(1);                       // 只有一封，不是兩封
    expect(blocks[0]).toContain('From boss@company.example'); // 反跳脫後內文原樣還原
    expect(blocks[0]).toContain('假內容');
  });

  it('兩封真信仍然切得成兩封（跳脫沒有把正常的分隔功能弄壞）', () => {
    const one = (mboxFromLine('a@x.com', Date.UTC(2026, 0, 1))) + dec(mboxrdQuote(enc('Subject: 一\n\n內容一\n'))) + '\n\n';
    const two = (mboxFromLine('b@x.com', Date.UTC(2026, 0, 2))) + dec(mboxrdQuote(enc('Subject: 二\n\n內容二\n'))) + '\n\n';
    const blocks = splitMbox(one + two);
    expect(blocks.length).toBe(2);
    expect(blocks[0]).toContain('內容一');
    expect(blocks[1]).toContain('內容二');
  });
});
