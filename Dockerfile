# syntax=docker/dockerfile:1

# Batch 9 (docs/STROYPLANT_SPEC.md section 14): a single image, backend + frontend, no separate
# nginx/Caddy container. Debian base (not Alpine) to match the production server's own distro —
# BlueZ/D-Bus behavior is validated against real Debian, not musl libc.

FROM node:26-bookworm-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME/bin:$PATH"
# pnpm 11 (see pnpm-workspace.yaml's own comment on verifyDepsBeforeRun for the CI build-blocking
# half of this) also interactively prompts to approve any package's build/postinstall scripts that
# aren't already pre-approved via allowBuilds — with no TTY, that prompt would otherwise hang
# forever instead of erroring cleanly. CI=true is pnpm's own documented way to make the whole CLI
# behave non-interactively in a build environment like this one.
ENV CI=true
RUN corepack enable
# openssl must be present here too, not just in the runtime stage: `prisma generate` (run in the
# build stage below) probes the local libssl version to pick the right query-engine binary, and
# silently defaults to a wrong guess (1.1.x) without it — found empirically as a runtime crash
# ("Prisma Client could not locate the Query Engine for runtime linux-arm64-openssl-3.0.x") since
# Debian bookworm actually ships OpenSSL 3.0.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*

# --- build: full workspace install (dev deps included) + compile backend and frontend ---
FROM base AS build
WORKDIR /usr/src/app
COPY . .
# noble-bridge is macOS-only/dev-only (native @abandonware/noble bindings for CoreBluetooth) — not
# needed in the production image and its native build fails outright on Linux without Python/build
# tools, so it's excluded from the install scope entirely rather than worked around.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --filter backend --filter frontend --frozen-lockfile
RUN pnpm --filter backend exec prisma generate
RUN pnpm --filter frontend build
RUN pnpm --filter backend build
# pnpm deploy (not a manual node_modules copy): the workspace's node_modules are pnpm-store
# symlinks, not portable across stages as-is — deploy resolves a real, isolated, prod-only
# node_modules for just the backend package (docs.pnpm.io/cli/deploy), including its already-built
# dist/ and prisma/ (nothing here is gitignored inside backend/, so pnpm deploy's default "copy
# everything" behavior keeps them).
RUN pnpm deploy --filter=backend --prod --legacy /prod/backend
# Prisma's generated client lives in node_modules and isn't part of dependency resolution — the
# isolated deploy above doesn't carry it over, so it's regenerated once more directly into the
# deployed node_modules (this build stage's `prisma` CLI, pointed at the deployed schema).
RUN pnpm --filter backend exec prisma generate --schema=/prod/backend/prisma/schema.prisma
# Frontend's build output isn't part of the backend package dir, so pnpm deploy doesn't carry it —
# placed as a sibling of backend's dist/ (see backend/src/api/staticFrontend.ts for the exact
# expected relative path).
RUN cp -r frontend/dist /prod/backend/frontend-dist

# --- runtime: minimal image, only what's needed to run the deployed backend ---
FROM base AS runtime
# bluez: provides `bluetoothctl`, shelled out to by the node-ble provider's adapter restart
# (backend/src/providers/node-ble/index.ts) — the container talks to the host's bluetoothd over
# the mounted D-Bus socket, but that specific binary must exist inside the container itself.
RUN apt-get update && apt-get install -y --no-install-recommends bluez dbus && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /prod/backend .
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
ENV NODE_ENV=production
# Set by .github/workflows/docker-publish.yml from github.sha — surfaced read-only via
# GET /api/public-config so the Settings page can show which commit is actually running and warn
# when GitHub's main has moved past it (see frontend/src/components/version-settings-section.tsx).
# Empty for a local `docker build` with no --build-arg (env.ts treats "" the same as unset).
ARG GIT_SHA=""
ENV GIT_SHA=$GIT_SHA
EXPOSE 3000
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
