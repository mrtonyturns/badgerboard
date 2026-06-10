-- Migration: Fix voters INSERT RLS — drop the all-in-one policy and split per-operation
--
-- Root cause: the original "Users manage own voters" policy covers ALL operations
-- (SELECT, INSERT, UPDATE, DELETE) with a single USING + WITH CHECK clause that only
-- checks `created_by = auth.uid()`. This allows User B to INSERT a voter row
-- referencing any voter_list_id (even one owned by User A) as long as they supply
-- their own uid as created_by. The INSERT check must also verify that the target
-- voter_list_id belongs to the calling user.
--
-- Fix: drop the broad combined policy and replace it with four per-operation policies.

-- 1. Drop ALL existing voters policies (combined + any from previous migration attempt)
DROP POLICY IF EXISTS "Users manage own voters"   ON public.voters;
DROP POLICY IF EXISTS "voters_insert_own"          ON public.voters;
DROP POLICY IF EXISTS "voters_owner_insert"        ON public.voters;
DROP POLICY IF EXISTS "Users can insert their own voters" ON public.voters;

-- 2. SELECT — can only see voters that belong to them
CREATE POLICY "voters_select_own"
  ON public.voters
  FOR SELECT
  USING (created_by = auth.uid());

-- 3. INSERT — created_by must be the caller AND the target list must also belong to the caller
CREATE POLICY "voters_insert_own"
  ON public.voters
  FOR INSERT
  WITH CHECK (
    created_by = auth.uid()
    AND voter_list_id IN (
      SELECT id FROM public.voter_lists WHERE created_by = auth.uid()
    )
  );

-- 4. UPDATE — can only update their own rows
CREATE POLICY "voters_update_own"
  ON public.voters
  FOR UPDATE
  USING (created_by = auth.uid())
  WITH CHECK (created_by = auth.uid());

-- 5. DELETE — can only delete their own rows
CREATE POLICY "voters_delete_own"
  ON public.voters
  FOR DELETE
  USING (created_by = auth.uid());
