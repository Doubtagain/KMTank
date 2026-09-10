import { defineConfig } from 'vite';

/**
 * `VITE_SERVER_URL` points the client at the game server. In development it
 * defaults to the local server; in production set it on the hosting provider
 * (Cloudflare Pages / Vercel) to the deployed backend origin.
 */
export default defineConfig({
  server: {
    port: 5173,
    strictPort: false,
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
    chunkSizeWarningLimit: 900,
  },
});
