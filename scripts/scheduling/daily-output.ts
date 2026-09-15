import { DEFAULT_DASHBOARD_ID } from "../../src/server/dashboard/registry.ts";
import type { DashboardRunResult } from "../../src/server/dashboard/update-runner.ts";

/** Compatibility fields for consumers of the original single-dashboard CLI output. */
export function defaultDashboardOutput(results: readonly DashboardRunResult[]) {
  const result = results.find((item) => item.dashboardId === DEFAULT_DASHBOARD_ID);
  const details = result?.details;
  const analysisStatus = details?.["analysisStatus"];
  return {
    published: result?.published ?? false,
    dataAsOf: result?.dataAsOf ?? null,
    analysisStatus: analysisStatus === "completed" || analysisStatus === "failed" || analysisStatus === "timed_out"
      ? analysisStatus : "skipped",
    analysisReason: typeof details?.["analysisReason"] === "string" ? details["analysisReason"] : result?.reason ?? null,
    ...(typeof details?.["analysisRunId"] === "string" ? { analysisRunId: details["analysisRunId"] } : {}),
    ...(typeof details?.["analysisArtifactDir"] === "string" ? { analysisArtifactDir: details["analysisArtifactDir"] } : {}),
  };
}
