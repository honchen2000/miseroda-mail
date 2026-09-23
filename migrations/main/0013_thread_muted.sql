-- 靜音對話串：muted=1 的 thread，日後新到的信自動跳過收件匣（進封存）並標為已讀。
ALTER TABLE threads ADD COLUMN muted INTEGER NOT NULL DEFAULT 0;
