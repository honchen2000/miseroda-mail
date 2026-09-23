// F10.3：帳單/包裹 summary card——receipt lane 信 ingest 時 AI 抽結構（金額/到期/追蹤號），
// 清洗驗證後存 messages.receipt_card（JSON）；列表列與讀信頂部顯示卡片。
// 容錯原則：AI 輸出任何欄位不合格式就丟該欄位，全空就不存——絕不顯示髒資料。
import { AI_MODEL } from '../api/ai';

/** 收據 lane 的主旨關鍵字（與 mail.ts 的 lane 判定共用；保守集合，降低誤判）。 */
export const RECEIPT_KEYWORDS = ['收據', '發票', '訂單', '帳單', '付款', '已出貨', 'receipt', 'invoice', 'your order', 'order confirm', 'payment', 'billing'];

export function looksLikeReceipt(subject: string): boolean {
  const s = subject.toLowerCase();
  return RECEIPT_KEYWORDS.some((k) => s.includes(k));
}

export interface ReceiptCard {
  kind: 'bill' | 'parcel';
  amount?: string; // 含幣別的顯示字串，如「NT$ 1,234」
  dueDate?: string; // YYYY-MM-DD
  trackingNo?: string;
  vendor?: string;
}

/** AI 輸出 → 逐欄驗證清洗（純函式，可測）。無效欄位丟棄；kind 非法或全欄位皆空 → null。 */
export function sanitizeReceiptCard(raw: unknown): ReceiptCard | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const kind = r.kind === 'bill' || r.kind === 'parcel' ? r.kind : null;
  if (!kind) return null;
  const card: ReceiptCard = { kind };
  if (typeof r.amount === 'string') {
    const a = r.amount.trim().slice(0, 30);
    if (/\d/.test(a)) card.amount = a; // 至少要有數字，擋「未知」「N/A」之類幻覺
  }
  if (typeof r.dueDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.dueDate.trim())) {
    const d = new Date(`${r.dueDate.trim()}T00:00:00Z`);
    if (!Number.isNaN(d.getTime())) card.dueDate = r.dueDate.trim();
  }
  if (typeof r.trackingNo === 'string') {
    const t = r.trackingNo.trim().toUpperCase();
    if (/^[A-Z0-9-]{8,30}$/.test(t)) card.trackingNo = t; // 太短/含雜字＝多半是幻覺
  }
  if (typeof r.vendor === 'string' && r.vendor.trim()) card.vendor = r.vendor.trim().slice(0, 40);
  if (!card.amount && !card.dueDate && !card.trackingNo) return null; // 沒抽到任何有用欄位就不顯示卡片
  return card;
}

/** AI 抽取（json_schema 強約束）→ 清洗。失敗回 null（best-effort，不影響收信）。 */
export async function extractReceiptCard(
  env: Env,
  args: { subject: string; fromName: string; body: string },
): Promise<ReceiptCard | null> {
  try {
    const result = (await env.AI.run(AI_MODEL, {
      messages: [
        {
          role: 'user',
          content: [
            '從這封收據/帳單/出貨通知信抽出結構化欄位，只輸出 JSON：',
            'kind：bill（帳單/收據/發票）或 parcel（包裹/出貨）',
            'amount：應付/已付金額（含幣別的原文字串）；沒有就省略',
            'dueDate：繳費/付款截止日 YYYY-MM-DD；沒有就省略',
            'trackingNo：物流追蹤號；沒有就省略',
            'vendor：商家/機構名；沒有就省略',
            '不確定的欄位一律省略，不要猜。',
            `寄件者：${args.fromName}`,
            `主旨：${args.subject}`,
            `內容：${args.body.slice(0, 3000)}`,
          ].join('\n'),
        },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['bill', 'parcel'] },
            amount: { type: 'string' },
            dueDate: { type: 'string' },
            trackingNo: { type: 'string' },
            vendor: { type: 'string' },
          },
          required: ['kind'],
        },
      },
    } as never)) as { response?: unknown };
    const raw = typeof result.response === 'string' ? JSON.parse(result.response) : result.response;
    return sanitizeReceiptCard(raw);
  } catch (err) {
    console.error('receipt card extract failed', err);
    return null;
  }
}
