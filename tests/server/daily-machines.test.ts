import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { calculateDefaultDashboard } from "../../src/server/dashboard/default/calculate/index.ts";
import { readDailyMachines, selectDailyMachines, buildDailyMachineCards, machineLossAndBottleneck } from "../../src/server/dashboard/default/calculate/daily-machines.ts";
import { createAnalysisDashboard } from "../../src/server/dashboard/analysis/template.ts";
import { projectAnalysisDashboard } from "../../src/server/dashboard/analysis/calculate/index.ts";
import { readDefaultDashboard } from "../../src/server/dashboard/default/index.ts";
import { createDefaultDashboard, createMachineAnalysisTemplates } from "../../src/server/dashboard/default/template.ts";
import { AnalysisEvidence } from "../../src/server/dashboard/default/analysis/agent.ts";
import { SessionArtifactStore } from "../../src/server/tool/artifact-store.ts";
import type { DashboardRow } from "../../src/shared/dashboard.ts";
import { AnalysisValidationError, pointerValue, MachineAnalysisState, applyMachineAnalysis, machineAnalysisInterrupted,
  machineAnalysisSummary, machineSelectionContext, inspectMachineCandidate, type MachineGroup,
} from "../../src/server/dashboard/default/analysis/validation.ts";

const day = "2026-10-20";
function fixture(t: TestContext) {
  const directory = mkdtempSync(path.join(tmpdir(), "daily-machines-"));
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync("scripts/database/schema.sql", "utf8"));
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  const a = db.prepare("INSERT INTO oee_availability(tool_name,lot_id,final_state,step,date,time_span) VALUES(?,?,?,?,?,?)");
  const d = db.prepare(`INSERT INTO oee_dut_utilization(machine_id,lot_id,step_id,date,in_qty,out_qty,dut_num,test_stage,touchdown_index,start_time,end_time)
    VALUES(?,?,?,?,?,?,?,'1st','1','2026-10-20T00:00:00Z','2026-10-20T00:00:10Z')`);
  return { db, directory,
    machine(machine: string, kind: "MT" | "ST", input = 10, lot = "P1") {
      const step = kind === "MT" ? "5000" : "7000";
      a.run(machine, lot, "Test(Normal)", step, day, 40);
      a.run(machine, lot, "PM", step, day, 30);
      a.run(machine, lot, "Conversion", step, day, 30);
      d.run(machine, lot, step, day, String(input), String(input * .8), "20");
    },
  };
}

function adviceFor(evidence: AnalysisEvidence, context: ReturnType<AnalysisEvidence["context"]>) {
  const groups: MachineGroup[] = machineSelectionContext(context.machines).map(({ kind, ranking, selected }) => ({
    kind: kind as "MT" | "ST", ranking, no_findings_reason: "",
    items: selected.map(({ machine, evidence_reference }) => ({ machine: String(machine), measure: "核查最低子项，试行调整并用次日同口径指标验证", suggested_owner: "测试工程", evidence_reference })),
  }));
  const state = new MachineAnalysisState(context.machines, evidence.records, day);
  state.submit(groups);
  return { groups, state };
}

test("daily ranking uses raw precision, deterministic ties, zero and independent overlapping lists", () => {
  const rows: DashboardRow[] = [
    { machine: "B", kind: "MT", oee: 10.003 }, { machine: "A", kind: "MT", oee: 10.004 },
    { machine: "C", kind: "MT", oee: 0 }, { machine: "D", kind: "MT", oee: null },
    { machine: "A", kind: "ST", oee: 99 }, { machine: "E", kind: "MT", oee: 10.004 },
  ];
  assert.deepEqual(selectDailyMachines(rows, "MT", "best").map(({ row, rank }) => [row["machine"], rank]), [["A", 1], ["E", 2], ["B", 3], ["C", 4]]);
  assert.deepEqual(selectDailyMachines(rows, "MT", "worst").map(({ row }) => row["machine"]), ["C", "B", "A", "E"]);
  assert.equal(selectDailyMachines(rows, "ST", "best")[0]!.row["oee"], 99);
  const many = Array.from({ length: 23 }, (_, index) => ({ machine: String(index).padStart(2, "0"), kind: "MT", oee: index }));
  assert.equal(selectDailyMachines(many, "MT", "best").length, 10);
  assert.equal(selectDailyMachines(many, "MT", "worst")[9]!.row["oee"], 9);
});

