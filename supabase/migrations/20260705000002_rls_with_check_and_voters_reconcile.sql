-- Migration: RLS WITH CHECK hardening + voters.created_by reconcile
-- (July 2026 remediation, bugs D1 + D2 — catch-up for environments that ran
-- the original 20260522_door_knocking_v2.sql without WITH CHECK)
--
-- D1: FOR ALL ... USING(...) without WITH CHECK meant INSERT/UPDATE rows were
-- NOT validated against the policy — any authenticated user could write rows
-- owned by someone else (cross-tenant writes). Recreate all three policies
-- with a matching WITH CHECK.
--
-- D2: voters.created_by existed only if 004_voter_and_incumbent_tables.sql
-- created the table; environments built from migration_v2.sql lacked it.
-- ADD COLUMN IF NOT EXISTS converges every environment (no-op where present).

BEGIN;

-- ─── D2: authoritative voters.created_by ─────────────────────────────────────
ALTER TABLE voters ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES auth.users(id);
CREATE INDEX IF NOT EXISTS idx_voters_created_by ON voters (created_by);

-- ─── D1: recreate door-knocking policies with WITH CHECK ────────────────────
DROP POLICY IF EXISTS "turf_blocks_owner" ON turf_blocks;
CREATE POLICY "turf_blocks_owner" ON turf_blocks
  FOR ALL USING (created_by = auth.uid())
  WITH CHECK (created_by = auth.uid());

DROP POLICY IF EXISTS "turf_assignments_owner" ON turf_assignments;
CREATE POLICY "turf_assignments_owner" ON turf_assignments
  FOR ALL USING (
    block_id IN (SELECT id FROM turf_blocks WHERE created_by = auth.uid())
  )
  WITH CHECK (
    block_id IN (SELECT id FROM turf_blocks WHERE created_by = auth.uid())
  );

DROP POLICY IF EXISTS "voter_file_entries_owner" ON voter_file_entries;
CREATE POLICY "voter_file_entries_owner" ON voter_file_entries
  FOR ALL USING (created_by = auth.uid())
  WITH CHECK (created_by = auth.uid());

COMMIT;
