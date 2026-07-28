import { createAuthClient } from 'better-auth/react';

// baseURL omis volontairement : le client et le serveur BetterAuth sont sur la même origine
// (proxy Vite en dev vers le backend, même conteneur en prod — docs/STROYPLANT_SPEC.md section 14),
// ce qui résout par défaut sur "/api/auth".
export const authClient = createAuthClient();
