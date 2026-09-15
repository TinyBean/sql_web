#!/usr/bin/env bash
set -euo pipefail
task_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
task_node="${SQL_WEB_NODE_PATH:-node}"
cd -- "$task_root"
umask 077

# A dry run must not create logs, locks, or database artifacts.
for task_argument in "$@"; do
  if [[ "$task_argument" == "--dry-run" ]]; then
    exec "$task_node" --import tsx scripts/oee-daily.ts "$@"
  fi
done

mkdir -p .data/locks .data/logs
if [[ "${1:-}" == "--cron" ]]; then
  shift
  task_log=".data/logs/oee-daily-console-$(TZ=Asia/Shanghai date +%F).log"
  exec >>"$task_log" 2>&1
fi
task_status=0
/usr/bin/flock -n -E 75 .data/locks/oee-daily.lock \
  "$task_node" --import tsx scripts/oee-daily.ts "$@" || task_status=$?
if [[ "$task_status" == 75 ]]; then
  echo '{"status":"skipped","reason":"daily update already running"}'
  exit 0
fi
exit "$task_status"
