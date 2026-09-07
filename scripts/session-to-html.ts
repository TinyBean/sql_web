import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";
import {
  migrateSessionEntries,
  type FileEntry,
  type ModelChangeEntry,
  type SessionEntry,
  type SessionHeader,
  type SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import {
  serializeMessages,
  type TranscriptSourceMessage,
} from "../src/server/agent/agent-sessions.ts";
import type { ChatMessage } from "../src/shared/contracts.ts";

const SESSION_ID_PATTERN = /^[A-Za-z0-9-]{8,100}$/u;
const HTML_EXTENSION_PATTERN = /\.html?$/iu;

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.basename(path.resolve(moduleDirectory, "..")) === "dist"
  ? path.resolve(moduleDirectory, "../..")
  : path.resolve(moduleDirectory, "..");

export interface SessionHtmlBranch {
  readonly leafId: string;
  readonly label: string;
  readonly current: boolean;
  readonly updatedAt: string;
  readonly model: string | null;
  readonly messages: readonly ChatMessage[];
  /** References the de-duplicated, file-ordered entries in SessionHtmlData.entries. */
  readonly entryIds: readonly string[];
}

export interface SessionHtmlData {
  readonly formatVersion: 1;
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly exportedAt: string;
  readonly sourceFile: string;
  readonly header: SessionHeader;
  /** All persisted entries exactly once and in physical JSONL order. */
  readonly entries: readonly SessionEntry[];
  readonly warnings: readonly SessionParseWarning[];
  readonly branches: readonly SessionHtmlBranch[];
}

export interface SessionParseWarning {
  readonly line: number;
  readonly message: string;
  readonly raw: string;
}

export interface SessionHtmlExportOptions {
  readonly input: string;
  readonly outputPath?: string;
  readonly sessionDir?: string;
  readonly now?: Date;
}

interface ParsedSession {
  readonly header: SessionHeader;
  readonly entries: readonly SessionEntry[];
  readonly warnings: readonly SessionParseWarning[];
}

interface CommandArguments {
  readonly input: string;
  readonly outputPath?: string;
  readonly sessionDir?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Parse and migrate a snapshot in memory; the persisted source is never opened for writing. */
export function parsePersistedSession(content: string, sourceName = "session"): ParsedSession {
  if (!content.trim()) throw new Error(`会话文件为空:${sourceName}`);

  const fileEntries: FileEntry[] = [];
  const fileEntryLines: number[] = [];
  const fileEntryRaw: string[] = [];
  const warnings: SessionParseWarning[] = [];
  const lines = content.split(/\r?\n/u);
  const unterminatedTailIndex = content.endsWith("\n") ? -1 : lines.length - 1;
  for (const [index, originalLine] of lines.entries()) {
    if (!originalLine.trim()) continue;
    const line = index === 0 ? originalLine.replace(/^\uFEFF/u, "") : originalLine;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      if (index === unterminatedTailIndex && index > 0) {
        warnings.push({
          line: index + 1,
          message: `末行尚未形成完整 JSON:${errorMessage(error)}`,
          raw: originalLine,
        });
        continue;
      }
      throw new Error(
        `无法解析会话文件 ${sourceName} 第 ${index + 1} 行:${errorMessage(error)}`,
        { cause: error },
      );
    }
    if (!isRecord(parsed) || typeof parsed["type"] !== "string") {
      if (index === unterminatedTailIndex && index > 0) {
        warnings.push({
          line: index + 1,
          message: "末行不是完整的 session 条目",
          raw: originalLine,
        });
        continue;
      }
      throw new Error(`会话文件 ${sourceName} 第 ${index + 1} 行不是有效的 session 条目`);
    }
    fileEntries.push(parsed as unknown as FileEntry);
    fileEntryLines.push(index + 1);
    fileEntryRaw.push(originalLine);
  }

  const first = fileEntries[0];
  if (
    !first || first.type !== "session" || typeof first.id !== "string" ||
    !first.id || typeof first.timestamp !== "string"
  ) {
    throw new Error(`会话文件缺少有效的 session header:${sourceName}`);
  }

  try {
    migrateSessionEntries(fileEntries);
  } catch (error) {
    throw new Error(`无法迁移会话文件 ${sourceName}:${errorMessage(error)}`, { cause: error });
  }

  const header = fileEntries[0];
  if (!header || header.type !== "session") {
    throw new Error(`会话文件缺少有效的 session header:${sourceName}`);
  }

  const entries: SessionEntry[] = [];
  const ids = new Set<string>();
  for (const [index, entry] of fileEntries.slice(1).entries()) {
    const sourceIndex = index + 1;
    const lineNumber = fileEntryLines[sourceIndex] ?? index + 2;
    if (
      entry.type === "session" || typeof entry.id !== "string" || !entry.id ||
      (entry.parentId !== null && typeof entry.parentId !== "string") ||
      typeof entry.timestamp !== "string"
    ) {
      if (lineNumber - 1 === unterminatedTailIndex) {
        warnings.push({
          line: lineNumber,
          message: "末行不是完整的 session 条目",
          raw: fileEntryRaw[sourceIndex] ?? JSON.stringify(entry),
        });
        continue;
      }
      throw new Error(`会话文件 ${sourceName} 第 ${lineNumber} 行不是有效的 session 条目`);
    }
    if (ids.has(entry.id)) {
      throw new Error(`会话文件包含重复的条目 ID:${entry.id}`);
    }
    if (entry.parentId !== null && !ids.has(entry.parentId)) {
      throw new Error(`会话条目 ${entry.id} 引用了尚未出现的父条目 ${entry.parentId}`);
    }
    ids.add(entry.id);
    entries.push(entry);
  }

  return { header, entries, warnings };
}

function pathToLeaf(
  leaf: SessionEntry,
  entriesById: ReadonlyMap<string, SessionEntry>,
): SessionEntry[] {
  const reversed: SessionEntry[] = [];
  const visited = new Set<string>();
  let current: SessionEntry | undefined = leaf;
  while (current) {
    if (visited.has(current.id)) throw new Error(`会话条目形成循环:${current.id}`);
    visited.add(current.id);
    reversed.push(current);
    if (current.parentId === null) break;
    const parentId: string = current.parentId;
    current = entriesById.get(parentId);
    if (!current) throw new Error(`会话条目 ${leaf.id} 引用了不存在的父条目 ${parentId}`);
  }
  return reversed.reverse();
}

function sourceMessage(entry: SessionMessageEntry): TranscriptSourceMessage | null {
  const message: unknown = entry.message;
  if (!isRecord(message) || typeof message["role"] !== "string") return null;
  const timestamp = message["timestamp"];
  if (typeof timestamp === "number") return message as unknown as TranscriptSourceMessage;
  const entryTimestamp = Date.parse(entry.timestamp);
  return {
    ...(message as unknown as TranscriptSourceMessage),
    ...(Number.isFinite(entryTimestamp) ? { timestamp: entryTimestamp } : {}),
  };
}

function branchModel(entries: readonly SessionEntry[]): string | null {
  const model = entries.findLast((entry): entry is ModelChangeEntry => entry.type === "model_change");
  return model ? `${model.provider}/${model.modelId}` : null;
}

function shortened(value: string, maximum: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  const characters = Array.from(normalized);
  return characters.length <= maximum
    ? normalized
    : `${characters.slice(0, maximum).join("")}…`;
}

function branchLabel(messages: readonly ChatMessage[], index: number): string {
  const lastUserMessage = messages.findLast((message) => message.role === "user");
  const suffix = lastUserMessage ? shortened(lastUserMessage.text, 38) : "无用户消息";
  return `分支 ${index + 1} · ${suffix}`;
}

function sessionTitle(entries: readonly SessionEntry[], currentMessages: readonly ChatMessage[]): string {
  const named = entries.findLast((entry) => (
    entry.type === "session_info" && typeof entry.name === "string" && Boolean(entry.name.trim())
  ));
  if (named?.type === "session_info" && named.name?.trim()) return shortened(named.name, 80);
  const firstUserMessage = currentMessages.find((message) => message.role === "user");
  return firstUserMessage ? shortened(firstUserMessage.text, 80) : "会话记录";
}

export function buildSessionHtmlData(
  parsed: ParsedSession,
  sourceFile: string,
  now = new Date(),
): SessionHtmlData {
  if (!parsed.entries.length) {
    return {
      formatVersion: 1,
      id: parsed.header.id,
      title: "会话记录",
      createdAt: parsed.header.timestamp,
      exportedAt: now.toISOString(),
      sourceFile: path.basename(sourceFile),
      header: parsed.header,
      entries: [],
      warnings: parsed.warnings,
      branches: [{
        leafId: parsed.header.id,
        label: "分支 1 · 无持久化条目",
        current: true,
        updatedAt: parsed.header.timestamp,
        model: null,
        messages: [],
        entryIds: [],
      }],
    };
  }

  const entriesById = new Map<string, SessionEntry>();
  const parentIds = new Set<string>();
  for (const entry of parsed.entries) {
    entriesById.set(entry.id, entry);
    if (entry.parentId !== null) parentIds.add(entry.parentId);
  }
  // Validate every chain, including malformed cycles that would otherwise have no leaf.
  for (const entry of parsed.entries) pathToLeaf(entry, entriesById);

  const currentLeafId = parsed.entries.at(-1)?.id;
  const leaves = parsed.entries
    .filter((entry) => !parentIds.has(entry.id))
    .sort((left, right) => {
      if (left.id === currentLeafId) return -1;
      if (right.id === currentLeafId) return 1;
      return Date.parse(right.timestamp) - Date.parse(left.timestamp);
    });

  const candidates = leaves.map((leaf) => {
    const pathEntries = pathToLeaf(leaf, entriesById);
    const messages = serializeMessages(
      pathEntries
        .filter((entry): entry is SessionMessageEntry => entry.type === "message")
        .map(sourceMessage)
        .filter((message): message is TranscriptSourceMessage => message !== null),
    );
    return {
      leaf,
      pathEntries,
      messages,
      current: leaf.id === currentLeafId,
    };
  });

  if (!candidates.length) throw new Error("会话中没有可导出的分支");

  const branches: SessionHtmlBranch[] = candidates.map((candidate, index) => ({
    leafId: candidate.leaf.id,
    label: branchLabel(candidate.messages, index),
    current: candidate.current,
    updatedAt: candidate.leaf.timestamp,
    model: branchModel(candidate.pathEntries),
    messages: candidate.messages,
    entryIds: candidate.pathEntries.map((entry) => entry.id),
  }));
  const currentBranch = branches.find((branch) => branch.current) ?? branches[0];
  if (!currentBranch) throw new Error("无法确定会话的当前分支");

  return {
    formatVersion: 1,
    id: parsed.header.id,
    title: sessionTitle(parsed.entries, currentBranch.messages),
    createdAt: parsed.header.timestamp,
    exportedAt: now.toISOString(),
    sourceFile: path.basename(sourceFile),
    header: parsed.header,
    entries: parsed.entries,
    warnings: parsed.warnings,
    branches,
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const VIEWER_CSS = String.raw`
:root {
  color-scheme: light dark;
  --page: #f4f5f7;
  --surface: #ffffff;
  --surface-soft: #f8fafc;
  --text: #172033;
  --muted: #657086;
  --border: #dfe3ea;
  --accent: #315efb;
  --accent-soft: #e9efff;
  --user: #315efb;
  --user-text: #ffffff;
  --success: #138a52;
  --danger: #c9363e;
  --shadow: 0 12px 34px rgba(30, 42, 66, .09);
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--page); color: var(--text); line-height: 1.65; }
button, input, select { font: inherit; }
.shell { width: min(980px, calc(100% - 32px)); margin: 28px auto 72px; }
.session-header { padding: 24px 26px; border: 1px solid var(--border); border-radius: 18px; background: var(--surface); box-shadow: var(--shadow); }
.eyebrow { margin: 0 0 4px; color: var(--accent); font-size: 12px; font-weight: 750; letter-spacing: .12em; text-transform: uppercase; }
h1 { margin: 0; font-size: clamp(22px, 4vw, 32px); line-height: 1.25; overflow-wrap: anywhere; }
.metadata { display: flex; flex-wrap: wrap; gap: 8px 18px; margin-top: 14px; color: var(--muted); font-size: 13px; }
.metadata span { overflow-wrap: anywhere; }
.toolbar { position: sticky; top: 0; z-index: 10; display: grid; grid-template-columns: minmax(140px, 1fr) minmax(130px, .7fr) minmax(180px, 1.3fr) auto; gap: 10px; margin: 16px 0 22px; padding: 10px; border: 1px solid var(--border); border-radius: 14px; background: color-mix(in srgb, var(--surface) 92%, transparent); backdrop-filter: blur(12px); }
.toolbar select, .toolbar input, .toolbar button { min-width: 0; height: 40px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface-soft); color: var(--text); }
.toolbar select, .toolbar input { padding: 0 12px; }
.toolbar button { padding: 0 14px; cursor: pointer; font-weight: 650; }
.toolbar button:hover { border-color: var(--accent); color: var(--accent); }
.summary { margin: -10px 2px 18px; color: var(--muted); font-size: 13px; }
.transcript { display: flex; flex-direction: column; gap: 18px; }
.message { position: relative; width: min(88%, 790px); border-radius: 16px; box-shadow: 0 5px 16px rgba(30, 42, 66, .055); }
.message.user { align-self: flex-end; padding: 14px 17px; background: var(--user); color: var(--user-text); border-bottom-right-radius: 5px; }
.message.assistant { align-self: flex-start; padding: 18px 20px; border: 1px solid var(--border); background: var(--surface); border-bottom-left-radius: 5px; }
.role { margin-bottom: 7px; font-size: 12px; font-weight: 750; letter-spacing: .06em; opacity: .74; }
.timestamp { margin-top: 8px; font-size: 11px; opacity: .62; text-align: right; }
.markdown { min-width: 0; overflow-wrap: anywhere; }
.markdown > :first-child { margin-top: 0; }
.markdown > :last-child { margin-bottom: 0; }
.markdown pre, .tool-arguments { max-width: 100%; overflow: auto; padding: 13px 14px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface-soft); color: var(--text); font: 12.5px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
.markdown code { padding: .12em .34em; border-radius: 5px; background: var(--surface-soft); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.markdown pre code { padding: 0; background: transparent; }
.markdown table { display: block; max-width: 100%; overflow-x: auto; border-collapse: collapse; }
.markdown th, .markdown td { padding: 7px 10px; border: 1px solid var(--border); }
.markdown blockquote { margin-left: 0; padding-left: 14px; border-left: 3px solid var(--accent); color: var(--muted); }
.markdown a { color: var(--accent); }
.process { margin: 0 0 15px; border: 1px solid var(--border); border-radius: 12px; background: var(--surface-soft); }
.process > summary { padding: 9px 12px; cursor: pointer; color: var(--muted); font-size: 13px; font-weight: 650; }
.process-items { display: flex; flex-direction: column; gap: 10px; padding: 0 11px 11px; }
.process-text { padding: 9px 11px; border-left: 2px solid var(--border); color: var(--muted); font-size: 13px; }
.tool { border: 1px solid var(--border); border-radius: 9px; background: var(--surface); }
.tool > summary { display: flex; align-items: center; gap: 8px; padding: 8px 10px; cursor: pointer; list-style: none; font-size: 13px; }
.tool > summary::-webkit-details-marker { display: none; }
.tool-name { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-weight: 700; }
.tool-status { margin-left: auto; font-size: 12px; }
.tool-status.success { color: var(--success); }
.tool-status.error { color: var(--danger); }
.tool-arguments { margin: 0 10px 10px; }
.generated-image { display: block; width: auto; max-width: 100%; max-height: 70vh; margin: 14px auto; border: 1px solid var(--border); border-radius: 12px; background: var(--surface-soft); cursor: zoom-in; }
.external-image { display: inline-flex; padding: 2px 7px; border: 1px dashed var(--border); border-radius: 6px; color: var(--muted); font-size: 12px; }
.diagnostic { display: flex; flex-direction: column; gap: 12px; }
.timeline-entry { padding: 15px 17px; border: 1px solid var(--border); border-left: 4px solid var(--muted); border-radius: 12px; background: var(--surface); box-shadow: 0 4px 14px rgba(30, 42, 66, .045); }
.timeline-entry[data-entry-type="message"] { border-left-color: var(--accent); }
.timeline-entry[data-message-role="toolResult"] { border-left-color: var(--success); }
.timeline-entry[data-message-role="assistant"] { border-left-color: #8659d9; }
.timeline-entry[data-entry-type="compaction"], .timeline-entry[data-entry-type="branch_summary"] { border-left-color: #d28a16; }
.entry-heading { display: flex; flex-wrap: wrap; align-items: baseline; gap: 7px 12px; margin-bottom: 10px; }
.entry-type { font: 700 13px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: var(--accent); }
.entry-id, .entry-parent, .entry-time { color: var(--muted); font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; overflow-wrap: anywhere; }
.diagnostic-block { margin: 9px 0 0; padding: 11px 12px; border: 1px solid var(--border); border-radius: 9px; background: var(--surface-soft); }
.diagnostic-label { margin-bottom: 6px; color: var(--muted); font-size: 11px; font-weight: 750; letter-spacing: .06em; text-transform: uppercase; }
.diagnostic-pre { max-height: 520px; overflow: auto; margin: 0; color: var(--text); font: 12px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
.thinking { border-color: #8659d9; background: color-mix(in srgb, #8659d9 7%, var(--surface)); }
.raw-json { margin-top: 10px; }
.raw-json > summary, .diagnostic-details > summary { cursor: pointer; color: var(--muted); font-size: 12px; }
.raw-json .diagnostic-pre, .diagnostic-details .diagnostic-pre { margin-top: 8px; padding: 10px; border-radius: 8px; background: var(--surface-soft); }
.content-part { margin-top: 9px; }
.content-part:first-child { margin-top: 0; }
.tool-result-error { color: var(--danger); font-weight: 700; }
.image-strip { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; margin-top: 10px; }
.image-strip figure { margin: 0; min-width: 0; }
.image-strip img { display: block; max-width: 100%; max-height: 420px; margin: 0 auto; border: 1px solid var(--border); border-radius: 9px; cursor: zoom-in; }
.image-strip figcaption { margin-top: 5px; color: var(--muted); font-size: 11px; overflow-wrap: anywhere; }
.parse-warning { padding: 13px 15px; border: 1px solid #d28a16; border-radius: 10px; background: color-mix(in srgb, #d28a16 10%, var(--surface)); }
.parse-warning strong { display: block; color: #b36c00; }
.bootstrap-error { margin: 0; padding: 18px; border: 1px solid #efb4b8; border-radius: 12px; background: #fff1f2; color: var(--danger); white-space: pre-wrap; overflow-wrap: anywhere; }
.empty { padding: 48px 20px; border: 1px dashed var(--border); border-radius: 16px; color: var(--muted); text-align: center; }
.image-dialog { max-width: min(96vw, 1400px); max-height: 94vh; padding: 10px; border: 0; border-radius: 14px; background: var(--surface); box-shadow: var(--shadow); }
.image-dialog::backdrop { background: rgba(4, 9, 20, .78); }
.image-dialog img { display: block; max-width: calc(96vw - 20px); max-height: calc(94vh - 20px); }
@media (prefers-color-scheme: dark) {
  :root { --page: #11151d; --surface: #191f2a; --surface-soft: #141a23; --text: #e8edf6; --muted: #9da9bc; --border: #2d3747; --accent: #83a2ff; --accent-soft: #202d52; --user: #4168dc; --user-text: #fff; --shadow: 0 14px 36px rgba(0, 0, 0, .28); }
}
@media (max-width: 680px) {
  .shell { width: min(100% - 20px, 980px); margin-top: 10px; }
  .session-header { padding: 18px; border-radius: 14px; }
  .toolbar { grid-template-columns: 1fr; position: static; }
  .message { width: 96%; }
}
@media print {
  :root { color-scheme: light; --page: #fff; --surface: #fff; --surface-soft: #f7f7f7; --text: #111; --muted: #555; --border: #ccc; }
  .shell { width: 100%; margin: 0; }
  .toolbar { display: none; }
  .session-header, .message { box-shadow: none; break-inside: avoid; }
  .process { break-inside: avoid; }
}
`;

const VIEWER_JS = String.raw`
(function () {
  "use strict";

  const encoded = document.getElementById("session-data").textContent.trim();
  const binary = atob(encoded);
  const bytes = Uint8Array.from(binary, function (character) { return character.charCodeAt(0); });
  const session = JSON.parse(new TextDecoder("utf-8").decode(bytes));
  const entriesById = new Map((session.entries || []).map(function (entry) { return [entry.id, entry]; }));
  const branchSelect = document.getElementById("branch-select");
  const viewSelect = document.getElementById("view-select");
  const searchInput = document.getElementById("message-search");
  const expandButton = document.getElementById("toggle-process");
  const transcript = document.getElementById("transcript");
  const summary = document.getElementById("branch-summary");
  const dialog = document.getElementById("image-dialog");
  const dialogImage = document.getElementById("dialog-image");
  let expandProcesses = false;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function canonicalGeneratedImageId(source) {
    const prefix = "/__datalens_generated_image__/";
    const normalized = String(source || "").trim();
    if (!normalized.startsWith(prefix)) return null;
    const encodedId = normalized.slice(prefix.length);
    if (!encodedId || encodedId.includes("/")) return null;
    try {
      const id = decodeURIComponent(encodedId);
      const canonical = encodeURIComponent(id).replace(/[!'()*]/g, function (character) {
        return "%" + character.charCodeAt(0).toString(16).toUpperCase();
      });
      return id && canonical === encodedId ? id : null;
    } catch {
      return null;
    }
  }

  function safeLink(value) {
    const normalized = String(value || "").trim();
    return /^(?:https?:|mailto:)/i.test(normalized) ? normalized : null;
  }

  function renderMarkdown(container, source, images, claimedImageIds) {
    if (!source) return;
    const references = [];
    const parser = new marked.Marked({
      breaks: true,
      gfm: true,
      renderer: {
        image: function (token) {
          const index = references.push({ source: token.href, alt: token.text, title: token.title }) - 1;
          return '<span class="markdown-image-reference" id="markdown-image-reference-' + index + '"></span>';
        },
        html: function (token) {
          return escapeHtml(token.text);
        }
      }
    });
    const dirty = parser.parse(String(source), { async: false });
    const clean = DOMPurify.sanitize(dirty, {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ["embed", "form", "iframe", "img", "object", "picture", "script", "source", "style", "template"],
      FORBID_ATTR: ["srcset", "style"],
      ALLOW_DATA_ATTR: false
    });
    const template = document.createElement("template");
    template.innerHTML = String(clean);

    const imagesById = new Map(images.map(function (image) { return [image.id, image]; }));
    template.content.querySelectorAll("span.markdown-image-reference").forEach(function (placeholder) {
      const match = /^markdown-image-reference-(?:0|[1-9]\d*)$/.exec(placeholder.id);
      const index = match ? Number(placeholder.id.slice("markdown-image-reference-".length)) : -1;
      const reference = references[index];
      if (!reference) {
        placeholder.remove();
        return;
      }
      const generatedId = canonicalGeneratedImageId(reference.source);
      if (generatedId) {
        const image = imagesById.get(generatedId);
        if (!image || claimedImageIds.has(generatedId) || image.mimeType !== "image/png") {
          placeholder.remove();
          return;
        }
        claimedImageIds.add(generatedId);
        const rendered = element("img", "generated-image");
        rendered.src = "data:image/png;base64," + image.data;
        rendered.alt = reference.alt || image.alt || "生成图片";
        rendered.loading = "lazy";
        rendered.decoding = "async";
        rendered.addEventListener("click", function () {
          dialogImage.src = rendered.src;
          dialogImage.alt = rendered.alt;
          if (typeof dialog.showModal === "function") dialog.showModal();
        });
        placeholder.replaceWith(rendered);
        return;
      }
      const external = element("span", "external-image", "图片未自动加载：" + (reference.alt || reference.source));
      const href = safeLink(reference.source);
      if (href) {
        const link = element("a", "", external.textContent);
        link.href = href;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        external.replaceChildren(link);
      }
      placeholder.replaceWith(external);
    });

    template.content.querySelectorAll("a").forEach(function (link) {
      const href = safeLink(link.getAttribute("href"));
      if (!href) link.removeAttribute("href");
      else link.setAttribute("href", href);
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    });
    container.append(template.content);
  }

  function formattedTime(timestamp) {
    if ((typeof timestamp !== "number" && typeof timestamp !== "string") || timestamp === "") return "";
    const date = new Date(timestamp);
    return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("zh-CN", { hour12: false });
  }

  function prettyJson(value) {
    try {
      return JSON.stringify(value, null, 2);
    } catch (error) {
      return "[无法序列化: " + String(error) + "]";
    }
  }

  function diagnosticBlock(label, value, className) {
    const block = element("div", "diagnostic-block" + (className ? " " + className : ""));
    block.append(element("div", "diagnostic-label", label));
    const pre = element("pre", "diagnostic-pre");
    pre.textContent = typeof value === "string" ? value : prettyJson(value);
    block.append(pre);
    return block;
  }

  function showImage(source, alt) {
    dialogImage.src = source;
    dialogImage.alt = alt;
    if (typeof dialog.showModal === "function") dialog.showModal();
  }

  function diagnosticImage(candidate, caption) {
    if (!candidate || !/^(?:image\/(?:png|jpeg|gif|webp))$/i.test(String(candidate.mimeType || "")) ||
        typeof candidate.data !== "string") return null;
    try {
      if (btoa(atob(candidate.data)) !== candidate.data) return null;
    } catch {
      return null;
    }
    const figure = element("figure");
    const image = element("img");
    image.src = "data:" + candidate.mimeType.toLowerCase() + ";base64," + candidate.data;
    image.alt = typeof candidate.alt === "string" ? candidate.alt : (caption || "持久化图片");
    image.loading = "lazy";
    image.decoding = "async";
    image.addEventListener("click", function () { showImage(image.src, image.alt); });
    figure.append(image);
    const description = typeof candidate.alt === "string" && candidate.alt ? candidate.alt : caption;
    if (description) figure.append(element("figcaption", "", description));
    return figure;
  }

  function appendDiagnosticImages(container, candidates, label) {
    if (!Array.isArray(candidates)) return;
    const strip = element("div", "image-strip");
    candidates.forEach(function (candidate, index) {
      const figure = diagnosticImage(candidate, label + " #" + (index + 1));
      if (figure) strip.append(figure);
    });
    if (strip.childElementCount) container.append(strip);
  }

  function renderTool(item) {
    const details = element("details", "tool " + (item.isError ? "error" : "success"));
    details.open = expandProcesses;
    const heading = element("summary");
    heading.append(element("span", "tool-name", item.name));
    heading.append(element("span", "tool-status " + (item.isError ? "error" : "success"), item.isError ? "失败" : "成功"));
    const argumentsBlock = element("pre", "tool-arguments");
    argumentsBlock.textContent = JSON.stringify(item.arguments || {}, null, 2);
    details.append(heading, argumentsBlock);
    return details;
  }

  function messageMetadata(message) {
    const metadata = {};
    Object.keys(message || {}).forEach(function (key) {
      if (key !== "content") metadata[key] = message[key];
    });
    if (metadata.details && metadata.details.kind === "code_interpreter" && Array.isArray(metadata.details.images)) {
      metadata.details = Object.assign({}, metadata.details, {
        images: metadata.details.images.map(function (image) {
          return Object.assign({}, image, { data: "[base64: " + String(image && image.data || "").length + " chars]" });
        })
      });
    }
    return metadata;
  }

  function appendDiagnosticContent(container, content, role) {
    if (typeof content === "string") {
      if (role === "user" || role === "assistant") {
        const markdown = element("div", "diagnostic-block markdown");
        renderMarkdown(markdown, content, [], new Set());
        container.append(markdown);
      } else {
        container.append(diagnosticBlock("content", content));
      }
      return;
    }
    if (!Array.isArray(content)) {
      container.append(diagnosticBlock("content", content));
      return;
    }

    content.forEach(function (part, index) {
      const partType = part && typeof part.type === "string" ? part.type : "unknown";
      if (partType === "text" && typeof part.text === "string") {
        if (role === "user" || role === "assistant") {
          const markdown = element("div", "diagnostic-block markdown content-part");
          markdown.prepend(element("div", "diagnostic-label", "content[" + index + "] · text"));
          renderMarkdown(markdown, part.text, [], new Set());
          container.append(markdown);
        } else {
          container.append(diagnosticBlock("content[" + index + "] · text", part.text, "content-part"));
        }
      } else if (partType === "thinking" && typeof part.thinking === "string") {
        container.append(diagnosticBlock("content[" + index + "] · thinking", part.thinking, "thinking content-part"));
      } else if (partType === "toolCall") {
        const block = element("div", "diagnostic-block content-part");
        block.append(element("div", "diagnostic-label", "content[" + index + "] · toolCall"));
        block.append(diagnosticBlock("工具", String(part.name || "unknown") + "\nID: " + String(part.id || "")));
        block.append(diagnosticBlock("arguments", part.arguments || {}));
        container.append(block);
      } else if (partType === "image") {
        const strip = element("div", "diagnostic-block content-part");
        strip.append(element("div", "diagnostic-label", "content[" + index + "] · image"));
        appendDiagnosticImages(strip, [part], "消息图片");
        strip.append(diagnosticBlock("image metadata", Object.assign({}, part, { data: "[base64: " + String(part.data || "").length + " chars]" })));
        container.append(strip);
      } else {
        container.append(diagnosticBlock("content[" + index + "] · " + partType, part, "content-part"));
      }
    });
  }

  function renderDiagnosticMessage(container, message) {
    const role = message && typeof message.role === "string" ? message.role : "unknown";
    const status = role === "toolResult" && message.isError ? " · ERROR" : "";
    container.append(element("div", role === "toolResult" && message.isError ? "tool-result-error" : "", "role: " + role + status));
    appendDiagnosticContent(container, message ? message.content : undefined, role);
    if (role === "toolResult" && message && message.details && message.details.kind === "code_interpreter") {
      const images = element("div", "diagnostic-block");
      images.append(element("div", "diagnostic-label", "details.images"));
      appendDiagnosticImages(images, message.details.images, "代码解释器图片");
      if (images.querySelector("img")) container.append(images);
    }
    container.append(diagnosticBlock("message metadata", messageMetadata(message || {})));
  }

  function renderRawEntry(entry) {
    const article = element("article", "timeline-entry");
    article.dataset.entryType = String(entry.type || "unknown");
    if (entry.type === "message" && entry.message) article.dataset.messageRole = String(entry.message.role || "unknown");
    const heading = element("div", "entry-heading");
    const role = entry.type === "message" && entry.message ? " · " + String(entry.message.role || "unknown") : "";
    heading.append(element("span", "entry-type", String(entry.type || "unknown") + role));
    heading.append(element("span", "entry-id", "id: " + String(entry.id || "")));
    heading.append(element("span", "entry-parent", "parent: " + String(entry.parentId)));
    const time = formattedTime(entry.timestamp);
    if (time) heading.append(element("span", "entry-time", time));
    article.append(heading);

    if (entry.type === "message") {
      renderDiagnosticMessage(article, entry.message || {});
    } else if (entry.type === "compaction") {
      article.append(diagnosticBlock("compaction summary", String(entry.summary || "")));
      article.append(diagnosticBlock("compaction metadata", {
        firstKeptEntryId: entry.firstKeptEntryId,
        tokensBefore: entry.tokensBefore,
        usage: entry.usage,
        details: entry.details,
        fromHook: entry.fromHook
      }));
    } else if (entry.type === "branch_summary") {
      const rendered = element("div", "diagnostic-block markdown");
      rendered.append(element("div", "diagnostic-label", "branch summary"));
      renderMarkdown(rendered, String(entry.summary || ""), [], new Set());
      article.append(rendered);
      article.append(diagnosticBlock("branch metadata", {
        fromId: entry.fromId,
        usage: entry.usage,
        details: entry.details,
        fromHook: entry.fromHook
      }));
    } else if (entry.type === "model_change") {
      article.append(diagnosticBlock("model", String(entry.provider || "") + "/" + String(entry.modelId || "")));
    } else if (entry.type === "thinking_level_change") {
      article.append(diagnosticBlock("thinking level", String(entry.thinkingLevel || "")));
    } else if (entry.type === "session_info") {
      article.append(diagnosticBlock("session name", String(entry.name || "")));
    } else if (entry.type === "label") {
      article.append(diagnosticBlock("label", { targetId: entry.targetId, label: entry.label }));
    } else if (entry.type === "custom_message") {
      appendDiagnosticContent(article, entry.content, "custom_message");
      article.append(diagnosticBlock("custom message metadata", {
        customType: entry.customType,
        display: entry.display,
        details: entry.details
      }));
    } else if (entry.type === "custom") {
      article.append(diagnosticBlock("custom entry · " + String(entry.customType || "unknown"), entry.data));
    } else {
      article.append(diagnosticBlock("entry", entry));
    }

    const raw = element("details", "raw-json");
    raw.append(element("summary", "", "完整 JSON"));
    const loadRawJson = function () {
      if (!raw.open || raw.querySelector("pre")) return;
      const pre = element("pre", "diagnostic-pre");
      pre.textContent = prettyJson(entry);
      raw.append(pre);
    };
    raw.addEventListener("toggle", loadRawJson);
    raw.open = expandProcesses;
    loadRawJson();
    article.append(raw);
    return article;
  }

  function renderHeaderEntry() {
    const article = element("article", "timeline-entry");
    article.dataset.entryType = "session";
    const heading = element("div", "entry-heading");
    heading.append(element("span", "entry-type", "session header"));
    const time = formattedTime(session.header && session.header.timestamp);
    if (time) heading.append(element("span", "entry-time", time));
    article.append(heading, diagnosticBlock("header", session.header));
    return article;
  }

  function renderParseWarning(warning) {
    const block = element("article", "parse-warning");
    block.append(element("strong", "", "解析警告 · 第 " + warning.line + " 行"));
    block.append(element("div", "", warning.message));
    const raw = element("pre", "diagnostic-pre");
    raw.textContent = warning.raw;
    block.append(raw);
    return block;
  }

  function renderMessage(message) {
    const article = element("article", "message " + message.role);
    article.dataset.messageId = message.id;
    article.append(element("div", "role", message.role === "user" ? "你" : "助手"));
    const traceImageIds = new Set();

    if (message.role === "assistant" && Array.isArray(message.trace) && message.trace.length) {
      const process = element("details", "process");
      process.open = expandProcesses;
      process.append(element("summary", "", "会话过程 · " + message.trace.length + " 项"));
      const items = element("div", "process-items");
      message.trace.forEach(function (item) {
        if (item.type === "tool") items.append(renderTool(item));
        else {
          const text = element("div", "process-text markdown");
          renderMarkdown(text, item.text, message.images || [], traceImageIds);
          items.append(text);
        }
      });
      process.append(items);
      article.append(process);
    }

    const body = element("div", "markdown");
    renderMarkdown(body, message.text, message.images || [], new Set());
    article.append(body);
    const time = formattedTime(message.timestamp);
    if (time) article.append(element("div", "timestamp", time));
    return article;
  }

  function applySearch() {
    const query = searchInput.value.trim().toLocaleLowerCase("zh-CN");
    let visible = 0;
    transcript.querySelectorAll(".message, .timeline-entry").forEach(function (entry) {
      const matches = !query || entry.textContent.toLocaleLowerCase("zh-CN").includes(query);
      entry.hidden = !matches;
      if (matches) visible += 1;
    });
    const empty = transcript.querySelector(".empty");
    if (empty) empty.remove();
    if (!visible) transcript.append(element("div", "empty", "没有匹配的消息"));
  }

  function renderSelectedBranch() {
    const branch = session.branches[Number(branchSelect.value)] || session.branches[0];
    transcript.replaceChildren();
    if (!branch) {
      transcript.append(element("div", "empty", "没有可显示的会话分支"));
      return;
    }
    if (viewSelect.value === "conversation") {
      branch.messages.forEach(function (message) { transcript.append(renderMessage(message)); });
    } else {
      const diagnostic = element("div", "diagnostic");
      (session.warnings || []).forEach(function (warning) { diagnostic.append(renderParseWarning(warning)); });
      diagnostic.append(renderHeaderEntry());
      const visibleEntries = viewSelect.value === "diagnostic-all"
        ? session.entries
        : branch.entryIds.map(function (id) { return entriesById.get(id); }).filter(Boolean);
      visibleEntries.forEach(function (entry) { diagnostic.append(renderRawEntry(entry)); });
      transcript.append(diagnostic);
    }
    const userCount = branch.messages.filter(function (message) { return message.role === "user"; }).length;
    const assistantCount = branch.messages.length - userCount;
    const toolCount = branch.messages.reduce(function (count, message) {
      return count + (message.trace || []).filter(function (item) { return item.type === "tool"; }).length;
    }, 0);
    const rawEntryCount = Array.isArray(branch.entryIds) ? branch.entryIds.length : 0;
    summary.textContent = [
      branch.model || "未知模型",
      userCount + " 条提问",
      assistantCount + " 条回答",
      toolCount + " 次工具调用",
      (viewSelect.value === "diagnostic-all" ? session.entries.length + " 个全部条目" : rawEntryCount + " 个分支条目"),
      (session.warnings || []).length ? session.warnings.length + " 个解析警告" : ""
    ].filter(Boolean).join(" · ");
    expandButton.textContent = viewSelect.value === "conversation"
      ? (expandProcesses ? "收起过程" : "展开过程")
      : (expandProcesses ? "收起完整 JSON" : "展开完整 JSON");
    applySearch();
  }

  session.branches.forEach(function (branch, index) {
    const option = element("option", "", branch.label + (branch.current ? "（当前）" : ""));
    option.value = String(index);
    branchSelect.append(option);
  });
  const currentIndex = session.branches.findIndex(function (branch) { return branch.current; });
  branchSelect.value = String(currentIndex >= 0 ? currentIndex : 0);
  branchSelect.hidden = session.branches.length < 2;
  branchSelect.addEventListener("change", renderSelectedBranch);
  viewSelect.addEventListener("change", renderSelectedBranch);
  searchInput.addEventListener("input", applySearch);
  expandButton.addEventListener("click", function () {
    expandProcesses = !expandProcesses;
    const selector = viewSelect.value === "conversation"
      ? "details.process, details.tool"
      : "details.raw-json, details.diagnostic-details";
    transcript.querySelectorAll(selector).forEach(function (details) { details.open = expandProcesses; });
    expandButton.textContent = viewSelect.value === "conversation"
      ? (expandProcesses ? "收起过程" : "展开过程")
      : (expandProcesses ? "收起完整 JSON" : "展开完整 JSON");
  });
  dialog.addEventListener("click", function (event) { if (event.target === dialog) dialog.close(); });
  renderSelectedBranch();
  document.documentElement.dataset.sessionViewerReady = "true";
})();
`;

function browserDependency(relativePath: string): string {
  const dependencyPath = path.join(projectRoot, "node_modules", relativePath);
  try {
    return readFileSync(dependencyPath, "utf8")
      .replace(/\n?\/\/# sourceMappingURL=.*(?:\n)?$/u, "");
  } catch (error) {
    throw new Error(`无法读取 HTML 导出依赖 ${dependencyPath}:${errorMessage(error)}`, { cause: error });
  }
}

function bootstrapSource(): string {
  return String.raw`
(function () {
  "use strict";
  const host = document.currentScript;
  const runtimeData = document.getElementById("viewer-runtime");
  const transcript = document.getElementById("transcript");

  function showFailure(error) {
    console.error(error);
    if (!transcript) return;
    const panel = document.createElement("pre");
    panel.className = "bootstrap-error";
    panel.textContent = "会话查看器初始化失败：" + (error instanceof Error ? error.message : String(error));
    transcript.replaceChildren(panel);
  }

  try {
    if (!host || !host.nonce) throw new Error("缺少脚本安全令牌");
    if (!runtimeData) throw new Error("缺少内嵌查看器数据");
    const binary = atob(runtimeData.textContent.trim());
    const bytes = Uint8Array.from(binary, function (character) { return character.charCodeAt(0); });
    const runtime = document.createElement("script");
    runtime.nonce = host.nonce;
    runtime.textContent = new TextDecoder("utf-8").decode(bytes);
    document.head.appendChild(runtime);
    runtime.remove();
    if (document.documentElement.dataset.sessionViewerReady !== "true") {
      throw new Error("内嵌查看器未能完成初始化");
    }
  } catch (error) {
    showFailure(error);
  }
})();
`;
}

function assertRawTextBoundary(source: string, kind: "script" | "style", label: string): void {
  const closingPattern = kind === "script" ? /<\/script/iu : /<\/style/iu;
  const unsafeScriptState = kind === "script" && (
    /<!--/u.test(source) || /<script(?=[\t\n\f\r />])/iu.test(source)
  );
  if (closingPattern.test(source) || unsafeScriptState) {
    throw new Error(`${label} 包含不安全的 HTML ${kind} 边界`);
  }
}

export function renderSessionHtml(data: SessionHtmlData): string {
  const nonce = randomBytes(18).toString("hex");
  const encodedData = Buffer.from(JSON.stringify(data), "utf8").toString("base64");
  const marked = browserDependency(path.join("marked", "lib", "marked.umd.js"));
  const domPurify = browserDependency(path.join("dompurify", "dist", "purify.min.js"));
  const runtime = [marked, domPurify, VIEWER_JS, "//# sourceURL=sql-web-session-viewer.js"].join("\n;\n");
  const encodedRuntime = Buffer.from(runtime, "utf8").toString("base64");
  const bootstrap = bootstrapSource();
  assertRawTextBoundary(VIEWER_CSS, "style", "查看器样式");
  assertRawTextBoundary(bootstrap, "script", "查看器启动脚本");
  const title = escapeHtml(`${data.title} · 会话记录`);
  const createdAt = escapeHtml(data.createdAt);
  const exportedAt = escapeHtml(data.exportedAt);
  const sourceFile = escapeHtml(data.sourceFile);
  const sessionId = escapeHtml(data.id);

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
  <title>${title}</title>
  <style nonce="${nonce}">${VIEWER_CSS}</style>
</head>
<body>
  <main class="shell">
    <header class="session-header">
      <p class="eyebrow">SQL Web · Session Archive</p>
      <h1>${escapeHtml(data.title)}</h1>
      <div class="metadata">
        <span>会话 ID：${sessionId}</span>
        <span>创建：${createdAt}</span>
        <span>导出：${exportedAt}</span>
        <span>来源：${sourceFile}</span>
      </div>
    </header>
    <div class="toolbar" aria-label="会话查看工具">
      <select id="branch-select" aria-label="选择会话分支"></select>
      <select id="view-select" aria-label="选择查看模式">
        <option value="diagnostic-all">全部事件（文件顺序）</option>
        <option value="diagnostic-branch">当前分支诊断</option>
        <option value="conversation">对话视图</option>
      </select>
      <input id="message-search" type="search" placeholder="搜索当前分支" aria-label="搜索当前分支">
      <button id="toggle-process" type="button">展开完整 JSON</button>
    </div>
    <div id="branch-summary" class="summary"></div>
    <section id="transcript" class="transcript" aria-live="polite"></section>
  </main>
  <dialog id="image-dialog" class="image-dialog"><img id="dialog-image" alt=""></dialog>
  <script id="session-data" type="application/json">${encodedData}</script>
  <script id="viewer-runtime" type="application/octet-stream">${encodedRuntime}</script>
  <script nonce="${nonce}" id="viewer-bootstrap">${bootstrap}</script>
</body>
</html>
`;
}

function configuredSessionDirectory(): string {
  let fileValue: string | undefined;
  try {
    fileValue = parseEnv(readFileSync(path.join(projectRoot, ".env"), "utf8"))["SQL_WEB_SESSION_DIR"];
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  return path.resolve(projectRoot, process.env["SQL_WEB_SESSION_DIR"] ?? fileValue ?? ".data/sessions");
}

function sessionFiles(sessionDir: string): string[] {
  try {
    return readdirSync(sessionDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => path.join(sessionDir, entry.name));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(`会话目录不存在:${sessionDir}`, { cause: error });
    }
    throw error;
  }
}

export function resolveSessionFile(input: string, sessionDir?: string): string {
  const normalized = input.trim();
  if (!normalized) throw new Error("必须指定 session ID、JSONL 文件或 latest");

  const directPath = path.resolve(process.cwd(), normalized);
  if (existsSync(directPath)) {
    if (!statSync(directPath).isFile()) throw new Error(`session 路径不是文件:${directPath}`);
    return directPath;
  }

  const looksLikePath = path.isAbsolute(normalized) || normalized.endsWith(".jsonl") ||
    normalized.includes("/") || normalized.includes("\\");
  if (looksLikePath) throw new Error(`找不到 session 文件:${directPath}`);

  const resolvedSessionDir = path.resolve(sessionDir ?? configuredSessionDirectory());
  const files = sessionFiles(resolvedSessionDir);
  if (normalized === "latest") {
    const latest = files
      .map((filePath) => ({ filePath, modifiedAt: statSync(filePath).mtimeMs }))
      .sort((left, right) => right.modifiedAt - left.modifiedAt)[0]?.filePath;
    if (!latest) throw new Error(`会话目录中没有 JSONL 文件:${resolvedSessionDir}`);
    return latest;
  }

  if (!SESSION_ID_PATTERN.test(normalized)) {
    throw new Error(`无效的 session ID:${normalized}`);
  }
  const matches = files.filter((filePath) => (
    path.basename(filePath) === `${normalized}.jsonl` ||
    path.basename(filePath).endsWith(`_${normalized}.jsonl`)
  ));
  if (!matches.length) throw new Error(`找不到会话 ${normalized}（目录:${resolvedSessionDir}）`);
  if (matches.length > 1) throw new Error(`会话 ID ${normalized} 匹配到多个文件`);
  const match = matches[0];
  if (!match) throw new Error(`找不到会话 ${normalized}`);
  return match;
}

function defaultOutputPath(sessionFile: string): string {
  const basename = path.basename(sessionFile, path.extname(sessionFile));
  return path.join(projectRoot, ".data", "session-exports", `${basename}.html`);
}

export function exportSessionHtml(options: SessionHtmlExportOptions): string {
  const sessionFile = resolveSessionFile(
    options.input,
    options.sessionDir ? path.resolve(options.sessionDir) : undefined,
  );
  const outputPath = options.outputPath
    ? path.resolve(process.cwd(), options.outputPath)
    : defaultOutputPath(sessionFile);
  if (!HTML_EXTENSION_PATTERN.test(outputPath)) {
    throw new Error(`输出文件必须使用 .html 或 .htm 扩展名:${outputPath}`);
  }
  const content = readFileSync(sessionFile, "utf8");
  const parsed = parsePersistedSession(content, sessionFile);
  const data = buildSessionHtmlData(parsed, sessionFile, options.now ?? new Date());
  const html = renderSessionHtml(data);
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, html, { encoding: "utf8", mode: 0o600 });
  chmodSync(outputPath, 0o600);
  return outputPath;
}

function usage(): string {
  return [
    "用法:",
    "  npm run session:html -- <session-id|session.jsonl|latest> [output.html]",
    "  npm run session:html -- --session-dir <directory> <session-id|latest> [output.html]",
    "",
    "未指定输出文件时，将写入 .data/session-exports/<session-file>.html。",
  ].join("\n");
}

function parseCommandArguments(args: readonly string[]): CommandArguments | null {
  if (args.includes("--help") || args.includes("-h")) return null;
  const positional: string[] = [];
  let sessionDir: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--session-dir") {
      const value = args[index + 1];
      if (!value) throw new Error("--session-dir 缺少目录参数");
      sessionDir = value;
      index += 1;
    } else if (argument?.startsWith("-")) {
      throw new Error(`未知参数:${argument}`);
    } else if (argument !== undefined) {
      positional.push(argument);
    }
  }
  const input = positional[0];
  if (!input || positional.length > 2) throw new Error(usage());
  return {
    input,
    ...(positional[1] ? { outputPath: positional[1] } : {}),
    ...(sessionDir ? { sessionDir } : {}),
  };
}

async function main(): Promise<void> {
  const command = parseCommandArguments(process.argv.slice(2));
  if (!command) {
    console.log(usage());
    return;
  }
  const outputPath = exportSessionHtml(command);
  console.log(`已导出会话 HTML:${outputPath}`);
  console.log("提示:导出文件包含会话正文、工具参数和生成图片,请按敏感数据妥善保管。");
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  await main().catch((error: unknown) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
