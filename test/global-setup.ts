import { mkdir } from 'node:fs/promises';
import path from 'node:path';

// pool-workers 會讀 wrangler.jsonc 的 assets.directory；尚未 build 時先確保目錄存在
export default async function setup() {
  await mkdir(path.resolve(process.cwd(), 'dist'), { recursive: true });
}
