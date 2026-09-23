// 共用元件：圖示、企鵝 Pori、Avatar、Chip、Switch、Modal、極光背景 —— 1:1 移植設計原型
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

/* ---------- 圖示（線條 16px viewBox） ---------- */
export type IconName =
  | 'inbox' | 'send' | 'draft' | 'archive' | 'trash' | 'spam' | 'star' | 'starFill'
  | 'search' | 'settings' | 'shield' | 'pen' | 'reply' | 'tag' | 'clip' | 'x' | 'back'
  | 'check' | 'key' | 'fingerprint' | 'logout' | 'mail' | 'more' | 'img' | 'pdf'
  | 'sparkle' | 'clock' | 'keyboard' | 'moon' | 'menu' | 'download'
  | 'refresh' | 'globe' | 'snooze' | 'bell' | 'flag' | 'checksquare' | 'square' | 'chevronDown' | 'user' | 'command' | 'minus' | 'pin' | 'calendar';

export function Icon({ name, size = 17 }: { name: IconName; size?: number }) {
  const s = { width: size, height: size, flex: 'none' } as const;
  const p = {
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.7,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
  } as const;
  const paths: Record<IconName, ReactNode> = {
    inbox: <g {...p}><path d="M2.5 9.5 5 3.5h8l2.5 6" /><path d="M2.5 9.5h3.6l1 2h3.8l1-2h3.6v3.8a1.2 1.2 0 0 1-1.2 1.2H3.7a1.2 1.2 0 0 1-1.2-1.2Z" /></g>,
    send: <g {...p}><path d="M14.5 1.5 7.2 8.8" /><path d="M14.5 1.5 9.8 14.5l-2.6-5.7-5.7-2.6Z" /></g>,
    draft: <g {...p}><path d="M9.5 2.5h-5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1v-7" /><path d="M9.5 2.5v3h3" /></g>,
    archive: <g {...p}><rect x="2" y="3" width="12" height="3.4" rx="0.8" /><path d="M3.2 6.4v6a1 1 0 0 0 1 1h7.6a1 1 0 0 0 1-1v-6" /><path d="M6.5 9.4h3" /></g>,
    trash: <g {...p}><path d="M2.5 4.3h11" /><path d="M5.5 4.3V3a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1.3" /><path d="M4 4.3l.7 8.7a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9l.7-8.7" /></g>,
    spam: <g {...p}><path d="M8 1.8 14.5 13a.9.9 0 0 1-.8 1.4H2.3a.9.9 0 0 1-.8-1.4Z" /><path d="M8 6v3.4" /><circle cx="8" cy="11.7" r="0.25" /></g>,
    star: <g {...p}><path d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6Z" /></g>,
    starFill: <path d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6Z" fill="currentColor" stroke="none" />,
    pin: <g {...p}><path d="M6 2.3h4" /><path d="M6.6 2.3v4l-1.3 2.6v1.3h5.4v-1.3l-1.3-2.6v-4" /><path d="M8 10.2v3.5" /></g>,
    search: <g {...p}><circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3.5 3.5" /></g>,
    settings: <g {...p}><circle cx="8" cy="8" r="2.2" /><path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M12.4 3.6 11 5M5 11l-1.4 1.4" /></g>,
    shield: <g {...p}><path d="M8 1.8 13 3.6v4.2c0 3.3-2.1 5.5-5 6.6-2.9-1.1-5-3.3-5-6.6V3.6Z" /><path d="m5.8 7.8 1.6 1.6 2.8-3" /></g>,
    pen: <g {...p}><path d="M11.2 2.2a1.6 1.6 0 0 1 2.3 2.3L5.3 12.7l-3 .8.8-3Z" /></g>,
    reply: <g {...p}><path d="M6.5 3.5 2.5 7.2l4 3.7" /><path d="M2.8 7.2h6.4a4.3 4.3 0 0 1 4.3 4.3v1" /></g>,
    tag: <g {...p}><path d="m2 7.4 5.5 5.5a1.2 1.2 0 0 0 1.7 0l4.3-4.3a1.2 1.2 0 0 0 0-1.7L8 1.4H3.2A1.2 1.2 0 0 0 2 2.6Z" /><circle cx="5.4" cy="5" r="0.4" /></g>,
    clip: <g {...p}><path d="m13 7.2-5 5a3.1 3.1 0 0 1-4.4-4.4l5.5-5.5a2.1 2.1 0 0 1 3 3l-5.5 5.5a1 1 0 0 1-1.5-1.5l4.8-4.7" /></g>,
    x: <g {...p}><path d="m4 4 8 8M12 4l-8 8" /></g>,
    minus: <g {...p}><path d="M3.5 8h9" /></g>,
    back: <g {...p}><path d="M10 3 5 8l5 5" /></g>,
    check: <g {...p}><path d="m3 8.6 3.3 3.3L13 5" /></g>,
    key: <g {...p}><circle cx="5.4" cy="8" r="3.2" /><path d="M8.6 8h5.2M11.5 8v2.4M13.8 8v1.6" /></g>,
    fingerprint: <g {...p}><path d="M4 13.2c1.5-1.6 1.7-3.8 1.7-5.2a2.3 2.3 0 0 1 4.6 0c0 2-.3 4.2-1.6 6" /><path d="M2.3 10.8c.8-1.3 1-2.5 1-2.8a4.7 4.7 0 0 1 8-3.3" /><path d="M13.4 5.8c.3.7.4 1.5.4 2.2 0 1.2 0 2.7-.5 4.2" /></g>,
    logout: <g {...p}><path d="M6.5 2.5H3.8a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h2.7" /><path d="m10 5 3 3-3 3M13 8H6.5" /></g>,
    mail: <g {...p}><rect x="1.8" y="3.2" width="12.4" height="9.6" rx="1.2" /><path d="m2.5 4.5 5.5 4.3 5.5-4.3" /></g>,
    more: <g {...p}><circle cx="3.4" cy="8" r="0.4" /><circle cx="8" cy="8" r="0.4" /><circle cx="12.6" cy="8" r="0.4" /></g>,
    img: <g {...p}><rect x="2" y="2.8" width="12" height="10.4" rx="1.2" /><circle cx="5.6" cy="6.4" r="1.1" /><path d="m3.2 12 3.6-3.6 2.4 2.4 2-2 2.6 2.6" /></g>,
    pdf: <g {...p}><path d="M9.5 1.8h-5a1 1 0 0 0-1 1v10.4a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V4.8Z" /><path d="M9.5 1.8v3h3" /><path d="M5.5 9.2h5M5.5 11.4h3.4" /></g>,
    sparkle: <g {...p}><path d="M8 2.2 9.3 6 13 7.3 9.3 8.6 8 12.4 6.7 8.6 3 7.3 6.7 6Z" /></g>,
    clock: <g {...p}><circle cx="8" cy="8" r="6" /><path d="M8 4.8V8l2.2 1.6" /></g>,
    calendar: <g {...p}><rect x="2.5" y="3.5" width="11" height="10" rx="1.5" /><path d="M2.5 6.3h11M5.3 2.2v2.4M10.7 2.2v2.4" /></g>,
    keyboard: <g {...p}><rect x="1.6" y="4" width="12.8" height="8" rx="1.2" /><path d="M4 6.5h.1M6.4 6.5h.1M8.8 6.5h.1M11.2 6.5h.1M4 9.5h8" /></g>,
    moon: <g {...p}><path d="M13.2 9.6A5.6 5.6 0 0 1 6.4 2.8a5.6 5.6 0 1 0 6.8 6.8Z" /></g>,
    menu: <g {...p}><path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" /></g>,
    download: <g {...p}><path d="M8 2.5v7.5M4.8 7l3.2 3.2L11.2 7" /><path d="M3 12.5h10" /></g>,
    refresh: <g {...p}><path d="M13.5 7a5.5 5.5 0 1 0-.6 3.4" /><path d="M13.5 3v4h-4" /></g>,
    globe: <g {...p}><circle cx="8" cy="8" r="6" /><path d="M2 8h12M8 2c1.8 1.6 2.8 3.8 2.8 6S9.8 14.4 8 14M8 2C6.2 3.6 5.2 5.8 5.2 8S6.2 14.4 8 14" /></g>,
    snooze: <g {...p}><circle cx="8" cy="9" r="5" /><path d="M8 6.2V9l1.8 1.2M6 2h4l-4 3.4h4M8 1v1" /></g>,
    bell: <g {...p}><path d="M4 7a4 4 0 0 1 8 0c0 3 1 4 1 4H3s1-1 1-4Z" /><path d="M6.5 13a1.5 1.5 0 0 0 3 0" /></g>,
    flag: <g {...p}><path d="M3.5 14V2.5M3.5 3h7.6l-1.3 2.6L11.1 8H3.5" /></g>,
    checksquare: <g {...p}><rect x="2.5" y="2.5" width="11" height="11" rx="2" /><path d="m5.5 8 1.8 1.8L11 6" /></g>,
    square: <g {...p}><rect x="2.5" y="2.5" width="11" height="11" rx="2" /></g>,
    chevronDown: <g {...p}><path d="m4 6 4 4 4-4" /></g>,
    user: <g {...p}><circle cx="8" cy="5.4" r="2.8" /><path d="M2.8 13.6c.8-2.6 2.8-4 5.2-4s4.4 1.4 5.2 4" /></g>,
    command: <g {...p}><path d="M5.5 5.5h5v5h-5z" /><path d="M5.5 5.5H4a1.5 1.5 0 1 1 1.5-1.5v1.5ZM10.5 5.5H12a1.5 1.5 0 1 0-1.5-1.5v1.5ZM5.5 10.5H4A1.5 1.5 0 1 0 5.5 12v-1.5ZM10.5 10.5H12a1.5 1.5 0 1 1-1.5 1.5v-1.5Z" /></g>,
  };
  return <svg viewBox="0 0 16 16" style={s} aria-hidden="true">{paths[name] ?? paths.mail}</svg>;
}

