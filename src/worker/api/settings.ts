// 標籤 / 自動規則 / 使用者設定 / 個人資料（顯示名稱、大頭貼）
import { Hono } from 'hono';
import { z } from 'zod';
import { audit } from '../lib/audit';
import { newId } from '../lib/ids';
import { getIp, getUa, isDomainEmail, requireSession, type Vars } from './middleware';
import { runRuleOnExisting } from '../email/rulesEngine';
import { isForwardTargetAllowed } from '../email/forward';
import { isPublicHttpsUrl } from '../email/list-unsubscribe';
import { isAllowedPushEndpoint } from '../lib/webpush';
import { EDGE_CACHE_TTL, edgeCacheKey, edgeCacheMatch, edgeCachePut } from '../lib/edgeCache';
import { CATEGORIES } from './ai';

const AVATAR_MAX_BYTES = 1024 * 1024; // 1 MB

/**
 * SVG 等 XML 基底的影像可內嵌 <script>：被當成同源文件開啟就是站內 XSS。
 * 只認這一類「可執行腳本」的型別；點陣影像（png/jpeg/gif/webp/tiff/ico/apng…）不受影響。
 */
export function isScriptableImageType(contentType: string): boolean {
  const type = (contentType.split(';')[0] ?? '').trim().toLowerCase();
  return type === 'image/svg' || type.startsWith('image/svg+') || type.endsWith('+xml');
}

const COLOR_RE = /^#[0-9A-Fa-f]{6}$/;

