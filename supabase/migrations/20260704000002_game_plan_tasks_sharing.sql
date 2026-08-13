-- Migration: Game Plan Tasks — Campaign Connect sharing
-- Adds an owner model so Action accounts with an active Campaign Connect link
-- (permissions.manage_tasks) can view and manage a connected Candidate's plan.
--
--   owner_id   = whose plan the row belongs to (candidate)
--   created_by = who actually created the row (audit trail; may be the manager)
--
-- Access rules:
--   read  : owner, or linked action account with view or manage_tasks
--   write : owner, or linked action account with manage_tasks
--
-- Safe to run multiple times.

-- ─── 1. owner_id columns ──────────────────────────────────────────────────────
ALTER TABLE gp_projects ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE gp_sections ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE gp_tasks    ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE gp_labels   ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;

UPDATE gp_projects SET owner_id = created_by WHERE owner_id IS NULL;
UPDATE gp_sections SET owner_id = created_by WHERE owner_id IS NULL;
UPDATE gp_tasks    SET owner_id = created_by WHERE owner_id IS NULL;
UPDATE gp_labels   SET owner_id = created_by WHERE owner_id IS NULL;

ALTER TABLE gp_projects ALTER COLUMN owner_id SET DEFAULT auth.uid();
ALTER TABLE gp_sections ALTER COLUMN owner_id SET DEFAULT auth.uid();
ALTER TABLE gp_tasks    ALTER COLUMN owner_id SET DEFAULT auth.uid();
ALTER TABLE gp_labels   ALTER COLUMN owner_id SET DEFAULT auth.uid();

DO $$ BEGIN
  ALTER TABLE gp_projects ALTER COLUMN owner_id SET NOT NULL;
  ALTER TABLE gp_sections ALTER COLUMN owner_id SET NOT NULL;
  ALTER TABLE gp_tasks    ALTER COLUMN owner_id SET NOT NULL;
  ALTER TABLE gp_labels   ALTER COLUMN owner_id SET NOT NULL;
EXCEPTION WHEN others THEN NULL;  -- already NOT NULL on re-run
END $$;

-- gp_labels: uniqueness must be per plan owner, not per creator
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gp_labels_created_by_name_key') THEN
    ALTER TABLE gp_labels DROP CONSTRAINT gp_labels_created_by_name_key;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gp_labels_owner_name_key') THEN
    ALTER TABLE gp_labels ADD CONSTRAINT gp_labels_owner_name_key UNIQUE (owner_id, name);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_gp_projects_owner ON gp_projects (owner_id);
CREATE INDEX IF NOT EXISTS idx_gp_sections_owner ON gp_sections (owner_id);
CREATE INDEX IF NOT EXISTS idx_gp_tasks_owner    ON gp_tasks (owner_id);
CREATE INDEX IF NOT EXISTS idx_gp_labels_owner   ON gp_labels (owner_id);

-- ─── 2. Access helper functions ───────────────────────────────────────────────
-- SECURITY DEFINER so the link lookup isn't subject to account_links RLS,
-- STABLE so the planner can cache per-statement.
-- plpgsql (was sql): a LANGUAGE sql body is validated at CREATE time, which
-- failed on clean rebuilds where account_links (created later in the original
-- lineage, now by 20260812000020) did not yet exist. plpgsql validates at
-- first execution instead. Behavior identical.
CREATE OR REPLACE FUNCTION gp_can_view(plan_owner UUID)
RETURNS BOOLEAN LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN plan_owner = auth.uid() OR EXISTS (
    SELECT 1 FROM account_links l
    WHERE l.status = 'active'
      AND l.action_user_id = auth.uid()
      AND l.candidate_user_id = plan_owner
      AND (COALESCE((l.permissions->>'view')::boolean, false)
        OR COALESCE((l.permissions->>'manage_tasks')::boolean, false))
  );
END;
$$;

CREATE OR REPLACE FUNCTION gp_can_edit(plan_owner UUID)
RETURNS BOOLEAN LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN plan_owner = auth.uid() OR EXISTS (
    SELECT 1 FROM account_links l
    WHERE l.status = 'active'
      AND l.action_user_id = auth.uid()
      AND l.candidate_user_id = plan_owner
      AND COALESCE((l.permissions->>'manage_tasks')::boolean, false)
  );
END;
$$;

REVOKE ALL ON FUNCTION gp_can_view(UUID)  FROM anon;
REVOKE ALL ON FUNCTION gp_can_edit(UUID)  FROM anon;

-- ─── 3. Replace RLS policies ──────────────────────────────────────────────────
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['gp_projects','gp_sections','gp_tasks','gp_labels'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS "Users manage own projects" ON %I', t);
    EXECUTE format('DROP POLICY IF EXISTS "Users manage own sections" ON %I', t);
    EXECUTE format('DROP POLICY IF EXISTS "Users manage own tasks" ON %I', t);
    EXECUTE format('DROP POLICY IF EXISTS "Users manage own labels" ON %I', t);
    EXECUTE format('DROP POLICY IF EXISTS gp_select ON %I', t);
    EXECUTE format('DROP POLICY IF EXISTS gp_insert ON %I', t);
    EXECUTE format('DROP POLICY IF EXISTS gp_update ON %I', t);
    EXECUTE format('DROP POLICY IF EXISTS gp_delete ON %I', t);

    EXECUTE format('CREATE POLICY gp_select ON %I FOR SELECT USING (gp_can_view(owner_id))', t);
    EXECUTE format('CREATE POLICY gp_insert ON %I FOR INSERT WITH CHECK (created_by = auth.uid() AND gp_can_edit(owner_id))', t);
    EXECUTE format('CREATE POLICY gp_update ON %I FOR UPDATE USING (gp_can_edit(owner_id)) WITH CHECK (gp_can_edit(owner_id))', t);
    EXECUTE format('CREATE POLICY gp_delete ON %I FOR DELETE USING (gp_can_edit(owner_id))', t);
  END LOOP;
END $$;

COMMENT ON COLUMN gp_tasks.owner_id IS
  'Plan owner (candidate). Differs from created_by when a connected Action account (Campaign Connect, permissions.manage_tasks) creates the row.';
