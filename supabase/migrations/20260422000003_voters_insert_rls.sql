-- Migration: Fix voters INSERT RLS policy
-- Bug: User B could insert voters into User A's voter_list_id because the INSERT
-- policy only checked created_by = auth.uid() but not that the voter_list_id
-- actually belongs to the calling user.
--
-- This migration drops the overly-permissive INSERT policy and replaces it with
-- one that also validates voter_list ownership.

-- Drop the existing INSERT policy if it exists
DROP POLICY IF EXISTS "voters_insert_own" ON public.voters;
DROP POLICY IF EXISTS "Users can insert their own voters" ON public.voters;
DROP POLICY IF EXISTS "voters_owner_insert" ON public.voters;

-- Create the corrected INSERT policy
-- Requires:
--   1. created_by = auth.uid()  (the row is attributed to the caller)
--   2. voter_list_id IN (SELECT id FROM voter_lists WHERE created_by = auth.uid())
--      (the target list belongs to the caller)
CREATE POLICY "voters_owner_insert"
  ON public.voters
  FOR INSERT
  WITH CHECK (
    created_by = auth.uid()
    AND voter_list_id IN (
      SELECT id FROM public.voter_lists WHERE created_by = auth.uid()
    )
  );
