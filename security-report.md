# 🔐 Security Audit Report

**Date:** 2026-08-17 (fixes applied same day — see "Fix Pass" section at the end)
**Score:** 84/100 🟡 at audit time → **89/100 🟡 after fixes**
**Project:** StroyPlant
**Stacks:** Node.js/TypeScript, Fastify, Prisma/SQLite, tRPC, BetterAuth, MCP SDK, Docker, GitHub Actions, React/Vite frontend
**Audited by:** security-skill v1.0.0

Context that shapes every finding below: this is a **self-hosted, single-admin personal tool**, not a multi-tenant SaaS. There is exactly one user (DestCom), who also holds SSH/Docker access to the production server. Several checks that would be Critical for a public multi-user app (rate limiting, IDOR, GDPR erasure) are real but lower-stakes here — flagged at reduced severity accordingly, per the skill's signal-vs-noise principle.

---

## 📊 Score Breakdown

| Category | Score | Issues |
|---|---|---|
| 01. Secrets & Files | 90/100 | 0 crit, 0 high, 1 low |
| 02. Network & CORS | 70/100 | 0 crit, 0 high, 1 medium |
| 03. HTTP Headers | 40/100 | 0 crit, 1 high |
| 04. Auth & Sessions | 85/100 | 0 crit, 0 high, 1 medium |
| 05. Cryptography | 92/100 | clean |
| 06. JWT (deep) | 95/100 | N/A — session cookies + library-managed OAuth, no custom JWT handling |
| 07. Database Security | 85/100 | clean |
| 08. Deployment & Cloud | 78/100 | 0 crit, 0 high, 2 low |
| 09. Docker & Containers | 60/100 | 0 crit, 1 high |
| 10. Protocols | 75/100 | 0 crit, 0 high, 1 medium |
| 11. Advanced Attacks | 92/100 | clean |
| 12. Injections | 90/100 | clean |
| 13. Race Conditions | 95/100 | clean — best-in-class, see below |
| 14. File Upload | 100/100 | N/A, no upload feature |
| 15. DNS & Email | 100/100 | N/A |
| 16. Supply Chain | 65/100 | 0 crit*, 0 high*, 1 medium (see note) |
| 17. Mobile | 100/100 | N/A |
| 18. Compliance & GDPR | 80/100 | 0 crit, 0 high, info only |
| 19. Monitoring & Detection | 82/100 | 0 crit, 0 high, 2 low |
| 20. Serverless & Edge | 100/100 | N/A |
| 21. Source Code Analysis | 85/100 | 0 crit, 0 high, 1 low |
| 22. AI/LLM Security (MCP) | 92/100 | clean — well-scoped |
| 23. Bot & DDoS | 65/100 | same rate-limit gap as #02 |
| 24. Browser APIs | 100/100 | N/A |
| 25. Advanced Security (L3) | 100/100 | N/A for this threat model |

\* `pnpm audit` reports 2 critical + 16 high, but nearly all sit in a non-runtime build-tool dependency chain — see Supply Chain section for the real breakdown.

---

## 🟠 High Issues

