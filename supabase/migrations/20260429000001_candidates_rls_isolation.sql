-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: 20260429000001_candidates_rls_isolation
-- Replaces the original permissive "USING (true)" candidates policies with
-- proper per-user isolation scoped to created_by = auth.uid().
--
-- Previously any authenticated user could read/write every candidate row.
-- The app enforced isolation only at the query layer (.eq('created_by', uid))
-- but the DB layer had no protection against direct API access.
-- ─────────────────────────────────────────────────────────────────────────────

-- Drop the original permissive policies from schema.sql
DROP POLICY IF EXISTS "Authenticated users can read candidates"   ON candidates;
DROP POLICY IF EXISTS "Authenticated users can insert candidates" ON candidates;
DROP POLICY IF EXISTS "Authenticated users can update candidates" ON candidates;
DROP POLICY IF EXISTS "Authenticated users can delete candidates" ON candidates;

-- Drop any other loose policies that might exist from intermediate migrations
DROP POLICY IF EXISTS "candidates_select_own"  ON candidates;
DROP POLICY IF EXISTS "candidates_insert_own"  ON candidates;
DROP POLICY IF EXISTS "candidates_update_own"  ON candidates;
DROP POLICY IF EXISTS "candidates_delete_own"  ON candidates;

-- Ensure RLS is enabled
ALTER TABLE candidates ENABLE ROW LEVEL SECURITY;

-- SELECT: only the owning user can read their candidates
CREATE POLICY "candidates_select_own"
  ON candidates FOR SELECT
  USING (created_by = auth.uid());

-- INSERT: user can only create candidates they own
CREATE POLICY "candidates_insert_own"
  ON candidates FOR INSERT
  WITH CHECK (created_by = auth.uid());

-- UPDATE: user can only modify their own candidates
CREATE POLICY "candidates_update_own"
  ON candidates FOR UPDATE
  USING  (created_by = auth.uid())
  WITH CHECK (created_by = auth.uid());

-- DELETE: user can only delete their own candidates
CREATE POLICY "candidates_delete_own"
  ON candidates FOR DELETE
  USING (created_by = auth.uid());
