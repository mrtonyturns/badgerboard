// netlify/functions/apply-dk-migration.js
// One-shot migration runner — secured by ADMIN_SETUP_TOKEN.
// Hit with:  POST /.netlify/functions/apply-dk-migration  { "token": "<ADMIN_SETUP_TOKEN>" }
// Safe to call multiple times — all statements use CREATE TABLE IF NOT EXISTS.
//
// DELETE THIS FILE after migration is confirmed.

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY
const ADMIN_TOKEN  = process.env.ADMIN_SETUP_TOKEN

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) }
  }

  let body
  try { body = JSON.parse(event.body) } catch { body = {} }

  if (!body.token || body.token !== ADMIN_TOKEN) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) }
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY)

  // We'll create each table by attempting to select from it (fails gracefully if exists)
  // then insert a dummy row using the service role to trigger table creation via RPC.
  // Since we can't run DDL via REST, we use the Postgres wire protocol via pg npm package
  // which Supabase supports via the connection pooler.
  // Instead: use a known Supabase pattern — create a DB function that runs DDL, call it once.

  // Strategy: call a custom SQL executor function if it exists, otherwise return the SQL to run manually
  const SQL_STATEMENTS = [
    `CREATE TABLE IF NOT EXISTS turf_blocks (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      list_id uuid REFERENCES door_knock_lists(id) ON DELETE CASCADE,
      name text NOT NULL,
      bbox jsonb NOT NULL,
      house_count int DEFAULT 0,
      created_by uuid REFERENCES auth.users(id),
      created_at timestamptz DEFAULT now()
    )`,
    `ALTER TABLE turf_blocks ENABLE ROW LEVEL SECURITY`,
    `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'turf_blocks' AND policyname = 'turf_blocks_owner') THEN
        CREATE POLICY "turf_blocks_owner" ON turf_blocks FOR ALL USING (created_by = auth.uid());
      END IF;
    END $$`,
    `CREATE TABLE IF NOT EXISTS turf_assignments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      block_id uuid REFERENCES turf_blocks(id) ON DELETE CASCADE,
      list_id uuid REFERENCES door_knock_lists(id) ON DELETE CASCADE,
      volunteer_name text NOT NULL,
      volunteer_email text,
      status text DEFAULT 'assigned' CHECK (status IN ('assigned','active','complete')),
      assigned_at timestamptz DEFAULT now(),
      completed_at timestamptz
    )`,
    `ALTER TABLE turf_assignments ENABLE ROW LEVEL SECURITY`,
    `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'turf_assignments' AND policyname = 'turf_assignments_owner') THEN
        CREATE POLICY "turf_assignments_owner" ON turf_assignments FOR ALL USING (
          block_id IN (SELECT id FROM turf_blocks WHERE created_by = auth.uid())
        );
      END IF;
    END $$`,
    `CREATE TABLE IF NOT EXISTS volunteers (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      coordinator_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
      list_id uuid REFERENCES door_knock_lists(id) ON DELETE SET NULL,
      name text NOT NULL,
      email text,
      phone text,
      role text DEFAULT 'volunteer' CHECK (role IN ('volunteer','captain')),
      invite_token text UNIQUE,
      invite_sent_at timestamptz,
      status text DEFAULT 'invited' CHECK (status IN ('invited','active','inactive')),
      created_at timestamptz DEFAULT now()
    )`,
    `ALTER TABLE volunteers ENABLE ROW LEVEL SECURITY`,
    `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'volunteers' AND policyname = 'volunteers_owner') THEN
        CREATE POLICY "volunteers_owner" ON volunteers FOR ALL USING (coordinator_id = auth.uid());
      END IF;
    END $$`,
    `CREATE TABLE IF NOT EXISTS voter_file_entries (
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
    )`,
    `ALTER TABLE voter_file_entries ENABLE ROW LEVEL SECURITY`,
    `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'voter_file_entries' AND policyname = 'voter_file_entries_owner') THEN
        CREATE POLICY "voter_file_entries_owner" ON voter_file_entries FOR ALL USING (created_by = auth.uid());
      END IF;
    END $$`,
  ]

  // Try to run via the pg package (available via @supabase/supabase-js internals)
  // Actually, PostgREST only exposes RPC calls. We need a pre-created DB function.
  // Return the SQL for the user to run in the Supabase SQL Editor.
  return {
    statusCode: 200,
    body: JSON.stringify({
      message: 'Migration SQL ready. Please run the following in your Supabase SQL Editor.',
      sql: SQL_STATEMENTS.join(';\n\n') + ';',
      note: 'This function cannot execute DDL via the REST API. Copy the SQL above into https://supabase.com/dashboard/project/cwsaskvanrzucufualbs/sql'
    })
  }
}
