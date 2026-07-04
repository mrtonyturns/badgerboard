-- Migration: Game Plan Tasks v2 — quality-of-life upgrades
--   1. Fractional ordering: gp_tasks.sort_order becomes DOUBLE PRECISION so
--      drag-reorder can insert between neighbors without renumbering.
--   2. Recurring tasks: gp_tasks.recurrence JSONB
--      ({ freq: daily|weekly|monthly|yearly, interval: N, weekday: 0-6? }).
--      Completing a recurring task advances due_date instead of completing.
--   3. Realtime: gp_* tables added to the supabase_realtime publication so
--      connected managers/candidates see each other's changes live
--      (RLS still applies to change events).
--
-- Safe to run multiple times.

-- ─── 1. Fractional sort order ─────────────────────────────────────────────────
DO $$ BEGIN
  IF (SELECT data_type FROM information_schema.columns
      WHERE table_name = 'gp_tasks' AND column_name = 'sort_order') <> 'double precision' THEN
    ALTER TABLE gp_tasks ALTER COLUMN sort_order TYPE DOUBLE PRECISION;
  END IF;
END $$;

-- Spread existing rows out so midpoint insertion has room immediately
UPDATE gp_tasks SET sort_order = sort_order * 1024
WHERE sort_order = ROUND(sort_order::numeric) AND ABS(sort_order) < 1000;

-- ─── 2. Recurrence ────────────────────────────────────────────────────────────
ALTER TABLE gp_tasks ADD COLUMN IF NOT EXISTS recurrence JSONB;
COMMENT ON COLUMN gp_tasks.recurrence IS
  'NULL = one-off. { "freq": "daily|weekly|monthly|yearly", "interval": 1, "weekday": 0-6 (weekly only) }';

-- ─── 3. Realtime publication ──────────────────────────────────────────────────
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['gp_projects','gp_sections','gp_tasks','gp_labels'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE %I', t);
    END IF;
  END LOOP;
END $$;
