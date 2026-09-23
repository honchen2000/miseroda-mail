// 純邏輯單元測試：vCard 解析 / 產生
import { describe, expect, it } from 'vitest';
import { generateVCard, parseVCard } from '../../src/worker/email/vcard';

describe('generateVCard', () => {
  it('產生 vCard 3.0，含 FN/EMAIL/TEL/NOTE，並跳脫特殊字元', () => {
    const out = generateVCard([{ name: '王, 小明', email: 'wang@example.com', phone: '+886 912', note: '客戶;VIP' }]);
    expect(out).toContain('BEGIN:VCARD');
    expect(out).toContain('VERSION:3.0');
    expect(out).toContain('FN:王\\, 小明'); // 逗號跳脫
    expect(out).toContain('EMAIL;TYPE=INTERNET:wang@example.com');
    expect(out).toContain('TEL:+886 912');
    expect(out).toContain('NOTE:客戶\\;VIP'); // 分號跳脫
    expect(out).toContain('END:VCARD');
  });
  it('無電話/備註則不輸出該行；FN 缺則用 email', () => {
    const out = generateVCard([{ name: '', email: 'a@b.com', phone: '', note: '' }]);
    expect(out).toContain('FN:a@b.com');
    expect(out).not.toContain('TEL:');
    expect(out).not.toContain('NOTE:');
  });
});

describe('parseVCard', () => {
  it('解析多張卡片，取 FN/EMAIL/TEL/NOTE 並反跳脫', () => {
    const vcf = [
      'BEGIN:VCARD', 'VERSION:3.0', 'FN:王\\, 小明', 'EMAIL:Wang@Example.com', 'TEL:+886912', 'NOTE:客戶\\;VIP', 'END:VCARD',
      'BEGIN:VCARD', 'VERSION:3.0', 'FN:Jane', 'EMAIL;TYPE=INTERNET:jane@x.org', 'END:VCARD',
    ].join('\r\n');
    const r = parseVCard(vcf);
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ name: '王, 小明', email: 'wang@example.com', phone: '+886912', note: '客戶;VIP' }); // email 小寫化、跳脫還原
    expect(r[1].email).toBe('jane@x.org');
  });
  it('無有效 email 的卡片略過；非 vCard → 空陣列', () => {
    expect(parseVCard('BEGIN:VCARD\r\nFN:NoEmail\r\nEND:VCARD')).toEqual([]);
    expect(parseVCard('not a vcard')).toEqual([]);
  });
  it('N 欄位在無 FN 時作為名稱（去分號）', () => {
    const r = parseVCard('BEGIN:VCARD\r\nN:陳;大文;;;\r\nEMAIL:c@d.com\r\nEND:VCARD');
    expect(r[0].name).toBe('陳 大文');
  });
  it('ORG/TITLE/BDAY/ADR 解析（F4.3a）', () => {
    const vcf = ['BEGIN:VCARD', 'VERSION:3.0', 'FN:Bob', 'EMAIL:bob@x.com', 'ORG:Acme;Sales', 'TITLE:工程師', 'BDAY:1990-05-15', 'ADR;TYPE=HOME:;;台北市信義路 1 號;;;;', 'END:VCARD'].join('\r\n');
    const r = parseVCard(vcf);
    expect(r[0].company).toBe('Acme'); // ORG 取第一段（去部門）
    expect(r[0].title).toBe('工程師');
    expect(r[0].birthday).toBe('1990-05-15');
    expect(r[0].address).toBe('台北市信義路 1 號');
  });
});

describe('vCard round-trip 含公司/生日（F4.3a）', () => {
  it('generate→parse 保留公司/職稱/生日/地址', () => {
    const c = { name: '小華', email: 'hua@x.com', phone: '0912', note: '', company: 'Acme', title: 'PM', birthday: '--05-15', address: '台北市' };
    const out = generateVCard([c]);
    expect(out).toContain('ORG:Acme');
    expect(out).toContain('TITLE:PM');
    expect(out).toContain('BDAY:--05-15');
    expect(out).toContain('ADR;TYPE=HOME:;;台北市;;;;');
    const r = parseVCard(out)[0];
    expect(r).toMatchObject({ company: 'Acme', title: 'PM', birthday: '--05-15', address: '台北市' });
  });
});
