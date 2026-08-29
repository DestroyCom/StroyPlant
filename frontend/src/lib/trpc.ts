import type { AppRouter } from '@stroyplant/backend/api/trpc/router';
import { createTRPCClient, createWSClient, httpBatchLink, splitLink, wsLink } from '@trpc/client';
import { createTRPCOptionsProxy } from '@trpc/tanstack-react-query';
import { queryClient } from './query-client';

const wsClient = createWSClient({
  url: () => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}/api/trpc`;
  },
});

const trpcClient = createTRPCClient<AppRouter>({
  links: [
    splitLink({
      condition: (op) => op.type === 'subscription',
      true: wsLink({ client: wsClient }),
      false: httpBatchLink({
        url: '/api/trpc',
        // Session cookie (BetterAuth) must ride along, same as the previous apiFetch() wrapper.
        fetch: (url, opts) => fetch(url, { ...opts, credentials: 'include' }),
        // Without this, batched GET queries encode every input in the URL query string — harmless
        // with a couple of calls, but a page that fires many health.deviceHealth queries at once
        // (e.g. the notification bell mounted app-wide, on top of whatever the current route
        // already queries) can build a URL long enough to hit a 414 URI Too Long (found 2026-08-29
        // on the device detail page: bell's 8 deviceHealth calls + the page's own 6 queries,
        // batched into one GET, exceeded it). POST has no equivalent practical limit — the tRPC
        // Fastify adapter already accepts POST for queries with no server-side change needed
        // (that's the whole point of this option, see @trpc/client's httpUtils.ts).
        methodOverride: 'POST',
      }),
    }),
  ],
});

export const trpc = createTRPCOptionsProxy<AppRouter>({ client: trpcClient, queryClient });
