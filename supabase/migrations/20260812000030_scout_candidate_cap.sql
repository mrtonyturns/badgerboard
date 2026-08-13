-- Server-side Scout candidate cap (closes the audit's "client-only cap" gap).
-- A Scout account (app_metadata.plan missing or 'scout') may hold at most 2
-- candidates; paid plans and admin emails are exempt. Enforced by a trigger
-- rather than RLS WITH CHECK so the count is race-free under the row lock and
-- the error message is human. Admin list mirrors netlify/functions/_config.js.
-- Idempotent.

CREATE OR REPLACE FUNCTION enforce_scout_candidate_cap()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  jwt jsonb;
  plan text;
  email text;
  n int;
BEGIN
  -- Service-role writes (auth.jwt() null) bypass — backend functions manage
  -- their own entitlements.
  jwt := NULLIF(current_setting('request.jwt.claims', true), '')::jsonb;
  IF jwt IS NULL THEN RETURN NEW; END IF;

  email := lower(coalesce(jwt ->> 'email', ''));
  IF email IN ('tony@bluejackgroup.com', 'tony@thebluejackgroup.com', 'tom@thebluejackgroup.com') THEN
    RETURN NEW;
  END IF;

  plan := coalesce(jwt -> 'app_metadata' ->> 'plan', 'scout');
  IF plan <> 'scout' THEN RETURN NEW; END IF;

  -- Active trials lift the cap (mirrors _entitlements.js).
  IF (jwt -> 'app_metadata' -> 'trial' ->> 'expires_at') IS NOT NULL
     AND (jwt -> 'app_metadata' -> 'trial' ->> 'expires_at')::timestamptz > now() THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO n FROM candidates WHERE created_by = NEW.created_by;
  IF n >= 2 THEN
    RAISE EXCEPTION 'Scout plans track up to 2 candidates. Upgrade to add more.'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS scout_candidate_cap ON candidates;
CREATE TRIGGER scout_candidate_cap
  BEFORE INSERT ON candidates
  FOR EACH ROW EXECUTE FUNCTION enforce_scout_candidate_cap();
