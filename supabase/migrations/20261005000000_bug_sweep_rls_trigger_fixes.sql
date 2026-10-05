-- Oct 5 bug sweep — RLS / trigger fixes. Idempotent.
--
--   1. enforce_monitoring_cap blocked EVERY edit for Scout / c_monitor users.
--      `(NEW.section_timestamps->>'monitoring') = 'true'` is NULL (not false)
--      when the key is absent — the default for every candidate never toggled —
--      so `IF NOT turning_on` didn't fire and plain renames fell through to the
--      0-slot cap ("Your plan includes 0 active monitoring slots").
--   2. The cap only ran BEFORE UPDATE, so inserting a row that already had
--      monitoring=true skipped it entirely. Now BEFORE INSERT OR UPDATE.
--   3. dossier_shares: the INSERT/UPDATE policies only checked created_by, so
--      any signed-in user could POST a share row for SOMEONE ELSE's dossier_id
--      (with any expiry) and read it publicly via get-shared-dossier. The
--      client never writes this table — create-dossier-share and
--      get-shared-dossier use the service role — so client writes are removed.
--   4. volunteers UPDATE didn't re-check list ownership: a coordinator could
--      re-point their own volunteer at another user's door_knock_list and act
--      on it through volunteer-auth (which trusts volunteers.list_id).
--   5. dossiers UPDATE WITH CHECK accepted a row the caller owned OR whose
--      candidate the caller owned, so a user could move their dossier onto a
--      victim's candidate (or hand it to a victim via created_by). The new row
--      must now keep a caller-owned (or legacy NULL) created_by AND point at a
--      caller-owned candidate. NULL is allowed because weekly auto-regenerated
--      rows were saved with created_by NULL until this sweep, and their owners
--      still need to save claim verdicts on them.

-- ── 1 + 2. Monitoring cap ───────────────────────────────────────────────────
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
  BEFORE INSERT OR UPDATE ON candidates
  FOR EACH ROW EXECUTE FUNCTION enforce_monitoring_cap();

-- ── 3. dossier_shares: service-role writes only ─────────────────────────────
DROP POLICY IF EXISTS "Users create own shares" ON dossier_shares;
DROP POLICY IF EXISTS "Users update own shares" ON dossier_shares;

-- ── 4. volunteers: UPDATE must keep the row on one of the caller's lists ────
DROP POLICY IF EXISTS "volunteers_owner_update" ON public.volunteers;
CREATE POLICY "volunteers_owner_update"
  ON public.volunteers FOR UPDATE
  USING (created_by = auth.uid())
  WITH CHECK (
    created_by = auth.uid()
    AND list_id IN (SELECT id FROM public.door_knock_lists WHERE created_by = auth.uid())
  );

-- ── 5. dossiers: UPDATE result must satisfy the same rule as INSERT ─────────
DROP POLICY IF EXISTS "dossiers_update_own" ON dossiers;
CREATE POLICY "dossiers_update_own" ON dossiers FOR UPDATE USING (
  created_by = auth.uid()
  OR EXISTS (SELECT 1 FROM candidates c WHERE c.id = dossiers.candidate_id AND c.created_by = auth.uid())
) WITH CHECK (
  (created_by IS NULL OR created_by = auth.uid())
  AND (candidate_id IS NULL
       OR EXISTS (SELECT 1 FROM candidates c WHERE c.id = candidate_id AND c.created_by = auth.uid()))
);
