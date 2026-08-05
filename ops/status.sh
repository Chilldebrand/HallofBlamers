#!/usr/bin/env bash
set -euo pipefail

# ops/status.sh — a one-shot snapshot of how the stack is doing right now:
# container status, site health + last sync, and disk usage.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

echo "=== Containers ==="
docker compose ps
echo

echo "=== Site health (last sync + last successful stat build) ==="
if response="$(curl -fsS http://127.0.0.1:3000/api/health 2>&1)"; then
  echo "$response"
else
  echo "UNREACHABLE: $response"
  echo "(the site may still be starting up, or something's wrong — see ./ops/logs.sh)"
fi
echo

echo "=== Disk usage ==="
if [ -d data ]; then
  du -sh data 2>/dev/null | awk '{print "  data/ total:  " $1}'
  # Explicit `if` blocks, not `[ -f x ] && cmd` as a standalone statement — under `set -e`, a
  # false test there would make the whole line exit non-zero and abort the script.
  if [ -f data/league.db ]; then
    du -sh data/league.db 2>/dev/null | awk '{print "  league.db:    " $1}'
  fi
  if [ -d data/backups ]; then
    du -sh data/backups 2>/dev/null | awk '{print "  backups/:     " $1}'
  fi
else
  echo "  data/ not found"
fi
df -h / 2>/dev/null | awk 'NR==1{print "  " $0} NR==2{print "  " $0}'
