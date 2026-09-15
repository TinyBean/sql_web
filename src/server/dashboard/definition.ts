import type { JsonObject } from "../../shared/contracts.ts";
import type { DashboardState } from "../../shared/dashboard.ts";
import type { AppLogger } from "../logger.ts";

export type UpdateStatus = "completed" | "completed_with_warnings" | "failed";

export interface DashboardUpdateContext {
  /** Updates may only open this database read-only. Database ingestion runs separately. */
  readonly databasePath: string;
  readonly throughDate: string;
  readonly now: Date;
  readonly syncWarnings: readonly string[];
  readonly runId: string;
  readonly logger: AppLogger;
}

export interface DashboardUpdatePlan {
  readonly action: "run" | "skip";
  readonly reason: string | null;
  readonly outputPath?: string;
  readonly details?: JsonObject;
}

export interface DashboardUpdateOutcome {
  readonly status: UpdateStatus;
  readonly published: boolean;
  readonly dataAsOf: string | null;
  readonly reason: string | null;
  readonly details?: JsonObject;
}

export interface DashboardDefinition {
  readonly id: string;
  /** Return a complete revision-0 snapshot; never start an update here. */
  loadInitial(): DashboardState;
  readonly update?: {
    /** Pure planning: no API/database access, logging, file writes, or Agent creation. */
    plan(context: DashboardUpdateContext): DashboardUpdatePlan;
    /** Publish atomically only after generation and validation succeed. */
    run(context: DashboardUpdateContext): Promise<DashboardUpdateOutcome>;
  };
}

export type InitialDashboardProvider = (sessionId: string) => DashboardState;
