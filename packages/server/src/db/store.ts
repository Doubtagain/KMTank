import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';
import { PLACEMENT_MATCHES, STARTING_MMR, rankFor, type LeaderboardRow, type UserProfile } from '@kmtank/shared';

import { config } from '../config.js';

export interface UserRecord {
  id: string;
  googleSub: string;
  email: string | null;
  name: string;
  avatarUrl: string | null;
  mmr: number;
  peakMmr: number;
  matches: number;
  wins: number;
  kills: number;
  deaths: number;
  highScore: number;
}

export interface GoogleProfile {
  sub: string;
  email: string | null;
  name: string;
  picture: string | null;
}

/** One player's outcome in a finished ranked match. */
export interface MatchPlayerResult {
  userId: string;
  placement: number;
  score: number;
  kills: number;
  deaths: number;
  mmrBefore: number;
  mmrAfter: number;
}

export interface Store {
  init(): Promise<void>;
  close(): Promise<void>;
  upsertGoogleUser(profile: GoogleProfile): Promise<UserRecord>;
  getUser(id: string): Promise<UserRecord | null>;
  recordMatch(
    mode: string,
    durationSeconds: number,
    results: MatchPlayerResult[],
  ): Promise<void>;
  leaderboard(limit: number, offset: number): Promise<LeaderboardRow[]>;
  /** True when ranked progress actually survives a restart. */
  readonly durable: boolean;
}

export function toProfile(user: UserRecord): UserProfile {
  const rank = rankFor(user.mmr, user.matches);
  return {
    id: user.id,
    name: user.name,
    avatarUrl: user.avatarUrl,
    mmr: user.mmr,
    peakMmr: user.peakMmr,
    rankedMatches: user.matches,
    wins: user.wins,
    kills: user.kills,
    deaths: user.deaths,
    highScore: user.highScore,
    rankLabel: rank.label,
    placed: rank.placed,
  };
}

// ---------------------------------------------------------------------------
// In-memory store (local development, and a safe fallback in production)
// ---------------------------------------------------------------------------

export class MemoryStore implements Store {
  readonly durable = false;
  constructor(private readonly reason = 'DATABASE_URL is not set') {}
  private readonly users = new Map<string, UserRecord>();
  private readonly bySub = new Map<string, string>();

  async init(): Promise<void> {
    console.warn(`[db] ${this.reason} - using an in-memory store. Ranks reset on restart.`);
  }

  async close(): Promise<void> {
    this.users.clear();
    this.bySub.clear();
  }

  async upsertGoogleUser(profile: GoogleProfile): Promise<UserRecord> {
    const existingId = this.bySub.get(profile.sub);
    if (existingId) {
      const user = this.users.get(existingId)!;
      user.name = profile.name;
      user.email = profile.email;
      user.avatarUrl = profile.picture;
      return user;
    }
    const user: UserRecord = {
      id: randomUUID(),
      googleSub: profile.sub,
      email: profile.email,
      name: profile.name,
      avatarUrl: profile.picture,
      mmr: STARTING_MMR,
      peakMmr: STARTING_MMR,
      matches: 0,
      wins: 0,
      kills: 0,
      deaths: 0,
      highScore: 0,
    };
    this.users.set(user.id, user);
    this.bySub.set(profile.sub, user.id);
    return user;
  }

  async getUser(id: string): Promise<UserRecord | null> {
    return this.users.get(id) ?? null;
  }

  async recordMatch(_mode: string, _duration: number, results: MatchPlayerResult[]): Promise<void> {
    for (const row of results) {
      const user = this.users.get(row.userId);
      if (!user) continue;
      user.mmr = row.mmrAfter;
      user.peakMmr = Math.max(user.peakMmr, row.mmrAfter);
      user.matches += 1;
      if (row.placement === 1) user.wins += 1;
      user.kills += row.kills;
      user.deaths += row.deaths;
      user.highScore = Math.max(user.highScore, row.score);
    }
  }

  async leaderboard(limit: number, offset: number): Promise<LeaderboardRow[]> {
    return [...this.users.values()]
      .filter((u) => u.matches >= PLACEMENT_MATCHES)
      .sort((a, b) => b.mmr - a.mmr || b.matches - a.matches)
      .slice(offset, offset + limit)
      .map((user, index) => ({
        rank: offset + index + 1,
        userId: user.id,
        name: user.name,
        avatarUrl: user.avatarUrl,
        mmr: user.mmr,
        rankLabel: rankFor(user.mmr, user.matches).label,
        wins: user.wins,
        rankedMatches: user.matches,
      }));
  }
}

// ---------------------------------------------------------------------------
// Postgres store
// ---------------------------------------------------------------------------

const SELECT_USER = `
  SELECT u.id, u.google_sub, u.email, u.name, u.avatar_url,
         COALESCE(r.mmr, $2)      AS mmr,
         COALESCE(r.peak_mmr, $2) AS peak_mmr,
         COALESCE(r.matches, 0)   AS matches,
         COALESCE(r.wins, 0)      AS wins,
         COALESCE(r.kills, 0)     AS kills,
         COALESCE(r.deaths, 0)    AS deaths,
         COALESCE(r.high_score,0) AS high_score
    FROM kmtank.users u
    LEFT JOIN kmtank.ratings r ON r.user_id = u.id AND r.season = $3
   WHERE u.id = $1
`;

