import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { AppDatabase } from "../../src/server/database/database.ts";
import { formatMachineMentions, machineLabel, machinePlatform, MACHINE_PLATFORMS } from "../../src/server/skills/test-oee-calculator/assets/machine-platforms.ts";
import { SessionArtifactStore } from "../../src/server/tool/artifact-store.ts";
import { createOeeSkillRuntime } from "../../src/server/agent/oee-skill-runtime.ts";
import { createRankMachinesTool, rankMachines, machineRankingView, type MachineRankingCache } from "../../src/server/skills/test-oee-calculator/assets/machine-ranking.ts";
import { createTools } from "../../src/server/skills/test-oee-calculator/assets/tools.ts";
import { lossOutput } from "../../src/server/tool/loss-output.ts";
import { createDailyImprovementEmail } from "../../src/server/dashboard/default/daily-email.ts";
import { AnalysisEvidence } from "../../src/server/dashboard/default/analysis/evidence.ts";
import { createAnalysisSkillOptions } from "../../src/server/dashboard/default/analysis/tools.ts";
import { validateAnalysisReport, applyAnalysisReport } from "../../src/server/dashboard/default/analysis/report.ts";
import { calculatedDashboard } from "../helpers/calculated-dashboard.ts";

function fixture(t: TestContext) {
  const directory = mkdtempSync(path.join(tmpdir(), "machine-ranking-"));
  const database = new DatabaseSync(":memory:");
  database.exec(readFileSync(path.join(process.cwd(), "scripts/database/schema.sql"), "utf8"));
  t.after(() => { database.close(); rmSync(directory, { recursive: true, force: true }); });
  const queries = AppDatabase.readOnlyQueries(database);
  const artifacts = new SessionArtifactStore(directory, "rankings");
  const a = database.prepare("INSERT INTO oee_availability(tool_name,lot_id,final_state,step,date,time_span) VALUES(?,?,?,?,?,?)");
  const d = database.prepare("INSERT INTO oee_dut_utilization(machine_id,lot_id,in_qty,out_qty,dut_num,step_id,date,test_stage,touchdown_index,start_time,end_time) VALUES(?,?,?,?,?,?,?,'1st','1','2026-01-01T00:00:00Z',?)");
  return { directory, database, queries, artifacts,
    a(machine: string, hours: number, state = "Conversion", kind = "MT", day = "2026-01-01", lot = "P1") {
      a.run(machine, lot, state, kind === "MT" ? "5000" : "7000", day, hours * 3600);
    },
    d(machine: string, input = 10, output = 8, sockets = 20, kind = "MT", day = "2026-01-01", lot = "P1", seconds = 10) {
      d.run(machine, lot, String(input), String(output), String(sockets), kind === "MT" ? "5000" : "7000", day,
        "2026-01-01T00:00:" + String(seconds).padStart(2, "0") + "Z");
    },
  };
}
const range = { start_date: "2026-01-01", end_date: "2026-01-03" };

test("Skill ranking needs runtime resources and binds each task to its own snapshots", async (t) => {
  const { directory, a, queries, artifacts } = fixture(t);
  a("ADH001", 4);
  const params = { ...range, kind: "MT" as const, metric: "loss_hours" as const };
  const unbound = createTools().find((tool) => tool.name === "rank_machines")!;
  await assert.rejects(() => unbound.execute("missing-runtime", params, undefined, undefined, undefined as never), /缺少会话运行依赖/u);
  assert.equal(artifacts.listDataSnapshots().length, 0);
  const results: { snapshot: { name: string }; top3: { value: number }[] }[] = [];
  for (const name of ["first", "second"]) {
    const scoped = artifacts.scoped(name);
    const tool = createTools({ runtime: createOeeSkillRuntime(queries, scoped) }).find((entry) => entry.name === "rank_machines")!;
    const result = await tool.execute("ranking", params, undefined, undefined, undefined as never);
    results.push(result.details as { snapshot: { name: string }; top3: { value: number }[] });
  }
  assert.notEqual(results[0]!.snapshot.name, results[1]!.snapshot.name);
  assert.equal(results[0]!.top3[0]!.value, 4);
  assert.equal(results[1]!.top3[0]!.value, 4);
  assert.throws(() => new SessionArtifactStore(directory, "another-session").resolveDataSnapshot(results[0]!.snapshot.name));
});

