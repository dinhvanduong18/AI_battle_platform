CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  elo INTEGER NOT NULL DEFAULT 1200 CHECK (elo BETWEEN 100 AND 10000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS matches (
  id UUID PRIMARY KEY,
  seed INTEGER NOT NULL,
  player1_id UUID NOT NULL REFERENCES users(id),
  player2_id UUID NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'completed', 'disputed', 'abandoned')),
  player1_key JSONB,
  player2_key JSONB,
  winner_id UUID REFERENCES users(id),
  final_state_hash CHAR(64),
  replay_key TEXT,
  replay_sha256 CHAR(64),
  replay_json JSONB,
  player1_proof JSONB,
  player2_proof JSONB,
  disconnected_player_id UUID REFERENCES users(id),
  disconnected_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  CHECK (player1_id <> player2_id)
);

CREATE TABLE IF NOT EXISTS match_results (
  match_id UUID PRIMARY KEY REFERENCES matches(id),
  player1_elo_before INTEGER NOT NULL,
  player2_elo_before INTEGER NOT NULL,
  player1_elo_after INTEGER NOT NULL,
  player2_elo_after INTEGER NOT NULL,
  result_player1 NUMERIC(3,2) NOT NULL CHECK (result_player1 IN (0, 0.5, 1)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS matches_player1_created_idx ON matches(player1_id, created_at DESC);
CREATE INDEX IF NOT EXISTS matches_player2_created_idx ON matches(player2_id, created_at DESC);

CREATE TABLE IF NOT EXISTS disconnect_claims (
  id BIGSERIAL PRIMARY KEY,
  match_id UUID NOT NULL REFERENCES matches(id),
  claimant_id UUID NOT NULL REFERENCES users(id),
  disconnected_id UUID NOT NULL REFERENCES users(id),
  proof JSONB NOT NULL,
  signature TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'needs-review' CHECK (status IN ('needs-review', 'accepted', 'rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(match_id, claimant_id)
);
