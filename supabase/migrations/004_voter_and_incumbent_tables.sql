-- ============================================================
-- Migration 004: voter_lists, voters, voter_saved_lists,
--                incumbent_records
-- Applied to production: 2026-04-01
-- ============================================================

-- ── incumbent_records ─────────────────────────────────────────────────────────
-- Tracks legislative/voting history for incumbent candidates.
-- Displayed and managed from the Candidate Detail page.
CREATE TABLE IF NOT EXISTS incumbent_records (
  id            UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  candidate_id  UUID        REFERENCES candidates(id) ON DELETE CASCADE,
  record_type   TEXT        NOT NULL DEFAULT 'bill'
                            CHECK (record_type IN ('bill','act','regulation','law','legal','vote','other')),
  title         TEXT        NOT NULL,
  description   TEXT,
  bill_number   TEXT,
  vote_result   TEXT        DEFAULT 'not_applicable',
  date          DATE,
  significance  TEXT        DEFAULT 'notable'
                            CHECK (significance IN ('major','notable','minor')),
  url           TEXT,
  source        TEXT,
  notes         TEXT,
  created_by    UUID        REFERENCES auth.users(id),
  created_at    TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE incumbent_records ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users manage own incumbent_records" ON incumbent_records;
CREATE POLICY "Users manage own incumbent_records" ON incumbent_records
  USING (auth.uid() = created_by) WITH CHECK (auth.uid() = created_by);

-- ── voter_lists ────────────────────────────────────────────────────────────────
-- Uploaded CSV voter files. One row per uploaded file/list.
CREATE TABLE IF NOT EXISTS voter_lists (
  id              UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  name            TEXT        NOT NULL,
  source_filename TEXT,
  created_by      UUID        REFERENCES auth.users(id),
  created_at      TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE voter_lists ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users manage own voter_lists" ON voter_lists;
CREATE POLICY "Users manage own voter_lists" ON voter_lists
  USING (auth.uid() = created_by) WITH CHECK (auth.uid() = created_by);

-- ── voters ─────────────────────────────────────────────────────────────────────
-- Individual voter rows parsed from uploaded CSVs.
CREATE TABLE IF NOT EXISTS voters (
  id                        UUID             DEFAULT gen_random_uuid() PRIMARY KEY,
  voter_list_id             UUID             REFERENCES voter_lists(id) ON DELETE CASCADE,
  first_name                TEXT,
  last_name                 TEXT,
  full_name                 TEXT,
  address                   TEXT,
  city                      TEXT,
  zip                       TEXT,
  county                    TEXT,
  ward                      TEXT,
  state_assembly_district   TEXT,
  state_senate_district     TEXT,
  congressional_district    TEXT,
  party                     TEXT,
  latitude                  DOUBLE PRECISION,
  longitude                 DOUBLE PRECISION,
  created_by                UUID             REFERENCES auth.users(id),
  created_at                TIMESTAMPTZ      DEFAULT now()
);
CREATE INDEX IF NOT EXISTS voters_voter_list_id_idx ON voters(voter_list_id);
ALTER TABLE voters ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users manage own voters" ON voters;
CREATE POLICY "Users manage own voters" ON voters
  USING (auth.uid() = created_by) WITH CHECK (auth.uid() = created_by);

-- ── voter_saved_lists ──────────────────────────────────────────────────────────
-- Named lists of voter IDs saved by the user (e.g. prospecting targets).
CREATE TABLE IF NOT EXISTS voter_saved_lists (
  id         UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  name       TEXT        NOT NULL,
  color      TEXT        DEFAULT '#4f46e5',
  voter_ids  UUID[]      DEFAULT '{}',
  created_by UUID        REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE voter_saved_lists ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users manage own voter_saved_lists" ON voter_saved_lists;
CREATE POLICY "Users manage own voter_saved_lists" ON voter_saved_lists
  USING (auth.uid() = created_by) WITH CHECK (auth.uid() = created_by);
