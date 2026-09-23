// 純邏輯單元測試：iCalendar 解析 + 撰寫防呆（忘附件）
import { describe, expect, it } from 'vitest';
import { buildReply, buildRequest, parseIcs } from '../../src/worker/email/calendar';
import { detectDomainTypos, looksLikeForgotAttachment } from '../../src/app/lib/compose-hints';

const CRLF = '\r\n';
function ics(lines: string[]): string {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', ...lines, 'END:VCALENDAR'].join(CRLF);
}

describe('parseIcs', () => {
  it('解析 REQUEST 邀請：UTC 時間 → 精確 epoch + 主辦/地點/主旨', () => {
    const ev = parseIcs(
      ics([
        'METHOD:REQUEST',
        'BEGIN:VEVENT',
        'UID:abc-123@example.com',
        'SUMMARY:專案啟動會議',
        'DTSTART:20260620T010000Z',
        'DTEND:20260620T020000Z',
        'LOCATION:台北辦公室 3F',
        'ORGANIZER;CN=王經理:mailto:boss@example.com',
        'END:VEVENT',
      ]),
    )!;
    expect(ev.method).toBe('REQUEST');
    expect(ev.summary).toBe('專案啟動會議');
    expect(ev.location).toBe('台北辦公室 3F');
    expect(ev.organizer).toEqual({ name: '王經理', email: 'boss@example.com' });
    expect(ev.startMs).toBe(Date.UTC(2026, 5, 20, 1, 0, 0));
    expect(ev.endMs).toBe(Date.UTC(2026, 5, 20, 2, 0, 0));
    expect(ev.allDay).toBe(false);
    expect(ev.uid).toBe('abc-123@example.com');
  });

  it('全天事件（VALUE=DATE）→ allDay + 日期 epoch', () => {
    const ev = parseIcs(ics(['BEGIN:VEVENT', 'SUMMARY:國定假日', 'DTSTART;VALUE=DATE:20260101', 'END:VEVENT']))!;
    expect(ev.allDay).toBe(true);
    expect(ev.startMs).toBe(Date.UTC(2026, 0, 1));
    expect(ev.startText).toBe('2026/01/01');
  });

  it('TEXT 反跳脫 + 行折疊（續行併回）', () => {
    const raw = ics([
      'BEGIN:VEVENT',
      'SUMMARY:季度檢討\\, 含預算',
      'DESCRIPTION:第一行\\n第二行很長很長很長很長很長很長很長很長很長很長很長很長很長很長很長',
      ' 接續同一欄位',
      'END:VEVENT',
    ]);
    const ev = parseIcs(raw)!;
    expect(ev.summary).toBe('季度檢討, 含預算');
    expect(ev.description).toContain('第一行\n第二行');
    expect(ev.description).toContain('接續同一欄位'); // 折疊續行併回
  });

  it('TZID 本地時間 → 牆鐘時間字串、epoch 留 null（不臆測偏移）', () => {
    const ev = parseIcs(
      ics(['BEGIN:VEVENT', 'SUMMARY:會議', 'DTSTART;TZID=Asia/Taipei:20260620T140000', 'END:VEVENT']),
    )!;
    expect(ev.startText).toBe('2026/06/20 14:00');
    expect(ev.startMs).toBeNull();
  });

  it('非 calendar 文字 → null', () => {
    expect(parseIcs('just some text')).toBeNull();
    expect(parseIcs('')).toBeNull();
  });
});

describe('looksLikeForgotAttachment', () => {
  it('提到附件且無附檔 → true（中英）', () => {
    expect(looksLikeForgotAttachment('', '詳見附件，謝謝', 0)).toBe(true);
    expect(looksLikeForgotAttachment('報告', '附上本月報表', 0)).toBe(true);
    expect(looksLikeForgotAttachment('', 'Please see the attached file', 0)).toBe(true);
    expect(looksLikeForgotAttachment('Invoice enclosed', 'hi', 0)).toBe(true);
  });
  it('已有附件 → false（不打擾）', () => {
    expect(looksLikeForgotAttachment('', '詳見附件', 2)).toBe(false);
  });
  it('沒提到附件 → false', () => {
    expect(looksLikeForgotAttachment('午餐', '今天要吃什麼', 0)).toBe(false);
  });
  it('引用原文提到附件、但本次沒提 → false（剝除引用）', () => {
    const body = '好的，收到。\n\n> 原信：請見附件\n> 謝謝';
    expect(looksLikeForgotAttachment('', body, 0)).toBe(false);
  });
});

