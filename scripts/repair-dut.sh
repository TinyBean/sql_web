#!/usr/bin/env bash
set -euo pipefail
task_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
task_node="${SQL_WEB_NODE_PATH:-node}"
cd -- "$task_root"
umask 077
mkdir -p .data/locks
exec /usr/bin/flock -n -E 75 .data/locks/oee-daily.lock \
  "$task_node" --import tsx scripts/repair-dut.ts "$@"
