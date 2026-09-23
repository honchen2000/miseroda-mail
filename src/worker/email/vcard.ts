// vCard 3.0 解析 / 產生（純函式可測）。用於通訊錄匯入 / 匯出。
export interface VCardContact {
  name: string;
  email: string;
  phone: string;
  note: string;
  company?: string; // ORG（取第一段）
  title?: string; // TITLE
  birthday?: string; // BDAY（YYYY-MM-DD 或 --MM-DD）
  address?: string; // ADR（單行；產生時放 street 欄，解析時併非空段）
}

/** TEXT 值跳脫（vCard：\ ; , 與換行）。 */
function vEscape(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/\r\n?|\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,');
}
function vUnescape(v: string): string {
  return v.replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}

/** vCard 行折疊還原：續行以空白 / Tab 開頭，併回上一行。 */
function unfold(body: string): string[] {
  return body.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n').filter((l) => l.trim());
}

/** 產生 vCard 3.0 文字（多筆）。 */
export function generateVCard(contacts: VCardContact[]): string {
  const cards = contacts.map((c) =>
    [
      'BEGIN:VCARD',
      'VERSION:3.0',
      `FN:${vEscape(c.name || c.email)}`,
      c.email ? `EMAIL;TYPE=INTERNET:${c.email}` : null,
      c.phone ? `TEL:${vEscape(c.phone)}` : null,
      c.company ? `ORG:${vEscape(c.company)}` : null,
      c.title ? `TITLE:${vEscape(c.title)}` : null,
      c.birthday ? `BDAY:${vEscape(c.birthday)}` : null,
      c.address ? `ADR;TYPE=HOME:;;${vEscape(c.address)};;;;` : null, // 單行地址放 street 段
      c.note ? `NOTE:${vEscape(c.note)}` : null,
      'END:VCARD',
    ]
      .filter((l): l is string => l !== null)
      .join('\r\n'),
  );
  return cards.join('\r\n') + (cards.length ? '\r\n' : '');
}

/** 解析 vCard 文字 → 聯絡人陣列（取每張卡的 FN/EMAIL/TEL/NOTE；無有效 email 者略過）。max 限制筆數，達上限即停止解析。 */
export function parseVCard(text: string, max = 5000): VCardContact[] {
  if (!text || !/BEGIN:VCARD/i.test(text)) return [];
  const out: VCardContact[] = [];
  for (const chunk of text.split(/BEGIN:VCARD/i).slice(1)) {
    if (out.length >= max) break;
    const body = chunk.split(/END:VCARD/i)[0];
    let fn = '';
    let nName = '';
    let email = '';
    let phone = '';
    let note = '';
    let company = '';
    let title = '';
    let birthday = '';
    let address = '';
    for (const line of unfold(body)) {
      const colon = line.indexOf(':');
      if (colon < 0) continue;
      const prop = line.slice(0, colon).split(';')[0].toUpperCase();
      const val = vUnescape(line.slice(colon + 1).trim());
      if (prop === 'FN' && !fn) fn = val;
      else if (prop === 'N' && !nName) nName = val.replace(/;/g, ' ').replace(/\s+/g, ' ').trim();
      else if (prop === 'EMAIL' && !email) email = val.toLowerCase();
      else if (prop === 'TEL' && !phone) phone = val;
      else if (prop === 'ORG' && !company) company = val.split(';')[0].trim(); // ORG 可帶部門，取第一段
      else if (prop === 'TITLE' && !title) title = val;
      else if (prop === 'BDAY' && !birthday) birthday = val;
      else if (prop === 'ADR' && !address) address = val.split(';').map((s) => s.trim()).filter(Boolean).join(', '); // 併非空段
      else if (prop === 'NOTE' && !note) note = val;
    }
    const name = fn || nName;
    if (email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) out.push({ name, email, phone, note, company, title, birthday, address });
  }
  return out;
}
