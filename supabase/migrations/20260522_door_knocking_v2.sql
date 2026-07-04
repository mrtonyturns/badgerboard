-- 20260522_door_knocking_v2.sql
-- Turf blocks, turf assignments, volunteers roster, and voter file tables.

-- ─── Turf blocks: geographic assignments within a campaign list ───────────────
CREATE TABLE IF NOT EXISTS turf_blocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id uuid REFERENCES door_knock_lists(id) ON DELETE CASCADE,
  name text NOT NULL,
  bbox jsonb NOT NULL,
  house_count int DEFAULT 0,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz DEFAULT now()
);

ALTER TABLE turf_blocks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "turf_blocks_owner" ON turf_blocks
  FOR ALL USING (created_by = auth.uid());

-- ─── Turf assignments: volunteer → block mapping ─────────────────────────────
CREATE TABLE IF NOT EXISTS turf_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  block_id uuid REFERENCES turf_blocks(id) ON DELETE CASCADE,
  list_id uuid REFERENCES door_knock_lists(id) ON DELETE CASCADE,
  volunteer_name text NOT NULL,
  volunteer_email text,
  status text DEFAULT 'assigned' CHECK (status IN ('assigned','active','complete')),
  assigned_at timestamptz DEFAULT now(),
  completed_at timestamptz
);

ALTER TABLE turf_assignments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "turf_assignments_owner" ON turf_assignments
  FOR ALL USING (
    block_id IN (SELECT id FROM turf_blocks WHERE created_by = auth.uid())
  );

-- NOTE: The volunteers table is defined in 20260422000002_volunteers.sql with the
-- correct created_by column. The original block here used coordinator_id (wrong)
-- and was removed to prevent this migration from failing. The RLS for volunteers
-- is maintained by 20260422000006_volunteer_rls_hardening.sql.

-- ─── Voter file entries ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS voter_file_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id uuid REFERENCES door_knock_lists(id) ON DELETE CASCADE,
  created_by uuid REFERENCES auth.users(id),
  address text NOT NULL,
  full_name text,
  party text,
  age int,
  lat double precision,
  lng double precision,
  propensity int DEFAULT 5,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE voter_file_entries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "voter_file_entries_owner" ON voter_file_entries
  FOR ALL USING (created_by = auth.uid());
