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
      }),
    }),
  ],
});

export const trpc = createTRPCOptionsProxy<AppRouter>({ client: trpcClient, queryClient });
