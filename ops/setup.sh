#!/usr/bin/env bash
set -euo pipefail

# ops/setup.sh — first-time Hall of Blamers setup on a fresh Linux box.
#
# Run this ONCE, right after cloning the repo:
#
#   git clone <your-repo-url> hallofblamers
#   cd hallofblamers
#   ./ops/setup.sh
#
# Safe to re-run if something goes wrong partway through: it won't reinstall
# Docker if it's already there, and it won't overwrite an existing .env (so
# re-running after a failure just picks up where it left off).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

echo "=== Hall of Blamers first-time setup ==="
echo

if [ ! -d .git ]; then
  echo "This doesn't look like a git clone of the Hall of Blamers repo (no .git directory here)."
  echo "Clone it first, then re-run this script from inside the clone:"
  echo
  echo "  git clone <your-repo-url> hallofblamers"
  echo "  cd hallofblamers"
  echo "  ./ops/setup.sh"
  exit 1
fi

# ---------------------------------------------------------------------------
# 1) Docker
# ---------------------------------------------------------------------------
if command -v docker >/dev/null 2>&1; then
  echo "Docker is already installed ($(docker --version)) — skipping install."
else
  echo "Docker not found. Installing it via get.docker.com ..."
  curl -fsSL https://get.docker.com | sh
  echo
  echo "Docker is installed, but this terminal session doesn't have the new 'docker' group"
  echo "membership yet — the docker commands later in this script would fail with a permissions"
  echo "error if we kept going right now."
  echo
  echo "Log out and back in (or just close this terminal/SSH session and reconnect), then run:"
  echo
  echo "  ./ops/setup.sh"
  echo
  echo "It's safe to run again — everything already done (like this Docker install) gets"
  echo "skipped, and it picks up right where this left off."
  exit 0
fi
echo

# ---------------------------------------------------------------------------
# 2) .env — copy from .env.example, then fill in what's still blank.
# ---------------------------------------------------------------------------
if [ -f .env ]; then
  echo ".env already exists — leaving it as-is. Delete it first if you want to redo this step."
else
  cp .env.example .env
  echo "Created .env from .env.example."
fi
echo

# Writes key=value into .env, replacing an existing line for that key or appending a new one.
# Uses awk (not sed) specifically so arbitrary secret values — ESPN cookies are URL-encoded and
# can contain '/', '%', '&', etc. — never need shell/regex escaping to be inserted safely.
set_env_var() {
  local key="$1" value="$2"
  if grep -q "^${key}=" .env; then
    awk -v k="$key" -v v="$value" -F= 'BEGIN{OFS="="} $1==k{$0=k"="v} {print}' .env > .env.tmp && mv .env.tmp .env
  else
    printf '%s=%s\n' "$key" "$value" >> .env
  fi
}

current_value() {
  grep "^${1}=" .env 2>/dev/null | head -n1 | cut -d= -f2- || true
}

# SESSION_SECRET: auto-generate, never prompt — a non-developer shouldn't have to invent a random
# string, and .env.example ships a literal placeholder that must never make it into real use.
session_secret_now="$(current_value SESSION_SECRET)"
if [ -z "$session_secret_now" ] || [ "$session_secret_now" = "change-me-to-a-long-random-string" ]; then
  new_secret="$(openssl rand -hex 32)"
  set_env_var SESSION_SECRET "$new_secret"
  echo "Generated a new random SESSION_SECRET."
fi

# Prompts for a var only if it's currently blank — re-running this script after filling
# something in won't ask again or clobber it.
prompt_if_blank() {
  local key="$1" question="$2" optional_note="${3:-}"
  local existing
  existing="$(current_value "$key")"
  if [ -n "$existing" ]; then
    echo "$key already set — skipping."
    return
  fi
  local value
  read -r -p "$question $optional_note: " value
  if [ -n "$value" ]; then
    set_env_var "$key" "$value"
  else
    echo "  (left blank — you can add this later by editing .env and re-running: ./ops/deploy.sh)"
  fi
}

echo "A few values Hall of Blamers needs. Press Enter to leave any of these blank for now — you can"
echo "always fill them in later by editing .env directly, then running ./ops/deploy.sh."
echo

prompt_if_blank ESPN_LEAGUE_ID \
  "ESPN league id (the number in your league's ESPN URL, e.g. .../leagueId=1690915927)"
prompt_if_blank ESPN_S2 \
  "ESPN_S2 cookie value (from your browser while logged into ESPN Fantasy — see docs/RUNBOOK.md)" "[optional, needed for a private league]"
prompt_if_blank ESPN_SWID \
  "SWID cookie value (same place as ESPN_S2 — keep the surrounding {curly braces})" "[optional, needed for a private league]"
prompt_if_blank ANTHROPIC_API_KEY \
  "Anthropic API key (console.anthropic.com -> API Keys)" "[optional — only needed for AI-written weekly recaps]"
prompt_if_blank CLOUDFLARE_TUNNEL_TOKEN \
  "Cloudflare Tunnel token (see docs/RUNBOOK.md 'Creating the tunnel' if you don't have one yet)" "[optional — the site just won't be reachable from the internet until this is set]"

echo
echo "=== Starting the stack ==="
docker compose up -d --build
echo

echo "=== Setup complete ==="
echo
echo "Next steps:"
echo "  1. Check everything's healthy:   ./ops/status.sh"
echo "  2. Watch the logs while it warms up:   ./ops/logs.sh"
if [ -z "$(current_value CLOUDFLARE_TUNNEL_TOKEN)" ]; then
  echo "  3. You skipped the Cloudflare Tunnel token — the site is running but not reachable from"
  echo "     the internet yet. See docs/RUNBOOK.md's 'Creating the tunnel' section, then add the"
  echo "     token to .env and run ./ops/deploy.sh to pick it up."
else
  echo "  3. Confirm your domain (or Tailscale Funnel) resolves to the site — see docs/RUNBOOK.md."
fi
echo "  4. Read docs/RUNBOOK.md for routine operations (deploy, backup, restore, incidents)."
