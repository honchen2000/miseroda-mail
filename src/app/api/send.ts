// 寄信 / 草稿 / 附件上傳資料層
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import { encryptMessage } from '../lib/msgcrypto';
import { appendShareLinks, type ShareLink } from './shareLinks';
import { uploadWithProgress, type UploadHandle, type UploadProgress } from './upload';
export type { ShareLink } from './shareLinks';
export { UploadAbortedError, type UploadProgress } from './upload';

export interface ComposerAttachment {
  id: string;
  filename: string;
  sizeBytes: number;
  mimeType: string;
}

export const SHARE_MAX_BYTES = 25 * 1024 * 1024;

/** 大檔案（>5 MiB 內嵌上限）→ R2 + 下載連結。回傳 handle：`.promise` 等結果、`.abort()` 取消。 */
export function uploadShareFile(file: File, onProgress: (p: UploadProgress) => void): UploadHandle<ShareLink> {
  return uploadWithProgress<ShareLink>('/share/upload', file, onProgress);
}

export interface ComposerDraft {
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
  /** 富文本內容（伺服器寄出前會再消毒一次） */
  bodyHtml: string | null;
  attachments: ComposerAttachment[];
  replyToMessageId: string | null;
  /** 伺服器草稿列 id（自動儲存用） */
  draftRowId: string | null;
  /** Send-as 寄件身分（本人 +tag 別名）；空/undefined = canonical email。 */
  fromAlias?: string | null;
  /** 大附件下載連結（寄信時附在內文末；不佔內嵌附件額度）。 */
  linkFiles?: ShareLink[];
  /** F2.7：回覆時帶入的原信情境（收件人/主旨/摘要）→ 供 AI 改寫貼合對象；不寄出、不存草稿。 */
  aiContext?: string | null;
  /** F3.2：此回覆的原信標記為「需回信」→ 寄出後自動清除其工作流標記（回完即消）；不寄出。 */
  replyClearStatus?: boolean;
}

export interface ServerDraft {
  id: string;
  payload: {
    to: string;
    cc: string;
    bcc?: string;
    subject: string;
    body: string;
    bodyHtml?: string | null;
    attachments: ComposerAttachment[];
    replyToMessageId: string | null;
    fromAlias?: string | null;
    linkFiles?: ShareLink[];
  };
  createdAt: number;
  updatedAt: number;
}

export interface OwnedAlias {
  id: string;
  address: string;
  name: string | null;
  signatureId: string | null; // F4.4：綁定的簽名
}

/** 使用者擁有的乾淨網域別名（撰寫器寄件身分清單用）。 */
export function useIdentities() {
  return useQuery({
    queryKey: ['identities'],
    queryFn: () => api<{ aliases: OwnedAlias[] }>('/identities'),
    staleTime: 300_000,
  });
}

// F4.4：多重簽名
export interface Signature {
  id: string;
  name: string;
  content: string;
  isDefault: boolean;
}
export function useSignatures(enabled = true) {
  return useQuery({
    queryKey: ['signatures'],
    queryFn: () => api<{ signatures: Signature[] }>('/signatures'),
    enabled,
    staleTime: 300_000,
  });
}

export function useDrafts(enabled: boolean) {
  return useQuery({
    queryKey: ['drafts'],
    queryFn: () => api<{ drafts: ServerDraft[] }>('/drafts'),
    enabled,
    staleTime: 5_000,
  });
}

export interface OutboxItem {
  id: string;
  status: 'scheduled' | 'sending' | 'failed' | 'review';
  scheduledAt: number;
  lastError: string | null;
  subject: string;
  to: string[];
}

export function useOutbox(enabled: boolean) {
  return useQuery({
    queryKey: ['outbox'],
    queryFn: () => api<{ items: OutboxItem[] }>('/outbox'),
    enabled,
    staleTime: 3_000,
    refetchInterval: enabled ? 15_000 : false,
  });
}

export function useRetrySend() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(`/send/${id}/retry`, { method: 'POST', body: {} }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['outbox'] });
      void qc.invalidateQueries({ queryKey: ['messages'] });
    },
  });
}

/** 裁決外送結果未定的信：'resend' 重新外送 / 'sent' 確認已送達只補本地收尾 / 'discard' 放棄整封 */
export function useResolveSend() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: 'resend' | 'sent' | 'discard' }) =>
      api(`/send/${id}/resolve`, { method: 'POST', body: { decision } }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['outbox'] });
      void qc.invalidateQueries({ queryKey: ['messages'] });
    },
  });
}

