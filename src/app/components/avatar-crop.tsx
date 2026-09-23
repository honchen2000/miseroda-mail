// 頭像裁切：圓形取景框，拖曳移動、滾輪／雙指縮放，輸出 512×512 WebP（不支援時退 JPEG）。
//
// 為什麼裁切與壓縮做在瀏覽器端：workerd 沒有 Canvas 也沒有影像解碼庫，要在 Worker 壓圖只能
// 掛付費的 Cloudflare Images 或塞 WASM 編解碼器。而瀏覽器本來就有完整 Canvas——讓使用者
// 拖曳縮放的那塊畫布，正好就是產生最終方圖的地方。順帶省下把數 MB 原檔傳上網的頻寬。
//
// 「無損壓縮」對照片是反效果：無損重編（PNG）通常比原始 JPEG 更大。真正讓檔案變小的是
// 縮尺寸——頭像最大只顯示到 72px（.user-pop-avatar），存 512 已是給未來放大用的餘裕。
import { useCallback, useEffect, useRef, useState } from 'react';
import { Modal } from './ui';
import { clampView, coverScale, initialView, sourceRect, zoomAtPoint, type CropView } from '../lib/avatarCrop';

/** 輸出邊長。顯示只用到 72px，512 是餘裕；再大對檔案大小不划算。 */
const OUT = 512;
/** 取景框在畫面上的邊長（CSS px）。 */
const VIEW = 260;
const MAX_ZOOM = 6;
/** 解碼前的輸入上限：手機照片約 3–8 MB，30 MB 足夠且擋掉會讓分頁 OOM 的怪檔。 */
const MAX_INPUT_BYTES = 30 * 1024 * 1024;

