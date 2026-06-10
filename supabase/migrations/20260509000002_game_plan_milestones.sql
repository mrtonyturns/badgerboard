-- Migration: Game Plan Milestones
-- Adds a per-user milestone tracker for campaign planning.
-- Milestones are grouped by phase and track status with due dates.
--
-- Safe to run multiple times (IF NOT EXISTS guards throughout).

-- ─── 1. game_plan_milestones table ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS game_plan_milestones (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by   UUID        REFERENCES auth.users(id) ON DELETE CASCADE,
  candidate_id UUID        REFERENCES candidates(id) ON DELETE CASCADE,
  election_id  UUID        REFERENCES elections(id)  ON DELETE SET NULL,

  -- Content
  title        TEXT        NOT NULL,
  notes        TEXT,

  -- Categorization
  -- phase:    planning | filing | voter_contact | fundraising | gotv | election_day
  -- category: recruitment | legal | outreach | finance | media | admin | general
  phase        TEXT        NOT NULL DEFAULT 'planning',
  category     TEXT        NOT NULL DEFAULT 'general',

  -- Timeline
  due_date     DATE,

  -- status: upcoming | in_progress | complete | overdue | skipped
  status       TEXT        NOT NULL DEFAULT 'upcoming',

  -- Template flag — milestones generated from the template generator
  is_template  BOOLEAN     NOT NULL DEFAULT false,

  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── 2. RLS ──────────────────────────────────────────────────────────────────
ALTER TABLE game_plan_milestones ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'game_plan_milestones' AND policyname = 'Users manage own milestones'
  ) THEN
    CREATE POLICY "Users manage own milestones"
      ON game_plan_milestones
      FOR ALL
      USING  (created_by = auth.uid())
      WITH CHECK (created_by = auth.uid());
  END IF;
END $$;

-- ─── 3. Indexes ───────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_game_plan_milestones_created_by
  ON game_plan_milestones (created_by);

CREATE INDEX IF NOT EXISTS idx_game_plan_milestones_candidate_id
  ON game_plan_milestones (candidate_id);

CREATE INDEX IF NOT EXISTS idx_game_plan_milestones_due_date
  ON game_plan_milestones (due_date);

-- ─── 4. updated_at trigger ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_game_plan_milestones_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_game_plan_milestones_updated_at ON game_plan_milestones;
CREATE TRIGGER trg_game_plan_milestones_updated_at
  BEFORE UPDATE ON game_plan_milestones
  FOR EACH ROW EXECUTE FUNCTION update_game_plan_milestones_updated_at();

-- ─── 5. Comments ─────────────────────────────────────────────────────────────
COMMENT ON TABLE game_plan_milestones IS
  'Campaign planning milestones per user/candidate. Used by the Game Plan page.';
COMMENT ON COLUMN game_plan_milestones.phase IS
  'Campaign phase: planning | filing | voter_contact | fundraising | gotv | election_day';
COMMENT ON COLUMN game_plan_milestones.category IS
  'Milestone type: recruitment | legal | outreach | finance | media | admin | general';
COMMENT ON COLUMN game_plan_milestones.status IS
  'Milestone status: upcoming | in_progress | complete | overdue | skipped';
COMMENT ON COLUMN game_plan_milestones.is_template IS
  'True if this milestone was generated from the template generator.';
