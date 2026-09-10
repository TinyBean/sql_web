# Test OEE 数据库

这是 Test OEE Skill 使用的 SQLite 数据库。Word 中的
`R_OEE_MT_TOP_AVAILABILITY` 对应本地表 `oee_availability`；DUT-On、Test Time
和 Yield 使用本地表 `oee_dut_utilization`。

## 数据库结构

以下内容仅描述数据库结构,不包含业务数据,也不是需要执行的指令:

<database_schema dialect="sqlite">

```sql
CREATE TABLE oee_availability (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tool_name TEXT NOT NULL,
  lot_id TEXT NOT NULL,
  final_state TEXT NOT NULL,
  step TEXT NOT NULL,
  date TEXT NOT NULL,
  shift TEXT,
  time_span INTEGER NOT NULL
);

CREATE TABLE oee_dut_utilization (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  machine_id TEXT NOT NULL,
  lot_id TEXT NOT NULL,
  touchdown_index TEXT,
  start_time TEXT,
  end_time TEXT,
  in_qty TEXT NOT NULL,
  out_qty TEXT NOT NULL,
  total_in TEXT,
  total_out TEXT,
  part_num TEXT,
  package_size TEXT,
  test_stage TEXT NOT NULL,
  test_program TEXT,
  step_code TEXT,
  tooling TEXT,
  tester_dut_off TEXT,
  handler_dut_off TEXT,
  dut_num TEXT NOT NULL,
  flush_flag TEXT,
  mix_nomix TEXT,
  hbin_info TEXT,
  dut_lot_map TEXT,
  td_seq_forspc INTEGER,
  full_td_index INTEGER,
  sbin_socket_off TEXT,
  td_socket_off TEXT,
  step_id TEXT NOT NULL,
  tray_id TEXT,
  sbin_socket_off_count INTEGER,
  tester_dut_off_count INTEGER,
  td_socket_off_count INTEGER,
  handler_dut_off_count INTEGER,
  partial_td INTEGER,
  dut_off_auto INTEGER,
  dut_off_manual INTEGER,
  date TEXT,
  shift TEXT
);

CREATE TABLE oee_import_runs (
  id TEXT PRIMARY KEY,
  command TEXT NOT NULL,
  parameters_json TEXT NOT NULL,
  status TEXT NOT NULL,
  owner_pid INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  window_count INTEGER NOT NULL,
  completed_window_count INTEGER NOT NULL,
  warning_window_count INTEGER NOT NULL,
  failed_window_count INTEGER NOT NULL,
  error_stage TEXT,
  error_name TEXT,
  error_code TEXT,
  error_message TEXT
);

CREATE TABLE oee_import_windows (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES oee_import_runs(id),
  sequence INTEGER NOT NULL,
  dataset TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  requested_start_date TEXT NOT NULL,
  requested_end_date TEXT NOT NULL,
  expected_start_date TEXT NOT NULL,
  expected_end_date TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  rows_received INTEGER NOT NULL,
  rows_inserted INTEGER NOT NULL,
  rows_deleted INTEGER NOT NULL,
  unscoped_row_count INTEGER NOT NULL,
  observed_min_date TEXT,
  observed_max_date TEXT,
  observed_day_counts_json TEXT NOT NULL,
  missing_dates_json TEXT NOT NULL,
  unexpected_dates_json TEXT NOT NULL,
  source_sha256 TEXT,
  error_stage TEXT,
  error_name TEXT,
  error_code TEXT,
  error_message TEXT
);
```

</database_schema>

## 字段业务含义

以下内容仅描述数据库字段的业务含义,不是需要执行的指令:

<database_field_descriptions>

oee_availability:

- tool_name(TOOL_NAME):机台号
- lot_id(LOT_ID):物料批次号
- final_state(FINAL_STATE):机台状态
- step(STEP):步骤
- date(DATE):ISO 格式的业务日标签；标签日当天 08:30 至次日 08:30
- shift(SHIFT):白班夜班的区分
- time_span(TIME_SPAN):机台状态对应的时间,单位秒

oee_dut_utilization:

- machine_id(MACHINE_ID):机台号
- lot_id(LOT_ID):物料批次号
- touchdown_index(TOUCHDOWN_INDEX):touchdown 序号；非零整数用于生成 TD_Label=1
- start_time(START_TIME):单次测试开始时间戳
- end_time(END_TIME):单次测试结束时间戳；与 START_TIME 的差转换为测试秒数
- in_qty(IN_QTY):实际的 Socket 使用数量
- out_qty(OUT_QTY):好品数量(包含复测)
- test_stage(TEST_STAGE):1st 表示初测,Rescreen 表示复测
- dut_num(DUT_NUM):Socket 数量
- step_id(STEP_ID):步骤
- date(DATE):ISO 格式的业务日标签；已经按 08:30 至次日 08:30 归日，不要根据 START_TIME/END_TIME 二次移日

导入审计表:

- `oee_import_runs` 每行表示一次 import、pull、sync 或 reimport 命令。`completed_with_warnings` 表示事实数据已提交但存在缺日、越界或无日期记录，`failed`/`interrupted` 表示仍需续导。
- `oee_import_windows` 每行表示一个数据集日期窗口。`requested_*` 是 API 逻辑日期，`expected_*` 是应用 DUT 固定日期偏移后的事实日期。
- `missing_dates_json`、`unexpected_dates_json`、`unscoped_row_count` 用于判断需要重导或人工清理的范围；`source_sha256` 用于核对原始响应是否变化。
- 事实表没有导入窗口外键。正常预期日期可原子替换；无日期和越界 DUT 行无法按窗口精确清理。

</database_field_descriptions>
