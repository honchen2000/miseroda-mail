// F3.1 全部回覆的 cc 計算（純函式，無 DOM → worker 可測）。
// cc = 原信所有收件人 ∪ cc，去掉「自己」與「已放進 to 的人（原寄件者）」，去重、保留原大小寫顯示。
export function computeReplyAllCc(p: {
  to: string[];
  cc: string[];
  fromAddr: string;
  selfEmail: string;
  direction: string;
}): string[] {
  const toAddr = (p.direction === 'outbound' ? p.to[0] ?? '' : p.fromAddr).toLowerCase();
  const self = p.selfEmail.toLowerCase();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [...p.to, ...p.cc]) {
    const a = raw.trim();
    const lo = a.toLowerCase();
    if (!a || lo === self || lo === toAddr || seen.has(lo)) continue;
    seen.add(lo);
    out.push(a);
  }
  return out;
}