test("machine SQL isolates types and Skill exclusions and computes full loss evidence before ranking", (t) => {
  const f = fixture(t);
  f.machine("SAME", "MT"); f.machine("SAME", "ST", 15);
  f.machine("ZERO", "MT"); f.machine("Q-ONLY", "MT", 10, "Q1"); f.machine("E-ONLY", "ST", 10, "E1");
  f.db.exec("UPDATE oee_availability SET final_state='Conversion' WHERE tool_name='ZERO' AND final_state='Test(Normal)'");
  f.machine("TSPH001", "MT");
  const rows = readDailyMachines(f.db, day);
  assert.deepEqual(rows.map((row) => [row["machine"], row["kind"]]), [["SAME", "MT"], ["ZERO", "MT"], ["SAME", "ST"]]);
  const mt = rows[0]!;
  assert.equal(rows[1]!["oee"], 0);
  assert.equal(selectDailyMachines(rows, "MT", "worst")[0]!.row["machine"], "ZERO");
  assert.equal(mt["availability"], 40);
  assert.equal(mt["dut_on"], 50);
  assert.equal(mt["test_time_performance"], 100);
  assert.equal(mt["final_yield"], 80);
  assert.ok(Math.abs(Number(mt["oee"]) - 16) < 1e-12);
  assert.equal(mt["main_loss_state"], "Conversion");
  assert.equal(mt["main_loss_hours"], 30 / 3600);
  assert.equal(JSON.parse(String(mt["loss_states"])).length, 2);
  assert.match(machineLossAndBottleneck(mt), /Conversion.*小时\n短板[:：]Availability 40%/u);
  assert.match(machineLossAndBottleneck({ availability: 50, dut_on: 50, test_time_performance: 100, final_yield: 80 }), /未记录非运行损失.*\n短板[:：]Availability 50%、Performance \(DUT-On\) 50%/u);
  assert.equal(readDailyMachines(f.db, "2026-10-19").length, 0);
});

test("15/6 card templates retain all trends and four wide tables of exactly ten columns", (t) => {
  const f = fixture(t); f.machine("ADH001", "MT"); f.machine("ADH092", "ST");
  f.machine("MT-UNKNOWN", "MT"); f.machine("ST-UNKNOWN", "ST");
  const state = calculateDefaultDashboard(f.db, day);
  assert.equal(state.widgets.length, 15);
  assert.equal(createAnalysisDashboard().widgets.length, 6);
  assert.deepEqual(state.widgets.slice(4, 7).map((widget) => widget.id), ["oee-trend-weekly-2026", "oee-trend-monthly-2026", "oee-trend-quarterly-2026"]);
  assert.ok(!state.widgets.some((widget) => /improvement-actions-(month|quarter)/u.test(widget.id)));
  for (const card of buildDailyMachineCards(readDailyMachines(f.db, day), day)) {
    assert.equal(card.size, "wide"); assert.equal(card.encoding.columns.length, 10);
    assert.deepEqual(card.encoding.columns[2], { key: "machine_label", label: "平台/机台" });
    for (const row of card.data) {
      assert.equal(row["machine_label"], row["machine"] === "ADH001" ? "T5773/ADH001" :
        row["machine"] === "ADH092" ? "T5851/ADH092" : "平台待维护/" + row["machine"]);
    }
    assert.match(card.title, /2026-10-20/u); assert.match(card.warnings.join(" "), /实际展示/u);
    assert.ok(card.data.every((row) => row["action_and_owner"] === "改善建议暂不可用"));
  }
});

test("earlier daily publications gain platform labels in both dashboards without rewriting data or files", (t) => {
  const f = fixture(t); f.machine("ADH001", "MT"); f.machine("UNMAPPED", "ST");
  const current = calculateDefaultDashboard(f.db, day);
  const legacy = { ...current, widgets: current.widgets.map((widget, index) => index < 11 || widget.kind !== "table" ? widget : {
    ...widget, encoding: { columns: widget.encoding.columns.map((column) => column.key === "machine_label" ? { key: "machine", label: "机台" } : column) },
    data: widget.data.map(({ machine_label: _label, ...row }) => row),
  }) };
  const original = JSON.stringify(legacy);
  const file = path.join(f.directory, "default.json"); writeFileSync(file, original);
  const loaded = readDefaultDashboard(file);
  assert.deepEqual(loaded, current);
  assert.equal(readFileSync(file, "utf8"), original);
  const projected = projectAnalysisDashboard(legacy);
  assert.deepEqual(projected.widgets.slice(2), current.widgets.slice(11));
  assert.equal(projected.widgets[2]!.data[0]!["machine"], "ADH001");
  assert.equal(projected.widgets[2]!.data[0]!["machine_label"], "T5773/ADH001");
  assert.equal(projected.widgets[4]!.data[0]!["machine_label"], "平台待维护/UNMAPPED");
});

