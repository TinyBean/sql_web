import {
  closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync,
  rmSync, writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { MAX_DASHBOARD_FILE_BYTES, parseDashboardState, type DashboardState } from "../../shared/dashboard.ts";

type SnapshotValidator = (state: DashboardState) => void;

function validate(value: unknown, validator?: SnapshotValidator): DashboardState {
  const state = parseDashboardState(value);
  if (state.revision !== 0) throw new Error("初始看板 revision 必须为 0");
  validator?.(state);
  return state;
}

export function readDashboardSnapshot(filePath: string, validator?: SnapshotValidator): DashboardState {
  const metadata = lstatSync(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink() ||
      metadata.size < 1 || metadata.size > MAX_DASHBOARD_FILE_BYTES) {
    throw new Error("看板快照文件类型或大小无效");
  }
  return validate(JSON.parse(readFileSync(filePath, "utf8")) as unknown, validator);
}

export function writeDashboardSnapshot(filePath: string, state: DashboardState, validator?: SnapshotValidator): void {
  const payload = JSON.stringify(validate(state, validator));
  if (Buffer.byteLength(payload) > MAX_DASHBOARD_FILE_BYTES) throw new Error("看板快照文件超过大小限制");
  const directory = path.dirname(filePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, ".dashboard-snapshot-" + randomUUID() + ".tmp");
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
