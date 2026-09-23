// 撰寫防呆的純邏輯（無 React/DOM，便於單元測試）。

/** 內文/主旨提到「附件」意圖的關鍵字（中英）。用詞邊界避免誤判（如 attachment 中的 attach）。 */
const ATTACHMENT_HINTS: RegExp[] = [
  /附\s*(件|檔|圖|上)/, // 附件 / 附檔 / 附圖 / 附上
  /夾\s*帶/, // 夾帶
  /\b(attach|attached|attachment|attaching|enclosed|enclosure)\b/i,
  /見\s*附/, // 見附件 / 見附檔
  /如\s*附/, // 如附件
];

/** 引用區（回覆/轉寄帶入的原文）不算寄件者本次的附件意圖，先剝掉再判斷。 */
function stripQuoted(text: string): string {
  // 去掉以 > 開頭的引用行，以及常見「-----原始郵件-----」分隔線之後的內容
  const cut = text.split(/\n-{2,}\s*(原始郵件|轉寄的郵件|Original Message|Forwarded message)/i)[0];
  return cut
    .split('\n')
    .filter((l) => !/^\s*>/.test(l))
    .join('\n');
}

/**
 * 是否「提到附件卻沒有附加檔案」——寄出前的善意提醒。
 * @param subject 主旨
 * @param body 純文字內文（撰寫者本次輸入；引用原文會被剝除）
 * @param attachmentCount 目前附件數
 */
export function looksLikeForgotAttachment(subject: string, body: string, attachmentCount: number): boolean {
  if (attachmentCount > 0) return false;
  const haystack = `${subject}\n${stripQuoted(body)}`;
  return ATTACHMENT_HINTS.some((re) => re.test(haystack));
}

/** 常見郵件網域——拿來比對拼錯（mailcheck 風格） */
const COMMON_DOMAINS = [
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.com.tw', 'hotmail.com', 'outlook.com',
  'live.com', 'msn.com', 'icloud.com', 'me.com', 'protonmail.com', 'proton.me',
  'qq.com', '163.com', '126.com', 'sina.com', 'foxmail.com', 'aol.com', 'hinet.net',
];

/** Optimal String Alignment 距離（含相鄰換位＝1），只需判斷是否 ≤1，超過即提早結束。 */
function osaDistance(a: string, b: string): number {
  const al = a.length;
  const bl = b.length;
  if (Math.abs(al - bl) > 1) return 2; // 只關心 ≤1
  const d: number[][] = Array.from({ length: al + 1 }, () => new Array<number>(bl + 1).fill(0));
  for (let i = 0; i <= al; i++) d[i][0] = i;
  for (let j = 0; j <= bl; j++) d[0][j] = j;
  for (let i = 1; i <= al; i++) {
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1); // 相鄰換位
      }
    }
  }
  return d[al][bl];
}

export interface DomainSuggestion {
  recipient: string;
  suggested: string;
}

/**
 * 偵測收件人網域疑似拼錯（與常見網域差一個編輯距離但不相等）→ 寄前提醒。
 * 僅提示、不自動改；找不到一律空陣列。
 */
export function detectDomainTypos(recipients: string[]): DomainSuggestion[] {
  const out: DomainSuggestion[] = [];
  const seen = new Set<string>();
  for (const r of recipients) {
    const addr = r.trim().toLowerCase();
    const at = addr.lastIndexOf('@');
    if (at <= 0) continue;
    const domain = addr.slice(at + 1);
    if (!domain || domain.length < 4 || COMMON_DOMAINS.includes(domain) || seen.has(addr)) continue;
    for (const cd of COMMON_DOMAINS) {
      if (osaDistance(domain, cd) === 1) {
        seen.add(addr);
        out.push({ recipient: r.trim(), suggested: `${addr.slice(0, at)}@${cd}` });
        break;
      }
    }
  }
  return out;
}
