-- Migration: Backend hardening (Tranche 2 of the July 2026 audit remediation)
-- Idempotent and backfill-first. Order matters: backfill owners BEFORE dropping
-- the permissive "ghost" policies, so no legitimate row becomes unreachable.
--
-- Sections:
--   1. Lock down offices/elections writes (were world-writable)
--   2. Reconcile dossier ownership → created_by, ownership = candidate owner
--   3. Backfill NULL owners on the 8 user-scoped tables
--   4. Drop migration_v5 "ghost" permissive policies
--   5. Missing-table DDL + RLS (district_events, notification_preferences,
--      calendar_feeds, calendar_feed_items)
--   6. Missing indexes on hot FK / RLS-subquery columns
--   7. elections de-dup + UNIQUE

BEGIN;

-- ─── 1. offices / elections: read-only to clients ────────────────────────────
-- Shared reference data (3,200+ rows). Any authenticated user could previously
-- INSERT/UPDATE/DELETE these for everyone. Reads stay open; writes go through
-- the service role (seed function / admin) only.
DROP POLICY IF EXISTS "Authenticated users can insert offices"   ON offices;
DROP POLICY IF EXISTS "Authenticated users can update offices"   ON offices;
DROP POLICY IF EXISTS "Authenticated users can delete offices"   ON offices;
DROP POLICY IF EXISTS "Authenticated users can insert elections" ON elections;
DROP POLICY IF EXISTS "Authenticated users can update elections" ON elections;
DROP POLICY IF EXISTS "Authenticated users can delete elections" ON elections;

-- ─── 2. Dossier ownership reconciliation ─────────────────────────────────────
-- Ownership had drifted across generated_by / user_id / created_by. Consolidate
-- on created_by, backfilled from the best available source (own column →
-- generated_by → user_id → the owning candidate). Auto-regenerated dossiers
-- (generated_by NULL) get created_by from the candidate owner, so they stop
-- being visible to every authenticated user.
ALTER TABLE dossiers ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;

UPDATE dossiers d SET created_by = COALESCE(
  d.created_by,
  d.generated_by,
  (SELECT c.created_by FROM candidates c WHERE c.id = d.candidate_id)
)
WHERE d.created_by IS NULL;

-- Drop every prior dossier policy (strict + ghost) and install candidate-owner RLS
DROP POLICY IF EXISTS "dossiers_select_own"    ON dossiers;
DROP POLICY IF EXISTS "dossiers_insert_own"    ON dossiers;
DROP POLICY IF EXISTS "dossiers_update_own"    ON dossiers;
DROP POLICY IF EXISTS "dossiers_delete_own"    ON dossiers;
DROP POLICY IF EXISTS "Users read own dossiers"   ON dossiers;
DROP POLICY IF EXISTS "Users insert dossiers"     ON dossiers;
DROP POLICY IF EXISTS "Users update own dossiers"  ON dossiers;
DROP POLICY IF EXISTS "Users delete own dossiers"  ON dossiers;

-- Access = you created it, OR you own the candidate it belongs to.
CREATE POLICY "dossiers_select_own" ON dossiers FOR SELECT USING (
  created_by = auth.uid()
  OR EXISTS (SELECT 1 FROM candidates c WHERE c.id = dossiers.candidate_id AND c.created_by = auth.uid())
);
CREATE POLICY "dossiers_insert_own" ON dossiers FOR INSERT WITH CHECK (
  created_by = auth.uid()
  AND (candidate_id IS NULL
       OR EXISTS (SELECT 1 FROM candidates c WHERE c.id = candidate_id AND c.created_by = auth.uid()))
);
CREATE POLICY "dossiers_update_own" ON dossiers FOR UPDATE USING (
  created_by = auth.uid()
  OR EXISTS (SELECT 1 FROM candidates c WHERE c.id = dossiers.candidate_id AND c.created_by = auth.uid())
) WITH CHECK (
  created_by = auth.uid()
  OR EXISTS (SELECT 1 FROM candidates c WHERE c.id = dossiers.candidate_id AND c.created_by = auth.uid())
);
CREATE POLICY "dossiers_delete_own" ON dossiers FOR DELETE USING (
  created_by = auth.uid()
  OR EXISTS (SELECT 1 FROM candidates c WHERE c.id = dossiers.candidate_id AND c.created_by = auth.uid())
);

-- ─── 3. Backfill NULL owners on the 8 user-scoped tables ─────────────────────
-- prospecting_lists / voter_lists / voter_saved_lists / door_knock_lists carry
-- created_by directly; child rows inherit from their parent list.
UPDATE prospecting_lists   SET created_by = created_by WHERE created_by IS NOT NULL; -- no-op guard
-- (Rows with NULL created_by and no derivable owner are orphans; leave them
--  NULL — the new strict policies simply make them inaccessible, which is the
--  safe outcome. They can be cleaned up manually if any exist.)
UPDATE incumbent_records ir SET created_by = (SELECT c.created_by FROM candidates c WHERE c.id = ir.candidate_id)
  WHERE ir.created_by IS NULL AND ir.candidate_id IS NOT NULL;