test("analysis Skill wrappers require root period and bind child evidence and snapshots", async (t) => {
  const { database, a, artifacts } = fixture(t);
  a("ADH001", 4);
  const evidence = new AnalysisEvidence(database, undefined, artifacts);
  const context = evidence.context(calculatedDashboard(database, "2026-01-01"), "2026-01-01");
  const params = { start_date: "2026-01-01", end_date: "2026-01-01", kind: "MT", metric: "loss_hours" };
  const definition = createTools().find((tool) => tool.name === "rank_machines")!;
  const root = createAnalysisSkillOptions(evidence).decorateTool!("test-oee-calculator", definition);
  const child = createAnalysisSkillOptions(evidence, evidence.scope(context, "day", "child")).decorateTool!("test-oee-calculator", definition);
  await assert.rejects(async () => root.execute("missing-period", params, undefined, undefined, undefined as never), /必须指定 period/u);
  await assert.rejects(async () => child.execute("override-period", { ...params, period: "week" }, undefined, undefined, undefined as never), /不能指定 period/u);
  const rootResult = await root.execute("root-ranking", { ...params, period: "day" }, undefined, undefined, undefined as never);
  const childResult = await child.execute("child-ranking", params, undefined, undefined, undefined as never);
  const rootId = (rootResult.details as { evidence_id: string }).evidence_id;
  const childId = (childResult.details as { evidence_id: string }).evidence_id;
  assert.deepEqual(evidence.records.get(rootId)!.owner, { period: "day", agentId: "root" });
  assert.deepEqual(evidence.records.get(childId)!.owner, { period: "day", agentId: "child" });
  assert.notEqual(evidence.records.get(rootId)!.snapshot!.name, evidence.records.get(childId)!.snapshot!.name);
  assert.equal(evidence.records.get(childId)!.source, "rank_machines");
  assert.equal(evidence.catalog(evidence.scope(context, "day", "child")).some((entry) => entry.evidence_id === rootId), false);
});

test("truncated or cancelled exports never publish a candidate snapshot or evidence", async (t) => {
  const { a, queries, artifacts } = fixture(t);
  a("ADH001", 4);
  const params = { ...range, kind: "MT" as const, metric: "loss_hours" as const };
  let recorded = 0;
  const truncated = { exportQueryJson: (...args: Parameters<typeof queries.exportQueryJson>) => ({ ...queries.exportQueryJson(...args), truncated: true }) };
  const fail = createRankMachinesTool(createOeeSkillRuntime(truncated, artifacts), () => { recorded++; return "unreachable"; });
  await assert.rejects(() => fail.execute("truncated", params, undefined, undefined, undefined as never), /快照上限/u);
  const controller = new AbortController();
  const cancelled = { exportQueryJson: (...args: Parameters<typeof queries.exportQueryJson>) => {
    const result = queries.exportQueryJson(...args); controller.abort(); return result;
  } };
  const stop = createRankMachinesTool(createOeeSkillRuntime(cancelled, artifacts), () => { recorded++; return "unreachable"; });
  await assert.rejects(() => stop.execute("cancelled", params, controller.signal, undefined, undefined as never));
  assert.equal(recorded, 0);
  assert.equal(artifacts.listDataSnapshots().length, 0);
});

test("the complete v4 inventory is frozen and formats business prose without changing code or link targets", () => {
  assert.equal(Object.keys(MACHINE_PLATFORMS).length, 166);
  assert.deepEqual(["T5773", "T5831", "T5851"].map((p) => Object.values(MACHINE_PLATFORMS).filter((v) => v === p).length), [78, 53, 35]);
  const inventory = Object.entries(MACHINE_PLATFORMS).sort().map(([machine, platform]) => machine + ":" + platform).join("\n");
  assert.equal(createHash("sha256").update(inventory).digest("hex"), "ba1c899214461eb10d9105573001f811c22a45c1958ce06a127b1b5bc2ceed1b");
  assert.equal(machinePlatform("__proto__"), null);
  assert.equal(machineLabel("ADH161"), "平台待维护/ADH161");
  const source = "ADH001、T5851/ADH035、平台待维护/ADH092、ADH161 [ADH001](https://example.com/ADH001) `ADH001`\n```sql\nSELECT 'ADH001';\n```";
  const expected = "T5773/ADH001、T5831/ADH035、T5851/ADH092、平台待维护/ADH161 [T5773/ADH001](https://example.com/ADH001) `T5773/ADH001`\n```sql\nSELECT 'ADH001';\n```";
  assert.equal(formatMachineMentions(source), expected);
  assert.equal(formatMachineMentions(expected), expected);
});

