#!/usr/bin/env bash
set -euo pipefail

# Applies any pending Prisma migrations against the volume-mounted SQLite database before the
# server starts — never left as a manual step for DestCom to remember on every deploy.
node_modules/.bin/prisma migrate deploy --schema=prisma/schema.prisma

# Idempotent (see seed-admin.ts) — safe to run on every boot, not just the first one; skips
# silently if ADMIN_EMAIL already has an account.
node dist/auth/seed-admin.js

exec "$@"
