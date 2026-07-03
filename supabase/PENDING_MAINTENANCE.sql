-- ─── Badger Board pending maintenance SQL ─────────────────────────────────────
-- Run this once in the Supabase Dashboard → SQL Editor (requires owner role).
-- Generated 2026-07-03. Everything here is idempotent — safe to run twice.

-- 1. Prevent duplicate office seeding (the offices table previously accumulated
--    5,057 duplicate rows from repeated seeder runs; duplicates were removed via
--    the API on 2026-07-03 — this index stops it happening again).
CREATE UNIQUE INDEX IF NOT EXISTS offices_name_county_uniq
  ON offices (name, COALESCE(county, ''));

-- 2. Helpful indexes for the new office history feature
CREATE INDEX IF NOT EXISTS election_contests_office_idx
  ON election_contests USING gin (to_tsvector('simple', office));
CREATE INDEX IF NOT EXISTS election_results_contest_idx
  ON election_results (contest_id);

-- 3. (Optional) Server-side turf tables for Door Knocking.
--    The app currently stores turf blocks in localStorage, which works but is
--    per-device. Run this only when ready to migrate to shared, synced turf.
-- CREATE TABLE IF NOT EXISTS turf_blocks (
--   id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
--   list_id uuid REFERENCES door_knock_lists(id) ON DELETE CASCADE,
--   name text NOT NULL,
--   bbox jsonb NOT NULL,
--   house_count int DEFAULT 0,
--   created_by uuid REFERENCES auth.users(id),
--   created_at timestamptz DEFAULT now()
-- );
-- ALTER TABLE turf_blocks ENABLE ROW LEVEL SECURITY;

-- ─── District intelligence cache (added 2026-07-03, applied via dashboard) ────
CREATE TABLE IF NOT EXISTS district_intel (
  district_key text PRIMARY KEY,
  layer        text,
  name         text,
  history      jsonb,
  history_at   timestamptz,
  updated_at   timestamptz DEFAULT now()
);
ALTER TABLE district_intel ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='district_intel' AND policyname='district_intel_read') THEN
    CREATE POLICY district_intel_read ON district_intel FOR SELECT TO authenticated USING (true);
  END IF;
END $$;
