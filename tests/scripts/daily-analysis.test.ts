import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";
import { AnalysisEvidence, PERIOD_KEYS, type AnalysisContext } from "../../src/server/dashboard/default/analysis/evidence.ts";
import { applyAnalysisReport, parseAnalysisReport, validateAnalysisReport, type AnalysisReport } from "../../src/server/dashboard/default/analysis/report.ts";
import { analysisBudget } from "../../src/server/dashboard/default/analysis/budget.ts";
import { createAnalysisTools, evidenceOutput } from "../../src/server/dashboard/default/analysis/tools.ts";
import { SessionArtifactStore } from "../../src/server/tool/artifact-store.ts";
import { CodeInterpreterRuntime } from "../../src/server/tool/code-interpreter.ts";
import { generateAnalyzedDashboard } from "../../src/server/dashboard/default/analysis/run.ts";
import { buildDefaultDashboardInTransaction } from "../../src/server/dashboard/default/build.ts";
import { loadDataCommandConfig } from "../../scripts/database/data-command-config.ts";
import { initializeOeeDatabase } from "../../scripts/database/initialize.ts";
import { dailyUpdatePlan } from "../../scripts/database/daily-update.ts";
import { runDailyUpdate } from "../../scripts/scheduling/daily-update.ts";
import { defaultDashboardOutput } from "../../scripts/scheduling/daily-output.ts";
import { DashboardRegistry } from "../../src/server/dashboard/registry.ts";
import { createDefaultDashboardDefinition } from "../../src/server/dashboard/default/index.ts";
import { createDefaultDashboard } from "../../src/server/dashboard/default/template.ts";
import type { AppLogger } from "../../src/server/logger.ts";

const logger: AppLogger = { info() {}, warn() {}, error() {}, child() { return this; } };

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
      database.prepare("INSERT INTO oee_dut_utilization(machine_id,lot_id,in_qty,out_qty,test_stage,dut_num,step_id,date) VALUES(?,?,?,?,?,?,?,?)")
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
  const base = buildDefaultDashboardInTransaction(database, "2026-01-12");
  const artifacts = new SessionArtifactStore(directory, "test-snapshots");
  const evidence = new AnalysisEvidence(database, undefined, artifacts);
  const context = evidence.context(base, "2026-01-12");
  const loss = evidence.measureLoss("week", context.periods.week, [], [], true);
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
  const run = (params: Record<string, unknown>) => sql.execute("query", params, undefined, undefined, undefined as never);
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