### 1. No HTTP security headers (CWE-693, CWE-1021)
**File:** `backend/src/api/server.ts`, `backend/src/api/staticFrontend.ts`
**Problem:** No `@fastify/helmet` (or manual equivalent) is registered anywhere. The app ships with none of: CSP, `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`. HSTS is presumably handled by your reverse proxy (out of this repo's scope), but nothing here confirms it.
**Risk:** The login page and dashboard can be iframed by any external site (no `frame-ancestors`/`X-Frame-Options`) — clickjacking on the "trigger watering" button is a concrete scenario. No CSP also removes a layer of defense-in-depth against any future XSS.
**Fix:**
```ts
// backend/src/api/server.ts
import helmet from '@fastify/helmet';
await app.register(helmet, {
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"], // Tailwind/shadcn inline styles — tighten with nonces if feasible
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'", 'wss:'], // for the tRPC WS subscription
      frameAncestors: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false, // would break the SPA's asset loading unless audited
});
```
**References:** OWASP A05:2021, CWE-1021 (Improper Restriction of Rendered UI Layers)

### 2. Docker container runs as root (CWE-250)
**File:** `Dockerfile`
**Problem:** No `USER` directive anywhere — the `runtime` stage runs `node dist/index.js` as root (the `node:22-bookworm-slim` base's default user). Combined with `docker-compose.prod.yml`'s `network_mode: host`, `cap_add: [NET_ADMIN, NET_RAW]`, and the mounted host D-Bus socket, a future RCE in the Node process (e.g. via a compromised dependency) would have direct host-adjacent reach rather than being contained by a UID boundary.
**Risk:** Elevated blast radius from any future application-level compromise — this is the one place where the app's own configuration, not just its dependencies, materially widens the attack surface.
**Context:** This is a deliberate, previously-validated tradeoff (`infra/lot0/CHECKLIST.md` — fine-grained capabilities chosen specifically to avoid `privileged: true`). Root may or may not be strictly required for the `bluetoothctl`/D-Bus calls this app makes; that needs verification on the real server, not a blind change.
**Fix (verify on production server before shipping):**
```dockerfile
RUN groupadd -r stroyplant && useradd -r -g stroyplant stroyplant
# ... after all apt-get/chmod steps that need root ...
USER stroyplant
```
Test specifically whether `bluetoothctl power off/on` and D-Bus socket access still work as a non-root user with the container's existing `cap_add` capabilities — if not, this may need to stay root with a documented justification rather than a silent revert.
**References:** CWE-250 (Execution with Unnecessary Privileges), Docker CIS Benchmark 4.1

---

## 🟡 Medium Issues

### 3. No general rate limiting on the API/tRPC/MCP surface (CWE-770)
**Files:** `backend/src/api/server.ts`, `backend/src/api/trpc/`, `backend/src/mcp/routes.ts`
**Problem:** Only BetterAuth's own built-in limiter covers `/api/auth/*`. Every tRPC procedure (`/api/trpc/*`) and the MCP OAuth endpoints (`/mcp/register`, `/mcp/authorize`, token exchange) have no rate limiting of their own.
**Risk:** Lower real-world urgency for a single-admin app with no public sign-up, but the MCP OAuth surface (`allowDynamicClientRegistration: true`) is unauthenticated by design until login — an attacker could hammer client registration or token endpoints. This is explicitly the kind of gap the skill flags as commonly missed.
**Fix:**
```ts
import rateLimit from '@fastify/rate-limit';
await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });
// Stricter on /mcp/register and /mcp/authorize specifically if needed
```
**References:** OWASP A05:2021, CWE-770

### 4. No explicit Origin validation on the WebSocket upgrade (CWE-346)
**File:** `backend/src/api/server.ts` (`useWSS: true` on `fastifyTRPCPlugin`)
**Problem:** The `readings.onReading` subscription's WS handshake is authenticated via the same session-cookie resolution as HTTP calls (`context.ts`), but there's no explicit `verifyClient`/Origin allowlist at the WebSocket layer itself — protection today relies entirely on the session cookie's `SameSite` attribute (BetterAuth's library default, not explicitly configured in `auth.ts`).
**Risk:** Cross-Site WebSocket Hijacking is largely mitigated in modern browsers by `SameSite=Lax` (the presumed default), but this hasn't been explicitly verified or hardened — the skill's own "AI Blind Spot" guidance specifically calls out WebSocket handshakes as a commonly-missed ASVS Level 3 check.
**Fix:** Add an explicit Origin check on the WS upgrade as defense-in-depth, and explicitly set (don't rely on library default) `sameSite: 'lax'` (or `'strict'`) on the session cookie in `auth.ts`:
```ts
// auth.ts
advanced: {
  ...,
  cookies: { session_token: { attributes: { sameSite: 'lax', secure: true, httpOnly: true } } },
},
```
**References:** CWE-346 (Origin Validation Error), ASVS V13.5 (WebSocket)

### 5. Dependency vulnerabilities — mostly noise, some real (CWE-1104)
**Evidence:** `pnpm audit --prod` reports 2 critical, 16 high, 12 moderate, 1 low (31 total).
**Breakdown:**
- **Not runtime-reachable (no action needed short-term):** the 2 critical (`form-data`, `tar`) and most of the 16 high findings all come through `node-ble → dbus-next → usocket → node-gyp`. `node-gyp` only runs during `pnpm install` to compile a native addon — it is never loaded by the running server process. Same story for the `noble-bridge`/`@abandonware/noble` chain (macOS dev-only tool, never shipped to production).
- **Worth a `pnpm update` when convenient:** `hono` (moderate, 4 advisories — ReDoS in CORS middleware, SSR `memo()` cross-request leak) is pulled in by `@modelcontextprotocol/sdk`, which does back the real, authenticated `/mcp` endpoint. `fast-uri` (high, host-confusion) comes through Fastify's own `fast-json-stringify`. Neither has a confirmed exploitable path in this app's actual usage of those libraries, but both are cheap to fix.
**Fix:** `pnpm update hono fast-uri` (transitive — may need `pnpm.overrides` in the root `package.json` if the direct dependents haven't bumped their own ranges yet). No action needed on the node-gyp chain findings.
**References:** CWE-1104 (Use of Unmaintained Third-Party Components)

---

## 🔵 Low / Info

- **No pre-commit secret-scanning hook** (gitleaks or equivalent) — `.gitignore` and `.env` handling are already correct, so this is a defense-in-depth layer, not an active gap. (Secrets & Files)
- **GitHub Actions pinned to tags, not commit SHAs** (`actions/checkout@v4`, `docker/*-action@v3/v5/v6`) — tags are mutable; SHA-pinning is the hardened form. Low urgency for a single-maintainer repo with `packages: write` correctly scoped and no `pull_request_target` usage. (Deployment)
- **No `.github/dependabot.yml`** — dependency updates are manual today. (Deployment / Supply Chain)
- **`inference-boundary-check.yml` has no explicit `permissions:` block** — inherits the repo default rather than declaring least-privilege explicitly like `docker-publish.yml` does. (Deployment)
- **No `/.well-known/security.txt`** — cosmetic for a personal, non-public-facing-by-design tool. (Monitoring)
- **tRPC's default error formatter is unmodified** (`backend/src/api/trpc/trpc.ts`) — no custom `errorFormatter` explicitly strips `error.data.stack` from responses. `NODE_ENV=production` is correctly set in the Docker image, which should suppress this in tRPC's own defaults, but this wasn't independently verified against a live production error. Cheap to harden explicitly rather than trust the default:
  ```ts
  const t = initTRPC.context<Context>().create({
    errorFormatter: ({ shape }) => ({ ...shape, data: { ...shape.data, stack: undefined } }),
  });
  ```
  (Source Code Analysis)

---

## ✅ What's Secure

- **No secrets in tracked files or git history** — `.env`/`.env.*` properly gitignored (only `.env.example` committed), targeted grep across the repo found no hardcoded API keys/tokens/passwords.
- **No command injection** despite shelling out to `bluetoothctl` — `execFile` with argument arrays, never a shell string (`backend/src/providers/node-ble/index.ts`).
- **No SQL injection** — Prisma ORM exclusively, zero `$queryRaw`/`$executeRaw` usage anywhere.
- **No XSS-prone patterns** — no `eval`/`new Function`/`dangerouslySetInnerHTML` in application code (only in vendored shadcn `ui/` components per the project's own documented Biome exception).
- **Consistent input validation** — every tRPC procedure and every MCP tool uses an explicit Zod schema; no mass-assignment risk anywhere (`req.body` is never passed directly to Prisma).
- **`BETTER_AUTH_SECRET` dev fallback correctly gated** — warns loudly if unset, and the insecure fallback + permissive dev CORS both correctly turn off because `NODE_ENV=production` is genuinely set in the shipped `Dockerfile`.
- **Race conditions are a documented strength, not a gap** — the single-connection `connectionQueue`, watering-trigger cooldowns, and multiple deduplication guards (`SyncEvent`, `ShadowDivergence`) were all purpose-built after a real production incident (see `CLAUDE.md`'s "Second production incident round" entry) — genuinely best-in-class for this category.
- **`never-fire-and-forget` discipline for the one physically consequential action** (`triggerWatering()`) — every failure path is explicit, logged, and surfaced to the caller across all 4 trigger sources (manual, cron, MQTT button, MCP tool) — exactly the CWE-252-adjacent class of bug this project has institutionalized a fix for.
- **MCP server is tightly scoped** — 4 well-defined tools (no arbitrary code execution, no filesystem/process access), OAuth 2.1 (not a static API key), Zod-validated tool inputs, `trigger_watering` never fails silently to the LLM caller either.
- **`.dockerignore` is solid** — excludes `.env`, `dev.db`, `.git`, and build artifacts from the build context.
- **GHCR publish workflow already follows least-privilege** — explicit `permissions: {contents: read, packages: write}`, no `pull_request_target`, no secrets echoed to logs.

---

## 📋 Accepted Risks

Carried over from `CLAUDE.md`/project memory — reviewed during this audit, not re-flagged as new findings:
- **MQTT broker password stored in cleartext** in the DB — consistent with `BETTER_AUTH_SECRET`'s own handling, no vault for this single-admin deployment (explicit prior decision).
- **MCP OAuth's `allowDynamicClientRegistration: true`** is open by design — any registered client still has to pass through the real `/login` page, gated by the single admin account's password.
- **`SyncEvent`/`RawSensorLog` have no retention/pruning policy** — deliberately deferred until real production volume data exists to inform a policy, per explicit prior instruction to prefer dedup/archive over blind deletion of historical data.
- **No GDPR data-export/erasure endpoint** — the "data subject" and the "operator" are the same person with direct DB access; a self-service erasure flow would be theater, not protection, for this deployment shape.

---

## 🔄 Secrets Rotation Status

No secrets are currently tracked in `memory-security.md`'s rotation table (first audit — nothing to compare against). Recommend recording `BETTER_AUTH_SECRET`'s creation date once a real (non-dev-fallback) value is confirmed set on the production server, so future audits can flag rotation due-dates.

---

## 📅 Next Steps

1. **Add `@fastify/helmet`** with a CSP tuned to the Vite build — closes the highest-signal gap (#1).
2. **Verify whether the Docker container can run as a non-root user** without breaking `bluetoothctl`/D-Bus access on the real production server — if yes, add the `USER` directive; if no, document why root is required (#2).
3. **Add `@fastify/rate-limit`** globally, with a stricter bucket on `/mcp/register` and `/mcp/authorize` (#3).
4. **Explicitly set `sameSite`/`secure` on the session cookie** in `auth.ts` rather than relying on the library default, and consider an explicit Origin allowlist on the WS upgrade (#4).
5. `pnpm update hono fast-uri` when convenient (#5) — not urgent.
6. Small cleanup pass: pin GitHub Actions to SHA, add `.github/dependabot.yml`, add an explicit `errorFormatter` stripping `data.stack` from tRPC responses.

Run `/security-fix` to apply fixes from this report automatically (with confirmations for anything risky — Docker/user changes will need your explicit sign-off before touching production).

---

## 🔧 Fix Pass (2026-08-17, same day)

Applied and verified (backend `tsc --noEmit`/`build` clean, 128/128 `pnpm test` passing, root `pnpm lint` clean on all touched files, a real server boot + Playwright pass through login → dashboard confirmed no CSP violations and the `readings.onReading` WebSocket still connects):

1. **HTTP headers (#1, High → fixed)** — `@fastify/helmet` registered in `backend/src/api/server.ts` with a CSP scoped to what the SPA actually needs (`'self'` everywhere, `'unsafe-inline'` only on `style-src` for Radix/shadcn's inline positioning styles, `https://api.github.com` added to `connect-src` for the version-check card's direct browser fetch). Verified live: `X-Frame-Options`, `Content-Security-Policy`, `Strict-Transport-Security`, `X-Content-Type-Options` all present on real responses; logged into the real app in a browser with zero console/CSP errors.
2. **Rate limiting (#3, Medium → fixed)** — `@fastify/rate-limit` registered globally (100 req/min), covering the tRPC and MCP surface that BetterAuth's own limiter doesn't reach. Verified: `x-ratelimit-*` headers present on live responses.
3. **WebSocket / cookie hardening (#4, Medium → downgraded, no code change)** — traced BetterAuth's actual cookie defaults in its installed source (`node_modules/better-auth/dist/cookies/index.mjs`): `httpOnly: true`, `sameSite: 'lax'`, and `secure` auto-derived from `NODE_ENV`/the configured `baseURL` scheme are **already the library default**, not something this app was missing. Adding an explicit override would have been redundant boilerplate. No code change made — finding downgraded to "verified already adequate" rather than left as an open Medium.
4. **tRPC error stack leakage (Low → fixed)** — `backend/src/api/trpc/trpc.ts` now sets an explicit `errorFormatter` stripping `data.stack` from every response, rather than trusting tRPC's own environment-based default.
5. **Supply chain (#5, Medium → mostly fixed)** — added `pnpm.overrides` in the root `package.json` (`hono >=4.12.34`, `fast-uri >=4.1.2`), resolving all `hono`/`fast-uri` advisories. `pnpm audit --prod` dropped from 31 to 25 findings; the remaining 25 are unchanged — all still in the non-runtime `node-gyp` build-tool chain identified during the audit, no action needed.
6. **GitHub Actions hardening (Low → fixed)** — all `uses:` steps in both workflows pinned to their current commit SHA (resolved live against each tag via the GitHub API, not guessed) with a version comment; `inference-boundary-check.yml` gained an explicit `permissions: {contents: read}` block matching `docker-publish.yml`'s existing least-privilege pattern.
7. **Pre-commit secret scan + Dependabot (Low → fixed)** — `.git/hooks/pre-commit` created (grep-fallback, `gitleaks` not installed on this machine) and `.github/dependabot.yml` created covering `npm`, `github-actions`, and `docker` ecosystems weekly.
8. **`security.txt` — deliberately skipped.** Requires a public contact (email/URL) to publish in a world-readable file; this is a private, single-admin tool with no public bug-bounty posture, and guessing a contact wasn't appropriate. Ask DestCom directly if this is ever wanted.

**Not applied — needs your decision (#2, High, Docker root user):** left untouched. Verifying whether the container can drop to a non-root `USER` without breaking `bluetoothctl`/D-Bus access requires testing against the real production server's BlueZ setup, not something safe to guess and ship blind. Still open — see "Next Steps" above, item 2.

**Score after this pass: ~89/100 🟡** (up from 84/100) — the Docker root-user item is the main thing standing between this and the 🟢 tier (90+).

