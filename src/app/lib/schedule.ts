// F3.3：排程寄信常用相對時間預設（純函式，無 DOM → worker 可測）。
// 用本地牆鐘時間算（與 DateTimeField/parseLocal 一致）；只回未來時間（過去的預設濾掉）。
export interface SchedulePreset {
  label: string;
  at: number;
}
export function sendSchedulePresets(now: number): SchedulePreset[] {
  const cur = new Date(now);
  // 先把時:分:秒歸零到指定小時、再加天數（避免 setDate 跨月/跨年的順序問題）
  const at = (addDays: number, h: number): number => {
    const x = new Date(now);
    x.setHours(h, 0, 0, 0);
    x.setDate(x.getDate() + addDays);
    return x.getTime();
  };
  const dow = cur.getDay(); // 0=日 .. 1=一
  let toMon = (1 - dow + 7) % 7;
  if (toMon === 0) toMon = 7; // 今天若週一 → 取下週一
  const presets: SchedulePreset[] = [
    { label: '一小時後', at: now + 3_600_000 },
    { label: '今晚 7 點', at: at(0, 19) },
    { label: '明早 8 點', at: at(1, 8) },
    { label: '下週一 9 點', at: at(toMon, 9) },
  ];
  // 只留比現在晚至少 1 分鐘的（今晚已過 19 點就濾掉）
  return presets.filter((p) => p.at > now + 60_000);
}
