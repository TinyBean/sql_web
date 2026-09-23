import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";
import { AnalysisEvidence, type AnalysisContext } from "../../src/server/dashboard/default/analysis/evidence.ts";
import { PERIOD_KEYS, type PeriodKey } from "../../src/server/dashboard/default/periods.ts";
import { applyAnalysisReport, parseAnalysisReport, validateAnalysisReport, type AnalysisReport } from "../../src/server/dashboard/default/analysis/report.ts";
import { analysisPrompt, runAnalysisAgent } from "../../src/server/dashboard/default/analysis/agent.ts";
import { analysisBudget } from "../../src/server/dashboard/default/analysis/budget.ts";
import { createAnalysisTools, evidenceOutput } from "../../src/server/dashboard/default/analysis/tools.ts";
import { SessionArtifactStore } from "../../src/server/tool/artifact-store.ts";
import { CodeInterpreterRuntime, type CodeInterpreterInput } from "../../src/server/tool/code-interpreter.ts";
import { generateDefaultDashboard } from "../../src/server/dashboard/default/run.ts";
import { calculatedDashboard } from "../helpers/calculated-dashboard.ts";
import { loadDataCommandConfig } from "../../scripts/database/data-command-config.ts";
import { initializeOeeDatabase } from "../../scripts/database/initialize.ts";
import { dailyUpdatePlan } from "../../scripts/database/daily-update.ts";
import { runDailyUpdate } from "../../scripts/scheduling/daily-update.ts";
import { DashboardRegistry } from "../../src/server/dashboard/index.ts";
import { createDefaultDashboardDefinition } from "../../src/server/dashboard/default/index.ts";
import { createDefaultDashboard } from "../../src/server/dashboard/default/template.ts";
import type { AppLogger } from "../../src/server/logger.ts";
import type { DashboardState } from "../../src/shared/dashboard.ts";

import { lossOutput, LOSS_VIEW_BYTES } from "../../src/server/tool/loss-output.ts";
import { measureLoss, type LossResult } from "../../src/server/tool/loss-tools.ts";
import { summarizeAnalysisEvents } from "../../src/server/dashboard/default/analysis/metrics.ts";
import type { SubagentResult } from "../../src/server/agent/subagent.ts";

const logger: AppLogger = { info() {}, warn() {}, error() {}, child() { return this; } };

function assertNumericCardsUnchanged(state: DashboardState, runDir: string): void {
  const base = JSON.parse(readFileSync(path.join(runDir, "base-dashboard.json"), "utf8")) as DashboardState;
  assert.deepEqual(state.widgets.slice(0, 9), base.widgets.slice(0, 9));
  assert.equal(state.dataAsOf, base.dataAsOf);
  assert.deepEqual(state.dateRange, base.dateRange);
}

