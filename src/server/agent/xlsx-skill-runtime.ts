import { createHash } from "node:crypto";
import type { JsonObject, SessionFile } from "../../shared/contracts.ts";
import type { CodeInterpreterRuntime } from "../tool/code-interpreter.ts";
import type { SessionArtifactStore } from "../tool/artifact-store.ts";
import { excelFilename } from "../tool/export-files.ts";
import type { ExcelSkillContext, ExportColumn } from "../skills/xlsx/assets/runtime.ts";
import type { AppLogger } from "../logger.ts";

export function createExcelSkillContext(
  artifacts: SessionArtifactStore,
  runtime: CodeInterpreterRuntime,
  logger: Pick<AppLogger, "info" | "error">,
): ExcelSkillContext {
  return {
    listFiles() { return artifacts.exportFiles().list(); },
    async inspectWorkbook(input, signal) {
      const files = artifacts.exportFiles();
      const file = files.read(input.file_id);
      const result = await runtime.processWorkbook(file.bytes, { action: "inspect",
        ...(input.sheet !== undefined ? { sheet: input.sheet } : {}),
        ...(input.range !== undefined ? { range: input.range } : {}) }, signal);
      return { file_id: file.metadata.id, ...result.details.result };
    },
    async editWorkbook(input, signal) {
      const startedAt = Date.now();
      const files = artifacts.exportFiles();
      try {
        const original = files.read(input.file_id);
        const operations = input.operations.map((operation) => ({ ...operation })) as unknown as JsonObject[];
        const result = await runtime.processWorkbook(original.bytes, { action: "edit", operations }, signal);
        if (!result.workbook) throw new Error("Excel 修改未生成文件");
        const details = result.details.result;
        const data = details.data as { changes?: { sheet: string; range: string; type: string }[]; notes?: string[] } | undefined;
        const labels: Record<string, string> = { set: "写入", fill: "填充", format: "格式" };
        const summary = [details.summary, ...(data?.changes ?? []).map((change) => `${change.sheet}!${change.range}：${labels[change.type] ?? change.type}`), ...input.operations.flatMap((operation) => operation.type === "format" ? [
          ...(operation.style.column_width !== undefined ? [`${operation.sheet}!${operation.range}：列宽 ${operation.style.column_width}，影响相关整列`] : []),
          ...(operation.style.row_height !== undefined ? [`${operation.sheet}!${operation.range}：行高 ${operation.style.row_height}，影响相关整行`] : []),
        ] : []), ...(data?.notes ?? [])].join("\n");
        if (summary.length > 12000) throw new Error("修改摘要超限，请减少单次操作数量");
        const file = files.save(result.workbook, {
          filename: input.filename ?? `${original.metadata.filename.replace(/\.xlsx$/iu, "")}_修改.xlsx`,
          rowCount: original.metadata.rowCount, kind: "edit", parentFileId: original.metadata.id, summary,
          source: { name: original.metadata.id, version: createHash("sha256").update(original.bytes).digest("hex"), createdAt: original.metadata.createdAt },
        }, signal);
        logger.info("xlsx.edit.completed", { sessionId: files.sessionId, fileId: file.id, parentFileId: original.metadata.id,
          byteCount: file.byteCount, durationMs: Date.now() - startedAt });
        return { file_id: file.id, filename: file.filename, byte_count: file.byteCount,
          download_url: files.downloadUrl(file.id), parent_file_id: original.metadata.id, ...details };
      } catch (error) {
        logger.error("xlsx.edit.failed", error, { sessionId: files.sessionId, durationMs: Date.now() - startedAt });
        throw error;
      }
    },
    async exportSnapshot(input, signal) {
      const startedAt = Date.now();
      const files = artifacts.exportFiles();
      try {
        signal?.throwIfAborted();
        const snapshot = artifacts.resolveDataSnapshot(input.snapshot);
        const columns = (input.columns ?? snapshot.columns.map((key): ExportColumn => ({ key }))).map((column) => ({
          key: column.key, title: column.title ?? column.key, format: column.format ?? "auto",
        }));
        if (columns.length === 0 || columns.length > 16384 || new Set(columns.map((c) => c.key)).size !== columns.length ||
          columns.some((c) => !snapshot.columns.includes(c.key) || !c.title.trim() || c.title.length > 200 ||
            !["auto", "text", "number", "ratio", "percent"].includes(c.format))) {
          throw new Error("导出列无效：字段必须存在且不重复，列名不能为空，格式必须合法");
        }
        const title = input.title?.trim() || "OEE查询结果";
        const filename = excelFilename(input.filename ?? `${title}.xlsx`);
        const result = await runtime.exportWorkbook({
          snapshot: { name: snapshot.name, version: snapshot.version, createdAt: snapshot.createdAt,
            databasePath: snapshot.filePath, rowCount: snapshot.rowCount, byteCount: snapshot.byteCount },
          userInput: { title, description: input.description ?? "", columns,
            expected_rows: snapshot.rowCount, expected_columns: snapshot.columns },
        }, signal);
        if (result.details.result.metrics?.["rowCount"] !== snapshot.rowCount) throw new Error("Excel 导出行数校验失败");
        const file = files.save(result.workbook, { filename, rowCount: snapshot.rowCount,
          source: { name: snapshot.name, version: snapshot.version, createdAt: snapshot.createdAt } }, signal);
        logger.info("xlsx.export.completed", { sessionId: files.sessionId, fileId: file.id,
          rowCount: file.rowCount, byteCount: file.byteCount, durationMs: Date.now() - startedAt });
        return { file_id: file.id, filename: file.filename, byte_count: file.byteCount,
          row_count: file.rowCount, download_url: files.downloadUrl(file.id) };
      } catch (error) {
        logger.error("xlsx.export.failed", error, { sessionId: files.sessionId, durationMs: Date.now() - startedAt });
        throw error;
      }
    },
  };
}

/** Validation happens before publication; callers recheck session ownership after the await. */
export async function validateUploadedWorkbook(runtime: CodeInterpreterRuntime, filename: string, bytes: Buffer, signal?: AbortSignal): Promise<void> {
  if (!/\.xlsx$/iu.test(filename) || filename.length > 200) throw new TypeError("仅支持上传普通 .xlsx 文件");
  await runtime.processWorkbook(bytes, { action: "validate" }, signal);
}

export function saveUploadedWorkbook(artifacts: SessionArtifactStore, filename: string, bytes: Buffer, signal?: AbortSignal): SessionFile {
  const files = artifacts.exportFiles();
  return files.describe(files.save(bytes, { filename, rowCount: 0, kind: "upload",
    source: { name: filename, version: createHash("sha256").update(bytes).digest("hex"), createdAt: new Date().toISOString() },
  }, signal));
}
