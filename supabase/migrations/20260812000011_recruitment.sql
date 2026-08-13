-- Recruit-from-voter-list (RECRUIT-from-voterlist-gameplan.md §6).
--
-- v1 is Tier A: COLUMN-FIRST district matching. The official WEC
-- "Badger Voters"/WisVote export already carries Ward, County Supervisory
-- District, Aldermanic District and School District as plain strings, so a seat
-- is matched by comparing the CSV's own column against the office's district.
-- No geocoding, no point-in-polygon, no new map geometry in this migration.
-- (Tier B — real ward/supervisory/aldermanic polygons + geocoded
-- point-in-polygon — is a DEFERRED fast-follow; it would add lat/lng plumbing
-- and a `match_method = 'geocode_point_in_polygon'` path, both already allowed
-- for below.)
--
-- Idempotent / non-destructive: safe to run repeatedly and on environments
-- that were built from any earlier baseline.

BEGIN;

-- ─── 1. voters: the district columns the WEC export carries ──────────────────
-- Additive only. Lists uploaded before this migration keep working; their new
-- columns are simply NULL and the UI shows the "re-export with these columns"
-- banner instead of a seat-level match.
ALTER TABLE voters ADD COLUMN IF NOT EXISTS county_supervisory_district TEXT;
ALTER TABLE voters ADD COLUMN IF NOT EXISTS aldermanic_district         TEXT;
ALTER TABLE voters ADD COLUMN IF NOT EXISTS school_district             TEXT;
-- `ward` already exists in 004_voter_and_incumbent_tables.sql; this is a no-op
-- there and a convergence fix for environments built from migration_v2.sql.
ALTER TABLE voters ADD COLUMN IF NOT EXISTS ward                        TEXT;

-- Seat-level lookups scan one list at a time, so the list id leads each index.
CREATE INDEX IF NOT EXISTS idx_voters_list_supervisory
  ON voters (voter_list_id, county_supervisory_district);
CREATE INDEX IF NOT EXISTS idx_voters_list_aldermanic
  ON voters (voter_list_id, aldermanic_district);
CREATE INDEX IF NOT EXISTS idx_voters_list_school
  ON voters (voter_list_id, school_district);

-- ─── 2. recruitment_searches ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.recruitment_searches (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                     TEXT NOT NULL,              -- auto: "Marathon Co. Board Dist. 4 — Aug 2026"
  voter_list_id            UUID REFERENCES voter_lists(id) ON DELETE SET NULL,

  -- Office scope / district filter. `office_scope` is the durable record of what
  -- the user picked ({ office_type, district_column, district_value, county,
  -- city, office_ids }); the flat columns below exist so the common filters are
  -- indexable and readable in SQL.
  office_scope             JSONB   NOT NULL DEFAULT '{}'::jsonb,
  office_type              TEXT,                       -- county_board | city_council | village_board | town_board | school_board
  district_level           TEXT CHECK (district_level IN ('county','municipal','school')),
  district_key             TEXT,                       -- e.g. 'county:Marathon' / 'muni:Wausau city'
  district_column          TEXT,                       -- the `voters` column matched against
  district_value           TEXT,                       -- the matched value (e.g. '4', 'Wausau School District')
  office_id                UUID REFERENCES offices(id),-- nullable = "any seat of this type in the district"

  match_method             TEXT CHECK (match_method IN ('csv_column','geocode_point_in_polygon')) DEFAULT 'csv_column',
  total_matched            INTEGER DEFAULT 0,
  status                   TEXT CHECK (status IN ('matching','ready','researching','done','error')) DEFAULT 'matching',
  research_requested_count INTEGER DEFAULT 0,
  research_completed_count INTEGER DEFAULT 0,
  quota_snapshot           JSONB,                      -- plan/bracket/remaining at run time (audit trail)
  attested_use             BOOLEAN DEFAULT false,      -- §4 run-time attestation
  attested_at              TIMESTAMPTZ,
  created_by               UUID REFERENCES auth.users(id),
  created_at               TIMESTAMPTZ DEFAULT now(),
  updated_at               TIMESTAMPTZ DEFAULT now()
);