test("loss TOP3 aggregates distinct machines across states, uses all scoped losses, and preserves candidate snapshots", (t) => {
  const { a, queries, artifacts } = fixture(t);
  a("ADH001", 6); a("ADH001", 5, "PM"); a("ADH002", 10); a("ADH003", 9); a("ADH161", 8);
  a("ADH001", 20, "Machine_Running", "MT", "2026-01-02");
  a("ADH092", 100, "Conversion", "ST");
  a("ADH004", 1000, "Conversion", "MT", "2026-01-01", "Q1");
  a("ADH005", 1000, "Conversion", "MT", "2026-01-01", "E1");
  a("TSPH001", 1000);
  const result = rankMachines(createOeeSkillRuntime(queries, artifacts), { ...range, kind: "MT", metric: "loss_hours", states: ["Conversion", "PM"] });
  const view = machineRankingView(result);
  assert.equal(result.rows.length, 4);
  assert.deepEqual(view.top3.map((r) => [r.machine, r.value]), [["ADH001", 11], ["ADH002", 10], ["ADH003", 9]]);
  assert.equal(view.total_loss_hours, 38);
  assert.equal(view.top3_share_percent, 30 / 38 * 100);
  assert.equal(view.top3[0]!.share_percent, 11 / 38 * 100);
  assert.equal(view.top3[0]!.availability_days, 2, "coverage is distinct machine days, not sums of state occurrence days");
  assert.match(view.summary, /T5773\/ADH001 11.0 小时/u);
  assert.deepEqual(view.missing_platforms, ["ADH161"]);
  const saved = JSON.parse(readFileSync(artifacts.resolveDataSnapshot(result.snapshot.name).filePath, "utf8"));
  assert.deepEqual(saved.rows, result.rows);
  assert.deepEqual(saved.scope, result.scope);
  const stateOnly = machineRankingView(rankMachines(createOeeSkillRuntime(queries, artifacts), { ...range, kind: "MT", metric: "loss_hours", states: ["Conversion"] }));
  assert.equal(stateOnly.total_loss_hours, 33);
  assert.deepEqual(stateOnly.top3.map((r) => r.machine), ["ADH002", "ADH003", "ADH161"]);
});

test("empty, zero, NULL and unrounded tie cases retain actual counts and never infer full coverage", (t) => {
  const { a, queries, artifacts } = fixture(t);
  a("ADH001", 1); a("ADH002", 1.00001); a("ADH003", 1); a("ADH004", 0);
  const view = machineRankingView(rankMachines(createOeeSkillRuntime(queries, artifacts), { ...range, kind: "MT", metric: "loss_hours" }));
  assert.deepEqual(view.top3.map((r) => r.machine), ["ADH002", "ADH001", "ADH003"]);
  const zero = machineRankingView(rankMachines(createOeeSkillRuntime(queries, artifacts), { ...range, kind: "MT", metric: "loss_hours", states: ["PM"] }));
  assert.equal(zero.machine_count, 0); assert.equal(zero.total_loss_hours, null);
  assert.match(zero.summary, /无匹配记录不代表零损失/u);
  a("ADH005", 0, "PM");
  const onlyZero = machineRankingView(rankMachines(createOeeSkillRuntime(queries, artifacts), { ...range, kind: "MT", metric: "loss_hours", states: ["PM"] }));
  assert.equal(onlyZero.top3.length, 1); assert.equal(onlyZero.top3_share_percent, null);
  const nulls = machineRankingView(rankMachines(createOeeSkillRuntime(queries, artifacts), { ...range, kind: "MT", metric: "final_yield" }));
  assert.equal(nulls.machine_count, 0); assert.equal(nulls.observed_machine_count, 5);
});

