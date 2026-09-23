declare module 'cloudflare:test' {
  // ProvidedEnv 對應 wrangler.jsonc 的 bindings（由 worker-configuration.d.ts 提供）
  interface ProvidedEnv extends Env {
    TEST_MAIN_MIGRATIONS: D1Migration[];
    TEST_FTS_MIGRATIONS: D1Migration[];
  }
}