test("stringified report structures are decoded before strict validation without echoing the report", (t) => {
  const { config, connections } = fixture(t);
  const database = new DatabaseSync(config.databasePath, { readOnly: true });
  connections.push(database);
  const evidence = new AnalysisEvidence(database);
  const context = evidence.context(buildDefaultDashboardInTransaction(database, "2026-01-12"), "2026-01-12");
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
  const { config, connections } = fixture(t);
  const database = new DatabaseSync(config.databasePath, { readOnly: true });
  connections.push(database);
  database.exec("BEGIN");
  const base = buildDefaultDashboardInTransaction(database, "2026-01-12");
  const evidence = new AnalysisEvidence(database);
  const context = evidence.context(base, "2026-01-12");
  assert.deepEqual(context.comparisons.week.minimum.range, { start: "2026-01-01", end: "2026-01-04" });
  assert.deepEqual(context.comparisons.week.current.range, { start: "2026-01-05", end: "2026-01-11" });
  const writer = new DatabaseSync(config.databasePath);
  writer.prepare("UPDATE oee_availability SET time_span=18000 WHERE final_state='Conversion'").run();
  writer.close();
  const loss = evidence.measureLoss("week", context.periods.week);
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
  assert.equal(analyzed.widgets[7]?.data[0]?.["loss_hours"], 2.5);
  assert.equal(analyzed.widgets[7]?.data[1]?.["loss_hours"], null);
  assert.match(String(analyzed.widgets[7]?.data[0]?.["suggested_owner"]), /工艺工程/u);
  const original = createDefaultDashboard();
  assert.deepEqual(analyzed.widgets.map((w) => [w.id, w.size]), original.widgets.map((w) => [w.id, w.size]));
  for (const widget of analyzed.widgets.slice(7)) {
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
  reject((r) => { r.periods[1]!.groups[0]!.items[0] = structuredClone(item); }, /本期/u);
  reject((r) => { r.periods[0]!.groups[0]!.items[0]!.category = "yield"; }, /不得折算/u);
  reject((r) => { r.periods[0]!.groups[0]!.items[0]!.priority = 2; }, /连续/u);
  reject((r) => { r.periods.pop(); }, /结构无效/u);
  reject((r) => { r.periods[0]!.groups[0]!.items = []; }, /空清单/u);
  assert.throws(() => evidence.query("DELETE FROM oee_availability"), /只读/u);
  assert.throws(() => evidence.query("ATTACH DATABASE ':memory:' AS another"));
  assert.throws(() => evidence.query("PRAGMA query_only=OFF"));
  database.exec("COMMIT");
});

test("reports require readable business text while preserving structured audit references", (t) => {
  const { config, connections } = fixture(t);
  const database = new DatabaseSync(config.databasePath, { readOnly: true });
  connections.push(database);
  const base = buildDefaultDashboardInTransaction(database, "2026-01-12");
  const evidence = new AnalysisEvidence(database);
  const context = evidence.context(base, "2026-01-12");
  const report = reportFor(context);
  report.verification = "已核对 q2 的原始查询结果。";
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
  assert.equal(analyzed.widgets[7]?.data[0]?.["measure"], report.periods[0]!.groups[0]!.items[0]!.measure);
});

test("unavailable models publish new metrics and empty analysis, without creating website sessions", { timeout: 30_000 }, async (t) => {
  const { config } = fixture(t);
  const registry = new DashboardRegistry([createDefaultDashboardDefinition(config, {
    generate: generateAnalyzedDashboard,
    publish(_file, state) {
      assert.equal(state.dateRange?.end, "2026-01-12");
      assert.ok(Math.abs(Number(state.widgets[0]?.data[0]?.["overall_oee_percent"]) - 100 / 6) < 1e-10);
      for (const widget of state.widgets.slice(7)) {
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
  const outcome = { ...result, ...defaultDashboardOutput(result.dashboards) };
  assert.equal(outcome.status, "completed_with_warnings", JSON.stringify(outcome));
  assert.equal(outcome.analysisStatus, "failed");
  assert.equal(outcome.published, true);
  assert.match(outcome.analysisReason ?? "", /模型列表/u);
  assert.ok(!readdirSync(path.join(config.analysis.cwd, ".data")).includes("sessions"));
  const saved = JSON.parse(readFileSync(path.join(outcome.analysisArtifactDir!, "run.json"), "utf8"));
  assert.equal(saved.status, "failed");
});

test("parent terminates a blocked child after base delivery and waits for process exit", { timeout: 10_000 }, async (t) => {
  const { config, directory } = fixture(t, 250);
  const worker = path.join(directory, "blocked.mjs");
  writeFileSync(path.join(directory, "base.json"), JSON.stringify(createDefaultDashboard()));
  writeFileSync(worker, `import {readFileSync,writeFileSync} from 'node:fs';
    process.once('message', request => {
      writeFileSync(request.runDir + '/pid', String(process.pid));
      process.send({type:'base', state: JSON.parse(readFileSync(request.config.cwd + '/base.json','utf8'))}, () => { while(true) {} });
    });`);
  const result = await generateAnalyzedDashboard(config, "2026-01-12", new Date(), [], logger, "timeout-test", pathToFileURL(worker));
  assert.equal(result.analysisStatus, "timed_out");
  const pid = Number(readFileSync(path.join(result.analysisArtifactDir, "pid"), "utf8"));
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  assert.ok(result.state.widgets.slice(7).every((widget) => widget.data.length === 0));
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
  const base = buildDefaultDashboardInTransaction(database, "2027-01-01");
  const evidence = new AnalysisEvidence(database);
  const context = evidence.context(base, "2027-01-01");
  assert.equal(context.comparisons.week.minimum.range, undefined);
  assert.deepEqual(context.comparisons.week.current.range, { start: "2026-12-21", end: "2026-12-27" });
  const report = reportFor(context);
  for (const period of report.periods) for (const group of period.groups) {
    group.items = [];
    group.no_findings_reason = "本期无可计算指标，缺少可验证的改善依据";
  }
  const analyzed = applyAnalysisReport(base, validateAnalysisReport(report, context, evidence.records));
  assert.equal(analyzed.widgets[0]?.data[0]?.["overall_oee_percent"], null);
  assert.ok(analyzed.widgets.slice(7).every((widget) => widget.data.length === 0 && widget.warnings.some((warning) => warning.includes("无可计算"))));
});

async function mockModel(t: TestContext, directory: string, responder: (body: Record<string, unknown>) => unknown,
  options: { contextWindow?: number; maxTokens?: number; firstPromptTokens?: number } = {}): Promise<Server> {
  let requests = 0;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
      const result = responder(body);
      const calls = typeof result === "string" ? null : result;
      requests += 1;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end('data: ' + JSON.stringify({
        id: "completion", object: "chat.completion.chunk", created: 0, model: "test-model",
        choices: [{ index: 0, delta: { role: "assistant", ...(calls ? { tool_calls: calls } : { content: typeof result === "string" ? result : "done" }) }, finish_reason: null }],
      }) + '\n\ndata: ' + JSON.stringify({
        id: "completion", choices: [{ index: 0, delta: {}, finish_reason: calls ? "tool_calls" : "stop" }],
        ...(requests === 1 && options.firstPromptTokens ? { usage: { prompt_tokens: options.firstPromptTokens,
          completion_tokens: 1, total_tokens: options.firstPromptTokens + 1 } } : {}),
      }) + '\n\ndata: [DONE]\n\n');
    } catch (error) {
      response.writeHead(500); response.end(String(error));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
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

test("ephemeral model repairs evidence and unreadable prose before publishing six-column recommendations", { timeout: 30_000 }, async (t) => {
  const { config, directory } = fixture(t);
  let turn = 0;
  let rejected = false;
  await mockModel(t, directory, (body) => {
    turn += 1;
    assert.equal(body["max_tokens"] ?? body["max_completion_tokens"], 8192);
    if (turn > 1) {
      const messages = body["messages"] as { role: string; name?: string; content: string }[];
      for (const message of messages.filter((message) => message.role === "tool" && message.name === "measure_loss")) {
        assert.ok(message.content.length < 2500, "full SQL and evidence rows stay outside the prompt");
      }
      assert.doesNotMatch(JSON.stringify(messages), /Received arguments:/u);
    }
    if (turn === 1) return [
      toolCall(0, "read", { path: path.join(directory, "outside.txt") }),
      toolCall(1, "execute_sql", { sql: "DELETE FROM oee_availability" }),
      ...PERIOD_KEYS.map((period, index) => toolCall(index + 2, "measure_loss", { period })),
    ];
    const runDir = path.join(config.analysis.artifactDir, "mock-analysis");
    if (turn === 4 || turn === 5) assert.equal(existsSync(path.join(runDir, "report.json")), false, "unreadable prose and an unreviewed draft cannot be published");
    const context = JSON.parse(readFileSync(path.join(runDir, "context.json"), "utf8")) as AnalysisContext;
    const report = reportFor(context);
    if (turn >= 5) report.verification = "已逐条复核原始查询：换线小时与本期同类型证据一致，未把损失出现日数当作全期天数；责任为职能建议。";
    for (const period of report.periods) {
      const all = readFileSync(path.join(runDir, "evidence.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
      const loss = all.find((entry) => entry.lossPeriod === period.period);
      for (const group of period.groups) {
        const rowIndex = loss.rows.findIndex((row: Record<string, unknown>) => row["kind"] === group.kind);
        const item = group.items[0]!;
        item.category = "availability";
        item.issue = loss.rows[rowIndex].state_group + " 换线损失，准备时间需验证";
        item.measure = "试行换线预备并比较日均换线时长";
        item.suggested_owner = "换线工艺工程";
        item.evidence_ids.push(loss.id);
        item.loss_reference = { evidence_id: loss.id, row_index: rowIndex };
      }
    }
    if (turn === 2) { report.periods[0]!.minimum_evidence = "missing"; rejected = true; }
    if (turn === 3) report.periods[0]!.groups[0]!.items[0]!.issue = "本周换线损失 2.5 小时（q11 第 0 行）";
    return [toolCall(0, "submit_analysis", { ...report, periods: JSON.stringify(report.periods) })];
  });
  writeFileSync(path.join(directory, "outside.txt"), "must not be readable");
  const result = await generateAnalyzedDashboard(config, "2026-01-12", new Date(), [], logger, "mock-analysis");
  assert.equal(result.analysisStatus, "completed", result.analysisReason ?? "");
  assert.equal(rejected, true);
  assert.ok(turn >= 5, "requires readable prose and a separate evidence review after the valid draft");
  assert.ok(JSON.parse(readFileSync(path.join(result.analysisArtifactDir, "report.json"), "utf8")).verification);
  assert.match(String(result.state.widgets[7]?.data[0]?.["issue"]), /Conversion/u);
  assert.equal(result.state.widgets[7]?.data[0]?.["loss_hours"], 2.5);
  assert.equal(result.state.widgets[8]?.data[0]?.["loss_hours"], 7.5);
  const events = readFileSync(path.join(result.analysisArtifactDir, "events.jsonl"), "utf8");
  assert.match(events, /read 仅允许/u);
  assert.match(events, /只读/u);
  assert.match(events, /最低点/u);
  assert.match(events, /业务用户可理解/u);
  assert.doesNotMatch(JSON.stringify(result.state.widgets.slice(7)), /\bq\d+\b|第\s*0\s*行/u);
  assert.doesNotMatch(events, /must not be readable/u);
  assert.ok(!readdirSync(path.join(directory, ".data")).includes("sessions"));
  const writer = new DatabaseSync(config.databasePath);
  assert.equal(writer.prepare("SELECT COUNT(*) AS n FROM oee_availability").get()?.["n"], 12);
  writer.exec("BEGIN IMMEDIATE; COMMIT");
  writer.close();
});

test("ephemeral analysis compacts context and restores snapshot references and draft status", { timeout: 30_000 }, async (t) => {
  const { config, directory } = fixture(t);
  let turn = 0;
  let summaries = 0;
  await mockModel(t, directory, (body) => {
    assert.ok(Number(body["max_tokens"] ?? body["max_completion_tokens"]) <= 32768);
    if (!body["tools"]) { summaries += 1; return "已检查数据库。继续按系统给定比较基准、证据快照目录和草稿状态完成三期报告。"; }
    turn += 1;
    if (turn === 1) return [
      toolCall(0, "execute_sql", { sql: "SELECT 1 AS marker", save_as: "compact-check" }),
      // A long failed query makes enough history eligible for an actual summary.
      toolCall(1, "execute_sql", { sql: "-- " + "x".repeat(70_000) + "\nSELECT 1", save_as: "large-request" }),
    ];
    const messages = JSON.stringify(body["messages"]);
    assert.match(messages, /compact-check/u);
    assert.match(messages, /minimum_evidence/u, "system rules and comparison anchors survive compaction");
    const runDir = path.join(config.analysis.artifactDir, "compaction-test");
    const context = JSON.parse(readFileSync(path.join(runDir, "context.json"), "utf8")) as AnalysisContext;
    const report = reportFor(context);
    if (turn >= 3) {
      assert.match(messages, /\\"draft_validated\\":true/u);
      report.verification = "已逐条复查本期、最低点与历史证据，缺失保持缺失；措施与根因区分。";
    }
    return [toolCall(0, "submit_analysis", report)];
  }, { contextWindow: 1_000_000, maxTokens: 131072, firstPromptTokens: 230000 });
  const result = await generateAnalyzedDashboard(config, "2026-01-12", new Date(), [], logger, "compaction-test");
  assert.equal(result.analysisStatus, "completed", result.analysisReason ?? "");
  assert.ok(summaries >= 1, "SDK must actually invoke compaction, not merely enable its setting");
  const events = readFileSync(path.join(result.analysisArtifactDir, "events.jsonl"), "utf8");
  assert.match(events, /"type":"compaction_end"/u);
  assert.match(events, /"contextWindow":262144/u);
  assert.match(events, /"maxOutputTokens":32768/u);
});

test("tool budget includes malformed calls and terminates at sixty without a report", { timeout: 30_000 }, async (t) => {
  const { config, directory } = fixture(t);
  await mockModel(t, directory, () => Array.from({ length: 65 }, (_, index) => toolCall(index, "execute_sql", { invalid: true })));
  const result = await generateAnalyzedDashboard(config, "2026-01-12", new Date(), [], logger, "budget-test");
  assert.equal(result.analysisStatus, "failed");
  assert.match(result.analysisReason ?? "", /60 次/u);
  const events = readFileSync(path.join(result.analysisArtifactDir, "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(events.filter((event) => event.type === "tool_call").length, 60);
  assert.ok(result.state.widgets.slice(7).every((widget) => widget.data.length === 0));
});
