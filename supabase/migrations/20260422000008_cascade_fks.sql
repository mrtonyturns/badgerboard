-- Migration: Add missing ON DELETE CASCADE foreign key constraints
--
-- Findings from the full test suite:
--   • Deleting a candidates row does NOT cascade to its dossiers
--   • Deleting a door_knock_lists row does NOT cascade to its volunteers
--   • Other cascade gaps found in testing
--
-- Strategy: for each missing cascade, drop the existing FK constraint and
-- recreate it with ON DELETE CASCADE. Nullify-on-delete is used where hard
-- cascade deletion would be too destructive.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. dossiers.candidate_id → candidates ────────────────────────────────────
-- Deleting a candidate should remove its dossiers.
ALTER TABLE public.dossiers
  DROP CONSTRAINT IF EXISTS dossiers_candidate_id_fkey;

ALTER TABLE public.dossiers
  ADD CONSTRAINT dossiers_candidate_id_fkey
    FOREIGN KEY (candidate_id)
    REFERENCES public.candidates(id)
    ON DELETE CASCADE;

-- ── 2. volunteers.list_id → door_knock_lists ─────────────────────────────────
-- Deleting a door_knock_list should remove all its volunteers.
-- Currently ON DELETE SET NULL — change to CASCADE.
ALTER TABLE public.volunteers
  DROP CONSTRAINT IF EXISTS volunteers_list_id_fkey;

ALTER TABLE public.volunteers
  ADD CONSTRAINT volunteers_list_id_fkey
    FOREIGN KEY (list_id)
    REFERENCES public.door_knock_lists(id)
    ON DELETE CASCADE;

-- ── 3. incumbent_records.candidate_id → candidates ───────────────────────────
-- Deleting a candidate should remove its incumbent records.
ALTER TABLE public.incumbent_records
  DROP CONSTRAINT IF EXISTS incumbent_records_candidate_id_fkey;

ALTER TABLE public.incumbent_records
  ADD CONSTRAINT incumbent_records_candidate_id_fkey
    FOREIGN KEY (candidate_id)
    REFERENCES public.candidates(id)
    ON DELETE CASCADE;
