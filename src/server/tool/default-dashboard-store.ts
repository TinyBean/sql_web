import {
  closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync,
  rmSync, writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { MAX_DASHBOARD_FILE_BYTES, parseDashboardState, type DashboardState } from "../../shared/dashboard.ts";
import type { AppLogger } from "../logger.ts";
import { createDefaultDashboard } from "./default-dashboard.ts";

function validateDefault(value: unknown): DashboardState {
  const state = parseDashboardState(value);
  const expected = createDefaultDashboard().widgets.map((widget) => widget.id);
  if (state.revision !== 0 || state.widgets.length !== expected.length ||
      state.widgets.some((widget, index) => widget.id !== expected[index])) {
    throw new Error("默认看板必须包含固定顺序的 9 张卡片，revision 必须为 0");
  }
  return state;
}

export function readDefaultDashboard(filePath?: string, logger?: Pick<AppLogger, "info" | "error">): DashboardState {
  if (!filePath) return createDefaultDashboard();
  try {
    const metadata = lstatSync(filePath);
    if (!metadata.isFile() || metadata.isSymbolicLink() ||
        metadata.size < 1 || metadata.size > MAX_DASHBOARD_FILE_BYTES) {
      throw new Error("默认看板文件类型或大小无效");
    }
    return validateDefault(JSON.parse(readFileSync(filePath, "utf8")) as unknown);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      logger?.info("dashboard.default.fallback", { reason: "missing", filePath });
    } else {
      logger?.error("dashboard.default.invalid", error, { filePath });
    }
    return createDefaultDashboard();
  }
}

export function writeDefaultDashboard(filePath: string, state: DashboardState): void {
  const payload = JSON.stringify(validateDefault(state));
  if (Buffer.byteLength(payload) > MAX_DASHBOARD_FILE_BYTES) {
    throw new Error("默认看板文件超过大小限制");
  }
  const directory = path.dirname(filePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, ".default-dashboard-" + randomUUID() + ".tmp");
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, payload, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, filePath);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}
