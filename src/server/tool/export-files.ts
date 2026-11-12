import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { SessionFile } from "../../shared/contracts.ts";

export const MAX_EXCEL_BYTES = 8 * 1024 * 1024;
export const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const FILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface ExportFileMetadata {
  readonly kind?: "upload" | "edit" | "export";
  readonly parentFileId?: string;
  readonly summary?: string;
  readonly id: string;
  readonly filename: string;
  readonly byteCount: number;
  readonly rowCount: number;
  readonly createdAt: string;
  readonly source: { readonly name: string; readonly version: string; readonly createdAt: string };
}

export interface OpenExportFile {
  readonly metadata: ExportFileMetadata;
  /** The caller owns this descriptor and must close it, including on failed downloads. */
  readonly fd: number;
}

export class ExportFileNotFoundError extends Error {
  constructor() { super("导出文件不存在或不可访问"); this.name = "ExportFileNotFoundError"; }
}

export function excelFilename(value = "OEE查询结果.xlsx"): string {
  const stem = value.normalize("NFKC").replace(/\.xlsx$/iu, "")
    .replace(/[\x00-\x1f\x7f/\\:*?"<>|]/gu, "_").replace(/^[.\s]+|[.\s]+$/gu, "");
  return `${Array.from(stem || "OEE查询结果").slice(0, 80).join("")}.xlsx`;
}

/** Immutable file + metadata bundles are published by one directory rename. */
export class SessionExportFiles {
  readonly rootDir: string;
  readonly sessionId: string;
  readonly #sessionDir: string;
  readonly #exportsDir: string;
  constructor(rootDir: string, sessionId: string) {
    this.rootDir = path.resolve(rootDir);
    this.sessionId = sessionId;
    if (!/^[A-Za-z0-9-]{8,100}$/u.test(sessionId)) throw new ExportFileNotFoundError();
    this.#sessionDir = path.join(path.resolve(rootDir), sessionId);
    this.#exportsDir = path.join(this.#sessionDir, "exports");
  }

  #checkDirectory(directory: string): void {
    const metadata = lstatSync(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new ExportFileNotFoundError();
  }

  #checkParents(): void {
    this.#checkDirectory(this.#sessionDir);
    this.#checkDirectory(this.#exportsDir);
    if (realpathSync(this.#exportsDir) !== path.join(realpathSync(this.rootDir), this.sessionId, "exports")) {
      throw new ExportFileNotFoundError();
    }
  }

  save(bytes: Buffer, input: Omit<ExportFileMetadata, "id" | "byteCount" | "createdAt">, signal?: AbortSignal): ExportFileMetadata {
    signal?.throwIfAborted();
    if (bytes.length < 4 || bytes.length > MAX_EXCEL_BYTES || bytes.readUInt32LE(0) !== 0x04034b50) {
      throw new Error("Excel 文件无效或超过 8 MiB 上限");
    }
    if (!existsSync(this.#sessionDir)) mkdirSync(this.#sessionDir, { mode: 0o700 });
    this.#checkDirectory(this.#sessionDir);
    if (!existsSync(this.#exportsDir)) mkdirSync(this.#exportsDir, { mode: 0o700 });
    this.#checkParents();
    const id = randomUUID();
    const staging = path.join(this.#exportsDir, `.${id}.tmp`);
    const metadata: ExportFileMetadata = { ...input, filename: excelFilename(input.filename), id,
      byteCount: bytes.length, createdAt: new Date().toISOString() };
    mkdirSync(staging, { mode: 0o700 });
    try {
      for (const [name, data] of [["workbook.xlsx", bytes], ["metadata.json", JSON.stringify(metadata)]] as const) {
        const fd = openSync(path.join(staging, name), "wx", 0o600);
        try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
      }
      signal?.throwIfAborted();
      renameSync(staging, path.join(this.#exportsDir, id));
      return metadata;
    } finally { rmSync(staging, { force: true, recursive: true }); }
  }

  open(id: string): OpenExportFile {
    let fd: number | undefined;
    try {
      if (!FILE_ID.test(id)) throw new ExportFileNotFoundError();
      this.#checkParents();
      const directory = path.join(this.#exportsDir, id);
      this.#checkDirectory(directory);
      const metaFd = openSync(path.join(directory, "metadata.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
      let metadata: ExportFileMetadata;
      try {
        const stat = fstatSync(metaFd);
        if (!stat.isFile() || stat.size > 64 * 1024 || stat.nlink !== 1) throw new ExportFileNotFoundError();
        metadata = JSON.parse(readFileSync(metaFd, "utf8")) as ExportFileMetadata;
      } finally { closeSync(metaFd); }
      if (metadata.id !== id || typeof metadata.filename !== "string" || excelFilename(metadata.filename) !== metadata.filename ||
        !Number.isInteger(metadata.byteCount) || metadata.byteCount < 4 || metadata.byteCount > MAX_EXCEL_BYTES ||
        !Number.isInteger(metadata.rowCount) || metadata.rowCount < 0 ||
        typeof metadata.createdAt !== "string" || !Number.isFinite(Date.parse(metadata.createdAt)) ||
        typeof metadata.source?.name !== "string" || typeof metadata.source.version !== "string" ||
        typeof metadata.source.createdAt !== "string" ||
        (metadata.kind !== undefined && !["upload", "edit", "export"].includes(metadata.kind)) ||
        (metadata.parentFileId !== undefined && !FILE_ID.test(metadata.parentFileId)) ||
        (metadata.summary !== undefined && (typeof metadata.summary !== "string" || metadata.summary.length > 12000))) throw new ExportFileNotFoundError();
      fd = openSync(path.join(directory, "workbook.xlsx"), constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size !== metadata.byteCount || stat.nlink !== 1) throw new ExportFileNotFoundError();
      return { metadata, fd };
    } catch {
      if (fd !== undefined) closeSync(fd);
      throw new ExportFileNotFoundError();
    }
  }

  downloadUrl(id: string): string { return `/api/sessions/${this.sessionId}/files/${id}`; }

  describe(metadata: ExportFileMetadata): SessionFile {
    return { id: metadata.id, filename: metadata.filename, byteCount: metadata.byteCount,
      createdAt: metadata.createdAt, kind: metadata.kind ?? "export", downloadUrl: this.downloadUrl(metadata.id),
      ...(metadata.parentFileId ? { parentFileId: metadata.parentFileId } : {}),
      ...(metadata.summary ? { summary: metadata.summary } : {}) };
  }

  list(): SessionFile[] {
    if (!existsSync(this.#exportsDir)) return [];
    this.#checkParents();
    const files: SessionFile[] = [];
    for (const id of readdirSync(this.#exportsDir)) {
      if (!FILE_ID.test(id)) continue;
      try {
        const file = this.open(id);
        try { files.push(this.describe(file.metadata)); } finally { closeSync(file.fd); }
      } catch { /* Incomplete or invalid bundles are never published. */ }
    }
    return files.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  read(id: string): { metadata: ExportFileMetadata; bytes: Buffer } {
    const file = this.open(id);
    try { return { metadata: file.metadata, bytes: readFileSync(file.fd) }; }
    finally { closeSync(file.fd); }
  }
}
