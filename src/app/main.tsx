import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider, MutationCache, QueryCache } from '@tanstack/react-query';
import { App } from './App';
import { TooltipProvider } from './components/tooltip';
import { registerSW } from './lib/swUpdate';
import { NetworkError } from './api/client';
import { reportConnectionError } from './api/netstatus';
import './styles/styles.css';
import './styles/quiet-aurora.css';

// 任一查詢/操作因連線層失敗（逾時/斷線）→ 統一彈一則 toast（去抖），避免各處顯示誤導訊息或靜默凍結。
// 只在「線上但卡住」時彈（navigator.onLine=true）；硬離線由持久離線橫幅＋各流程自身提示（如送信入待送匣）處理。
const onConnErr = (err: unknown) => {
  if (err instanceof NetworkError && (typeof navigator === 'undefined' || navigator.onLine)) {
    reportConnectionError(err.message);
  }
};

const queryClient = new QueryClient({
  mutationCache: new MutationCache({ onError: onConnErr }),
  queryCache: new QueryCache({ onError: onConnErr }),
  defaultOptions: {
    // gcTime 24h：離線持久化還原後的查詢需在記憶體保留夠久才不會被立即回收
    // retry：連線層錯誤（NetworkError）不重試（已逾時，重試只是再等一輪）；其餘沿用 1 次。
    queries: {
      retry: (count, err) => !(err instanceof NetworkError) && count < 1,
      // 效能：邊緣在 PDX、一支往返 ~165ms 起跳 → 預設不重打；30s 內視為新鮮，切回剛看過的資料夾不再打網路。
      staleTime: 30_000,
      // 切回分頁時重抓：WebSocket 兜底不夠即時（背景逾 60 秒會主動斷線，回前景只重連、不 invalidate；
      // refetchInterval 失焦時本來就暫停）→ 曾出現切分頁看到近 2 分鐘前舊資料。開啟後靠上面的
      // staleTime（30s，counts/messages 60s）擋著：只有資料真的過期才會重抓，不會變回「每次切分頁全額重打」。
      refetchOnWindowFocus: true,
      gcTime: 24 * 60 * 60 * 1000,
    },
  },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
      <TooltipProvider />
    </QueryClientProvider>
  </React.StrictMode>,
);

// PWA：註冊 service worker + 掛上「背景自動更新」流程（見 lib/swUpdate）
registerSW();
