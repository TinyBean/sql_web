import type { JsonObject } from "../../shared/contracts.ts";
import { parseDashboardState, type DashboardState } from "../../shared/dashboard.ts";
import type { AppLogger } from "../logger.ts";
import { createDefaultDashboardDefinition, type DefaultDashboardOptions } from "./default/index.ts";

export interface DashboardUpdateContext {
  /** Updates may only open this database read-only. Database ingestion runs separately. */
  readonly databasePath: string;
  readonly throughDate: string;
  readonly now: Date;
  readonly syncWarnings: readonly string[];
  readonly runId: string;
  readonly logger: AppLogger;
}

export interface DashboardUpdateOutcome {
  readonly status: "completed" | "completed_with_warnings" | "failed" | "skipped";
  readonly published: boolean;
  readonly dataAsOf: string | null;
  readonly reason: string | null;
  readonly details?: JsonObject;
}

export interface DashboardDefinition {
  readonly id: string;
  /** Return a complete revision-0 snapshot; never start an update here. */
  loadInitial(): DashboardState;
  /** Decide whether to update; publish atomically after generation and validation succeed. */
  update?(context: DashboardUpdateContext): Promise<DashboardUpdateOutcome>;
}

export class DashboardRegistry {
  readonly #definitions = new Map<string, DashboardDefinition>();

  constructor(definitions: readonly DashboardDefinition[]) {
    for (const definition of definitions) {
      if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(definition.id)) {
        throw new Error("看板 ID 无效：" + definition.id);
      }
      if (this.#definitions.has(definition.id)) throw new Error("看板 ID 重复：" + definition.id);
      this.#definitions.set(definition.id, definition);
    }
  }

  list(): readonly DashboardDefinition[] {
    return [...this.#definitions.values()];
  }

  loadInitial(id = "default"): DashboardState {
    const definition = this.#definitions.get(id);
    if (!definition) throw new Error("未知看板 ID：" + id);
    const state = parseDashboardState(definition.loadInitial());
    if (state.revision !== 0) throw new Error("初始看板 revision 必须为 0");
    return state;
  }
}

/** The shared registration point used by both the web service and the daily command. */
export function createDashboardRegistry(options: DefaultDashboardOptions = {}): DashboardRegistry {
  return new DashboardRegistry([
    createDefaultDashboardDefinition(options),
  ]);
}
