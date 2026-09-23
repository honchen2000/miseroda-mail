// F19.2 / 2026-09-20 安全掃描 F9：buildReply 原樣重送寄件者的 .ics 行，裸 CR 可偽造內容行。
// 影響：受害者按下「接受」→ 從自己網域、DKIM 簽名寄出一封 REPLY，在會以裸 CR 斷行的解析器上
// 多出一位「已接受的與會者」。unfold() 只處理 CRLF，單獨的 CR 會留在行內。
import { describe, expect, it } from 'vitest';
import { buildReply } from '../../src/worker/email/calendar';

const CR = String.fromCharCode(13); // 裸 CR，刻意不寫成字面控制字元
const NL = String.fromCharCode(13, 10);

const ics = (summary: string) =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'METHOD:REQUEST', 'BEGIN:VEVENT', 'UID:cal-1@x',
   'ORGANIZER:mailto:boss@example.com', 'SEQUENCE:3', `SUMMARY:${summary}`, 'END:VEVENT', 'END:VCALENDAR', ''].join(NL);

describe('RSVP REPLY 的內容行注入（F19.2）', () => {
  it('SUMMARY 裡的裸 CR 不得在產生的 REPLY 裡變成額外的 ATTENDEE 行', () => {
    const out = buildReply({
      rawIcs: ics(`Team sync${CR}ATTENDEE;PARTSTAT=ACCEPTED;CN=CFO:mailto:cfo@target.com`),
      attendeeEmail: 'me@miseroda.com',
      partstat: 'DECLINED',
      dtStampMs: Date.UTC(2026, 0, 1),
    })!;
    expect(out).toBeTruthy();
    // 注意：位址字串本身仍會留在輸出裡——剝掉 CR 之後那段文字併進了 SUMMARY，成為無害的純文字。
    // 真正要釘的是「它不再是一行獨立的 content line」，所以斷言逐行看，而不是看整份字串有沒有那個位址。
    const lines = out.split(NL);
    expect(lines.filter((l) => l.startsWith('ATTENDEE')).length).toBe(1); // 全文只有本人那一行
    expect(lines.some((l) => l.includes('cfo@target.com') && l.startsWith('ATTENDEE'))).toBe(false);
    expect(/\r(?!\n)/.test(out)).toBe(false); // 輸出裡沒有任何「不成對的」裸 CR
    expect(out).toContain('PARTSTAT=DECLINED:mailto:me@miseroda.com');
    // 只是被攤平成一段無害文字，留在 SUMMARY 裡
    expect(out).toContain('SUMMARY:Team syncATTENDEE;PARTSTAT=ACCEPTED;CN=CFO:mailto:cfo@target.com');
  });

  it('UID / ORGANIZER 裡的控制字元同樣被剝掉，不影響正常欄位', () => {
    const raw = [
      'BEGIN:VCALENDAR', 'BEGIN:VEVENT', `UID:a${String.fromCharCode(1)}b@x`,
      'ORGANIZER:mailto:boss@example.com', 'END:VEVENT', 'END:VCALENDAR', '',
    ].join(NL);
    const out = buildReply({ rawIcs: raw, attendeeEmail: 'me@miseroda.com', partstat: 'ACCEPTED', dtStampMs: 0 })!;
    expect(out).toContain('UID:ab@x');
    expect(out).not.toContain(String.fromCharCode(1));
  });

  it('正常邀請的 REPLY 逐字不變（沒有誤傷合法內容）', () => {
    const out = buildReply({
      rawIcs: ics('專案同步 · 3F'),
      attendeeEmail: 'me@miseroda.com',
      attendeeName: '小明',
      partstat: 'ACCEPTED',
      dtStampMs: Date.UTC(2026, 0, 1, 8, 0, 0),
    })!;
    expect(out).toContain('UID:cal-1@x');
    expect(out).toContain('ORGANIZER:mailto:boss@example.com');
    expect(out).toContain('SUMMARY:專案同步 · 3F');
    expect(out).toContain('SEQUENCE:3');
    expect(out).toContain('METHOD:REPLY');
  });

  it('無 UID 或無 ORGANIZER 的邀請仍回 null（既有行為不變）', () => {
    const raw = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'SUMMARY:x', 'END:VEVENT', 'END:VCALENDAR', ''].join(NL);
    expect(buildReply({ rawIcs: raw, attendeeEmail: 'me@miseroda.com', partstat: 'ACCEPTED', dtStampMs: 0 })).toBeNull();
  });
});
