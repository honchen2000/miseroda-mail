import { applyD1Migrations, env } from 'cloudflare:test';

// 每個測試 worker 啟動時把兩庫 schema 套到隔離的測試 D1
await applyD1Migrations(env.DB, env.TEST_MAIN_MIGRATIONS);
await applyD1Migrations(env.DB_FTS, env.TEST_FTS_MIGRATIONS);