export class PostgresStore implements Store {
  readonly durable = true;
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({
      connectionString,
      max: 8,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
    });
    this.pool.on('error', (err) => console.error('[db] idle client error', err));
  }

  async init(): Promise<void> {
    const here = dirname(fileURLToPath(import.meta.url));
    const sql = await readFile(join(here, 'schema.sql'), 'utf8');
    await this.pool.query(sql);
    console.log('[db] schema ready');
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private rowToUser(row: Record<string, unknown>): UserRecord {
    return {
      id: String(row.id),
      googleSub: String(row.google_sub),
      email: (row.email as string | null) ?? null,
      name: String(row.name),
      avatarUrl: (row.avatar_url as string | null) ?? null,
      mmr: Number(row.mmr),
      peakMmr: Number(row.peak_mmr),
      matches: Number(row.matches),
      wins: Number(row.wins),
      kills: Number(row.kills),
      deaths: Number(row.deaths),
      highScore: Number(row.high_score),
    };
  }

  async upsertGoogleUser(profile: GoogleProfile): Promise<UserRecord> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const upserted = await client.query(
        `INSERT INTO kmtank.users (google_sub, email, name, avatar_url)
              VALUES ($1, $2, $3, $4)
         ON CONFLICT (google_sub) DO UPDATE
                SET name = EXCLUDED.name,
                    email = EXCLUDED.email,
                    avatar_url = EXCLUDED.avatar_url,
                    last_seen_at = now()
           RETURNING id`,
        [profile.sub, profile.email, profile.name, profile.picture],
      );
      const id = String(upserted.rows[0].id);
      await client.query(
        `INSERT INTO kmtank.ratings (user_id, season, mmr, peak_mmr)
              VALUES ($1, $2, $3, $3)
         ON CONFLICT (user_id, season) DO NOTHING`,
        [id, config.season, STARTING_MMR],
      );
      const result = await client.query(SELECT_USER, [id, STARTING_MMR, config.season]);
      await client.query('COMMIT');
      return this.rowToUser(result.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async getUser(id: string): Promise<UserRecord | null> {
    const result = await this.pool.query(SELECT_USER, [id, STARTING_MMR, config.season]);
    return result.rows.length ? this.rowToUser(result.rows[0]) : null;
  }

  async recordMatch(
    mode: string,
    durationSeconds: number,
    results: MatchPlayerResult[],
  ): Promise<void> {
    if (results.length === 0) return;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const match = await client.query(
        `INSERT INTO kmtank.matches (season, mode, player_count, duration_s)
              VALUES ($1, $2, $3, $4) RETURNING id`,
        [config.season, mode, results.length, Math.round(durationSeconds)],
      );
      const matchId = String(match.rows[0].id);

      for (const row of results) {
        await client.query(
          `INSERT INTO kmtank.match_players
                 (match_id, user_id, placement, score, kills, deaths, mmr_before, mmr_after)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (match_id, user_id) DO NOTHING`,
          [
            matchId,
            row.userId,
            row.placement,
            row.score,
            row.kills,
            row.deaths,
            row.mmrBefore,
            row.mmrAfter,
          ],
        );
        await client.query(
          `INSERT INTO kmtank.ratings (user_id, season, mmr, peak_mmr, matches, wins, kills, deaths, high_score)
                VALUES ($1, $2, $3, $3, 1, $4, $5, $6, $7)
           ON CONFLICT (user_id, season) DO UPDATE
                  SET mmr = EXCLUDED.mmr,
                      peak_mmr = GREATEST(ratings.peak_mmr, EXCLUDED.mmr),
                      matches = ratings.matches + 1,
                      wins = ratings.wins + EXCLUDED.wins,
                      kills = ratings.kills + EXCLUDED.kills,
                      deaths = ratings.deaths + EXCLUDED.deaths,
                      high_score = GREATEST(ratings.high_score, EXCLUDED.high_score),
                      updated_at = now()`,
          [
            row.userId,
            config.season,
            row.mmrAfter,
            row.placement === 1 ? 1 : 0,
            row.kills,
            row.deaths,
            row.score,
          ],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async leaderboard(limit: number, offset: number): Promise<LeaderboardRow[]> {
    const result = await this.pool.query(
      `SELECT u.id, u.name, u.avatar_url, r.mmr, r.wins, r.matches
         FROM kmtank.ratings r
         JOIN kmtank.users u ON u.id = r.user_id
        WHERE r.season = $1 AND r.matches >= $2
        ORDER BY r.mmr DESC, r.matches DESC
        LIMIT $3 OFFSET $4`,
      [config.season, PLACEMENT_MATCHES, limit, offset],
    );
    return result.rows.map((row, index) => ({
      rank: offset + index + 1,
      userId: String(row.id),
      name: String(row.name),
      avatarUrl: (row.avatar_url as string | null) ?? null,
      mmr: Number(row.mmr),
      rankLabel: rankFor(Number(row.mmr), Number(row.matches)).label,
      wins: Number(row.wins),
      rankedMatches: Number(row.matches),
    }));
  }
}

let store: Store | null = null;

export async function initStore(): Promise<Store> {
  if (store) return store;
  if (config.databaseUrl) {
    const pgStore = new PostgresStore(config.databaseUrl);
    try {
      await pgStore.init();
      store = pgStore;
      return store;
    } catch (error) {
      console.error('[db] Postgres unavailable, falling back to memory:', error);
      await pgStore.close().catch(() => {});
    }
  }
  const memory = new MemoryStore(
    config.databaseUrl ? 'Postgres connection failed (see error above)' : 'DATABASE_URL is not set',
  );
  await memory.init();
  store = memory;
  return store;
}

export function getStore(): Store {
  if (!store) throw new Error('store accessed before initStore()');
  return store;
}
