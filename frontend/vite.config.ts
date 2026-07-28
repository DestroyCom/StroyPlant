import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The Fastify backend (Batch 1/2) listens on BACKEND_PORT (default 3000, see backend/.env.example) —
// a dev proxy is needed so /api shares the same origin as the Vite frontend, otherwise BetterAuth's
// session cookies (SameSite) don't follow cross-origin requests. `ws: true` also forwards the WS
// upgrade for the readings.onReading tRPC subscription, which shares the /api/trpc prefix with the
// regular HTTP calls (fastifyTRPCPlugin's useWSS option, see backend/src/api/server.ts) — there is
// no separate /ws endpoint anymore.
const backendPort = process.env.BACKEND_PORT ?? '3000';
const backendUrl = `http://localhost:${backendPort}`;

// https://vite.dev/config/
export default defineConfig({
  plugins: [tanstackRouter({ target: 'react', autoCodeSplitting: true }), react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    proxy: {
      '/api': { target: backendUrl, changeOrigin: true, ws: true },
    },
  },
});