/* ---------- 企鵝吉祥物 Pori（精細版，對齊 logo：一體輪廓 + 雙拱白面 + 萌眼 + 絲質極光圍巾） ---------- */
export type PoriPose = 'happy' | 'search' | 'sweep' | 'error' | 'wave';

export function Pori({ size = 110, pose = 'happy' }: { size?: number; pose?: PoriPose }) {
  const tilt = pose === 'search' ? -6 : pose === 'sweep' ? 4 : 0;
  // 彩蛋：點 Pori 會開心地跳一下
  const [hop, setHop] = useState(false);
  const hopTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const doHop = () => {
    if (hop) return;
    setHop(true);
    clearTimeout(hopTimer.current);
    hopTimer.current = setTimeout(() => setHop(false), 900);
  };
  useEffect(() => () => clearTimeout(hopTimer.current), []);
  return (
    <svg width={size} height={size} viewBox="0 0 120 120" aria-label="企鵝 Pori" role="img"
      className={`pori ${hop ? 'hop' : ''}`} onClick={doHop} style={{ cursor: 'pointer' }}>
      <defs>
        <linearGradient id="pori-scarf" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#5FF6C2" />
          <stop offset="50%" stopColor="#38BDF8" />
          <stop offset="100%" stopColor="#A78BFA" />
        </linearGradient>
        <linearGradient id="pori-scarf-tail" x1="0" y1="0" x2="1" y2="0.4">
          <stop offset="0%" stopColor="#38BDF8" />
          <stop offset="60%" stopColor="#7DA2F6" />
          <stop offset="100%" stopColor="#A78BFA" />
        </linearGradient>
        <linearGradient id="pori-body" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#28324E" />
          <stop offset="55%" stopColor="#1B2338" />
          <stop offset="100%" stopColor="#131A2B" />
        </linearGradient>
        <linearGradient id="pori-belly" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#FFFFFF" />
          <stop offset="100%" stopColor="#DCE5F4" />
        </linearGradient>
        <linearGradient id="pori-beak" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#FFC95C" />
          <stop offset="100%" stopColor="#F2982A" />
        </linearGradient>
      </defs>

      <ellipse cx="60" cy="106.5" rx="35" ry="5.5" fill="currentColor" opacity="0.12" />

      <g transform={`rotate(${tilt} 60 70)`}>
        {/* 後翅（wave 時左翅改畫前景舉起） */}
        {pose !== 'wave' && (
          <path d="M36.8 61.5 C30.2 65 26.4 74.5 28.2 83.5 C29 88 32.4 89.6 35.4 87 C39.6 83.2 41.2 72.5 40 64.4 C39.6 61 38.6 60.4 36.8 61.5 Z"
            fill="#161D30" stroke="#2A3654" strokeWidth="1.2" />
        )}
        <path d="M83.2 61.5 C89.8 65 93.6 74.5 91.8 83.5 C91 88 87.6 89.6 84.6 87 C80.4 83.2 78.8 72.5 80 64.4 C80.4 61 81.4 60.4 83.2 61.5 Z"
          fill="#161D30" stroke="#2A3654" strokeWidth="1.2" />

        {/* 腳（蹼形 + 趾縫） */}
        <g>
          <path d="M46 99.5 C41 99.5 38 101.4 38 103.6 C38 105.7 41.4 106.9 46 106.9 C50.6 106.9 54 105.7 54 103.6 C54 101.4 51 99.5 46 99.5 Z" fill="url(#pori-beak)" />
          <path d="M74 99.5 C69 99.5 66 101.4 66 103.6 C66 105.7 69.4 106.9 74 106.9 C78.6 106.9 82 105.7 82 103.6 C82 101.4 79 99.5 74 99.5 Z" fill="url(#pori-beak)" />
          <g stroke="#D88A1F" strokeWidth="1.1" strokeLinecap="round" opacity="0.8">
            <path d="M43.6 100.4 43.2 104.8 M48.4 100.4 48.8 104.8" />
            <path d="M71.6 100.4 71.2 104.8 M76.4 100.4 76.8 104.8" />
          </g>
        </g>

        {/* 身體（一體成形：大頭、微腰、圓臀） */}
        <path d="M60 22 C78 22 89.5 35 89.5 51.5 C89.5 58.5 87.5 64.5 84 69.5 C91 77 94.3 86.5 93.2 94 C91.6 103.2 77.5 107.5 60 107.5 C42.5 107.5 28.4 103.2 26.8 94 C25.7 86.5 29 77 36 69.5 C32.5 64.5 30.5 58.5 30.5 51.5 C30.5 35 42 22 60 22 Z"
          fill="url(#pori-body)" stroke="#2A3654" strokeWidth="1.5" />
        {/* 頭頂環境光 */}
        <path d="M42 30.5 C47 25.5 54 23.6 60 23.6 C66 23.6 73 25.5 78 30.5 C71.5 27 66 26 60 26 C54 26 48.5 27 42 30.5 Z"
          fill="#FFFFFF" opacity="0.08" />

        {/* 臉頰雙拱白面 + 肚（一體） */}
        <path d="M60 49.5 C56.5 41.5 50 37.5 44 38.2 C36 39.2 31.2 46.5 33 55 C30.2 64 29.6 75 31.8 84.5 C34.6 96 45.5 102.8 60 102.8 C74.5 102.8 85.4 96 88.2 84.5 C90.4 75 89.8 64 87 55 C88.8 46.5 84 39.2 76 38.2 C70 37.5 63.5 41.5 60 49.5 Z"
          fill="url(#pori-belly)" />

        {/* 眼睛（error 時打叉） */}
        {pose === 'error'
          ? <g stroke="#10141F" strokeWidth="2.6" strokeLinecap="round">
              <path d="M43.5 49 50.5 56 M50.5 49 43.5 56" />
              <path d="M69.5 49 76.5 56 M76.5 49 69.5 56" />
            </g>
          : <g>
              <circle cx="47" cy="52.5" r="5" fill="#10141F" />
              <circle cx="73" cy="52.5" r="5" fill="#10141F" />
              <circle cx="45.2" cy="50.6" r="1.9" fill="#FFFFFF" />
              <circle cx="48.7" cy="54.2" r="0.9" fill="#FFFFFF" opacity="0.85" />
              <circle cx="71.2" cy="50.6" r="1.9" fill="#FFFFFF" />
              <circle cx="74.7" cy="54.2" r="0.9" fill="#FFFFFF" opacity="0.85" />
            </g>}

        {/* 腮紅 */}
        <ellipse cx="39.5" cy="61" rx="4.2" ry="2.4" fill="#FF9AA8" opacity="0.4" />
        <ellipse cx="80.5" cy="61" rx="4.2" ry="2.4" fill="#FF9AA8" opacity="0.4" />

        {/* 喙（上下瓣 + 高光） */}
        <path d="M54 57.2 C56 55.8 64 55.8 66 57.2 C65 62.8 62.5 65 60 65 C57.5 65 55 62.8 54 57.2 Z" fill="url(#pori-beak)" />
        <path d="M55.2 60.8 C57 62.6 63 62.6 64.8 60.8 C64 63.4 62.2 64.8 60 64.8 C57.8 64.8 56 63.4 55.2 60.8 Z" fill="#E08222" opacity="0.55" />
        <path d="M56.4 57.6 C57.6 57 59 56.8 60 56.8" stroke="#FFE2A6" strokeWidth="1.1" strokeLinecap="round" fill="none" />

        {/* 圍巾：繞頸帶 + 絲光 + 結 + 飄逸尾端（流蘇切口） */}
        <path d="M32.6 65 C43 72.6 77 72.6 87.4 65 C89 68.6 89.2 72.2 87.8 75.8 C75.5 83.6 44.5 83.6 32.2 75.8 C30.8 72.2 31 68.6 32.6 65 Z"
          fill="url(#pori-scarf)" />
        <path d="M35 68.4 C45 74.6 75 74.6 85 68.4" stroke="#FFFFFF" strokeWidth="1.8" strokeLinecap="round" fill="none" opacity="0.3" />
        <path d="M33 74.4 C45 81.4 75 81.4 87 74.4" stroke="#0A0E1A" strokeWidth="1.6" strokeLinecap="round" fill="none" opacity="0.18" />
        <path d="M75 79.5 C83 82.5 90.5 81.5 96.5 76.5 C100 80.5 101.8 86 101 91.5 L94 89.2 L95.4 96.2 C88.5 97.6 80.5 94.3 75 88.8 Z"
          fill="url(#pori-scarf-tail)" />
        <path d="M78.5 84 C85 88 91.5 88.6 97.5 86.2" stroke="#FFFFFF" strokeWidth="1.5" strokeLinecap="round" fill="none" opacity="0.3" />
        <rect x="70.5" y="73.5" width="9.5" height="11.5" rx="3.6" fill="url(#pori-scarf)" stroke="#0A0E1A" strokeOpacity="0.15" strokeWidth="1"
          transform="rotate(-12 75.2 79.2)" />

        {/* wave：左翅前景舉起揮手（垂直鏡像讓翅尖朝上，再微外傾） */}
        {pose === 'wave' && (
          <path d="M36.8 61.5 C30.2 65 26.4 74.5 28.2 83.5 C29 88 32.4 89.6 35.4 87 C39.6 83.2 41.2 72.5 40 64.4 C39.6 61 38.6 60.4 36.8 61.5 Z"
            fill="#1B2338" stroke="#2A3654" strokeWidth="1.2" transform="translate(-4 7) rotate(-18 37 62) translate(0 124) scale(1 -1)" />
        )}
      </g>

      {/* 姿勢道具 */}
      {pose === 'search' && (
        <g transform="rotate(20 96 50)">
          <rect x="93.4" y="58" width="5.2" height="17" rx="2.6" fill="#2A3654" stroke="#3A4A6E" strokeWidth="1" />
          <circle cx="96" cy="49" r="9" fill="rgba(56,189,248,0.12)" stroke="#38BDF8" strokeWidth="2.6" />
          <circle cx="96" cy="49" r="6.6" fill="none" stroke="#9BD9FB" strokeWidth="0.8" opacity="0.5" />
          <path d="M90.8 45.6 C92.2 43.4 94.8 42.2 97.2 42.6" stroke="#FFFFFF" strokeWidth="1.7" strokeLinecap="round" fill="none" opacity="0.6" />
        </g>
      )}
      {pose === 'sweep' && (
        <g>
          <line x1="89" y1="46" x2="100" y2="88" stroke="#B98A4A" strokeWidth="3" strokeLinecap="round" />
          <line x1="89" y1="46" x2="91.6" y2="56" stroke="#8A6435" strokeWidth="3.4" strokeLinecap="round" />
          <path d="M96 86 C92 90 90 96 90.5 102 C97 104.5 106 104 112 100.5 C110.5 94 107 89 102.5 86.5 Z" fill="#FBD46D" />
          <g stroke="#D9A33C" strokeWidth="1.2" strokeLinecap="round" opacity="0.9">
            <path d="M95 90 92.6 100 M99 89.4 97.6 102.4 M103 88.6 102.6 103 M107 89.6 107.6 101.8" />
          </g>
          <rect x="95" y="84.6" width="11" height="4" rx="2" fill="#8A6435" transform="rotate(12 100.5 86.6)" />
        </g>
      )}
      {pose === 'error' && (
        <g>
          <line x1="95" y1="42" x2="95" y2="92" stroke="#9FB0CC" strokeWidth="2.5" strokeLinecap="round" />
          <circle cx="95" cy="41" r="1.8" fill="#9FB0CC" />
          <path d="M95 44 C102 41 108 41 114 44 L114 56 C108 53 102 53 95 56 Z" fill="url(#pori-scarf)" opacity="0.9" />
        </g>
      )}
      {pose === 'happy' && (
        <g fill="currentColor">
          <path d="M103 26 l1.3 3.2 3.2 1.3 -3.2 1.3 -1.3 3.2 -1.3 -3.2 -3.2 -1.3 3.2 -1.3 Z" opacity="0.4" />
          <circle cx="22" cy="30" r="1.6" opacity="0.35" /><circle cx="100" cy="44" r="1" opacity="0.3" />
          <circle cx="86" cy="24" r="1.1" opacity="0.3" /><circle cx="30" cy="52" r="1.1" opacity="0.35" />
        </g>
      )}
    </svg>
  );
}

