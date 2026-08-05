#!/usr/bin/env bash
set -euo pipefail

# ops/backup-now.sh — runs an on-demand database backup right now, outside
# the regular 4:30am nightly schedule. Same VACUUM INTO + 14-day retention
# logic the worker's own nightly job uses (src/server/db/backup.ts) — useful
# right before a risky change, or just to check backups are still working.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

echo "=== Running an on-demand backup ==="
echo

if [ -n "$(docker compose ps -q web 2>/dev/null)" ]; then
  docker compose exec web npm run backup
else
  echo "(web isn't running right now — starting a one-off container just for this backup)"
  docker compose run --rm web npm run backup
fi

echo
echo "Done. Backups live in data/backups/ on this box — see ./ops/status.sh for a disk-usage summary."
