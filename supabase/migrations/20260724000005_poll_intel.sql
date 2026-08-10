-- v1.25: Polling Local Intel — user-supplied notes/files that get factored
-- into the vote-share projection, plus per-user personalized snapshots so
-- private intel never pollutes the shared district baseline.

-- ── 1. poll_intel: one row per note/file ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.poll_intel (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  district    text NOT NULL,
  kind        text NOT NULL DEFAULT 'note' CHECK (kind IN ('note','text','image','file')),
  title       text,
  content     text,             -- typed note or client-extracted document text
  file_path   text,             -- storage path (poll-intel bucket) for images/files
  file_type   text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_poll_intel_user_district ON public.poll_intel(user_id, district);

ALTER TABLE public.poll_intel ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS poll_intel_select ON public.poll_intel;
DROP POLICY IF EXISTS poll_intel_insert ON public.poll_intel;
DROP POLICY IF EXISTS poll_intel_delete ON public.poll_intel;
CREATE POLICY poll_intel_select ON public.poll_intel FOR SELECT USING (user_id = auth.uid());
CREATE POLICY poll_intel_insert ON public.poll_intel FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY poll_intel_delete ON public.poll_intel FOR DELETE USING (user_id = auth.uid());

-- ── 2. poll_snapshots: per-user personalized rows ────────────────────────────
-- Global (shared) rows use the zero-uuid sentinel so a plain composite UNIQUE
-- works with PostgREST on_conflict (expression indexes can't be targeted).
ALTER TABLE public.poll_snapshots ADD COLUMN IF NOT EXISTS user_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000';
ALTER TABLE public.poll_snapshots ADD COLUMN IF NOT EXISTS intel_count int NOT NULL DEFAULT 0;
UPDATE public.poll_snapshots SET user_id = '00000000-0000-0000-0000-000000000000' WHERE user_id IS NULL;
ALTER TABLE public.poll_snapshots DROP CONSTRAINT IF EXISTS poll_snapshots_district_key;
DROP INDEX IF EXISTS poll_snapshots_district_user_key;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'poll_snapshots_district_user_key') THEN
    ALTER TABLE public.poll_snapshots ADD CONSTRAINT poll_snapshots_district_user_key UNIQUE (district, user_id);
  END IF;
END $$;

-- ── 3. poll-intel storage bucket + owner-scoped policies ─────────────────────
INSERT INTO storage.buckets (id, name, public)
  VALUES ('poll-intel', 'poll-intel', false)
  ON CONFLICT (id) DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'poll-intel_select') THEN
    CREATE POLICY "poll-intel_select" ON storage.objects FOR SELECT
      USING (bucket_id = 'poll-intel' AND (storage.foldername(name))[1] = auth.uid()::text);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'poll-intel_insert') THEN
    CREATE POLICY "poll-intel_insert" ON storage.objects FOR INSERT
      WITH CHECK (bucket_id = 'poll-intel' AND (storage.foldername(name))[1] = auth.uid()::text);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'poll-intel_delete') THEN
    CREATE POLICY "poll-intel_delete" ON storage.objects FOR DELETE
      USING (bucket_id = 'poll-intel' AND (storage.foldername(name))[1] = auth.uid()::text);
  END IF;
END $$;
