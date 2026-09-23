// 附件上傳：走 XMLHttpRequest 而非 fetch。
//
// 為什麼不是 fetch：**fetch 拿不到上傳進度**（Web API 的限制，不是這裡的實作問題）。
// 要顯示真實百分比／速度／剩餘時間，只有 `xhr.upload.onprogress` 這條路；順帶也才有
// `xhr.abort()` 這個取消能力——fetch 版連取消都做不到。
//
// 這個模組刻意只做「一個檔案的上傳」，不碰 React：進度回呼交給呼叫端決定怎麼呈現。
import { BOOKMARK_HEADER, clearBookmark, getBookmark, setBookmark } from './bookmark';

export interface UploadProgress {
  loaded: number;
  /** 0 = 瀏覽器沒給總量（lengthComputable=false），此時不要顯示百分比。 */
  total: number;
  bytesPerSec: number;
  /** null = 算不出來（總量未知或還沒有樣本）。 */
  etaSec: number | null;
}

export interface UploadHandle<T> {
  promise: Promise<T>;
  abort: () => void;
}

/** 使用者按了取消。與「上傳失敗」分開，呼叫端不該對它跳錯誤提示。 */
export class UploadAbortedError extends Error {
  constructor() {
    super('upload_aborted');
    this.name = 'UploadAbortedError';
  }
}

function csrfFromCookie(): string {
  for (const part of document.cookie.split(/;\s*/)) {
    const eq = part.indexOf('=');
    if (part.slice(0, eq) === '__Host-csrf' || part.slice(0, eq) === 'csrf') {
      return decodeURIComponent(part.slice(eq + 1));
    }
  }
  return '';
}

export function uploadWithProgress<T>(
  path: string,
  file: File,
  onProgress: (p: UploadProgress) => void,
): UploadHandle<T> {
  const xhr = new XMLHttpRequest();
  const form = new FormData();
  form.set('file', file);
  const startedAt = Date.now();

  const promise = new Promise<T>((resolve, reject) => {
    xhr.open('POST', `/api/v1${path}`);
    xhr.setRequestHeader('X-CSRF-Token', csrfFromCookie());
    // D1 讀你所寫：與 client.ts 的 api() 同一套往返，別讓上傳成為漏掉 bookmark 的破口。
    const bookmark = getBookmark();
    if (bookmark) xhr.setRequestHeader(BOOKMARK_HEADER, bookmark);

    // 刻意不設 xhr.timeout：25 MiB 在慢速網路可能要好幾分鐘，硬性逾時會誤殺正常上傳。
    // 卡住的上傳交給使用者按取消——這正是改用 XHR 才拿到的能力。
    xhr.upload.onprogress = (e) => {
      const elapsed = (Date.now() - startedAt) / 1000;
      const bytesPerSec = elapsed > 0 ? e.loaded / elapsed : 0;
      const total = e.lengthComputable ? e.total : 0;
      onProgress({
        loaded: e.loaded,
        total,
        bytesPerSec,
        etaSec: total > 0 && bytesPerSec > 0 ? Math.max(0, Math.round((total - e.loaded) / bytesPerSec)) : null,
      });
    };

    xhr.onload = () => {
      // bookmark 收回：與 api() 同語意——5xx 主動丟棄（可能是失效的 bookmark，自癒），其餘收下。
      if (xhr.status >= 500) clearBookmark();
      else setBookmark(xhr.getResponseHeader(BOOKMARK_HEADER));

      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as T);
        } catch {
          reject(new Error('bad_response'));
        }
        return;
      }
      // 沿用原本的錯誤語意：丟帶伺服器錯誤碼的 Error（不是 ApiError——上傳本來就不走 api()）
      let code = `upload_failed_${xhr.status}`;
      try {
        code = (JSON.parse(xhr.responseText) as { error?: string }).error ?? code;
      } catch {
        /* 非 JSON 錯誤頁 → 沿用狀態碼 */
      }
      reject(new Error(code));
    };
    xhr.onerror = () => reject(new Error('network'));
    xhr.onabort = () => reject(new UploadAbortedError());
    xhr.send(form);
  });

  return { promise, abort: () => xhr.abort() };
}
