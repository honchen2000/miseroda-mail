// 收件匣分類（主要 / 社交 / 促銷 / 通知）——便宜的確定性啟發式，無 AI 成本、純函式、可測、易擴充。
// 與 Gmail 分頁同概念，但規則透明且「保守偏向主要」：沒有任何批量/自動訊號的直接 1:1 信一律留在「主要」，
// 只把帶 List-Unsubscribe / 社交網域 / no-reply / Precedence:bulk 等訊號的信分流出去，避免把重要信誤移出主要。
export type InboxCategory = 'primary' | 'social' | 'promotions' | 'updates';

export const INBOX_CATEGORIES: InboxCategory[] = ['primary', 'social', 'promotions', 'updates'];

// 社交網路寄件網域（高信心，最優先判定）
const SOCIAL_DOMAINS = [
  'facebookmail.com', 'facebook.com', 'twitter.com', 'x.com', 'linkedin.com',
  'instagram.com', 'mail.instagram.com', 'youtube.com', 'reddit.com', 'redditmail.com',
  'pinterest.com', 'tiktok.com', 'discord.com', 'quora.com', 'meetup.com', 'nextdoor.com',
  'line.me', 'plurk.com', 'threads.net',
];

// 明確的行銷寄件者前綴（僅在已有批量/自動訊號時才參考，不會把直接信誤判）
const MARKETING_SENDER = /^(newsletter|marketing|promo|promotions|deals?|offers?|sales?|campaign|e?dm)@/i;
// 自動/系統寄件者前綴
const NOREPLY_SENDER = /^(no.?reply|do.?not.?reply|donotreply|notification|notifications|alert|alerts|mailer|mailer-daemon|bounce|postmaster|system|root|cron)@/i;
// 行銷主旨字眼（中英）。數字量詞刻意收斂為 {1,3} + \s? 並對主旨限長，杜絕超長純數字主旨的二次方回溯（ReDoS）。
const MARKETING_SUBJECT = /(\bsale\b|\d{1,3}\s?%\s?off|\d{1,3}%|coupon|discount|\bdeal\b|\boffer\b|\bpromo|newsletter|black\s?friday|限時|優惠|折扣|特賣|促銷|免運|下殺|買一送一|最後機會|週年慶|回饋)/i;
// 交易/通知主旨字眼（中英）
const TRANSACTIONAL_SUBJECT = /(receipt|invoice|\border\b|statement|confirm|verification|verify|password|security|shipped|delivery|tracking|reminder|digest|報表|收據|帳單|訂單|對帳|確認|驗證|密碼|安全|出貨|配送|物流|通知|提醒|摘要)/i;

function domainOf(email: string): string {
  const at = email.lastIndexOf('@');
  return at >= 0 ? email.slice(at + 1).toLowerCase() : '';
}
function domainMatches(domain: string, list: string[]): boolean {
  return list.some((d) => domain === d || domain.endsWith('.' + d));
}

export interface CategorizeInput {
  fromAddr: string;
  subject: string;
  /** 是否帶 List-Unsubscribe 標頭（批量信的強訊號） */
  hasListUnsubscribe: boolean;
  /** List-Id 標頭（郵件論壇/清單） */
  listId?: string | null;
  /** Precedence 標頭（bulk / list / junk） */
  precedence?: string | null;
  /** Auto-Submitted 標頭（auto-generated / auto-replied） */
  autoSubmitted?: string | null;
}

/** 回傳收件匣分類。判定保守：無任何批量/自動訊號的直接信恆為 'primary'。 */
export function categorizeMessage(input: CategorizeInput): InboxCategory {
  const from = (input.fromAddr || '').toLowerCase();
  const domain = domainOf(from);
  const subject = (input.subject || '').slice(0, 1000); // 限長：即便量詞已收斂，仍對病態輸入再加一道防線

  // 1) 社交網域（高信心）
  if (domainMatches(domain, SOCIAL_DOMAINS)) return 'social';

  const bulk = input.hasListUnsubscribe || !!input.listId?.trim() || /\b(bulk|list|junk)\b/i.test(input.precedence || '');
  const automated = NOREPLY_SENDER.test(from) || /auto-(generated|replied|notified)/i.test(input.autoSubmitted || '');

  // 2) 無任何批量/自動訊號 → 直接信，一律留在主要（主旨關鍵字不影響，避免誤移重要信）
  if (!bulk && !automated) return 'primary';

  // 以下皆為某種批量/自動信，依訊號分流：
  // 3) 明確行銷寄件者（newsletter@/marketing@…）→ 促銷
  if (MARKETING_SENDER.test(from)) return 'promotions';
  // 4) 交易/通知型主旨優先於行銷字眼 → 通知（避免「出貨通知＋折扣」這類交易信誤入促銷）
  if (TRANSACTIONAL_SUBJECT.test(subject)) return 'updates';
  // 5) 行銷字眼 → 促銷
  if (MARKETING_SUBJECT.test(subject)) return 'promotions';
  // 6) no-reply / 自動但無行銷/交易字眼 → 通知
  if (automated) return 'updates';
  // 7) 純 List-Unsubscribe 批量（無其他訊號）→ 促銷（多為電子報）
  return 'promotions';
}
