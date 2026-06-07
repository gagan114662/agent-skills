#!/usr/bin/env bash
# Restore a Reload Postgres backup produced by scripts/backup.sh (#19).
#
# Usage:  bash platform/scripts/restore.sh <backup-file.sql.gz>
#
# DESTRUCTIVE: pipes the dump back into the live `reload` database via the compose
# `postgres` service. Take a fresh backup first. See operations.md for the full
# restore runbook (incl. point-in-time considerations).
set -euo pipefail
cd "$(dirname "$0")/.."

FILE="${1:?usage: restore.sh <backup-file.sql.gz>}"
[ -f "$FILE" ] || { echo "!! no such file: $FILE" >&2; exit 1; }

echo ">> restoring $FILE into the reload database (this overwrites current data)" >&2
gunzip -c "$FILE" | docker compose exec -T postgres psql -U reload -d reload

echo ">> restore complete from $FILE" >&2
