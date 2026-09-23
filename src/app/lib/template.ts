// F2.7：範本佔位符代入（純函式，無 DOM → worker 可測）。
// {{name}} → 收件人顯示名；{{firstName}} → 名（英文取第一個空白詞；中文姓名無空白則用整名，避免切到單姓）。
// 無收件人時退回禮貌稱謂「您」，讓範本仍可讀。大小寫不敏感、容忍內側空白：{{ name }} 也代入。
export function fillTemplate(body: string, recipientName: string): string {
  const name = (recipientName || '').trim();
  const first = name.includes(' ') ? name.split(/\s+/)[0] : name;
  const NAME = name || '您';
  const FIRST = first || NAME;
  return body
    .replace(/\{\{\s*firstName\s*\}\}/gi, FIRST)
    .replace(/\{\{\s*name\s*\}\}/gi, NAME);
}

/** 由收件人 email + 自訂名對照，算出顯示用稱謂（自訂名 > local-part）。
 * 非 email（半成品 chip、純顯示名）→ 回空字串，讓範本退回「您」而非塞半截亂碼。 */
export function recipientDisplayName(email: string | undefined, contactNames: Map<string, string>): string {
  if (!email || !email.includes('@')) return '';
  return contactNames.get(email.toLowerCase()) || email.split('@')[0] || '';
}