/* ---------- App Logo（極光圍巾企鵝徽章，依主題切換明暗版） ---------- */
import { useTheme } from '../hooks/useTheme';

export function AppLogo({ size = 40 }: { size?: number }) {
  const [prefs] = useTheme();
  return (
    <img src={prefs.theme === 'dark' ? '/logo-dark.png' : '/logo-light.png'} alt="Miseroda Mail"
      width={size} height={size}
      style={{ borderRadius: Math.round(size * 0.24), flex: 'none', display: 'block' }} />
  );
}

/* ---------- 空狀態 ---------- */
export function EmptyState({ pose, title, sub, action }: { pose: PoriPose; title: string; sub?: string; action?: React.ReactNode }) {
  return (
    <div className="empty-state">
      <div style={{ color: 'var(--text-secondary)' }}><Pori pose={pose} /></div>
      <p className="empty-title">{title}</p>
      {sub && <p className="empty-sub">{sub}</p>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}

/* ---------- 小元件 ---------- */
export function Avatar({ name, size = '' }: { name: string; size?: '' | 'sm' | 'lg' }) {
  return <div className={`avatar ${size}`}>{(name || '?').trim()[0]?.toUpperCase()}</div>;
}

/** 圖片頭像：依序嘗試 sources（站內 → Gravatar），全部失敗回退字首圓圈 */
export function AvatarImg({ name, sources, size = '' }: {
  name: string;
  sources: string[];
  size?: '' | 'sm' | 'lg';
}) {
  const [idx, setIdx] = useState(0);
  const key = sources.join('|');
  useEffect(() => setIdx(0), [key]);
  const src = sources[idx];
  if (!src) return <Avatar name={name} size={size} />;
  return (
    <img className={`avatar ${size}`} src={src} alt={name}
      style={{ objectFit: 'cover' }} loading="lazy"
      onError={() => setIdx((i) => i + 1)} />
  );
}

/* Gravatar 外部頭像查詢已於 2026-09-20 移除（安全掃描 F2 的同類管道；該 hook 本就零呼叫點）。
   要做外部頭像請走伺服器端代理＋預設關閉的偏好設定，不要在前端直連第三方。 */

export function LabelChip({ label }: { label: { name: string; color: string } }) {
  return (
    <span className="chip" style={{ background: label.color + '1F', color: label.color }}>
      <span className="label-dot" style={{ background: label.color, width: 6, height: 6 }}></span>
      {label.name}
    </span>
  );
}

export function Switch({ on, onChange, ariaLabel, disabled }: {
  on: boolean; onChange: (v: boolean) => void; ariaLabel: string; disabled?: boolean;
}) {
  return <button className={`switch ${on ? 'on' : ''}`} role="switch" aria-checked={on} disabled={disabled}
    aria-label={ariaLabel} onClick={() => onChange(!on)}></button>;
}

export function Modal({ title, desc, onClose, children, width }: {
  title: string; desc?: string; onClose: () => void; children?: ReactNode; width?: number;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const fn = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, [onClose]);
  // F13.4 a11y：開啟時 focus 移入、Tab 在 modal 內循環、關閉時 focus 歸還開啟者
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const box = boxRef.current;
    if (!box) return;
    const focusables = () =>
      [...box.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
        .filter((el) => !el.hasAttribute('disabled') && el.offsetParent !== null);
    // 初始 focus：優先第一個表單欄位（恢復表單 Modal 開啟即可打字），否則落在 dialog 容器本身（唸出 aria-label）——
    // 不搶到「關閉」鈕上，避免蓋掉既有 Modal 的 autoFocus 意圖。
    const firstField = [...box.querySelectorAll<HTMLElement>('input, textarea, select')]
      .find((el) => !el.hasAttribute('disabled') && el.offsetParent !== null);
    (firstField ?? box).focus();
    const trap = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const f = focusables();
      if (!f.length) { e.preventDefault(); return; }
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === box)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    box.addEventListener('keydown', trap);
    return () => { box.removeEventListener('keydown', trap); opener?.focus?.(); };
  }, []);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={width ? { width } : undefined} ref={boxRef} tabIndex={-1}
        role="dialog" aria-modal="true" aria-label={title}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ flex: 1 }}>
            <h3>{title}</h3>
            {desc && <p className="desc">{desc}</p>}
          </div>
          <button className="iconbtn" onClick={onClose} aria-label="關閉"><Icon name="x" /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

