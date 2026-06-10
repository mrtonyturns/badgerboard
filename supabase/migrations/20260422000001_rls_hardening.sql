-- ─────────────────────────────────────────────────────────────────────────────
-- RLS Hardening Migration
-- Fixes cross-user data isolation issues found by security test suite.
--
-- Problems fixed:
--   1. door_knock_lists  — policies were USING (true), allowing any auth user to
--                          read/update/delete any row.
--   2. door_knocks       — same overly-permissive policies.
--   3. volunteers        — INSERT policy only checked created_by, not list ownership,
--                          allowing User B to attach volunteers to User A's lists.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. door_knock_lists: replace permissive policies with owner-scoped ones ──
DROP POLICY IF EXISTS "Auth users read door_knock_lists"   ON door_knock_lists;
DROP POLICY IF EXISTS "Auth users insert door_knock_lists" ON door_knock_lists;
DROP POLICY IF EXISTS "Auth users update door_knock_lists" ON door_knock_lists;
DROP POLICY IF EXISTS "Auth users delete door_knock_lists" ON door_knock_lists;

CREATE POLICY "lists_select"
  ON door_knock_lists FOR SELECT
  USING (created_by = auth.uid());

CREATE POLICY "lists_insert"
  ON door_knock_lists FOR INSERT
  WITH CHECK (created_by = auth.uid());

CREATE POLICY "lists_update"
  ON door_knock_lists FOR UPDATE
  USING (created_by = auth.uid())
  WITH CHECK (created_by = auth.uid());

CREATE POLICY "lists_delete"
  ON door_knock_lists FOR DELETE
  USING (created_by = auth.uid());

-- ── 2. door_knocks: scope to the owner of the parent list ────────────────────
DROP POLICY IF EXISTS "Auth users read door_knocks"   ON door_knocks;
DROP POLICY IF EXISTS "Auth users insert door_knocks" ON door_knocks;
DROP POLICY IF EXISTS "Auth users update door_knocks" ON door_knocks;
DROP POLICY IF EXISTS "Auth users delete door_knocks" ON door_knocks;

CREATE POLICY "knocks_select"
  ON door_knocks FOR SELECT
  USING (
    list_id IN (SELECT id FROM door_knock_lists WHERE created_by = auth.uid())
  );

CREATE POLICY "knocks_insert"
  ON door_knocks FOR INSERT
  WITH CHECK (
    list_id IN (SELECT id FROM door_knock_lists WHERE created_by = auth.uid())
  );

CREATE POLICY "knocks_update"
  ON door_knocks FOR UPDATE
  USING (
    list_id IN (SELECT id FROM door_knock_lists WHERE created_by = auth.uid())
  )
  WITH CHECK (
    list_id IN (SELECT id FROM door_knock_lists WHERE created_by = auth.uid())
  );

CREATE POLICY "knocks_delete"
  ON door_knocks FOR DELETE
  USING (
    list_id IN (SELECT id FROM door_knock_lists WHERE created_by = auth.uid())
  );

-- ── 3. volunteers: tighten INSERT to also verify list ownership ───────────────
DROP POLICY IF EXISTS "volunteers_owner_all" ON volunteers;

-- SELECT/UPDATE/DELETE — only the creator of the volunteer record
CREATE POLICY "volunteers_owner_select"
  ON volunteers FOR SELECT
  USING (created_by = auth.uid());

CREATE POLICY "volunteers_owner_update"
  ON volunteers FOR UPDATE
  USING (created_by = auth.uid())
  WITH CHECK (created_by = auth.uid());

CREATE POLICY "volunteers_owner_delete"
  ON volunteers FOR DELETE
  USING (created_by = auth.uid());

-- INSERT — created_by must be the caller AND the list must belong to the caller
CREATE POLICY "volunteers_owner_insert"
  ON volunteers FOR INSERT
  WITH CHECK (
    created_by = auth.uid()
    AND (
      list_id IS NULL
      OR list_id IN (SELECT id FROM door_knock_lists WHERE created_by = auth.uid())
    )
  );
