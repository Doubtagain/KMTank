-- KMTank schema. Safe to run repeatedly.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  google_sub  TEXT NOT NULL UNIQUE,
  email       TEXT,
  name        TEXT NOT NULL,
  avatar_url  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One rating row per user per season, so a season reset is a config change.
CREATE TABLE IF NOT EXISTS ratings (
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  season      INTEGER NOT NULL,
  mmr         INTEGER NOT NULL DEFAULT 1000,
  peak_mmr    INTEGER NOT NULL DEFAULT 1000,
  matches     INTEGER NOT NULL DEFAULT 0,
  wins        INTEGER NOT NULL DEFAULT 0,
  kills       INTEGER NOT NULL DEFAULT 0,
  deaths      INTEGER NOT NULL DEFAULT 0,
  high_score  INTEGER NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, season)
);

CREATE INDEX IF NOT EXISTS ratings_season_mmr_idx ON ratings (season, mmr DESC, matches DESC);

CREATE TABLE IF NOT EXISTS matches (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  season       INTEGER NOT NULL,
  mode         TEXT NOT NULL,
  player_count INTEGER NOT NULL,
  duration_s   INTEGER NOT NULL DEFAULT 0,
  ended_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS match_players (
  match_id   UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  placement  INTEGER NOT NULL,
  score      INTEGER NOT NULL,
  kills      INTEGER NOT NULL,
  deaths     INTEGER NOT NULL,
  mmr_before INTEGER NOT NULL,
  mmr_after  INTEGER NOT NULL,
  PRIMARY KEY (match_id, user_id)
);

CREATE INDEX IF NOT EXISTS match_players_user_idx ON match_players (user_id);
