import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';

// 版本標籤（頭像選單最底下，見 src/app/lib/buildLabel.ts）：commit 編號＋commit 時間。
// 刻意不用建置時間——同一個 commit 建出來的產物要一模一樣，「比對線上與本機程式檔」的上線驗證才不會失效。
// Workers Builds 在 git checkout 裡建置，git 可用；萬一不可用，編號退回 CI 環境變數、時間留空（只顯示編號）。
function gitOut(cmd: string): string {
  try {
    return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '';
  }
}
const buildSha = gitOut('git rev-parse --short=7 HEAD') || (process.env.WORKERS_CI_COMMIT_SHA ?? '').slice(0, 7) || 'dev';
const buildTime = gitOut('git log -1 --format=%cI');

// 把本次 build 的 entry hash 注入 dist/sw.js 的 CACHE 名稱（置換 __SW_BUILD__）。
// 目的：service worker 的位元組隨每次部署改變 → 瀏覽器必偵測到新版 SW 並重抓，
// 解決「sw.js 內容不變 → 不更新 → 使用者卡舊殼/白屏」。
// 用 closeBundle（build 全部寫完、public/sw.js 已複製到 dist 後）做純文字置換，最小可行。
function swVersion(): Plugin {
  let entryHash = 'dev';
  return {
    name: 'sw-version-inject',
    apply: 'build',
    generateBundle(_opts, bundle) {
      for (const f of Object.values(bundle)) {
        if (f.type === 'chunk' && f.isEntry) {
          const m = f.fileName.match(/index-([A-Za-z0-9_-]+)\.js$/);
          if (m) entryHash = m[1];
        }
      }
    },
    closeBundle() {
      const swPath = resolve(process.cwd(), 'dist', 'sw.js');
      if (!existsSync(swPath)) return; // 沒有 sw.js → 不是本外掛的事
      const src = readFileSync(swPath, 'utf8');
      if (!src.includes('__SW_BUILD__')) return; // 沒有佔位符 → 無需置換
      // 有佔位符卻沒抓到 entry hash → 寧可讓 build 失敗，也別靜默出貨「版本不變」的 SW
      // （否則使用者會卡在舊殼/白屏，正是這項要修的事）。
      if (entryHash === 'dev') {
        throw new Error('[sw-version-inject] 找不到 entry chunk hash，無法為 sw.js 注入版本');
      }
      writeFileSync(swPath, src.replace(/__SW_BUILD__/g, entryHash));
    },
  };
}

export default defineConfig({
  plugins: [react(), swVersion()],
  define: {
    __BUILD_SHA__: JSON.stringify(buildSha),
    __BUILD_TIME__: JSON.stringify(buildTime),
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8787',
    },
  },
});
