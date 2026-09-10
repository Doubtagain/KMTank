import type { AuthResponse, LeaderboardRow, TierDef, UserProfile } from '@kmtank/shared';

import { SERVER_URL, STORAGE_KEYS } from '../config.js';

export interface ServerConfig {
  googleClientId: string | null;
  googleEnabled: boolean;
  season: number;
  durableRanks: boolean;
  placementMatches: number;
  tiers: TierDef[];
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${SERVER_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  const body = text ? (JSON.parse(text) as unknown) : {};
  if (!response.ok) {
    const message =
      typeof body === 'object' && body !== null && 'error' in body
        ? String((body as { error: unknown }).error)
        : `Request failed (${response.status})`;
    throw new Error(message);
  }
  return body as T;
}

export const api = {
  config: () => request<ServerConfig>('/api/config'),

  loginWithGoogle: (credential: string) =>
    request<AuthResponse>('/api/auth/google', {
      method: 'POST',
      body: JSON.stringify({ credential }),
    }),

  me: (token: string) =>
    request<UserProfile>('/api/me', { headers: { Authorization: `Bearer ${token}` } }),

  leaderboard: (limit = 25) =>
    request<{ season: number; rows: LeaderboardRow[] }>(`/api/leaderboard?limit=${limit}`),
};

export const session = {
  get token(): string | null {
    try {
      return localStorage.getItem(STORAGE_KEYS.token);
    } catch {
      return null;
    }
  },
  set token(value: string | null) {
    try {
      if (value === null) localStorage.removeItem(STORAGE_KEYS.token);
      else localStorage.setItem(STORAGE_KEYS.token, value);
    } catch {
      // Private browsing with storage disabled: the session simply will not persist.
    }
  },
  get name(): string {
    try {
      return localStorage.getItem(STORAGE_KEYS.name) ?? '';
    } catch {
      return '';
    }
  },
  set name(value: string) {
    try {
      localStorage.setItem(STORAGE_KEYS.name, value);
    } catch {
      // Ignore.
    }
  },
};
