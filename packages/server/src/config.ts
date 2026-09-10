import 'dotenv/config';

import { RANKED_MATCH_SECONDS, RANKED_QUEUE_GRACE } from '@kmtank/shared';

const required = (name: string, fallback?: string): string => {
  const value = process.env[name] ?? fallback;
  if (value === undefined) throw new Error(`Missing required environment variable ${name}`);
  return value;
};

const bool = (name: string, fallback: boolean): boolean => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
};

const int = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const config = {
  port: int('PORT', 8080),
  host: process.env.HOST ?? '0.0.0.0',
  nodeEnv: process.env.NODE_ENV ?? 'development',
  get isProduction(): boolean {
    return this.nodeEnv === 'production';
  },

  /** Comma-separated list of allowed browser origins, or `*` in development. */
  corsOrigins: (process.env.CORS_ORIGINS ?? '*')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  /** Postgres connection string. When empty, an in-memory store is used. */
  databaseUrl: process.env.DATABASE_URL ?? '',
  databaseSsl: bool('DATABASE_SSL', true),

  /** OAuth client id issued by Google Cloud Console. */
  googleClientId: process.env.GOOGLE_CLIENT_ID ?? '',

  /** Secret used to sign KMTank session JWTs. */
  jwtSecret: required('JWT_SECRET', 'dev-only-insecure-secret-change-me'),
  jwtTtlSeconds: int('JWT_TTL_SECONDS', 60 * 60 * 24 * 30),

  /** Fill casual rooms with AI tanks so the arena is never empty. */
  botsEnabled: bool('BOTS_ENABLED', true),
  botTarget: int('BOT_TARGET', 8),

  /** Ranked match length in seconds. Overrides the shared default. */
  rankedMatchSeconds: int('RANKED_MATCH_SECONDS', RANKED_MATCH_SECONDS),

  /** Seconds a partly-filled ranked lobby waits before starting anyway. */
  rankedQueueGrace: int('RANKED_QUEUE_GRACE', RANKED_QUEUE_GRACE),

  /** Current ladder season. Bump to reset the leaderboard. */
  season: int('SEASON', 1),

  /**
   * Enables `POST /api/auth/dev`, which mints a session for an arbitrary name
   * without Google. It exists so ranked can be exercised locally and in tests;
   * it is refused outright when NODE_ENV is production.
   */
  allowDevLogin: bool('ALLOW_DEV_LOGIN', false),
} as const;

if (config.isProduction && config.jwtSecret === 'dev-only-insecure-secret-change-me') {
  // Running with a public secret would let anyone forge a session for any
  // account. Refusing to start is the only safe behaviour.
  throw new Error(
    '[config] JWT_SECRET is not set. Set it to a long random string before running in production.',
  );
}
