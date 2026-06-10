-- Migration: Add RLS to dossiers and prospecting_lists
--
-- Neither table has had per-user RLS applied. Both use different ownership
-- column conventions — dossiers uses user_id, prospecting_lists has both
-- created_by and user_id. We normalise to created_by where possible and
-- add strict owner-scoped policies for all four CRUD operations.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. dossiers ──────────────────────────────────────────────────────────────
-- Ownership column is user_id (will be aliased to created_by in a later migration).

ALTER TABLE public.dossiers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "dossiers_select_own"   ON public.dossiers;
DROP POLICY IF EXISTS "dossiers_insert_own"   ON public.dossiers;
DROP POLICY IF EXISTS "dossiers_update_own"   ON public.dossiers;
DROP POLICY IF EXISTS "dossiers_delete_own"   ON public.dossiers;
-- Drop any legacy permissive policies
DROP POLICY IF EXISTS "Users manage own dossiers" ON public.dossiers;
DROP POLICY IF EXISTS "Auth users read dossiers"  ON public.dossiers;

CREATE POLICY "dossiers_select_own"
  ON public.dossiers FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "dossiers_insert_own"
  ON public.dossiers FOR INSERT
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "dossiers_update_own"
  ON public.dossiers FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "dossiers_delete_own"
  ON public.dossiers FOR DELETE
  USING (user_id = auth.uid());

-- ── 2. prospecting_lists ─────────────────────────────────────────────────────
-- Has both created_by and user_id. Use created_by as the canonical ownership
-- column (consistent with all other tables that have it). INSERT must supply
-- created_by = auth.uid(); SELECT/UPDATE/DELETE check created_by.

ALTER TABLE public.prospecting_lists ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "prospecting_select_own"           ON public.prospecting_lists;
DROP POLICY IF EXISTS "prospecting_insert_own"           ON public.prospecting_lists;
DROP POLICY IF EXISTS "prospecting_update_own"           ON public.prospecting_lists;
DROP POLICY IF EXISTS "prospecting_delete_own"           ON public.prospecting_lists;
DROP POLICY IF EXISTS "Users manage own prospecting lists" ON public.prospecting_lists;
DROP POLICY IF EXISTS "Auth users read prospecting_lists"  ON public.prospecting_lists;

CREATE POLICY "prospecting_select_own"
  ON public.prospecting_lists FOR SELECT
  USING (created_by = auth.uid());

CREATE POLICY "prospecting_insert_own"
  ON public.prospecting_lists FOR INSERT
  WITH CHECK (created_by = auth.uid());

CREATE POLICY "prospecting_update_own"
  ON public.prospecting_lists FOR UPDATE
  USING (created_by = auth.uid())
  WITH CHECK (created_by = auth.uid());

CREATE POLICY "prospecting_delete_own"
  ON public.prospecting_lists FOR DELETE
  USING (created_by = auth.uid());
