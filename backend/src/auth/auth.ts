import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { admin, mcp } from 'better-auth/plugins';
import { prisma } from '../db/client.js';
import { env } from '../env.js';

// Single-admin personal use (docs/STROYPLANT_SPEC.md section 7.6): no public self sign-up.
// The `admin` plugin isn't here for multi-user role management — it just gives
// access to `auth.api.createUser()`, the only method documented by BetterAuth to create an account
// programmatically without going through the public sign-up endpoint (which respects disableSignUp).
// See scripts/seed-admin.ts.
//
// Designed for a future addition of BetterAuth's native OIDC plugin (genericOAuth / SSO provider)
// without rewriting: the config below has nothing credentials-specific that would prevent adding
// an OIDC provider (Authentik) later in `plugins`, with a new Prisma migration for the
// additional tables it introduces.
export const auth = betterAuth({
  baseURL: env.betterAuthUrl,
  secret: env.betterAuthSecret,
  database: prismaAdapter(prisma, { provider: 'sqlite' }),
  emailAndPassword: {
    enabled: true,
    disableSignUp: true,
  },
  // In prod (docs/STROYPLANT_SPEC.md section 14) a single process serves front+back on the same
  // origin, so trustedOrigins doesn't need anything else. In dev, the Vite frontend runs on a
  // separate port (5173): the browser sends that Origin even through the Vite proxy (which only
  // rewrites Host, not Origin), and BetterAuth would otherwise reject it ("Invalid origin").
  // Kept conditional on NODE_ENV=production — still to be set explicitly when the prod
  // Dockerfile is written (nothing sets it today, so env.nodeEnv stays 'development' everywhere).
  trustedOrigins: env.nodeEnv === 'production' ? [] : ['http://localhost:5173'],
  // Production sits behind a reverse proxy for TLS termination (docs/STROYPLANT_SPEC.md section 14
  // says front+back share one origin — true, but that origin is still reached through the proxy,
  // not directly). Without this, better-auth can't resolve a real client IP from the raw socket
  // (it sees the proxy's own address) and falls back to a single shared rate-limit bucket for
  // everyone — observed in production logs, 2026-07-29. The proxy already sends X-Forwarded-For;
  // trustedProxies is scoped to RFC1918 ranges (Docker bridge networks + the LAN) rather than the
  // proxy's specific container IP, which changes on every network recreate.
  advanced: {
    ipAddress: {
      ipAddressHeaders: ['x-forwarded-for'],
      trustedProxies: ['127.0.0.1', '::1', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'],
    },
  },
  plugins: [
    admin(),
    // MCP server (Batch 8, docs/STROYPLANT_SPEC.md section 7.8) — OAuth 2.1 authorization for MCP
    // clients (Claude Desktop/Code, remote connectors), confirmed with DestCom over a simpler
    // static API-key mechanism since this ships in the already-installed `better-auth` package (no
    // new dependency) and is the protocol-correct mechanism real MCP clients expect. Reuses the
    // existing /login page — no separate frontend work: an unauthenticated `/mcp/authorize` redirects
    // there, and BetterAuth's own after-hook resumes the OAuth flow once the user signs in normally.
    // No `consentPage` set — BetterAuth serves its own built-in consent HTML, sufficient for this
    // single-admin, personal-use deployment.
    mcp({
      loginPage: '/login',
      oidcConfig: {
        loginPage: '/login',
        // Real MCP clients self-register via RFC 7591 (Dynamic Client Registration) — there's no
        // UI in this project to pre-provision an OAuth client by hand.
        allowDynamicClientRegistration: true,
      },
    }),
  ],
});
