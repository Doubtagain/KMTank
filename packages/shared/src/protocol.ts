/**
 * Wire protocol.
 *
 * WebSocket *text* frames carry JSON control messages (join, upgrades, match
 * lifecycle, leaderboards). WebSocket *binary* frames carry the hot path:
 * input frames up, world snapshots down. See `codec.ts` for the binary layout.
 */

import type { StatVector } from './stats.js';

export type GameMode = 'casual' | 'ranked';

export const BINARY_INPUT = 0x01;
export const BINARY_SNAPSHOT = 0x81;

/** Movement key bits inside an input frame. */
export const MOVE_UP = 1 << 0;
export const MOVE_DOWN = 1 << 1;
export const MOVE_LEFT = 1 << 2;
export const MOVE_RIGHT = 1 << 3;

/** Action bits inside an input frame. */
export const ACT_FIRE = 1 << 0;
export const ACT_AUTOFIRE = 1 << 1;
export const ACT_AUTOSPIN = 1 << 2;

export interface InputFrame {
  seq: number;
  move: number;
  actions: number;
  /** Aim direction in radians. */
  aim: number;
}

// ---------------------------------------------------------------------------
// Client -> server (JSON)
// ---------------------------------------------------------------------------

export interface C2SJoin {
  t: 'join';
  mode: GameMode;
  /** Display name used for guests. Ignored when a token is supplied. */
  name?: string;
  /** KMTank session JWT from `POST /api/auth/google`. Required for ranked. */
  token?: string;
}

export interface C2SUpgradeStat {
  t: 'upgradeStat';
  /** Index into `STAT_IDS`. */
  stat: number;
}

export interface C2SUpgradeClass {
  t: 'upgradeClass';
  classKey: string;
}

export interface C2SRespawn {
  t: 'respawn';
}

export interface C2SLeave {
  t: 'leave';
}

export interface C2SPing {
  t: 'ping';
  /** Client clock, echoed back untouched. */
  at: number;
}

export type ClientMessage =
  | C2SJoin
  | C2SUpgradeStat
  | C2SUpgradeClass
  | C2SRespawn
  | C2SLeave
  | C2SPing;

// ---------------------------------------------------------------------------
// Server -> client (JSON)
// ---------------------------------------------------------------------------

export interface PlayerInfo {
  id: number;
  name: string;
  /** Null for guests. */
  userId: string | null;
  classKey: string;
  level: number;
  score: number;
  colorIndex: number;
  mmr: number | null;
  rankLabel: string | null;
  bot: boolean;
}

export interface S2CWelcome {
  t: 'welcome';
  /** This connection's entity id. */
  playerId: number;
  mode: GameMode;
  roomId: string;
  tickRate: number;
  worldSize: number;
  /** Server clock at the time of sending, for latency estimation. */
  serverTime: number;
  you: PlayerInfo;
}

export interface S2CRoster {
  t: 'roster';
  /** Full replacement of the client's player table. */
  players: PlayerInfo[];
}

export interface S2CLeaderboard {
  t: 'leaderboard';
  entries: { id: number; name: string; score: number; classKey: string }[];
}

export interface S2CKilled {
  t: 'killed';
  killerName: string;
  killerId: number;
  score: number;
  level: number;
  survivedSeconds: number;
  canRespawn: boolean;
  respawnInSeconds: number;
}

export interface S2CKillFeed {
  t: 'kill';
  killerName: string;
  victimName: string;
}

export interface S2CStats {
  t: 'stats';
  stats: StatVector;
  statPoints: number;
  classKey: string;
  /** Class keys currently offered as an upgrade. */
  upgrades: string[];
}

export interface S2CQueue {
  t: 'queue';
  mode: GameMode;
  position: number;
  size: number;
  needed: number;
  /** Seconds until the lobby starts regardless of size, or null while waiting. */
  startsIn: number | null;
}

export interface S2CMatchState {
  t: 'match';
  phase: 'countdown' | 'live' | 'ended';
  /** Seconds remaining in the current phase. */
  secondsLeft: number;
  /** Wall-clock seconds of match time elapsed. */
  elapsed: number;
}

export interface MatchResultRow {
  placement: number;
  name: string;
  userId: string | null;
  score: number;
  kills: number;
  mmrBefore: number | null;
  mmrAfter: number | null;
  mmrDelta: number | null;
  rankLabel: string | null;
  you: boolean;
}

export interface S2CMatchResult {
  t: 'result';
  mode: GameMode;
  rows: MatchResultRow[];
}

export interface S2CPong {
  t: 'pong';
  at: number;
  serverTime: number;
}

export interface S2CError {
  t: 'error';
  code:
    | 'auth_required'
    | 'invalid_token'
    | 'bad_request'
    | 'room_full'
    | 'rate_limited'
    | 'server_error';
  message: string;
}

export type ServerMessage =
  | S2CWelcome
  | S2CRoster
  | S2CLeaderboard
  | S2CKilled
  | S2CKillFeed
  | S2CStats
  | S2CQueue
  | S2CMatchState
  | S2CMatchResult
  | S2CPong
  | S2CError;

// ---------------------------------------------------------------------------
// REST payloads
// ---------------------------------------------------------------------------

export interface AuthResponse {
  token: string;
  user: UserProfile;
}

export interface UserProfile {
  id: string;
  name: string;
  avatarUrl: string | null;
  mmr: number;
  peakMmr: number;
  rankedMatches: number;
  wins: number;
  kills: number;
  deaths: number;
  highScore: number;
  rankLabel: string;
  placed: boolean;
}

export interface LeaderboardRow {
  rank: number;
  userId: string;
  name: string;
  avatarUrl: string | null;
  mmr: number;
  rankLabel: string;
  wins: number;
  rankedMatches: number;
}