/* ---------- Undo 倒數環 ---------- */
export function UndoRing({ total, left }: { total: number; left: number }) {
  const r = 10, c = 2 * Math.PI * r;
  const frac = Math.max(0, left / total);
  return (
    <div className="undo-ring">
      <svg width="26" height="26" viewBox="0 0 26 26">
        <circle cx="13" cy="13" r={r} fill="none" stroke="var(--border-subtle)" strokeWidth="2.5" />
        <circle cx="13" cy="13" r={r} fill="none" stroke="var(--accent)" strokeWidth="2.5"
          strokeDasharray={c} strokeDashoffset={c * (1 - frac)} strokeLinecap="round"
          style={{ transition: 'stroke-dashoffset 1s linear' }} />
      </svg>
      <span className="num">{Math.ceil(left)}</span>
    </div>
  );
}

/* ---------- 極光背景 ---------- */
export function AuroraSky({ bands = 3 }: { bands?: number }) {
  const stars = useMemo(() =>
    Array.from({ length: 26 }, (_, i) => ({
      left: ((i * 37) % 100), top: ((i * 53) % 60), delay: (i % 7) * 0.6,
    })), []);
  return (
    <div className="aurora-sky" aria-hidden="true">
      <div className="stars">
        {stars.map((s, i) => (
          <span key={i} className="star" style={{ left: s.left + '%', top: s.top + '%', animationDelay: s.delay + 's' }}></span>
        ))}
      </div>
      <div className="aurora-band" style={{ width: '70%', height: 220, top: '-6%', left: '-10%' }}></div>
      {bands > 1 && <div className="aurora-band" style={{ width: '55%', height: 180, top: '8%', right: '-12%', animationDelay: '-9s' }}></div>}
      {bands > 2 && <div className="aurora-band" style={{ width: '40%', height: 140, top: '30%', left: '20%', opacity: 0.22, animationDelay: '-17s' }}></div>}
    </div>
  );
}

