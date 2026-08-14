-- Server-side Active Monitoring cap (closes the last client-only enforcement
-- gap). Limits mirror src/lib/tiers.js activeCandidateLimit:
--   scout 0 · c_monitor 0 · c_active 1 · c_campaign 3 · a_* unlimited
-- Legacy plan keys map like netlify/functions/_entitlements.js
-- (monitor→c_monitor, campaign→a_campaign, agency→a_campaign). Active trials
-- use the trial plan's limit. Admin emails (netlify/functions/_config.js) are
-- exempt. Service-role writes bypass. Fires only when a row's monitoring flag
-- TURNS ON. Idempotent.

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
  IF jwt IS NULL THEN RETURN NEW; END IF;  -- service role

  email := lower(coalesce(jwt ->> 'email', ''));
  IF email IN ('tony@bluejackgroup.com', 'tony@thebluejackgroup.com', 'tom@thebluejackgroup.com') THEN
    RETURN NEW;
  END IF;

  plan := coalesce(jwt -> 'app_metadata' ->> 'plan', 'scout');
  -- Active trial overrides the paid plan (mirrors _entitlements.js)
  IF (jwt -> 'app_metadata' -> 'trial' ->> 'expires_at') IS NOT NULL
     AND (jwt -> 'app_metadata' -> 'trial' ->> 'expires_at')::timestamptz > now() THEN
    plan := coalesce(jwt -> 'app_metadata' -> 'trial' ->> 'plan', plan);
  END IF;
  -- Legacy aliases
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
    ELSE NULL  -- a_monitor / a_active / a_campaign / unknown paid: unlimited
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

DROP TRIGGER IF EXISTS monitoring_cap ON candidates;
CREATE TRIGGER monitoring_cap
  BEFORE UPDATE ON candidates
  FOR EACH ROW EXECUTE FUNCTION enforce_monitoring_cap();
