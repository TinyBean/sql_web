import { closeSync, constants, lstatSync, openSync, readSync, readdirSync } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { readSessionFile, type SessionOwner } from "./session-files.ts";

interface FileSummary {
  owner: SessionOwner | null;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

// Legacy filenames can be arbitrary. Discover identity from the immutable JSONL header.
function readHeaderId(filename: string): string | undefined {
  const fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const buffer = Buffer.alloc(4096);
    const decoder = new StringDecoder("utf8");
    let text = "";
    for (;;) {
      const size = readSync(fd, buffer);
      text = (text + (size ? decoder.write(buffer.subarray(0, size)) : decoder.end())).trimStart();
      const newline = text.indexOf("\n");
      if (newline < 0 && size) continue;
      if (!text) return undefined;
      const header = JSON.parse(newline < 0 ? text : text.slice(0, newline));
      return header?.type === "session" && typeof header.id === "string" ? header.id : undefined;
    }
  } finally { closeSync(fd); }
}

interface IndexedFile {
  path: string;
  id: string;
  version: string;
  summary?: FileSummary;
}

function version(filename: string): string {
  const stat = lstatSync(filename, { bigint: true });
  return `${stat.dev}:${stat.ino}:${stat.ctimeNs}:${stat.size}`;
}

export class SessionDirectory {
  readonly #directory: string;
  #directoryVersion = "";
  #byPath = new Map<string, IndexedFile>();
  #byId = new Map<string, IndexedFile | null>();
  #unidentified = new Map<string, string>();

  constructor(directory: string) { this.#directory = directory; }

  files(): ReadonlyMap<string, IndexedFile | null> {
    const current = version(this.#directory);
    if (this.#directoryVersion === current && !this.#unidentifiedChanged()) return this.#byId;

    const byPath = new Map<string, IndexedFile>();
    const byId = new Map<string, IndexedFile | null>();
    const unidentified = new Map<string, string>();
    for (const entry of readdirSync(this.#directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const filename = path.join(this.#directory, entry.name);
      try {
        const stamp = version(filename);
        let file = this.#byPath.get(filename);
        if (!file || file.version !== stamp) {
          // A writer can finish an initially empty header without changing the directory.
          unidentified.set(filename, stamp);
          const id = readHeaderId(filename);
          if (!id) continue;
          unidentified.delete(filename);
          file = { id, path: filename, version: stamp };
        }
        byPath.set(filename, file);
        byId.set(file.id, byId.has(file.id) ? null : file);
      } catch { /* An incomplete header does not identify a session. */ }
    }
    this.#byPath = byPath;
    this.#byId = byId;
    this.#unidentified = unidentified;
    this.#directoryVersion = current;
    return byId;
  }

  #unidentifiedChanged(): boolean {
    for (const [filename, stamp] of this.#unidentified) {
      try { if (version(filename) !== stamp) return true; }
      catch { return true; }
    }
    return false;
  }

  summary(file: IndexedFile): FileSummary {
    const stamp = version(file.path);
    if (file.summary && stamp === file.version) return file.summary;
    const { header, entries, owner } = readSessionFile(file.path);
    if (header.id !== file.id) throw new Error("会话 ID 已改变");
    const createdAt = new Date(header.timestamp).toISOString();
    let activity: number | undefined;
    let name = "";
    let firstUser = "";
    let messageCount = 0;
    for (const entry of entries) {
      if (entry.type === "session_info") name = entry.name?.trim() ?? "";
      if (entry.type !== "message") continue;
      messageCount++;
      const message = entry.message;
      if (message.role !== "user" && message.role !== "assistant") continue;
      const time = message.timestamp ?? Date.parse(entry.timestamp);
      if (Number.isFinite(time)) activity = Math.max(activity ?? time, time);
      if (message.role === "user" && !firstUser) {
        firstUser = typeof message.content === "string" ? message.content :
          message.content.filter((part) => part.type === "text").map((part) => part.text).join(" ");
      }
    }
    file.summary = { owner, title: name || firstUser || "新会话", createdAt,
      updatedAt: activity === undefined ? createdAt : new Date(activity).toISOString(), messageCount };
    file.version = stamp;
    return file.summary;
  }
}