function splitAddrs(s: string): string[] {
  return s
    .split(/[,，;\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

export interface SendResult {
  id: string;
  scheduledAt: number;
  undoWindowSec: number;
  /** F2.3：寄出含問句的信時，後端會自動建「等回覆」跟進 → 前端在 toast 提示一句。 */
  trackReply?: boolean;
}

export function useSendMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { draft: ComposerDraft; undoWindowSec?: number; scheduleAt?: number | null }) => {
      // 大附件下載連結附在內文末（送信端不需感知；html 仍會經伺服器消毒白名單）。
      const { text, html } = appendShareLinks(args.draft);
      return api<SendResult>('/messages/send', {
        body: {
          to: splitAddrs(args.draft.to),
          cc: splitAddrs(args.draft.cc),
          bcc: splitAddrs(args.draft.bcc),
          subject: args.draft.subject,
          text,
          html,
          attachmentIds: args.draft.attachments.map((a) => a.id),
          replyToMessageId: args.draft.replyToMessageId,
          ...(args.draft.fromAlias ? { fromAlias: args.draft.fromAlias } : {}),
          ...(args.undoWindowSec !== undefined ? { undoWindowSec: args.undoWindowSec } : {}),
          ...(args.scheduleAt ? { scheduleAt: args.scheduleAt } : {}),
        },
      });
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['messages'] });
      void qc.invalidateQueries({ queryKey: ['counts'] });
    },
  });
}

export function useCancelSend() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<{ ok: boolean; payload: { to: string[]; cc: string[]; subject: string; text: string; attachmentIds: string[]; replyToMessageId: string | null } | null }>(
        `/send/${id}/cancel`,
        { method: 'POST', body: {} },
      ),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['messages'] });
      void qc.invalidateQueries({ queryKey: ['counts'] });
    },
  });
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

/** 內嵌附件上傳。回傳 handle：`.promise` 等結果、`.abort()` 取消。 */
export function uploadAttachment(file: File, onProgress: (p: UploadProgress) => void): UploadHandle<ComposerAttachment> {
  return uploadWithProgress<ComposerAttachment>('/attachments/upload', file, onProgress);
}

export async function deleteStagedAttachment(id: string): Promise<void> {
  await api(`/attachments/${id}`, { method: 'DELETE' });
}

// F7.6：MBOX 匯入舊信
export interface ImportJob {
  id: string;
  filename: string;
  total: number;
  done: number;
  skipped: number;
  failed: number;
  status: 'pending' | 'running' | 'done' | 'error';
  created_at: number;
}
// F7.7：建立訊息級加密連結。內容在瀏覽器端加密，伺服器只拿到密文/salt/iv；
// fragmentSecret 留在 client 組進連結 fragment（#k=）→ 站方無從解密。
export async function createEncryptedLink(args: {
  plaintext: string;
  password: string;
  subject?: string;
  expiresDays?: number;
}): Promise<{ url: string; expiresAt: number }> {
  const bundle = await encryptMessage(args.plaintext, args.password);
  const res = await api<{ token: string; url: string; expiresAt: number }>('/encrypted', {
    method: 'POST',
    body: { subject: args.subject, ciphertext: bundle.ciphertext, salt: bundle.salt, iv: bundle.iv, expiresDays: args.expiresDays },
  });
  return { url: `${res.url}#k=${bundle.fragmentSecret}`, expiresAt: res.expiresAt };
}

export async function uploadMbox(file: File): Promise<{ jobId: string }> {
  const form = new FormData();
  form.set('file', file);
  const res = await fetch('/api/v1/import/mbox', {
    method: 'POST',
    headers: { 'X-CSRF-Token': csrfFromCookie() },
    credentials: 'same-origin',
    body: form,
  });
  if (!res.ok) {
    const payload = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error ?? `import_failed_${res.status}`);
  }
  return (await res.json()) as { jobId: string };
}

export async function saveDraft(draft: ComposerDraft): Promise<string> {
  const payload = {
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    subject: draft.subject,
    body: draft.body,
    bodyHtml: draft.bodyHtml,
    attachments: draft.attachments,
    replyToMessageId: draft.replyToMessageId,
    fromAlias: draft.fromAlias ?? null,
    linkFiles: draft.linkFiles ?? [],
  };
  if (draft.draftRowId) {
    await api(`/drafts/${draft.draftRowId}`, { method: 'PATCH', body: payload });
    return draft.draftRowId;
  }
  const res = await api<{ id: string }>('/drafts', { body: payload });
  return res.id;
}

export async function deleteDraft(id: string): Promise<void> {
  await api(`/drafts/${id}`, { method: 'DELETE' });
}
