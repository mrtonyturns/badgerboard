-- Migration: Add created_by column to dossiers for schema consistency
--
-- All other user-owned tables use created_by = auth.uid(). The dossiers table
-- uses user_id instead, which breaks generic queries and causes confusion.
-- This migration adds a created_by column, back-fills it from user_id, and
-- updates RLS policies to use created_by going forward.
-- user_id is kept in place (not dropped) to avoid breaking existing queries.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Add the column (nullable first for the back-fill)
ALTER TABLE public.dossiers
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES auth.users(id) ON DELETE CASCADE;

-- 2. Back-fill from the existing user_id column
UPDATE public.dossiers
  SET created_by = user_id
  WHERE created_by IS NULL AND user_id IS NOT NULL;

-- 3. Add index for performance
CREATE INDEX IF NOT EXISTS idx_dossiers_created_by ON public.dossiers(created_by);

-- 4. Update RLS policies to use created_by (drop + recreate)
DROP POLICY IF EXISTS "dossiers_select_own" ON public.dossiers;
DROP POLICY IF EXISTS "dossiers_insert_own" ON public.dossiers;
DROP POLICY IF EXISTS "dossiers_update_own" ON public.dossiers;
DROP POLICY IF EXISTS "dossiers_delete_own" ON public.dossiers;

-- Use created_by; also accept user_id for rows where created_by is still null
-- (shouldn't happen after back-fill, but safety net)
CREATE POLICY "dossiers_select_own"
  ON public.dossiers FOR SELECT
  USING (
    created_by = auth.uid()
    OR (created_by IS NULL AND user_id = auth.uid())
  );

CREATE POLICY "dossiers_insert_own"
  ON public.dossiers FOR INSERT
  WITH CHECK (
    (created_by = auth.uid() OR created_by IS NULL)
    AND user_id = auth.uid()
  );

CREATE POLICY "dossiers_update_own"
  ON public.dossiers FOR UPDATE
  USING (
    created_by = auth.uid()
    OR (created_by IS NULL AND user_id = auth.uid())
  )
  WITH CHECK (
    created_by = auth.uid()
    OR (created_by IS NULL AND user_id = auth.uid())
  );

CREATE POLICY "dossiers_delete_own"
  ON public.dossiers FOR DELETE
  USING (
    created_by = auth.uid()
    OR (created_by IS NULL AND user_id = auth.uid())
  );
