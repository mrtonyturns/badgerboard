-- ============================================================
-- Badger Board — Schema Migration v5: User Data Isolation
-- Adds created_by to candidates, replaces all RLS policies
-- with user-scoped checks so each user only sees their own data.
-- ============================================================

-- ============================================================
-- 1. ADD created_by COLUMN TO CANDIDATES TABLE
-- ============================================================
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES auth.users(id);

-- Backfill: assign any existing candidates with NULL created_by
-- to the first admin user so they don't become invisible.
-- Run this AFTER adding the column. Replace the UUID below if needed.
-- UPDATE candidates SET created_by = '<YOUR_ADMIN_USER_UUID>' WHERE created_by IS NULL;

-- ============================================================
-- 2. DROP OLD "ALLOW ALL" RLS POLICIES
-- ============================================================

-- Candidates
DROP POLICY IF EXISTS "Authenticated users can read candidates"   ON candidates;
DROP POLICY IF EXISTS "Authenticated users can insert candidates" ON candidates;
DROP POLICY IF EXISTS "Authenticated users can update candidates" ON candidates;
DROP POLICY IF EXISTS "Authenticated users can delete candidates" ON candidates;

-- Dossiers
DROP POLICY IF EXISTS "Authenticated users can read dossiers"   ON dossiers;
DROP POLICY IF EXISTS "Authenticated users can insert dossiers" ON dossiers;
DROP POLICY IF EXISTS "Authenticated users can update dossiers" ON dossiers;
DROP POLICY IF EXISTS "Authenticated users can delete dossiers" ON dossiers;

-- Prospecting Lists
DROP POLICY IF EXISTS "Authenticated users can read prospecting_lists"   ON prospecting_lists;
DROP POLICY IF EXISTS "Authenticated users can insert prospecting_lists" ON prospecting_lists;
DROP POLICY IF EXISTS "Authenticated users can update prospecting_lists" ON prospecting_lists;
DROP POLICY IF EXISTS "Authenticated users can delete prospecting_lists" ON prospecting_lists;

-- Activity Log
DROP POLICY IF EXISTS "Authenticated users can read activity_log"   ON activity_log;
DROP POLICY IF EXISTS "Authenticated users can insert activity_log" ON activity_log;

-- Incumbent Records
DROP POLICY IF EXISTS "Auth users read incumbent_records"   ON incumbent_records;
DROP POLICY IF EXISTS "Auth users insert incumbent_records" ON incumbent_records;
DROP POLICY IF EXISTS "Auth users update incumbent_records" ON incumbent_records;
DROP POLICY IF EXISTS "Auth users delete incumbent_records" ON incumbent_records;

-- Voter Lists
DROP POLICY IF EXISTS "Auth users read voter_lists"   ON voter_lists;
DROP POLICY IF EXISTS "Auth users insert voter_lists" ON voter_lists;
DROP POLICY IF EXISTS "Auth users update voter_lists" ON voter_lists;
DROP POLICY IF EXISTS "Auth users delete voter_lists" ON voter_lists;

-- Voters
DROP POLICY IF EXISTS "Auth users read voters"   ON voters;
DROP POLICY IF EXISTS "Auth users insert voters" ON voters;
DROP POLICY IF EXISTS "Auth users update voters" ON voters;
DROP POLICY IF EXISTS "Auth users delete voters" ON voters;

-- Voter Saved Lists
DROP POLICY IF EXISTS "Auth users read voter_saved_lists"   ON voter_saved_lists;
DROP POLICY IF EXISTS "Auth users insert voter_saved_lists" ON voter_saved_lists;
DROP POLICY IF EXISTS "Auth users update voter_saved_lists" ON voter_saved_lists;
DROP POLICY IF EXISTS "Auth users delete voter_saved_lists" ON voter_saved_lists;

-- Door Knock Lists
DROP POLICY IF EXISTS "Auth users read door_knock_lists"   ON door_knock_lists;
DROP POLICY IF EXISTS "Auth users insert door_knock_lists" ON door_knock_lists;
DROP POLICY IF EXISTS "Auth users update door_knock_lists" ON door_knock_lists;
DROP POLICY IF EXISTS "Auth users delete door_knock_lists" ON door_knock_lists;

-- Door Knocks
DROP POLICY IF EXISTS "Auth users read door_knocks"   ON door_knocks;
DROP POLICY IF EXISTS "Auth users insert door_knocks" ON door_knocks;
DROP POLICY IF EXISTS "Auth users update door_knocks" ON door_knocks;
DROP POLICY IF EXISTS "Auth users delete door_knocks" ON door_knocks;

