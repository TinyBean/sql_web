import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { dailyUpdatePlan, type DailyDatabaseDependencies } from "../../scripts/database/daily-update.ts";
import { loadDataCommandConfig } from "../../scripts/database/data-command-config.ts";
import { outcomeExitCode } from "../../scripts/database/oee-data-store.ts";
import { runDailyUpdate } from "../../scripts/scheduling/daily-update.ts";
import { DashboardRegistry } from "../../src/server/dashboard/index.ts";
import { createDefaultDashboardDefinition } from "../../src/server/dashboard/default/index.ts";
import { writeDefaultDashboard } from "../../src/server/dashboard/default/store.ts";
import type { DefaultDashboardResult } from "../../src/server/dashboard/default/run.ts";
import { createNotificationDispatcher, type NotificationDispatcher } from "../../src/server/notifications.ts";
import { sendEmail } from "../../src/server/email.ts";
import type { AppLogger } from "../../src/server/logger.ts";
import { smtpServer, decodedBody } from "../helpers/smtp.ts";
import { weeklyDashboard } from "../helpers/weekly-dashboard.ts";

const plan = dailyUpdatePlan([], new Date("2026-09-15T01:00:00Z"));
const database: DailyDatabaseDependencies = { openStore: () => ({
  async sync() { return { runId: "sync", status: "completed", datasets: [] }; }, close() {},
}) };

