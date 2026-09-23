// AI 摘要 / 分類 / 智慧回覆 / 撰寫輔助 / 自然語言搜尋 / 對話串摘要（Workers AI，按需觸發）
import { Hono } from 'hono';
import { z } from 'zod';
import { htmlToText } from '../email/sanitize';
import { requireSession, type Vars } from './middleware';
import { rateLimitUserMw } from '../lib/ratelimit';
import { parseKeywords, retrieveAskContext } from '../lib/askMail';
import { autoDraftKey } from '../lib/autoDraft';

// 注意：@cf/meta/llama-3.1-8b-instruct 已於 2026-05-30 被 Cloudflare 棄用（錯誤碼 5028），
// 連帶讓翻譯/摘要/撰寫/搜尋/晨報全失效。改用現役多語模型（繁中翻譯/撰寫品質佳、支援結構化輸出）。
// 若此模型未來也被棄用，前端會顯示「翻譯失敗：<原始錯誤>」可一眼辨識，再換一個現役 model 即可。
export const AI_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
export const CATEGORIES = ['帳單', '工作', '朋友', '電子報', '通知', '其他'] as const;
export type AiCategory = (typeof CATEGORIES)[number];

export interface AiEvent {
  summary: string;
  startMs: number;
  endMs: number;
  location?: string;
}
export interface AiSummary {
  summary: string;
  category: string;
  replies: string[];
  /** F2.4：從信件正文抽到的會議/約定（可一鍵加入行事曆）。 */
  events?: AiEvent[];
  /** F2.4：從信件正文抽到的待辦（可一鍵設跟進）。 */
  actions?: string[];
  model: string;
  generatedAt: number;
}

