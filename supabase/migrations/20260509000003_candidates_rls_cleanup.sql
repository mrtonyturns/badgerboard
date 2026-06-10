-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: 20260509000003_candidates_rls_cleanup
-- Drops the legacy permissive policies that had (created_by IS NULL) escape
-- hatches, leaving only the four strict candidates_*_own policies installed by
-- 20260429000001_candidates_rls_isolation.sql.
--
-- Root cause: intermediate migrations created "Users *" policies with
-- USING ((created_by = auth.uid()) OR (created_by IS NULL)), which allowed any
-- authenticated user to access candidate rows with no owner set.
-- ─────────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Users delete own candidates" ON candidates;
DROP POLICY IF EXISTS "Users insert own candidates" ON candidates;
DROP POLICY IF EXISTS "Users read own candidates"   ON candidates;
DROP POLICY IF EXISTS "Users update own candidates" ON candidates;
DROP POLICY IF EXISTS "users_own_candidates"        ON candidates;

-- Remaining policies after this migration (all strict, no NULL escape):
--   candidates_select_own  USING (created_by = auth.uid())
--   candidates_insert_own  WITH CHECK (created_by = auth.uid())
--   candidates_update_own  USING (created_by = auth.uid()) WITH CHECK (created_by = auth.uid())
--   candidates_delete_own  USING (created_by = auth.uid())
