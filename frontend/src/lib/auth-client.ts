import { createAuthClient } from 'better-auth/react';

// baseURL deliberately omitted: the BetterAuth client and server are on the same origin
// (Vite proxy to the backend in dev, same container in prod — docs/STROYPLANT_SPEC.md section 14),
// which resolves by default to "/api/auth".
export const authClient = createAuthClient();
