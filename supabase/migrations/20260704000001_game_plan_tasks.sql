-- Migration: Game Plan Tasks (Todoist-style task system)
-- Replaces the milestone tracker UI with a full task manager:
--   projects → sections → tasks (subtasks, priorities p1–p4, labels, due dates)
-- Existing game_plan_milestones rows are migrated into a "Campaign Plan"
-- project per user (phases become sections). The old table is left untouched.
--
-- Safe to run multiple times (IF NOT EXISTS + ON CONFLICT guards throughout).

-- ─── 1. Projects ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS gp_projects (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by   UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name         TEXT        NOT NULL,
  color        TEXT        NOT NULL DEFAULT '#808080',
  is_favorite  BOOLEAN     NOT NULL DEFAULT false,
  sort_order   INTEGER     NOT NULL DEFAULT 0,
  archived     BOOLEAN     NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── 2. Sections ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS gp_sections (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by   UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  project_id   UUID        NOT NULL REFERENCES gp_projects(id) ON DELETE CASCADE,
  name         TEXT        NOT NULL,
  sort_order   INTEGER     NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── 3. Tasks ─────────────────────────────────────────────────────────────────
-- project_id NULL = Inbox. parent_id set = subtask.
CREATE TABLE IF NOT EXISTS gp_tasks (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by          UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  project_id          UUID        REFERENCES gp_projects(id)  ON DELETE CASCADE,
  section_id          UUID        REFERENCES gp_sections(id)  ON DELETE SET NULL,
  parent_id           UUID        REFERENCES gp_tasks(id)     ON DELETE CASCADE,

  content             TEXT        NOT NULL,
  description         TEXT,
  due_date            DATE,
  priority            SMALLINT    NOT NULL DEFAULT 4 CHECK (priority BETWEEN 1 AND 4),
  labels              TEXT[]      NOT NULL DEFAULT '{}',
  sort_order          INTEGER     NOT NULL DEFAULT 0,

  completed           BOOLEAN     NOT NULL DEFAULT false,
  completed_at        TIMESTAMPTZ,

  -- provenance for the one-time milestone migration (makes re-runs idempotent)
  source_milestone_id UUID UNIQUE,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── 4. Labels ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS gp_labels (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by   UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name         TEXT        NOT NULL,
  color        TEXT        NOT NULL DEFAULT '#808080',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (created_by, name)
);

-- ─── 5. RLS ───────────────────────────────────────────────────────────────────
ALTER TABLE gp_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE gp_sections ENABLE ROW LEVEL SECURITY;
ALTER TABLE gp_tasks    ENABLE ROW LEVEL SECURITY;
ALTER TABLE gp_labels   ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'gp_projects' AND policyname = 'Users manage own projects') THEN
    CREATE POLICY "Users manage own projects" ON gp_projects
      FOR ALL USING (created_by = auth.uid()) WITH CHECK (created_by = auth.uid());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'gp_sections' AND policyname = 'Users manage own sections') THEN
    CREATE POLICY "Users manage own sections" ON gp_sections
      FOR ALL USING (created_by = auth.uid()) WITH CHECK (created_by = auth.uid());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'gp_tasks' AND policyname = 'Users manage own tasks') THEN
    CREATE POLICY "Users manage own tasks" ON gp_tasks
      FOR ALL USING (created_by = auth.uid()) WITH CHECK (created_by = auth.uid());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'gp_labels' AND policyname = 'Users manage own labels') THEN
    CREATE POLICY "Users manage own labels" ON gp_labels
      FOR ALL USING (created_by = auth.uid()) WITH CHECK (created_by = auth.uid());
  END IF;
END $$;

-- ─── 6. Indexes ───────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_gp_projects_created_by ON gp_projects (created_by);
CREATE INDEX IF NOT EXISTS idx_gp_sections_project    ON gp_sections (project_id);
CREATE INDEX IF NOT EXISTS idx_gp_tasks_created_by    ON gp_tasks (created_by);
CREATE INDEX IF NOT EXISTS idx_gp_tasks_project       ON gp_tasks (project_id);
CREATE INDEX IF NOT EXISTS idx_gp_tasks_section       ON gp_tasks (section_id);
CREATE INDEX IF NOT EXISTS idx_gp_tasks_parent        ON gp_tasks (parent_id);
CREATE INDEX IF NOT EXISTS idx_gp_tasks_due_date      ON gp_tasks (due_date);
CREATE INDEX IF NOT EXISTS idx_gp_labels_created_by   ON gp_labels (created_by);

-- ─── 7. updated_at triggers ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION gp_touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS trg_gp_projects_updated ON gp_projects;
CREATE TRIGGER trg_gp_projects_updated BEFORE UPDATE ON gp_projects
  FOR EACH ROW EXECUTE FUNCTION gp_touch_updated_at();
