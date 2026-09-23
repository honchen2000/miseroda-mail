// 建置時由 vite.config.ts 的 define 注入（commit 編號與 commit 時間）。純字串邏輯在 buildLabel.ts。
import { formatBuildLabel } from './buildLabel';

declare const __BUILD_SHA__: string;
declare const __BUILD_TIME__: string;

export const BUILD_SHA = __BUILD_SHA__;
export const BUILD_LABEL = formatBuildLabel(__BUILD_SHA__, __BUILD_TIME__);