/** 「YYYY-MM-DD HH:MM」台北牆鐘 → UTC epoch ms（純函式，可測）。無法解析或日期溢位回 null。 */
export function parseTaipeiLocal(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(s.trim().replace(/\//g, '-'));
  if (!m) return null;
  const [y, mo, d, h, mi] = [+m[1], +m[2], +m[3], +m[4], +m[5]];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const ms = Date.UTC(y, mo - 1, d, h, mi) - 8 * 3_600_000; // 台北牆鐘 → 減 8h 得 UTC instant
  // 回環驗證：擋 2/30、4/31 等「日」溢位被 Date.UTC 靜默進位成錯誤日期
  const back = new Date(ms + 8 * 3_600_000);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return ms;
}

interface MsgRow {
  id: string;
  user_id: string;
  from_addr: string;
  from_name: string;
  subject: string;
  snippet: string;
  r2_html_key: string | null;
  ai_summary: string | null;
  ai_translation: string | null;
}

function parseAiJson(raw: unknown): { summary?: string; category?: string; replies?: unknown } | null {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // 模型偶爾包 markdown code fence
    const m = /\{[\s\S]*\}/.exec(raw);
    if (m) {
      try {
        return JSON.parse(m[0]) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * 輕量分類：只問 category（不產 summary/replies，省額度），給規則 ai_category 條件用。
 * throw-safe：失敗回 null（不影響收信主流程）。只在使用者有 ai_category 規則時才會被呼叫（成本守門）。
 */
export async function aiCategorize(
  env: Env,
  m: { fromName: string; fromAddr: string; subject: string; snippet: string },
): Promise<AiCategory | null> {
  const prompt = [
    `把這封信分類，從「${CATEGORIES.join('、')}」中選一個最貼切的，只輸出 JSON。`,
    `寄件者: ${m.fromName} <${m.fromAddr}>`,
    `主旨: ${m.subject}`,
    `摘要: ${m.snippet}`,
  ].join('\n');
  try {
    const result = (await env.AI.run(AI_MODEL, {
      messages: [{ role: 'user', content: prompt }],
      response_format: {
        type: 'json_schema',
        json_schema: {
          type: 'object',
          properties: { category: { type: 'string', enum: [...CATEGORIES] } },
          required: ['category'],
        },
      },
    } as never)) as { response?: unknown };
    const cat = parseAiJson(result.response)?.category;
    return cat && (CATEGORIES as readonly string[]).includes(cat) ? (cat as AiCategory) : null;
  } catch {
    return null;
  }
}

/** 分類 Workers AI 失敗原因：免費額度/容量用罄 vs 其他錯誤 —— 讓前端能顯示貼切訊息、利於診斷。 */
function aiErrorReason(err: unknown): 'quota' | 'error' {
  const s = String((err as { message?: string })?.message ?? err ?? '').toLowerCase();
  return /quota|credit|exceed|limit|capacity|too many|unavailable|no instances|overloaded|3040|rate.?limit/.test(s) ? 'quota' : 'error';
}
/** 失敗回應主體：reason 分類 + detail 原始訊息（截斷，供診斷）。 */
function aiErrorBody(err: unknown) {
  return { reason: aiErrorReason(err), detail: String((err as { message?: string })?.message ?? err ?? '').slice(0, 200) };
}

/** 純文字生成（system + user），失敗回 null。 */
async function aiText(env: Env, system: string, user: string): Promise<string | null> {
  try {
    const result = (await env.AI.run(AI_MODEL, {
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    } as never)) as { response?: unknown };
    if (typeof result.response !== 'string') console.warn('aiText non-string response', typeof result.response);
    const out = typeof result.response === 'string' ? result.response.trim() : '';
    return out || null;
  } catch (err) {
    console.error('aiText failed', err);
    return null;
  }
}

export function aiRoutes() {
  const app = new Hono<{ Bindings: Env; Variables: Vars }>();
  app.use('*', requireSession);
  // 互動式 AI（撰寫/搜尋/摘要）會即時消耗 Neurons → 按使用者上限流
  app.use('/ai/ask', rateLimitUserMw('ai', 30, 60));
  app.use('/ai/compose', rateLimitUserMw('ai', 30, 60));
  app.use('/ai/search', rateLimitUserMw('ai', 30, 60));
  app.use('/ai/rewrite', rateLimitUserMw('ai', 30, 60));
  app.use('/ai/subject', rateLimitUserMw('ai', 30, 60));
  app.use('/messages/:id/thread-summary', rateLimitUserMw('ai', 30, 60));

  /* ---------- F10.2：讀取抵達即備稿（ingest 背景生成、KV 7 天） ---------- */
  app.get('/messages/:id/auto-draft', async (c) => {
    const id = c.req.param('id');
    const owns = await c.var.db.prepare(`SELECT 1 FROM messages WHERE id = ? AND user_id = ?`)
      .bind(id, c.var.user.id)
      .first();
    if (!owns) return c.json({ error: 'not_found' }, 404);
    const raw = await c.env.KV.get(autoDraftKey(c.var.user.id, id), 'json');
    const d = raw as { draft?: string; generatedAt?: number } | null;
    return c.json({ draft: d?.draft ?? null, generatedAt: d?.generatedAt ?? null });
  });

  /* ---------- F10.1：Ask AI 信箱問答（RAG over own mail） ---------- */
  app.post('/ai/ask', async (c) => {
    const body = z.object({ question: z.string().min(2).max(500) }).safeParse(await c.req.json());
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    const userId = c.var.user.id;
    const question = body.data.question.trim();

    // KV 快取（1 小時）：同問題不重複燒 Neurons；新信抵達最多延遲一小時反映
    const qHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(question)))]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
      .slice(0, 32);
    const cacheKey = `ai:ask:${userId}:${qHash}`;
    const cached = await c.env.KV.get(cacheKey, 'json');
    if (cached) return c.json({ ...(cached as Record<string, unknown>), cached: true });

    // ① 抽關鍵字（縮小檢索面；直接拿整句問 FTS trigram 幾乎必落空）
    const kwRaw = await aiText(
      c.env,
      '從使用者的「信箱問題」抽出 1-4 個最適合全文檢索的關鍵字（人名/店名/主題詞，保留原語言、不要翻譯、不要泛詞如「郵件」「信」）。用逗號分隔，只輸出關鍵字本身。',
      question,
    );
    if (!kwRaw) return c.json({ error: 'ai_failed' }, 502);
    const keywords = parseKeywords(kwRaw);
    const sources = keywords.length ? await retrieveAskContext(c.env, userId, keywords, undefined, c.var.db) : [];
    if (!sources.length) {
      return c.json({ answer: null, sources: [], keywords, reason: 'no_match' });
    }

    // ② 用編號片段作答（要求誠實：片段不足就說找不到，不得腦補）
    const ctx = sources
      .map((s, i) => `[${i + 1}] 主旨：${s.subject}｜寄件者：${s.from}｜日期：${new Date(s.receivedAt).toISOString().slice(0, 10)}\n${s.excerpt}`)
      .join('\n\n');
    const answer = await aiText(
      c.env,
      '你是信箱問答助理。只依據提供的信件片段回答使用者問題，用繁體中文、精簡直接；引用到哪封信就在句末標 [編號]。若片段不足以回答，誠實說「在信箱裡找不到相關資訊」，絕不要編造金額、日期或事實。',
      `問題：${question}\n\n信件片段：\n${ctx}`,
    );
    if (!answer) return c.json({ error: 'ai_failed' }, 502);

    const payload = {
      answer: answer.slice(0, 4000),
      keywords,
      sources: sources.map((s) => ({ id: s.id, subject: s.subject, from: s.from, receivedAt: s.receivedAt })),
    };
    await c.env.KV.put(cacheKey, JSON.stringify(payload), { expirationTtl: 3600 });
    return c.json({ ...payload, cached: false });
  });

  /* ---------- AI 草擬新信（依自然語言指示產生正文） ---------- */
  app.post('/ai/compose', async (c) => {
    const body = z.object({ prompt: z.string().min(1).max(2000), context: z.string().max(2000).optional() }).safeParse(await c.req.json());
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    // F2.7：可選情境（收件人/原信摘要）→ 讓草稿稱謂與內容貼合對象
    const userMsg = body.data.context
      ? `情境參考（請貼合此情境的稱謂與對象，但只依下方「指示」撰寫，勿改寫情境本身）：\n${body.data.context}\n\n指示：${body.data.prompt}`
      : body.data.prompt;
    const text = await aiText(
      c.env,
      '你是郵件撰寫助理。依使用者的指示，草擬一封可直接寄出的繁體中文電子郵件「正文」：語氣得體、段落清楚；不要輸出主旨行、收件者、或「正文：」之類的標籤，也不要加簽名。只輸出正文。',
      userMsg,
    );
    if (!text) return c.json({ error: 'ai_failed' }, 502);
    return c.json({ text: text.slice(0, 8000) });
  });

  /* ---------- AI 改寫 / 調語氣（潤飾、更正式、更親切、更精簡） ---------- */
  const REWRITE_SYS: Record<string, string> = {
    polish: '你是中文寫作編輯。潤飾以下郵件正文：修正錯字與語病、讓文句通順，但保持原本的語氣、長度與所有事實／數字／連結。只輸出潤飾後的繁體中文正文，不要加任何說明、標籤或引號。',
    formal: '你是中文寫作編輯。把以下郵件正文改寫得更正式、專業、有禮貌，保留原意與所有事實／數字／連結。只輸出改寫後的繁體中文正文，不要加任何說明、標籤或引號。',
    friendly: '你是中文寫作編輯。把以下郵件正文改寫得更親切、溫暖、口語自然，保留原意與所有事實／數字／連結。只輸出改寫後的繁體中文正文，不要加任何說明、標籤或引號。',
    concise: '你是中文寫作編輯。把以下郵件正文改寫得更精簡扼要、刪去贅字，但保留所有重點與事實／數字／連結。只輸出改寫後的繁體中文正文，不要加任何說明、標籤或引號。',
  };
  app.post('/ai/rewrite', async (c) => {
    const body = z
      .object({ text: z.string().min(1).max(8000), mode: z.enum(['polish', 'formal', 'friendly', 'concise']), context: z.string().max(2000).optional() })
      .safeParse(await c.req.json());
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    // F2.7：可選情境讓改寫貼合對象（稱謂/語氣）；只改寫「待改寫正文」，情境僅作參考
    const input = body.data.context
      ? `情境參考（僅供判斷稱謂與對象，勿改寫情境本身）：\n${body.data.context}\n\n待改寫正文：\n${body.data.text}`
      : body.data.text;
    const out = await aiText(c.env, REWRITE_SYS[body.data.mode], input);
    if (!out) return c.json({ error: 'ai_failed' }, 502);
    return c.json({ text: out.slice(0, 8000) });
  });

  /* ---------- AI 依正文建議主旨 ---------- */
  app.post('/ai/subject', async (c) => {
    const body = z.object({ text: z.string().min(1).max(8000) }).safeParse(await c.req.json());
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    const out = await aiText(
      c.env,
      '依以下郵件正文，擬一個精簡、貼切的繁體中文主旨（不超過 30 字、不要句號）。只輸出主旨本身，不要引號、不要「主旨：」之類前綴或任何說明。',
      body.data.text,
    );
    if (!out) return c.json({ error: 'ai_failed' }, 502);
    return c.json({ subject: out.replace(/^["'「『]+|["'」』]+$/g, '').replace(/\s+/g, ' ').trim().slice(0, 200) });
  });

  /* ---------- 自然語言找信 → 搜尋查詢字串（用既有搜尋運算子） ---------- */
  app.post('/ai/search', async (c) => {
    const body = z.object({ q: z.string().min(1).max(500) }).safeParse(await c.req.json());
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    const today = new Date().toISOString().slice(0, 10);
    const out = await aiText(
      c.env,
      `把使用者的「找信」自然語言需求，轉成一行搜尋查詢。可用運算子：from:寄件者 to:收件人 has:attachment is:unread is:starred before:YYYY-MM-DD after:YYYY-MM-DD；其餘視為關鍵字（保留中文關鍵字）。今天是 ${today}。只輸出查詢字串本身，不要任何解釋或引號。`,
      body.data.q,
    );
    if (!out) return c.json({ error: 'ai_failed' }, 502);
    return c.json({ query: out.replace(/^["'`]+|["'`]+$/g, '').replace(/\s+/g, ' ').trim().slice(0, 200) });
  });

  /* ---------- 對話串摘要（整串多封信） ---------- */
  app.post('/messages/:id/thread-summary', async (c) => {
    const msg = await c.var.db.prepare(`SELECT thread_id FROM messages WHERE id = ? AND user_id = ?`)
      .bind(c.req.param('id'), c.var.user.id)
      .first<{ thread_id: string }>();
    if (!msg) return c.json({ error: 'not_found' }, 404);
    const rows = await c.var.db.prepare(
      `SELECT from_name, from_addr, subject, snippet, r2_html_key, received_at FROM messages
       WHERE user_id = ? AND thread_id = ? AND folder != 'trash' ORDER BY received_at ASC LIMIT 30`,
    )
      .bind(c.var.user.id, msg.thread_id)
      .all<{ from_name: string; from_addr: string; subject: string; snippet: string; r2_html_key: string | null; received_at: number }>();
    if (rows.results.length < 2) return c.json({ error: 'too_short' }, 400);

    // 並行取各封內文（R2），再依預算組裝，避免逐封序列等待
    const bodies = await Promise.all(
      rows.results.map(async (m) => {
        let text = m.snippet;
        if (m.r2_html_key) {
          const obj = await c.env.MAIL_STORE.get(m.r2_html_key);
          if (obj) text = (await htmlToText(await obj.text())).slice(0, 1500);
        }
        return `【${m.from_name || m.from_addr}】${text}`;
      }),
    );
    const parts: string[] = [];
    let budget = 9000;
    for (const b of bodies) {
      const block = b.slice(0, budget);
      parts.push(block);
      budget -= block.length;
      if (budget <= 0) break;
    }
    const summary = await aiText(
      c.env,
      '你是郵件助理。閱讀以下同一對話串依時間排列的多封信件，用繁體中文條列式摘要整串的來龍去脈、結論與待辦／待回覆事項（若有）。精簡扼要，只輸出摘要。',
      parts.join('\n\n---\n\n'),
    );
    if (!summary) return c.json({ error: 'ai_failed' }, 502);
    return c.json({ summary: summary.slice(0, 3000) });
  });

  app.post('/messages/:id/ai', async (c) => {
    const msg = await c.var.db.prepare(`SELECT * FROM messages WHERE id = ? AND user_id = ?`)
      .bind(c.req.param('id'), c.var.user.id)
      .first<MsgRow>();
    if (!msg) return c.json({ error: 'not_found' }, 404);

    if (msg.ai_summary) {
      return c.json({ ai: JSON.parse(msg.ai_summary) as AiSummary, cached: true });
    }

    let bodyText = msg.snippet;
    if (msg.r2_html_key) {
      const obj = await c.env.MAIL_STORE.get(msg.r2_html_key);
      if (obj) bodyText = (await htmlToText(await obj.text())).slice(0, 6000);
    }

    const today = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10); // 台北日期（避近午夜 UTC 差一天）
    const prompt = [
      `你是 Miseroda Mail 的信件助理。閱讀以下信件，回覆 JSON。`,
      `寄件者: ${msg.from_name} <${msg.from_addr}>`,
      `主旨: ${msg.subject}`,
      `內文:\n${bodyText}`,
      ``,
      `要求：`,
      `1. summary：用繁體中文 1–2 句總結重點（含關鍵數字/日期）。`,
      `2. category：從 ${CATEGORIES.join('、')} 中選一個。`,
      `3. replies：若這封信來自真人且適合快速回覆（朋友邀約、工作確認等），給 2–3 個 ≤20 字的繁體中文回覆草稿；通知/帳單/電子報則給空陣列。`,
      `4. extractedEvents：若信中提到具體的約定時間/會議（如「下週二下午三點碰面」），抽成事件。start 用台北時間格式「YYYY-MM-DD HH:MM」；相對時間請依「今天是 ${today}（台北）」換算成絕對日期。沒有就空陣列。`,
      `5. actionItems：若信中提到需要你處理的待辦（如「月底前回覆」），抽成 ≤15 字的繁中待辦短語。沒有就空陣列。`,
    ].join('\n');

    let parsed: { summary?: string; category?: string; replies?: unknown; extractedEvents?: unknown; actionItems?: unknown } | null = null;
    try {
      const result = (await c.env.AI.run(AI_MODEL, {
        messages: [{ role: 'user', content: prompt }],
        response_format: {
          type: 'json_schema',
          json_schema: {
            type: 'object',
            properties: {
              summary: { type: 'string' },
              category: { type: 'string', enum: [...CATEGORIES] },
              replies: { type: 'array', items: { type: 'string' }, maxItems: 3 },
              extractedEvents: {
                type: 'array',
                maxItems: 5,
                items: {
                  type: 'object',
                  properties: {
                    summary: { type: 'string' },
                    start: { type: 'string' },
                    durationMin: { type: 'number' },
                    location: { type: 'string' },
                  },
                  required: ['summary', 'start'],
                },
              },
              actionItems: { type: 'array', items: { type: 'string' }, maxItems: 5 },
            },
            required: ['summary', 'category', 'replies'],
          },
        },
      } as never)) as { response?: unknown };
      parsed = parseAiJson(result.response);
    } catch (err) {
      console.error('ai run failed', err);
      return c.json({ error: 'ai_failed', ...aiErrorBody(err) }, 502);
    }
    if (!parsed?.summary) return c.json({ error: 'ai_failed', reason: 'empty', detail: '模型回傳空白' }, 502);

    const now = Date.now();
    const events: AiEvent[] = Array.isArray(parsed.extractedEvents)
      ? parsed.extractedEvents
          .map((raw): AiEvent | null => {
            const e = raw as { summary?: unknown; start?: unknown; durationMin?: unknown; location?: unknown };
            const startMs = typeof e.start === 'string' ? parseTaipeiLocal(e.start) : null;
            if (typeof e.summary !== 'string' || !e.summary.trim() || startMs == null) return null;
            if (startMs < now - 86_400_000) return null; // 過去的事件（>1 天前）不給晶片
            const dur = typeof e.durationMin === 'number' && e.durationMin > 0 ? Math.min(e.durationMin, 1440) : 60;
            return {
              summary: e.summary.trim().slice(0, 200),
              startMs,
              endMs: startMs + dur * 60_000,
              ...(typeof e.location === 'string' && e.location.trim() ? { location: e.location.trim().slice(0, 200) } : {}),
            };
          })
          .filter((e): e is AiEvent => e != null)
          .slice(0, 5)
      : [];
    const actions: string[] = Array.isArray(parsed.actionItems)
      ? parsed.actionItems.filter((a): a is string => typeof a === 'string' && a.trim().length > 0).map((a) => a.trim().slice(0, 60)).slice(0, 5)
      : [];

    const ai: AiSummary = {
      summary: String(parsed.summary).slice(0, 500),
      category: CATEGORIES.includes(parsed.category as never) ? String(parsed.category) : '其他',
      replies: Array.isArray(parsed.replies)
        ? parsed.replies.filter((r): r is string => typeof r === 'string').slice(0, 3)
        : [],
      ...(events.length ? { events } : {}),
      ...(actions.length ? { actions } : {}),
      model: AI_MODEL,
      generatedAt: Date.now(),
    };
    await c.var.db.prepare(`UPDATE messages SET ai_summary = ? WHERE id = ?`)
      .bind(JSON.stringify(ai), msg.id)
      .run();
    return c.json({ ai, cached: false });
  });

  /* ---------- AI 翻譯成繁體中文（快取於 messages.ai_translation） ---------- */
  app.post('/messages/:id/translate', async (c) => {
    const msg = await c.var.db.prepare(`SELECT * FROM messages WHERE id = ? AND user_id = ?`)
      .bind(c.req.param('id'), c.var.user.id)
      .first<MsgRow>();
    if (!msg) return c.json({ error: 'not_found' }, 404);
    if (msg.ai_translation) return c.json({ translation: msg.ai_translation, cached: true });

    let bodyText = msg.snippet;
    if (msg.r2_html_key) {
      const obj = await c.env.MAIL_STORE.get(msg.r2_html_key);
      if (obj) bodyText = (await htmlToText(await obj.text())).slice(0, 6000);
    }
    if (!bodyText.trim()) return c.json({ error: 'empty' }, 400);

    let translation = '';
    try {
      const result = (await c.env.AI.run(AI_MODEL, {
        messages: [
          {
            role: 'system',
            content:
              '你是專業翻譯。把使用者提供的郵件內容翻譯成自然流暢的繁體中文，保留段落結構。只輸出譯文，不要加說明、不要加引號。若原文已是中文，原樣回傳。',
          },
          { role: 'user', content: bodyText },
        ],
      } as never)) as { response?: unknown };
      translation = typeof result.response === 'string' ? result.response.trim() : '';
    } catch (err) {
      console.error('translate failed', err);
      return c.json({ error: 'ai_failed', ...aiErrorBody(err) }, 502);
    }
    if (!translation) return c.json({ error: 'ai_failed', reason: 'empty', detail: '模型回傳空白' }, 502);

    translation = translation.slice(0, 8000);
    await c.var.db.prepare(`UPDATE messages SET ai_translation = ? WHERE id = ?`)
      .bind(translation, msg.id)
      .run();
    return c.json({ translation, cached: false });
  });

  return app;
}
