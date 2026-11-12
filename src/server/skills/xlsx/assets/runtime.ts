import type { JsonValue, SessionFile } from "../../../../shared/contracts.ts";

export interface ExportColumn {
  readonly key: string;
  readonly title?: string;
  readonly format?: "auto" | "text" | "number" | "ratio" | "percent";
}

export interface ExcelExportInput {
  readonly snapshot: string;
  readonly filename?: string;
  readonly title?: string;
  readonly description?: string;
  readonly columns?: readonly ExportColumn[];
}

export interface ExcelExportResult {
  readonly file_id: string;
  readonly filename: string;
  readonly byte_count: number;
  readonly row_count: number;
  readonly download_url: string;
}

export interface ExcelSkillContext {
  listFiles(): readonly SessionFile[];
  inspectWorkbook(input: WorkbookInspectInput, signal?: AbortSignal): Promise<JsonValue>;
  editWorkbook(input: WorkbookEditInput, signal?: AbortSignal): Promise<JsonValue>;
  exportSnapshot(input: ExcelExportInput, signal?: AbortSignal): Promise<ExcelExportResult>;
}

export interface WorkbookInspectInput { readonly file_id: string; readonly sheet?: string; readonly range?: string; }
export type CellValue = string | number | boolean | null;
export interface CellStyle {
  readonly number_format?: "general" | "text" | "integer" | "decimal" | "ratio" | "percent";
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly font_size?: number;
  readonly font_color?: string;
  readonly fill_color?: string;
  readonly alignment?: "left" | "center" | "right";
  readonly wrap_text?: boolean;
  readonly column_width?: number;
  readonly row_height?: number;
}
export type WorkbookOperation = { readonly sheet: string; readonly range: string } & (
  | { readonly type: "set"; readonly values: readonly (readonly CellValue[])[] }
  | { readonly type: "fill"; readonly value: CellValue }
  | { readonly type: "format"; readonly style: CellStyle }
);
export interface WorkbookEditInput { readonly file_id: string; readonly operations: readonly WorkbookOperation[]; readonly filename?: string; }
