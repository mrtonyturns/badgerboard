-- ============================================================
-- Candidate Notes & Files — Storage bucket RLS policies
-- (Rewritten July 2026 remediation, bug D3)
-- ============================================================
-- The original version used CREATE POLICY IF NOT EXISTS, which is NOT valid
-- Postgres syntax — the migration errored and never created anything (so no
-- orphan "candidate_files_*" policies exist anywhere).
--
-- backend_hardening (20260704000004 §9) later installed the working policies
-- under the names candidate-files_select / _insert / _update / _delete.
-- Those names are authoritative; this file now guard-creates the SAME set so
-- fresh environments converge with production and re-runs are no-ops.
--
-- Path structure: {userId}/{candidateId}/{filename}

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'candidate-files_select') THEN
    CREATE POLICY "candidate-files_select" ON storage.objects FOR SELECT
      TO authenticated
      USING (bucket_id = 'candidate-files' AND (storage.foldername(name))[1] = auth.uid()::text);
  END IF;

  IF NOT EXISTS (SELECT FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'candidate-files_insert') THEN
    CREATE POLICY "candidate-files_insert" ON storage.objects FOR INSERT
      TO authenticated
      WITH CHECK (bucket_id = 'candidate-files' AND (storage.foldername(name))[1] = auth.uid()::text);
  END IF;

  IF NOT EXISTS (SELECT FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'candidate-files_update') THEN
    CREATE POLICY "candidate-files_update" ON storage.objects FOR UPDATE
      TO authenticated
      USING (bucket_id = 'candidate-files' AND (storage.foldername(name))[1] = auth.uid()::text)
      WITH CHECK (bucket_id = 'candidate-files' AND (storage.foldername(name))[1] = auth.uid()::text);
  END IF;

  IF NOT EXISTS (SELECT FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'candidate-files_delete') THEN
    CREATE POLICY "candidate-files_delete" ON storage.objects FOR DELETE
      TO authenticated
      USING (bucket_id = 'candidate-files' AND (storage.foldername(name))[1] = auth.uid()::text);
  END IF;
END $$;