test("per-machine evidence rejects duplicates, omissions, wrong date/type/machine and retains valid advice", (t) => {
  const f = fixture(t); f.machine("A", "MT"); f.machine("B", "MT"); f.machine("A", "ST");
  const base = calculateDefaultDashboard(f.db, day);
  const evidence = new AnalysisEvidence(f.db, undefined, new SessionArtifactStore(f.directory, "evidence"));
  const context = evidence.context(base, day);
  assert.deepEqual(Object.keys(context.losses), ["day", "week"]);
  const { groups, state } = adviceFor(evidence, context);
  assert.equal(state.inspect().status, "completed");
  const changed = structuredClone(groups);
  changed[0]!.items[0]!.evidence_reference = changed[2]!.items[0]!.evidence_reference;
  state.submit(changed);
  assert.ok(state.inspect().issues.some((issue) => issue.code === "MACHINE_EVIDENCE_MISMATCH"));
  assert.equal(state.inspect().groups[0]!.items.length, 1);
  const displayed = applyMachineAnalysis(base, state.inspect()).widgets[11]!;
  assert.equal(displayed.data.length, 2);
  assert.ok(displayed.data.some((row) => String(row["action_and_owner"]).includes("建议责任人：测试工程")));
  assert.ok(displayed.data.some((row) => String(row["action_and_owner"]).includes("未通过校验（证据类型不匹配")));
  const duplicate = structuredClone(groups); duplicate[0]!.items[1] = structuredClone(duplicate[0]!.items[0]!);
  state.submit(duplicate);
  assert.equal(state.inspect().issues.filter((issue) => issue.code === "MACHINE_COVERAGE").length, 2);
  const malformed = structuredClone(groups); malformed[0]!.items[0]!.measure = "";
  state.submit(malformed); assert.equal(state.inspect().groups[0]!.items.length, 1);
  state.submit(groups);
  evidence.records.set(context.machines.MT.id, { ...context.machines.MT, range: { start: "2026-10-19", end: "2026-10-19" } });
  assert.ok(state.inspect().issues.some((issue) => issue.code === "MACHINE_EVIDENCE_MISMATCH"));
  evidence.records.set(context.machines.MT.id, context.machines.MT);
  assert.equal(inspectMachineCandidate(JSON.stringify({ machine_groups: groups.slice(0, 2) }), "MT", context.machines, evidence.records, day).status, "valid");
  assert.equal(inspectMachineCandidate("broken JSON", "MT", context.machines, evidence.records, day).status, "needs_repair");
});

test("machine alerts identify the platform, failing count and exact date/type/machine/owner problem", (t) => {
  const f = fixture(t); f.machine("ADH001", "MT"); f.machine("ADH092", "MT"); f.machine("ADH001", "ST");
  const base = calculateDefaultDashboard(f.db, day);
  const evidence = new AnalysisEvidence(f.db, undefined, new SessionArtifactStore(f.directory, "machine-alerts"));
  const context = evidence.context(base, day);
  const { groups, state } = adviceFor(evidence, context);
  const advice = (input: MachineGroup[]) => input[0]!.items.find((item) => item.machine === "ADH001")!;
  const cases = [
    { reason: /证据类型不匹配（应为 MT，实际 ST）/u, change(input: MachineGroup[]) { advice(input).evidence_reference = input[2]!.items[0]!.evidence_reference; } },
    { reason: /证据机台不匹配.*T5773\/ADH001.*T5851\/ADH092/u, change(input: MachineGroup[]) { advice(input).evidence_reference = input[0]!.items.find((item) => item.machine === "ADH092")!.evidence_reference; } },
    { reason: /缺少建议责任职能/u, change(input: MachineGroup[]) { advice(input).suggested_owner = ""; } },
    { reason: /缺少改善措施/u, change(input: MachineGroup[]) { advice(input).measure = " "; } },
    { reason: /证据日期不匹配.*2026-10-20.*2026-10-19/u, change() {
      evidence.records.set(context.machines.MT.id, { ...context.machines.MT, range: { start: "2026-10-19", end: "2026-10-19" } });
    } },
  ];
  for (const example of cases) {
    const changed = structuredClone(groups);
    example.change(changed);
    state.submit(changed);
    const rendered = applyMachineAnalysis(base, state.inspect());
    const card = rendered.widgets[11]!;
    const row = card.data.find((entry) => entry["machine"] === "ADH001")!;
    assert.match(String(row["action_and_owner"]), example.reason);
    assert.ok(card.warnings.some((warning) => warning.includes("T5773/ADH001") && example.reason.test(warning)));
    assert.match(card.warnings[0]!, /MT 最佳榜：[12]\/2 台机台的建议未通过校验/u);
    assert.match(card.warnings[0]!, /排名、五项指标及短板已保留/u);
    assert.match(machineAnalysisSummary(state.inspect()), example.reason);
    assert.deepEqual(card.data.map(({ action_and_owner: _advice, ...facts }) => facts), base.widgets[11]!.data.map(({ action_and_owner: _advice, ...facts }) => facts));
    assert.deepEqual(projectAnalysisDashboard(rendered).widgets[2], card);
    assert.ok(card.warnings.length <= 20 && card.warnings.every((warning) => warning.length <= 300));
    evidence.records.set(context.machines.MT.id, context.machines.MT);
  }
});

