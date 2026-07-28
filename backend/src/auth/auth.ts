import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { admin } from 'better-auth/plugins';
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
  plugins: [admin()],
});