function fixture(t: TestContext, timeoutMs = 20_000) {
  const directory = mkdtempSync(path.join(tmpdir(), "daily-analysis-"));
  const connections: DatabaseSync[] = [];
  t.after(() => {
    for (const connection of connections) connection.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const config = loadDataCommandConfig(directory, {
    SQL_WEB_PROVIDER: "test", SQL_WEB_MODEL: "test-model", SQL_WEB_DAILY_ANALYSIS_TIMEOUT_MS: String(timeoutMs),
  });
  initializeOeeDatabase(config.databasePath);
  const database = new DatabaseSync(config.databasePath);
  for (const date of ["2026-01-01", "2026-01-05", "2026-01-12"]) {
    for (const kind of ["MT", "ST"]) {
      const step = kind === "MT" ? "5000" : "7000";
      database.prepare("INSERT INTO oee_availability(tool_name,lot_id,final_state,step,date,time_span) VALUES(?,?,?,?,?,?)")
        .run(kind + "-01", "P-LOT", "Test(Normal)", step, date, date === "2026-01-01" ? 21_600 : 43_200);
      database.prepare("INSERT INTO oee_availability(tool_name,lot_id,final_state,step,date,time_span) VALUES(?,?,?,?,?,?)")
        .run(kind + "-01", "P-LOT", "Conversion", step, date, 9000);
      database.prepare("INSERT INTO oee_dut_utilization(machine_id,lot_id,in_qty,out_qty,test_stage,dut_num,step_id,date,touchdown_index,start_time,end_time) VALUES(?,?,?,?,?,?,?,?,'1','2026-01-01T00:00:00.000Z','2026-01-01T00:00:10.000Z')")
        .run(kind + "-01", "P-LOT", "10", "8", "1st", "20", step, date);
    }
  }
  database.close();
  return { config, directory, connections };
}

function reportFor(context: AnalysisContext): AnalysisReport {
  return { periods: PERIOD_KEYS.map((period) => ({
    period, comparison: "本期和最低点均有缺日，按可计算日均值比较，根因待验证。",
    minimum_evidence: context.comparisons[period].minimum.id,
    history_evidence: context.comparisons[period].history.id,
    groups: (["MT", "ST"] as const).map((kind) => ({
      kind, no_findings_reason: "", evidence_ids: [context.comparisons[period].current.id],
      items: [{
        priority: 1, category: "performance", issue: "Performance 使用率偏低；需验证换线期间的 Socket 配置。",
        measure: "核查低使用率批次的 Socket 启用记录，并以次周日均 Performance 验证。",
        suggested_owner: "测试工程", evidence_ids: [context.comparisons[period].current.id], loss_reference: null,
      }],
    })),
  })) };
}

test("daily queries reuse shared tools and freeze complete evidence without copying rows into context", async (t) => {
  const { config, directory, connections } = fixture(t);
  const writer = new DatabaseSync(config.databasePath);
  for (let index = 0; index < 205; index += 1) {
    writer.prepare("INSERT INTO oee_availability(tool_name,lot_id,final_state,step,date,time_span) VALUES(?,?,?,?,?,?)")
      .run("ADH" + index, "P-LOT", "Conversion", "5000", "2026-01-05", 3600);
  }
  writer.close();
  const database = new DatabaseSync(config.databasePath, { readOnly: true });
  connections.push(database);
  database.exec("BEGIN");
  const base = calculatedDashboard(database, "2026-01-12");
  const artifacts = new SessionArtifactStore(directory, "test-snapshots");
  const evidence = new AnalysisEvidence(database, undefined, artifacts);
  const context = evidence.context(base, "2026-01-12");
  const loss = evidence.recordLoss(measureLoss(evidence.queries, artifacts, { start_date: context.periods.week.start, end_date: context.periods.week.end, by_machine: true }), { period: "week", agentId: "root" });
  assert.equal(loss.rows.length, 207);
  assert.equal(loss.truncated, false);
  const preview = evidenceOutput(loss);
  assert.equal(preview.details.preview.rows.length, 3);
  assert.equal(preview.details.preview.truncated, true);
  assert.ok(preview.content[0]!.text.length < 2500);
  assert.doesNotMatch(preview.content[0]!.text, /WITH facts/u);
  const frozen = JSON.parse(readFileSync(artifacts.resolveDataSnapshot(loss.snapshot!.name).filePath, "utf8"));
  assert.deepEqual(frozen.rows, loss.rows);
  const report = reportFor(context);
  const item = report.periods[0]!.groups[0]!.items[0]!;
  item.category = "availability";
  item.evidence_ids.push(loss.id);
  item.loss_reference = { evidence_id: loss.id, row_index: 201 };
  assert.equal(validateAnalysisReport(report, context, evidence.records).rows.week[0]!["loss_hours"], 1);

  const interpreter = await CodeInterpreterRuntime.create({ ...config.analysis.codeInterpreter, projectRoot: directory });
  t.after(() => interpreter.dispose());
  const tools = createAnalysisTools(evidence, interpreter);
  const sql = tools.find((tool) => tool.name === "execute_sql")!;
  const run = (params: Record<string, unknown>) => sql.execute("query", { period: "week", ...params }, undefined, undefined, undefined as never);
  const concurrent = new DatabaseSync(config.databasePath);
  concurrent.prepare("UPDATE oee_availability SET time_span=7200 WHERE tool_name LIKE 'ADH%'").run();
  concurrent.close();
  const result = await run({ sql: "SELECT tool_name, time_span FROM oee_availability WHERE tool_name LIKE 'ADH%' ORDER BY tool_name", save_as: "all-machines" });
  const details = JSON.parse(result.content.find((part) => part.type === "text")!.text);
  assert.equal(details.row_count, 205);
  assert.equal(details.preview.rows.length, 3);
  assert.equal(details.preview.rows[0].row.time_span, 3600, "borrowed queries retain the original transaction");
  assert.equal(evidence.records.get(details.evidence_id)!.rows.length, 205);
  await assert.rejects(run({ sql: "SELECT 0", save_as: "all-machines" }), /已固定/u);
  await assert.rejects(run({ sql: "SELECT 0", save_as: loss.snapshot!.name }), /保留名称/u);
  await assert.rejects(run({ sql: "DELETE FROM oee_availability" }), /只读/u);
  await assert.rejects(run({ sql: "WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<100001) SELECT i FROM n", save_as: "too-many" }), /快照未保存/u);
  assert.throws(() => artifacts.resolveDataSnapshot("too-many"));
  const empty = await run({ sql: "SELECT 1 WHERE 0" });
  assert.equal(JSON.parse(empty.content.find((part) => part.type === "text")!.text).row_count, 0);
  const python = tools.find((tool) => tool.name === "code_interpreter");
  if (interpreter.status.available) {
    assert.ok(python);
    const calculated = await python.execute("python", {
      snapshot: details.snapshot.name,
      code: "emit_result(metrics={'count': len(snapshot_rows), 'seconds': sum(row['time_span'] for row in snapshot_rows)})",
    }, undefined, undefined, undefined as never);
    assert.deepEqual(calculated.details.result.metrics, { count: 205, seconds: 205 * 3600 });
  } else {
    assert.equal(python, undefined, "SQL snapshots remain available when the sandbox is unavailable");
  }
  database.exec("COMMIT");
});

test("parallel SQL evidence registration is atomic and queued cancellations do not poison later queries", async (t) => {
  const { config, directory, connections } = fixture(t);
  const database = new DatabaseSync(config.databasePath, { readOnly: true });
  connections.push(database);
  database.exec("BEGIN");
  const evidence = new AnalysisEvidence(database, undefined, new SessionArtifactStore(directory, "parallel-data"));
  const interpreter = await CodeInterpreterRuntime.create({ projectRoot: directory,
    pythonPath: "/nonexistent/python", bwrapPath: "/nonexistent/bwrap", prlimitPath: "/nonexistent/prlimit" });
  t.after(() => interpreter.dispose());
  const context = evidence.context(calculatedDashboard(database, "2026-01-12"), "2026-01-12");
  const scopes = PERIOD_KEYS.map((period) => evidence.scope(context, period, period + "-agent"));
  const agents = scopes.map((scope) => createAnalysisTools(evidence, interpreter, scope));
  const query = (index: number, params: Record<string, unknown>, signal?: AbortSignal) =>
    agents[index]!.find((tool) => tool.name === "execute_sql")!.execute("same-call-id", params, signal, undefined, undefined as never);
  const results = await Promise.all(agents.map((_, index) => query(index, { sql: `SELECT ${index} AS value` })));
  const details = results.map((result) => JSON.parse(result.content.find((part) => part.type === "text")!.text));
  assert.equal(new Set(details.map((entry) => entry.evidence_id)).size, 3);
  assert.equal(new Set(details.map((entry) => entry.snapshot.name)).size, 3);
  assert.deepEqual(details.map((entry) => evidence.records.get(entry.evidence_id)!.rows[0]!["value"]), [0, 1, 2]);
  const duplicate = await Promise.allSettled([query(0, { sql: "SELECT 4", save_as: "duplicate" }), query(1, { sql: "SELECT 5", save_as: "duplicate" })]);
  assert.deepEqual(duplicate.map((result) => result.status), ["fulfilled", "fulfilled"]);
  await assert.rejects(query(0, { sql: "SELECT 8", save_as: "duplicate" }), /已固定/u);
  for (const [index, scope] of scopes.entries()) {
    assert.ok(evidence.catalog(scope).every((record) => record.owner?.period === scope.period));
    assert.ok(evidence.catalog(scope).some((record) => record.evidence_id === details[index].evidence_id));
    assert.ok(!evidence.catalog(scope).some((record) => record.evidence_id === details[(index + 1) % 3].evidence_id));
  }
  let release!: () => void;
  const gate = evidence.withEvidenceWrite(() => new Promise<void>((resolve) => { release = resolve; }));
  await Promise.resolve();
  const abort = new AbortController();
  const cancelled = query(2, { sql: "SELECT 6", save_as: "cancelled" }, abort.signal);
  abort.abort(); release();
  await gate;
  await assert.rejects(cancelled, /abort/iu);
  assert.throws(() => evidence.artifacts!.resolveDataSnapshot("cancelled"));
  await query(0, { sql: "SELECT 7", save_as: "after-cancel" });
  database.exec("COMMIT");
});

test("period evidence whitelists protect Python reads, initial context and newly registered snapshots", async (t) => {
  const { config, directory, connections } = fixture(t);
  const database = new DatabaseSync(config.databasePath, { readOnly: true });
  connections.push(database);
  const artifacts = new SessionArtifactStore(directory, "isolated-data");
  const evidence = new AnalysisEvidence(database, undefined, artifacts);
  const context = evidence.context(calculatedDashboard(database, "2026-01-12"), "2026-01-12");
  const scopes = PERIOD_KEYS.map((period) => evidence.scope(context, period, period + "-agent"));
  const readNames: (string | null)[] = [];
  // Keep this authorization test independent of host Python/bwrap availability.
  const interpreter = { status: { available: true }, async execute(_code: string, input: CodeInterpreterInput) {
    readNames.push(input.snapshot?.name ?? null);
    return { details: { images: [], result: { summary: "read" } } };
  } } as unknown as CodeInterpreterRuntime;
  const agents = scopes.map((scope) => createAnalysisTools(evidence, interpreter, scope));
  const run = (index: number, name: string, params: Record<string, unknown>) =>
    agents[index]!.find((tool) => tool.name === name)!.execute("same", params, undefined, undefined, undefined as never);
  for (const [index, scope] of scopes.entries()) {
    assert.deepEqual(evidence.catalog(scope).map((entry) => entry.evidence_id), scope.baselineIds);
    const prompt = analysisPrompt(context, scope.period);
    assert.deepEqual(Object.keys(JSON.parse(prompt.split("\n").at(-1)!).periods), [scope.period]);
    for (const record of Object.values(context.comparisons[scope.period])) {
      await run(index, "code_interpreter", { snapshot: record.snapshot!.name, code: "emit_result(summary='read')" });
    }
    for (const other of PERIOD_KEYS.filter((period) => period !== scope.period)) {
      for (const record of Object.values(context.comparisons[other])) assert.ok(!prompt.includes(record.snapshot!.name));
    }
  }
  const initialReads = readNames.length;
  let denial: string | undefined;
  for (const name of [context.comparisons.month.current.snapshot!.name, evidence.records.get("q1")!.snapshot!.name, "unknown-secret"]) {
    await assert.rejects(run(0, "code_interpreter", { snapshot: name, code: "emit_result(summary='read')" }), (error: unknown) => {
      assert.ok(error instanceof Error);
      denial ??= error.message;
      assert.equal(error.message, denial);
      assert.ok(!error.message.includes(name));
      assert.ok(!error.message.includes(context.comparisons.quarter.current.snapshot!.name));
      return true;
    });
  }
  assert.equal(readNames.length, initialReads, "denied reads never reach Python or snapshot resolution");
  const queries = await Promise.all(agents.map((_, index) => run(index, "execute_sql", { sql: "SELECT 1 AS marker", save_as: "same-name" })));
  const details = queries.map((result) => JSON.parse(result.content.find((part) => part.type === "text")!.text));
  assert.equal(new Set(details.map((entry) => entry.snapshot.name)).size, 3);
  for (const [index, scope] of scopes.entries()) {
    assert.equal(evidence.catalog(scope).length, 4);
    assert.equal(evidence.catalog(scope).at(-1)!.evidence_id, details[index].evidence_id);
    await run(index, "code_interpreter", { snapshot: details[index].snapshot.name, code: "emit_result(summary='read')" });
    await assert.rejects(run(index, "code_interpreter", { snapshot: details[(index + 1) % 3].snapshot.name, code: "emit_result(summary='read')" }), /当前子任务/u);
    await assert.rejects(run(index, "execute_sql", { period: "month", sql: "SELECT 1" }), /服务端绑定/u);
  }
  const samePeriodOtherTask = evidence.scope(context, "week", "another-week-agent");
  assert.throws(() => evidence.assertSnapshotAccess(details[0].snapshot.name, samePeriodOtherTask), /当前子任务/u);
  const parent = createAnalysisTools(evidence, interpreter);
  const parentSql = parent.find((tool) => tool.name === "execute_sql")!;
  await assert.rejects(parentSql.execute("missing", { sql: "SELECT 1" }, undefined, undefined, undefined as never), /指定 period/u);
  await assert.rejects(parentSql.execute("bad", { period: "year", sql: "SELECT 1" }, undefined, undefined, undefined as never), /指定 period/u);
  const followUp = await parentSql.execute("parent", { period: "week", sql: "SELECT 2" }, undefined, undefined, undefined as never);
  const parentData = JSON.parse(followUp.content.find((part) => part.type === "text")!.text);
  assert.deepEqual(parentData.owner, { period: "week", agentId: "root" });
  assert.equal(evidence.catalog(scopes[0]!).length, 4, "parent follow-ups do not enter a child's whitelist");
  const parentPython = parent.find((tool) => tool.name === "code_interpreter")!;
  await parentPython.execute("parent-read", { snapshot: details[1].snapshot.name, code: "emit_result(summary='read')" }, undefined, undefined, undefined as never);
  assert.equal(readNames.at(-1), details[1].snapshot.name);
});

test("stringified report structures are decoded before strict validation without echoing the report", (t) => {
  const { config, connections } = fixture(t);
  const database = new DatabaseSync(config.databasePath, { readOnly: true });
  connections.push(database);
  const evidence = new AnalysisEvidence(database);
  const context = evidence.context(calculatedDashboard(database, "2026-01-12"), "2026-01-12");
  const report = reportFor(context);
  assert.deepEqual(parseAnalysisReport({ periods: JSON.stringify(report.periods) }), report);
  const nested = { periods: report.periods.map((period) => ({ ...period, groups: JSON.stringify(period.groups) })) };
  assert.deepEqual(validateAnalysisReport(nested, context, evidence.records).report, report);
  assert.throws(() => parseAnalysisReport({ periods: "[" }), /合法的 JSON/u);
  assert.throws(() => parseAnalysisReport({ periods: JSON.stringify([{ ...report.periods[0], period: "invalid" }]) }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(error.message.length < 500);
    assert.doesNotMatch(error.message, /Performance|Socket/u);
    return true;
  });
});

test("daily model budgets respect deployment limits and reserve compaction/output space", (t) => {
  const { config, directory } = fixture(t);
  const budget = analysisBudget({ contextWindow: 1_000_000, maxTokens: 131072 }, config.analysis);
  assert.equal(budget.contextWindow, 262144);
  assert.equal(budget.maxTokens, 32768);
  assert.equal(budget.compaction.enabled, true);
  assert.ok(budget.compaction.reserveTokens > budget.maxTokens);
  const smaller = analysisBudget({ contextWindow: 16384, maxTokens: 8192 }, config.analysis);
  assert.equal(smaller.maxTokens, 4096);
  assert.ok(smaller.compaction.keepRecentTokens < smaller.contextWindow - smaller.compaction.reserveTokens);
  for (const name of ["SQL_WEB_DAILY_ANALYSIS_CONTEXT_WINDOW", "SQL_WEB_DAILY_ANALYSIS_MAX_OUTPUT_TOKENS"]) {
    for (const value of ["0", "-1", "NaN", "1.5"]) assert.throws(() => loadDataCommandConfig(directory, { [name]: value }), /整数 token/u);
  }
});

test("analysis evidence shares the metrics snapshot and validates six unchanged columns and actual measured hours", (t) => {
  const { config, directory, connections } = fixture(t);
  const database = new DatabaseSync(config.databasePath, { readOnly: true });
  connections.push(database);
  database.exec("BEGIN");
  const base = calculatedDashboard(database, "2026-01-12");
  const artifacts = new SessionArtifactStore(directory, "test-snapshots");
  const evidence = new AnalysisEvidence(database, undefined, artifacts);
  const context = evidence.context(base, "2026-01-12");
  assert.deepEqual(context.comparisons.week.minimum.range, { start: "2026-01-01", end: "2026-01-03" });
  assert.deepEqual(context.comparisons.week.current.range, { start: "2026-01-04", end: "2026-01-10" });
  const writer = new DatabaseSync(config.databasePath);
  writer.prepare("UPDATE oee_availability SET time_span=18000 WHERE final_state='Conversion'").run();
  writer.close();
  const loss = evidence.recordLoss(measureLoss(evidence.queries, artifacts, { start_date: context.periods.week.start, end_date: context.periods.week.end }), { period: "week", agentId: "root" });
  assert.equal(loss.rows[0]?.["state_group"], "Conversion");
  assert.equal(loss.rows[0]?.["loss_hours"], 2.5, "reads the original transaction snapshot after concurrent changes");
  assert.equal(loss.rows[0]?.["hours_per_kind_available_day"], 2.5);
  assert.equal(loss.rows[0]?.["hours_per_selected_day"], 2.5 / 7);
  const report = reportFor(context);
  const item = report.periods[0]!.groups[0]!.items[0]!;
  item.category = "availability";
  item.issue = "Conversion 损失集中，换线准备不足的原因待验证。";
  item.measure = "核查换线准备时间并试行物料预备，按机台复测换线时长。";
  item.suggested_owner = "工艺工程";
  item.evidence_ids.push(loss.id);
  item.loss_reference = { evidence_id: loss.id, row_index: 0 };
  const analyzed = applyAnalysisReport(base, validateAnalysisReport(report, context, evidence.records));
  assert.deepEqual(analyzed.widgets.slice(0, 9), base.widgets.slice(0, 9));
  assert.equal(analyzed.widgets[9]?.data[0]?.["loss_hours"], 2.5);
  assert.equal(analyzed.widgets[9]?.data[1]?.["loss_hours"], null);
  assert.match(String(analyzed.widgets[9]?.data[0]?.["suggested_owner"]), /工艺工程/u);
  const original = createDefaultDashboard();
  assert.deepEqual(analyzed.widgets.map((w) => [w.id, w.size]), original.widgets.map((w) => [w.id, w.size]));
  for (const widget of analyzed.widgets.slice(9)) {
    assert.equal(widget.kind, "table");
    if (widget.kind !== "table") continue;
    assert.deepEqual(widget.encoding.columns, [
      { key: "kind", label: "类型" }, { key: "priority", label: "优先级" },
      { key: "issue", label: "问题（损失源）" }, { key: "measure", label: "改善措施" },
      { key: "suggested_owner", label: "建议责任人" }, { key: "loss_hours", label: "本期损失小时" },
    ]);
    assert.ok(!widget.warnings.some((w) => w.startsWith("本次分析暂不可用")));
    assert.ok(widget.warnings.some((w) => w.includes("缺")));
  }
  const reject = (mutate: (value: AnalysisReport) => void, expected: RegExp): void => {
    const copy = structuredClone(report); mutate(copy);
    assert.throws(() => validateAnalysisReport(copy, context, evidence.records), expected);
  };
  reject((r) => { r.periods[0]!.minimum_evidence = "invalid"; }, /最低点/u);
  reject((r) => { r.periods[0]!.groups[0]!.items[0]!.evidence_ids = ["invalid"]; }, /证据不存在/u);
  reject((r) => { r.periods[0]!.groups[0]!.items[0]!.loss_reference!.row_index = 1; }, /同类型/u);
  reject((r) => { r.periods[0]!.groups[0]!.items[0]!.loss_reference!.row_index = 999; }, /同类型/u);
  reject((r) => { r.periods[1]!.groups[0]!.items[0] = structuredClone(item); }, /本周期/u);
  reject((r) => { r.periods[0]!.groups[0]!.items[0]!.category = "yield"; }, /不得折算/u);
  reject((r) => { r.periods[0]!.groups[0]!.items[0]!.priority = 2; }, /连续/u);
  reject((r) => { r.periods.pop(); }, /结构无效/u);
  reject((r) => { r.periods[0]!.groups[0]!.items = []; }, /空清单/u);
  const ordinarySql = evidence.query(loss.sql, loss.parameters, 200, { period: "week", agentId: "root" });
  evidence.records.set(ordinarySql.id, { ...ordinarySql, range: loss.range! });
  reject((r) => {
    const target = r.periods[0]!.groups[0]!.items[0]!;
    target.evidence_ids.push(ordinarySql.id);
    target.loss_reference = { evidence_id: ordinarySql.id, row_index: 0 };
  }, /measure_loss/u);
  const monthLoss = evidence.recordLoss(measureLoss(evidence.queries, artifacts, {
    start_date: context.periods.month.start, end_date: context.periods.month.end,
  }), { period: "month", agentId: "root" });
  assert.deepEqual(context.periods.month, context.periods.quarter);
  const overlapping = structuredClone(report);
  for (const period of overlapping.periods.filter((entry) => entry.period !== "week")) {
    const target = period.groups[0]!.items[0]!;
    target.category = "availability";
    target.evidence_ids.push(monthLoss.id);
    target.loss_reference = { evidence_id: monthLoss.id, row_index: 0 };
  }
  assert.throws(() => validateAnalysisReport(overlapping, context, evidence.records), /不属于本周期/u);
  const quarterLoss = evidence.recordLoss(measureLoss(evidence.queries, artifacts, {
    start_date: context.periods.quarter.start, end_date: context.periods.quarter.end,
  }), { period: "quarter", agentId: "root" });
  const quarterItem = overlapping.periods[2]!.groups[0]!.items[0]!;
  quarterItem.evidence_ids = [context.comparisons.quarter.current.id, quarterLoss.id];
  quarterItem.loss_reference = { evidence_id: quarterLoss.id, row_index: 0 };
  const validated = validateAnalysisReport(overlapping, context, evidence.records);
  assert.equal(validated.rows.month[0]?.["loss_hours"], 7.5);
  assert.equal(validated.rows.quarter[0]?.["loss_hours"], 7.5, "matching ranges still require separate period evidence");
  assert.throws(() => evidence.query("DELETE FROM oee_availability"), /只读/u);
  assert.throws(() => evidence.query("ATTACH DATABASE ':memory:' AS another"));
  assert.throws(() => evidence.query("PRAGMA query_only=OFF"));
  database.exec("COMMIT");
});

test("reports require readable business text while preserving structured audit references", (t) => {
  const { config, connections } = fixture(t);
  const database = new DatabaseSync(config.databasePath, { readOnly: true });
  connections.push(database);
  const base = calculatedDashboard(database, "2026-01-12");
  const evidence = new AnalysisEvidence(database);
  const context = evidence.context(base, "2026-01-12");
  const report = reportFor(context);
  report.periods[0]!.groups[0]!.items[0]!.issue = "MT 在 Q1 的 W01 可用率偏低；ADH075 的 Assistance（协助等待）需进一步核查。";
  const result = validateAnalysisReport(report, context, evidence.records);
  assert.deepEqual(result.report, report, "audit references and business identifiers are preserved");
  assert.deepEqual(result.report.periods[0]!.groups[0]!.items[0]!.evidence_ids,
    [context.comparisons.week.current.id]);

  for (const field of ["comparison", "no_findings_reason", "issue", "measure", "suggested_owner"] as const) {
    const copy = structuredClone(report);
    const period = copy.periods[0]!;
    const group = period.groups[0]!;
    if (field === "comparison") period.comparison = "依据（q11/q13）判断";
    else if (field === "no_findings_reason") {
      group.items = [];
      group.no_findings_reason = "q11 无数据";
    } else group.items[0]![field] = "依据q11第 0 行判断";
    assert.throws(() => validateAnalysisReport(copy, context, evidence.records),
      (error: unknown) => error instanceof Error && error.message.includes(field) && error.message.includes("改写"), field);
  }
  for (const internal of [
    "q11", "（q11/q13）", "第 0 行", "row 0", "row_index=0", "evidence_ids",
    "measure_loss(week/month)", "execute_sql", "hours_per_kind_available_day", "observed_days",
  ]) {
    const copy = structuredClone(report);
    copy.periods[0]!.groups[0]!.items[0]!.measure = "下周复查 " + internal;
    assert.throws(() => validateAnalysisReport(copy, context, evidence.records), /改写/u, internal);
  }
  report.periods[0]!.groups[0]!.items[0]!.measure = "下周复查各机台损失时长，以每个有数据业务日的平均损失小时进行比较。";
  const analyzed = applyAnalysisReport(base, validateAnalysisReport(report, context, evidence.records));
  assert.equal(analyzed.widgets[9]?.data[0]?.["measure"], report.periods[0]!.groups[0]!.items[0]!.measure);
});

test("unavailable models publish new metrics and empty analysis, without creating website sessions", { timeout: 30_000 }, async (t) => {
  const { config } = fixture(t);
  let published: DashboardState | undefined;
  const registry = new DashboardRegistry([createDefaultDashboardDefinition(config, {
    generate: generateDefaultDashboard,
    publish(_file, state) {
      published = state;
      assert.equal(state.dateRange?.end, "2026-01-12");
      assert.ok(Math.abs(Number(state.widgets[1]?.data[0]?.["overall_oee_percent"]) - 100 / 6) < 1e-10);
      for (const widget of state.widgets.slice(9)) {
        assert.deepEqual(widget.data, []);
        assert.ok(widget.warnings.some((warning) => warning.includes("本次分析暂不可用")));
      }
    },
  })]);
  const result = await runDailyUpdate(config, dailyUpdatePlan(["--through-date", "2026-01-12"], new Date("2026-01-13T01:00:00Z")), registry, logger, {
    openStore: () => ({
      async sync() { return { runId: "test", status: "completed", datasets: [] }; }, close() {},
    }),
  });
  assert.equal(result.status, "completed_with_warnings", JSON.stringify(result));
  const outcome = result.dashboards[0]!;
  assert.equal(outcome.details?.["analysisStatus"], "failed");
  assert.equal(outcome.published, true);
  assert.match(outcome.reason ?? "", /模型列表/u);
  assert.ok(!readdirSync(path.join(config.analysis.cwd, ".data")).includes("sessions"));
  const artifactDir = outcome.details?.["analysisArtifactDir"];
  assert.equal(typeof artifactDir, "string");
  const saved = JSON.parse(readFileSync(path.join(artifactDir as string, "run.json"), "utf8"));
  assert.equal(saved.status, "failed");
  assert.ok(published);
  assertNumericCardsUnchanged(published, artifactDir as string);
});

test("parent terminates a blocked child after base delivery and waits for process exit", { timeout: 10_000 }, async (t) => {
  // Allow the instrumented child to start on loaded CI hosts before testing its blocked phase.
  const { config, directory } = fixture(t, 1500);
  const worker = path.join(directory, "blocked.mjs");
  writeFileSync(path.join(directory, "base.json"), JSON.stringify(createDefaultDashboard()));
  writeFileSync(worker, `import {readFileSync,writeFileSync} from 'node:fs';
    process.once('message', request => {
      writeFileSync(request.runDir + '/pid', String(process.pid));
      process.send({type:'base', state: JSON.parse(readFileSync(request.config.cwd + '/base.json','utf8'))}, () => { while(true) {} });
    });`);
  const result = await generateDefaultDashboard(config, "2026-01-12", new Date(), [], logger, "timeout-test", pathToFileURL(worker));
  assert.equal(result.analysisStatus, "timed_out");
  assertNumericCardsUnchanged(result.state, result.analysisArtifactDir);
  const pid = Number(readFileSync(path.join(result.analysisArtifactDir, "pid"), "utf8"));
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  assert.ok(result.state.widgets.slice(9).every((widget) => widget.data.length === 0));
});

test("invalid timeout settings fail early", (t) => {
  const { directory } = fixture(t);
  for (const value of ["0", "-1", "abc", "600.5", "2147483648"]) {
    assert.throws(() => loadDataCommandConfig(directory, { SQL_WEB_DAILY_ANALYSIS_TIMEOUT_MS: value }), /正整数/u);
  }
});

test("empty current periods and missing minima retain nulls and require explicit no-findings explanations", (t) => {
  const { config, connections } = fixture(t);
  const database = new DatabaseSync(config.databasePath, { readOnly: true });
  connections.push(database);
  database.exec("BEGIN");
  const base = calculatedDashboard(database, "2027-01-01");
  const evidence = new AnalysisEvidence(database);
  const context = evidence.context(base, "2027-01-01");
  assert.equal(context.comparisons.week.minimum.range, undefined);
  assert.deepEqual(context.comparisons.week.current.range, { start: "2026-12-20", end: "2026-12-26" });
  const report = reportFor(context);
  for (const period of report.periods) for (const group of period.groups) {
    group.items = [];
    group.no_findings_reason = "本期无可计算指标，缺少可验证的改善依据";
  }
  const analyzed = applyAnalysisReport(base, validateAnalysisReport(report, context, evidence.records));
  assert.equal(analyzed.widgets[1]?.data[0]?.["overall_oee_percent"], null);
  assert.ok(analyzed.widgets.slice(9).every((widget) => widget.data.length === 0 && widget.warnings.some((warning) => warning.includes("无可计算"))));
});

async function mockModel(t: TestContext, directory: string, responder: (body: Record<string, unknown>) => unknown,
  options: { contextWindow?: number; maxTokens?: number; firstPromptTokens?: number; tokenUsageRequest?: number;
    promptTokensFor?: (body: Record<string, unknown>) => number | undefined } = {}): Promise<Server> {
  let requests = 0;
  const errors: unknown[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
      const result = await responder(body);
      if (result instanceof Error) { response.writeHead(400); response.end(JSON.stringify({ error: { message: result.message } })); return; }
      const calls = typeof result === "string" ? null : result;
      requests += 1;
      const promptTokens = options.promptTokensFor?.(body) ??
        (requests === (options.tokenUsageRequest ?? 1) ? options.firstPromptTokens : undefined);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end('data: ' + JSON.stringify({
        id: "completion", object: "chat.completion.chunk", created: 0, model: "test-model",
        choices: [{ index: 0, delta: { role: "assistant", ...(calls ? { tool_calls: calls } : { content: typeof result === "string" ? result : "done" }) }, finish_reason: null }],
      }) + '\n\ndata: ' + JSON.stringify({
        id: "completion", choices: [{ index: 0, delta: {}, finish_reason: calls ? "tool_calls" : "stop" }],
        ...(promptTokens ? { usage: { prompt_tokens: promptTokens, completion_tokens: 1, total_tokens: promptTokens + 1 } } : {}),
      }) + '\n\ndata: [DONE]\n\n');
    } catch (error) {
      errors.push(error); response.writeHead(500); response.end(String(error));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections(); server.close();
    assert.deepEqual(errors, [], "mock model assertions failed");
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const agentDir = path.join(directory, ".data", "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { test: {
    baseUrl: "http://127.0.0.1:" + address.port + "/v1", api: "openai-completions", apiKey: "test-key",
    models: [{ id: "test-model", name: "test model", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: options.contextWindow ?? 128000, maxTokens: options.maxTokens ?? 8192 }],
  } } }));
  return server;
}