DROP TRIGGER IF EXISTS trg_gp_sections_updated ON gp_sections;
CREATE TRIGGER trg_gp_sections_updated BEFORE UPDATE ON gp_sections
  FOR EACH ROW EXECUTE FUNCTION gp_touch_updated_at();
DROP TRIGGER IF EXISTS trg_gp_tasks_updated ON gp_tasks;
CREATE TRIGGER trg_gp_tasks_updated BEFORE UPDATE ON gp_tasks
  FOR EACH ROW EXECUTE FUNCTION gp_touch_updated_at();

-- ─── 8. Migrate existing milestones ──────────────────────────────────────────
-- For every user with milestones: create a "Campaign Plan" project, one section
-- per campaign phase (in campaign order), and one task per milestone.
--   complete/skipped → completed tasks; category → label; notes → description.
-- Idempotent via gp_tasks.source_milestone_id UNIQUE.
DO $$
DECLARE
  u           RECORD;
  m           RECORD;
  proj_id     UUID;
  sec_id      UUID;
  phase_keys  TEXT[] := ARRAY['planning','filing','voter_contact','fundraising','gotv','election_day'];
  phase_names TEXT[] := ARRAY['Planning','Filing','Voter Contact','Fundraising','GOTV','Election Day'];
  i           INTEGER;
BEGIN
  FOR u IN (SELECT DISTINCT created_by FROM game_plan_milestones WHERE created_by IS NOT NULL) LOOP

    -- Find or create the user's Campaign Plan project
    SELECT id INTO proj_id FROM gp_projects
      WHERE created_by = u.created_by AND name = 'Campaign Plan' LIMIT 1;
    IF proj_id IS NULL THEN
      INSERT INTO gp_projects (created_by, name, color, is_favorite, sort_order)
        VALUES (u.created_by, 'Campaign Plan', '#8B0000', true, 0)
        RETURNING id INTO proj_id;
    END IF;

    -- Sections per phase (only phases this user actually used)
    FOR i IN 1..array_length(phase_keys, 1) LOOP
      IF EXISTS (SELECT 1 FROM game_plan_milestones
                 WHERE created_by = u.created_by AND phase = phase_keys[i]) THEN
        SELECT id INTO sec_id FROM gp_sections
          WHERE created_by = u.created_by AND project_id = proj_id AND name = phase_names[i] LIMIT 1;
        IF sec_id IS NULL THEN
          INSERT INTO gp_sections (created_by, project_id, name, sort_order)
            VALUES (u.created_by, proj_id, phase_names[i], i)
            RETURNING id INTO sec_id;
        END IF;

        -- Tasks for this phase
        FOR m IN (SELECT * FROM game_plan_milestones
                  WHERE created_by = u.created_by AND phase = phase_keys[i]
                  ORDER BY due_date NULLS LAST, created_at) LOOP
          INSERT INTO gp_tasks (
            created_by, project_id, section_id, content, description, due_date,
            priority, labels, completed, completed_at, source_milestone_id, sort_order
          ) VALUES (
            m.created_by, proj_id, sec_id, m.title, NULLIF(m.notes, ''), m.due_date,
            CASE WHEN m.status = 'in_progress' THEN 2 ELSE 4 END,
            CASE WHEN m.category IS NOT NULL AND m.category <> 'general'
                 THEN ARRAY[m.category] ELSE '{}'::TEXT[] END,
            m.status IN ('complete', 'skipped'),
            CASE WHEN m.status IN ('complete', 'skipped') THEN m.updated_at ELSE NULL END,
            m.id, 0
          )
          ON CONFLICT (source_milestone_id) DO NOTHING;
        END LOOP;
      END IF;
    END LOOP;

    -- Seed labels used by this user's migrated tasks
    INSERT INTO gp_labels (created_by, name, color)
      SELECT DISTINCT m2.created_by, m2.category, '#6B7280'
      FROM game_plan_milestones m2
      WHERE m2.created_by = u.created_by AND m2.category IS NOT NULL AND m2.category <> 'general'
    ON CONFLICT (created_by, name) DO NOTHING;

  END LOOP;
END $$;

-- ─── 9. Comments ──────────────────────────────────────────────────────────────
COMMENT ON TABLE gp_projects IS 'Game Plan task projects (Todoist-style). NULL project on a task = Inbox.';
COMMENT ON TABLE gp_sections IS 'Sections within a Game Plan project.';
COMMENT ON TABLE gp_tasks    IS 'Game Plan tasks. priority 1 = highest (p1) … 4 = none (p4). parent_id set = subtask.';
COMMENT ON TABLE gp_labels   IS 'User-defined labels for Game Plan tasks.';
