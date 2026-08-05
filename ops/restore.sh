#!/usr/bin/env bash
set -euo pipefail

# ops/restore.sh <backup-file> — restores the database from a backup,
# REPLACING the live database. Use this to recover from a bad state (a bad
# sync, accidental data loss, etc).
#
# Usage:
#   ./ops/restore.sh data/backups/league-2026-08-03.db

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

if [ $# -ne 1 ]; then
  echo "Usage: ./ops/restore.sh <backup-file>"
  echo
  echo "Available backups:"
  ls -1 data/backups/ 2>/dev/null || echo "  (none found in data/backups/)"
  exit 1
fi

BACKUP_FILE="$1"

if [ ! -f "$BACKUP_FILE" ]; then
  echo "File not found: $BACKUP_FILE"
  exit 1
fi

echo "############################################################"
echo "#                                                          #"
echo "#     WARNING: THIS WILL REPLACE THE LIVE DATABASE!        #"
echo "#                                                          #"
echo "############################################################"
echo
echo "  Restoring from:  $BACKUP_FILE"
echo "  This REPLACES:   data/league.db"
echo
echo "  Everything since that backup was taken will be LOST — synced scores, recaps,"
echo "  admin edits, invite links, all of it — overwritten by whatever's in the backup."
echo
echo "  The site will be OFFLINE for a minute or two while this happens."
echo

read -r -p "Type EXACTLY 'restore' to continue, anything else to cancel: " confirm
if [ "$confirm" != "restore" ]; then
  echo "Cancelled — nothing was changed."
  exit 1
fi

echo
echo "-> Stopping the stack ..."
docker compose down

echo
echo "-> Saving a safety copy of the CURRENT database first (in case this was a mistake) ..."
# Taken AFTER the stack is stopped, not before — the database is WAL-mode and, while the stack is
# still up, something could be mid-write; a plain `cp` of a live WAL-mode database can copy a
# torn, inconsistent snapshot (see src/server/db/backup.ts's docstring for why the nightly backup
# uses VACUUM INTO instead of a raw copy for exactly this reason). Once the stack is down, nothing
# has the file open anymore, so a plain copy is safe here. It still needs the -wal/-shm siblings
# alongside the main file if they exist: SQLite doesn't necessarily checkpoint pending writes back
# into the main file just because the last connection closed, so recent writes can still be
# sitting in the WAL — copying only league.db could silently drop them from the safety copy.
mkdir -p data/backups
SAFETY_COPY="data/backups/league-pre-restore-$(date +%Y%m%d-%H%M%S).db"
if [ -f data/league.db ]; then
  cp data/league.db "$SAFETY_COPY"
  # NOT `[ -f x ] && cp ...` as a standalone statement — under `set -e`, a false test there would
  # make the whole line exit non-zero and abort the script right when the file just doesn't exist
  # (the common case: an empty/checkpointed WAL). Explicit `if` avoids that trap entirely.
  if [ -f data/league.db-wal ]; then
    cp data/league.db-wal "${SAFETY_COPY}-wal"
  fi
  if [ -f data/league.db-shm ]; then
    cp data/league.db-shm "${SAFETY_COPY}-shm"
  fi
  echo "   Saved to $SAFETY_COPY"
else
  echo "   (no existing data/league.db to copy — skipping)"
fi

echo
echo "-> Replacing data/league.db ..."
cp "$BACKUP_FILE" data/league.db
# Drop any stale WAL/SHM files from the previous database — the restored file is a clean,
# fully-checkpointed VACUUM INTO snapshot, so leftover WAL state from before would be wrong.
rm -f data/league.db-wal data/league.db-shm

echo
echo "-> Starting the stack back up ..."
docker compose up -d

echo
echo "-> Waiting for the site to report healthy ..."
ATTEMPTS=30
SLEEP_SECONDS=2
ok=0
for i in $(seq 1 "$ATTEMPTS"); do
  if curl -fsS http://127.0.0.1:3000/api/health >/dev/null 2>&1; then
    ok=1
    break
  fi
  sleep "$SLEEP_SECONDS"
done

echo
if [ "$ok" = "1" ]; then
  echo "RESTORE OK — site is back up and healthy."
  echo "If this was a mistake, your previous database was saved to: $SAFETY_COPY"
else
  echo "RESTORE FAILED — the site hasn't reported healthy yet — check ./ops/logs.sh"
  echo "Your previous database was still saved to: $SAFETY_COPY"
  exit 1
fi
