import path from 'node:path';
import { readD1Migrations } from '@cloudflare/vitest-pool-workers/config';

const ROOT = path.resolve(__dirname, '..');

// 物理阻斷真 Workers AI（LESSONS L5）：wrangler.jsonc 的 ai binding 在 vpw 裡會被接到 wrangler 的外部 AI worker，
// 用本機 Cloudflare 登入真打遠端推論（計費＋0.6～2s 網路延遲，ingest e2e 曾因此撞 5s 逾時）。
// 這裡用同名 wrappedBinding 蓋掉它（miniflare 的 mergeWorkerOptions 是 Object.assign，使用者設定勝出），
// 預設的 env.AI.run 一律 throw——正式碼的 AI 呼叫點全有 try/catch，等同「AI 失敗」的既有降級路徑。
// 要測 AI 行為的測試照舊注入 {...env, AI: stub}（spread 覆蓋，不經過這個 binding）。
// 注意：vpw 開場的「Workers AI … incur usage charges」警告仍會印（它在合併前檢查 wrangler 設定），已無實際意義。
//
// 被換下來的 wrangler 外部 AI worker 仍在 workers 清單裡（無法移除、也不能同名覆蓋——miniflare 同名直接報錯），
// 它 import 的 cloudflare-internal:ai-api 只准以 wrapped binding 載入，當一般 worker 會讓 workerd 起不來。
// → 收容在一個沒人綁定、沒有路由的 sink worker 上：載入得了，但測試碼沒有任何路徑碰得到它。
// 名稱是 wrangler 內部命名（EXTERNAL_AI_WORKER_NAME + ':' + wrangler.jsonc 的 name）；
// 哪天 wrangler 改名或改成別的接法，miniflare 會在啟動時直接報錯（fail-closed），金絲雀 ai-blocked.test.ts 也會紅。
const WRANGLER_AI_WORKER = '__WRANGLER_EXTERNAL_AI_WORKER:miseroda-mail';
const AI_SINK_WORKER = 'test-ai-sink';
const AI_BLOCKED_WORKER = 'test-ai-blocked';
// stub 原始碼保持純 ASCII：miniflare 把字串 contents 當 latin1 讀，中文會變亂碼（實測）
const AI_BLOCKED_SCRIPT = `
export default function () {
  return {
    async run(model) {
      const msg = '[test] real Workers AI is blocked in tests (test/vitest.base.ts); inject {...env, AI: stub} to test AI behaviour';
      console.warn(msg + ' model=' + String(model));
      throw new Error(msg);
    },
  };
}
`;

/**
 * 共用 workers pool 設定。
 * isolatedStorage:false 的 project 專供 DO WebSocket 測試 ——
 * miniflare 無法在開過 WS 的 DO 上完成 isolated storage 回收（上游限制）。
 */
export async function workersTestConfig(opts: { name: string; include: string[]; isolatedStorage: boolean }) {
  const mainMigrations = await readD1Migrations(path.join(ROOT, 'migrations/main'));
  const ftsMigrations = await readD1Migrations(path.join(ROOT, 'migrations/fts'));

  return {
    resolve: {
      // @peculiar/*（@simplewebauthn 依賴）以 named import 載入 tslib；
      // tslib 的預設入口是 CJS UMD，在 workerd 的嚴格 ESM 下沒有 default/named export
      alias: { tslib: 'tslib/tslib.es6.js' },
    },
    test: {
      name: opts.name,
      include: opts.include,
      globalSetup: [path.join(ROOT, 'test/global-setup.ts')],
      setupFiles: [path.join(ROOT, 'test/apply-migrations.ts')],
      poolOptions: {
        workers: {
          isolatedStorage: opts.isolatedStorage,
          singleWorker: !opts.isolatedStorage,
          wrangler: { configPath: path.join(ROOT, 'wrangler.jsonc') },
          miniflare: {
            bindings: {
              TEST_MAIN_MIGRATIONS: mainMigrations,
              TEST_FTS_MIGRATIONS: ftsMigrations,
              // 測試用 secrets（正式環境走 wrangler secret）
              TOTP_ENC_KEY: 'dGVzdC1rZXktdGVzdC1rZXktdGVzdC1rZXktdGVzdCE=',
              BOOTSTRAP_TOKEN: 'test-bootstrap-token',
              // 蓋過 .dev.vars（本機 dev 用 localhost，測試固定走正式網域語意）
              RP_ID: 'mail.miseroda.com',
              ORIGIN: 'https://mail.miseroda.com',
              MAIL_DOMAIN: 'miseroda.com',
            },
            wrappedBindings: { AI: { scriptName: AI_BLOCKED_WORKER } },
            workers: [
              { name: AI_BLOCKED_WORKER, modules: [{ type: 'ESModule' as const, path: 'index.mjs', contents: AI_BLOCKED_SCRIPT }] },
              {
                name: AI_SINK_WORKER,
                modules: [{ type: 'ESModule' as const, path: 'index.mjs', contents: 'export default {};' }],
                wrappedBindings: { UNREACHABLE_REAL_AI: { scriptName: WRANGLER_AI_WORKER } },
              },
            ],
          },
        },
      },
    },
  };
}