export function AvatarCropModal({ file, onCancel, onDone, pushToast }: {
  file: File;
  onCancel: () => void;
  onDone: (out: File) => void;
  pushToast: (t: string) => void;
}) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [view, setView] = useState<CropView>({ zoom: 1, ox: 0, oy: 0 });
  const [busy, setBusy] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  // 進行中的指標（滑鼠或手指）。兩指時用來算捏合。
  const ptrs = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ dist: number; zoom: number } | null>(null);

  const clamp = useCallback(
    (im: HTMLImageElement, v: CropView) => clampView(im.naturalWidth, im.naturalHeight, VIEW, v),
    [],
  );

  // 讀檔。用 <img> 而非 createImageBitmap：它會套用 EXIF 方向（手機直式照片必要），
  // 而且 SVG 也載得起來——SVG 在 <img> 內不能執行腳本，光柵化後輸出點陣圖是安全的。
  useEffect(() => {
    if (file.size > MAX_INPUT_BYTES) {
      pushToast('圖片檔案過大（上限 30 MB）');
      onCancel();
      return;
    }
    const url = URL.createObjectURL(file);
    const im = new Image();
    im.onload = () => {
      if (!im.naturalWidth || !im.naturalHeight) {
        pushToast('這張圖片讀不到尺寸，請換一張');
        onCancel();
        return;
      }
      setImg(im);
      setView(initialView(im.naturalWidth, im.naturalHeight, VIEW));
    };
    im.onerror = () => {
      // 最常見成因：桌機瀏覽器不認 iPhone 的 HEIC。
      pushToast('瀏覽器無法讀取這個圖片格式（例如 HEIC），請改用 JPG 或 PNG');
      onCancel();
    };
    im.src = url;
    return () => URL.revokeObjectURL(url);
  }, [file, onCancel, pushToast]);

  /** 以 (fx, fy) 為焦點縮放，讓游標／指尖下的那一點維持不動。 */
  const zoomAt = useCallback((fx: number, fy: number, nextZoom: number) => {
    if (!img) return;
    setView((v) => zoomAtPoint(img.naturalWidth, img.naturalHeight, VIEW, v, fx, fy, nextZoom, MAX_ZOOM));
  }, [img]);

  const localPoint = (e: { clientX: number; clientY: number }) => {
    const r = boxRef.current?.getBoundingClientRect();
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
  };

  // 用原生 listener 而非 React 的 onWheel：React 把 wheel 註冊成 passive，
  // 在裡面 preventDefault 無效——滾輪縮放時背後的頁面會跟著捲動。
  useEffect(() => {
    const box = boxRef.current;
    if (!box || !img) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = box.getBoundingClientRect();
      // deltaY 向上為負＝放大。除以 400 讓一格滾輪約 ±12%。
      setView((v) => zoomAtPoint(
        img.naturalWidth, img.naturalHeight, VIEW, v,
        e.clientX - r.left, e.clientY - r.top,
        v.zoom * Math.exp(-e.deltaY / 400), MAX_ZOOM,
      ));
    };
    box.addEventListener('wheel', onWheel, { passive: false });
    return () => box.removeEventListener('wheel', onWheel);
  }, [img]);

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    ptrs.current.set(e.pointerId, localPoint(e));
    if (ptrs.current.size === 2) {
      const [a, b] = [...ptrs.current.values()];
      pinch.current = { dist: Math.hypot(a.x - b.x, a.y - b.y), zoom: view.zoom };
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!img || !ptrs.current.has(e.pointerId)) return;
    const prev = ptrs.current.get(e.pointerId)!;
    const now = localPoint(e);
    ptrs.current.set(e.pointerId, now);

    if (ptrs.current.size >= 2 && pinch.current) {
      const [a, b] = [...ptrs.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch.current.dist > 0) {
        zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, pinch.current.zoom * (dist / pinch.current.dist));
      }
      return;
    }
    const dx = now.x - prev.x;
    const dy = now.y - prev.y;
    setView((v) => clamp(img, { ...v, ox: v.ox + dx, oy: v.oy + dy }));
  };

  const endPointer = (e: React.PointerEvent) => {
    ptrs.current.delete(e.pointerId);
    if (ptrs.current.size < 2) pinch.current = null;
  };

  const confirm = async () => {
    if (!img || busy) return;
    setBusy(true);
    try {
      const canvas = document.createElement('canvas');
      canvas.width = OUT;
      canvas.height = OUT;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('no 2d context');
      ctx.imageSmoothingQuality = 'high';
      const { sx, sy, side } = sourceRect(img.naturalWidth, img.naturalHeight, VIEW, view);
      ctx.drawImage(img, sx, sy, side, side, 0, 0, OUT, OUT);

      // 不支援 WebP 編碼的瀏覽器會回傳 image/png（而非 null），所以用 type 判斷而不是有無 blob。
      let blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/webp', 0.92));
      if (!blob || blob.type !== 'image/webp') {
        blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.92));
      }
      if (!blob) throw new Error('encode failed');
      const ext = blob.type === 'image/webp' ? 'webp' : 'jpg';
      onDone(new File([blob], `avatar.${ext}`, { type: blob.type }));
    } catch {
      pushToast('圖片處理失敗，請再試一次');
      setBusy(false);
    }
  };

  const s = img ? coverScale(img.naturalWidth, img.naturalHeight, VIEW) * view.zoom : 1;

  return (
    <Modal title="調整頭像" desc="拖曳移動位置，滾輪或雙指縮放" onClose={onCancel} width={VIEW + 72}>
      <div className="avatar-crop" ref={boxRef}
        style={{ width: VIEW, height: VIEW }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
      >
        {img && (
          <img className="avatar-crop-img" src={img.src} alt=""
            draggable={false}
            style={{
              width: img.naturalWidth * s,
              height: img.naturalHeight * s,
              transform: `translate(${view.ox}px, ${view.oy}px)`,
            }} />
        )}
        <span className="avatar-crop-mask" aria-hidden="true"></span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
        <button className="btn btn-ghost" onClick={onCancel} disabled={busy}>取消</button>
        <button className="btn btn-primary" onClick={() => void confirm()} disabled={!img || busy}>
          {busy ? '處理中…' : '設為頭像'}
        </button>
      </div>
    </Modal>
  );
}