test("missing, duplicate and extra advice have distinct alerts and preserve valid machine actions", (t) => {
  const f = fixture(t); f.machine("ADH001", "MT"); f.machine("ADH092", "MT");
  const base = calculateDefaultDashboard(f.db, day);
  const evidence = new AnalysisEvidence(f.db, undefined, new SessionArtifactStore(f.directory, "coverage-alerts"));
  const { groups, state } = adviceFor(evidence, evidence.context(base, day));
  const missing = structuredClone(groups); missing[0]!.items = [];
  state.submit(missing);
  assert.match(applyMachineAnalysis(base, state.inspect()).widgets[11]!.warnings.join(" "), /2\/2 台.*缺少该机台的改善建议/u);
  const duplicate = structuredClone(groups); duplicate[0]!.items[1] = structuredClone(duplicate[0]!.items[0]!);
  state.submit(duplicate);
  assert.match(applyMachineAnalysis(base, state.inspect()).widgets[11]!.warnings.join(" "), /重复提交了 2 条建议/u);
  const extra = structuredClone(groups); extra[0]!.items.push({ ...extra[0]!.items[0]!, machine: "ADH999" });
  state.submit(extra);
  const card = applyMachineAnalysis(base, state.inspect()).widgets[11]!;
  assert.match(card.warnings[0]!, /0\/2 台.*入榜建议均可用/u);
  assert.match(card.warnings.join(" "), /忽略榜外建议 .*ADH999/u);
  assert.ok(card.data.every((row) => String(row["action_and_owner"]).startsWith("改善措施：")));
});

