# Test OEE 数据库

这是 Test OEE Skill 使用的 SQLite 数据库。

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
- date(DATE):日期
- shift(SHIFT):白班夜班的区分
- time_span(TIME_SPAN):机台状态对应的时间,单位秒

oee_dut_utilization:

- machine_id(MACHINE_ID):机台号
- lot_id(LOT_ID):物料批次号
- in_qty(IN_QTY):实际的 Socket 使用数量
- out_qty(OUT_QTY):好品数量(包含复测)
- test_stage(TEST_STAGE):1st 表示初测,Rescreen 表示复测
- dut_num(DUT_NUM):Socket 数量
- step_id(STEP_ID):步骤

</database_field_descriptions>
