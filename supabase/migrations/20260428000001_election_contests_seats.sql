-- Add seats column to election_contests
-- Tracks how many winners a race has (default 1; multi-seat races set this > 1)
ALTER TABLE election_contests
  ADD COLUMN IF NOT EXISTS seats INT NOT NULL DEFAULT 1;
