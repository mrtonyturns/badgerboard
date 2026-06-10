-- ─────────────────────────────────────────────────────────────────────────────
-- Volunteer Mobile App Tables
-- Run in Supabase SQL Editor
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Volunteers (managed by campaign users, linked to door knock lists)
CREATE TABLE IF NOT EXISTS volunteers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  list_id       UUID REFERENCES door_knock_lists(id) ON DELETE SET NULL,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL,
  phone         TEXT,
  role          TEXT NOT NULL DEFAULT 'canvasser', -- 'canvasser' | 'captain'
  status        TEXT NOT NULL DEFAULT 'invited',   -- 'invited' | 'active' | 'inactive'
  avatar_color  TEXT DEFAULT '#4f46e5',
  notes         TEXT,
  -- Stats
  doors_knocked INTEGER NOT NULL DEFAULT 0,
  contacts_made INTEGER NOT NULL DEFAULT 0,
  shifts_worked INTEGER NOT NULL DEFAULT 0,
  last_active   TIMESTAMPTZ,
  -- Auth
  magic_token   TEXT,  -- ephemeral invite token (cleared on first use)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Volunteer Messages (group chat per list)
CREATE TABLE IF NOT EXISTS volunteer_messages (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id       UUID NOT NULL REFERENCES door_knock_lists(id) ON DELETE CASCADE,
  sender_id     UUID NOT NULL,                      -- auth.users id (coordinator) OR volunteer id
  sender_type   TEXT NOT NULL DEFAULT 'coordinator', -- 'coordinator' | 'volunteer'
  sender_name   TEXT NOT NULL,
  content       TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Volunteer Notifications (broadcast or targeted)
CREATE TABLE IF NOT EXISTS volunteer_notifications (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id       UUID NOT NULL REFERENCES door_knock_lists(id) ON DELETE CASCADE,
  created_by    UUID NOT NULL,                      -- coordinator user id
  volunteer_id  UUID REFERENCES volunteers(id) ON DELETE CASCADE,  -- NULL = broadcast to all
  title         TEXT NOT NULL,
  body          TEXT,
  type          TEXT NOT NULL DEFAULT 'info',       -- 'info' | 'warning' | 'success' | 'urgent'
  read_by       UUID[] NOT NULL DEFAULT '{}',       -- array of volunteer ids who have read it
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Indexes ─────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS volunteers_created_by_idx  ON volunteers(created_by);
CREATE INDEX IF NOT EXISTS volunteers_list_id_idx     ON volunteers(list_id);
CREATE INDEX IF NOT EXISTS volunteers_email_idx       ON volunteers(email);
CREATE INDEX IF NOT EXISTS vol_messages_list_id_idx   ON volunteer_messages(list_id);
CREATE INDEX IF NOT EXISTS vol_messages_created_at_idx ON volunteer_messages(created_at);
CREATE INDEX IF NOT EXISTS vol_notifs_list_id_idx     ON volunteer_notifications(list_id);
CREATE INDEX IF NOT EXISTS vol_notifs_volunteer_idx   ON volunteer_notifications(volunteer_id);

-- ─── Updated_at trigger ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ language 'plpgsql';

DROP TRIGGER IF EXISTS volunteers_updated_at ON volunteers;
CREATE TRIGGER volunteers_updated_at
  BEFORE UPDATE ON volunteers
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ─── Row Level Security ───────────────────────────────────────────────────────
ALTER TABLE volunteers              ENABLE ROW LEVEL SECURITY;
ALTER TABLE volunteer_messages      ENABLE ROW LEVEL SECURITY;
ALTER TABLE volunteer_notifications ENABLE ROW LEVEL SECURITY;

-- Volunteers: campaign users manage their own volunteers
CREATE POLICY "volunteers_owner_all"
  ON volunteers FOR ALL
  USING (created_by = auth.uid())
  WITH CHECK (created_by = auth.uid());

-- Volunteer messages: coordinator can do anything for their lists
CREATE POLICY "vol_messages_coordinator"
  ON volunteer_messages FOR ALL
  USING (
    list_id IN (
      SELECT id FROM door_knock_lists WHERE created_by = auth.uid()
    )
  );

-- Volunteer notifications: coordinator can manage their list notifications
CREATE POLICY "vol_notifs_coordinator"
  ON volunteer_notifications FOR ALL
  USING (
    list_id IN (
      SELECT id FROM door_knock_lists WHERE created_by = auth.uid()
    )
  );

-- ─── Enable Realtime on messaging tables ─────────────────────────────────────
-- Run these in Supabase dashboard under Database > Replication (or via SQL):
ALTER PUBLICATION supabase_realtime ADD TABLE volunteer_messages;
ALTER PUBLICATION supabase_realtime ADD TABLE volunteer_notifications;
