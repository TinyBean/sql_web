import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { migrateSessionEntries, type FileEntry, type SessionEntry, type SessionHeader, type SessionManager } from "@earendil-works/pi-coding-agent";
import { normalizeAccount } from "../auth.ts";

export const OWNER_ENTRY = "datalens_owner_v1";
export interface SessionOwner { readonly account: string; readonly dashboardId: string }
export interface SessionFile {
  readonly header: SessionHeader;
  readonly entries: SessionEntry[];
  readonly owner: SessionOwner | null;
}

export function readSessionFile(filePath: string): SessionFile {
  const metadata = lstatSync(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("会话必须为普通文件");
  const source = readFileSync(filePath, "utf8");
  const lines = source.split("\n");
  const entries: FileEntry[] = [];
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    try {
      const item: unknown = JSON.parse(line);
      if (!item || typeof item !== "object" || !("type" in item)) throw new Error("无效会话条目");
      entries.push(item as FileEntry);
    } catch (error) {
      if (index === lines.length - 1 && !source.endsWith("\n")) break;
      throw error;
    }
  }
  const header = entries[0];
  if (!header || header.type !== "session" || !/^[A-Za-z0-9-]{8,100}$/u.test(header.id)) throw new Error("会话 header 无效");
  migrateSessionEntries(entries); // Migration is deliberately in memory only.
  const records = entries.filter((item) => item.type === "custom" && item.customType === OWNER_ENTRY);
  const parts = path.basename(filePath).split("__");
  const watermarked = parts.length > 1;
  let owner: SessionOwner | null = null;
  if (records.length || watermarked) {
    const record = records[0];
    if (records.length !== 1 || !record || record.type !== "custom" || !record.data || typeof record.data !== "object") {
      throw new Error("会话归属缺失或冲突");
    }
    const data = record.data as Record<string, unknown>;
    const account = normalizeAccount(data["account"]);
    if (data["account"] !== account || typeof data["dashboardId"] !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/u.test(data["dashboardId"]) ||
        parts.length !== 3 || parts[0] !== account || parts[2] !== `${header.id}.jsonl`) {
      throw new Error("会话归属与文件水印不一致");
    }
    owner = { account, dashboardId: data["dashboardId"] };
  }
  return { header, entries: entries.filter((item): item is SessionEntry => item.type !== "session"), owner };
}

export function sessionBranch(entries: readonly SessionEntry[]): SessionEntry[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const branch: SessionEntry[] = [];
  const visited = new Set<string>();
  let current = entries.at(-1);
  while (current) {
    if (visited.has(current.id)) throw new Error("会话分支存在循环");
    visited.add(current.id);
    branch.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return branch.reverse();
}

export function persistOwnedSession(directory: string, manager: SessionManager, owner: SessionOwner): string {
  const header = manager.getHeader();
  if (!header) throw new Error("会话缺少 header");
  const timestamp = header.timestamp.replace(/[:.]/gu, "-");
  const filePath = path.join(directory, `${owner.account}__${timestamp}__${header.id}.jsonl`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.session-${randomUUID()}.tmp`);
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    try {
      writeFileSync(descriptor, [header, ...manager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
      fsyncSync(descriptor);
    } finally { closeSync(descriptor); }
    renameSync(temporary, filePath);
  } finally { rmSync(temporary, { force: true }); }
  return filePath;
}
