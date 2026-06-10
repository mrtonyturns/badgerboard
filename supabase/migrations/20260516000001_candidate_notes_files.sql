-- ============================================================
-- Candidate Notes & Files — Storage bucket RLS policies
-- ============================================================
-- Notes and file metadata are stored in the existing `candidates.notes`
-- column as a JSON string (no schema change needed for notes).
-- This migration only adds storage policies for the `candidate-files` bucket.
--
-- Run AFTER creating the bucket via the admin-setup-candidate-storage function
-- OR apply directly in Supabase dashboard > Storage > Policies.
-- ============================================================

-- Storage RLS: users can only access files under their own userId prefix
-- Path structure: {userId}/{candidateId}/{filename}

CREATE POLICY IF NOT EXISTS "candidate_files_insert"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'candidate-files'
  AND (storage.foldername(name))[1] = auth.uid()::text
);

CREATE POLICY IF NOT EXISTS "candidate_files_select"
ON storage.objects FOR SELECT
TO authenticated
USING (
  bucket_id = 'candidate-files'
  AND (storage.foldername(name))[1] = auth.uid()::text
);

CREATE POLICY IF NOT EXISTS "candidate_files_update"
ON storage.objects FOR UPDATE
TO authenticated
USING (
  bucket_id = 'candidate-files'
  AND (storage.foldername(name))[1] = auth.uid()::text
);

CREATE POLICY IF NOT EXISTS "candidate_files_delete"
ON storage.objects FOR DELETE
TO authenticated
USING (
  bucket_id = 'candidate-files'
  AND (storage.foldername(name))[1] = auth.uid()::text
);
