#!/bin/sh
# Migrate-on-deploy entrypoint (#19): apply pending migrations, then start the server.
# Uses the compiled migrate CLI (no tsx needed at runtime). Idempotent — `up` is a no-op
# when nothing is pending, so it's safe to run on every boot.
set -e

echo "[entrypoint] applying database migrations (migrate-on-deploy)..."
node /app/apps/server/dist/db/migrate.js up

echo "[entrypoint] starting Reload server..."
exec node /app/apps/server/dist/index.js
