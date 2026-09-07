PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS oee_availability (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tool_name TEXT NOT NULL,
  lot_id TEXT NOT NULL,
  final_state TEXT NOT NULL,
  step TEXT NOT NULL,
  date TEXT NOT NULL,
  shift TEXT,
  time_span INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_oee_availability_date
ON oee_availability(date);

CREATE INDEX IF NOT EXISTS idx_oee_availability_date_tool_state
ON oee_availability(date, tool_name, final_state);

CREATE INDEX IF NOT EXISTS idx_oee_availability_lot
ON oee_availability(lot_id);

CREATE TABLE IF NOT EXISTS oee_dut_utilization (
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

CREATE INDEX IF NOT EXISTS idx_oee_dut_date
ON oee_dut_utilization(date);

CREATE INDEX IF NOT EXISTS idx_oee_dut_date_machine
ON oee_dut_utilization(date, machine_id);

CREATE INDEX IF NOT EXISTS idx_oee_dut_date_part
ON oee_dut_utilization(date, part_num);

CREATE INDEX IF NOT EXISTS idx_oee_dut_start_time
ON oee_dut_utilization(start_time);

CREATE INDEX IF NOT EXISTS idx_oee_dut_lot
ON oee_dut_utilization(lot_id);

CREATE INDEX IF NOT EXISTS idx_oee_dut_business_fields
ON oee_dut_utilization(machine_id, lot_id, in_qty, out_qty, test_stage, dut_num, step_id);

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

CREATE INDEX IF NOT EXISTS idx_oee_import_runs_started
ON oee_import_runs(started_at DESC);

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
  error_stage TEXT,
  error_name TEXT,
  error_code TEXT,
  error_message TEXT,
  UNIQUE (run_id, sequence)
);

CREATE INDEX IF NOT EXISTS idx_oee_import_windows_dataset_dates
ON oee_import_windows(dataset, requested_start_date, requested_end_date, completed_at);

CREATE INDEX IF NOT EXISTS idx_oee_import_windows_status
ON oee_import_windows(status, dataset);

PRAGMA user_version = 2;