describe('detectDomainTypos', () => {
  it('抓常見網域拼錯（換位/刪字/替換）並給正確建議', () => {
    expect(detectDomainTypos(['a@gmial.com'])).toEqual([{ recipient: 'a@gmial.com', suggested: 'a@gmail.com' }]); // 換位
    expect(detectDomainTypos(['b@gmai.com'])[0].suggested).toBe('b@gmail.com'); // 刪字
    expect(detectDomainTypos(['c@gmail.con'])[0].suggested).toBe('c@gmail.com'); // 替換
    expect(detectDomainTypos(['d@hotmial.com'])[0].suggested).toBe('d@hotmail.com');
  });
  it('正確網域 / 不相關網域 / 無 @ → 不提示', () => {
    expect(detectDomainTypos(['ok@gmail.com'])).toEqual([]);
    expect(detectDomainTypos(['staff@my-company.com'])).toEqual([]);
    expect(detectDomainTypos(['noatsign'])).toEqual([]);
  });
  it('多收件人去重、只回拼錯的那些', () => {
    const r = detectDomainTypos(['ok@gmail.com', 'x@yahooo.com', 'x@yahooo.com']);
    expect(r).toHaveLength(1);
    expect(r[0].suggested).toBe('x@yahoo.com');
  });
});

describe('buildReply（RSVP REPLY 產生）', () => {
  const invite = ics([
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    'UID:abc-123@example.com',
    'SEQUENCE:2',
    'SUMMARY:專案啟動會議',
    'DTSTART;TZID=Asia/Taipei:20260620T090000',
    'DTEND;TZID=Asia/Taipei:20260620T100000',
    'ORGANIZER;CN=王經理:mailto:boss@example.com',
    'END:VEVENT',
  ]);
  const stamp = Date.UTC(2026, 5, 18, 9, 30, 0);

  it('接受：METHOD:REPLY + 忠實沿用 UID/ORGANIZER/SEQUENCE/DTSTART(含 TZID) + 本人 ATTENDEE(PARTSTAT)', () => {
    const out = buildReply({ rawIcs: invite, attendeeEmail: 'me@miseroda.com', attendeeName: '陳先生', partstat: 'ACCEPTED', dtStampMs: stamp })!;
    expect(out).toContain('METHOD:REPLY');
    expect(out).toContain('UID:abc-123@example.com');
    expect(out).toContain('ORGANIZER;CN=王經理:mailto:boss@example.com');
    expect(out).toContain('SEQUENCE:2'); // 沿用原邀請序號，非預設 0
    // 刻意不帶 DTSTART/DTEND：避免 TZID 無 VTIMEZONE 的非法 .ics（組織者以 UID+ATTENDEE 比對即可）
    expect(out).not.toContain('DTSTART');
    expect(out).not.toContain('DTEND');
    expect(out).toContain('ATTENDEE;CN="陳先生";PARTSTAT=ACCEPTED:mailto:me@miseroda.com');
    expect(out).toContain('DTSTAMP:20260618T093000Z');
    expect(out.endsWith('\r\n')).toBe(true);
  });

  it('拒絕 / 暫定 → 對應 PARTSTAT；無 CN 時不帶 CN 參數', () => {
    const declined = buildReply({ rawIcs: invite, attendeeEmail: 'me@miseroda.com', attendeeName: null, partstat: 'DECLINED', dtStampMs: stamp })!;
    // 無 attendeeName → ATTENDEE 行直接 PARTSTAT，不帶 CN（ORGANIZER 的 CN 為忠實沿用，不在此判斷）
    expect(declined).toContain('ATTENDEE;PARTSTAT=DECLINED:mailto:me@miseroda.com');
    expect(declined).not.toContain('ATTENDEE;CN=');
    const tentative = buildReply({ rawIcs: invite, attendeeEmail: 'me@miseroda.com', partstat: 'TENTATIVE', dtStampMs: stamp })!;
    expect(tentative).toContain('PARTSTAT=TENTATIVE');
  });

  it('無 UID 或無 ORGANIZER 的邀請無法回覆 → null', () => {
    const noOrg = ics(['BEGIN:VEVENT', 'UID:x@e.com', 'SUMMARY:無組織者', 'END:VEVENT']);
    expect(buildReply({ rawIcs: noOrg, attendeeEmail: 'me@miseroda.com', partstat: 'ACCEPTED', dtStampMs: stamp })).toBeNull();
    expect(buildReply({ rawIcs: 'not a calendar', attendeeEmail: 'me@miseroda.com', partstat: 'ACCEPTED', dtStampMs: stamp })).toBeNull();
  });

  it('無 SEQUENCE 的邀請 → 預設 SEQUENCE:0', () => {
    const noSeq = ics(['BEGIN:VEVENT', 'UID:y@e.com', 'ORGANIZER:mailto:o@e.com', 'DTSTART:20260620T010000Z', 'END:VEVENT']);
    const out = buildReply({ rawIcs: noSeq, attendeeEmail: 'me@miseroda.com', partstat: 'ACCEPTED', dtStampMs: stamp })!;
    expect(out).toContain('SEQUENCE:0');
  });
});

