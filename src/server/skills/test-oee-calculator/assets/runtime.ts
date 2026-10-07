/** Capabilities supplied by the current session; no database or file handles belong to the Skill. */
export type MachineRow = Readonly<Record<string, string | number | null>>;
export interface MachineDatePeriod {
  readonly start: string;
  readonly end: string;
}
export interface RankingSnapshot {
  readonly name: string;
  readonly version: string;
  readonly columns: readonly string[];
  readonly rowCount: number;
  readonly byteCount: number;
  readonly createdAt: string;
}
export interface TestOeeRuntime {
  querySnapshot(name: string, sql: string, signal?: AbortSignal): {
    readonly rows: readonly MachineRow[];
    readonly truncated: boolean;
  };
  saveSnapshot(name: string, data: {
    readonly columns: readonly string[];
    readonly rows: readonly MachineRow[];
    readonly rowCount: number;
    readonly truncated: false;
    readonly range: MachineDatePeriod;
    readonly scope: unknown;
  }, signal?: AbortSignal): RankingSnapshot;
}
export interface TestOeeToolContext {
  readonly runtime?: TestOeeRuntime;
}
