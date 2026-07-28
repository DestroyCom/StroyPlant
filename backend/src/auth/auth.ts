import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { admin } from 'better-auth/plugins';
import { prisma } from '../db/client.js';
import { env } from '../env.js';

// Usage perso mono-admin (docs/STROYPLANT_SPEC.md section 7.6) : pas d'auto-inscription publique.
// Le plugin `admin` n'est pas là pour de la gestion de rôles multi-utilisateurs — il donne juste
// accès à `auth.api.createUser()`, le seul moyen documenté par BetterAuth de créer un compte de
// façon programmatique sans passer par l'endpoint public de sign-up (qui respecte disableSignUp).
// Voir scripts/seed-admin.ts.
//
// Conçu pour un ajout futur du plugin OIDC natif de BetterAuth (genericOAuth / SSO provider) sans
// réécriture : la config ci-dessous n'a rien de spécifique aux credentials qui empêcherait d'ajouter
// un provider OIDC (Authentik) plus tard dans `plugins`, avec une nouvelle migration Prisma pour les
// tables additionnelles qu'il introduit.
export const auth = betterAuth({
  baseURL: env.betterAuthUrl,
  secret: env.betterAuthSecret,
  database: prismaAdapter(prisma, { provider: 'sqlite' }),
  emailAndPassword: {
    enabled: true,
    disableSignUp: true,
  },
  // En prod (docs/STROYPLANT_SPEC.md section 14) un seul process sert front+back sur la même
  // origine, donc trustedOrigins n'a besoin de rien d'autre. En dev, le frontend Vite tourne sur un
  // port distinct (5173) : le navigateur envoie cet Origin même via le proxy Vite (qui ne réécrit
  // que le Host, pas l'Origin), et BetterAuth le rejetterait sinon ("Invalid origin").
  trustedOrigins: ['http://localhost:5173'],
  plugins: [admin()],
});
