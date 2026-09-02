PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS oee_ingestion_runs (
  id INTEGER PRIMARY KEY,
  dataset TEXT NOT NULL CHECK (dataset IN ('availability', 'dut_utilization')),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('file', 'api')),
  source_ref TEXT NOT NULL,
  source_sha256 TEXT,
  requested_start_date TEXT NOT NULL CHECK (length(requested_start_date) = 10),
  requested_end_date TEXT NOT NULL CHECK (length(requested_end_date) = 10),
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  rows_received INTEGER NOT NULL DEFAULT 0 CHECK (rows_received >= 0),
  rows_inserted INTEGER NOT NULL DEFAULT 0 CHECK (rows_inserted >= 0),
  rows_updated INTEGER NOT NULL DEFAULT 0 CHECK (rows_updated >= 0),
  rows_unchanged INTEGER NOT NULL DEFAULT 0 CHECK (rows_unchanged >= 0),
  duplicate_rows_in_response INTEGER NOT NULL DEFAULT 0
    CHECK (duplicate_rows_in_response >= 0),
  record_issue_count INTEGER NOT NULL DEFAULT 0 CHECK (record_issue_count >= 0),
  observed_min_date TEXT,
  observed_max_date TEXT,
  error_message TEXT
);

CREATE TABLE IF NOT EXISTS oee_ingestion_run_days (
  run_id INTEGER NOT NULL REFERENCES oee_ingestion_runs(id) ON DELETE CASCADE,
  data_date TEXT NOT NULL CHECK (length(data_date) = 10),
  status TEXT NOT NULL
    CHECK (status IN ('present', 'missing_response', 'partial_response', 'out_of_range')),
  response_row_count INTEGER NOT NULL CHECK (response_row_count >= 0),
  database_row_count_before INTEGER NOT NULL CHECK (database_row_count_before >= 0),
  database_row_count_after INTEGER NOT NULL CHECK (database_row_count_after >= 0),
  PRIMARY KEY (run_id, data_date)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS oee_data_gaps (
  dataset TEXT NOT NULL CHECK (dataset IN ('availability', 'dut_utilization')),
  data_date TEXT NOT NULL CHECK (length(data_date) = 10),
  status TEXT NOT NULL CHECK (status IN ('open', 'resolved', 'accepted')),
  reason TEXT NOT NULL CHECK (reason IN ('missing_response', 'partial_response')),
  last_response_row_count INTEGER NOT NULL CHECK (last_response_row_count >= 0),
  database_row_count INTEGER NOT NULL CHECK (database_row_count >= 0),
  first_detected_run_id INTEGER NOT NULL REFERENCES oee_ingestion_runs(id),
  last_checked_run_id INTEGER NOT NULL REFERENCES oee_ingestion_runs(id),
  resolved_run_id INTEGER REFERENCES oee_ingestion_runs(id),
  check_count INTEGER NOT NULL DEFAULT 1 CHECK (check_count >= 1),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (dataset, data_date)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS oee_dataset_state (
  dataset TEXT PRIMARY KEY CHECK (dataset IN ('availability', 'dut_utilization')),
  api_endpoint TEXT NOT NULL,
  min_data_date TEXT,
  max_data_date TEXT,
  row_count INTEGER NOT NULL DEFAULT 0 CHECK (row_count >= 0),
  distinct_date_count INTEGER NOT NULL DEFAULT 0 CHECK (distinct_date_count >= 0),
  last_successful_run_id INTEGER REFERENCES oee_ingestion_runs(id),
  last_requested_start_date TEXT,
  last_requested_end_date TEXT,
  last_observed_min_date TEXT,
  last_observed_max_date TEXT,
  updated_at TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS oee_record_issues (
  dataset TEXT NOT NULL CHECK (dataset IN ('availability', 'dut_utilization')),
  record_key TEXT NOT NULL,
  issue_code TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'resolved', 'accepted')),
  details TEXT NOT NULL,
  first_seen_run_id INTEGER NOT NULL REFERENCES oee_ingestion_runs(id),
  last_seen_run_id INTEGER NOT NULL REFERENCES oee_ingestion_runs(id),
  resolved_run_id INTEGER REFERENCES oee_ingestion_runs(id),
  occurrence_count INTEGER NOT NULL DEFAULT 1 CHECK (occurrence_count >= 1),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (dataset, record_key, issue_code)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS oee_availability (
  record_key TEXT PRIMARY KEY,
  data_date TEXT NOT NULL CHECK (length(data_date) = 10),
  event_ts INTEGER NOT NULL,
  tool_name TEXT NOT NULL,
  lot_id TEXT NOT NULL,
  final_state TEXT NOT NULL,
  step_code TEXT NOT NULL,
  shift TEXT NOT NULL,
  time_span INTEGER NOT NULL,
  source_hash TEXT NOT NULL,
  first_run_id INTEGER NOT NULL REFERENCES oee_ingestion_runs(id),
  last_run_id INTEGER NOT NULL REFERENCES oee_ingestion_runs(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_oee_availability_date
ON oee_availability(data_date);

CREATE INDEX IF NOT EXISTS idx_oee_availability_date_tool_state
ON oee_availability(data_date, tool_name, final_state, shift);

CREATE INDEX IF NOT EXISTS idx_oee_availability_lot
ON oee_availability(lot_id);

CREATE TABLE IF NOT EXISTS oee_dut_utilization (
  record_key TEXT PRIMARY KEY,
  data_date TEXT NOT NULL CHECK (length(data_date) = 10),
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  start_ts INTEGER NOT NULL,
  end_ts INTEGER NOT NULL,
  machine_id TEXT NOT NULL,
  lot_id TEXT NOT NULL,
  dut_num TEXT NOT NULL,
  touchdown_index INTEGER NOT NULL,
  tray_id TEXT NOT NULL,
  shift TEXT NOT NULL,
  in_qty INTEGER NOT NULL,
  out_qty INTEGER NOT NULL,
  total_in INTEGER NOT NULL,
  total_out INTEGER NOT NULL,
  part_num TEXT NOT NULL,
  package_size TEXT NOT NULL,
  test_stage TEXT NOT NULL,
  test_program TEXT NOT NULL,
  step_code TEXT NOT NULL,
  step_id TEXT NOT NULL,
  tooling TEXT NOT NULL,
  flush_flag TEXT NOT NULL,
  mix_nomix TEXT NOT NULL,
  full_td_index INTEGER NOT NULL,
  partial_td INTEGER NOT NULL,
  td_seq_forspc INTEGER NOT NULL,
  dut_off_auto INTEGER NOT NULL,
  dut_off_manual INTEGER NOT NULL,
  handler_dut_off_count INTEGER NOT NULL,
  sbin_socket_off_count INTEGER NOT NULL,
  td_socket_off_count INTEGER NOT NULL,
  tester_dut_off_count INTEGER NOT NULL,
  source_hash TEXT NOT NULL,
  first_run_id INTEGER NOT NULL REFERENCES oee_ingestion_runs(id),
  last_run_id INTEGER NOT NULL REFERENCES oee_ingestion_runs(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_oee_dut_date
ON oee_dut_utilization(data_date);

CREATE INDEX IF NOT EXISTS idx_oee_dut_date_machine
ON oee_dut_utilization(data_date, machine_id);

CREATE INDEX IF NOT EXISTS idx_oee_dut_date_part
ON oee_dut_utilization(data_date, part_num);

CREATE INDEX IF NOT EXISTS idx_oee_dut_start_time
ON oee_dut_utilization(start_ts);

CREATE INDEX IF NOT EXISTS idx_oee_dut_lot
ON oee_dut_utilization(lot_id);

CREATE TABLE IF NOT EXISTS oee_dut_payload (
  record_key TEXT PRIMARY KEY REFERENCES oee_dut_utilization(record_key) ON DELETE CASCADE,
  dut_lot_map TEXT NOT NULL,
  handler_dut_off TEXT NOT NULL,
  hbin_info TEXT NOT NULL,
  sbin_socket_off TEXT NOT NULL,
  td_socket_off TEXT NOT NULL,
  tester_dut_off TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oee_availability_monthly_stats (
  month_key TEXT NOT NULL CHECK (length(month_key) = 7),
  tool_name TEXT NOT NULL,
  final_state TEXT NOT NULL,
  step_code TEXT NOT NULL,
  shift TEXT NOT NULL,
  record_count INTEGER NOT NULL,
  total_time_span INTEGER NOT NULL,
  PRIMARY KEY (month_key, tool_name, final_state, step_code, shift)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS oee_dut_monthly_stats (
  month_key TEXT NOT NULL CHECK (length(month_key) = 7),
  machine_id TEXT NOT NULL,
  part_num TEXT NOT NULL,
  package_size TEXT NOT NULL,
  test_stage TEXT NOT NULL,
  step_code TEXT NOT NULL,
  shift TEXT NOT NULL,
  record_count INTEGER NOT NULL,
  total_duration_seconds INTEGER NOT NULL,
  total_in_qty INTEGER NOT NULL,
  total_out_qty INTEGER NOT NULL,
  total_handler_dut_off INTEGER NOT NULL,
  total_sbin_socket_off INTEGER NOT NULL,
  total_td_socket_off INTEGER NOT NULL,
  total_tester_dut_off INTEGER NOT NULL,
  PRIMARY KEY (
    month_key,
    machine_id,
    part_num,
    package_size,
    test_stage,
    step_code,
    shift
  )
) WITHOUT ROWID;

CREATE VIEW IF NOT EXISTS oee_data_status AS
SELECT
  state.dataset,
  state.api_endpoint,
  state.min_data_date,
  state.max_data_date,
  state.row_count,
  state.distinct_date_count,
  state.last_requested_start_date,
  state.last_requested_end_date,
  state.last_observed_min_date,
  state.last_observed_max_date,
  state.updated_at,
  COALESCE((
    SELECT COUNT(*)
    FROM oee_data_gaps AS gap
    WHERE gap.dataset = state.dataset AND gap.status = 'open'
  ), 0) AS open_gap_count,
  COALESCE((
    SELECT COUNT(*)
    FROM oee_record_issues AS issue
    WHERE issue.dataset = state.dataset AND issue.status = 'open'
  ), 0) AS open_record_issue_count
FROM oee_dataset_state AS state;