/* ---------- 附件預覽 Lightbox ---------- */
export interface LightboxAtt {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

export function Lightbox({ att, onClose, onDownload }: {
  att: LightboxAtt;
  onClose: () => void;
  onDownload: (att: LightboxAtt) => void;
}) {
  useEffect(() => {
    const fn = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, [onClose]);
  const isImg = att.mimeType.startsWith('image/');
  const isPdf = att.mimeType === 'application/pdf';
  const isVideo = att.mimeType.startsWith('video/');
  const isAudio = att.mimeType.startsWith('audio/');
  // 文字/markdown/程式碼/json/xml → fetch 前 N KB 以 <pre> 顯示（React 轉義，無 XSS）。F5.2
  const isText = att.mimeType.startsWith('text/') || /\b(json|xml|javascript|x-yaml|markdown)\b/.test(att.mimeType);
  const fmtSize = att.sizeBytes >= 1048576
    ? `${(att.sizeBytes / 1048576).toFixed(1)} MB`
    : `${Math.max(1, Math.round(att.sizeBytes / 1024))} KB`;
  const inlineUrl = `/api/v1/attachments/${att.id}?inline=1`;
  const [textBody, setTextBody] = useState<{ text: string; truncated: boolean } | null>(null);
  const [textErr, setTextErr] = useState(false);
  useEffect(() => {
    if (!isText) return;
    let alive = true;
    const CAP = 256 * 1024; // 只取前 256KB（串流讀取後即取消，不下載整個大檔）
    const ctrl = new AbortController();
    void (async () => {
      try {
        const r = await fetch(`/api/v1/attachments/${att.id}`, { credentials: 'same-origin', signal: ctrl.signal });
        if (!r.ok || !r.body) throw new Error('fetch');
        const reader = r.body.getReader();
        const buf = new Uint8Array(CAP);
        let total = 0;
        let truncated = false;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            const take = Math.min(value.length, CAP - total);
            buf.set(value.subarray(0, take), total);
            total += take;
            if (total >= CAP) { truncated = true; break; }
          }
        }
        void reader.cancel().catch(() => {}); // 取消其餘下載
        if (!alive) return;
        setTextBody({ text: new TextDecoder('utf-8', { fatal: false }).decode(buf.subarray(0, total)), truncated });
      } catch {
        if (alive) setTextErr(true);
      }
    })();
    return () => { alive = false; ctrl.abort(); };
  }, [att.id, isText]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="lightbox-card" role="dialog" aria-label={`預覽 ${att.filename}`}>
        <div className="lightbox-head">
          <span className="attach-icon"><Icon name={isImg ? 'img' : 'pdf'} size={16} /></span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="lightbox-name">{att.filename}</div>
            <div className="lightbox-size">{fmtSize} · 經授權代理自 R2 載入</div>
          </div>
          <button className="btn btn-secondary btn-sm" onClick={() => onDownload(att)}>
            <Icon name="download" size={14} /> 下載
          </button>
          <button className="iconbtn" onClick={onClose} aria-label="關閉"><Icon name="x" /></button>
        </div>
        <div className="lightbox-body">
          {isImg && (
            <img src={inlineUrl} alt={att.filename}
              style={{ maxWidth: '100%', maxHeight: '70vh', display: 'block', margin: '0 auto', borderRadius: 10 }} />
          )}
          {isPdf && (
            <iframe src={inlineUrl} title={att.filename}
              style={{ width: '100%', height: 460, border: '1px solid var(--border-subtle)', borderRadius: 10 }} />
          )}
          {isVideo && (
            <video src={inlineUrl} controls preload="metadata"
              style={{ maxWidth: '100%', maxHeight: '70vh', display: 'block', margin: '0 auto', borderRadius: 10, background: '#000' }} />
          )}
          {isAudio && (
            <audio src={inlineUrl} controls style={{ width: '100%', marginTop: 24 }} />
          )}
          {isText && (
            textErr ? (
              <div className="imgph" style={{ height: 120 }}>無法載入文字內容 — 請下載檢視</div>
            ) : textBody === null ? (
              <div className="imgph" style={{ height: 120 }}>載入中…</div>
            ) : (
              <>
                <pre style={{ maxHeight: '68vh', overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                  fontSize: 13, lineHeight: 1.55, fontFamily: 'var(--font-mono)', background: 'var(--bg-subtle, #1112)', padding: 14, borderRadius: 10, margin: 0 }}>{textBody.text}</pre>
                {textBody.truncated && <div className="lightbox-size" style={{ marginTop: 8 }}>只顯示前 256 KB · 完整內容請下載</div>}
              </>
            )
          )}
          {!isImg && !isPdf && !isVideo && !isAudio && !isText && (
            <div className="imgph" style={{ height: 200 }}>
              此格式不支援預覽 — 請下載檢視（{att.mimeType}）
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------- 工具 ---------- */
export function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.round(diff / 60000);
  if (min < 1) return '剛剛';
  if (min < 60) return `${min} 分鐘前`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} 小時前`;
  const dt = new Date(ts);
  return `${dt.getMonth() + 1}/${dt.getDate()}`;
}

export function fullTime(ts: number): string {
  const dt = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}/${dt.getMonth() + 1}/${dt.getDate()} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
}

/** 捲動邊緣霧化：依捲動位置設定 --fog-top / --fog-bot CSS 變數（搭配 .scroll-fog） */
export function useScrollFog<T extends HTMLElement>(): React.RefObject<T | null> {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      el.style.setProperty('--fog-top', el.scrollTop > 4 ? '16px' : '0px');
      el.style.setProperty('--fog-bot', el.scrollTop + el.clientHeight < el.scrollHeight - 4 ? '16px' : '0px');
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
    };
  });
  return ref;
}

export function highlight(text: string, q: string): ReactNode {
  if (!q || !text) return text;
  const idx: number[] = [];
  const lower = text.toLowerCase(), needle = q.toLowerCase();
  let i = lower.indexOf(needle);
  while (i !== -1 && idx.length < 20) { idx.push(i); i = lower.indexOf(needle, i + needle.length); }
  if (!idx.length) return text;
  const out: ReactNode[] = []; let last = 0;
  idx.forEach((start, k) => {
    out.push(text.slice(last, start));
    out.push(<mark key={k}>{text.slice(start, start + q.length)}</mark>);
    last = start + q.length;
  });
  out.push(text.slice(last));
  return out;
}