-- ============================================================
-- 3. OFFICES & ELECTIONS — shared reference data, keep open
-- ============================================================
-- These are shared lookup tables (not user-specific), so policies stay open.
-- Existing policies are fine: USING (true) for all authenticated users.

-- ============================================================
-- 4. NEW USER-SCOPED RLS POLICIES
-- ============================================================

-- ── Candidates: user sees only their own ──────────────────────
-- created_by IS NULL allows backwards compat for pre-migration data
-- until the backfill UPDATE is run.
CREATE POLICY "Users read own candidates"
  ON candidates FOR SELECT TO authenticated
  USING (created_by = auth.uid() OR created_by IS NULL);

CREATE POLICY "Users insert own candidates"
  ON candidates FOR INSERT TO authenticated
  WITH CHECK (created_by = auth.uid());

CREATE POLICY "Users update own candidates"
  ON candidates FOR UPDATE TO authenticated
  USING (created_by = auth.uid() OR created_by IS NULL)
  WITH CHECK (created_by = auth.uid());

CREATE POLICY "Users delete own candidates"
  ON candidates FOR DELETE TO authenticated
  USING (created_by = auth.uid() OR created_by IS NULL);

-- ── Dossiers: user sees dossiers for their own candidates ─────
-- Also allow service-role inserts (generated_by IS NULL = auto-regen)
CREATE POLICY "Users read own dossiers"
  ON dossiers FOR SELECT TO authenticated
  USING (
    candidate_id IN (SELECT id FROM candidates WHERE created_by = auth.uid() OR created_by IS NULL)
    OR generated_by = auth.uid()
    OR generated_by IS NULL
  );

CREATE POLICY "Users insert dossiers"
  ON dossiers FOR INSERT TO authenticated
  WITH CHECK (true);  -- generation sets generated_by server-side

CREATE POLICY "Users update own dossiers"
  ON dossiers FOR UPDATE TO authenticated
  USING (
    generated_by = auth.uid()
    OR candidate_id IN (SELECT id FROM candidates WHERE created_by = auth.uid())
  );

CREATE POLICY "Users delete own dossiers"
  ON dossiers FOR DELETE TO authenticated
  USING (
    generated_by = auth.uid()
    OR candidate_id IN (SELECT id FROM candidates WHERE created_by = auth.uid() OR created_by IS NULL)
  );

-- ── Prospecting Lists: user sees only their own ───────────────
CREATE POLICY "Users read own prospecting_lists"
  ON prospecting_lists FOR SELECT TO authenticated
  USING (created_by = auth.uid() OR created_by IS NULL);

CREATE POLICY "Users insert own prospecting_lists"
  ON prospecting_lists FOR INSERT TO authenticated
  WITH CHECK (created_by = auth.uid());

CREATE POLICY "Users update own prospecting_lists"
  ON prospecting_lists FOR UPDATE TO authenticated
  USING (created_by = auth.uid() OR created_by IS NULL);

CREATE POLICY "Users delete own prospecting_lists"
  ON prospecting_lists FOR DELETE TO authenticated
  USING (created_by = auth.uid() OR created_by IS NULL);

-- ── Activity Log: user sees only their own ────────────────────
CREATE POLICY "Users read own activity"
  ON activity_log FOR SELECT TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "Users insert own activity"
  ON activity_log FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

-- ── Incumbent Records: scoped via parent candidate ────────────
CREATE POLICY "Users read own incumbent_records"
  ON incumbent_records FOR SELECT TO authenticated
  USING (
    candidate_id IN (SELECT id FROM candidates WHERE created_by = auth.uid() OR created_by IS NULL)
    OR created_by = auth.uid()
    OR created_by IS NULL
  );

CREATE POLICY "Users insert own incumbent_records"
  ON incumbent_records FOR INSERT TO authenticated
  WITH CHECK (created_by = auth.uid());

CREATE POLICY "Users update own incumbent_records"
  ON incumbent_records FOR UPDATE TO authenticated
  USING (created_by = auth.uid() OR created_by IS NULL);

CREATE POLICY "Users delete own incumbent_records"
  ON incumbent_records FOR DELETE TO authenticated
  USING (created_by = auth.uid() OR created_by IS NULL);

-- ── Voter Lists: user sees only their own ─────────────────────
CREATE POLICY "Users read own voter_lists"
  ON voter_lists FOR SELECT TO authenticated
  USING (created_by = auth.uid() OR created_by IS NULL);

