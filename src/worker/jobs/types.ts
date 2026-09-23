export interface IngestJob {
  kind: 'ingest';
  messageId: string;
  userId: string;
}

export interface SendJob {
  kind: 'send';
  sendQueueId: string;
}

// F7.6：MBOX 匯入。分批處理（offset 推進，做完一批再 re-enqueue 下一批）避 CPU 上限。
export interface ImportMboxJob {
  kind: 'import-mbox';
  jobId: string;
  userId: string;
  offset: number; // 從第幾封開始處理這一批
}

export type QueueJob = IngestJob | SendJob | ImportMboxJob;