test("period component ratios use sums, isolate types, retain Yield-only eligibility, and cache only frozen source scans", (t) => {
  const { a, d, queries, artifacts } = fixture(t);
  a("ADH001", 10, "Test(Normal)"); a("ADH001", 10); d("ADH001", 10, 8, 20);
  a("ADH001", 5, "Test(Normal)", "ST"); d("ADH001", 10, 10, 10, "ST");
  a("ADH002", 10, "Test(Normal)"); d("ADH002", 10, 2, 20); d("ADH002", 90, 0, 90, "MT", "2026-01-01", "None");
  a("ADH003", 10, "Test(Normal)"); d("ADH003", 1, 0, 0);
  const cache: MachineRankingCache = new Map();
  let scans = 0;
  const counted = { exportQueryJson: (...args: Parameters<typeof queries.exportQueryJson>) => { scans++; return queries.exportQueryJson(...args); } };
  const dut = machineRankingView(rankMachines(createOeeSkillRuntime(counted, artifacts), { ...range, kind: "MT", metric: "dut_on" }, undefined, cache));
  assert.deepEqual(dut.top3.map((r) => r.machine), ["ADH001", "ADH002"]);
  assert.equal(dut.top3[0]!.value, 50); assert.equal(dut.top3[1]!.value, 100 / 110 * 100);
  const yieldRanking = machineRankingView(rankMachines(createOeeSkillRuntime(counted, artifacts), { ...range, kind: "MT", metric: "final_yield" }, undefined, cache));
  assert.deepEqual(yieldRanking.top3.map((r) => [r.machine, r.value]), [["ADH003", 0], ["ADH002", 20], ["ADH001", 80]]);
  const st = machineRankingView(rankMachines(createOeeSkillRuntime(counted, artifacts), { ...range, kind: "ST", metric: "dut_on" }, undefined, cache));
  assert.equal(st.top3[0]!.value, 100); assert.equal(scans, 1);
});

test("machine-day and report-period Test Time standards remain distinct and invalid/cancelled requests do not write", (t) => {
  const { a, d, queries, artifacts } = fixture(t);
  a("ADH001", 24, "Test(Normal)"); d("ADH001", 10, 10, 10, "MT", "2026-01-01", "P1", 10);
  a("ADH002", 24, "Test(Normal)"); d("ADH002", 10, 10, 10, "MT", "2026-01-01", "P1", 30);
  const oneDay = { start_date: range.start_date, end_date: range.start_date, kind: "MT" as const, metric: "test_time_performance" as const };
  const period = machineRankingView(rankMachines(createOeeSkillRuntime(queries, artifacts), oneDay));
  assert.deepEqual(period.top3.map((r) => r.machine), ["ADH002", "ADH001"]);
  assert.ok(Math.abs(period.top3[0]!.value - 200 / 3) < 1e-10); assert.equal(period.top3[1]!.value, 200);
  const daily = machineRankingView(rankMachines(createOeeSkillRuntime(queries, artifacts), { ...oneDay, basis: "machine_day" }));
  assert.deepEqual(daily.top3.map((r) => r.value), [100, 100]);
  const names = artifacts.listDataSnapshots().map((r) => r.name);
  assert.throws(() => rankMachines(createOeeSkillRuntime(queries, artifacts), { ...range, kind: "MT", metric: "oee", basis: "machine_day" }), /同一业务日/u);
  assert.throws(() => rankMachines(createOeeSkillRuntime(queries, artifacts), { ...oneDay, states: ["PM"] }), /states/u);
  assert.throws(() => rankMachines(createOeeSkillRuntime(queries, artifacts), { ...oneDay, metric: "oee; DROP TABLE" } as never), /参数无效/u);
  assert.throws(() => rankMachines(createOeeSkillRuntime(queries, artifacts), oneDay, AbortSignal.abort()));
  assert.deepEqual(artifacts.listDataSnapshots().map((r) => r.name), names);
});

