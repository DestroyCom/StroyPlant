import { QueryClient } from '@tanstack/react-query';

// Single instance shared by the router context (router.tsx) and the tRPC options proxy (trpc.ts) —
// split out from main.tsx to avoid a circular import between the two.
export const queryClient = new QueryClient();