-- Columns added after the first cut of this table ship as no-ops on a fresh create.
ALTER TABLE public.recruitment_searches ADD COLUMN IF NOT EXISTS office_scope     JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.recruitment_searches ADD COLUMN IF NOT EXISTS office_type      TEXT;
ALTER TABLE public.recruitment_searches ADD COLUMN IF NOT EXISTS district_column  TEXT;
ALTER TABLE public.recruitment_searches ADD COLUMN IF NOT EXISTS district_value   TEXT;
ALTER TABLE public.recruitment_searches ADD COLUMN IF NOT EXISTS updated_at       TIMESTAMPTZ DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_recruitment_searches_creator ON public.recruitment_searches (created_by, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_recruitment_searches_list    ON public.recruitment_searches (voter_list_id);

-- ─── 3. recruitment_prospects ────────────────────────────────────────────────
-- One row per confirmed resident in the search. Voter identity fields are
-- COPIED (not just referenced) so a search survives its source list being
-- deleted, and so the research pipeline never has to join back into `voters`.
--
-- Protected attributes (race, religion, national origin, disability, sexual
-- orientation/gender identity, immigration status, health, and criminal history
-- unrelated to public civic conduct) are NEVER researched and have no column
-- here by design — see gameplan §4.
CREATE TABLE IF NOT EXISTS public.recruitment_prospects (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  search_id              UUID REFERENCES public.recruitment_searches(id) ON DELETE CASCADE,
  voter_id               UUID REFERENCES voters(id) ON DELETE SET NULL,

  -- voter row identity (copied at match time)
  full_name              TEXT,
  first_name             TEXT,
  last_name              TEXT,
  address                TEXT,
  city                   TEXT,
  zip                    TEXT,
  county                 TEXT,
  ward                   TEXT,
  district_value         TEXT,                          -- the seat value this person matched on
  matched_office_ids     UUID[] DEFAULT '{}',

  -- research output (all default to unknown; thin evidence keeps them unknown)
  affiliation_value      TEXT CHECK (affiliation_value IN ('republican','democrat','independent','other','unknown')) DEFAULT 'unknown',
  affiliation_confidence INTEGER CHECK (affiliation_confidence IS NULL OR (affiliation_confidence BETWEEN 0 AND 100)),
  affiliation_basis      TEXT,
  notoriety              TEXT CHECK (notoriety IN ('high','medium','low','unknown')) DEFAULT 'unknown',
  sentiment              TEXT CHECK (sentiment IN ('positive','mixed','negative','unknown')) DEFAULT 'unknown',
  evidence               JSONB DEFAULT '[]'::jsonb,     -- [{ title, url }] — URLs only ever come from the citations array
  research_summary       TEXT,
  research_status        TEXT CHECK (research_status IN ('pending','researching','done','error','skipped_quota')) DEFAULT 'pending',
  research_error         TEXT,
  research_cache_key     TEXT,                          -- hash(normalize(name+city+zip)) — cross-search reuse
  model_version          TEXT,
  researched_at          TIMESTAMPTZ,
  excluded               BOOLEAN DEFAULT false,         -- manual user exclude
  created_by             UUID REFERENCES auth.users(id),
  created_at             TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.recruitment_prospects ADD COLUMN IF NOT EXISTS research_error TEXT;
ALTER TABLE public.recruitment_prospects ADD COLUMN IF NOT EXISTS model_version  TEXT;
ALTER TABLE public.recruitment_prospects ADD COLUMN IF NOT EXISTS district_value TEXT;

CREATE INDEX IF NOT EXISTS idx_recruitment_prospects_search   ON public.recruitment_prospects (search_id);
CREATE INDEX IF NOT EXISTS idx_recruitment_prospects_cachekey ON public.recruitment_prospects (research_cache_key);
CREATE INDEX IF NOT EXISTS idx_recruitment_prospects_status   ON public.recruitment_prospects (search_id, research_status);
CREATE INDEX IF NOT EXISTS idx_recruitment_prospects_creator  ON public.recruitment_prospects (created_by);

-- ─── 4. recruitment_research_progress ────────────────────────────────────────
-- recruit-research-background.js is a Netlify BACKGROUND function: Netlify
-- answers the browser with 202 BEFORE the handler runs, so every status code it
-- returns is discarded. This row is the run's only durable output channel —
-- exactly the pattern dossier_generation_progress (Profiler) and
-- district_events_progress (Events) already use. The function writes it at every
-- phase boundary AND on every terminal error; the client polls it.
CREATE TABLE IF NOT EXISTS public.recruitment_research_progress (
  search_id  UUID PRIMARY KEY REFERENCES public.recruitment_searches(id) ON DELETE CASCADE,
  stage      INTEGER     NOT NULL DEFAULT 1,          -- 1 prepare · 2 search · 3 structure · 4 save
  status     TEXT        NOT NULL DEFAULT 'running',  -- running | done | error
  message    TEXT,                                    -- human-readable reason when status = 'error'
  processed  INTEGER     NOT NULL DEFAULT 0,
  total      INTEGER     NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── 5. RLS — owner-scoped throughout ────────────────────────────────────────
-- Mirrors the WITH CHECK hardening applied to voters/turf_blocks in
-- 20260705000002: creator-owns-row, no cross-tenant reads OR writes.
ALTER TABLE public.recruitment_searches          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recruitment_prospects         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recruitment_research_progress ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "recruitment_searches_owner" ON public.recruitment_searches;
CREATE POLICY "recruitment_searches_owner" ON public.recruitment_searches
  FOR ALL USING (created_by = auth.uid())
  WITH CHECK (created_by = auth.uid());

-- Prospects are owned directly AND fenced by their parent search, so a row can
-- never be attached to somebody else's search even with a forged created_by.
DROP POLICY IF EXISTS "recruitment_prospects_owner" ON public.recruitment_prospects;
CREATE POLICY "recruitment_prospects_owner" ON public.recruitment_prospects
  FOR ALL USING (
    created_by = auth.uid()
    AND (search_id IS NULL OR search_id IN (SELECT id FROM public.recruitment_searches WHERE created_by = auth.uid()))
  )
  WITH CHECK (
    created_by = auth.uid()
    AND (search_id IS NULL OR search_id IN (SELECT id FROM public.recruitment_searches WHERE created_by = auth.uid()))
  );

-- Progress: the owner of the search may read it. Writes are service-role only
-- (the background function), which bypasses RLS.
DROP POLICY IF EXISTS "recruitment_research_progress_select_own" ON public.recruitment_research_progress;
CREATE POLICY "recruitment_research_progress_select_own"
  ON public.recruitment_research_progress FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.recruitment_searches s
    WHERE s.id = search_id AND s.created_by = auth.uid()
  ));

COMMIT;

-- ─── Retention (gameplan §4) ─────────────────────────────────────────────────
-- 12-month purge of the RESEARCH fields only (affiliation_*, notoriety,
-- sentiment, evidence, research_summary) is a scheduled-function follow-up
-- (precedent: trial-expiry.js). Deliberately NOT a trigger here — deleting a
-- user's data on a schedule belongs in code that can be audited and disabled.