test("the existing loss tool exposes distinct-machine TOP3 without changing raw row references", () => {
  const rows = [
    { machine: "ADH001", kind: "MT", state_group: "PM", loss_hours: 6 },
    { machine: "ADH001", kind: "MT", state_group: "Conversion", loss_hours: 6 },
    { machine: "ADH002", kind: "MT", state_group: "PM", loss_hours: 10 },
  ];
  const output = lossOutput({ rows, truncated: false, range: { start: "2026-01-01", end: "2026-01-03" },
    scope: { byMachine: true, states: [], machines: [] } }).details.view;
  assert.equal(output.mode, "complete");
  assert.deepEqual(output.rows!.map((r) => r.row), rows);
  assert.deepEqual(output.machine_summaries![0]!.top3.map((r) => [r.machine, r.value]), [["ADH001", 12], ["ADH002", 10]]);
});

test("reports and email share server TOP3 text and reject wrong type, period, metric, basis, truncation and missing references", (t) => {
  const { a, d, database, queries, artifacts } = fixture(t);
  a("ADH001", 10, "Test(Normal)"); d("ADH001");
  a("ADH092", 10, "Test(Normal)", "ST"); d("ADH092", 10, 8, 20, "ST");
  a("ADH001", 4, "Conversion"); a("ADH092", 3, "Conversion", "ST");
  const base = calculatedDashboard(database, "2026-01-01");
  const evidence = new AnalysisEvidence(database, undefined, artifacts);
  const context = evidence.context(base, "2026-01-01");
  const report = { periods: (["day", "week", "month", "quarter"] as const).map((period) => ({
    period, comparison: "覆盖有限，根因待验证。", minimum_evidence: context.comparisons[period].minimum.id,
    history_evidence: context.comparisons[period].history.id,
    groups: (["MT", "ST"] as const).map((kind) => ({ kind, evidence_ids: [context.comparisons[period].current.id, context.losses[period].evidence_id],
      no_findings_reason: "无匹配损失记录，覆盖需核查", items: context.losses[period].by_kind[kind].map((candidate) => {
        const ranking = evidence.recordMachineRanking(rankMachines(createOeeSkillRuntime(queries, artifacts), {
          start_date: context.periods[period].start, end_date: context.periods[period].end, kind, metric: "loss_hours", states: [candidate.state_group],
        }), { period, agentId: "test" });
        return { priority: candidate.priority, category: "availability", issue: "Conversion（换线）损失，ADH001 的准备过程需核查。", measure: "核查准备过程并复测换线时长", suggested_owner: "测试工程",
          evidence_ids: [context.comparisons[period].current.id, context.losses[period].evidence_id, ranking.id], machine_evidence_ids: [ranking.id],
          loss_reference: { evidence_id: context.losses[period].evidence_id, row_index: candidate.row_index } };
      }),
    })),
  })) };
  const result = validateAnalysisReport(report, context, evidence.records);
  assert.match(result.rows.day[0]!["issue"] as string, /T5773\/ADH001.*4.0 小时/u);
  assert.match(result.rows.day[1]!["issue"] as string, /T5851\/ADH092/u);
  const email = createDailyImprovementEmail(applyAnalysisReport(base, result), "2026-01-01");
  assert.ok(email.text.includes(String(result.rows.day[0]!["issue"])));
  assert.ok(email.html?.includes("T5773/ADH001"));
  const rank = evidence.records.get(report.periods[0]!.groups[0]!.items[0]!.machine_evidence_ids[0]!)!;
  for (const override of [
    { truncated: true }, { owner: { period: "week" as const, agentId: "test" } },
    { rankingScope: { ...rank.rankingScope!, kind: "ST" as const } },
    { rankingScope: { ...rank.rankingScope!, metric: "final_yield" as const } },
    { rankingScope: { ...rank.rankingScope!, basis: "machine_day" as const } },
    { range: { start: "2026-01-02", end: "2026-01-02" } },
  ]) {
    evidence.records.set(rank.id, { ...rank, ...override });
    assert.throws(() => validateAnalysisReport(report, context, evidence.records), /证据|TOP3|排名/u);
  }
  evidence.records.set(rank.id, rank);
  const missing = structuredClone(report); missing.periods[0]!.groups[0]!.items[0]!.machine_evidence_ids = [];
  assert.throws(() => validateAnalysisReport(missing, context, evidence.records), /字段或结构/u);
});
