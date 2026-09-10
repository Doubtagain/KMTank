/**
 * Where the game server lives.
 *
 * Set `VITE_SERVER_URL` at build time on the static host (Cloudflare Pages,
 * Vercel, ...). Without it the client talks to a local dev server, or to its
 * own origin when the static bundle is served by the game server itself.
 */
function resolveServerUrl(): string {
  const configured = import.meta.env.VITE_SERVER_URL as string | undefined;
  if (configured && configured.length > 0) return configured.replace(/\/+$/, '');
  if (import.meta.env.DEV) return 'http://localhost:8080';
  return window.location.origin.replace(/\/+$/, '');
}

export const SERVER_URL = resolveServerUrl();

export const WS_URL = `${SERVER_URL.replace(/^http/, 'ws')}/ws`;

export const STORAGE_KEYS = {
  token: 'kmtank.token',
  name: 'kmtank.name',
} as const;
