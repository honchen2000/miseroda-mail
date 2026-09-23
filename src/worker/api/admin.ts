import { Hono } from 'hono';
import { z } from 'zod';
import { audit } from '../lib/audit';
import { createInvite } from '../auth/invites';
import { createRecoveryToken } from '../auth/recovery';
import { newId } from '../lib/ids';
import { runBackup } from '../jobs/backup';
import { revokePushSubscriptionsForUser } from '../auth/sessions';
import { sanitizePasskeyName } from '../auth/webauthn';
import { getIp, getUa, isDomainEmail, requireAdmin, requireSession, type Vars } from './middleware';
import { edgeCacheDelete, edgeCacheKey } from '../lib/edgeCache';

/** 由救援連結綁定、未經第二因子確認的 passkey（credentials.recovery_bound，見 migration 0048）。
 *  name 是綁定者自訂字串（救援情境下＝任何拿到連結的人）→ 交給 admin 之前先消毒成單行。 */
async function recoveryBoundPasskeys(db: D1DatabaseSession, userId: string) {
  const rows = await db
    .prepare(`SELECT id, name, created_at FROM credentials WHERE user_id = ? AND recovery_bound = 1 ORDER BY created_at`)
    .bind(userId)
    .all<{ id: string; name: string | null; created_at: number }>();
  return rows.results.map((r) => ({ id: r.id, name: sanitizePasskeyName(r.name), createdAt: r.created_at }));
}

/** email 前綴：小寫英數開頭結尾，中間可含 . _ -（plus-tag 由系統折疊，不可註冊） */
const EMAIL_LOCAL_RE = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
/** 系統與 RFC 2142 保留地址 */
const RESERVED_LOCALS = new Set([
  'digest', 'noreply', 'no-reply', 'postmaster', 'mailer-daemon', 'abuse',
  'hostmaster', 'webmaster', 'bounce', 'bounces', 'root',
]);

