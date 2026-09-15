import type { DashboardRegistry } from "./registry.ts";
import type { DashboardUpdateContext, DashboardUpdateOutcome, DashboardUpdatePlan, UpdateStatus } from "./definition.ts";

export interface DashboardRunResult extends Omit<DashboardUpdateOutcome, "status"> {
  readonly dashboardId: string;
  readonly status: UpdateStatus | "skipped";
}

type PlannedUpdate = { readonly dashboardId: string } & (
  DashboardUpdatePlan | { readonly action: "failed"; readonly reason: string }
);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function summarizeUpdateStatuses(statuses: readonly (UpdateStatus | "skipped")[]): UpdateStatus {
  if (statuses.includes("failed")) return "failed";
  return statuses.includes("completed_with_warnings") ? "completed_with_warnings" : "completed";
}

/** Used by dry-run without opening the database or executing any update. */
export function planDashboardUpdates(registry: DashboardRegistry, context: DashboardUpdateContext): readonly PlannedUpdate[] {
  return registry.list().map((definition) => {
    try {
      return { dashboardId: definition.id, ...(definition.update?.plan(context) ?? {
        action: "skip", reason: "未注册更新策略",
      }) };
    } catch (error) {
      return { dashboardId: definition.id, action: "failed", reason: errorMessage(error) };
    }
  });
}

export async function runDashboardUpdates(
  registry: DashboardRegistry, context: DashboardUpdateContext, skipReason?: string,
): Promise<readonly DashboardRunResult[]> {
  const results: DashboardRunResult[] = [];
  for (const definition of registry.list()) {
    const logger = context.logger.child({ dashboardId: definition.id });
    const started = Date.now();
    let result: DashboardRunResult;
    try {
      const plan = skipReason ? { action: "skip", reason: skipReason } :
        definition.update?.plan(context) ?? { action: "skip", reason: "未注册更新策略" };
      if (plan.action === "skip") {
        result = { dashboardId: definition.id, status: "skipped", published: false, dataAsOf: null, reason: plan.reason };
      } else {
        logger.info("daily.dashboard.started", { throughDate: context.throughDate });
        const outcome = await definition.update!.run({ ...context, logger });
        result = { ...outcome, dashboardId: definition.id };
      }
    } catch (error) {
      logger.error("daily.dashboard.failed", error, { throughDate: context.throughDate });
      result = { dashboardId: definition.id, status: "failed", published: false, dataAsOf: null, reason: errorMessage(error) };
    }
    logger.info("daily.dashboard.completed", { ...result, durationMs: Date.now() - started });
    results.push(result);
  }
  return results;
}
