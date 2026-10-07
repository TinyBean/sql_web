import { readFileSync, writeSync } from "node:fs";
import type { AppDatabase } from "../database/database.ts";
import { MAX_QUERY_ARTIFACT_BYTES, normalizeDataSnapshotName, type SessionArtifactStore } from "../tool/artifact-store.ts";
import type { MachineRow, TestOeeRuntime, TestOeeToolContext } from "../skills/test-oee-calculator/assets/runtime.ts";
import type { SkillSessionOptions } from "./skill-catalog.ts";

function uniqueName(artifacts: SessionArtifactStore, base: string): string {
  const names = new Set(artifacts.listDataSnapshots().map((entry) => entry.name));
  const normalized = normalizeDataSnapshotName(base);
  let name = normalized;
  for (let suffix = 2; names.has(artifacts.snapshotName(name)); suffix++) {
    const ending = "-" + suffix;
    name = normalized.slice(0, 32 - ending.length) + ending;
  }
  return name;
}

/** Binds only caller-owned, read-only resources; analysis passes its frozen transaction. */
export function createOeeSkillRuntime(
  database: Pick<AppDatabase, "exportQueryJson">, artifacts: SessionArtifactStore,
): TestOeeRuntime {
  return {
    querySnapshot(base, sql, signal) {
      signal?.throwIfAborted();
      const snapshot = artifacts.createDataSnapshot(uniqueName(artifacts, base), (fileDescriptor) => {
        const exported = database.exportQueryJson(sql, [], { fileDescriptor, maxRows: 100_000,
          maxBytes: MAX_QUERY_ARTIFACT_BYTES, previewRows: 0, ...(signal ? { signal } : {}) });
        signal?.throwIfAborted();
        if (exported.truncated) throw new Error("机台排名源数据超过快照上限，请缩小日期范围");
        return exported;
      });
      const data = JSON.parse(readFileSync(artifacts.resolveDataSnapshot(snapshot.name).filePath, "utf8")) as { rows: MachineRow[] };
      return { rows: data.rows, truncated: false };
    },
    saveSnapshot(base, data, signal) {
      signal?.throwIfAborted();
      const content = JSON.stringify(data);
      if (Buffer.byteLength(content) > MAX_QUERY_ARTIFACT_BYTES) throw new Error("机台排名超过快照大小上限");
      const { value: _value, replaced: _replaced, ...snapshot } = artifacts.createDataSnapshot(uniqueName(artifacts, base), (fd) => {
        writeSync(fd, content);
        signal?.throwIfAborted();
        return { columns: data.columns, rowCount: data.rows.length };
      });
      return snapshot;
    },
  };
}

export function oeeSkillSessionOptions(
  database: Pick<AppDatabase, "exportQueryJson">, artifacts: SessionArtifactStore,
): SkillSessionOptions {
  const context: TestOeeToolContext = { runtime: createOeeSkillRuntime(database, artifacts) };
  return { contexts: { "test-oee-calculator": context } };
}
