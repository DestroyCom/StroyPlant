import * as Sentry from '@sentry/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { initSentry } from './instrument';
import { queryClient } from './lib/query-client';
import { createAppRouter } from './router';

await initSentry();

const router = createAppRouter(queryClient);

// biome-ignore lint/style/noNonNullAssertion: #root is guaranteed present by index.html
createRoot(document.getElementById('root')!, {
  onUncaughtError: Sentry.reactErrorHandler(),
  onCaughtError: Sentry.reactErrorHandler(),
  onRecoverableError: Sentry.reactErrorHandler(),
}).render(
  <StrictMode>
    <Sentry.ErrorBoundary fallback={<ErrorFallback />}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </Sentry.ErrorBoundary>
  </StrictMode>,
);

function ErrorFallback() {
  return (
    <div className="flex h-svh flex-col items-center justify-center gap-4 p-6 text-center">
      <p className="text-lg font-medium">Une erreur inattendue est survenue.</p>
      <button type="button" className="underline" onClick={() => window.location.reload()}>
        Recharger la page
      </button>
    </div>
  );
}
