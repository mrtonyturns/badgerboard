-- ============================================================
-- Election Results System — Real-time WEC Data
-- Migration: 20260426000001_election_results
-- ============================================================
-- Replaces the JSON-blob-in-elections.notes pattern with
-- proper tables that support Supabase Realtime subscriptions
-- and row-level granularity for partial precinct updates.
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- 1. ELECTION CONTESTS
--    One row per race per election (e.g. "State Senate Dist 5")
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS election_contests (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  election_id     UUID REFERENCES elections(id) ON DELETE CASCADE,
  wec_race_id     TEXT,           -- WEC's own identifier; NULL until first WEC sync
  office          TEXT NOT NULL,  -- "Wisconsin Supreme Court" / "State Senate District 5"
  office_type     TEXT,           -- 'statewide' | 'legislative' | 'judicial' | 'county' | 'municipal' | 'referendum'
  district        TEXT,           -- "District 5"
  county          TEXT,           -- NULL = statewide / multi-county
  precincts_total INT DEFAULT 0,
  precincts_rptg  INT DEFAULT 0,
  is_nonpartisan  BOOLEAN DEFAULT FALSE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (wec_race_id)            -- prevents duplicate upserts from poller
);

CREATE INDEX IF NOT EXISTS idx_election_contests_election_id ON election_contests(election_id);
CREATE INDEX IF NOT EXISTS idx_election_contests_office_type ON election_contests(office_type);
CREATE INDEX IF NOT EXISTS idx_election_contests_county      ON election_contests(county);

-- ────────────────────────────────────────────────────────────
-- 2. ELECTION RESULTS
--    One row per candidate per contest, updated as returns come in.
--    Supabase Realtime is enabled on this table so the browser
--    gets pushed updates without polling.
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS election_results (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  contest_id      UUID NOT NULL REFERENCES election_contests(id) ON DELETE CASCADE,
  candidate_id    UUID REFERENCES candidates(id) ON DELETE SET NULL,  -- links to existing candidate record if known
  candidate_name  TEXT NOT NULL,
  party           TEXT,           -- 'Democrat' | 'Republican' | 'Independent' | 'Nonpartisan' | …
  incumbent       BOOLEAN DEFAULT FALSE,
  votes           BIGINT NOT NULL DEFAULT 0,
  vote_pct        NUMERIC(6, 3),  -- e.g. 52.341
  winner          BOOLEAN DEFAULT FALSE,
  declared        BOOLEAN DEFAULT FALSE,  -- winner has been officially called
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (contest_id, candidate_name)     -- idempotent upsert by contest + name
);

CREATE INDEX IF NOT EXISTS idx_election_results_contest_id   ON election_results(contest_id);
CREATE INDEX IF NOT EXISTS idx_election_results_candidate_id ON election_results(candidate_id);
CREATE INDEX IF NOT EXISTS idx_election_results_winner       ON election_results(winner) WHERE winner = TRUE;

-- ────────────────────────────────────────────────────────────
-- 3. POLLER HEALTH LOG
--    Written by the Netlify scheduled function each run so the
--    admin panel can show "last synced X minutes ago" and alert
--    if the poller goes silent during an active election.
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS election_poller_log (
  id               UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  ran_at           TIMESTAMPTZ DEFAULT NOW(),
  election_date    DATE,
  contests_synced  INT DEFAULT 0,
  results_upserted INT DEFAULT 0,
  source           TEXT DEFAULT 'wec',   -- 'wec' | 'manual'
  error            TEXT,                  -- NULL = success
  duration_ms      INT
);

CREATE INDEX IF NOT EXISTS idx_election_poller_log_ran_at ON election_poller_log(ran_at DESC);

-- ────────────────────────────────────────────────────────────
-- 4. ROW LEVEL SECURITY
--    Results are PUBLIC READ (anyone with an account can see
--    live results). Only service-role can write (the poller).
-- ────────────────────────────────────────────────────────────
ALTER TABLE election_contests   ENABLE ROW LEVEL SECURITY;
ALTER TABLE election_results    ENABLE ROW LEVEL SECURITY;
ALTER TABLE election_poller_log ENABLE ROW LEVEL SECURITY;

-- Election results are public data — anyone can read (anon + authenticated).
-- Writes are service-role only (the poller), which bypasses RLS entirely.
CREATE POLICY "Public read election contests"
  ON election_contests FOR SELECT
  TO anon, authenticated USING (true);

CREATE POLICY "Public read election results"
  ON election_results FOR SELECT
  TO anon, authenticated USING (true);

CREATE POLICY "Public read poller log"
  ON election_poller_log FOR SELECT
  TO anon, authenticated USING (true);

-- Only service role can write (poller runs with service_role key)
-- No INSERT/UPDATE/DELETE policies for 'authenticated' role →
-- all writes go through service_role which bypasses RLS.

-- ────────────────────────────────────────────────────────────
-- 5. ENABLE SUPABASE REALTIME
--    The frontend subscribes to election_results changes so
--    vote totals update live without any client-side polling.
-- ────────────────────────────────────────────────────────────
ALTER PUBLICATION supabase_realtime ADD TABLE election_results;
ALTER PUBLICATION supabase_realtime ADD TABLE election_contests;

-- ────────────────────────────────────────────────────────────
-- 6. UPDATED_AT TRIGGER (auto-bump on every write)
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_election_contests_updated_at
  BEFORE UPDATE ON election_contests
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER set_election_results_updated_at
  BEFORE UPDATE ON election_results
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ────────────────────────────────────────────────────────────
-- 7. SEED KNOWN WISCONSIN ELECTIONS (through 2028)
--    Ensures April 7 2025 Spring General and future elections
--    are always present — the original omission that caused
--    the election night failure.
-- ────────────────────────────────────────────────────────────
INSERT INTO elections (name, election_date, type, year, notes)
VALUES
  -- 2025
  ('2025 Spring Primary',        '2025-02-18', 'spring_primary', 2025, NULL),
  ('2025 Spring General',        '2025-04-01', 'spring_general', 2025, NULL),
  ('2025 Partisan Primary',      '2025-08-12', 'primary',        2025, NULL),
  ('2025 General Election',      '2025-11-04', 'general',        2025, NULL),
  -- 2026
  ('2026 Spring Primary',        '2026-02-17', 'spring_primary', 2026, NULL),
  ('2026 Spring General',        '2026-04-07', 'spring_general', 2026, NULL),
  ('2026 Partisan Primary',      '2026-08-11', 'primary',        2026, NULL),
  ('2026 General Election',      '2026-11-03', 'general',        2026, NULL),
  -- 2027
  ('2027 Spring Primary',        '2027-02-16', 'spring_primary', 2027, NULL),
  ('2027 Spring General',        '2027-04-06', 'spring_general', 2027, NULL),
  ('2027 Partisan Primary',      '2027-08-10', 'primary',        2027, NULL),
  ('2027 General Election',      '2027-11-02', 'general',        2027, NULL),
  -- 2028
  ('2028 Spring Primary',        '2028-02-15', 'spring_primary', 2028, NULL),
  ('2028 Spring General',        '2028-04-04', 'spring_general', 2028, NULL),
  ('2028 Presidential Primary',  '2028-04-04', 'primary',        2028, NULL),
  ('2028 Partisan Primary',      '2028-08-08', 'primary',        2028, NULL),
  ('2028 General Election',      '2028-11-07', 'general',        2028, NULL)
ON CONFLICT DO NOTHING;