test("machine feedback addresses original group/item fields and supplies expected, actual and repair hints", (t) => {
  const f = fixture(t); f.machine("ADH001", "MT"); f.machine("ADH092", "MT"); f.machine("ADH001", "ST");
  const base = calculateDefaultDashboard(f.db, day);
  const evidence = new AnalysisEvidence(f.db, undefined, new SessionArtifactStore(f.directory, "structured-feedback"));
  const context = evidence.context(base, day);
  const { groups, state } = adviceFor(evidence, context);
  const changed = structuredClone(groups).reverse();
  changed[3]!.items.reverse();
  const item = changed[3]!.items.find((entry) => entry.machine === "ADH001")!;
  item.suggested_owner = "";
  Object.assign(item, { "unexpected/key~": "remove me" });
  const original = JSON.stringify(changed);
  state.submit(changed);
  const owner = state.inspect().issues.find((issue) => issue.path.endsWith("/suggested_owner"))!;
  assert.equal(owner.path, "/machine_groups/3/items/1/suggested_owner");
  assert.equal(owner.item_index, 1);
  assert.equal(owner.period, "day"); assert.equal(owner.kind, "MT"); assert.equal(owner.ranking, "best");
  assert.equal(owner.machine, "ADH001");
  assert.deepEqual(owner.expected, { type: "string", non_blank: true, maxLength: 200 });
  assert.equal(owner.actual, pointerValue({ machine_groups: changed }, owner.path));
  assert.match(owner.hint, /责任职能/u);
  const extra = state.inspect().issues.find((issue) => issue.path.endsWith("unexpected~1key~0"))!;
  assert.equal(extra.actual, pointerValue({ machine_groups: changed }, extra.path));
  const preflight = inspectMachineCandidate(JSON.stringify({ machine_groups: [changed[3], changed[2]] }), "MT", context.machines, evidence.records, day);
  assert.equal(preflight.status, "needs_repair"); assert.equal(preflight.has_more, false);
  assert.equal(preflight.issues.length, 2, "one invalid field must not erase all per-machine diagnostics during preflight");
  assert.equal(preflight.issues[0]!.path, "/machine_groups/0/items/1/suggested_owner");
  for (const issue of JSON.parse(JSON.stringify(preflight)).issues) {
    for (const key of ["code", "path", "message", "expected", "actual", "hint"]) assert.ok(Object.hasOwn(issue, key), key);
  }
  assert.equal(JSON.stringify(changed), original, "validation must not alter the raw candidate");
  assert.throws(() => state.prepareGroup(changed[3]), (error: unknown) => {
    assert.ok(error instanceof AnalysisValidationError);
    assert.equal(error.issues[0]!.path, "/items/1/suggested_owner");
    assert.equal(error.issues[0]!.actual, "");
    assert.match(error.issues[0]!.hint, /责任职能/u);
    return true;
  });
  assert.ok(state.modelContext().issues.some((issue) => issue.path === "/items/1/suggested_owner"));
  assert.match(machineAnalysisSummary(state.inspect()), /MT 最佳榜.*T5773\/ADH001.*缺少建议责任职能/u);
  const publication = { status: state.inspect().status, issues: state.inspect().issues, coverage: state.inspect().coverage };
  const summary = machineAnalysisSummary(publication);
  const rendered = applyMachineAnalysis(base, state.inspect());
  assert.ok(rendered.widgets[11]!.warnings.some((warning) => warning.includes(owner.message)));
  const restoredSummary = machineAnalysisSummary(JSON.parse(JSON.stringify(publication)));
  assert.equal(restoredSummary, summary);
  for (const warning of rendered.widgets[11]!.warnings.filter((warning) => warning.startsWith("改善建议暂不可用："))) {
    assert.ok(restoredSummary.includes(warning.slice("改善建议暂不可用：".length)), "display and log explanations must agree on the serialized feedback");
  }
});

test("machine interruption explains timeout or failure while preserving accepted advice and evidence errors", (t) => {
  const f = fixture(t); f.machine("ADH001", "MT"); f.machine("ADH092", "MT");
  const base = calculateDefaultDashboard(f.db, day);
  const evidence = new AnalysisEvidence(f.db, undefined, new SessionArtifactStore(f.directory, "interruption-alerts"));
  const { groups, state } = adviceFor(evidence, evidence.context(base, day));
  groups[0]!.items[0]!.suggested_owner = ""; state.submit(groups);
  const analyzed = applyMachineAnalysis(base, state.inspect());
  for (const [status, label] of [["timed_out", "分析超时"], ["failed", "分析失败"]] as const) {
    const rendered = machineAnalysisInterrupted(analyzed, { status, reason: "测试中止原因" }, state.inspect());
    const card = rendered.widgets[11]!;
    assert.match(card.warnings[0]!, new RegExp(`MT 最佳榜：${label}.*1/2 台`));
    assert.ok(card.data.some((row) => String(row["action_and_owner"]).includes(label) && String(row["action_and_owner"]).includes("缺少建议责任职能")));
    const valid = analyzed.widgets[11]!.data.find((row) => String(row["action_and_owner"]).startsWith("改善措施："))!;
    assert.deepEqual(card.data.find((row) => row["machine"] === valid["machine"]), valid);
    assert.deepEqual(rendered.widgets.slice(0, 11), analyzed.widgets.slice(0, 11));
    assert.deepEqual(rendered.widgets[12], analyzed.widgets[12]);
  }
});

test("legacy 13-card publications upgrade in memory while retaining their original file and data", (t) => {
  const f = fixture(t);
  const current = createDefaultDashboard();
  const dayTemplate = current.widgets[9]!;
  const legacy = { ...current, widgets: [...current.widgets.slice(0, 11),
    ...["month", "quarter"].map((period) => ({ ...dayTemplate, id: `improvement-actions-${period}-2026` }))] };
  const file = path.join(f.directory, "default.json");
  const payload = JSON.stringify(legacy); writeFileSync(file, payload);
  const upgraded = readDefaultDashboard(file);
  assert.equal(upgraded.widgets.length, 15);
  assert.deepEqual(upgraded.widgets.slice(0, 11), legacy.widgets.slice(0, 11));
  assert.deepEqual(upgraded.widgets.slice(11), createMachineAnalysisTemplates());
  assert.equal(readFileSync(file, "utf8"), payload);
});
