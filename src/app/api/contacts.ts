// 聯絡人資料層：與 components/contacts.tsx 拆開，讓 App 只靜態載入 hook（不連帶 bundle 整個聯絡人頁）。
import { useQuery } from '@tanstack/react-query';
import { api } from './client';

export interface ContactRow {
  email: string;
  knownName: string;
  customName: string;
  note: string;
  phone: string;
  company: string; // F4.3a
  title: string;
  birthday: string;
  address: string;
  count: number;
  lastUsed: number;
}

export function useContacts(enabled = true) {
  return useQuery({
    queryKey: ['contacts'],
    queryFn: () => api<{ contacts: ContactRow[] }>('/contacts'),
    enabled,
    staleTime: 30_000,
  });
}

// 聯絡人群組（F4.3b：一鍵寄給家人）
export interface ContactGroup {
  id: string;
  name: string;
  emails: string[];
}

export function useContactGroups(enabled = true) {
  return useQuery({
    queryKey: ['contact-groups'],
    queryFn: () => api<{ groups: ContactGroup[] }>('/contact-groups'),
    enabled,
    staleTime: 30_000,
  });
}

// 聯絡人 360 聚合（F2.5）：純讀，點開人物抽屜時才查
export interface Contact360 {
  email: string;
  customName: string;
  note: string;
  phone: string;
  totalMessages: number;
  lastContactedAt: number | null;
  authVerdict: { spf?: string; dkim?: string; dmarc?: string } | null;
  messages: { id: string; threadId: string; subject: string; snippet: string; direction: string; receivedAt: number; folder: string }[];
  events: { id: string; summary: string; startMs: number; endMs: number | null; startText: string; allDay: boolean; floating: boolean; location: string }[];
  followUps: { id: string; subject: string; dueAt: number; awaitReply: boolean; threadId: string }[];
}

export function useContact360(email: string | null) {
  return useQuery({
    queryKey: ['contact360', email],
    queryFn: () => api<Contact360>(`/contacts/profile/${encodeURIComponent(email!)}`),
    enabled: !!email,
    staleTime: 15_000,
  });
}

/** email → 自訂名稱 對照（列表/閱讀顯示覆寫用） */
export function useContactNames(): Map<string, string> {
  const contacts = useContacts();
  const map = new Map<string, string>();
  for (const ct of contacts.data?.contacts ?? []) {
    if (ct.customName) map.set(ct.email, ct.customName);
  }
  return map;
}