function toolCall(index: number, name: string, args: unknown) {
  return { index, id: "call-" + index + "-" + name, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

function modelMessages(body: Record<string, unknown>) {
  return (body["messages"] as { role: string; name?: string; content: string | { text?: string }[] }[])
    .map((message) => ({ ...message, content: typeof message.content === "string" ? message.content
      : message.content?.map((part) => part.text ?? "").join("") ?? "" }));
}

function modelContext(body: Record<string, unknown>) {
  const values = modelMessages(body).flatMap((message) => {
    try { return [JSON.parse(message.content)]; } catch { return []; }
  });
  const root = values.find((value) => Array.isArray(value.subagent_results));
  const child = values.find((value) => value.data?.evidence);
  assert.ok(root || child, "server-owned context must be injected");
  return { root, child: child?.data };
}

function savedContext(runDir: string): AnalysisContext {
  return JSON.parse(readFileSync(path.join(runDir, "context.json"), "utf8")) as AnalysisContext;
}

function lossReport(runDir: string): AnalysisReport {
  const context = savedContext(runDir);
  const report = reportFor(context);
  const records = readFileSync(path.join(runDir, "evidence.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  for (const period of report.periods) {
    const loss = records.find((entry) => entry.source === "measure_loss" && entry.owner.period === period.period);
    assert.ok(loss, "missing loss evidence for " + period.period);
    for (const group of period.groups) {
      const item = group.items[0]!;
      item.category = "availability";
      item.issue = "Conversion（换线）损失，准备时间待验证";
      item.measure = "试行换线预备并比较日均换线时长";
      item.suggested_owner = "换线工艺工程";
      item.evidence_ids.push(loss.id);
      item.loss_reference = { evidence_id: loss.id, row_index: loss.rows.findIndex((row: { kind: string }) => row.kind === group.kind) };
    }
  }
  return report;
}

function childLossResponse(body: Record<string, unknown>, runDir: string): unknown {
  const { child } = modelContext(body);
  assert.ok(child);
  const keys = Object.keys(child.periods);
  assert.equal(keys.length, 1);
  const period = keys[0] as PeriodKey;
  const context = savedContext(runDir);
  const tools = body["tools"] as { function: { name: string; parameters: { properties: Record<string, unknown> } } }[];
  assert.ok(!tools.some((tool) => ["subagent", "submit_analysis", "finalize_analysis", "get_analysis_draft", "send_email", "update_dashboard"].includes(tool.function.name)));
  assert.ok(tools.filter((tool) => ["measure_loss", "execute_sql"].includes(tool.function.name))
    .every((tool) => !("period" in tool.function.parameters.properties)));
  assert.ok(child.evidence.every((entry: { owner: { period: string } }) => entry.owner.period === period));
  const messages = JSON.stringify(body["messages"]);
  for (const other of PERIOD_KEYS.filter((key) => key !== period)) {
    assert.ok(!messages.includes(context.comparisons[other].current.snapshot!.name));
    assert.ok(!messages.includes(context.comparisons[other].minimum.snapshot!.name));
    assert.ok(!messages.includes(context.comparisons[other].history.snapshot!.name));
  }
  if (!modelMessages(body).some((message) => message.role === "tool")) {
    return [toolCall(0, "measure_loss", { start_date: context.periods[period].start, end_date: context.periods[period].end })];
  }
  return "本周期候选结论：Conversion（换线）损失，准备时间待验证；试行换线预备并比较日均时长，建议换线工艺工程跟进。";
}

test("ephemeral model repairs evidence and unreadable prose then immediately accepts a complete report", { timeout: 30_000 }, async (t) => {
  const { config, directory } = fixture(t);
  const runDir = path.join(config.analysis.artifactDir, "mock-analysis");
  let turn = 0;
  await mockModel(t, directory, (body) => {
    const { root } = modelContext(body);
    if (!root) return childLossResponse(body, runDir);
    turn += 1;
    assert.equal(existsSync(path.join(runDir, "report.json")), false);
    assert.doesNotMatch(JSON.stringify(body["messages"]), /Received arguments:/u);
    if (turn === 1) return [
      toolCall(0, "read", { path: path.join(directory, "outside.txt") }),
      toolCall(1, "execute_sql", { period: "week", sql: "DELETE FROM oee_availability" }),
    ];
    const report = lossReport(runDir);
    if (turn === 2) report.periods[0]!.minimum_evidence = "missing";
    if (turn === 3) report.periods[0]!.groups[0]!.items[0]!.issue = "本周换线损失 2.5 小时（q11 第 0 行）";
    return [toolCall(0, "submit_analysis", { ...report, periods: JSON.stringify(report.periods) })];
  });
  writeFileSync(path.join(directory, "outside.txt"), "must not be readable");
  const result = await generateDefaultDashboard(config, "2026-01-12", new Date(), [], logger, "mock-analysis");
  assert.equal(result.analysisStatus, "completed", result.analysisReason ?? "");
  assertNumericCardsUnchanged(result.state, result.analysisArtifactDir);
  assert.equal(turn, 4, "first valid submission finishes without any review or confirmation request");
  assert.ok(!("verification" in JSON.parse(readFileSync(path.join(runDir, "report.json"), "utf8"))));
  assert.equal(result.state.widgets[9]?.data[0]?.["loss_hours"], 2.5);
  assert.equal(result.state.widgets[10]?.data[0]?.["loss_hours"], 7.5);
  const events = readFileSync(path.join(runDir, "events.jsonl"), "utf8");
  assert.match(events, /read 仅允许/u);
  assert.match(events, /只读/u);
  assert.match(events, /最低点/u);
  assert.match(events, /业务用户可理解/u);
  assert.doesNotMatch(events, /must not be readable|"type":"analysis_draft"|"type":"analysis_review"/u);
  assert.doesNotMatch(JSON.stringify(result.state.widgets.slice(9)), /\bq\d+\b|第\s*0\s*行/u);
  assert.ok(!readdirSync(path.join(directory, ".data")).includes("sessions"));
});

test("daily orchestration starts three isolated periods concurrently before the parent submits once", { timeout: 30_000 }, async (t) => {
  const { config, directory } = fixture(t);
  const runDir = path.join(config.analysis.artifactDir, "subagent-report");
  let rootTurns = 0;
  let started = 0;
  let completed = 0;
  let release!: () => void;
  const allStarted = new Promise<void>((resolve) => { release = resolve; });
  await mockModel(t, directory, async (body) => {
    const { root } = modelContext(body);
    if (!root) {
      if (!modelMessages(body).some((message) => message.role === "tool")) {
        started += 1;
        if (started === 3) release();
        await allStarted;
      }
      const response = childLossResponse(body, runDir);
      if (typeof response === "string") completed += 1;
      return response;
    }
    rootTurns += 1;
    assert.equal(completed, 3);
    const children = root.subagent_results as SubagentResult[];
    assert.deepEqual(children.map((entry) => entry.name), PERIOD_KEYS);
    assert.deepEqual(children.map((entry) => entry.status), ["completed", "completed", "completed"]);
    const tools = body["tools"] as { function: { name: string; parameters: { required?: string[] } } }[];
    assert.ok(!tools.some((tool) => ["subagent", "get_analysis_draft", "finalize_analysis"].includes(tool.function.name)));
    assert.ok(tools.filter((tool) => ["execute_sql", "measure_loss"].includes(tool.function.name))
      .every((tool) => tool.function.parameters.required?.includes("period")));
    return [toolCall(0, "submit_analysis", lossReport(runDir))];
  });
  const result = await generateDefaultDashboard(config, "2026-01-12", new Date(), [], logger, "subagent-report");
  assert.equal(result.analysisStatus, "completed", result.analysisReason ?? "");
  assert.equal(started, 3);
  assert.equal(rootTurns, 1);
  assertNumericCardsUnchanged(result.state, runDir);
  const metrics = JSON.parse(readFileSync(path.join(runDir, "metrics.json"), "utf8"));
  assert.equal(Object.keys(metrics.agents).length, 4);
  assert.equal(metrics.tools.measure_loss.calls, 3);
  assert.equal(metrics.tools.subagent.calls, 1);
  assert.equal(metrics.tools.submit_analysis.calls, 1);
  assert.ok(metrics.delegationMs > 0);
  assert.ok(!metrics.turns.some((turn: { phase: string }) => /review|draft/u.test(turn.phase)));
});

for (const failure of ["failed", "truncated"] as const) {
  test("parent fills the " + failure + " period from its own scoped evidence", { timeout: 30_000 }, async (t) => {
    const { config, directory } = fixture(t);
    const runId = "fallback-" + failure;
    const runDir = path.join(config.analysis.artifactDir, runId);
    let rootTurns = 0;
    await mockModel(t, directory, (body) => {
      const { root, child } = modelContext(body);
      if (!root) {
        if (child.periods.week) return failure === "failed" ? new Error("week investigation failed") : "不完整结论".repeat(4000);
        return childLossResponse(body, runDir);
      }
      rootTurns += 1;
      const week = (root.subagent_results as SubagentResult[])[0]!;
      if (failure === "failed") assert.equal(week.status, "failed");
      else assert.equal(week.text_truncated, true);
      if (rootTurns === 1) {
        const context = savedContext(runDir);
        return [toolCall(0, "measure_loss", { period: "week", start_date: context.periods.week.start, end_date: context.periods.week.end })];
      }
      assert.ok(root.evidence.some((entry: { owner?: { period: string; agentId: string } }) => entry.owner?.period === "week" && entry.owner.agentId === "root"));
      return [toolCall(0, "submit_analysis", lossReport(runDir))];
    });
    const result = await generateDefaultDashboard(config, "2026-01-12", new Date(), [], logger, runId);
    assert.equal(result.analysisStatus, "completed", result.analysisReason ?? "");
    assert.equal(rootTurns, 2);
    assert.equal(result.state.widgets[9]?.data[0]?.["loss_hours"], 2.5);
  });
}

test("unsuccessful parent fallback uses two repair prompts then publishes only numeric cards", { timeout: 30_000 }, async (t) => {
  const { config, directory } = fixture(t);
  let rootTurns = 0;
  await mockModel(t, directory, (body) => {
    if (!modelContext(body).root) return new Error("child unavailable");
    rootTurns += 1;
    return "未能完成报告";
  });
  const result = await generateDefaultDashboard(config, "2026-01-12", new Date(), [], logger, "fallback-failed");
  assert.equal(result.analysisStatus, "failed");
  assert.equal(rootTurns, 3);
  assertNumericCardsUnchanged(result.state, result.analysisArtifactDir);
  assert.ok(result.state.widgets.slice(9).every((widget) => !widget.data.length));
  assert.equal(existsSync(path.join(result.analysisArtifactDir, "report.json")), false);
});

test("ephemeral analysis compacts context and restores child results and scoped evidence", { timeout: 30_000 }, async (t) => {
  const { config, directory } = fixture(t);
  const runDir = path.join(config.analysis.artifactDir, "compaction-test");
  let turn = 0;
  let summaries = 0;
  await mockModel(t, directory, (body) => {
    assert.ok(Number(body["max_tokens"] ?? body["max_completion_tokens"]) <= 32768);
    if (!body["tools"]) { summaries += 1; return "继续依据系统比较基准和服务端子任务结果汇总报告。"; }
    const { root } = modelContext(body);
    if (!root) return "本周期数据不足，请主 Agent 补齐。";
    turn += 1;
    if (turn === 1) return [
      toolCall(0, "execute_sql", { period: "week", sql: "SELECT 1 AS marker", save_as: "compact-check" }),
      toolCall(1, "execute_sql", { period: "week", sql: "-- " + "x".repeat(70_000) + "\nSELECT 1", save_as: "large-request" }),
    ];
    assert.equal(root.subagent_results.length, 3);
    assert.ok(root.evidence.some((entry: { owner?: { agentId: string } }) => entry.owner?.agentId === "root"));
    assert.match(JSON.stringify(body["messages"]), /minimum_evidence/u);
    if (turn === 2) return "已完成汇总，准备提交。";
    assert.ok(summaries >= 1);
    assert.match(JSON.stringify(body["messages"]), /尚未提交有效报告/u);
    return [toolCall(0, "submit_analysis", reportFor(savedContext(runDir)))];
  }, { contextWindow: 1_000_000, maxTokens: 131072, firstPromptTokens: 230000, tokenUsageRequest: 5 });
  const result = await generateDefaultDashboard(config, "2026-01-12", new Date(), [], logger, "compaction-test");
  assert.equal(result.analysisStatus, "completed", result.analysisReason ?? "");
  assert.ok(summaries >= 1);
  const events = readFileSync(path.join(runDir, "events.jsonl"), "utf8");
  assert.match(events, /"type":"compaction_end"/u);
  assert.match(events, /"contextWindow":262144/u);
  assert.match(events, /"maxOutputTokens":32768/u);
});

test("child compaction restores only its period baselines and its own new evidence", { timeout: 30_000 }, async (t) => {
  const { config, directory } = fixture(t);
  const runDir = path.join(config.analysis.artifactDir, "child-compaction");
  let weekTurns = 0;
  let summaries = 0;
  await mockModel(t, directory, (body) => {
    if (!body["tools"]) { summaries += 1; return "继续本周期调查，使用服务端证据目录。"; }
    const { root, child } = modelContext(body);
    if (root) return [toolCall(0, "submit_analysis", lossReport(runDir))];
    if (!child.periods.week) return childLossResponse(body, runDir);
    weekTurns += 1;
    assert.ok(child.evidence.every((entry: { owner: { period: string } }) => entry.owner.period === "week"));
    if (weekTurns === 1) return [
      toolCall(0, "execute_sql", { sql: "SELECT 1 AS marker", save_as: "week-marker" }),
      toolCall(1, "execute_sql", { sql: "-- " + "x".repeat(70_000) + "\nSELECT 1", save_as: "week-long" }),
    ];
    if (weekTurns === 2) return [toolCall(0, "measure_loss", {
      start_date: child.periods.week.start, end_date: child.periods.week.end,
    })];
    assert.ok(summaries >= 1);
    assert.equal(child.evidence.length, 5, "three baselines, the marker query and loss evidence survive; the oversized query was rejected");
    childLossResponse(body, runDir); // Also checks no other period's anchors reach this model request.
    return "本周损失已分析，使用本周标准证据汇总。";
  }, { contextWindow: 1_000_000, maxTokens: 131072, promptTokensFor(body) {
    if (!body["tools"]) return undefined;
    const { child } = modelContext(body);
    return child?.periods.week && modelMessages(body).filter((message) => message.role === "tool").length === 2 ? 230000 : undefined;
  } });
  const result = await generateDefaultDashboard(config, "2026-01-12", new Date(), [], logger, "child-compaction");
  assert.equal(result.analysisStatus, "completed", result.analysisReason ?? "");
  assert.ok(summaries >= 1);
  const events = readFileSync(path.join(runDir, "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(events.some((event) => event.type === "compaction_end" && event.taskName === "week"));
});

for (const stop of ["abort", "timeout"] as const) {
  test("daily " + stop + " cleans up all three children without publishing", { timeout: 15_000 }, async (t) => {
    const { config, directory, connections } = fixture(t);
    const pending: ((result: string) => void)[] = [];
    let started!: () => void;
    const allStarted = new Promise<void>((resolve) => { started = resolve; });
    await mockModel(t, directory, (body) => {
      const { child } = modelContext(body);
      if (stop === "abort") assert.ok(child);
      return new Promise<string>((resolve) => {
        pending.push(resolve);
        if (pending.length === 3) started();
      });
    });
    t.after(() => pending.forEach((resolve) => resolve("cancelled")));
    const database = new DatabaseSync(config.databasePath, { readOnly: true });
    connections.push(database);
    const evidence = new AnalysisEvidence(database, undefined, new SessionArtifactStore(directory, "cancel-data"));
    const context = evidence.context(calculatedDashboard(database, "2026-01-12"), "2026-01-12");
    const events: Record<string, unknown>[] = [];
    const controller = new AbortController();
    let reports = 0;
    const running = runAnalysisAgent({ ...config.analysis, timeoutMs: 3000,
      codeInterpreter: { ...config.analysis.codeInterpreter, pythonPath: "/nonexistent/python",
        bwrapPath: "/nonexistent/bwrap", prlimitPath: "/nonexistent/prlimit" },
    }, context, evidence, (event) => events.push(event), () => { reports += 1; }, controller.signal);
    const rejected = assert.rejects(running, /abort|timeout/iu);
    await allStarted;
    if (stop === "abort") controller.abort();
    await rejected;
    assert.equal(reports, 0);
    if (stop === "abort") assert.ok(!events.some((event) => event["type"] === "model_turn_start" && !event["agentId"]));
    const results = events.filter((event) => event["type"] === "subagent_result").map((event) => event["result"] as SubagentResult);
    assert.equal(results.length, 3);
    assert.deepEqual(results.map((result) => result.status), Array(3).fill(stop === "abort" ? "aborted" : "timed_out"));
  });
}

test("tool budget includes malformed calls and terminates at sixty without a report", { timeout: 30_000 }, async (t) => {
  const { config, directory } = fixture(t);
  await mockModel(t, directory, () => Array.from({ length: 65 }, (_, index) => toolCall(index, "execute_sql", { invalid: true })));
  const result = await generateDefaultDashboard(config, "2026-01-12", new Date(), [], logger, "budget-test");
  assert.equal(result.analysisStatus, "failed");
  assert.match(result.analysisReason ?? "", /60 次/u);
  const events = readFileSync(path.join(result.analysisArtifactDir, "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(events.filter((event) => event.type === "tool_call").length, 60);
  assert.ok(result.state.widgets.slice(9).every((widget) => widget.data.length === 0));
});


test("loss views preserve original row references and compute scoped statistics without summing coverage", () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({ kind: i % 2 ? "ST" : "MT", state_group: i % 4 < 2 ? "PM" : "Conversion",
    machine: "M" + String(40 - i).padStart(2, "0"), loss_hours: i === 0 ? 10.004 : 10,
    observed_days: 1, kind_availability_days: 5, selected_days: 7 }));
  const record: LossResult = { rows, truncated: false,
    range: { start: "2026-01-05", end: "2026-01-11" },
    scope: { states: ["PM", "Conversion"], machines: [], byMachine: true } };
  const full = lossOutput({ ...record, rows: rows.slice(0, 12) }).details;
  assert.ok(full.view.mode === "complete");
  assert.deepEqual(full.view.rows?.map((r) => r.row_index), Array.from({ length: 12 }, (_, i) => i));
  const output = lossOutput(record).details;
  assert.ok(output.view.mode === "summary");
  const mt = output.view.by_kind![0]!;
  assert.equal(mt.kind_availability_days, 5);
  assert.equal(mt.ranking.length, 10);
  assert.equal(mt.ranking[0]!.row_index, 0, "ranking compares unrounded values");
  assert.equal(mt.ranking[1]!.row["machine"], "M02", "ties use machine id");
  assert.ok(Math.abs(mt.loss_hours! - 200.004) < 1e-8);
  assert.ok(Math.abs(mt.state_totals.reduce((sum, state) => sum + state.share_percent!, 0) - 100) < 1e-8);
  for (const state of mt.state_totals) assert.equal(state.hours_per_kind_available_day, state.loss_hours! / 5);
  for (const entry of output.view.by_kind!.flatMap((kind) => kind.ranking)) assert.deepEqual(entry.row, rows[entry.row_index]);
  assert.deepEqual(output.scope, record.scope);
  const st = output.view.by_kind![1]!;
  assert.equal(st.loss_hours, 200);
  assert.equal(st.ranking.length, 10, "both types receive their own top ten");
  assert.equal(lossOutput({ ...record, rows: rows.slice(0, 32) }).details.view.mode, "complete");
  assert.equal(lossOutput({ ...record, rows: rows.slice(0, 33) }).details.view.mode, "summary");
  const ties = lossOutput({ ...record, rows: rows.map((r) => ({ ...r, machine: "same", loss_hours: 10 })) }).details.view;
  assert.ok(ties.mode === "summary");
  assert.equal(ties.by_kind![0]!.ranking[0]!.row["state_group"], "Conversion", "machine ties use state name");
  const zero = lossOutput({ ...record, rows: rows.map((r) => ({ ...r, loss_hours: 0, kind_availability_days: 0 })) });
  assert.ok(zero.details.view.mode === "summary");
  assert.ok(zero.details.view.by_kind!.every((g) => g.state_totals.every((state) => state.share_percent === null && state.hours_per_kind_available_day === null)));
  const inconsistent = lossOutput({ ...record, rows: rows.map((r, i) => ({ ...r, kind_availability_days: i < 2 ? 4 : 5 })) }).details.view;
  assert.ok(inconsistent.mode === "summary");
  assert.ok(inconsistent.by_kind!.every((g) => g.kind_availability_days === null && g.state_totals.every((s) => s.hours_per_kind_available_day === null)));
  const missing = lossOutput({ ...record, rows: [] }).details;
  assert.equal(missing.view.mode, "complete");
  const truncated = lossOutput({ ...record, truncated: true }).details;
  assert.equal(truncated.view.mode, "unavailable");
  assert.equal("by_kind" in truncated.view, false);
  const huge = lossOutput({ ...record, rows: rows.map((r, i) => ({ ...r, machine: "M".repeat(1000) + i, state_group: "S".repeat(1000) + i })) }).details;
  assert.ok(Buffer.byteLength(JSON.stringify(huge.view)) <= LOSS_VIEW_BYTES);
  assert.equal(huge.view.rows_complete, false);
  assert.ok(huge.view.mode === "summary");
  assert.equal(huge.view.state_summaries_complete, false);
  assert.ok(rows.every((r) => r.kind_availability_days === 5), "summary computation does not mutate evidence");
});

test("analysis metrics separate model intervals and tools and record unfinished timeout work", () => {
  const at = (ms: number) => new Date(ms).toISOString();
  const events = [
    { at: at(100), type: "session" }, { at: at(100), type: "model_turn_start", turnId: 1 },
    { at: at(600), type: "assistant", turnId: 1, message: { usage: { input: 100, output: 20 }, content: [{ type: "toolCall", name: "measure_loss" }] } },
    { at: at(600), type: "tool_call", toolCallId: "a", name: "measure_loss" },
    { at: at(700), type: "tool_result", toolCallId: "a", name: "measure_loss", isError: false },
    { at: at(700), type: "model_turn_start", turnId: 2 },
    { at: at(800), type: "auto_retry_start" },
  ];
  const metrics = summarizeAnalysisEvents(events, 0, 1000, 50);
  assert.equal(metrics.baseMs, 50);
  assert.equal(metrics.startupMs, 100);
  assert.equal(metrics.modelObservedMs, 500);
  assert.equal(metrics.toolMs, 100);
  assert.equal(metrics.outputTokens, 20);
  assert.equal(metrics.retryCount, 1);
  assert.deepEqual(metrics.pending, [{ kind: "model", name: "client_observed", durationMs: 300 }]);
});

test("metrics distinguish direct submissions while retaining historical draft and review phases", () => {
  const assistant = (name: string, phase: string) => ({ at: new Date(20).toISOString(), type: "assistant", phase,
    message: { content: [{ type: "toolCall", name }], usage: { input: 10, output: 5 } } });
  const current = summarizeAnalysisEvents([assistant("submit_analysis", "submission"),
    { at: new Date(25).toISOString(), type: "analysis_accepted" }], 0, 2000);
  assert.equal(current.turns[0]!.phase, "submission");
  assert.deepEqual(current.pending, []);
  const legacy = summarizeAnalysisEvents([assistant("submit_analysis", "investigation"),
    { at: new Date(25).toISOString(), type: "analysis_draft" }, assistant("finalize_analysis", "review")], 0, 30);
  assert.deepEqual(legacy.turns.map((turn) => turn.phase), ["draft", "review"]);
});

test("parallel metrics isolate repeated IDs and exclude orchestration waits from tool work", () => {
  const at = (ms: number) => new Date(ms).toISOString();
  const events = [
    { at: at(0), type: "session" },
    { at: at(10), type: "tool_call", toolCallId: "same", name: "subagent" },
    ...["a", "b"].flatMap((agentId) => [
      { agentId, at: at(20), type: "session" },
      { agentId, at: at(20), type: "model_turn_start", turnId: 1 },
      { agentId, at: at(60), type: "assistant", message: { usage: { input: 10, output: 5 }, content: [{ type: "toolCall", name: "execute_sql" }] } },
      { agentId, at: at(60), type: "tool_call", toolCallId: "same", name: "execute_sql" },
      { agentId, at: at(70), type: "tool_result", toolCallId: "same", name: "execute_sql" },
      { agentId, at: at(80), type: "subagent_result" },
    ]),
    { at: at(90), type: "tool_result", toolCallId: "same", name: "subagent" },
  ];
  const metrics = summarizeAnalysisEvents(events, 0, 100);
  assert.equal(metrics.durationMs, 100);
  assert.equal(metrics.inputTokens, 20);
  assert.equal(metrics.outputTokens, 10);
  assert.equal(metrics.modelObservedMs, 80);
  assert.equal(metrics.toolMs, 20);
  assert.equal(metrics.delegationMs, 80);
  assert.equal(metrics.tools["execute_sql"]!.calls, 2);
  assert.deepEqual(metrics.pending, []);
});
