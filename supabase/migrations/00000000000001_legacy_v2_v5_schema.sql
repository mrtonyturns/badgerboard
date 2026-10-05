-- ═══ 00000000000001_legacy_v2_v5_schema.sql ═════════════════════════════════
-- REPLAY CONVERGENCE for the two hand-run legacy files that never entered the
-- chain: supabase/migration_v2.sql and supabase/migration_v5_user_data_isolation.sql.
--
-- Why: `supabase db reset` failed at 005_shifts_and_messages.sql (FK to
-- door_knock_lists) and then on every later migration that reads
-- candidates.created_by / candidates.section_timestamps / dossiers.user_id,
-- because those objects only ever existed on prod via the legacy files (or,
-- for dossiers.user_id, by hand — 20260812000020 re-adds it, but
-- 20260422000005's policies need it four months earlier in the chain).
--
-- Sorts after 00000000000000_baseline.sql and before 001_admin_tables.sql.
--
-- PROD SAFETY: every statement is a no-op where the object already exists
-- (prod). Tables are created inside to_regclass() guards so RLS / trigger
-- statements for them only run when THIS file created the table. Columns use
-- ADD COLUMN IF NOT EXISTS.
--
-- Deliberately NOT carried over:
--   * v2's "Auth users … USING (true)" policies on every new table and v5's
--     "Users … own …" policies with their `OR created_by IS NULL` escapes.
--     Later chain migrations install the authoritative owner-scoped policies
--     (20260422000001 door_knock_lists/door_knocks, 20260429000001 candidates,
--     004 + 20260422000004 voters & friends) and 20260704000004 drops v5's
--     ghosts on prod. Until those run, the new tables simply have RLS on and no
--     policy (deny-all), which is the safe state for a fresh replay.
--   * v2's voter_lists / voters / voter_saved_lists / incumbent_records: 004
--     creates them (IF NOT EXISTS), and the app works with either shape.
--   * v5's activity_log policies: handled (guarded, owner-scoped) by
--     20261005000001_bug_sweep_2.sql, which also drops the baseline's
--     permissive activity_log / dossiers / prospecting_lists policies.

-- ── candidates: v2 + v5 columns ─────────────────────────────────────────────
ALTER TABLE public.candidates ADD COLUMN IF NOT EXISTS weaknesses         JSONB DEFAULT '[]';
ALTER TABLE public.candidates ADD COLUMN IF NOT EXISTS section_timestamps JSONB DEFAULT '{}';
ALTER TABLE public.candidates ADD COLUMN IF NOT EXISTS is_incumbent       BOOLEAN DEFAULT false;
ALTER TABLE public.candidates ADD COLUMN IF NOT EXISTS incumbent_since    DATE;
ALTER TABLE public.candidates ADD COLUMN IF NOT EXISTS created_by         UUID REFERENCES auth.users(id);

-- ── dossiers.user_id (needed by 20260422000005 / 20260422000007) ────────────
-- Same definition 20260812000020_schema_reconciliation.sql uses.
ALTER TABLE public.dossiers ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id);

-- ── door_knock_lists (v2) ───────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.door_knock_lists') IS NULL THEN
    CREATE TABLE public.door_knock_lists (
      id            UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
      name          TEXT NOT NULL,
      description   TEXT,
      candidate_id  UUID REFERENCES public.candidates(id) ON DELETE SET NULL,
      election_id   UUID REFERENCES public.elections(id) ON DELETE SET NULL,
      status        TEXT DEFAULT 'active' CHECK (status IN ('active','completed','archived')),
      target_count  INT DEFAULT 0,
      knocked_count INT DEFAULT 0,
      created_by    UUID REFERENCES auth.users(id),
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      updated_at    TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE public.door_knock_lists ENABLE ROW LEVEL SECURITY;
    CREATE TRIGGER door_knock_lists_updated_at
      BEFORE UPDATE ON public.door_knock_lists
      FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;
END $$;

-- ── door_knocks (v2) ────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.door_knocks') IS NULL THEN
    CREATE TABLE public.door_knocks (
      id                UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
      list_id           UUID REFERENCES public.door_knock_lists(id) ON DELETE CASCADE,
      address           TEXT NOT NULL,
      city              TEXT,
      zip               TEXT,
      resident_name     TEXT,
      phone             TEXT,
      status            TEXT DEFAULT 'not_home' CHECK (status IN (
        'contacted','not_home','refused','moved','wrong_address','do_not_knock'
      )),
      party_affiliation TEXT,
      received_mailer   BOOLEAN,
      support_level     INT CHECK (support_level BETWEEN 1 AND 5),
      notes             TEXT,
      knocked_by        UUID REFERENCES auth.users(id),
      knocked_at        TIMESTAMPTZ DEFAULT NOW(),
      latitude          DECIMAL(10,7),
      longitude         DECIMAL(10,7),
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      updated_at        TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE public.door_knocks ENABLE ROW LEVEL SECURITY;
    CREATE TRIGGER door_knocks_updated_at
      BEFORE UPDATE ON public.door_knocks
      FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;
END $$;

-- ── volunteers (chain-ordering fix, not legacy) ─────────────────────────────
-- 20260422000001_rls_hardening.sql creates policies ON volunteers, but the
-- table is only created by the NEXT file, 20260422000002_volunteers.sql (prod
-- ran them by hand in the other order). Same definition as 20260422000002 so
-- its CREATE TABLE IF NOT EXISTS is a no-op afterwards. The transient
-- "volunteers_owner_all" policy 20260422000002 then adds is dropped again by
-- 20260422000006_volunteer_rls_hardening.sql.
DO $$
BEGIN
  IF to_regclass('public.volunteers') IS NULL THEN
    CREATE TABLE public.volunteers (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      created_by    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
      list_id       UUID REFERENCES public.door_knock_lists(id) ON DELETE SET NULL,
      name          TEXT NOT NULL,
      email         TEXT NOT NULL,
      phone         TEXT,
      role          TEXT NOT NULL DEFAULT 'canvasser',
      status        TEXT NOT NULL DEFAULT 'invited',
      avatar_color  TEXT DEFAULT '#4f46e5',
      notes         TEXT,
      doors_knocked INTEGER NOT NULL DEFAULT 0,
      contacts_made INTEGER NOT NULL DEFAULT 0,
      shifts_worked INTEGER NOT NULL DEFAULT 0,
      last_active   TIMESTAMPTZ,
      magic_token   TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE public.volunteers ENABLE ROW LEVEL SECURITY;
  END IF;
END $$;