CREATE POLICY "Users insert own voter_lists"
  ON voter_lists FOR INSERT TO authenticated
  WITH CHECK (created_by = auth.uid());

CREATE POLICY "Users update own voter_lists"
  ON voter_lists FOR UPDATE TO authenticated
  USING (created_by = auth.uid() OR created_by IS NULL);

CREATE POLICY "Users delete own voter_lists"
  ON voter_lists FOR DELETE TO authenticated
  USING (created_by = auth.uid() OR created_by IS NULL);

-- ── Voters: scoped via parent voter_list ──────────────────────
CREATE POLICY "Users read own voters"
  ON voters FOR SELECT TO authenticated
  USING (
    voter_list_id IN (SELECT id FROM voter_lists WHERE created_by = auth.uid() OR created_by IS NULL)
  );

CREATE POLICY "Users insert own voters"
  ON voters FOR INSERT TO authenticated
  WITH CHECK (
    voter_list_id IN (SELECT id FROM voter_lists WHERE created_by = auth.uid() OR created_by IS NULL)
  );

CREATE POLICY "Users update own voters"
  ON voters FOR UPDATE TO authenticated
  USING (
    voter_list_id IN (SELECT id FROM voter_lists WHERE created_by = auth.uid() OR created_by IS NULL)
  );

CREATE POLICY "Users delete own voters"
  ON voters FOR DELETE TO authenticated
  USING (
    voter_list_id IN (SELECT id FROM voter_lists WHERE created_by = auth.uid() OR created_by IS NULL)
  );

-- ── Voter Saved Lists: user sees only their own ───────────────
CREATE POLICY "Users read own voter_saved_lists"
  ON voter_saved_lists FOR SELECT TO authenticated
  USING (created_by = auth.uid() OR created_by IS NULL);

CREATE POLICY "Users insert own voter_saved_lists"
  ON voter_saved_lists FOR INSERT TO authenticated
  WITH CHECK (created_by = auth.uid());

CREATE POLICY "Users update own voter_saved_lists"
  ON voter_saved_lists FOR UPDATE TO authenticated
  USING (created_by = auth.uid() OR created_by IS NULL);

CREATE POLICY "Users delete own voter_saved_lists"
  ON voter_saved_lists FOR DELETE TO authenticated
  USING (created_by = auth.uid() OR created_by IS NULL);

-- ── Door Knock Lists: user sees only their own ────────────────
CREATE POLICY "Users read own door_knock_lists"
  ON door_knock_lists FOR SELECT TO authenticated
  USING (created_by = auth.uid() OR created_by IS NULL);

CREATE POLICY "Users insert own door_knock_lists"
  ON door_knock_lists FOR INSERT TO authenticated
  WITH CHECK (created_by = auth.uid());

CREATE POLICY "Users update own door_knock_lists"
  ON door_knock_lists FOR UPDATE TO authenticated
  USING (created_by = auth.uid() OR created_by IS NULL);

CREATE POLICY "Users delete own door_knock_lists"
  ON door_knock_lists FOR DELETE TO authenticated
  USING (created_by = auth.uid() OR created_by IS NULL);

-- ── Door Knocks: scoped via parent list ───────────────────────
CREATE POLICY "Users read own door_knocks"
  ON door_knocks FOR SELECT TO authenticated
  USING (
    list_id IN (SELECT id FROM door_knock_lists WHERE created_by = auth.uid() OR created_by IS NULL)
    OR knocked_by = auth.uid()
  );

CREATE POLICY "Users insert own door_knocks"
  ON door_knocks FOR INSERT TO authenticated
  WITH CHECK (
    list_id IN (SELECT id FROM door_knock_lists WHERE created_by = auth.uid() OR created_by IS NULL)
  );

CREATE POLICY "Users update own door_knocks"
  ON door_knocks FOR UPDATE TO authenticated
  USING (
    knocked_by = auth.uid()
    OR list_id IN (SELECT id FROM door_knock_lists WHERE created_by = auth.uid() OR created_by IS NULL)
  );

CREATE POLICY "Users delete own door_knocks"
  ON door_knocks FOR DELETE TO authenticated
  USING (
    list_id IN (SELECT id FROM door_knock_lists WHERE created_by = auth.uid() OR created_by IS NULL)
  );

-- ============================================================
-- 5. SERVICE ROLE BYPASS
-- The Supabase service_role key bypasses RLS by default.
-- This means Netlify functions using SUPABASE_SERVICE_ROLE_KEY
-- (auto-regenerate-dossiers, admin-dashboard) still have full
-- access to all rows. No changes needed for server-side functions.
-- ============================================================
