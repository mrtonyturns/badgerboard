-- URGENT fix to both cap triggers (post-repair audit, Tier 1 item 1).
-- Three defects shipped in 20260812000030/-32:
--   1. Service-role writes were NOT bypassed: PostgREST sets
--      request.jwt.claims for ANY verified JWT including the service key, so
--      the null check never fired. Correct test: role = 'service_role'.
--   2. The trial escape hatch read a nested app_metadata.trial object; the
--      real shape (written by admin-manage-access, read by _entitlements.js)
--      is FLAT: trial_plan / trial_ends_at. Every trial user was capped.
--   3. Beta mode was ignored: beta users keep plan='scout' underneath, so
--      they were capped at 2 candidates and 0 monitoring slots. LIVE BUG.
-- Idempotent (CREATE OR REPLACE; triggers already exist).

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

  SELECT count(*) INTO n FROM candidates WHERE created_by = NEW.created_by;
  IF n >= 2 THEN
    RAISE EXCEPTION 'Scout plans track up to 2 candidates. Upgrade to add more.'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

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
  turning_on := (NEW.section_timestamps ->> 'monitoring') = 'true'
            AND coalesce(OLD.section_timestamps ->> 'monitoring', '') <> 'true';
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
