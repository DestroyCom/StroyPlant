import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Backend Fastify (Lot 1/2) écoute sur BACKEND_PORT (défaut 3000, voir backend/.env.example) —
// proxy nécessaire en dev pour que /api et /ws partagent la même origine que le frontend Vite,
// sinon les cookies de session BetterAuth (SameSite) ne suivent pas les requêtes cross-origin.
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
      '/api': { target: backendUrl, changeOrigin: true },
      '/ws': { target: backendUrl, ws: true, changeOrigin: true },
    },
  },
});
