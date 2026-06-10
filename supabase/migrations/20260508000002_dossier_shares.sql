-- ─────────────────────────────────────────────────────────────────────────────
-- Dossier Shares Migration
-- Creates the dossier_shares table for temporary shareable dossier links.
-- Agency-tier users can generate time-limited public links to dossiers.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS dossier_shares (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  token        text        UNIQUE NOT NULL,
  dossier_id   uuid        NOT NULL REFERENCES dossiers(id) ON DELETE CASCADE,
  created_by   uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  expires_at   timestamptz NOT NULL,
  view_count   integer     NOT NULL DEFAULT 0,
  is_active    boolean     NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS dossier_shares_token_idx      ON dossier_shares(token);
CREATE INDEX IF NOT EXISTS dossier_shares_dossier_idx    ON dossier_shares(dossier_id);
CREATE INDEX IF NOT EXISTS dossier_shares_created_by_idx ON dossier_shares(created_by);

ALTER TABLE dossier_shares ENABLE ROW LEVEL SECURITY;

-- Authenticated users can see only their own shares
DROP POLICY IF EXISTS "Users see own shares"   ON dossier_shares;
CREATE POLICY "Users see own shares"
  ON dossier_shares FOR SELECT
  USING (auth.uid() = created_by);

-- Authenticated users can insert shares they own
DROP POLICY IF EXISTS "Users create own shares" ON dossier_shares;
CREATE POLICY "Users create own shares"
  ON dossier_shares FOR INSERT
  WITH CHECK (auth.uid() = created_by);

-- Authenticated users can update (deactivate) their own shares
DROP POLICY IF EXISTS "Users update own shares" ON dossier_shares;
CREATE POLICY "Users update own shares"
  ON dossier_shares FOR UPDATE
  USING (auth.uid() = created_by);