/** F4.5：父標籤須屬本人且為頂層（parent_id IS NULL）——維持標籤最多 2 層、無循環。 */
async function isTopLevelLabel(env: Env, userId: string, labelId: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT parent_id FROM labels WHERE id = ? AND user_id = ?`)
    .bind(labelId, userId)
    .first<{ parent_id: string | null }>();
  return !!row && row.parent_id === null;
}

const clauseSchema = z.object({
  field: z.enum(['from', 'subject', 'to', 'cc', 'recipient']),
  op: z.enum(['contains', 'notContains', 'equals', 'startsWith', 'endsWith']),
  value: z.string().min(1).max(200),
});

const conditionsSchema = z
  .object({
    match: z.enum(['all', 'any']).optional(),
    clauses: z.array(clauseSchema).max(10).optional(),
    hasListUnsubscribe: z.boolean().optional(),
    aiCategory: z.enum(CATEGORIES).optional(), // F2.2b：AI 分類條件
    authVerdict: z.enum(['fail', 'none']).optional(), // F2.8a：寄件驗證等級（fail/none）
    hasAttachment: z.boolean().optional(), // F4.1a
    sizeOverKb: z.number().int().positive().max(50_000).optional(), // F4.1a：上限 ~50MB
    olderThanDays: z.number().int().positive().max(3650).optional(), // F4.1a：上限 10 年
    // 舊版扁平欄位（向後相容）
    fromContains: z.string().min(1).max(120).optional(),
    subjectContains: z.string().min(1).max(120).optional(),
    toContains: z.string().min(1).max(120).optional(),
  })
  .refine(
    (c) =>
      (c.clauses?.length ?? 0) > 0 ||
      !!c.fromContains ||
      !!c.subjectContains ||
      !!c.toContains ||
      c.hasListUnsubscribe !== undefined ||
      !!c.aiCategory ||
      !!c.authVerdict ||
      c.hasAttachment !== undefined ||
      !!c.sizeOverKb ||
      !!c.olderThanDays,
    'at least one condition',
  );

const actionsSchema = z
  .object({
    addLabelId: z.string().optional(),
    moveToFolder: z.enum(['archive', 'spam', 'trash']).optional(),
    star: z.boolean().optional(),
    markRead: z.boolean().optional(),
    snooze: z.enum(['evening', 'tomorrow', 'weekend']).optional(),
    followUpAfterMin: z.number().int().positive().max(43200).optional(), // ≤30 天
    stopProcessing: z.boolean().optional(), // F4.1a：命中即停，後續規則不再套用
    forward: z.string().email().max(254).optional(), // F4.1b：自動轉寄目標（限聯絡人/站內，handler 另查；空字串視為未設）
  })
  // 至少一個「有效」動作（stopProcessing 僅在 true 時算數，避免只送 {stopProcessing:false} 的無效規則）。
  .refine(
    (a) => !!(a.addLabelId || a.moveToFolder || a.star || a.markRead || a.snooze || a.followUpAfterMin || a.stopProcessing || a.forward),
    'at least one action',
  );

const pushSubSchema = z.object({
  endpoint: z.string().url().max(2048),
  p256dh: z.string().min(1).max(256),
  auth: z.string().min(1).max(64),
  // 訂閱輪換（pushsubscriptionchange）時帶舊 endpoint → 一併刪掉，避免殘留失效訂閱。
  oldEndpoint: z.string().url().max(2048).optional(),
});

export function settingsRoutes() {
  const app = new Hono<{ Bindings: Env; Variables: Vars }>();
  app.use('*', requireSession);

  /* ---------- Web Push 訂閱 ---------- */
  app.post('/push/subscribe', async (c) => {
    const body = pushSubSchema.safeParse(await c.req.json());
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    const { endpoint, p256dh, auth } = body.data;
    // SSRF：endpoint 之後會被 Worker 直接 POST，只收真正的瀏覽器推播服務網域（見 isAllowedPushEndpoint）。
    if (!isAllowedPushEndpoint(endpoint)) return c.json({ error: 'bad_request' }, 400);
    // endpoint 全域唯一：同瀏覽器重訂閱時轉移歸屬並更新金鑰
    // F5：連同「建立它的 session」一起記下（migration 0049）。推播內容含寄件者＋主旨，
    // 授權要隨 session 結束；upsert 也更新 session_id，讓每次重新登入的重新回報接上新 session。
    await c.var.db.prepare(
      `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at, session_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id,
         p256dh = excluded.p256dh, auth = excluded.auth, session_id = excluded.session_id`,
    )
      .bind(newId('psub'), c.var.user.id, endpoint, p256dh, auth, Date.now(), c.var.session.id)
      .run();
    // 輪換：刪掉這位使用者的舊（失效）endpoint。scoped by user_id，且不刪剛 upsert 的新 endpoint。
    if (body.data.oldEndpoint && body.data.oldEndpoint !== endpoint) {
      await c.var.db.prepare(`DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?`)
        .bind(c.var.user.id, body.data.oldEndpoint)
        .run();
    }
    return c.json({ ok: true });
  });

  app.post('/push/unsubscribe', async (c) => {
    const body = z.object({ endpoint: z.string().max(2048) }).safeParse(await c.req.json());
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    await c.var.db.prepare(`DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?`)
      .bind(c.var.user.id, body.data.endpoint)
      .run();
    return c.json({ ok: true });
  });

  /* ---------- 個人資料 ---------- */
  app.patch('/profile', async (c) => {
    const body = z.object({ displayName: z.string().trim().min(1).max(40) }).safeParse(await c.req.json());
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    await c.var.db.prepare(`UPDATE users SET display_name = ? WHERE id = ?`)
      .bind(body.data.displayName, c.var.user.id)
      .run();
    await audit(c.var.db, {
      userId: c.var.user.id,
      action: 'profile.update',
      ip: getIp(c),
      userAgent: getUa(c),
      meta: { displayName: body.data.displayName },
    });
    return c.json({ ok: true });
  });

  app.post('/profile/avatar', async (c) => {
    const form = await c.req.parseBody();
    const file = form['file'];
    if (!(file instanceof File)) return c.json({ error: 'bad_request' }, 400);
    if (!file.type.startsWith('image/')) return c.json({ error: 'not_an_image' }, 400);
    // SVG 走同源文件會執行腳本（頭像網址人人可讀）——只擋這一類，其餘影像照收。
    if (isScriptableImageType(file.type)) return c.json({ error: 'not_an_image' }, 400);
    if (file.size > AVATAR_MAX_BYTES) return c.json({ error: 'too_large', maxBytes: AVATAR_MAX_BYTES }, 413);

    const userId = c.var.user.id;
    const old = await c.var.db.prepare(`SELECT avatar_key FROM users WHERE id = ?`)
      .bind(userId)
      .first<{ avatar_key: string | null }>();
    // 時戳只為了好讀（R2 列表可依上傳順序排），唯一性一律靠隨機後綴：
    // 光靠 Date.now() 時，同一毫秒內的雙擊／重送會生出同一個 key，
    // 下面「刪舊」那一步就會刪掉自己剛寫進去的物件（avatar_key 指向空物件 → 頭像無聲消失）。
    const key = `avatar/${userId}/${Date.now()}-${newId('av')}`;
    await c.env.MAIL_STORE.put(key, await file.arrayBuffer(), {
      httpMetadata: { contentType: file.type },
    });
    await c.var.db.prepare(`UPDATE users SET avatar_key = ? WHERE id = ?`).bind(key, userId).run();
    // key 已不可能相撞，這道 guard 是純保險：舊 key 等於新 key 就絕不刪。
    if (old?.avatar_key && old.avatar_key !== key) await c.env.MAIL_STORE.delete(old.avatar_key);
    return c.json({ ok: true, avatarUrl: `/api/v1/avatars/${userId}?v=${key.split('/').pop()}` });
  });

  /** 站內任何登入者可看彼此頭像（寄件人顯示用） */
  async function serveAvatar(c: { env: Env; executionCtx?: ExecutionContext }, avatarKey: string | null) {
    if (!avatarKey) return null;
    // 邊緣快取（lib/edgeCache.ts）：授權在前——avatarKey 只可能來自呼叫端剛做完的
    // users 查詢（requireSession 已擋未登入；查無此人時 avatarKey 為 null → 上面就返回，
    // 照原本邏輯由呼叫端回 404）；確認之後才查快取。
    // 可變性：頭像 key 是 `avatar/<userId>/<上傳時戳>-<隨機 id>`，換頭像會寫新 key、舊物件即刻從 R2 刪除
    //   → key 本身就是版本；DB 回新 key 就是新的快取項目，不會讀到舊圖。
    //   隨機後綴讓同一毫秒的兩次上傳也拿到不同 key（見上方 /profile/avatar），所以「key 即版本」
    //   沒有例外；TTL 仍取短（5 分鐘）純粹當保險。
    const ck = edgeCacheKey('avatar', avatarKey);
    const hit = await edgeCacheMatch(ck);
    // 原始型別存在 R2 metadata（不在 D1）→ 連同位元組一起放進快取項目的 Content-Type，
    // 命中時照樣重跑下面的 isScriptableImageType 降級，不因為走快取而少一道守門。
    const cachedType = hit?.headers.get('content-type');
    let body: ReadableStream | null;
    let stored: string;
    // 快取命中但沒存到 content-type（理論上不會發生，因為下面 edgeCachePut 一律帶 storedContentType；
    // 保險起見仍當成 miss 處理）：視為未命中改讀 R2，並讓下面的 `!usedCache` 補寫一份完整的快取項目，
    // 而不是「這次退回讀 R2 之後就再也不補寫、永遠繞過快取」。
    const usedCache = !!(hit && cachedType);
    if (usedCache) {
      body = hit!.body;
      stored = cachedType!;
    } else {
      const obj = await c.env.MAIL_STORE.get(avatarKey);
      if (!obj) return null;
      body = obj.body;
      stored = obj.httpMetadata?.contentType ?? 'image/png';
    }
    // 守門加嚴前可能已有 SVG 存進 R2：不照原型別 inline 回送，改成純下載；其餘型別原樣送出。
    const scriptable = isScriptableImageType(stored);
    const res = new Response(body, {
      headers: {
        'Content-Type': scriptable ? 'application/octet-stream' : stored,
        'Content-Disposition': scriptable ? 'attachment' : 'inline',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, max-age=86400',
        // 比照 inline 附件（mail.ts）：即使被當頂層文件開啟也不能執行腳本／對外發請求。
        'Content-Security-Policy': "sandbox; default-src 'none'",
      },
    });
    // 注意：`res` 這裡的 Cache-Control 是給瀏覽器看的 'private,...'（頭像仍要求登入才能取得）；
    // edgeCachePut 內部會另外組一份 `Cache-Control: public, max-age=...` 存進 Cache API ——
    // 存進去的那份必須是 public，否則 Cache API 會直接拒收整個 put（日後別「順手」把這裡改成
    // 直接存 res 本身或把 storedContentType 那條路改成帶 private，會讓快取靜默失效、查不出原因）。
    if (!usedCache) edgeCachePut(c, ck, res, EDGE_CACHE_TTL.avatar, stored);
    return res;
  }

  app.get('/avatars/by-email', async (c) => {
    const email = (c.req.query('email') ?? '').toLowerCase();
    if (!isDomainEmail(c.env, email)) return c.json({ error: 'not_found' }, 404);
    const row = await c.var.db.prepare(`SELECT avatar_key FROM users WHERE email = ?`)
      .bind(email)
      .first<{ avatar_key: string | null }>();
    const res = await serveAvatar(c, row?.avatar_key ?? null);
    return res ?? c.json({ error: 'not_found' }, 404);
  });

  app.get('/avatars/:userId', async (c) => {
    const row = await c.var.db.prepare(`SELECT avatar_key FROM users WHERE id = ?`)
      .bind(c.req.param('userId'))
      .first<{ avatar_key: string | null }>();
    const res = await serveAvatar(c, row?.avatar_key ?? null);
    return res ?? c.json({ error: 'not_found' }, 404);
  });

  /* ---------- 標籤 ---------- */
  app.post('/labels', async (c) => {
    const body = z
      .object({
        name: z.string().trim().min(1).max(24),
        color: z.string().regex(COLOR_RE),
        parentId: z.string().nullable().optional(), // F4.5：父標籤（須為頂層）
        sortOrder: z.number().int().min(0).max(9999).optional(),
      })
      .safeParse(await c.req.json());
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    const parentId = body.data.parentId || null; // 空字串→null（避免存進非法的非 null 父）
    if (parentId && !(await isTopLevelLabel(c.env, c.var.user.id, parentId))) {
      return c.json({ error: 'bad_parent' }, 400); // 父標籤須屬本人且為頂層（限 2 層）
    }
    const id = newId('lbl');
    try {
      await c.var.db.prepare(`INSERT INTO labels (id, user_id, name, color, parent_id, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .bind(id, c.var.user.id, body.data.name, body.data.color, parentId, body.data.sortOrder ?? 0, Date.now())
        .run();
    } catch {
      return c.json({ error: 'label_exists' }, 409);
    }
    return c.json({ id, name: body.data.name, color: body.data.color });
  });

  app.patch('/labels/:id', async (c) => {
    const body = z
      .object({
        name: z.string().trim().min(1).max(24).optional(),
        color: z.string().regex(COLOR_RE).optional(),
        parentId: z.string().nullable().optional(), // F4.5：設/清父標籤
        sortOrder: z.number().int().min(0).max(9999).optional(),
      })
      .safeParse(await c.req.json());
    const d = body.success ? body.data : null;
    if (!d || (d.name === undefined && d.color === undefined && d.parentId === undefined && d.sortOrder === undefined)) {
      return c.json({ error: 'bad_request' }, 400);
    }
    const labelId = c.req.param('id');
    // 空字串視為「清為頂層」(null)；undefined=不動。避免空字串被當合法父值寫入。
    const newParent = d.parentId === undefined ? undefined : (d.parentId || null);
    // F4.5：要「設」父標籤時（truthy id）才驗證——須頂層、非自己、且本標籤目前無子標籤（避免變成 3 層）。
    if (newParent) {
      if (newParent === labelId) return c.json({ error: 'bad_parent' }, 400);
      if (!(await isTopLevelLabel(c.env, c.var.user.id, newParent))) return c.json({ error: 'bad_parent' }, 400);
      const hasKids = await c.var.db.prepare(`SELECT 1 FROM labels WHERE parent_id = ? AND user_id = ? LIMIT 1`)
        .bind(labelId, c.var.user.id)
        .first();
      if (hasKids) return c.json({ error: 'has_children' }, 400);
    }
    const sets: string[] = [];
    const binds: unknown[] = [];
    if (d.name) {
      sets.push('name = ?');
      binds.push(d.name);
    }
    if (d.color) {
      sets.push('color = ?');
      binds.push(d.color);
    }
    if (newParent !== undefined) {
      sets.push('parent_id = ?');
      binds.push(newParent); // null=清為頂層（已正規化空字串）
    }
    if (d.sortOrder !== undefined) {
      sets.push('sort_order = ?');
      binds.push(d.sortOrder);
    }
    try {
      const res = await c.var.db.prepare(`UPDATE labels SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`)
        .bind(...binds, c.req.param('id'), c.var.user.id)
        .run();
      if (!(res.meta.changes ?? 0)) return c.json({ error: 'not_found' }, 404);
    } catch {
      return c.json({ error: 'label_exists' }, 409);
    }
    return c.json({ ok: true });
  });

  app.delete('/labels/:id', async (c) => {
    const id = c.req.param('id');
    const owned = await c.var.db.prepare(`SELECT id FROM labels WHERE id = ? AND user_id = ?`)
      .bind(id, c.var.user.id)
      .first();
    if (!owned) return c.json({ error: 'not_found' }, 404);
    // 規則若引用了被刪的標籤，rulesEngine 的 INSERT…SELECT 會自然落空，無需連動清理
    await c.var.db.batch([
      c.var.db.prepare(`DELETE FROM message_labels WHERE label_id = ?`).bind(id),
      c.var.db.prepare(`DELETE FROM labels WHERE id = ?`).bind(id),
    ]);
    return c.json({ ok: true });
  });

  /* ---------- 自動規則 ---------- */
  app.get('/rules', async (c) => {
    const rows = await c.var.db.prepare(
      `SELECT id, name, conditions, actions, enabled, priority FROM rules WHERE user_id = ? ORDER BY priority, created_at`,
    )
      .bind(c.var.user.id)
      .all<{ id: string; name: string; conditions: string; actions: string; enabled: number; priority: number }>();
    return c.json({
      rules: rows.results.map((r) => ({
        id: r.id,
        name: r.name,
        conditions: JSON.parse(r.conditions) as Record<string, unknown>,
        actions: JSON.parse(r.actions) as Record<string, unknown>,
        enabled: !!r.enabled,
        priority: r.priority,
      })),
    });
  });

  app.post('/rules', async (c) => {
    const body = z
      .object({
        name: z.string().trim().min(1).max(60),
        conditions: conditionsSchema,
        actions: actionsSchema,
        enabled: z.boolean().default(true),
        priority: z.number().int().min(0).max(999).default(0),
      })
      .safeParse(await c.req.json());
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    if (body.data.actions.addLabelId) {
      const label = await c.var.db.prepare(`SELECT id FROM labels WHERE id = ? AND user_id = ?`)
        .bind(body.data.actions.addLabelId, c.var.user.id)
        .first();
      if (!label) return c.json({ error: 'bad_label' }, 400);
    }
    // F4.1b：轉寄目標須為聯絡人或站內（forward 為高風險，建立時即把關，縮小外洩面；執行時再驗一次）。
    if (body.data.actions.forward) {
      const ok = await isForwardTargetAllowed(c.env, c.var.user.id, c.var.user.email, body.data.actions.forward);
      if (!ok) return c.json({ error: 'bad_forward_target' }, 400);
    }
    const id = newId('rul');
    await c.var.db.prepare(
      `INSERT INTO rules (id, user_id, name, conditions, actions, enabled, priority, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        c.var.user.id,
        body.data.name,
        JSON.stringify(body.data.conditions),
        JSON.stringify(body.data.actions),
        body.data.enabled ? 1 : 0,
        body.data.priority,
        Date.now(),
      )
      .run();
    return c.json({ id });
  });

  app.patch('/rules/:id', async (c) => {
    const body = z
      .object({
        name: z.string().trim().min(1).max(60).optional(),
        conditions: conditionsSchema.optional(),
        actions: actionsSchema.optional(),
        enabled: z.boolean().optional(),
        priority: z.number().int().min(0).max(999).optional(),
      })
      .safeParse(await c.req.json());
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    // 與 POST 一致：若指定 addLabelId，標籤須屬於本人（縱深防禦；套用端另有 user_id 把關）。
    if (body.data.actions?.addLabelId) {
      const label = await c.var.db.prepare(`SELECT id FROM labels WHERE id = ? AND user_id = ?`)
        .bind(body.data.actions.addLabelId, c.var.user.id)
        .first();
      if (!label) return c.json({ error: 'bad_label' }, 400);
    }
    if (body.data.actions?.forward) {
      const ok = await isForwardTargetAllowed(c.env, c.var.user.id, c.var.user.email, body.data.actions.forward);
      if (!ok) return c.json({ error: 'bad_forward_target' }, 400);
    }
    const sets: string[] = [];
    const binds: unknown[] = [];
    if (body.data.name !== undefined) {
      sets.push('name = ?');
      binds.push(body.data.name);
    }
    if (body.data.conditions !== undefined) {
      sets.push('conditions = ?');
      binds.push(JSON.stringify(body.data.conditions));
    }
    if (body.data.actions !== undefined) {
      sets.push('actions = ?');
      binds.push(JSON.stringify(body.data.actions));
    }
    if (body.data.enabled !== undefined) {
      sets.push('enabled = ?');
      binds.push(body.data.enabled ? 1 : 0);
    }
    if (body.data.priority !== undefined) {
      sets.push('priority = ?');
      binds.push(body.data.priority);
    }
    if (!sets.length) return c.json({ error: 'bad_request' }, 400);
    const res = await c.var.db.prepare(`UPDATE rules SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`)
      .bind(...binds, c.req.param('id'), c.var.user.id)
      .run();
    if (!(res.meta.changes ?? 0)) return c.json({ error: 'not_found' }, 404);
    return c.json({ ok: true });
  });

  app.delete('/rules/:id', async (c) => {
    const res = await c.var.db.prepare(`DELETE FROM rules WHERE id = ? AND user_id = ?`)
      .bind(c.req.param('id'), c.var.user.id)
      .run();
    if (!(res.meta.changes ?? 0)) return c.json({ error: 'not_found' }, 404);
    return c.json({ ok: true });
  });

  // 把規則套用到收件匣現有信：dryRun=true 只預覽符合數＋樣本（不異動），false 才實際套用。
  app.post('/rules/:id/run', async (c) => {
    const body = z
      .object({ dryRun: z.boolean().default(true) })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    const result = await runRuleOnExisting(c.env, c.var.user.id, c.req.param('id'), { dryRun: body.data.dryRun });
    if (!result) return c.json({ error: 'not_found' }, 404);
    if (!body.data.dryRun) {
      await audit(c.var.db, {
        userId: c.var.user.id,
        action: 'rule.run_existing',
        targetType: 'rule',
        targetId: c.req.param('id'),
        ip: getIp(c),
        userAgent: getUa(c),
        meta: { matched: result.matched, applied: result.applied },
      });
    }
    return c.json(result);
  });

  /* ---------- 聯絡人（聚合通信史 + 自訂名稱/備註覆寫） ---------- */
  app.get('/contacts', async (c) => {
    const userId = c.var.user.id;
    const rows = await c.var.db.prepare(
      `SELECT agg.addr AS email,
              MAX(agg.name) AS known_name,
              COUNT(*) AS cnt,
              MAX(agg.ts) AS last_used,
              ct.custom_name, ct.note, ct.phone, ct.company, ct.title, ct.birthday, ct.address
       FROM (
         SELECT je.value AS addr, '' AS name, m.received_at AS ts
           FROM messages m, json_each(m.to_addrs) je
          WHERE m.user_id = ?1 AND m.direction = 'outbound'
         UNION ALL
         SELECT m.from_addr AS addr, m.from_name AS name, m.received_at AS ts
           FROM messages m
          WHERE m.user_id = ?1 AND m.direction = 'inbound' AND m.folder NOT IN ('spam','trash')
       ) agg
       LEFT JOIN contacts ct ON ct.user_id = ?1 AND ct.email = agg.addr
       WHERE agg.addr != ?2 AND agg.addr != 'digest@miseroda.com'
       GROUP BY agg.addr
       ORDER BY last_used DESC LIMIT 500`,
    )
      .bind(userId, c.var.user.email)
      .all<{
        email: string; known_name: string; cnt: number; last_used: number;
        custom_name: string | null; note: string | null; phone: string | null;
        company: string | null; title: string | null; birthday: string | null; address: string | null;
      }>();

    const contacts = rows.results.map((r) => ({
      email: r.email,
      knownName: r.known_name || '',
      customName: r.custom_name ?? '',
      note: r.note ?? '',
      phone: r.phone ?? '',
      company: r.company ?? '',
      title: r.title ?? '',
      birthday: r.birthday ?? '',
      address: r.address ?? '',
      count: r.cnt,
      lastUsed: r.last_used,
    }));

    // 手動新增 / 匯入但無往來紀錄的聯絡人也要列出。
    // seen 用「完整」往來地址集（非僅顯示中的前 500），避免 rank>500 的真實往來對象被誤標「手動新增」。
    const allAddrs = await c.var.db.prepare(
      `SELECT DISTINCT addr FROM (
         SELECT je.value AS addr FROM messages m, json_each(m.to_addrs) je WHERE m.user_id = ?1 AND m.direction = 'outbound'
         UNION SELECT m.from_addr AS addr FROM messages m WHERE m.user_id = ?1 AND m.direction = 'inbound' AND m.folder NOT IN ('spam','trash')
       )`,
    )
      .bind(userId)
      .all<{ addr: string }>();
    const seen = new Set(allAddrs.results.map((r) => r.addr));
    const manual = await c.var.db.prepare(
      `SELECT email, custom_name, note, phone, company, title, birthday, address FROM contacts WHERE user_id = ? ORDER BY updated_at DESC`,
    )
      .bind(userId)
      .all<{ email: string; custom_name: string; note: string; phone: string; company: string; title: string; birthday: string; address: string }>();
    for (const m of manual.results) {
      if (seen.has(m.email)) continue;
      contacts.push({
        email: m.email, knownName: '', customName: m.custom_name ?? '', note: m.note ?? '', phone: m.phone ?? '',
        company: m.company ?? '', title: m.title ?? '', birthday: m.birthday ?? '', address: m.address ?? '', count: 0, lastUsed: 0,
      });
    }

    return c.json({ contacts });
  });

  /* ---------- 通訊錄匯出（vCard 3.0） ---------- */
  app.get('/contacts/export.vcf', async (c) => {
    const { generateVCard } = await import('../email/vcard');
    const userId = c.var.user.id;
    const rows = await c.var.db.prepare(
      `SELECT agg.addr AS email, MAX(agg.name) AS known_name, ct.custom_name, ct.note, ct.phone, ct.company, ct.title, ct.birthday, ct.address
       FROM (
         SELECT je.value AS addr, '' AS name FROM messages m, json_each(m.to_addrs) je
          WHERE m.user_id = ?1 AND m.direction = 'outbound'
         UNION ALL
         SELECT m.from_addr AS addr, m.from_name AS name FROM messages m
          WHERE m.user_id = ?1 AND m.direction = 'inbound' AND m.folder NOT IN ('spam','trash')
       ) agg
       LEFT JOIN contacts ct ON ct.user_id = ?1 AND ct.email = agg.addr
       WHERE agg.addr != ?2 AND agg.addr != 'digest@miseroda.com'
       GROUP BY agg.addr`,
    )
      .bind(userId, c.var.user.email)
      .all<{
        email: string; known_name: string; custom_name: string | null; note: string | null; phone: string | null;
        company: string | null; title: string | null; birthday: string | null; address: string | null;
      }>();
    const seen = new Set(rows.results.map((r) => r.email));
    const all = rows.results.map((r) => ({
      name: r.custom_name || r.known_name || r.email,
      email: r.email,
      phone: r.phone ?? '',
      note: r.note ?? '',
      company: r.company ?? '',
      title: r.title ?? '',
      birthday: r.birthday ?? '',
      address: r.address ?? '',
    }));
    const manual = await c.var.db.prepare(
      `SELECT email, custom_name, note, phone, company, title, birthday, address FROM contacts WHERE user_id = ?`,
    )
      .bind(userId)
      .all<{ email: string; custom_name: string; note: string; phone: string; company: string; title: string; birthday: string; address: string }>();
    for (const m of manual.results) {
      if (seen.has(m.email)) continue;
      all.push({
        name: m.custom_name || m.email, email: m.email, phone: m.phone ?? '', note: m.note ?? '',
        company: m.company ?? '', title: m.title ?? '', birthday: m.birthday ?? '', address: m.address ?? '',
      });
    }
    return new Response(generateVCard(all), {
      headers: {
        'Content-Type': 'text/vcard; charset=utf-8',
        'Content-Disposition': `attachment; filename="miseroda-contacts.vcf"`,
        'Cache-Control': 'private, max-age=0',
      },
    });
  });

  /* ---------- 通訊錄匯入（vCard 3.0；上限 5000 筆，逐筆 upsert） ---------- */
  app.post('/contacts/import', async (c) => {
    const { parseVCard } = await import('../email/vcard');
    const body = z.object({ vcf: z.string().max(5 * 1024 * 1024) }).safeParse(await c.req.json());
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    const parsed = parseVCard(body.data.vcf, 2000); // 解析時即上限，避免巨檔先全解析才截斷
    if (!parsed.length) return c.json({ ok: true, imported: 0 });
    const now = Date.now();
    const stmts = parsed.map((p) =>
      c.var.db.prepare(
        `INSERT INTO contacts (user_id, email, custom_name, note, phone, company, title, birthday, address, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, email) DO UPDATE SET
           custom_name = CASE WHEN excluded.custom_name != '' THEN excluded.custom_name ELSE contacts.custom_name END,
           phone = CASE WHEN excluded.phone != '' THEN excluded.phone ELSE contacts.phone END,
           note = CASE WHEN excluded.note != '' THEN excluded.note ELSE contacts.note END,
           company = CASE WHEN excluded.company != '' THEN excluded.company ELSE contacts.company END,
           title = CASE WHEN excluded.title != '' THEN excluded.title ELSE contacts.title END,
           birthday = CASE WHEN excluded.birthday != '' THEN excluded.birthday ELSE contacts.birthday END,
           address = CASE WHEN excluded.address != '' THEN excluded.address ELSE contacts.address END,
           updated_at = excluded.updated_at`,
      ).bind(
        c.var.user.id, p.email.slice(0, 254), p.name.slice(0, 60), p.note.slice(0, 500), p.phone.slice(0, 40),
        (p.company ?? '').slice(0, 120), (p.title ?? '').slice(0, 120), (p.birthday ?? '').slice(0, 40), (p.address ?? '').slice(0, 300),
        now, now,
      ),
    );
    // 分批執行（每批 200 句，把 round-trip 壓到 ≤10 次）
    for (let i = 0; i < stmts.length; i += 200) await c.var.db.batch(stmts.slice(i, i + 200));
    return c.json({ ok: true, imported: parsed.length });
  });

  /* ---------- 刪除聯絡人（移除標註 / 手動聯絡人列） ---------- */
  app.delete('/contacts/:email', async (c) => {
    const email = decodeURIComponent(c.req.param('email')).trim().toLowerCase();
    await c.var.db.prepare(`DELETE FROM contacts WHERE user_id = ? AND email = ?`).bind(c.var.user.id, email).run();
    return c.json({ ok: true });
  });

  app.put('/contacts/:email', async (c) => {
    const body = z
      .object({
        customName: z.string().max(60).default(''),
        note: z.string().max(500).default(''),
        phone: z.string().max(40).default(''),
        company: z.string().max(120).default(''),
        title: z.string().max(120).default(''),
        birthday: z.string().max(40).default(''),
        address: z.string().max(300).default(''),
      })
      .safeParse(await c.req.json());
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    const email = decodeURIComponent(c.req.param('email')).trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return c.json({ error: 'bad_request' }, 400);
    const d = body.data;
    const now = Date.now();
    await c.var.db.prepare(
      `INSERT INTO contacts (user_id, email, custom_name, note, phone, company, title, birthday, address, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, email) DO UPDATE SET custom_name = excluded.custom_name, note = excluded.note, phone = excluded.phone,
         company = excluded.company, title = excluded.title, birthday = excluded.birthday, address = excluded.address, updated_at = excluded.updated_at`,
    )
      .bind(c.var.user.id, email, d.customName.trim(), d.note.trim(), d.phone.trim(), d.company.trim(), d.title.trim(), d.birthday.trim(), d.address.trim(), now, now)
      .run();
    return c.json({ ok: true });
  });

  /* ---------- 聯絡人群組（F4.3b：一鍵寄給家人） ---------- */
  app.get('/contact-groups', async (c) => {
    const userId = c.var.user.id;
    const groups = await c.var.db.prepare(`SELECT id, name, created_at FROM contact_groups WHERE user_id = ? ORDER BY name`)
      .bind(userId)
      .all<{ id: string; name: string; created_at: number }>();
    const members = await c.var.db.prepare(
      `SELECT m.group_id, m.email FROM contact_group_members m JOIN contact_groups g ON g.id = m.group_id WHERE g.user_id = ?`,
    )
      .bind(userId)
      .all<{ group_id: string; email: string }>();
    const byGroup = new Map<string, string[]>();
    for (const m of members.results) {
      const arr = byGroup.get(m.group_id) ?? [];
      arr.push(m.email);
      byGroup.set(m.group_id, arr);
    }
    return c.json({ groups: groups.results.map((g) => ({ id: g.id, name: g.name, emails: byGroup.get(g.id) ?? [] })) });
  });

  app.post('/contact-groups', async (c) => {
    const body = z.object({ name: z.string().trim().min(1).max(60) }).safeParse(await c.req.json());
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    const cnt = await c.var.db.prepare(`SELECT COUNT(*) AS c FROM contact_groups WHERE user_id = ?`).bind(c.var.user.id).first<{ c: number }>();
    if ((cnt?.c ?? 0) >= 200) return c.json({ error: 'too_many_groups' }, 400); // 每人群組數上限（防無界成長）
    const id = newId('grp');
    await c.var.db.prepare(`INSERT INTO contact_groups (id, user_id, name, created_at) VALUES (?, ?, ?, ?)`)
      .bind(id, c.var.user.id, body.data.name, Date.now())
      .run();
    return c.json({ id });
  });

  app.patch('/contact-groups/:id', async (c) => {
    const body = z
      .object({
        name: z.string().trim().min(1).max(60).optional(),
        emails: z.array(z.string().email().max(254)).max(500).optional(),
      })
      .safeParse(await c.req.json());
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    const gid = c.req.param('id');
    const owns = await c.var.db.prepare(`SELECT 1 FROM contact_groups WHERE id = ? AND user_id = ?`).bind(gid, c.var.user.id).first();
    if (!owns) return c.json({ error: 'not_found' }, 404);
    if (body.data.name !== undefined) {
      await c.var.db.prepare(`UPDATE contact_groups SET name = ? WHERE id = ? AND user_id = ?`).bind(body.data.name, gid, c.var.user.id).run();
    }
    if (body.data.emails !== undefined) {
      const emails = [...new Set(body.data.emails.map((e) => e.trim().toLowerCase()).filter(Boolean))].slice(0, 500);
      const stmts: D1PreparedStatement[] = [c.var.db.prepare(`DELETE FROM contact_group_members WHERE group_id = ?`).bind(gid)];
      for (const e of emails) stmts.push(c.var.db.prepare(`INSERT OR IGNORE INTO contact_group_members (group_id, email) VALUES (?, ?)`).bind(gid, e));
      await c.var.db.batch(stmts);
    }
    return c.json({ ok: true });
  });

  app.delete('/contact-groups/:id', async (c) => {
    const gid = c.req.param('id');
    const owns = await c.var.db.prepare(`SELECT 1 FROM contact_groups WHERE id = ? AND user_id = ?`).bind(gid, c.var.user.id).first();
    if (!owns) return c.json({ error: 'not_found' }, 404);
    // 先刪成員再刪群組（成員 FK 參照群組；反序會觸發 FOREIGN KEY constraint）。
    await c.var.db.prepare(`DELETE FROM contact_group_members WHERE group_id = ?`).bind(gid).run();
    await c.var.db.prepare(`DELETE FROM contact_groups WHERE id = ? AND user_id = ?`).bind(gid, c.var.user.id).run();
    return c.json({ ok: true });
  });

  /* ---------- 使用者端儲存用量（F4.6a，唯讀自助） ---------- */
  app.get('/storage', async (c) => {
    const userId = c.var.user.id;
    const [msgAgg, attAgg, largest] = await Promise.all([
      c.var.db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(size_bytes), 0) AS bytes FROM messages WHERE user_id = ?`)
        .bind(userId)
        .first<{ n: number; bytes: number }>(),
      c.var.db.prepare(`SELECT COALESCE(SUM(size_bytes), 0) AS bytes FROM attachments WHERE user_id = ?`)
        .bind(userId)
        .first<{ bytes: number }>(),
      c.var.db.prepare(
        `SELECT id, subject, from_addr, from_name, size_bytes, received_at, folder, has_attachments
         FROM messages WHERE user_id = ? ORDER BY size_bytes DESC LIMIT 20`,
      )
        .bind(userId)
        .all<{ id: string; subject: string; from_addr: string; from_name: string; size_bytes: number; received_at: number; folder: string; has_attachments: number }>(),
    ]);
    const messageBytes = msgAgg?.bytes ?? 0;
    const attachmentBytes = attAgg?.bytes ?? 0;
    return c.json({
      messageBytes,
      attachmentBytes,
      totalBytes: messageBytes + attachmentBytes,
      messageCount: msgAgg?.n ?? 0,
      largest: largest.results.map((r) => ({
        id: r.id,
        subject: r.subject,
        from: r.from_name || r.from_addr,
        sizeBytes: r.size_bytes,
        receivedAt: r.received_at,
        folder: r.folder,
        hasAttachments: r.has_attachments === 1,
      })),
    });
  });

  /* ---------- 多重簽名 + 綁寄件身分（F4.4） ---------- */
  app.get('/signatures', async (c) => {
    const rows = await c.var.db.prepare(
      `SELECT id, name, content, is_default FROM signatures WHERE user_id = ? ORDER BY is_default DESC, created_at`,
    )
      .bind(c.var.user.id)
      .all<{ id: string; name: string; content: string; is_default: number }>();
    return c.json({ signatures: rows.results.map((r) => ({ id: r.id, name: r.name, content: r.content, isDefault: r.is_default === 1 })) });
  });

  app.post('/signatures', async (c) => {
    const body = z
      .object({ name: z.string().trim().min(1).max(60), content: z.string().max(2000).default(''), isDefault: z.boolean().default(false) })
      .safeParse(await c.req.json());
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    const cnt = await c.var.db.prepare(`SELECT COUNT(*) AS c FROM signatures WHERE user_id = ?`).bind(c.var.user.id).first<{ c: number }>();
    if ((cnt?.c ?? 0) >= 20) return c.json({ error: 'too_many_signatures' }, 400);
    const id = newId('sig');
    const stmts: D1PreparedStatement[] = [];
    if (body.data.isDefault) stmts.push(c.var.db.prepare(`UPDATE signatures SET is_default = 0 WHERE user_id = ?`).bind(c.var.user.id));
    stmts.push(
      c.var.db.prepare(`INSERT INTO signatures (id, user_id, name, content, is_default, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .bind(id, c.var.user.id, body.data.name, body.data.content, body.data.isDefault ? 1 : 0, Date.now()),
    );
    await c.var.db.batch(stmts);
    return c.json({ id });
  });

  app.patch('/signatures/:id', async (c) => {
    const body = z
      .object({ name: z.string().trim().min(1).max(60).optional(), content: z.string().max(2000).optional(), isDefault: z.boolean().optional() })
      .safeParse(await c.req.json());
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    const sid = c.req.param('id');
    const owns = await c.var.db.prepare(`SELECT 1 FROM signatures WHERE id = ? AND user_id = ?`).bind(sid, c.var.user.id).first();
    if (!owns) return c.json({ error: 'not_found' }, 404);
    const stmts: D1PreparedStatement[] = [];
    if (body.data.isDefault === true) stmts.push(c.var.db.prepare(`UPDATE signatures SET is_default = 0 WHERE user_id = ?`).bind(c.var.user.id));
    const sets: string[] = [];
    const binds: unknown[] = [];
    if (body.data.name !== undefined) { sets.push('name = ?'); binds.push(body.data.name); }
    if (body.data.content !== undefined) { sets.push('content = ?'); binds.push(body.data.content); }
    if (body.data.isDefault !== undefined) { sets.push('is_default = ?'); binds.push(body.data.isDefault ? 1 : 0); }
    if (sets.length) stmts.push(c.var.db.prepare(`UPDATE signatures SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).bind(...binds, sid, c.var.user.id));
    if (stmts.length) await c.var.db.batch(stmts);
    return c.json({ ok: true });
  });

  app.delete('/signatures/:id', async (c) => {
    const sid = c.req.param('id');
    const res = await c.var.db.prepare(`DELETE FROM signatures WHERE id = ? AND user_id = ?`).bind(sid, c.var.user.id).run();
    if (!(res.meta.changes ?? 0)) return c.json({ error: 'not_found' }, 404);
    await c.var.db.prepare(`UPDATE aliases SET signature_id = NULL WHERE signature_id = ? AND user_id = ?`).bind(sid, c.var.user.id).run(); // 解綁
    return c.json({ ok: true });
  });

  // 綁定簽名到自己的別名（signatureId=null 解綁）。驗別名與簽名皆屬本人。
  app.put('/signatures/bind', async (c) => {
    const body = z.object({ aliasId: z.string().min(1), signatureId: z.string().min(1).nullable() }).safeParse(await c.req.json());
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    const ownsAlias = await c.var.db.prepare(`SELECT 1 FROM aliases WHERE id = ? AND user_id = ?`).bind(body.data.aliasId, c.var.user.id).first();
    if (!ownsAlias) return c.json({ error: 'not_found' }, 404);
    if (body.data.signatureId) {
      const ownsSig = await c.var.db.prepare(`SELECT 1 FROM signatures WHERE id = ? AND user_id = ?`).bind(body.data.signatureId, c.var.user.id).first();
      if (!ownsSig) return c.json({ error: 'bad_signature' }, 400);
    }
    await c.var.db.prepare(`UPDATE aliases SET signature_id = ? WHERE id = ? AND user_id = ?`)
      .bind(body.data.signatureId, body.data.aliasId, c.var.user.id)
      .run();
    return c.json({ ok: true });
  });

  /* ---------- 聯絡人 360：純讀聚合（最近往來 × 未來事件 × 待跟進 × 寄件驗證）。
     路徑用 /contacts/profile/:email 避免與 /contacts/suggest、/contacts/export.vcf 的 param/static 路由競合。 */
  app.get('/contacts/profile/:email', async (c) => {
    const userId = c.var.user.id;
    const email = decodeURIComponent(c.req.param('email')).trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return c.json({ error: 'bad_request' }, 400);
    const now = Date.now();

    const [card, msgs, events, followUps, verdict, stats] = await Promise.all([
      c.var.db.prepare(`SELECT custom_name, note, phone FROM contacts WHERE user_id = ? AND email = ?`)
        .bind(userId, email)
        .first<{ custom_name: string; note: string; phone: string }>(),
      // 最近往來（收 from_addr=我；寄 to_addrs 含我），keyset by received_at DESC
      c.var.db.prepare(
        `SELECT id, thread_id, subject, snippet, direction, received_at, folder
           FROM messages
          WHERE user_id = ?1 AND folder NOT IN ('trash','spam')
            AND ( (direction = 'inbound' AND lower(from_addr) = ?2)
                  OR (direction = 'outbound' AND EXISTS (SELECT 1 FROM json_each(to_addrs) je WHERE lower(je.value) = ?2)) )
          ORDER BY received_at DESC LIMIT 12`,
      )
        .bind(userId, email)
        .all<{ id: string; thread_id: string; subject: string; snippet: string; direction: string; received_at: number; folder: string }>(),
      // 未來事件：該 email 為 organizer 且尚未過（含當天）
      c.var.db.prepare(
        `SELECT id, summary, start_ms, end_ms, start_text, all_day, floating, location
           FROM calendar_events
          WHERE user_id = ? AND lower(organizer) = ? AND start_ms >= ?
          ORDER BY start_ms ASC LIMIT 6`,
      )
        .bind(userId, email, now - 86_400_000)
        .all<{ id: string; summary: string; start_ms: number; end_ms: number | null; start_text: string; all_day: number; floating: number; location: string }>(),
      // 待處理跟進：跟進的信件與此聯絡人相關
      c.var.db.prepare(
        `SELECT f.id, f.subject, f.due_at, f.await_reply, f.thread_id
           FROM follow_ups f JOIN messages m ON m.id = f.message_id AND m.user_id = f.user_id
          WHERE f.user_id = ?1 AND f.status = 'pending'
            AND ( lower(m.from_addr) = ?2 OR EXISTS (SELECT 1 FROM json_each(m.to_addrs) je WHERE lower(je.value) = ?2) )
          ORDER BY f.due_at ASC LIMIT 6`,
      )
        .bind(userId, email)
        .all<{ id: string; subject: string; due_at: number; await_reply: number; thread_id: string }>(),
      // 最近一次此人寄信的 SPF/DKIM/DMARC 驗證（信任卡）
      c.var.db.prepare(
        `SELECT auth_verdict FROM messages
          WHERE user_id = ? AND direction = 'inbound' AND lower(from_addr) = ? AND auth_verdict IS NOT NULL
          ORDER BY received_at DESC LIMIT 1`,
      )
        .bind(userId, email)
        .first<{ auth_verdict: string }>(),
      // 統計：往來總數 + 最近往來時間
      c.var.db.prepare(
        `SELECT COUNT(*) AS total, MAX(received_at) AS last_at FROM messages
          WHERE user_id = ?1 AND folder NOT IN ('trash','spam')
            AND ( (direction = 'inbound' AND lower(from_addr) = ?2)
                  OR (direction = 'outbound' AND EXISTS (SELECT 1 FROM json_each(to_addrs) je WHERE lower(je.value) = ?2)) )`,
      )
        .bind(userId, email)
        .first<{ total: number; last_at: number | null }>(),
    ]);

    let authVerdict: { spf?: string; dkim?: string; dmarc?: string } | null = null;
    if (verdict?.auth_verdict) {
      try {
        authVerdict = JSON.parse(verdict.auth_verdict) as { spf?: string; dkim?: string; dmarc?: string };
      } catch {
        authVerdict = null;
      }
    }

    return c.json({
      email,
      customName: card?.custom_name ?? '',
      note: card?.note ?? '',
      phone: card?.phone ?? '',
      totalMessages: stats?.total ?? 0,
      lastContactedAt: stats?.last_at ?? null,
      authVerdict,
      messages: msgs.results.map((r) => ({
        id: r.id,
        threadId: r.thread_id,
        subject: r.subject,
        snippet: r.snippet,
        direction: r.direction,
        receivedAt: r.received_at,
        folder: r.folder,
      })),
      events: events.results.map((r) => ({
        id: r.id,
        summary: r.summary,
        startMs: r.start_ms,
        endMs: r.end_ms,
        startText: r.start_text,
        allDay: !!r.all_day,
        floating: !!r.floating,
        location: r.location,
      })),
      followUps: followUps.results.map((r) => ({
        id: r.id,
        subject: r.subject,
        dueAt: r.due_at,
        awaitReply: !!r.await_reply,
        threadId: r.thread_id,
      })),
    });
  });

  /* ---------- Plus 別名統計（hon_chen+tag@ 的 tag 聚合） ---------- */
  app.get('/aliases', async (c) => {
    const local = c.var.user.email.split('@')[0];
    const rows = await c.var.db.prepare(
      `SELECT je.value AS addr, COUNT(*) AS cnt, MAX(m.received_at) AS last_used
       FROM messages m, json_each(m.to_addrs) je
       WHERE m.user_id = ?1 AND m.direction = 'inbound' AND je.value LIKE ?2
       GROUP BY je.value ORDER BY cnt DESC LIMIT 50`,
    )
      .bind(c.var.user.id, `${local}+%@%`)
      .all<{ addr: string; cnt: number; last_used: number }>();
    return c.json({
      aliases: rows.results.map((r) => ({
        address: r.addr,
        tag: /\+([^@]+)@/.exec(r.addr)?.[1] ?? '',
        count: r.cnt,
        lastUsed: r.last_used,
      })),
    });
  });

  /* ---------- F9.4：Masked Email（隨機別名一鍵生成 / 停用 / 備註） ---------- */
  // 隨機詞組 word-word-NN@domain：好唸好抄、不含個資。停用時 ingest 對外「查無此人」拒收。
  const MASK_WORDS = [
    'aurora', 'frost', 'otter', 'penguin', 'cedar', 'maple', 'river', 'stone', 'cloud', 'ember',
    'willow', 'harbor', 'meadow', 'comet', 'birch', 'coral', 'dune', 'fern', 'glacier', 'heron',
    'iris', 'juniper', 'kelp', 'lagoon', 'moss', 'nova', 'orchid', 'pine', 'quartz', 'reef',
    'sage', 'tundra', 'umbra', 'vale', 'wren', 'zephyr', 'basil', 'cinder', 'delta', 'echo',
  ];
  app.get('/masked-aliases', async (c) => {
    const rows = await c.var.db.prepare(
      `SELECT id, address, note, disabled, created_by, created_at FROM aliases WHERE user_id = ? ORDER BY created_at DESC`,
    )
      .bind(c.var.user.id)
      .all<{ id: string; address: string; note: string | null; disabled: number; created_by: string; created_at: number }>();
    return c.json({
      aliases: rows.results.map((r) => ({
        id: r.id,
        address: r.address,
        note: r.note,
        disabled: !!r.disabled,
        selfServe: r.created_by === c.var.user.id, // admin 指派的也列出（可停用），但標示來源
        createdAt: r.created_at,
      })),
    });
  });

  app.post('/masked-aliases', async (c) => {
    const body = z.object({ note: z.string().max(200).optional() }).safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    const userId = c.var.user.id;
    const count = await c.var.db.prepare(`SELECT COUNT(*) AS n FROM aliases WHERE user_id = ? AND created_by = ?`)
      .bind(userId, userId)
      .first<{ n: number }>();
    if ((count?.n ?? 0) >= 100) return c.json({ error: 'limit_reached' }, 400);

    const domain = c.env.MAIL_DOMAIN.toLowerCase();
    for (let attempt = 0; attempt < 5; attempt++) {
      const buf = new Uint32Array(3);
      crypto.getRandomValues(buf);
      const address = `${MASK_WORDS[buf[0] % MASK_WORDS.length]}-${MASK_WORDS[buf[1] % MASK_WORDS.length]}-${buf[2] % 100}@${domain}`;
      // 不可撞任何使用者 email（aliases UNIQUE 不涵蓋 users 表）
      const clash = await c.var.db.prepare(`SELECT 1 FROM users WHERE email = ?`).bind(address).first();
      if (clash) continue;
      try {
        const id = newId('als');
        await c.var.db.prepare(
          `INSERT INTO aliases (id, user_id, address, name, note, disabled, created_by, created_at) VALUES (?, ?, ?, NULL, ?, 0, ?, ?)`,
        )
          .bind(id, userId, address, body.data.note ?? null, userId, Date.now())
          .run();
        return c.json({ id, address });
      } catch {
        // UNIQUE 撞號 → 換一組再試
      }
    }
    return c.json({ error: 'generate_failed' }, 500);
  });

  app.patch('/masked-aliases/:id', async (c) => {
    const body = z
      .object({ disabled: z.boolean().optional(), note: z.string().max(200).nullable().optional() })
      .safeParse(await c.req.json());
    if (!body.success || (body.data.disabled === undefined && body.data.note === undefined)) {
      return c.json({ error: 'bad_request' }, 400);
    }
    const sets: string[] = [];
    const binds: unknown[] = [];
    if (body.data.disabled !== undefined) { sets.push('disabled = ?'); binds.push(body.data.disabled ? 1 : 0); }
    if (body.data.note !== undefined) { sets.push('note = ?'); binds.push(body.data.note); }
    const res = await c.var.db.prepare(`UPDATE aliases SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`)
      .bind(...binds, c.req.param('id'), c.var.user.id)
      .run();
    if (!(res.meta.changes ?? 0)) return c.json({ error: 'not_found' }, 404);
    return c.json({ ok: true });
  });

  /* ---------- 送達率與網域驗證儀表板 ---------- */
  app.get('/deliverability', async (c) => {
    const domain = c.env.MAIL_DOMAIN;
    const userId = c.var.user.id;
    const since = Date.now() - 30 * 86400_000;

    // DNS-over-HTTPS 查 TXT（SPF / DMARC）；查詢失敗回 null（區分「無法檢查」與「確實沒有」），不阻斷儀表板
    const dohTxt = async (name: string): Promise<string[] | null> => {
      try {
        const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=TXT`, {
          headers: { accept: 'application/dns-json' },
        });
        if (!res.ok) return null;
        const data = (await res.json()) as { Answer?: { data: string }[] };
        return (data.Answer ?? []).map((a) => a.data.replace(/^"|"$/g, '').replace(/"\s+"/g, ''));
      } catch {
        return null;
      }
    };

    const [spfRecs, dmarcRecs, sendStats] = await Promise.all([
      dohTxt(domain),
      dohTxt(`_dmarc.${domain}`),
      c.var.db.prepare(
        `SELECT status, external_state, last_error, COUNT(*) AS n FROM send_queue
         WHERE user_id = ? AND created_at > ? GROUP BY status, external_state, last_error`,
      )
        .bind(userId, since)
        .all<{ status: string; external_state: string | null; last_error: string | null; n: number }>(),
    ]);

    const spfRec = spfRecs?.find((r) => /v=spf1/i.test(r)) ?? null;
    const spfStatus = spfRecs === null ? 'unknown' : spfRec ? 'present' : 'absent';
    const dmarcRec = dmarcRecs?.find((r) => /v=DMARC1/i.test(r)) ?? null;
    const dmarcStatus = dmarcRecs === null ? 'unknown' : dmarcRec ? 'present' : 'absent';
    const dmarcPolicy = dmarcRec ? /\bp=([a-z]+)/i.exec(dmarcRec)?.[1]?.toLowerCase() ?? null : null;

    let sent = 0;
    let failed = 0;
    let review = 0;
    for (const r of sendStats.results) {
      if (r.status === 'sent') sent += r.n;
      else if (r.status === 'failed' && r.external_state === 'attempting' && r.last_error === 'external_uncertain') review += r.n;
      else if (r.status === 'failed') failed += r.n;
    }

    return c.json({
      domain,
      spf: { status: spfStatus, record: spfRec },
      dmarc: { status: dmarcStatus, policy: dmarcPolicy },
      dkim: { managed: true }, // Cloudflare Email Routing/Sending 出站自動 DKIM 簽署
      // 註：含站內直送，反映「寄送管線結果」而非純外部送達率
      outbound: { sent, failed, review, total: sent + failed + review, windowDays: 30 },
    });
  });

  /* ---------- 使用者設定（簽名檔 / 偏好） ---------- */
  app.get('/settings', async (c) => {
    const row = await c.var.db.prepare(`SELECT signature, prefs FROM user_settings WHERE user_id = ?`)
      .bind(c.var.user.id)
      .first<{ signature: string; prefs: string }>();
    return c.json({
      signature: row?.signature ?? '',
      prefs: JSON.parse(row?.prefs ?? '{}') as Record<string, unknown>,
    });
  });

  app.patch('/settings', async (c) => {
    const body = z
      .object({
        signature: z.string().max(2000).optional(),
        prefs: z.record(z.string(), z.unknown()).optional(),
      })
      .safeParse(await c.req.json());
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    // F9.1：控制不可逆刪除的 pref 必須是布林——字串 "false" 會被 SQL 的 != 0 當 truthy（SQLite 型別排序），拒收防歧義。
    if (body.data.prefs && 'purgeSpamTrash' in body.data.prefs && typeof body.data.prefs.purgeSpamTrash !== 'boolean') {
      return c.json({ error: 'bad_request' }, 400);
    }
    // F9.5：守門暗號必須是 4-32 字的字串或 null（清除）——太短會讓主旨誤含而放行陌生信。
    if (body.data.prefs && 'speakeasy' in body.data.prefs) {
      const v = body.data.prefs.speakeasy;
      if (v !== null && (typeof v !== 'string' || v.trim().length < 4 || v.trim().length > 32)) {
        return c.json({ error: 'bad_request' }, 400);
      }
    }
    // F14.1：外部 ICS 訂閱清單——≤5 條、每條 https 公開 URL（擋 SSRF）、label ≤60 字。
    if (body.data.prefs && 'icsSubscriptions' in body.data.prefs) {
      const subs = z
        .array(z.object({ url: z.string().url().max(2048), label: z.string().max(60).optional() }))
        .max(5)
        .safeParse(body.data.prefs.icsSubscriptions);
      if (!subs.success || subs.data.some((sfeed) => !isPublicHttpsUrl(sfeed.url))) {
        return c.json({ error: 'bad_request' }, 400);
      }
      // 正規化：只留 url + label，丟棄前端可能夾帶的 status 等欄位（狀態一律以 KV 快取為準）
      body.data.prefs.icsSubscriptions = subs.data.map((sfeed) => ({ url: sfeed.url, label: sfeed.label ?? '' }));
    }
    // F9.2：保留規則只收固定檔位（0=永久），杜絕字串/負數/危險短天數進入刪除路徑。
    if (body.data.prefs && 'retention' in body.data.prefs) {
      const r = z
        .object({ archive: z.union([z.literal(0), z.literal(30), z.literal(90), z.literal(365)]).optional(),
                  newsletter: z.union([z.literal(0), z.literal(30), z.literal(90), z.literal(365)]).optional() })
        .strict()
        .safeParse(body.data.prefs.retention);
      if (!r.success) return c.json({ error: 'bad_request' }, 400);
    }
    // F12.4：單一 SQL json_set 原子合併——取代舊的 SELECT→JS merge→覆寫（兩個並發 PATCH 不同 key 會互相蓋掉）。
    // 不用 json_patch（它會把 null 值剝除，speakeasy:null=清除語義會壞）；值以 json(?) 包裝防雙重編碼。
    const prefEntries = Object.entries(body.data.prefs ?? {});
    // 鍵名要拼進 JSON path 字面量，奇形鍵直接拒收（現有 prefs 鍵全是 camelCase）
    if (prefEntries.some(([k]) => !/^[A-Za-z0-9_-]{1,64}$/.test(k))) {
      return c.json({ error: 'bad_request' }, 400);
    }
    const setPairs = prefEntries.map(([k]) => `'$."${k}"', json(?)`).join(', ');
    await c.var.db.prepare(
      `INSERT INTO user_settings (user_id, signature, prefs, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         signature = ${body.data.signature !== undefined ? 'excluded.signature' : 'user_settings.signature'},
         prefs = ${prefEntries.length ? `json_set(user_settings.prefs, ${setPairs})` : 'user_settings.prefs'},
         updated_at = excluded.updated_at`,
    )
      .bind(
        c.var.user.id,
        body.data.signature ?? '',
        JSON.stringify(body.data.prefs ?? {}),
        Date.now(),
        // D1 正式環境拒收 undefined bind（本地 miniflare 不會炸，D1_TYPE_ERROR 只在線上出現）；
        // JSON 傳輸層理論上到不了 undefined，仍以 'null' 兜底。
        ...prefEntries.map(([, v]) => JSON.stringify(v) ?? 'null'),
      )
      .run();
    return c.json({ ok: true });
  });

  return app;
}
