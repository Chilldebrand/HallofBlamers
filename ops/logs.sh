#!/usr/bin/env bash
set -euo pipefail

# ops/logs.sh — tails the last 200 lines of logs from all services, then keeps following.
# Press Ctrl+C to stop.
#
# Usage:
#   ./ops/logs.sh            # every service (web, worker, cloudflared)
#   ./ops/logs.sh worker     # just one service

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

docker compose logs -f --tail 200 "$@"
