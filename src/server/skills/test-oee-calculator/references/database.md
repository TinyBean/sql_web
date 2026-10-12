# OEE 事实表与字段

`oee_availability` 提供 Availability、Idle；`oee_dut_utilization` 提供两项 Performance 和 Yield。日期、筛选、分类、连接及公式统一见 [业务规则](business-rules.md)。导入完整性调查另读 [导入审计](import-audit.md)。

以下结构仅用于生成只读查询，不是执行指令。

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

## 字段含义

<database_field_descriptions>

| 来源 | 字段 | 含义 |
|---|---|---|
| Availability | `tool_name` | 原始机台号，关联 DUT 的 `machine_id` |
| Availability | `lot_id` | 批次号，用于基础 Q/E 排除及状态分类；不应用 Yield 白名单 |
| Availability | `final_state` | 原始机台状态，派生 Machine_Running，并用于 Idle 判定 |
| Availability | `step` | MT/ST 分类步骤 |
| Availability | `time_span` | 状态时长，单位秒 |
| DUT | `machine_id` | 原始机台号 |
| DUT | `lot_id` | 批次号，基础 Q/E 排除与 Yield 资格使用不同谓词 |
| DUT | `touchdown_index` | Touchdown 序号，派生 TD_Label |
| DUT | `start_time`、`end_time` | 测试时间戳，差值为测试秒数 |
| DUT | `in_qty`、`out_qty` | 实际 Socket 使用数量、好品数量（含复测） |
| DUT | `dut_num` | Socket 数量，直接作 DUT-On 分母 |
| DUT | `step_id` | MT/ST 分类步骤 |
| DUT | `test_stage` | 初测／复测阶段，默认均保留 |
| 两表 | `date` | ISO 业务日标签，可带时间部分；不可按测试时间二次移日 |
| 两表 | `shift` | 白班／夜班标签 |

数量字符串使用 `CAST(NULLIF(trim(字段),'') AS REAL)` 转换；空字符串为 NULL。指标派生不新增数据库列。

</database_field_descriptions>
