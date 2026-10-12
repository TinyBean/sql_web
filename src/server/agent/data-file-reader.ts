import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import path from "node:path";

export const MAX_DATA_READ_BYTES = 50 * 1024;
const MAX_JSON_BYTES = 32 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;

export interface DataReadParameters {
  readonly offset?: number;
  readonly limit?: number;
  readonly byte_offset?: number;
  readonly json_pointer?: string;
}

function decode(bytes: Buffer): string {
  if (bytes.includes(0)) throw new Error("read 仅支持 UTF-8 文本文件，不支持二进制文件");
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new Error("read 文件内容不是有效的 UTF-8 文本，或 byte_offset 不在字符边界"); }
}

function characterBoundary(bytes: Buffer, end: number): number {
  while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
  return end;
}

async function readChunk(file: FileHandle, position: number, length: number, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted();
  const bytes = Buffer.alloc(length);
  const { bytesRead } = await file.read(bytes, 0, length, position);
  signal?.throwIfAborted();
  return bytes.subarray(0, bytesRead);
}

async function lineStart(file: FileHandle, size: number, line: number, signal?: AbortSignal): Promise<number> {
  let currentLine = 1;
  let position = 0;
  while (currentLine < line && position < size) {
    const chunk = await readChunk(file, position, Math.min(CHUNK_BYTES, size - position), signal);
    if (!chunk.length) break;
    for (let index = 0; index < chunk.length; index++) {
      if (chunk[index] === 10 && ++currentLine === line) return position + index + 1;
    }
    position += chunk.length;
  }
  return position;
}

async function jsonSource(file: FileHandle, size: number, filename: string, params: DataReadParameters, signal?: AbortSignal) {
  const extension = path.extname(filename).toLowerCase();
  if (![".json", ".jsonl", ".log"].includes(extension)) throw new Error("json_pointer 仅支持 JSON 文件、JSONL 或结构化 .log 日志");
  if (params.limit !== undefined) throw new Error("json_pointer 模式不使用 limit");
  const document = extension === ".json";
  if (document && params.offset !== undefined) throw new Error("JSON 文档字段定位不使用 offset");
  if (document && size > MAX_JSON_BYTES) throw new Error("JSON 文档超过 32 MiB 解析上限");
  const start = document ? 0 : await lineStart(file, size, params.offset ?? 1, signal);
  const chunks: Buffer[] = [];
  let position = start;
  let count = 0;
  while (position < size) {
    const chunk = await readChunk(file, position, Math.min(CHUNK_BYTES, size - position), signal);
    if (!chunk.length) break;
    const newline = document ? -1 : chunk.indexOf(10);
    const selected = newline < 0 ? chunk : chunk.subarray(0, newline);
    count += selected.length;
    if (count > MAX_JSON_BYTES) throw new Error("JSON 记录超过 32 MiB 解析上限");
    chunks.push(selected);
    position += chunk.length;
    if (newline >= 0) break;
  }
  let value: unknown;
  try { value = JSON.parse(decode(Buffer.concat(chunks)).replace(/^\uFEFF/u, "")); }
  catch (error) {
    signal?.throwIfAborted();
    if (error instanceof SyntaxError) throw new Error("JSON 无效或记录尚未写入完整；不能将局部内容视为完整结果");
    throw error;
  }
  return { value, ...(!document ? { recordLine: params.offset ?? 1 } : {}) };
}

function selectPointer(value: unknown, pointer: string): unknown {
  if (pointer === "") return value;
  if (!pointer.startsWith("/")) throw new Error("无效的 JSON Pointer：必须为空字符串或以 / 开头");
  for (const part of pointer.slice(1).split("/")) {
    if (/~(?:[^01]|$)/u.test(part)) throw new Error("无效的 JSON Pointer 转义");
    const key = part.replaceAll("~1", "/").replaceAll("~0", "~");
    if (typeof value !== "object" || value === null || !Object.hasOwn(value, key) ||
        (Array.isArray(value) && !/^(?:0|[1-9]\d*)$/u.test(key))) {
      throw new Error(`JSON Pointer 指定的字段不存在:${pointer}`);
    }
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

/** Bounded file reads; JSON pagination cursors refer to the selected serialized value. */
export async function readDataFile(filename: string, dataRoot: string, params: DataReadParameters, signal?: AbortSignal) {
  if (params.byte_offset !== undefined && (!Number.isSafeInteger(params.byte_offset) || params.byte_offset < 0)) {
    throw new Error("byte_offset 必须是非负安全整数");
  }
  if (params.json_pointer === undefined && params.byte_offset !== undefined &&
      (params.offset !== undefined || params.limit !== undefined)) throw new Error("原始 byte_offset 续读与 offset/limit 行分页互斥");
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    signal?.throwIfAborted();
    const metadata = await file.stat();
    if (!metadata.isFile()) throw new Error("read 仅支持普通文件");
    const header = await readChunk(file, 0, Math.min(4096, metadata.size), signal);
    decode(header.subarray(0, characterBoundary(header, Math.min(4093, header.length))));
    let bytes: Buffer;
    let start: number;
    let totalBytes: number;
    let extra: { jsonPointer?: string; recordLine?: number } = {};
    if (params.json_pointer !== undefined) {
      const source = await jsonSource(file, metadata.size, filename, params, signal);
      signal?.throwIfAborted();
      const projected = Buffer.from(JSON.stringify(selectPointer(source.value, params.json_pointer), null, 2));
      totalBytes = projected.length;
      start = params.byte_offset ?? 0;
      if (start > totalBytes) throw new Error("byte_offset 超出字段定位结果的字节范围");
      bytes = projected.subarray(start, Math.min(totalBytes, start + MAX_DATA_READ_BYTES + 4));
      extra = { jsonPointer: params.json_pointer, ...(source.recordLine ? { recordLine: source.recordLine } : {}) };
    } else {
      totalBytes = metadata.size;
      start = params.byte_offset ?? await lineStart(file, totalBytes, params.offset ?? 1, signal);
      if (start > totalBytes) throw new Error("byte_offset 超出文件字节范围");
      bytes = await readChunk(file, start, Math.min(MAX_DATA_READ_BYTES + 4, totalBytes - start), signal);
      if (!bytes.length && start < totalBytes) throw new Error("文件在读取期间发生变化，请重新读取");
      if (params.byte_offset === undefined) {
        let lines = 0;
        for (let index = 0; index < bytes.length; index++) {
          if (bytes[index] === 10 && ++lines === (params.limit ?? 2000)) {
            bytes = bytes.subarray(0, index + 1);
            break;
          }
        }
      }
    }
    const end = characterBoundary(bytes, Math.min(MAX_DATA_READ_BYTES, bytes.length));
    const selected = bytes.subarray(0, end);
    const text = decode(selected);
    signal?.throwIfAborted();
    const truncated = start + end < totalBytes;
    return {
      content: [{ type: "text" as const, text }],
      details: { path: filename, source: "data" as const, dataRoot, sourceBytes: metadata.size,
        totalBytes, byteOffset: start, returnedBytes: end, truncated,
        nextByteOffset: truncated ? start + end : null, ...extra },
    };
  } finally { await file.close(); }
}
