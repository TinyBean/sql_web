import { parseDashboardState, type DashboardState } from "../../shared/dashboard.ts";
import type { DashboardDefinition } from "./definition.ts";

export const DEFAULT_DASHBOARD_ID = "default";

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

  get(id = DEFAULT_DASHBOARD_ID): DashboardDefinition {
    const definition = this.#definitions.get(id);
    if (!definition) throw new Error("未知看板 ID：" + id);
    return definition;
  }

  loadInitial(id = DEFAULT_DASHBOARD_ID): DashboardState {
    const state = parseDashboardState(this.get(id).loadInitial());
    if (state.revision !== 0) throw new Error("初始看板 revision 必须为 0");
    return state;
  }
}
