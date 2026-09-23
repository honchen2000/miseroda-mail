import path from 'node:path';
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';
import { workersTestConfig } from './test/vitest.base';

// 主測試 project（isolated storage：每個 it() 自動回滾）
// DO WebSocket 測試在 test/realtime/（見 vitest.workspace.ts）
export default defineWorkersConfig(() =>
  workersTestConfig({
    name: 'worker',
    include: [path.join(__dirname, 'test/worker/**/*.test.ts')],
    isolatedStorage: true,
  }),
);