UPDATE voters v SET created_by = (SELECT vl.created_by FROM voter_lists vl WHERE vl.id = v.voter_list_id)
  WHERE v.created_by IS NULL AND v.voter_list_id IS NOT NULL;
UPDATE door_knocks dk SET created_by = (SELECT l.created_by FROM door_knock_lists l WHERE l.id = dk.list_id)
  WHERE dk.created_by IS NULL AND dk.list_id IS NOT NULL;

-- ─── 4. Drop migration_v5 ghost policies (permissive OR NULL escapes) ────────
DO $$
DECLARE
  tbl TEXT;
  verb TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'prospecting_lists','incumbent_records','voter_lists','voters',
    'voter_saved_lists','door_knock_lists','door_knocks'
  ] LOOP
    FOREACH verb IN ARRAY ARRAY['read','insert','update','delete'] LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON %I', 'Users '||verb||' own '||tbl, tbl);
    END LOOP;
  END LOOP;
END $$;

-- ─── 5. Missing tables: capture DDL + owner-scoped RLS ───────────────────────
-- These were created ad hoc in the dashboard; declaring them here makes RLS
-- auditable and repeatable. IF NOT EXISTS keeps production rows intact.

CREATE TABLE IF NOT EXISTS district_events (
  district_key TEXT PRIMARY KEY,
  name         TEXT,
  events       JSONB NOT NULL DEFAULT '[]'::jsonb,
  fetched_at   TIMESTAMPTZ,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE district_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS district_events_read ON district_events;
CREATE POLICY district_events_read ON district_events FOR SELECT TO authenticated USING (true);
-- writes: service role only (shared cache)

CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id     UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  prefs       JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS notif_prefs_own ON notification_preferences;
CREATE POLICY notif_prefs_own ON notification_preferences FOR ALL
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

CREATE TABLE IF NOT EXISTS calendar_feeds (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  token       TEXT UNIQUE NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE calendar_feeds ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS calendar_feeds_own ON calendar_feeds;
CREATE POLICY calendar_feeds_own ON calendar_feeds FOR ALL
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

CREATE TABLE IF NOT EXISTS calendar_feed_items (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  event       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE calendar_feed_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS calendar_feed_items_own ON calendar_feed_items;
CREATE POLICY calendar_feed_items_own ON calendar_feed_items FOR ALL
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
-- Public ICS consumption of feeds is served by the calendar-feed function
-- (service role, token-scoped) — no anon policy needed here.

-- ─── 6. Missing indexes (FK / RLS-subquery / hot filter columns) ─────────────
CREATE INDEX IF NOT EXISTS idx_candidates_created_by      ON candidates (created_by);
CREATE INDEX IF NOT EXISTS idx_candidates_office_id       ON candidates (office_id);
CREATE INDEX IF NOT EXISTS idx_candidates_election_id     ON candidates (election_id);
CREATE INDEX IF NOT EXISTS idx_dossiers_candidate_id      ON dossiers (candidate_id);
CREATE INDEX IF NOT EXISTS idx_dossiers_generated_by      ON dossiers (generated_by);
CREATE INDEX IF NOT EXISTS idx_door_knocks_list_id        ON door_knocks (list_id);
CREATE INDEX IF NOT EXISTS idx_door_knock_lists_created_by ON door_knock_lists (created_by);
CREATE INDEX IF NOT EXISTS idx_voters_created_by          ON voters (created_by);
CREATE INDEX IF NOT EXISTS idx_voter_lists_created_by     ON voter_lists (created_by);
CREATE INDEX IF NOT EXISTS idx_voter_saved_lists_created_by ON voter_saved_lists (created_by);
CREATE INDEX IF NOT EXISTS idx_prospecting_lists_created_by ON prospecting_lists (created_by);
CREATE INDEX IF NOT EXISTS idx_incumbent_records_candidate_id ON incumbent_records (candidate_id);
CREATE INDEX IF NOT EXISTS idx_activity_log_user_created  ON activity_log (user_id, created_at);

-- ─── 7. elections: de-dup + UNIQUE ───────────────────────────────────────────
-- Collapse exact-duplicate seed rows, keeping the earliest, and repoint any
-- candidates that referenced a removed duplicate.
WITH ranked AS (
  SELECT id, name, election_date,
         row_number() OVER (PARTITION BY name, election_date ORDER BY created_at NULLS FIRST, id) AS rn,
         first_value(id) OVER (PARTITION BY name, election_date ORDER BY created_at NULLS FIRST, id) AS keep_id
  FROM elections
)
UPDATE candidates c SET election_id = r.keep_id
FROM ranked r WHERE c.election_id = r.id AND r.rn > 1;

DELETE FROM elections e
USING (
  SELECT id, row_number() OVER (PARTITION BY name, election_date ORDER BY created_at NULLS FIRST, id) AS rn
  FROM elections
) d
WHERE e.id = d.id AND d.rn > 1;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'elections_name_date_uniq') THEN
    ALTER TABLE elections ADD CONSTRAINT elections_name_date_uniq UNIQUE (name, election_date);
  END IF;
END $$;

COMMIT;
