// 檔案庫：信箱內所有附件總覽（圖片縮圖、依檔名搜尋、點擊預覽/下載）
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { EmptyState, Icon, timeAgo, type LightboxAtt } from './ui';

export interface FileRow {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  ts: number;
  messageId: string;
  from: { name: string; addr: string };
  subject: string;
  direction: 'inbound' | 'outbound';
  folder: string;
}

function useFiles(q: string) {
  return useQuery({
    queryKey: ['files', q],
    queryFn: () => api<{ files: FileRow[] }>(`/files${q ? `?q=${encodeURIComponent(q)}` : ''}`),
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });
}

function fmtSize(n: number): string {
  return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

function kindIcon(mime: string): 'img' | 'pdf' | 'clip' {
  if (mime.startsWith('image/')) return 'img';
  if (mime === 'application/pdf') return 'pdf';
  return 'clip';
}

export function FilesPage({ onPreview, onOpenMessage, onMenu }: {
  onPreview: (att: LightboxAtt) => void;
  onOpenMessage: (messageId: string, folder: string) => void;
  onMenu: () => void;
}) {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  const files = useFiles(debounced);
  const list = files.data?.files ?? [];

  return (
    <main className="readpane">
      <div className="content-page">
        <div className="mobile-topbar">
          <button className="iconbtn mobile-only" aria-label="開啟選單" onClick={onMenu}><Icon name="menu" /></button>
          <span className="t">檔案</span>
        </div>
        <h1 className="page-title">檔案</h1>
        <p className="page-sub">所有信件附件集中在這裡（最近 200 筆）。點圖片或 PDF 直接預覽，其他檔案點了就下載。</p>
        <div className="searchbar" style={{ maxWidth: 420, marginBottom: 18 }}>
          <Icon name="search" size={15} />
          <input className="input" placeholder="搜尋檔名…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {!list.length && !files.isLoading && (
          <EmptyState pose="search" title={debounced ? '找不到符合的檔案' : '還沒有附件'}
            sub={debounced ? '換個關鍵字試試。' : '收到帶附件的信後會自動出現在這裡。'} />
        )}
        <div className="files-grid">
          {list.map((f, i) => (
            <div key={f.id} className="file-card" style={{ ['--i' as string]: i }} role="button" tabIndex={0}
              data-tooltip={f.filename}
              onClick={() => onPreview({ id: f.id, filename: f.filename, mimeType: f.mimeType, sizeBytes: f.sizeBytes })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onPreview({ id: f.id, filename: f.filename, mimeType: f.mimeType, sizeBytes: f.sizeBytes });
              }}>
              <div className="file-thumb">
                {f.mimeType.startsWith('image/') ? (
                  <img src={`/api/v1/attachments/${f.id}/inline`} alt="" loading="lazy" />
                ) : (
                  <Icon name={kindIcon(f.mimeType)} size={28} />
                )}
              </div>
              <div className="file-meta">
                <div className="file-name">{f.filename}</div>
                <div className="file-sub">
                  {f.direction === 'outbound' ? '我寄出' : (f.from.name || f.from.addr)} · {fmtSize(f.sizeBytes)} · {timeAgo(f.ts)}
                </div>
              </div>
              <button className="iconbtn file-jump" data-tooltip="開啟原始信件" aria-label="開啟原始信件"
                onClick={(e) => { e.stopPropagation(); onOpenMessage(f.messageId, f.folder); }}>
                <Icon name="mail" size={14} />
              </button>
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
