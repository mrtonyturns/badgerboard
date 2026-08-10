-- Migration: poll_snapshots — beta-only AI polling snapshots (v1.22)
-- One row per district (latest snapshot upserted in place; district is unique).
-- RLS enabled with NO client policies: ALL access goes through the
-- polling-snapshot function, which enforces the beta flag server-side.

CREATE TABLE IF NOT EXISTS poll_snapshots (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district      text NOT NULL UNIQUE,          -- e.g. 'congress-3', 'senate-17', 'assembly-85', 'state-wi'
  district_name text,
  generated_at  timestamptz NOT NULL DEFAULT now(),
  top_issues    jsonb NOT NULL DEFAULT '[]',   -- [{rank, issue, why}]
  approval      jsonb,                          -- {subject, approval_pct, disapproval_pct}
  vote_share    jsonb NOT NULL DEFAULT '[]',   -- [{candidate, party, pct}]
  confidence    jsonb,                          -- {margin_pts, band, note}
  sources       jsonb NOT NULL DEFAULT '[]',   -- [{title, url}]
  model_used    text,
  disclaimer    text NOT NULL DEFAULT 'AI-Estimated. Not a scientific poll.',
  status        text NOT NULL DEFAULT 'ready', -- ready | generating | error
  error_note    text,
  requested_by  uuid
);

CREATE INDEX IF NOT EXISTS idx_poll_snapshots_generated ON poll_snapshots (generated_at);

ALTER TABLE poll_snapshots ENABLE ROW LEVEL SECURITY;
-- No policies on purpose — service role only.

NOTIFY pgrst, 'reload schema';