export function adminRoutes() {
  const app = new Hono<{ Bindings: Env; Variables: Vars }>();
  app.use('*', requireSession, requireAdmin);

  /* ---------- 邀請 ---------- */
  app.post('/invites', async (c) => {
    const body = z
      .object({ email: z.string().email(), role: z.enum(['user', 'admin']).default('user') })
      .safeParse(await c.req.json());
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    const email = body.data.email.toLowerCase();
    if (!isDomainEmail(c.env, email)) return c.json({ error: 'email_not_in_domain' }, 400);

    const existingUser = await c.var.db.prepare(`SELECT id FROM users WHERE email = ?`).bind(email).first();
    if (existingUser) return c.json({ error: 'user_exists' }, 409);
    const pending = await c.var.db.prepare(
      `SELECT id FROM invites WHERE email = ? AND used_at IS NULL AND expires_at > ?`,
    )
      .bind(email, Date.now())
      .first();
    if (pending) return c.json({ error: 'invite_pending' }, 409);

    const invite = await createInvite(c.env, { email, role: body.data.role, invitedBy: c.var.user.id });
    await audit(c.var.db, {
      userId: c.var.user.id,
      action: 'admin.invite.create',
      targetType: 'invite',
      targetId: invite.id,
      ip: getIp(c),
      userAgent: getUa(c),
      meta: { email, role: body.data.role },
    });
    // 明碼只在此回應出現一次
    return c.json({ id: invite.id, code: invite.code, email, role: body.data.role, expiresAt: invite.expiresAt });
  });

  app.get('/invites', async (c) => {
    const rows = await c.var.db.prepare(
      `SELECT id, email, role, invited_by, created_at, expires_at FROM invites
       WHERE used_at IS NULL AND expires_at > ? ORDER BY created_at DESC`,
    )
      .bind(Date.now())
      .all();
    return c.json({ invites: rows.results });
  });

  app.delete('/invites/:id', async (c) => {
    const res = await c.var.db.prepare(`DELETE FROM invites WHERE id = ? AND used_at IS NULL`)
      .bind(c.req.param('id'))
      .run();
    if (!(res.meta.changes ?? 0)) return c.json({ error: 'not_found' }, 404);
    await audit(c.var.db, {
      userId: c.var.user.id,
      action: 'admin.invite.revoke',
      targetType: 'invite',
      targetId: c.req.param('id'),
      ip: getIp(c),
      userAgent: getUa(c),
    });
    return c.json({ ok: true });
  });

  /* ---------- 使用者 ---------- */
  app.get('/users', async (c) => {
    const users = await c.var.db.prepare(
      `SELECT u.id, u.email, u.display_name, u.role, u.status, u.created_at, u.last_login_at,
              (SELECT COUNT(*) FROM credentials cr WHERE cr.user_id = u.id) AS passkeys,
              (SELECT COUNT(*) FROM credentials cr WHERE cr.user_id = u.id AND cr.backed_up = 1) AS synced_passkeys,
              (SELECT enabled FROM totp_secrets t WHERE t.user_id = u.id) AS totp
       FROM users u ORDER BY u.created_at`,
    ).all();
    return c.json({ users: users.results });
  });

  /* ---------- 核發 passkey 救援連結（使用者失去所有 passkey 時用） ---------- */
  app.post('/users/:id/recovery', async (c) => {
    const targetId = c.req.param('id');
    const target = await c.var.db.prepare(`SELECT id, email FROM users WHERE id = ? AND status = 'active'`)
      .bind(targetId)
      .first<{ id: string; email: string }>();
    if (!target) return c.json({ error: 'not_found' }, 404);
    // 安全閘門：救援只「新增 passkey、不發 session」，安全性靠登入時仍需既有 TOTP。
    // 但尚未啟用 TOTP 的帳號登入會走免 TOTP 快路徑 → 光憑救援 token 就能接管。
    // 因此只對「已啟用 TOTP」的帳號核發救援（沒第二因子者請改用停用→刪除→重新邀請）。
    const totp = await c.var.db.prepare(`SELECT enabled FROM totp_secrets WHERE user_id = ?`)
      .bind(target.id)
      .first<{ enabled: number }>();
    if (!totp?.enabled) return c.json({ error: 'totp_not_enabled' }, 409);
    const { token, expiresAt } = await createRecoveryToken(c.env, { userId: target.id, createdBy: c.var.user.id });
    await audit(c.var.db, {
      userId: c.var.user.id,
      action: 'admin.recovery.issue',
      targetType: 'user',
      targetId: target.id,
      ip: getIp(c),
      userAgent: getUa(c),
      meta: { email: target.email },
    });
    // 明碼 token / 連結只在此回應出現一次；admin 站外（如 LINE）轉交使用者
    return c.json({ token, email: target.email, expiresAt, url: `${c.env.ORIGIN.split(',')[0]}/#recover=${token}` });
  });

  /* ---------- 重設使用者 TOTP（解「passkey 救援後仍卡 TOTP、且驗證器/備援碼都遺失」的死鎖） ----------
     刪 TOTP 種子 + 清備援碼 + 撤信任裝置 + 撤所有現有 session。
     重設後該帳號 passkey 登入走「免 TOTP 快路徑」(auth.ts /login/verify totpSetupRequired)，
     前端強制導去重新設定 TOTP。安全要點：
     - 先撤 session/trusted_devices 再刪 TOTP（同一 batch 原子）→ 不留任何已發 session 在「無第二因子暫態」接管。
     - 重設後帳號變「無 TOTP」→ /recover 的 totp_not_enabled 閘門會擋下救援 token，不會疊加被接管。
     - 不能對自己做（避免誤把 admin 自己降級為 passkey-only）。
     - **救援綁定的 passkey 必須逐一承認**：救援只加 passkey、不發 session，安全性全靠「登入仍需既有 TOTP」；
       這個重設正是把那道保險拆掉，於是每一把救援綁定的 passkey 都立刻能免 TOTP 登入並自行重設 TOTP＝完整接管。
       伺服器分不出「本人綁的」與「攔截救援連結者綁的」——兩者送出的請求一模一樣，差別只在 admin 的線下認知，
       所以只能把這個判斷交還給 admin：未帶 acknowledgeRecoveryPasskeys 涵蓋現存清單時回 409＋清單，零寫入。
       （不能改成「連同 credentials 一起刪」：TOTP 已被刪，/users/:id/recovery 的 totp_not_enabled 會擋下新的救援連結，
       本人就再也回不來，只剩「停用→刪除→重邀」這條會清空整個信箱的路——違反「絕不把使用者鎖在外面」。） */
  app.post('/users/:id/totp/reset', async (c) => {
    const targetId = c.req.param('id');
    if (targetId === c.var.user.id) return c.json({ error: 'cannot_modify_self' }, 400);
    const body = z
      .object({ acknowledgeRecoveryPasskeys: z.array(z.string().min(1)).max(100).optional() })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    const target = await c.var.db.prepare(`SELECT id, email, role FROM users WHERE id = ? AND status = 'active'`)
      .bind(targetId)
      .first<{ id: string; email: string; role: string }>();
    if (!target) return c.json({ error: 'not_found' }, 404);
    // 後端比照前端：只重設一般使用者的 TOTP，不碰 admin 帳號（防 API 直呼弱化他人 admin 第二因子）。
    if (target.role === 'admin') return c.json({ error: 'cannot_reset_admin' }, 403);

    // 承認閘門：清單以伺服器手上的現況為準（多送的 id 無效果，少一把就擋下）。此處零寫入。
    const acknowledged = body.data.acknowledgeRecoveryPasskeys ?? [];
    const ackJson = JSON.stringify(acknowledged);
    const bound = await recoveryBoundPasskeys(c.var.db, target.id);
    if (bound.some((p) => !acknowledged.includes(p.id))) {
      return c.json({ error: 'recovery_passkeys_unconfirmed', passkeys: bound }, 409);
    }

    // 競態守門：上面查完之後、這批寫入之前，若又有救援綁定進來（攻擊者手上還有未用的 token），
    // 四條全部不生效（同一 batch＝同一交易、同一快照）→ 事後重查如實回 409，不會留下半套重設。
    const guard = `NOT EXISTS (SELECT 1 FROM credentials c
       WHERE c.user_id = ? AND c.recovery_bound = 1 AND c.id NOT IN (SELECT value FROM json_each(?)))`;
    const now = Date.now();
    await c.var.db.batch([
      c.var.db.prepare(`UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND ${guard}`)
        .bind(now, target.id, target.id, ackJson),
      // F5：session 全撤＝所有裝置取消授權 → push 訂閱一併刪除（含 0049 之前未綁 session 的舊列），
      // 否則那些瀏覽器仍會收到每封新信的寄件者＋主旨。放進同一 batch 帶同一 guard：
      // 重設沒生效時（競態被擋下、回 409）就一列都不刪，不會誤斷仍登入中裝置的通知。
      c.var.db.prepare(`DELETE FROM push_subscriptions WHERE user_id = ? AND ${guard}`).bind(target.id, target.id, ackJson),
      c.var.db.prepare(`DELETE FROM trusted_devices WHERE user_id = ? AND ${guard}`).bind(target.id, target.id, ackJson),
      c.var.db.prepare(`DELETE FROM backup_codes WHERE user_id = ? AND ${guard}`).bind(target.id, target.id, ackJson),
      c.var.db.prepare(`DELETE FROM totp_secrets WHERE user_id = ? AND ${guard}`).bind(target.id, target.id, ackJson),
    ]);
    const after = await recoveryBoundPasskeys(c.var.db, target.id);
    if (after.some((p) => !acknowledged.includes(p.id))) {
      return c.json({ error: 'recovery_passkeys_unconfirmed', passkeys: after }, 409);
    }

    await audit(c.var.db, {
      userId: c.var.user.id,
      action: 'admin.totp.reset',
      targetType: 'user',
      targetId: target.id,
      ip: getIp(c),
      userAgent: getUa(c),
      // 承認了哪幾把救援綁定 passkey 一併入帳：事後回溯「重設當下誰能免 TOTP 登入」的唯一依據
      meta: { email: target.email, ...(bound.length ? { acknowledgedRecoveryPasskeys: bound.map((p) => p.id) } : {}) },
    });
    return c.json({ ok: true, email: target.email });
  });

  /* ---------- 乾淨網域別名（admin 指派給使用者） ---------- */
  const RESERVED_ALIAS = new Set(['postmaster', 'noreply', 'no-reply', 'mailer-daemon', 'abuse', 'digest']);

  app.get('/aliases', async (c) => {
    const rows = await c.var.db.prepare(
      `SELECT a.id, a.address, a.name, a.user_id, u.email AS owner_email, a.created_at
       FROM aliases a JOIN users u ON u.id = a.user_id ORDER BY a.created_at DESC`,
    ).all<{ id: string; address: string; name: string | null; user_id: string; owner_email: string; created_at: number }>();
    return c.json({ aliases: rows.results });
  });

  app.post('/aliases', async (c) => {
    const body = z
      .object({
        userId: z.string().min(1),
        address: z.string().email().max(254),
        name: z.string().trim().max(80).optional(),
      })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    const address = body.data.address.trim().toLowerCase();
    // 必須是本網域、prefix 安全字元、無 +tag（別名是 base 地址；+tag 於寄送時套用）。
    const m = /^([a-z0-9._-]+)@([^@\s]+)$/.exec(address);
    if (!m || m[2] !== c.env.MAIL_DOMAIN.toLowerCase()) return c.json({ error: 'bad_address' }, 400);
    if (RESERVED_ALIAS.has(m[1])) return c.json({ error: 'address_reserved' }, 400);
    // 不可撞既有使用者 email、不可撞既有別名（UNIQUE 也擋，但回友善錯誤）。
    if (await c.var.db.prepare(`SELECT id FROM users WHERE email = ?`).bind(address).first())
      return c.json({ error: 'address_is_user' }, 400);
    if (await c.var.db.prepare(`SELECT id FROM aliases WHERE address = ?`).bind(address).first())
      return c.json({ error: 'address_taken' }, 400);
    const target = await c.var.db.prepare(`SELECT id FROM users WHERE id = ? AND status = 'active'`)
      .bind(body.data.userId)
      .first();
    if (!target) return c.json({ error: 'user_not_found' }, 404);

    const id = newId('alias');
    await c.var.db.prepare(
      `INSERT INTO aliases (id, user_id, address, name, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, body.data.userId, address, body.data.name ?? null, c.var.user.id, Date.now())
      .run();
    await audit(c.var.db, {
      userId: c.var.user.id,
      action: 'admin.alias.create',
      targetType: 'user',
      targetId: body.data.userId,
      ip: getIp(c),
      userAgent: getUa(c),
      meta: { address },
    });
    return c.json({ id });
  });

  app.delete('/aliases/:id', async (c) => {
    const res = await c.var.db.prepare(`DELETE FROM aliases WHERE id = ?`).bind(c.req.param('id')).run();
    if (!(res.meta.changes ?? 0)) return c.json({ error: 'not_found' }, 404);
    await audit(c.var.db, {
      userId: c.var.user.id,
      action: 'admin.alias.delete',
      ip: getIp(c),
      userAgent: getUa(c),
      meta: { id: c.req.param('id') },
    });
    return c.json({ ok: true });
  });

  app.patch('/users/:id', async (c) => {
    const body = z
      .object({
        status: z.enum(['active', 'disabled']).optional(),
        emailLocal: z.string().trim().toLowerCase().optional(),
        displayName: z.string().trim().min(1).max(40).optional(),
      })
      .refine((b) => b.status !== undefined || b.emailLocal !== undefined || b.displayName !== undefined)
      .safeParse(await c.req.json());
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    const targetId = c.req.param('id');
    const target = await c.var.db.prepare(`SELECT id, email, display_name FROM users WHERE id = ?`)
      .bind(targetId)
      .first<{ id: string; email: string; display_name: string }>();
    if (!target) return c.json({ error: 'not_found' }, 404);

    /* 啟用/停用（不能對自己做） */
    if (body.data.status !== undefined) {
      if (targetId === c.var.user.id) return c.json({ error: 'cannot_modify_self' }, 400);
      await c.var.db.prepare(`UPDATE users SET status = ? WHERE id = ?`).bind(body.data.status, targetId).run();
      if (body.data.status === 'disabled') {
        await c.var.db.prepare(`UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`)
          .bind(Date.now(), targetId)
          .run();
        // 信任裝置一併作廢：重新啟用後必須重走 TOTP
        await c.var.db.prepare(`DELETE FROM trusted_devices WHERE user_id = ?`).bind(targetId).run();
        // F5：所有裝置都被取消授權 → push 訂閱一併刪除，否則停用後那些瀏覽器仍會收到新信的寄件者＋主旨。
        await revokePushSubscriptionsForUser(c.env, targetId);
      }
      await audit(c.var.db, {
        userId: c.var.user.id,
        action: `admin.user.${body.data.status === 'disabled' ? 'disable' : 'enable'}`,
        targetType: 'user',
        targetId,
        ip: getIp(c),
        userAgent: getUa(c),
      });
    }

    /* email 前綴變更（admin 可改任何人，含自己） */
    if (body.data.emailLocal !== undefined) {
      const local = body.data.emailLocal;
      if (!EMAIL_LOCAL_RE.test(local)) return c.json({ error: 'bad_email_local' }, 400);
      if (RESERVED_LOCALS.has(local)) return c.json({ error: 'reserved_email_local' }, 400);
      const email = `${local}@${c.env.MAIL_DOMAIN}`;
      if (email !== target.email) {
        const taken = await c.var.db.prepare(`SELECT id FROM users WHERE email = ? AND id != ?`)
          .bind(email, targetId)
          .first();
        if (taken) return c.json({ error: 'email_taken' }, 409);
        const pending = await c.var.db.prepare(
          `SELECT id FROM invites WHERE email = ? AND used_at IS NULL AND expires_at > ?`,
        )
          .bind(email, Date.now())
          .first();
        if (pending) return c.json({ error: 'invite_pending' }, 409);
        await c.var.db.prepare(`UPDATE users SET email = ? WHERE id = ?`).bind(email, targetId).run();
        await audit(c.var.db, {
          userId: c.var.user.id,
          action: 'admin.user.update',
          targetType: 'user',
          targetId,
          ip: getIp(c),
          userAgent: getUa(c),
          meta: { field: 'email', from: target.email, to: email },
        });
      }
    }

    /* 顯示名稱 */
    if (body.data.displayName !== undefined && body.data.displayName !== target.display_name) {
      await c.var.db.prepare(`UPDATE users SET display_name = ? WHERE id = ?`)
        .bind(body.data.displayName, targetId)
        .run();
      await audit(c.var.db, {
        userId: c.var.user.id,
        action: 'admin.user.update',
        targetType: 'user',
        targetId,
        ip: getIp(c),
        userAgent: getUa(c),
        meta: { field: 'displayName', from: target.display_name, to: body.data.displayName },
      });
    }
    return c.json({ ok: true });
  });

  /* 刪除前的用量預覽（確認 Modal 顯示用） */
  app.get('/users/:id/usage', async (c) => {
    const targetId = c.req.param('id');
    const target = await c.var.db.prepare(`SELECT id FROM users WHERE id = ?`).bind(targetId).first();
    if (!target) return c.json({ error: 'not_found' }, 404);
    const [msgs, atts] = await Promise.all([
      c.var.db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE user_id = ?`).bind(targetId).first<{ n: number }>(),
      c.var.db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(size_bytes),0) AS bytes FROM attachments WHERE user_id = ?`)
        .bind(targetId)
        .first<{ n: number; bytes: number }>(),
    ]);
    return c.json({ messages: msgs?.n ?? 0, attachments: atts?.n ?? 0, attachmentBytes: atts?.bytes ?? 0 });
  });

  /* 永久刪除帳號：限「停用中」且非自己（操作者必為 admin，故系統永遠至少剩一位 admin） */
  app.delete('/users/:id', async (c) => {
    const targetId = c.req.param('id');
    if (targetId === c.var.user.id) return c.json({ error: 'cannot_delete_self' }, 400);
    const target = await c.var.db.prepare(`SELECT id, email, status FROM users WHERE id = ?`)
      .bind(targetId)
      .first<{ id: string; email: string; status: string }>();
    if (!target) return c.json({ error: 'not_found' }, 404);
    if (target.status !== 'disabled') return c.json({ error: 'must_disable_first' }, 400);

    const [msgs, atts] = await Promise.all([
      c.var.db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE user_id = ?`).bind(targetId).first<{ n: number }>(),
      c.var.db.prepare(`SELECT COUNT(*) AS n FROM attachments WHERE user_id = ?`).bind(targetId).first<{ n: number }>(),
    ]);

    // R2：各類前綴批次清除（list 1000/輪）
    for (const prefix of ['raw/', 'html/', 'att/', 'upload/', 'avatar/', 'share/']) {
      let cursor: string | undefined;
      do {
        const listed = await c.env.MAIL_STORE.list({ prefix: `${prefix}${targetId}/`, cursor, limit: 1000 });
        if (listed.objects.length) await c.env.MAIL_STORE.delete(listed.objects.map((o) => o.key));
        cursor = listed.truncated ? listed.cursor : undefined;
      } while (cursor);
    }

    // FTS 庫：索引 + 對照表
    await c.env.DB_FTS.prepare(
      `DELETE FROM messages_fts WHERE rowid IN (SELECT fts_rowid FROM msg_map WHERE user_id = ?)`,
    )
      .bind(targetId)
      .run();
    await c.env.DB_FTS.prepare(`DELETE FROM msg_map WHERE user_id = ?`).bind(targetId).run();

    // 主庫：一個 batch 內全鏈清除（audit_log 刻意保留 — 治理紀錄不留空洞）
    const byUser = (table: string) => c.var.db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).bind(targetId);
    await c.var.db.batch([
      c.var.db.prepare(
        `DELETE FROM message_labels WHERE message_id IN (SELECT id FROM messages WHERE user_id = ?)`,
      ).bind(targetId),
      byUser('attachments'),
      byUser('messages'),
      byUser('threads'),
      byUser('labels'),
      byUser('rules'),
      byUser('drafts'),
      byUser('send_queue'),
      byUser('sessions'),
      byUser('credentials'),
      byUser('totp_secrets'),
      byUser('backup_codes'),
      byUser('user_settings'),
      byUser('contacts'),
      byUser('push_subscriptions'),
      byUser('trusted_devices'),
      byUser('challenges'),
      byUser('follow_ups'),
      byUser('recovery_tokens'),
      byUser('aliases'),
      byUser('saved_searches'),
      byUser('shared_files'),
      byUser('thread_notes'),
      byUser('message_reactions'),
      byUser('cal_feed_tokens'),
      c.var.db.prepare(`DELETE FROM users WHERE id = ?`).bind(targetId),
    ]);

    await audit(c.var.db, {
      userId: c.var.user.id,
      action: 'admin.user.delete',
      targetType: 'user',
      targetId,
      ip: getIp(c),
      userAgent: getUa(c),
      meta: { email: target.email, messages: msgs?.n ?? 0, attachments: atts?.n ?? 0 },
    });
    return c.json({ ok: true, deleted: { email: target.email, messages: msgs?.n ?? 0, attachments: atts?.n ?? 0 } });
  });

  /* ---------- 系統用量統計 ---------- */
  app.get('/stats', async (c) => {
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const [users, msgs, sends, storage] = await Promise.all([
      c.var.db.prepare(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active FROM users`,
      ).first<{ total: number; active: number }>(),
      c.var.db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(size_bytes), 0) AS bytes FROM messages`).first<{
        n: number;
        bytes: number;
      }>(),
      c.var.db.prepare(`SELECT COUNT(*) AS n FROM send_queue WHERE status = 'sent' AND sent_at >= ?`)
        .bind(monthStart.getTime())
        .first<{ n: number }>(),
      c.var.db.prepare(`SELECT COALESCE(SUM(size_bytes), 0) AS bytes FROM attachments`).first<{ bytes: number }>(),
    ]);
    const failed = await c.var.db.prepare(`SELECT COUNT(*) AS n FROM send_queue WHERE status = 'failed'`).first<{
      n: number;
    }>();
    return c.json({
      users: { total: users?.total ?? 0, active: users?.active ?? 0 },
      messages: { total: msgs?.n ?? 0 },
      sentThisMonth: sends?.n ?? 0,
      failedSends: failed?.n ?? 0,
      // Email Service 內含額度（Workers Paid）；用量超額 $0.35/千封
      monthlyQuota: 3000,
      storageBytes: (msgs?.bytes ?? 0) + (storage?.bytes ?? 0),
    });
  });

  /* ---------- FTS 重建（分批；FTS 庫可拋棄重建的保證） ---------- */
  /* ---------- F12.1：備份手動觸發（演練用）+ 狀態檢視 ---------- */
  app.post('/backup/run', async (c) => {
    const r = await runBackup(c.env);
    await audit(c.var.db, { userId: c.var.user.id, action: 'admin.backup.run', meta: { ranToday: !!r } });
    return c.json(r ? { ok: true, ...r } : { ok: true, skipped: 'already_done_today' });
  });

  app.get('/backup/status', async (c) => {
    // 只列 day 目錄 + manifest 摘要（最近 12 個）
    const days = new Map<string, number>();
    let cursor: string | undefined;
    do {
      const listed = await c.env.MAIL_STORE.list({ prefix: 'backup/', cursor, limit: 1000 });
      for (const o of listed.objects) {
        const m = /^backup\/(\d{4}-\d{2}-\d{2})\//.exec(o.key);
        if (m) days.set(m[1], (days.get(m[1]) ?? 0) + 1);
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
    const sorted = [...days.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, 12);
    return c.json({ backups: sorted.map(([day, objects]) => ({ day, objects })) });
  });

  app.post('/fts/rebuild', async (c) => {
    const body = z.object({ cursor: z.string().nullable().optional() }).safeParse(await c.req.json());
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    const BATCH = 50;
    const rows = await c.var.db.prepare(
      `SELECT id, user_id, subject, from_addr, from_name, snippet, r2_html_key FROM messages
       WHERE id > ? ORDER BY id LIMIT ?`,
    )
      .bind(body.data.cursor ?? '', BATCH)
      .all<{ id: string; user_id: string; subject: string; from_addr: string; from_name: string; snippet: string; r2_html_key: string | null }>();

    const { htmlToText } = await import('../email/sanitize');
    for (const m of rows.results) {
      let bodyText = m.snippet;
      if (m.r2_html_key) {
        const obj = await c.env.MAIL_STORE.get(m.r2_html_key);
        if (obj) bodyText = (await htmlToText(await obj.text())).slice(0, 100_000);
      }
      await c.env.DB_FTS.prepare(`INSERT OR IGNORE INTO msg_map (message_id, user_id) VALUES (?, ?)`)
        .bind(m.id, m.user_id)
        .run();
      const mapRow = await c.env.DB_FTS.prepare(`SELECT fts_rowid FROM msg_map WHERE message_id = ?`)
        .bind(m.id)
        .first<{ fts_rowid: number }>();
      if (mapRow) {
        await c.env.DB_FTS.prepare(
          `INSERT OR REPLACE INTO messages_fts (rowid, subject, from_addr, snippet, body_text) VALUES (?, ?, ?, ?, ?)`,
        )
          .bind(mapRow.fts_rowid, m.subject, `${m.from_name} ${m.from_addr}`, m.snippet, bodyText)
          .run();
      }
    }
    const nextCursor = rows.results.length === BATCH ? rows.results[rows.results.length - 1].id : null;
    await audit(c.var.db, {
      userId: c.var.user.id,
      action: 'admin.fts.rebuild',
      meta: { processed: rows.results.length, nextCursor },
    });
    return c.json({ processed: rows.results.length, nextCursor });
  });

  /* ---------- 維護：用最新解析/消毒器重跑既有 inbound 信 ----------
   * 修 from_addr（取 From 標頭，非信封 VERP 退信位址）+ 重渲染 HTML（保留安全 inline style）。
   * 從 R2 原始 .eml 重解析，不重跑 rules/vacation/notify（無副作用）。游標分頁，同 /fts/rebuild。 */
  app.post('/messages/resanitize', async (c) => {
    const body = z.object({ cursor: z.string().nullable().optional() }).safeParse(await c.req.json());
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    const BATCH = 25;
    const rows = await c.var.db.prepare(
      `SELECT id, user_id, from_addr FROM messages
       WHERE direction = 'inbound' AND r2_raw_key IS NOT NULL AND id > ? ORDER BY id LIMIT ?`,
    )
      .bind(body.data.cursor ?? '', BATCH)
      .all<{ id: string; user_id: string; from_addr: string }>();

    const PostalMime = (await import('postal-mime')).default;
    const { sanitizeEmailHtml, textToHtml } = await import('../email/sanitize');
    const { r2RawKey, r2HtmlKey } = await import('../lib/keys');
    const { categorizeMessage } = await import('../email/categorize');
    const { parseListUnsubscribe } = await import('../email/list-unsubscribe');
    const { parseAuthVerdict } = await import('../email/authVerdict');

    let fixedFrom = 0;
    let resanitized = 0;
    for (const m of rows.results) {
      const rawObj = await c.env.MAIL_STORE.get(r2RawKey(m.user_id, m.id));
      if (!rawObj) continue;
      const parsed = await PostalMime.parse(await rawObj.arrayBuffer());

      const headerFrom = parsed.from?.address?.toLowerCase();
      if (headerFrom && headerFrom !== m.from_addr) {
        await c.var.db.prepare(`UPDATE messages SET from_addr = ? WHERE id = ?`).bind(headerFrom, m.id).run();
        fixedFrom++;
      }

      const atts = await c.var.db.prepare(`SELECT id, content_id FROM attachments WHERE message_id = ?`)
        .bind(m.id)
        .all<{ id: string; content_id: string | null }>();
      const cidMap = new Map<string, string>();
      for (const a of atts.results) {
        if (a.content_id) cidMap.set(a.content_id.replace(/[<>]/g, ''), `/api/v1/attachments/${a.id}/inline`);
      }
      const sourceHtml = parsed.html ?? textToHtml(parsed.text ?? '');
      const { html, hasRemoteImages } = await sanitizeEmailHtml(sourceHtml, cidMap);
      const htmlKey = r2HtmlKey(m.user_id, m.id);
      await c.env.MAIL_STORE.put(htmlKey, html, {
        httpMetadata: { contentType: 'text/html; charset=utf-8' },
      });
      // best-effort 清邊緣快取（lib/edgeCache.ts）：這一步覆寫的正是「同一個 r2_html_key」，
      // 是 html 快取不能當真正 immutable 處理的原因。cache.delete() 只清得到「處理這個 admin
      // 請求的當下這個 colo」——使用者散落在其他 colo 的舊快取項目完全不受影響，不是全球撤回；
      // 真正的全域撤回要靠 edgeCache.ts 的 HTML_CACHE_VER（改數字重新部署）。這裡只是聊勝於無。
      await edgeCacheDelete(edgeCacheKey('html', htmlKey));
      // 順手回填收件匣分類（既有信原為 NULL=primary）
      const hdr = (k: string): string | null => (parsed.headers ?? []).find((h) => h.key === k)?.value ?? null;
      const unsub = parseListUnsubscribe(hdr('list-unsubscribe'), hdr('list-unsubscribe-post'));
      const category = categorizeMessage({
        fromAddr: headerFrom || m.from_addr,
        subject: parsed.subject ?? '',
        hasListUnsubscribe: !!unsub,
        listId: hdr('list-id'),
        precedence: hdr('precedence'),
        autoSubmitted: hdr('auto-submitted'),
      });
      // 回填寄件者信任卡：從 raw .eml 取最上方（最新一跳＝邊界 MTA）的 Authentication-Results 重算 verdict。
      // 只取第一筆（非合併全部）——同 ingest 的防偽造立場：寄件者在信體內塞的第二份 A-R 在更下方、不採信。
      // 用 COALESCE：raw 缺 A-R 標頭（CF 有時只在 runtime 加）時保留既有值，不把 ingest 當下抓到的 verdict 抹成 NULL。
      const arHeader = (parsed.headers ?? []).find((h) => h.key === 'authentication-results')?.value ?? '';
      const av = parseAuthVerdict(arHeader.toLowerCase());
      await c.var.db.prepare(
        `UPDATE messages SET r2_html_key = ?, remote_images = ?, category = ?, auth_verdict = COALESCE(?, auth_verdict) WHERE id = ?`,
      )
        .bind(htmlKey, hasRemoteImages ? 1 : 0, category, av ? JSON.stringify(av) : null, m.id)
        .run();
      resanitized++;
    }

    const nextCursor = rows.results.length === BATCH ? rows.results[rows.results.length - 1].id : null;
    await audit(c.var.db, {
      userId: c.var.user.id,
      action: 'admin.messages.resanitize',
      ip: getIp(c),
      userAgent: getUa(c),
      meta: { processed: rows.results.length, fixedFrom, resanitized, nextCursor },
    });
    return c.json({ processed: rows.results.length, fixedFrom, resanitized, nextCursor });
  });

  /* ---------- 稽核日誌 ---------- */
  app.get('/audit-log', async (c) => {
    const limit = Math.min(Number(c.req.query('limit') ?? 100), 200);
    const rows = await c.var.db.prepare(
      `SELECT a.id, a.user_id, u.email AS user_email, a.action, a.target_type, a.target_id, a.ip, a.meta, a.created_at
       FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
       ORDER BY a.created_at DESC LIMIT ?`,
    )
      .bind(limit)
      .all();
    return c.json({ entries: rows.results });
  });

  /* ---------- F12.2：系統健康——錯誤 ring buffer 檢視 ---------- */
  app.get('/errors', async (c) => {
    const limit = Math.max(1, Math.min(Number(c.req.query('limit')) || 100, 200)); // NaN/負數/越界防護

    const [recent, byScope] = await Promise.all([
      c.var.db.prepare(`SELECT id, scope, message, meta, created_at FROM error_log ORDER BY created_at DESC LIMIT ?`)
        .bind(limit)
        .all(),
      // 近 7 天各 scope 聚合（哪類錯誤在燒）
      c.var.db.prepare(
        `SELECT scope, COUNT(*) AS n, MAX(created_at) AS last_at FROM error_log
         WHERE created_at > ? GROUP BY scope ORDER BY n DESC LIMIT 30`,
      )
        .bind(Date.now() - 7 * 86400_000)
        .all(),
    ]);
    return c.json({ recent: recent.results, byScope: byScope.results });
  });

  return app;
}