describe('buildRequest（自建會議邀請 REQUEST 產生）', () => {
  const stamp = Date.UTC(2026, 5, 18, 9, 30, 0);
  const startMs = Date.UTC(2026, 5, 20, 1, 0, 0);
  const endMs = Date.UTC(2026, 5, 20, 2, 0, 0);

  // 反折行（RFC 5545 §3.1）：長行會被折成 CRLF+空白續行，比對邏輯內容前先還原
  const unfold = (s: string) => s.replace(/\r\n[ \t]/g, '');

  it('產生 METHOD:REQUEST：UTC 起訖時間、ORGANIZER、每位 ATTENDEE 帶 RSVP=TRUE', () => {
    const out = buildRequest({
      uid: 'evt-1@miseroda.com',
      organizerEmail: 'me@miseroda.com',
      organizerName: '陳先生',
      attendees: ['a@x.com', 'b@y.com'],
      summary: '專案啟動會議',
      location: '台北辦公室',
      startMs, endMs, dtStampMs: stamp,
    });
    const u = unfold(out);
    expect(u).toContain('METHOD:REQUEST');
    expect(u).toContain('UID:evt-1@miseroda.com');
    expect(u).toContain('DTSTART:20260620T010000Z'); // UTC，自帶無需 VTIMEZONE
    expect(u).toContain('DTEND:20260620T020000Z');
    expect(u).toContain('SUMMARY:專案啟動會議');
    expect(u).toContain('LOCATION:台北辦公室');
    expect(u).toContain('ORGANIZER;CN="陳先生":mailto:me@miseroda.com');
    expect(u).toContain('ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:a@x.com');
    expect(u).toContain('ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:b@y.com');
    expect(u).toContain('SEQUENCE:0');
    expect(out.endsWith('\r\n')).toBe(true);
  });

  it('TEXT 值正確跳脫（逗號/分號/換行）；無地點/說明則不輸出該行', () => {
    const out = buildRequest({
      uid: 'evt-2@miseroda.com',
      organizerEmail: 'me@miseroda.com',
      attendees: ['a@x.com'],
      summary: '會議, 重要; 請準時',
      description: '第一行\n第二行',
      startMs, endMs, dtStampMs: stamp,
    });
    expect(out).toContain('SUMMARY:會議\\, 重要\\; 請準時');
    expect(out).toContain('DESCRIPTION:第一行\\n第二行');
    expect(out).not.toContain('LOCATION:'); // 未提供地點
  });
});
