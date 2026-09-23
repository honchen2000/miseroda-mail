import path from 'node:path';
import { defineWorkersProject } from '@cloudflare/vitest-pool-workers/config';
import { workersTestConfig } from '../vitest.base';

// DO WebSocket 專用 project：isolatedStorage 關閉（miniflare 上游限制），
// 測試自己負責用唯一資料避免互踩
export default defineWorkersProject(() =>
  workersTestConfig({
    name: 'realtime-ws',
    include: [path.join(__dirname, '**/*.test.ts')],
    isolatedStorage: false,
  }),
);
