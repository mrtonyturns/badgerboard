-- ============================================================
-- Badger Board — Schema Migration v2
-- New features: incumbent records, voter lists, door knocking,
-- candidate section timestamps, key weaknesses
-- ============================================================

-- ============================================================
-- ADD COLUMNS TO CANDIDATES TABLE
-- ============================================================
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS weaknesses      JSONB DEFAULT '[]';
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS section_timestamps JSONB DEFAULT '{}';
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS is_incumbent    BOOLEAN DEFAULT false;
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS incumbent_since DATE;

-- ============================================================
-- INCUMBENT RECORDS TABLE
-- Bills, acts, votes, legal events from a politician's term
-- ============================================================
CREATE TABLE IF NOT EXISTS incumbent_records (
  id              UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  candidate_id    UUID REFERENCES candidates(id) ON DELETE CASCADE,
  record_type     TEXT NOT NULL CHECK (record_type IN ('bill','act','regulation','law','legal','vote','other')),
  title           TEXT NOT NULL,
  description     TEXT,
  bill_number     TEXT,
  vote_result     TEXT CHECK (vote_result IN ('yes','no','abstain','absent','not_applicable')),
  date            DATE,
  significance    TEXT DEFAULT 'notable' CHECK (significance IN ('major','notable','minor')),
  url             TEXT,
  source          TEXT,
  notes           TEXT,
  created_by      UUID REFERENCES auth.users(id),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- VOTER LISTS TABLE
-- Uploaded voter CSV files and named saved lists
-- ============================================================
CREATE TABLE IF NOT EXISTS voter_lists (
  id              UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  name            TEXT NOT NULL,
  description     TEXT,
  source_filename TEXT,
  total_count     INT DEFAULT 0,
  created_by      UUID REFERENCES auth.users(id),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- VOTERS TABLE
-- Individual voter records parsed from uploaded CSV files
-- ============================================================
CREATE TABLE IF NOT EXISTS voters (
  id                       UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  voter_list_id            UUID REFERENCES voter_lists(id) ON DELETE CASCADE,
  -- Authoritative ownership column (reconciled July 2026): every later RLS
  -- policy (20260422000003/4, migration_v5, backend_hardening backfill+index)
  -- assumes voters.created_by exists. 004_voter_and_incumbent_tables.sql
  -- defines it too; this definition matches it exactly.
  created_by               UUID REFERENCES auth.users(id),
  first_name               TEXT,
  last_name                TEXT,
  full_name                TEXT,
  address                  TEXT,
  city                     TEXT,
  state                    TEXT DEFAULT 'WI',
  zip                      TEXT,
  county                   TEXT,
  ward                     TEXT,
  congressional_district   TEXT,
  state_senate_district    TEXT,
  state_assembly_district  TEXT,
  party                    TEXT,
  latitude                 DECIMAL(10,7),
  longitude                DECIMAL(10,7),
  geocoded                 BOOLEAN DEFAULT false,
  ai_score                 INT,
  ai_notes                 TEXT,
  saved_lists              JSONB DEFAULT '[]',
  raw_data                 JSONB DEFAULT '{}',
  created_at               TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- VOTER SAVED LISTS TABLE
-- Named lists users create to organize voters
-- ============================================================
CREATE TABLE IF NOT EXISTS voter_saved_lists (
  id          UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  color       TEXT DEFAULT '#3B82F6',
  voter_ids   JSONB DEFAULT '[]',
  created_by  UUID REFERENCES auth.users(id),
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- DOOR KNOCK LISTS TABLE
-- Campaigns / organized canvassing lists
-- ============================================================
CREATE TABLE IF NOT EXISTS door_knock_lists (
  id            UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT,
  candidate_id  UUID REFERENCES candidates(id) ON DELETE SET NULL,
  election_id   UUID REFERENCES elections(id) ON DELETE SET NULL,
  status        TEXT DEFAULT 'active' CHECK (status IN ('active','completed','archived')),
  target_count  INT DEFAULT 0,
  knocked_count INT DEFAULT 0,
  created_by    UUID REFERENCES auth.users(id),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- DOOR KNOCKS TABLE
-- Individual door knock records
-- ============================================================
CREATE TABLE IF NOT EXISTS door_knocks (
  id                UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  list_id           UUID REFERENCES door_knock_lists(id) ON DELETE CASCADE,
  address           TEXT NOT NULL,
  city              TEXT,
  zip               TEXT,
  resident_name     TEXT,
  phone             TEXT,
  status            TEXT DEFAULT 'not_home' CHECK (status IN (
    'contacted','not_home','refused','moved','wrong_address','do_not_knock'
  )),
  party_affiliation TEXT,
  received_mailer   BOOLEAN,
  support_level     INT CHECK (support_level BETWEEN 1 AND 5),
  notes             TEXT,
  knocked_by        UUID REFERENCES auth.users(id),
  knocked_at        TIMESTAMPTZ DEFAULT NOW(),
  latitude          DECIMAL(10,7),
  longitude         DECIMAL(10,7),
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- ROW LEVEL SECURITY — NEW TABLES
-- ============================================================
ALTER TABLE incumbent_records   ENABLE ROW LEVEL SECURITY;
ALTER TABLE voter_lists         ENABLE ROW LEVEL SECURITY;
ALTER TABLE voters              ENABLE ROW LEVEL SECURITY;
ALTER TABLE voter_saved_lists   ENABLE ROW LEVEL SECURITY;
ALTER TABLE door_knock_lists    ENABLE ROW LEVEL SECURITY;
ALTER TABLE door_knocks         ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Auth users read incumbent_records"   ON incumbent_records   FOR SELECT    TO authenticated USING (true);
CREATE POLICY "Auth users insert incumbent_records" ON incumbent_records   FOR INSERT    TO authenticated WITH CHECK (true);
CREATE POLICY "Auth users update incumbent_records" ON incumbent_records   FOR UPDATE    TO authenticated USING (true);
CREATE POLICY "Auth users delete incumbent_records" ON incumbent_records   FOR DELETE    TO authenticated USING (true);

CREATE POLICY "Auth users read voter_lists"         ON voter_lists         FOR SELECT    TO authenticated USING (true);
CREATE POLICY "Auth users insert voter_lists"       ON voter_lists         FOR INSERT    TO authenticated WITH CHECK (true);
CREATE POLICY "Auth users update voter_lists"       ON voter_lists         FOR UPDATE    TO authenticated USING (true);
CREATE POLICY "Auth users delete voter_lists"       ON voter_lists         FOR DELETE    TO authenticated USING (true);

CREATE POLICY "Auth users read voters"              ON voters              FOR SELECT    TO authenticated USING (true);
CREATE POLICY "Auth users insert voters"            ON voters              FOR INSERT    TO authenticated WITH CHECK (true);
CREATE POLICY "Auth users update voters"            ON voters              FOR UPDATE    TO authenticated USING (true);
CREATE POLICY "Auth users delete voters"            ON voters              FOR DELETE    TO authenticated USING (true);

CREATE POLICY "Auth users read voter_saved_lists"   ON voter_saved_lists   FOR SELECT    TO authenticated USING (true);
CREATE POLICY "Auth users insert voter_saved_lists" ON voter_saved_lists   FOR INSERT    TO authenticated WITH CHECK (true);
CREATE POLICY "Auth users update voter_saved_lists" ON voter_saved_lists   FOR UPDATE    TO authenticated USING (true);
CREATE POLICY "Auth users delete voter_saved_lists" ON voter_saved_lists   FOR DELETE    TO authenticated USING (true);

CREATE POLICY "Auth users read door_knock_lists"    ON door_knock_lists    FOR SELECT    TO authenticated USING (true);
CREATE POLICY "Auth users insert door_knock_lists"  ON door_knock_lists    FOR INSERT    TO authenticated WITH CHECK (true);
CREATE POLICY "Auth users update door_knock_lists"  ON door_knock_lists    FOR UPDATE    TO authenticated USING (true);
CREATE POLICY "Auth users delete door_knock_lists"  ON door_knock_lists    FOR DELETE    TO authenticated USING (true);

CREATE POLICY "Auth users read door_knocks"         ON door_knocks         FOR SELECT    TO authenticated USING (true);
CREATE POLICY "Auth users insert door_knocks"       ON door_knocks         FOR INSERT    TO authenticated WITH CHECK (true);
CREATE POLICY "Auth users update door_knocks"       ON door_knocks         FOR UPDATE    TO authenticated USING (true);
CREATE POLICY "Auth users delete door_knocks"       ON door_knocks         FOR DELETE    TO authenticated USING (true);

-- ============================================================
-- UPDATED_AT TRIGGERS — NEW TABLES
-- ============================================================
CREATE TRIGGER incumbent_records_updated_at  BEFORE UPDATE ON incumbent_records  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER voter_lists_updated_at        BEFORE UPDATE ON voter_lists        FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER voter_saved_lists_updated_at  BEFORE UPDATE ON voter_saved_lists  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER door_knock_lists_updated_at   BEFORE UPDATE ON door_knock_lists   FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER door_knocks_updated_at        BEFORE UPDATE ON door_knocks        FOR EACH ROW EXECUTE FUNCTION update_updated_at();
