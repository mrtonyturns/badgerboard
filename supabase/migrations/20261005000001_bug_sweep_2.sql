-- Oct 5 bug sweep, part 2 — DB hardening. Idempotent; safe to re-run.
--
--   1. Cap-trigger races. enforce_scout_candidate_cap / enforce_monitoring_cap
--      counted the caller's rows with a plain SELECT: two concurrent requests
--      (two tabs, a double-click, a bulk import) each saw n < cap and both
--      committed. Each trigger now takes a per-owner transaction advisory lock
--      before counting, so concurrent writers for the SAME owner serialise and
--      the second one's count (fresh snapshot under READ COMMITTED) sees the
--      first one's row. Different owners never contend. Bodies are otherwise
--      unchanged from 20260812000040 (scout) and 20261005000000 (monitoring).
--   2. candidates.ai_access_notes / ai_access_locked_at could be flipped by the
--      owner straight through PostgREST (candidates_update_own allows any
--      column), skipping candidate-ai-lock.js's grace-window / password
--      re-check — and forging ai_access_locked_at = now() would even re-open
--      the no-password grace window. A BEFORE UPDATE trigger now rejects any
--      change to either column unless the JWT role is service_role (the lock
--      endpoint) or there are no JWT claims at all (direct DB / migrations).
--   3. exec_sql (called by admin-setup-candidate-storage.js) is defined in no
--      migration; if a hand-made copy exists, Supabase's default privileges
--      gave EXECUTE to anon + authenticated — arbitrary SQL for anyone. Lock
--      every overload down to service_role.
--   4. voters UPDATE WITH CHECK only checked created_by, so a user could move
--      their own voter rows onto ANOTHER user's voter_list (polluting lists
--      that service-role jobs such as recruitment read by voter_list_id). The
--      target list must now be the caller's (or NULL).
--   5. The baseline's "Authenticated users can … USING (true)" policies on
--      dossiers / prospecting_lists / activity_log were only ever dropped by
--      the hand-run migration_v5 file, so a chain-built database (db reset,
--      branches, new environments) let every user read/write everyone's rows.
--      Drop them. Owner-scoped replacements: dossiers_*_own (20260704000004 +
--      20261005000000), prospecting_*_own (20260422000005); activity_log had
--      none in the chain (v5's lived only on prod), so the v5 owner policies
--      are created here when missing — no-op on prod.

-- ── 1a. Scout candidate cap: serialise per owner ────────────────────────────
CREATE OR REPLACE FUNCTION enforce_scout_candidate_cap()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  jwt jsonb;
  plan text;
  email text;
  n int;
BEGIN
  jwt := NULLIF(current_setting('request.jwt.claims', true), '')::jsonb;
  IF jwt IS NULL THEN RETURN NEW; END IF;
  -- Service role: backend functions manage their own entitlements.
  IF coalesce(jwt ->> 'role', '') IN ('service_role', 'supabase_admin') THEN RETURN NEW; END IF;

  email := lower(coalesce(jwt ->> 'email', ''));
  IF email IN ('tony@bluejackgroup.com', 'tony@thebluejackgroup.com', 'tom@thebluejackgroup.com') THEN
    RETURN NEW;
  END IF;

  -- Beta mode grants full access (mirrors _entitlements.js beta branch).
  IF coalesce(jwt -> 'app_metadata' ->> 'beta_mode', '') = 'true' THEN RETURN NEW; END IF;

  plan := coalesce(jwt -> 'app_metadata' ->> 'plan', 'scout');
  -- Active trial (FLAT shape: trial_plan / trial_ends_at) lifts the cap.
  IF (jwt -> 'app_metadata' ->> 'trial_ends_at') IS NOT NULL
     AND (jwt -> 'app_metadata' ->> 'trial_ends_at')::timestamptz > now()
     AND coalesce(jwt -> 'app_metadata' ->> 'trial_plan', '') <> '' THEN
    plan := jwt -> 'app_metadata' ->> 'trial_plan';
  END IF;
  -- Legacy aliases (mirrors _entitlements.js)
  plan := CASE plan
    WHEN 'monitor'  THEN 'c_monitor'
    WHEN 'campaign' THEN 'a_campaign'
    WHEN 'agency'   THEN 'a_campaign'
    ELSE plan
  END;
  IF plan <> 'scout' THEN RETURN NEW; END IF;

  -- Serialise concurrent inserts for this owner (released at commit/rollback).
  PERFORM pg_advisory_xact_lock(hashtext(NEW.created_by::text));

  SELECT count(*) INTO n FROM candidates WHERE created_by = NEW.created_by;
  IF n >= 2 THEN
    RAISE EXCEPTION 'Scout plans track up to 2 candidates. Upgrade to add more.'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

-- ── 1b. Monitoring cap: serialise per owner ─────────────────────────────────
CREATE OR REPLACE FUNCTION enforce_monitoring_cap()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  jwt jsonb;
  email text;
  plan text;
  lim int;
  n int;
  turning_on boolean;
BEGIN
  turning_on := coalesce((NEW.section_timestamps ->> 'monitoring') = 'true', false)
            AND (TG_OP = 'INSERT'
                 OR coalesce(OLD.section_timestamps ->> 'monitoring', '') <> 'true');
  IF NOT turning_on THEN RETURN NEW; END IF;

  jwt := NULLIF(current_setting('request.jwt.claims', true), '')::jsonb;
  IF jwt IS NULL THEN RETURN NEW; END IF;
  IF coalesce(jwt ->> 'role', '') IN ('service_role', 'supabase_admin') THEN RETURN NEW; END IF;

  email := lower(coalesce(jwt ->> 'email', ''));
  IF email IN ('tony@bluejackgroup.com', 'tony@thebluejackgroup.com', 'tom@thebluejackgroup.com') THEN
    RETURN NEW;
  END IF;

  IF coalesce(jwt -> 'app_metadata' ->> 'beta_mode', '') = 'true' THEN RETURN NEW; END IF;

  plan := coalesce(jwt -> 'app_metadata' ->> 'plan', 'scout');
  IF (jwt -> 'app_metadata' ->> 'trial_ends_at') IS NOT NULL
     AND (jwt -> 'app_metadata' ->> 'trial_ends_at')::timestamptz > now()
     AND coalesce(jwt -> 'app_metadata' ->> 'trial_plan', '') <> '' THEN
    plan := jwt -> 'app_metadata' ->> 'trial_plan';
  END IF;
  plan := CASE plan
    WHEN 'monitor'  THEN 'c_monitor'
    WHEN 'campaign' THEN 'a_campaign'
    WHEN 'agency'   THEN 'a_campaign'
    ELSE plan
  END;

  lim := CASE plan
    WHEN 'scout'      THEN 0
    WHEN 'c_monitor'  THEN 0
    WHEN 'c_active'   THEN 1
    WHEN 'c_campaign' THEN 3
    ELSE NULL  -- action plans / unknown paid: unlimited
  END;
  IF lim IS NULL THEN RETURN NEW; END IF;

  -- Serialise concurrent monitoring toggles for this owner.
  PERFORM pg_advisory_xact_lock(hashtext(NEW.created_by::text));

  SELECT count(*) INTO n FROM candidates
  WHERE created_by = NEW.created_by
    AND id <> NEW.id
    AND (section_timestamps ->> 'monitoring') = 'true';

  IF n >= lim THEN
    RAISE EXCEPTION 'Your plan includes % active monitoring slot%. Turn monitoring off on another candidate or upgrade.',
      lim, CASE WHEN lim = 1 THEN '' ELSE 's' END
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
-- (Triggers scout_candidate_cap / monitoring_cap already point at these.)

-- ── 2. AI access lock columns: service role only ────────────────────────────
-- Not SECURITY DEFINER on purpose: current_user must stay the caller's role so
-- a request with no claims GUC but an API role is still refused.
CREATE OR REPLACE FUNCTION guard_candidate_ai_lock()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  jwt  jsonb;
  role text;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.ai_access_notes     IS NOT DISTINCT FROM OLD.ai_access_notes
     AND NEW.ai_access_locked_at IS NOT DISTINCT FROM OLD.ai_access_locked_at THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' AND NEW.ai_access_notes IS NULL AND NEW.ai_access_locked_at IS NULL THEN
    RETURN NEW;
  END IF;

  jwt  := NULLIF(current_setting('request.jwt.claims', true), '')::jsonb;
  role := coalesce(NULLIF(jwt ->> 'role', ''),
                   NULLIF(current_setting('request.jwt.claim.role', true), ''));

  -- INSERT from an API role: reset to the defaults (NULL = follow the org AI
  -- default) rather than erroring — no client path sets these on create, and a
  -- forged future ai_access_locked_at would open the no-password grace window.
  IF TG_OP = 'INSERT' AND coalesce(role, '') NOT IN ('service_role', 'supabase_admin')
     AND (role IS NOT NULL OR current_user IN ('anon', 'authenticated')) THEN
    NEW.ai_access_notes := NULL;
    NEW.ai_access_locked_at := NULL;
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN RETURN NEW; END IF;

  IF role IS NULL THEN
    -- No JWT at all: direct DB session (SQL editor, migrations, cron) — allowed,
    -- unless the session itself is running as an API role.
    IF current_user IN ('anon', 'authenticated') THEN
      RAISE EXCEPTION 'AI access lock can only be changed through the AI lock endpoint.'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF role IN ('service_role', 'supabase_admin') THEN RETURN NEW; END IF;

  RAISE EXCEPTION 'AI access lock can only be changed through the AI lock endpoint.'
    USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS candidates_ai_lock_guard ON candidates;
CREATE TRIGGER candidates_ai_lock_guard
  BEFORE INSERT OR UPDATE ON candidates
  FOR EACH ROW EXECUTE FUNCTION guard_candidate_ai_lock();

-- ── 3. exec_sql: service role only (every overload, if any exist) ───────────
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'exec_sql'
  LOOP
    EXECUTE format('REVOKE EXECUTE ON ROUTINE %s FROM PUBLIC, anon, authenticated', r.sig);
    EXECUTE format('GRANT EXECUTE ON ROUTINE %s TO service_role', r.sig);
  END LOOP;
END $$;

-- ── 4. voters UPDATE: the row must stay on one of the caller's lists ────────
-- Legacy UPDATE-capable policies (v2 / v5 / 004 names) are dropped too: RLS
-- policies are OR-ed, so any survivor would bypass the new WITH CHECK.
DROP POLICY IF EXISTS "Auth users update voters"  ON public.voters;
DROP POLICY IF EXISTS "Users update own voters"   ON public.voters;
DROP POLICY IF EXISTS "Users manage own voters"   ON public.voters;
DROP POLICY IF EXISTS "voters_update_own"         ON public.voters;
CREATE POLICY "voters_update_own"
  ON public.voters FOR UPDATE
  USING (created_by = auth.uid())
  WITH CHECK (
    created_by = auth.uid()
    AND (voter_list_id IS NULL
         OR voter_list_id IN (SELECT id FROM public.voter_lists WHERE created_by = auth.uid()))
  );

-- ── 5. Baseline permissive policies ─────────────────────────────────────────
-- activity_log first: make sure owner-scoped SELECT/INSERT exist (the app's
-- logActivity / getRecentActivity) before the open ones go. Names match
-- migration_v5 so prod (which already has them) skips creation.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname = 'public' AND tablename = 'activity_log'
                   AND policyname = 'Users read own activity') THEN
    CREATE POLICY "Users read own activity"
      ON public.activity_log FOR SELECT TO authenticated
      USING (user_id = auth.uid());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname = 'public' AND tablename = 'activity_log'
                   AND policyname = 'Users insert own activity') THEN
    CREATE POLICY "Users insert own activity"
      ON public.activity_log FOR INSERT TO authenticated
      WITH CHECK (user_id = auth.uid());
  END IF;
END $$;

DROP POLICY IF EXISTS "Authenticated users can read dossiers"   ON public.dossiers;
DROP POLICY IF EXISTS "Authenticated users can insert dossiers" ON public.dossiers;
DROP POLICY IF EXISTS "Authenticated users can update dossiers" ON public.dossiers;
DROP POLICY IF EXISTS "Authenticated users can delete dossiers" ON public.dossiers;

DROP POLICY IF EXISTS "Authenticated users can read prospecting_lists"   ON public.prospecting_lists;
DROP POLICY IF EXISTS "Authenticated users can insert prospecting_lists" ON public.prospecting_lists;
DROP POLICY IF EXISTS "Authenticated users can update prospecting_lists" ON public.prospecting_lists;
DROP POLICY IF EXISTS "Authenticated users can delete prospecting_lists" ON public.prospecting_lists;

DROP POLICY IF EXISTS "Authenticated users can read activity_log"   ON public.activity_log;
DROP POLICY IF EXISTS "Authenticated users can insert activity_log" ON public.activity_log;
