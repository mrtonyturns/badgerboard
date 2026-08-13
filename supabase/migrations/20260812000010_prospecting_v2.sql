-- ============================================================================
-- Prospecting v2 — discover → enrich → score → export
-- Migration: 20260812000010_prospecting_v2
-- ============================================================================
-- Backs the rebuilt Prospecting page (src/pages/Prospecting.jsx) and the
-- background enrichment engine (netlify/functions/enrich-prospects-background.js).
--
-- Two tables:
--   prospect_profiles                — one enriched prospect per owner
--   prospecting_enrichment_progress  — per-run progress the client polls
--
-- Everything is owner-scoped through created_by (same shape as candidates,
-- prospecting_lists, gp_projects). Everything is idempotent / non-destructive:
-- CREATE TABLE IF NOT EXISTS, ADD COLUMN IF NOT EXISTS, DROP POLICY IF EXISTS
-- before CREATE POLICY. Safe to run more than once.
--
-- ── COMPLIANCE: NO CFIS DATA IS STORED BY THIS SCHEMA ───────────────────────
-- Wis. Stat. §11.1304(12): "No information copied from such reports and
-- statements may be sold or utilized by any person for any commercial
-- purpose." That covers WEC/CFIS committee emails, treasurer names, addresses
-- and itemized disbursements — i.e. exactly the data the redesign game plan
-- proposed using for contact discovery and agency detection.
--
-- Per the owner's directive this migration deliberately defines NO column for
-- CFIS-derived contact data or vendor/disbursement records. Agency detection is
-- built entirely from web-visible signals (site "paid for by" lines, footer
-- vendor credits, staff pages, ActBlue/WinRed/NGP VAN/EveryAction embeds,
-- Meta Ad Library presence surfaced through cited web research). Contact data
-- comes only from the candidate's own published pages and cited news coverage.
--
-- EXTENSION POINT (do not enable without a written legal read):
--   ALTER TABLE public.prospect_profiles
--     ADD COLUMN IF NOT EXISTS cfis_signals JSONB;   -- vendor/disbursement matches
--   Gate any such column behind an internal-only flag and keep it out of every
--   export path (see buildProspectCsv in src/lib/prospectCsv.js) until counsel
--   answers the three questions in PROSPECTING-redesign-gameplan.md §5.
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────────
-- 1. PROSPECT PROFILES
--    A prospect is either a row in the owner's candidates table (candidate_id
--    set — the normal path, "discover" filters the candidates DB) or a
--    standalone prospect (candidate_id NULL — CSV/manual entries that have not
--    been promoted to a candidate record yet).
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.prospect_profiles (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by        UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  candidate_id      UUID        REFERENCES public.candidates(id) ON DELETE CASCADE,

  -- Identity snapshot (kept denormalized so a deleted candidate row does not
  -- blank an exported list, and so standalone prospects work at all)
  name              TEXT        NOT NULL,
  office_name       TEXT,
  district_name     TEXT,
  county            TEXT,
  level             TEXT,                       -- federal | state | county | municipal
  election_id       UUID        REFERENCES public.elections(id) ON DELETE SET NULL,
  election_date     DATE,
  party             TEXT,                       -- declared party from candidates.party, if any

  -- ── Win odds (transparent model — netlify/functions/_win-odds.js) ─────────
  win_odds_score    NUMERIC(5,2),               -- 0–100, NULL when unmeasurable
  win_odds_band     TEXT,                       -- strong | competitive | longshot | unknown
  win_odds_factors  JSONB       NOT NULL DEFAULT '{}'::jsonb,
  -- { model_version, confidence, unavailable[], factors:[{key,label,weight,
  --   weight_applied,value,points,available,enabled,basis,source}] }

  -- ── Affiliation ───────────────────────────────────────────────────────────
  -- affiliation is the label shown in the UI; affiliation_detail records
  -- whether it is a CONFIRMED filing (candidates.party / ballot) or an
  -- INFERENCE, with confidence + basis. Never conflate the two.
  affiliation        TEXT,                      -- Republican | Democrat | Independent | Nonpartisan | conservative | liberal | unknown
  affiliation_detail JSONB      NOT NULL DEFAULT '{}'::jsonb,
  -- { inferred bool, confidence 0-100, basis text, source text, source_url text }

  -- ── Website (tri-state per game plan §4c) ────────────────────────────────
  has_website       BOOLEAN,                    -- NULL = not checked yet
  website_url       TEXT,
  website_state     TEXT,                       -- yes | facebook_only | no | unknown
  website_verified_at TIMESTAMPTZ,              -- last successful server-side fetch
  website_status    INTEGER,                    -- HTTP status of that fetch

  -- ── Socials ───────────────────────────────────────────────────────────────
  socials           JSONB       NOT NULL DEFAULT '{}'::jsonb,
  -- { facebook, instagram, x, linkedin, tiktok }  (URL string or null each)

  -- ── Agency signals (web-visible evidence ONLY — see the compliance note) ──
  agency_signals    JSONB       NOT NULL DEFAULT '{"detected": false, "evidence": []}'::jsonb,
  -- { detected bool, confidence 0-100,
  --   evidence: [{ type, detail, url, source }] }
  -- type ∈ paid_for_by | vendor_credit | staff_page | platform_embed |
  --        ad_library | press_mention

  -- ── Contact (compliant sources only) ─────────────────────────────────────
  contact           JSONB       NOT NULL DEFAULT '{}'::jsonb,
  -- { emails: [{ value, source, source_url, confidence }],
  --   phones: [{ value, source, source_url, confidence }],
  --   source: 'candidate_website' | 'web_research' | 'candidates_db',
  --   confidence: 0-100 }

  -- ── Pipeline bookkeeping ─────────────────────────────────────────────────
  discovery_source  TEXT,                       -- candidates_db | csv_import | manual
  discovered_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  enriched_at       TIMESTAMPTZ,
  enrichment_status TEXT        NOT NULL DEFAULT 'pending',
  enrichment_error  TEXT,
  last_run_id       UUID,
  research_citations JSONB      NOT NULL DEFAULT '[]'::jsonb,  -- [{ label, url }]

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Status vocabulary, added separately so re-running the migration on an older
-- table still installs the constraint.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'prospect_profiles_status_chk'
  ) THEN
    ALTER TABLE public.prospect_profiles
      ADD CONSTRAINT prospect_profiles_status_chk
      CHECK (enrichment_status IN ('pending','running','enriched','partial','error'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'prospect_profiles_website_state_chk'
  ) THEN
    ALTER TABLE public.prospect_profiles
      ADD CONSTRAINT prospect_profiles_website_state_chk
      CHECK (website_state IS NULL OR website_state IN ('yes','facebook_only','no','unknown'));
  END IF;
END $$;

-- One profile per candidate per owner. Partial index so standalone prospects
-- (candidate_id NULL) are never collapsed together.
CREATE UNIQUE INDEX IF NOT EXISTS prospect_profiles_owner_candidate_uniq
  ON public.prospect_profiles (created_by, candidate_id)
  WHERE candidate_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS prospect_profiles_owner_idx
  ON public.prospect_profiles (created_by);
CREATE INDEX IF NOT EXISTS prospect_profiles_status_idx
  ON public.prospect_profiles (created_by, enrichment_status);
CREATE INDEX IF NOT EXISTS prospect_profiles_score_idx
  ON public.prospect_profiles (created_by, win_odds_score DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS prospect_profiles_run_idx
  ON public.prospect_profiles (last_run_id);

-- ────────────────────────────────────────────────────────────────────────────
-- 2. ENRICHMENT PROGRESS
--    Same contract as dossier_generation_progress (20260721000003) and
--    district_events_progress (20260812000001): enrich-prospects-background.js
--    is a Netlify BACKGROUND function, so Netlify answers the browser 202
--    BEFORE the handler runs and every status code the handler returns is
--    discarded. This row is the run's only durable output channel — the
--    function writes it at each phase boundary AND on every terminal outcome
--    (403, 429, provider failure, uncaught throw), and the page polls it.
--
--    Keyed by run_id (not prospect_id) because enrichment is batched: one run
--    walks up to 10 prospects and the UI shows one progress bar.
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.prospecting_enrichment_progress (
  run_id       UUID        PRIMARY KEY,
  created_by   UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  stage        INTEGER     NOT NULL DEFAULT 1,        -- 1 scoring · 2 research · 3 verification · 4 saving
  status       TEXT        NOT NULL DEFAULT 'running',-- running | done | error
  message      TEXT,                                  -- human-readable reason when status = 'error'
  total        INTEGER     NOT NULL DEFAULT 0,
  completed    INTEGER     NOT NULL DEFAULT 0,
  failed       INTEGER     NOT NULL DEFAULT 0,
  current_name TEXT,                                  -- prospect being worked on right now
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'prospecting_progress_status_chk'
  ) THEN
    ALTER TABLE public.prospecting_enrichment_progress
      ADD CONSTRAINT prospecting_progress_status_chk
      CHECK (status IN ('running','done','error'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS prospecting_progress_owner_idx
  ON public.prospecting_enrichment_progress (created_by, updated_at DESC);

-- ────────────────────────────────────────────────────────────────────────────
-- 3. ROW LEVEL SECURITY
--    Owner-scoped on both tables. Prospect profiles are fully manageable by
--    their owner (the Discover tab inserts them client-side). Progress rows are
--    READ-ONLY to the owner and written by the service role only — the client
--    must never be able to fake a "done" that no run produced.
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.prospect_profiles                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prospecting_enrichment_progress  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS prospect_profiles_select_own ON public.prospect_profiles;
CREATE POLICY prospect_profiles_select_own
  ON public.prospect_profiles FOR SELECT TO authenticated
  USING (created_by = auth.uid());

DROP POLICY IF EXISTS prospect_profiles_insert_own ON public.prospect_profiles;
CREATE POLICY prospect_profiles_insert_own
  ON public.prospect_profiles FOR INSERT TO authenticated
  WITH CHECK (created_by = auth.uid());

DROP POLICY IF EXISTS prospect_profiles_update_own ON public.prospect_profiles;
CREATE POLICY prospect_profiles_update_own
  ON public.prospect_profiles FOR UPDATE TO authenticated
  USING (created_by = auth.uid())
  WITH CHECK (created_by = auth.uid());

DROP POLICY IF EXISTS prospect_profiles_delete_own ON public.prospect_profiles;
CREATE POLICY prospect_profiles_delete_own
  ON public.prospect_profiles FOR DELETE TO authenticated
  USING (created_by = auth.uid());

-- Progress: owner may read; no INSERT/UPDATE/DELETE policy exists, so
-- authenticated clients cannot write it at all (service role bypasses RLS).
DROP POLICY IF EXISTS prospecting_progress_select_own ON public.prospecting_enrichment_progress;
CREATE POLICY prospecting_progress_select_own
  ON public.prospecting_enrichment_progress FOR SELECT TO authenticated
  USING (created_by = auth.uid());

-- ────────────────────────────────────────────────────────────────────────────
-- 4. updated_at maintenance
--    Reuses the shared trigger function if this database already has one;
--    creates a local one if not. Trigger creation is guarded so re-runs are
--    no-ops rather than errors.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.prospecting_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS prospect_profiles_touch ON public.prospect_profiles;
CREATE TRIGGER prospect_profiles_touch
  BEFORE UPDATE ON public.prospect_profiles
  FOR EACH ROW EXECUTE FUNCTION public.prospecting_touch_updated_at();

DROP TRIGGER IF EXISTS prospecting_progress_touch ON public.prospecting_enrichment_progress;
CREATE TRIGGER prospecting_progress_touch
  BEFORE UPDATE ON public.prospecting_enrichment_progress
  FOR EACH ROW EXECUTE FUNCTION public.prospecting_touch_updated_at();
