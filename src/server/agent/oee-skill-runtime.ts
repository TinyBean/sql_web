import { readFile } from "node:fs/promises";
import { writeSync } from "node:fs";
import type { QueryDatabase } from "../database/database.ts";
import { MAX_QUERY_ARTIFACT_BYTES, type SessionArtifactStore } from "../tool/artifact-store.ts";
import type { MachineRow, TestOeeRuntime, TestOeeToolContext } from "../skills/test-oee-calculator/assets/runtime.ts";
import type { SkillSessionOptions } from "./skill-catalog.ts";

/** Binds only caller-owned, read-only resources; analysis passes its frozen transaction. */
export function createOeeSkillRuntime(
  database: Pick<QueryDatabase, "exportQueryJson">, artifacts: SessionArtifactStore,
): TestOeeRuntime {
  return {
    async querySnapshot(base, sql, signal) {
      signal?.throwIfAborted();
      const snapshot = await artifacts.createDataSnapshotAsync(base, async (fileDescriptor) => {
        const exported = await database.exportQueryJson(sql, [], { fileDescriptor, maxRows: 100_000,
          maxBytes: MAX_QUERY_ARTIFACT_BYTES, previewRows: 0, ...(signal ? { signal } : {}) });
        signal?.throwIfAborted();
        if (exported.truncated) throw new Error("机台排名源数据超过快照上限，请缩小日期范围");
        return exported;
      }, signal, "unique");
      const data = JSON.parse(await readFile(artifacts.resolveDataSnapshot(snapshot.name).filePath, "utf8")) as { rows: MachineRow[] };
      return { rows: data.rows, truncated: false };
    },
    saveSnapshot(base, data, signal) {
      signal?.throwIfAborted();
      const content = JSON.stringify(data);
      if (Buffer.byteLength(content) > MAX_QUERY_ARTIFACT_BYTES) throw new Error("机台排名超过快照大小上限");
      const { value: _value, replaced: _replaced, ...snapshot } = artifacts.createDataSnapshot(base, (fd) => {
        writeSync(fd, content);
        signal?.throwIfAborted();
        return { columns: data.columns, rowCount: data.rows.length };
      }, "unique");
      return snapshot;
    },
  };
}

export function oeeSkillSessionOptions(
  database: Pick<QueryDatabase, "exportQueryJson">, artifacts: SessionArtifactStore,
): SkillSessionOptions {
  const context: TestOeeToolContext = { runtime: createOeeSkillRuntime(database, artifacts) };
  return { contexts: { "test-oee-calculator": context } };
}
