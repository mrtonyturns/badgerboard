-- ============================================================
-- Wisconsin Political Intelligence Platform — Supabase Schema
-- The Bluejack Group
-- ============================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- OFFICES TABLE
-- All elected/appointed political offices in Wisconsin
-- ============================================================
CREATE TABLE IF NOT EXISTS offices (
  id              UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  name            TEXT NOT NULL,
  level           TEXT NOT NULL CHECK (level IN ('federal','state','county','municipal')),
  office_type     TEXT NOT NULL CHECK (office_type IN ('executive','legislative','judicial','administrative')),
  district_number TEXT,
  district_name   TEXT,
  county          TEXT,
  city            TEXT,
  term_years      INT DEFAULT 4,
  seats           INT DEFAULT 1,
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- ELECTIONS TABLE
-- All election dates across Wisconsin
-- ============================================================
CREATE TABLE IF NOT EXISTS elections (
  id               UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  name             TEXT NOT NULL,
  election_date    DATE NOT NULL,
  filing_deadline  DATE,
  type             TEXT NOT NULL CHECK (type IN ('primary','general','special','spring_primary','spring_general')),
  year             INT NOT NULL,
  notes            TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- CANDIDATES TABLE
-- All candidates running for office
-- ============================================================
CREATE TABLE IF NOT EXISTS candidates (
  id                  UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  name                TEXT NOT NULL,
  party               TEXT CHECK (party IN ('Republican','Democrat','Independent','Libertarian','Green','Constitution','Working Families','Nonpartisan','Other')),
  office_id           UUID REFERENCES offices(id) ON DELETE SET NULL,
  election_id         UUID REFERENCES elections(id) ON DELETE SET NULL,
  status              TEXT DEFAULT 'exploring' CHECK (status IN ('exploring','declared','primary_winner','general','elected','lost','withdrawn')),
  -- Contact Information
  email               TEXT,
  phone               TEXT,
  website             TEXT,
  campaign_address    TEXT,
  campaign_city       TEXT,
  campaign_zip        TEXT,
  -- Campaign Details
  campaign_committee  TEXT,
  campaign_manager    TEXT,
  treasurer           TEXT,
  filing_date         DATE,
  -- Financial
  total_raised        DECIMAL(12,2),
  total_spent         DECIMAL(12,2),
  cash_on_hand        DECIMAL(12,2),
  -- Social Media
  twitter_handle      TEXT,
  facebook_url        TEXT,
  instagram_handle    TEXT,
  linkedin_url        TEXT,
  -- Background
  occupation          TEXT,
  employer            TEXT,
  bio_summary         TEXT,
  key_issues          TEXT[],
  notes               TEXT,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- DOSSIERS TABLE
-- AI-generated political dossiers on candidates
-- ============================================================
CREATE TABLE IF NOT EXISTS dossiers (
  id              UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  candidate_id    UUID REFERENCES candidates(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  content         TEXT NOT NULL,
  key_issues      JSONB DEFAULT '[]',
  voting_history  JSONB DEFAULT '[]',
  endorsements    JSONB DEFAULT '[]',
  opposition_data JSONB DEFAULT '[]',
  contact_summary JSONB DEFAULT '{}',
  generated_by    UUID REFERENCES auth.users(id),
  generated_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- PROSPECTING LISTS TABLE
-- AI-generated prospecting lists for outreach
-- ============================================================
CREATE TABLE IF NOT EXISTS prospecting_lists (
  id            UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT,
  filters       JSONB DEFAULT '{}',
  candidates    JSONB DEFAULT '[]',
  total_count   INT DEFAULT 0,
  notes         TEXT,
  created_by    UUID REFERENCES auth.users(id),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- ACTIVITY LOG TABLE
-- Track user actions
-- ============================================================
CREATE TABLE IF NOT EXISTS activity_log (
  id          UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id     UUID REFERENCES auth.users(id),
  action      TEXT NOT NULL,
  entity_type TEXT,
  entity_id   UUID,
  details     JSONB DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
ALTER TABLE offices ENABLE ROW LEVEL SECURITY;
ALTER TABLE elections ENABLE ROW LEVEL SECURITY;
ALTER TABLE candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE dossiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE prospecting_lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_log ENABLE ROW LEVEL SECURITY;

-- Allow all authenticated users full access
CREATE POLICY "Authenticated users can read offices" ON offices FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert offices" ON offices FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update offices" ON offices FOR UPDATE TO authenticated USING (true);
CREATE POLICY "Authenticated users can delete offices" ON offices FOR DELETE TO authenticated USING (true);

CREATE POLICY "Authenticated users can read elections" ON elections FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert elections" ON elections FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update elections" ON elections FOR UPDATE TO authenticated USING (true);
CREATE POLICY "Authenticated users can delete elections" ON elections FOR DELETE TO authenticated USING (true);

CREATE POLICY "Authenticated users can read candidates" ON candidates FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert candidates" ON candidates FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update candidates" ON candidates FOR UPDATE TO authenticated USING (true);
CREATE POLICY "Authenticated users can delete candidates" ON candidates FOR DELETE TO authenticated USING (true);

CREATE POLICY "Authenticated users can read dossiers" ON dossiers FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert dossiers" ON dossiers FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update dossiers" ON dossiers FOR UPDATE TO authenticated USING (true);
CREATE POLICY "Authenticated users can delete dossiers" ON dossiers FOR DELETE TO authenticated USING (true);

CREATE POLICY "Authenticated users can read prospecting_lists" ON prospecting_lists FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert prospecting_lists" ON prospecting_lists FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update prospecting_lists" ON prospecting_lists FOR UPDATE TO authenticated USING (true);
CREATE POLICY "Authenticated users can delete prospecting_lists" ON prospecting_lists FOR DELETE TO authenticated USING (true);

CREATE POLICY "Authenticated users can read activity_log" ON activity_log FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert activity_log" ON activity_log FOR INSERT TO authenticated WITH CHECK (true);

-- ============================================================
-- UPDATED_AT TRIGGER
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER offices_updated_at BEFORE UPDATE ON offices FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER candidates_updated_at BEFORE UPDATE ON candidates FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER dossiers_updated_at BEFORE UPDATE ON dossiers FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER prospecting_lists_updated_at BEFORE UPDATE ON prospecting_lists FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- SEED DATA: WISCONSIN ELECTIONS 2025-2026
-- ============================================================
INSERT INTO elections (name, election_date, filing_deadline, type, year, notes) VALUES
  ('2025 Spring Primary',          '2025-02-18', '2024-12-27', 'spring_primary',  2025, 'Spring primary for nonpartisan offices'),
  ('2025 Spring General Election', '2025-04-01', '2024-12-27', 'spring_general',  2025, 'Spring general: school boards, local offices, Supreme Court'),
  ('2025 November General',        '2025-11-04', '2025-08-01', 'general',         2025, 'Fall general election'),
  ('2026 Spring Primary',          '2026-02-17', '2025-12-26', 'spring_primary',  2026, 'Spring primary for nonpartisan offices'),
  ('2026 Spring General Election', '2026-04-07', '2025-12-26', 'spring_general',  2026, 'Spring general: local offices, judicial races'),
  ('2026 August Partisan Primary', '2026-08-11', '2026-06-01', 'primary',         2026, 'Partisan primary: Governor, AG, Legislature, US Congress'),
  ('2026 November General',        '2026-11-03', '2026-06-01', 'general',         2026, 'General election: all statewide + legislative seats'),
  ('2028 Spring Primary',          '2028-02-15', '2027-12-27', 'spring_primary',  2028, 'Spring primary'),
  ('2028 Spring General Election', '2028-04-04', '2027-12-27', 'spring_general',  2028, 'Spring general'),
  ('2028 Presidential Primary',    '2028-04-04', '2027-12-27', 'primary',         2028, 'Presidential preference primary'),
  ('2028 August Partisan Primary', '2028-08-08', '2028-06-01', 'primary',         2028, 'Partisan primary'),
  ('2028 November General',        '2028-11-07', '2028-06-01', 'general',         2028, 'Presidential general election');

-- ============================================================
-- SEED DATA: FEDERAL OFFICES — WISCONSIN
-- ============================================================
INSERT INTO offices (name, level, office_type, district_number, district_name, term_years, notes) VALUES
  ('U.S. Senator (Class I)',      'federal', 'legislative', NULL, 'Statewide', 6, 'Next election: 2028'),
  ('U.S. Senator (Class III)',    'federal', 'legislative', NULL, 'Statewide', 6, 'Next election: 2026'),
  ('U.S. Representative',        'federal', 'legislative', '1',  'WI-1 (Racine, Kenosha, Janesville)', 2, NULL),
  ('U.S. Representative',        'federal', 'legislative', '2',  'WI-2 (Madison, Dane County)', 2, NULL),
  ('U.S. Representative',        'federal', 'legislative', '3',  'WI-3 (La Crosse, Eau Claire, western WI)', 2, NULL),
  ('U.S. Representative',        'federal', 'legislative', '4',  'WI-4 (Milwaukee)', 2, NULL),
  ('U.S. Representative',        'federal', 'legislative', '5',  'WI-5 (Waukesha, western Milwaukee suburbs)', 2, NULL),
  ('U.S. Representative',        'federal', 'legislative', '6',  'WI-6 (Fond du Lac, Sheboygan, Green Bay area)', 2, NULL),
  ('U.S. Representative',        'federal', 'legislative', '7',  'WI-7 (Northern WI, Wausau, Superior)', 2, NULL),
  ('U.S. Representative',        'federal', 'legislative', '8',  'WI-8 (Green Bay, Fox Valley, Door Peninsula)', 2, NULL);

-- ============================================================
-- SEED DATA: STATE EXECUTIVE OFFICES
-- ============================================================
INSERT INTO offices (name, level, office_type, district_number, district_name, term_years, notes) VALUES
  ('Governor',             'state', 'executive', NULL, 'Statewide', 4, 'Chief executive of Wisconsin. Next election: 2026'),
  ('Lieutenant Governor',  'state', 'executive', NULL, 'Statewide', 4, 'Next election: 2026'),
  ('Attorney General',     'state', 'executive', NULL, 'Statewide', 4, 'Chief law enforcement officer. Next election: 2026'),
  ('Secretary of State',   'state', 'executive', NULL, 'Statewide', 4, 'Next election: 2026'),
  ('State Treasurer',      'state', 'executive', NULL, 'Statewide', 4, 'Next election: 2026');

-- ============================================================
-- SEED DATA: WISCONSIN SUPREME COURT
-- ============================================================
INSERT INTO offices (name, level, office_type, district_number, district_name, term_years, notes) VALUES
  ('Wisconsin Supreme Court Justice', 'state', 'judicial', NULL, 'Statewide', 10, 'Seat 1 — Next election: 2025'),
  ('Wisconsin Supreme Court Justice', 'state', 'judicial', NULL, 'Statewide', 10, 'Seat 2 — Next election: 2026'),
  ('Wisconsin Supreme Court Justice', 'state', 'judicial', NULL, 'Statewide', 10, 'Seat 3 — Next election: 2027'),
  ('Wisconsin Supreme Court Justice', 'state', 'judicial', NULL, 'Statewide', 10, 'Seat 4 — Next election: 2028'),
  ('Wisconsin Supreme Court Justice', 'state', 'judicial', NULL, 'Statewide', 10, 'Seat 5 — Next election: 2029'),
  ('Wisconsin Supreme Court Justice', 'state', 'judicial', NULL, 'Statewide', 10, 'Seat 6 — Next election: 2030'),
  ('Wisconsin Supreme Court Justice', 'state', 'judicial', NULL, 'Statewide', 10, 'Seat 7 — Next election: 2031');

-- ============================================================
-- SEED DATA: COURT OF APPEALS
-- ============================================================
INSERT INTO offices (name, level, office_type, district_number, district_name, term_years, notes) VALUES
  ('Court of Appeals Judge', 'state', 'judicial', '1', 'District 1 — Milwaukee County',           6, 'Milwaukee area'),
  ('Court of Appeals Judge', 'state', 'judicial', '2', 'District 2 — Southeastern Wisconsin',     6, 'Waukesha, Racine, Kenosha, Sheboygan, Ozaukee, Washington'),
  ('Court of Appeals Judge', 'state', 'judicial', '3', 'District 3 — Northern / Western Wisconsin', 6, 'Eau Claire, La Crosse, Green Bay, Wausau, Superior area'),
  ('Court of Appeals Judge', 'state', 'judicial', '4', 'District 4 — South Central Wisconsin',    6, 'Dane County and surrounding counties');

-- ============================================================
-- SEED DATA: STATE SENATE (33 Districts)
-- ============================================================
INSERT INTO offices (name, level, office_type, district_number, district_name, term_years, notes) VALUES
  ('State Senator', 'state', 'legislative', '1',  'District 1  — Marinette, Florence, northern Oconto', 4, 'Up in 2026'),
  ('State Senator', 'state', 'legislative', '2',  'District 2  — Door, Kewaunee, parts of Brown',        4, 'Up in 2028'),
  ('State Senator', 'state', 'legislative', '3',  'District 3  — Green Bay / Brown County',              4, 'Up in 2026'),
  ('State Senator', 'state', 'legislative', '4',  'District 4  — Outagamie, parts of Winnebago',         4, 'Up in 2028'),
  ('State Senator', 'state', 'legislative', '5',  'District 5  — Fox Valley / Appleton area',            4, 'Up in 2026'),
  ('State Senator', 'state', 'legislative', '6',  'District 6  — Fond du Lac, eastern Winnebago',        4, 'Up in 2028'),
  ('State Senator', 'state', 'legislative', '7',  'District 7  — Sheboygan County',                      4, 'Up in 2026'),
  ('State Senator', 'state', 'legislative', '8',  'District 8  — Washington County',                     4, 'Up in 2028'),
  ('State Senator', 'state', 'legislative', '9',  'District 9  — Ozaukee County',                        4, 'Up in 2026'),
  ('State Senator', 'state', 'legislative', '10', 'District 10 — Northern Milwaukee suburbs',            4, 'Up in 2028'),
  ('State Senator', 'state', 'legislative', '11', 'District 11 — Milwaukee North Shore',                 4, 'Up in 2026'),
  ('State Senator', 'state', 'legislative', '12', 'District 12 — Milwaukee City (north)',                4, 'Up in 2028'),
  ('State Senator', 'state', 'legislative', '13', 'District 13 — Milwaukee City (central)',              4, 'Up in 2026'),
  ('State Senator', 'state', 'legislative', '14', 'District 14 — Milwaukee City (south)',                4, 'Up in 2028'),
  ('State Senator', 'state', 'legislative', '15', 'District 15 — Waukesha County (east)',                4, 'Up in 2026'),
  ('State Senator', 'state', 'legislative', '16', 'District 16 — Waukesha County (west)',                4, 'Up in 2028'),
  ('State Senator', 'state', 'legislative', '17', 'District 17 — Jefferson, Walworth counties',          4, 'Up in 2026'),
  ('State Senator', 'state', 'legislative', '18', 'District 18 — Racine County',                        4, 'Up in 2028'),
  ('State Senator', 'state', 'legislative', '19', 'District 19 — Kenosha County',                       4, 'Up in 2026'),
  ('State Senator', 'state', 'legislative', '20', 'District 20 — Rock County / Janesville',             4, 'Up in 2028'),
  ('State Senator', 'state', 'legislative', '21', 'District 21 — Green, Iowa, Lafayette counties',      4, 'Up in 2026'),
  ('State Senator', 'state', 'legislative', '22', 'District 22 — Dane County (east)',                   4, 'Up in 2028'),
  ('State Senator', 'state', 'legislative', '23', 'District 23 — Dane County (west/Madison)',           4, 'Up in 2026'),
  ('State Senator', 'state', 'legislative', '24', 'District 24 — Columbia, Dodge counties',             4, 'Up in 2028'),
  ('State Senator', 'state', 'legislative', '25', 'District 25 — Portage, Waupaca, Waushara',           4, 'Up in 2026'),
  ('State Senator', 'state', 'legislative', '26', 'District 26 — Marathon County / Wausau',             4, 'Up in 2028'),
  ('State Senator', 'state', 'legislative', '27', 'District 27 — Lincoln, Langlade, Menominee, Shawano',4, 'Up in 2026'),
  ('State Senator', 'state', 'legislative', '28', 'District 28 — Wausau metro / Marathon County',       4, 'Up in 2028'),
  ('State Senator', 'state', 'legislative', '29', 'District 29 — Chippewa, Eau Claire counties',        4, 'Up in 2026'),
  ('State Senator', 'state', 'legislative', '30', 'District 30 — Barron, Rusk, Polk, Washburn',         4, 'Up in 2028'),
  ('State Senator', 'state', 'legislative', '31', 'District 31 — Douglas, Bayfield, Ashland, Iron',     4, 'Up in 2026'),
  ('State Senator', 'state', 'legislative', '32', 'District 32 — La Crosse, Monroe, Vernon counties',   4, 'Up in 2028'),
  ('State Senator', 'state', 'legislative', '33', 'District 33 — Adams, Juneau, Sauk, Richland',        4, 'Up in 2026');

-- ============================================================
-- SEED DATA: STATE ASSEMBLY (99 Districts — all up in 2026)
-- ============================================================
INSERT INTO offices (name, level, office_type, district_number, district_name, term_years, notes) VALUES
  ('State Assembly Representative', 'state', 'legislative', '1',  'District 1  — Marinette/Oconto (north)', 2, 'All Assembly seats up in 2026'),
  ('State Assembly Representative', 'state', 'legislative', '2',  'District 2  — Marinette/Oconto (south)', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '3',  'District 3  — Florence, Vilas, Oneida', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '4',  'District 4  — Door County', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '5',  'District 5  — Kewaunee, Manitowoc (east)', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '6',  'District 6  — Manitowoc County', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '7',  'District 7  — Sheboygan County (north)', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '8',  'District 8  — Sheboygan County (south)', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '9',  'District 9  — Ozaukee County', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '10', 'District 10 — Ozaukee/Washington border', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '11', 'District 11 — Washington County (east)', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '12', 'District 12 — Washington County (west)', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '13', 'District 13 — Fond du Lac (east)', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '14', 'District 14 — Fond du Lac (west)', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '15', 'District 15 — Winnebago (north)', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '16', 'District 16 — Winnebago / Oshkosh', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '17', 'District 17 — Winnebago (south)', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '18', 'District 18 — Calumet, Manitowoc', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '19', 'District 19 — Brown County (east)', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '20', 'District 20 — Green Bay (west)', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '21', 'District 21 — Green Bay (central)', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '22', 'District 22 — Brown County (south)', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '23', 'District 23 — Outagamie County (north)', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '24', 'District 24 — Appleton (east)', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '25', 'District 25 — Appleton (west)', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '26', 'District 26 — Outagamie (south)', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '27', 'District 27 — Shawano, Menominee', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '28', 'District 28 — Oconto, southern Marinette', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '29', 'District 29 — Langlade, Lincoln, Oneida', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '30', 'District 30 — Marathon (north)', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '31', 'District 31 — Wausau / Marathon (central)', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '32', 'District 32 — Marathon (south)', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '33', 'District 33 — Portage, Waushara', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '34', 'District 34 — Waupaca County', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '35', 'District 35 — Marquette, Green Lake, Waushara', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '36', 'District 36 — Dodge County (east)', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '37', 'District 37 — Dodge County (west)', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '38', 'District 38 — Columbia County', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '39', 'District 39 — Dane County (north)', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '40', 'District 40 — Dane County (NE)', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '41', 'District 41 — Madison (east)', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '42', 'District 42 — Madison (central)', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '43', 'District 43 — Madison (west)', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '44', 'District 44 — Madison (SW)', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '45', 'District 45 — Dane County (south)', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '46', 'District 46 — Dane County (SW)', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '47', 'District 47 — Iowa, Lafayette counties', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '48', 'District 48 — Green, Rock border', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '49', 'District 49 — Janesville (north)', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '50', 'District 50 — Janesville (south) / Rock', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '51', 'District 51 — Walworth County (north)', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '52', 'District 52 — Walworth County (south)', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '53', 'District 53 — Kenosha County (west)', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '54', 'District 54 — Kenosha City', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '55', 'District 55 — Kenosha (north)', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '56', 'District 56 — Racine (south)', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '57', 'District 57 — Racine City', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '58', 'District 58 — Racine (north)', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '59', 'District 59 — Waukesha (south)', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '60', 'District 60 — Waukesha City', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '61', 'District 61 — Waukesha (NE)', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '62', 'District 62 — Waukesha (NW)', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '63', 'District 63 — Jefferson County', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '64', 'District 64 — Jefferson / Waukesha border', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '65', 'District 65 — Milwaukee suburbs (west)', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '66', 'District 66 — Milwaukee suburbs (SW)', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '67', 'District 67 — Milwaukee (south)', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '68', 'District 68 — Milwaukee (south central)', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '69', 'District 69 — Milwaukee (central south)', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '70', 'District 70 — Milwaukee (Walker''s Point)', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '71', 'District 71 — Milwaukee (downtown)', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '72', 'District 72 — Milwaukee (east side)', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '73', 'District 73 — Milwaukee (north central)', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '74', 'District 74 — Milwaukee (northwest)', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '75', 'District 75 — Milwaukee (north)', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '76', 'District 76 — Milwaukee (northeast)', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '77', 'District 77 — Milwaukee (Riverwest)', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '78', 'District 78 — Milwaukee suburbs (north)', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '79', 'District 79 — Milwaukee (Shorewood/Whitefish Bay)', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '80', 'District 80 — Milwaukee suburbs (NW Waukesha)', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '81', 'District 81 — Barron, Polk counties', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '82', 'District 82 — Chippewa, Dunn counties', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '83', 'District 83 — Eau Claire County (east)', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '84', 'District 84 — Eau Claire (city)', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '85', 'District 85 — Eau Claire (west)', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '86', 'District 86 — Trempealeau, Jackson', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '87', 'District 87 — La Crosse County (east)', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '88', 'District 88 — La Crosse (city)', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '89', 'District 89 — La Crosse (west)', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '90', 'District 90 — Crawford, Vernon, Richland', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '91', 'District 91 — Sauk County', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '92', 'District 92 — Juneau, Adams counties', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '93', 'District 93 — Monroe County', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '94', 'District 94 — Buffalo, Pepin, Pierce', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '95', 'District 95 — St. Croix County', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '96', 'District 96 — Hudson / St. Croix (east)', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '97', 'District 97 — Douglas, Washburn', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '98', 'District 98 — Bayfield, Ashland, Iron, Price', 2, NULL),
  ('State Assembly Representative', 'state', 'legislative', '99', 'District 99 — Rusk, Taylor, Clark', 2, NULL);

-- ============================================================
-- SEED DATA: COUNTY OFFICES — MAJOR COUNTIES
-- ============================================================
INSERT INTO offices (name, level, office_type, district_number, district_name, county, term_years, notes) VALUES
  -- Milwaukee County
  ('County Executive',     'county', 'executive',      NULL, 'Milwaukee County', 'Milwaukee', 4, NULL),
  ('County Supervisor',    'county', 'legislative',    NULL, 'Milwaukee County', 'Milwaukee', 4, '18 supervisory districts'),
  ('District Attorney',    'county', 'executive',      NULL, 'Milwaukee County', 'Milwaukee', 4, NULL),
  ('County Sheriff',       'county', 'executive',      NULL, 'Milwaukee County', 'Milwaukee', 4, NULL),
  ('County Clerk',         'county', 'administrative', NULL, 'Milwaukee County', 'Milwaukee', 4, NULL),
  ('County Treasurer',     'county', 'administrative', NULL, 'Milwaukee County', 'Milwaukee', 4, NULL),
  -- Dane County
  ('County Executive',     'county', 'executive',      NULL, 'Dane County',      'Dane',      4, NULL),
  ('County Supervisor',    'county', 'legislative',    NULL, 'Dane County',      'Dane',      4, '37 supervisory districts'),
  ('District Attorney',    'county', 'executive',      NULL, 'Dane County',      'Dane',      4, NULL),
  ('County Sheriff',       'county', 'executive',      NULL, 'Dane County',      'Dane',      4, NULL),
  ('County Clerk',         'county', 'administrative', NULL, 'Dane County',      'Dane',      4, NULL),
  -- Waukesha County
  ('County Executive',     'county', 'executive',      NULL, 'Waukesha County',  'Waukesha',  4, NULL),
  ('District Attorney',    'county', 'executive',      NULL, 'Waukesha County',  'Waukesha',  4, NULL),
  ('County Sheriff',       'county', 'executive',      NULL, 'Waukesha County',  'Waukesha',  4, NULL),
  -- Brown County (Green Bay)
  ('County Executive',     'county', 'executive',      NULL, 'Brown County',     'Brown',     4, NULL),
  ('District Attorney',    'county', 'executive',      NULL, 'Brown County',     'Brown',     4, NULL),
  ('County Sheriff',       'county', 'executive',      NULL, 'Brown County',     'Brown',     4, NULL),
  -- Racine County
  ('County Executive',     'county', 'executive',      NULL, 'Racine County',    'Racine',    4, NULL),
  ('District Attorney',    'county', 'executive',      NULL, 'Racine County',    'Racine',    4, NULL),
  ('County Sheriff',       'county', 'executive',      NULL, 'Racine County',    'Racine',    4, NULL),
  -- Outagamie County (Appleton)
  ('County Executive',     'county', 'executive',      NULL, 'Outagamie County', 'Outagamie', 4, NULL),
  ('District Attorney',    'county', 'executive',      NULL, 'Outagamie County', 'Outagamie', 4, NULL),
  -- Kenosha County
  ('County Executive',     'county', 'executive',      NULL, 'Kenosha County',   'Kenosha',   4, NULL),
  ('District Attorney',    'county', 'executive',      NULL, 'Kenosha County',   'Kenosha',   4, NULL),
  ('County Sheriff',       'county', 'executive',      NULL, 'Kenosha County',   'Kenosha',   4, NULL),
  -- Marathon County (Wausau)
  ('County Chairperson',   'county', 'executive',      NULL, 'Marathon County',  'Marathon',  2, NULL),
  ('District Attorney',    'county', 'executive',      NULL, 'Marathon County',  'Marathon',  4, NULL),
  -- Winnebago County (Oshkosh)
  ('County Executive',     'county', 'executive',      NULL, 'Winnebago County', 'Winnebago', 4, NULL),
  ('District Attorney',    'county', 'executive',      NULL, 'Winnebago County', 'Winnebago', 4, NULL),
  -- La Crosse County
  ('County Chairperson',   'county', 'executive',      NULL, 'La Crosse County', 'La Crosse', 2, NULL),
  ('District Attorney',    'county', 'executive',      NULL, 'La Crosse County', 'La Crosse', 4, NULL),
  ('County Sheriff',       'county', 'executive',      NULL, 'La Crosse County', 'La Crosse', 4, NULL),
  -- Eau Claire County
  ('County Chairperson',   'county', 'executive',      NULL, 'Eau Claire County','Eau Claire', 2, NULL),
  ('District Attorney',    'county', 'executive',      NULL, 'Eau Claire County','Eau Claire', 4, NULL),
  -- Sheboygan County
  ('County Administrator', 'county', 'executive',      NULL, 'Sheboygan County', 'Sheboygan', 4, 'Administrator, not elected executive'),
  ('District Attorney',    'county', 'executive',      NULL, 'Sheboygan County', 'Sheboygan', 4, NULL),
  ('County Sheriff',       'county', 'executive',      NULL, 'Sheboygan County', 'Sheboygan', 4, NULL),
  -- Rock County (Janesville)
  ('County Administrator', 'county', 'executive',      NULL, 'Rock County',      'Rock',      4, NULL),
  ('District Attorney',    'county', 'executive',      NULL, 'Rock County',      'Rock',      4, NULL),
  ('County Sheriff',       'county', 'executive',      NULL, 'Rock County',      'Rock',      4, NULL);

-- ============================================================
-- SEED DATA: KEY MUNICIPAL OFFICES
-- ============================================================
INSERT INTO offices (name, level, office_type, district_number, district_name, county, city, term_years, notes) VALUES
  -- Milwaukee City
  ('Mayor',            'municipal', 'executive',   NULL, 'City of Milwaukee',  'Milwaukee', 'Milwaukee', 4, NULL),
  ('Common Council',   'municipal', 'legislative', NULL, 'City of Milwaukee',  'Milwaukee', 'Milwaukee', 4, '15 aldermanic districts'),
  ('City Comptroller', 'municipal', 'administrative', NULL, 'City of Milwaukee','Milwaukee', 'Milwaukee', 4, NULL),
  ('City Attorney',    'municipal', 'administrative', NULL, 'City of Milwaukee','Milwaukee', 'Milwaukee', 4, NULL),
  ('City Treasurer',   'municipal', 'administrative', NULL, 'City of Milwaukee','Milwaukee', 'Milwaukee', 4, NULL),
  -- Madison City
  ('Mayor',            'municipal', 'executive',   NULL, 'City of Madison',    'Dane',      'Madison',   4, NULL),
  ('Common Council',   'municipal', 'legislative', NULL, 'City of Madison',    'Dane',      'Madison',   4, '20 alder districts'),
  ('City Comptroller', 'municipal', 'administrative', NULL, 'City of Madison',  'Dane',     'Madison',   4, NULL),
  -- Green Bay City
  ('Mayor',            'municipal', 'executive',   NULL, 'City of Green Bay',  'Brown',     'Green Bay', 4, NULL),
  ('Common Council',   'municipal', 'legislative', NULL, 'City of Green Bay',  'Brown',     'Green Bay', 4, '12 districts'),
  -- Kenosha City
  ('Mayor',            'municipal', 'executive',   NULL, 'City of Kenosha',    'Kenosha',   'Kenosha',   4, NULL),
  ('Common Council',   'municipal', 'legislative', NULL, 'City of Kenosha',    'Kenosha',   'Kenosha',   4, '17 districts'),
  -- Racine City
  ('Mayor',            'municipal', 'executive',   NULL, 'City of Racine',     'Racine',    'Racine',    4, NULL),
  ('Common Council',   'municipal', 'legislative', NULL, 'City of Racine',     'Racine',    'Racine',    4, '10 districts'),
  -- Appleton City
  ('Mayor',            'municipal', 'executive',   NULL, 'City of Appleton',   'Outagamie', 'Appleton',  4, NULL),
  ('Common Council',   'municipal', 'legislative', NULL, 'City of Appleton',   'Outagamie', 'Appleton',  4, NULL),
  -- Waukesha City
  ('Mayor',            'municipal', 'executive',   NULL, 'City of Waukesha',   'Waukesha',  'Waukesha',  4, NULL),
  -- Oshkosh City
  ('Mayor',            'municipal', 'executive',   NULL, 'City of Oshkosh',    'Winnebago', 'Oshkosh',   4, NULL),
  -- La Crosse City
  ('Mayor',            'municipal', 'executive',   NULL, 'City of La Crosse',  'La Crosse', 'La Crosse', 4, NULL),
  -- Eau Claire City
  ('Mayor',            'municipal', 'executive',   NULL, 'City of Eau Claire', 'Eau Claire','Eau Claire', 4, NULL),
  -- Janesville City
  ('Mayor',            'municipal', 'executive',   NULL, 'City of Janesville', 'Rock',      'Janesville', 4, NULL),
  -- Superior City
  ('Mayor',            'municipal', 'executive',   NULL, 'City of Superior',   'Douglas',   'Superior',  4, NULL),
  -- Sheboygan City
  ('Mayor',            'municipal', 'executive',   NULL, 'City of Sheboygan',  'Sheboygan', 'Sheboygan', 4, NULL),
  -- Wausau City
  ('Mayor',            'municipal', 'executive',   NULL, 'City of Wausau',     'Marathon',  'Wausau',    4, NULL),
  -- School Boards (major districts)
  ('School Board Member', 'municipal', 'legislative', NULL, 'Milwaukee Public Schools',           'Milwaukee', 'Milwaukee', 4, '9 member board'),
  ('School Board Member', 'municipal', 'legislative', NULL, 'Madison Metropolitan School District','Dane',      'Madison',   4, '7 member board'),
  ('School Board Member', 'municipal', 'legislative', NULL, 'Green Bay Area Public Schools',       'Brown',     'Green Bay', 4, NULL),
  ('School Board Member', 'municipal', 'legislative', NULL, 'Kenosha Unified School District',     'Kenosha',   'Kenosha',   4, NULL),
  ('School Board Member', 'municipal', 'legislative', NULL, 'Racine Unified School District',      'Racine',    'Racine',    4, NULL),
  ('School Board Member', 'municipal', 'legislative', NULL, 'Waukesha School District',            'Waukesha',  'Waukesha',  4, NULL),
  ('School Board Member', 'municipal', 'legislative', NULL, 'Appleton Area School District',       'Outagamie', 'Appleton',  4, NULL);
