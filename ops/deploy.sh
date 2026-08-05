#!/usr/bin/env bash
set -euo pipefail

# ops/deploy.sh — pulls the latest code and redeploys the stack.
# Run this any time there's a new change to go live (Claude will usually tell you when).

# Task 28: if ANY command below fails, this prints one plain-language line before the script exits
# (via `set -e`) with whatever raw error came before it still visible above. The most likely cause
# right after `docker compose up` specifically is the automatic `migrate` step (see
# docker-compose.yml) refusing to start `web`/`worker` because a migration failed — that's the
# stack correctly refusing to half-start against a stale schema, not a bug in this script.
on_deploy_error() {
  echo
  echo "DEPLOY STOPPED — a command above failed, so nothing further ran."
  echo "If this happened right after 'docker compose up', the automatic database migration"
  echo "step ('migrate') most likely failed. Check its output:   ./ops/logs.sh migrate"
}
trap on_deploy_error ERR

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

echo "=== Deploying Hall of Blamers ==="
echo

echo "-> git pull"
git pull

echo
echo "-> docker compose up -d --build"
docker compose up -d --build

echo
echo "-> docker image prune -f (cleaning up old, now-unused images)"
docker image prune -f

echo
echo "-> waiting for the site to report healthy ..."
ATTEMPTS=30
SLEEP_SECONDS=2
ok=0
last_response=""

for i in $(seq 1 "$ATTEMPTS"); do
  if last_response="$(curl -fsS http://127.0.0.1:3000/api/health 2>&1)"; then
    ok=1
    break
  fi
  sleep "$SLEEP_SECONDS"
done

echo
if [ "$ok" = "1" ]; then
  echo "DEPLOY OK — site is up and healthy."
  echo "  $last_response"
  exit 0
else
  echo "DEPLOY FAILED — /api/health didn't come back healthy within $((ATTEMPTS * SLEEP_SECONDS))s."
  echo "Last response/error: $last_response"
  echo
  echo "Check what's wrong:   ./ops/logs.sh"
  echo "Check container status:   ./ops/status.sh"
  exit 1
fi
