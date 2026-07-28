#!/usr/bin/env bash
set -euo pipefail

# Applies any pending Prisma migrations against the volume-mounted SQLite database before the
# server starts — never left as a manual step for DestCom to remember on every deploy.
node_modules/.bin/prisma migrate deploy --schema=prisma/schema.prisma

# Idempotent (see seed-admin.ts) — safe to run on every boot, not just the first one; skips
# silently if ADMIN_EMAIL already has an account.
node dist/auth/seed-admin.js

# Idempotent (see importSpeciesProfiles.ts) — skips the download entirely once plant_profiles has
# any rows. Unlike the two steps above, a failure here (e.g. a transient GitHub fetch error) must
# never block boot — the app works with no species assigned (docs/STROYPLANT_SPEC.md section 7.3),
# this is a nice-to-have, not core functionality like migrations or the admin account.
node dist/health/importSpeciesProfiles.js || echo "WARN: species profile import failed — will retry on next boot"

exec "$@"
