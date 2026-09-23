// F12.3(a)：新裝置登入偵測。coarseUa 純函式（去版本號，降低誤報）；記錄 + 判定 + 通知全程 best-effort。
// 鐵則：偵測/通知絕不可阻斷或拖垮登入——呼叫端以 waitUntil 背景執行，且本檔所有函式吞掉自身錯誤。
import { notifyUser } from './notify';

/** UA → 粗粒度「瀏覽器 / OS」（去掉版本號）。瀏覽器小版本升級不會被當成新裝置。純函式，可測。 */
export function coarseUa(ua: string | null | undefined): string {
  if (!ua) return '未知裝置';
  let os = '未知系統';
  if (/iphone|ipad|ipod/i.test(ua)) os = 'iOS';
  else if (/android/i.test(ua)) os = 'Android';
  else if (/mac os x|macintosh/i.test(ua)) os = 'macOS';
  else if (/windows/i.test(ua)) os = 'Windows';
  else if (/cros/i.test(ua)) os = 'ChromeOS';
  else if (/linux/i.test(ua)) os = 'Linux';
  let br = '未知瀏覽器';
  // 順序重要：Edge/Opera 的 UA 也含 Chrome/Safari 字樣，須先判
  if (/edg\//i.test(ua)) br = 'Edge';
  else if (/opr\/|opera/i.test(ua)) br = 'Opera';
  else if (/firefox|fxios/i.test(ua)) br = 'Firefox';
  else if (/chrome|crios/i.test(ua)) br = 'Chrome';
  else if (/safari/i.test(ua)) br = 'Safari';
  return `${br} / ${os}`;
}

/**
 * 記錄本次登入裝置；回傳是否為「新裝置」（此使用者先前有其他裝置、但沒見過這台）。
 * 首次登入（此使用者第一台裝置）→ isNew=false（不對唯一裝置發警報）。
 * 全程吞錯：任何 DB 失敗回 { isNew:false }，絕不讓登入失敗。
 */
export async function recordDevice(env: Env, userId: string, ua: string | null): Promise<{ isNew: boolean; coarse: string }> {
  const coarse = coarseUa(ua);
  const now = Date.now();
  try {
    const existing = await env.DB.prepare(`SELECT 1 FROM known_devices WHERE user_id = ? AND ua_coarse = ?`)
      .bind(userId, coarse)
      .first();
    if (existing) {
      await env.DB.prepare(`UPDATE known_devices SET last_seen_at = ? WHERE user_id = ? AND ua_coarse = ?`)
        .bind(now, userId, coarse)
        .run();
      return { isNew: false, coarse };
    }
    // 未見過這台：先看使用者「本來有沒有其他裝置」→ 有才算新裝置警報（第一台不吵）
    const prior = await env.DB.prepare(`SELECT COUNT(*) AS n FROM known_devices WHERE user_id = ?`)
      .bind(userId)
      .first<{ n: number }>();
    await env.DB.prepare(
      `INSERT INTO known_devices (user_id, ua_coarse, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, ua_coarse) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
    )
      .bind(userId, coarse, now, now)
      .run();
    return { isNew: (prior?.n ?? 0) > 0, coarse };
  } catch {
    return { isNew: false, coarse }; // 診斷/安全輔助絕不反噬登入
  }
}

/** 記錄裝置，若判定為新裝置則推播提醒。全程吞錯——呼叫端用 waitUntil 背景跑。 */
export async function maybeNotifyNewDevice(env: Env, userId: string, ua: string | null): Promise<void> {
  try {
    const { isNew, coarse } = await recordDevice(env, userId, ua);
    if (!isNew) return;
    await notifyUser(env, userId, {
      type: 'security',
      push: {
        title: '🔐 新裝置登入',
        body: `你的帳號剛在新裝置登入：${coarse}。不是你的話請到設定撤銷該裝置並重設 TOTP。`,
        url: '/#settings',
      },
    });
  } catch {
    // 絕不阻斷登入
  }
}