function fixture(t: TestContext) {
  const directory = mkdtempSync(path.join(tmpdir(), "daily-notifications-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const config = loadDataCommandConfig(directory, {});
  const logs: unknown[] = [];
  const logger: AppLogger = { info: (...args) => { logs.push(args); }, warn: (...args) => { logs.push(args); },
    error: (...args) => { logs.push(args); }, child() { return this; } };
  const state = weeklyDashboard(plan.throughDate);
  const generated: DefaultDashboardResult = { state, analysisStatus: "completed", analysisReason: null,
    analysisRunId: "run-test", analysisArtifactDir: path.join(directory, "analysis") };
  const saveRoute = () => {
    mkdirSync(path.dirname(config.notificationOptions.configPath), { recursive: true });
    writeFileSync(config.notificationOptions.configPath, JSON.stringify({ groups: {}, routes: {
      "weekly-improvement": { enabled: true, groups: [], to: ["Cheng.Wu@sdsscn.com", "missing@example.com"] },
    } }));
  };
  return { directory, config, logger, logs, state, generated, saveRoute };
}

test("each successful run publishes before sending, including repeated dates and coverage warnings", async (t) => {
  const f = fixture(t);
  f.saveRoute();
  const smtp = await smtpServer(t);
  const calls: string[] = [];
  const notify = createNotificationDispatcher({ ...f.config.notificationOptions, loadEmail: () => smtp.config }, async (config, input) => {
    calls.push("send");
    assert.deepEqual(JSON.parse(readFileSync(f.config.defaultDashboardPath, "utf8")), f.state);
    return sendEmail(config, input);
  });
  const registry = new DashboardRegistry([createDefaultDashboardDefinition({ ...f.config, notify }, {
    async generate() { calls.push("analyze"); return f.generated; },
    publish(file, state) { calls.push("publish"); writeDefaultDashboard(file, state); },
  })]);
  for (let run = 0; run < 2; run++) {
    const outcome = await runDailyUpdate(f.config, plan, registry, f.logger, database, "run-" + run);
    assert.equal(outcome.status, "completed");
    assert.equal(outcome.dashboards[0]?.published, true);
    const notification = outcome.dashboards[0]?.details?.["notification"];
    assert.ok(notification && typeof notification === "object" && !Array.isArray(notification));
    assert.equal((notification as Record<string, unknown>)["status"], "accepted");
    assert.doesNotMatch(JSON.stringify(outcome), /Cheng\.Wu|missing@example|换线时间/u);
  }
  assert.deepEqual(calls, ["analyze", "publish", "send", "analyze", "publish", "send"]);
  assert.equal(smtp.messages.length, 2);
  assert.match(decodedBody(smtp.messages[0]!, "text/plain"), /换线时间偏长/u);
  assert.match(decodedBody(smtp.messages[0]!, "text/html"), /<td>—<\/td>/u);
  assert.doesNotMatch(JSON.stringify(f.logs), /Cheng\.Wu|missing@example|换线时间/u);

  // This run checks a different snapshot, so use the same dispatcher without the first snapshot assertion.
  const warningNotify = createNotificationDispatcher({ ...f.config.notificationOptions, loadEmail: () => smtp.config });
  const warningDefinition = createDefaultDashboardDefinition({ ...f.config, notify: warningNotify }, {
    async generate() { return { ...f.generated, state: { ...f.state, widgets: f.state.widgets.map((widget) => ({
      ...widget, warnings: [...widget.warnings, "数据缺失：仅反映已有数据"],
    })) } }; }, publish: writeDefaultDashboard,
  });
  const warningResult = await runDailyUpdate(f.config, plan, new DashboardRegistry([warningDefinition]), f.logger, database);
  assert.equal(warningResult.status, "completed_with_warnings");
  assert.equal(smtp.messages.length, 3);
  assert.match(decodedBody(smtp.messages[2]!, "text/plain"), /数据缺失：仅反映已有数据/u);
});

test("partial, failed and unknown SMTP outcomes attempt once and preserve a published dashboard with exit code 2", async (t) => {
  for (const [status, options] of [
    ["partial", { reject: ["missing@example.com"] }],
    ["failed", { senderRejected: true }],
    ["unknown", { dataResult: "drop" as const }],
  ] as const) {
    const f = fixture(t);
    f.saveRoute();
    const smtp = await smtpServer(t, options);
    let attempts = 0;
    const notify = createNotificationDispatcher({ ...f.config.notificationOptions, loadEmail: () => smtp.config }, async (config, input) => {
      attempts++;
      return sendEmail(config, input);
    });
    const registry = new DashboardRegistry([createDefaultDashboardDefinition({ ...f.config, notify }, {
      async generate() { return f.generated; }, publish: writeDefaultDashboard,
    })]);
    const result = await runDailyUpdate(f.config, plan, registry, f.logger, database);
    assert.equal(attempts, 1, status);
    assert.equal(smtp.commands.filter((command) => command.startsWith("MAIL FROM")).length, 1, status);
    assert.equal(result.dashboards[0]?.published, true);
    assert.equal(outcomeExitCode(result.status), 2);
    assert.equal((result.dashboards[0]?.details?.["notification"] as Record<string, unknown>)["status"], status);
    assert.deepEqual(JSON.parse(readFileSync(f.config.defaultDashboardPath, "utf8")), f.state);
    assert.doesNotMatch(JSON.stringify(f.logs), /Cheng\.Wu|missing@example|换线时间/u);
  }
});

test("analysis, sync and publication failures never trigger notifications", async (t) => {
  for (const failure of ["failed", "timed_out", "sync", "calculation", "publication"] as const) {
    const f = fixture(t);
    const notify: NotificationDispatcher = async () => { assert.fail("must not notify"); };
    const registry = new DashboardRegistry([createDefaultDashboardDefinition({ ...f.config, notify }, {
      async generate() {
        if (failure === "calculation") throw new Error("calculation failed");
        return failure === "failed" || failure === "timed_out" ? {
          ...f.generated, analysisStatus: failure, analysisReason: "分析未完成",
        } : f.generated;
      },
      publish(file, state) {
        if (failure === "publication") throw new Error("publication failed");
        writeDefaultDashboard(file, state);
      },
    })]);
    const result = await runDailyUpdate(f.config, plan, registry, f.logger, failure === "sync" ? {
      openStore() { throw new Error("sync failed"); },
    } : database);
    const analysisFailure = failure === "failed" || failure === "timed_out";
    assert.equal(result.dashboards[0]?.published, analysisFailure);
    if (analysisFailure) assert.equal((result.dashboards[0]?.details?.["notification"] as Record<string, unknown>)["status"], "skipped");
  }
});

test("invalid enabled configuration and unexpected notifier errors cannot roll back publication", async (t) => {
  for (const failure of ["config", "smtp", "exception"]) {
    const f = fixture(t);
    f.saveRoute();
    if (failure === "config") writeFileSync(f.config.notificationOptions.configPath, "{broken");
    const notify: NotificationDispatcher = failure === "exception" ? async () => { throw new Error("private@example.com"); } :
      createNotificationDispatcher(f.config.notificationOptions);
    const registry = new DashboardRegistry([createDefaultDashboardDefinition({ ...f.config, notify }, {
      async generate() { return f.generated; }, publish: writeDefaultDashboard,
    })]);
    const result = await runDailyUpdate(f.config, plan, registry, f.logger, database);
    assert.equal(result.dashboards[0]?.published, true);
    assert.equal(outcomeExitCode(result.status), 2);
    assert.deepEqual(JSON.parse(readFileSync(f.config.defaultDashboardPath, "utf8")), f.state);
    assert.doesNotMatch(JSON.stringify(f.logs), /private@example/u);
  }
});

test("dry-run never resolves notification config or starts any update", async (t) => {
  const f = fixture(t);
  const notify = createNotificationDispatcher({ ...f.config.notificationOptions, loadEmail() { assert.fail("must not load SMTP"); } },
    async () => { assert.fail("must not send"); });
  const registry = new DashboardRegistry([createDefaultDashboardDefinition({ ...f.config, notify }, {
    async generate() { assert.fail("must not analyze"); }, publish() { assert.fail("must not publish"); },
  })]);
  await assert.rejects(runDailyUpdate(f.config, { ...plan, dryRun: true }, registry, f.logger, {
    openStore() { assert.fail("must not sync"); },
  }), /dry-run/u);
  assert.deepEqual(readdirSync(f.directory), []);
});
