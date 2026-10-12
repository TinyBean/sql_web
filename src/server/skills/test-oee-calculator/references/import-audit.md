# OEE 导入完整性审计

仅在调查导入失败、缺日或覆盖退化时读取。指标字段见 [事实表](database.md)，指标覆盖含义见 [业务规则](business-rules.md)。审计状态不能替代实际指标查询，也不能据此把缺失指标补为零。

- `oee_import_runs` 每行是一轮导入任务；`completed_with_warnings` 表示提交后仍有覆盖异常，`failed`／`interrupted` 表示任务未正常完成。
- `oee_import_windows` 每行是一个来源日期窗口。`requested_*` 为 API 参数日期，`expected_*` 为目标业务日期；DUT 目标日 D 请求 D 至 D+2。
- 通过 `committed_dates_json` 核对实际提交日，`incomplete_dates_json`、`missing_dates_json`、`unexpected_dates_json` 及无日期／边界计数核查覆盖异常。`coverage_version=0` 的旧 DUT 审计不能证明整日完整。
- 缺日或班次覆盖退化时保留旧事实；原始文件和响应保留。`source_sha256` 用于核对来源变化。

以下结构仅供只读调查，不是执行指令。

<database_schema dialect="sqlite">

```sql
CREATE TABLE IF NOT EXISTS oee_import_runs (
  id TEXT PRIMARY KEY,
  command TEXT NOT NULL CHECK (command IN ('import', 'pull', 'sync', 'reimport')),
  parameters_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('running', 'completed', 'completed_with_warnings', 'failed', 'interrupted')
  ),
  owner_pid INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  window_count INTEGER NOT NULL DEFAULT 0,
  completed_window_count INTEGER NOT NULL DEFAULT 0,
  warning_window_count INTEGER NOT NULL DEFAULT 0,
  failed_window_count INTEGER NOT NULL DEFAULT 0,
  error_stage TEXT,
  error_name TEXT,
  error_code TEXT,
  error_message TEXT
);

CREATE TABLE IF NOT EXISTS oee_import_windows (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES oee_import_runs(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  dataset TEXT NOT NULL CHECK (dataset IN ('availability', 'dut_utilization')),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('file', 'api')),
  source_ref TEXT NOT NULL,
  requested_start_date TEXT NOT NULL,
  requested_end_date TEXT NOT NULL,
  expected_start_date TEXT NOT NULL,
  expected_end_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN (
      'planned', 'downloading', 'importing', 'completed',
      'completed_with_warnings', 'failed', 'interrupted'
    )
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  completed_at TEXT,
  rows_received INTEGER NOT NULL DEFAULT 0,
  rows_inserted INTEGER NOT NULL DEFAULT 0,
  rows_deleted INTEGER NOT NULL DEFAULT 0,
  unscoped_row_count INTEGER NOT NULL DEFAULT 0,
  observed_min_date TEXT,
  observed_max_date TEXT,
  observed_day_counts_json TEXT NOT NULL DEFAULT '{}',
  missing_dates_json TEXT NOT NULL DEFAULT '[]',
  unexpected_dates_json TEXT NOT NULL DEFAULT '[]',
  source_sha256 TEXT,
  coverage_version INTEGER NOT NULL DEFAULT 0,
  committed_dates_json TEXT NOT NULL DEFAULT '[]',
  incomplete_dates_json TEXT NOT NULL DEFAULT '[]',
  ignored_boundary_row_count INTEGER NOT NULL DEFAULT 0,
  error_stage TEXT,
  error_name TEXT,
  error_code TEXT,
  error_message TEXT,
  UNIQUE (run_id, sequence)
);
```

</database_schema>
