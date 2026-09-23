// F8.9：首登 60 秒導覽。3–4 步 overlay，重用 Modal 基建 + Pori 五態。
// 可隨時跳過；完成/跳過都由 onDone 寫入 localStorage 標記（不再顯示）。
import { useState } from 'react';
import { Modal, Pori, type PoriPose } from './ui';

const STEPS: { pose: PoriPose; title: string; desc: string }[] = [
  {
    pose: 'wave',
    title: '歡迎來到 Miseroda Mail 👋',
    desc: '花 60 秒認識一下。畫面分三欄：左邊是資料夾側欄、中間是信件列表、右邊是閱讀窗——一眼掌握全局。',
  },
  {
    pose: 'search',
    title: '⌘K 是你的萬能入口',
    desc: '任何時候按 ⌘K（Windows 為 Ctrl + K）叫出指令面板：寫信、搜尋、跳資料夾、AI 草擬、建立加密連結…全都在這裡。',
  },
  {
    pose: 'happy',
    title: '按 ? 隨時看快捷鍵',
    desc: '常用的有：c 寫信、e 封存、r 回覆、# 刪除、g 之後接 i 回到收件匣。滑鼠一樣能操作，快捷鍵只是更快。',
  },
  {
    pose: 'wave',
    title: 'Pori 幫你收好每封信 🐧',
    desc: '就這樣！Passkey + 兩步驟驗證把關安全，AI 幫你摘要與草擬。開始享受清爽的信箱吧。',
  },
];

export function Onboarding({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0);
  const s = STEPS[step];
  const last = step === STEPS.length - 1;
  return (
    <Modal title={s.title} desc={s.desc} onClose={onDone} width={480}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 18 }}>
        <div style={{ color: 'var(--text-secondary)' }}><Pori pose={s.pose} size={124} /></div>
        <div style={{ display: 'flex', gap: 8 }} aria-hidden="true">
          {STEPS.map((_, i) => (
            <span key={i} style={{
              width: 8, height: 8, borderRadius: '50%',
              background: i === step ? 'var(--accent)' : 'var(--border-subtle)',
              transition: 'background var(--dur-fast) var(--ease-out)',
            }} />
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%' }}>
          <button className="btn btn-ghost" onClick={onDone}>跳過</button>
          <div style={{ flex: 1 }} />
          {step > 0 && <button className="btn btn-secondary" onClick={() => setStep((n) => n - 1)}>上一步</button>}
          <button className="btn btn-primary" onClick={() => (last ? onDone() : setStep((n) => n + 1))}>
            {last ? '開始使用' : `下一步（${step + 1}/${STEPS.length}）`}
          </button>
        </div>
      </div>
    </Modal>
  );
}
