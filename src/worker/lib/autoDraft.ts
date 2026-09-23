// F10.2：抵達即備稿（Auto Drafts）——ingest 時對「像在等你回覆」的私人信背景生成回覆草稿，
// 存 KV 7 天；讀信時備稿即現、一鍵帶入撰寫器。設定 prefs.autoDrafts=false 可關（預設開）。
import { AI_MODEL } from '../api/ai';

export interface NeedsReplyInput {
  direction: string;
  listUnsubscribe: string | null;
  fromAddr: string;
  subject: string;
  body: string;
}

/** 問句/請求標記（zh-TW + en）。窄判定：寧可漏備稿，不浪費 Neurons 在通知信上。 */
const ASK_MARKERS = /[？?]|請問|是否|能否|可以.{0,6}嗎|方便.{0,6}嗎|麻煩|幫我|幫忙|何時|什麼時候|哪一?天|多少|要不要|好嗎|如何|怎麼|請回覆|請確認|rsvp|let me know|could you|can you|would you|please (confirm|reply|advise)/i;
const NOREPLY_RE = /no-?reply|do-?not-?reply|notification|mailer-daemon|postmaster/i;

/** 純函式：這封入站信像不像在等使用者回覆（值得預先備稿）。 */
export function looksNeedsReply(m: NeedsReplyInput): boolean {
  if (m.direction !== 'inbound') return false;
  if (m.listUnsubscribe) return false; // 批量信不備稿
  if (NOREPLY_RE.test(m.fromAddr)) return false; // 系統信箱不期待回覆
  const text = `${m.subject}\n${m.body}`;
  if (m.body.trim().length < 20) return false; // 太短＝多半是通知
  return ASK_MARKERS.test(text);
}

export const autoDraftKey = (userId: string, messageId: string) => `ai:draft:${userId}:${messageId}`;

/** 背景生成回覆備稿寫入 KV（best-effort：失敗靜默，讀信時就是沒有備稿而已）。 */
export async function generateAutoDraft(
  env: Env,
  args: { userId: string; messageId: string; fromName: string; subject: string; body: string },
): Promise<void> {
  try {
    const result = (await env.AI.run(AI_MODEL, {
      messages: [
        {
          role: 'system',
          content:
            '你是郵件回覆助理。替收件人草擬一封可直接寄出的繁體中文「回覆正文」：語氣自然得體、直接回應對方的問題或請求；對方問的具體資訊你若不知道，用〔待補〕標示讓使用者填。不要主旨、不要簽名、不要任何標籤，只輸出正文。',
        },
        {
          role: 'user',
          content: `寄件者：${args.fromName}\n主旨：${args.subject}\n來信內容：\n${args.body.slice(0, 4000)}`,
        },
      ],
    } as never)) as { response?: unknown };
    const draft = typeof result.response === 'string' ? result.response.trim() : '';
    if (!draft) return;
    await env.KV.put(autoDraftKey(args.userId, args.messageId), JSON.stringify({ draft: draft.slice(0, 8000), generatedAt: Date.now() }), {
      expirationTtl: 7 * 86400,
    });
  } catch (err) {
    console.error('auto draft failed', err); // best-effort：不影響收信
  }
}
