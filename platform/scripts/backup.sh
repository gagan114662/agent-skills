#!/usr/bin/env bash
# Postgres logical backup for the Reload platform (#19).
# Dumps the database via the compose `postgres` service to a timestamped file.
#
# Usage:  bash platform/scripts/backup.sh [output-dir]
# Output: <output-dir>/reload-YYYYmmdd-HHMMSS.sql.gz   (default dir: ./backups)
#
# Restore with scripts/restore.sh. Schedule via cron/CI for real environments;
# ship the artifact to offsite/object storage (out of scope here — see operations.md).
set -euo pipefail
cd "$(dirname "$0")/.."

OUT_DIR="${1:-backups}"
mkdir -p "$OUT_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$OUT_DIR/reload-$STAMP.sql.gz"

echo ">> dumping reload database -> $OUT" >&2
docker compose exec -T postgres pg_dump -U reload -d reload | gzip > "$OUT"

echo ">> backup complete: $OUT ($(du -h "$OUT" | cut -f1))" >&2
