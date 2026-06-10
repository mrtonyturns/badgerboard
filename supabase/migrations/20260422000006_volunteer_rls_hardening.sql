-- Migration: Harden RLS on volunteer/canvass tables
--
-- Problems fixed:
--   1. volunteers       — migration 20260422000002 re-created the broad
--                         "volunteers_owner_all" policy AFTER migration
--                         20260422000001 had already replaced it with tighter
--                         per-operation policies. Drop it again, and also remove
--                         the list_id IS NULL exception from INSERT (no reason to
--                         create a volunteer without a list).
--   2. door_knock_shifts — policies were USING (auth.uid() is not null), letting
--                          any authenticated user read/write any shift.
--   3. canvass_messages  — same permissive pattern; scope to list owners.
--   4. volunteer_messages, volunteer_notifications — policies exist in code but
--                          may not have been applied to the live DB; ensure they
--                          are correct and present.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. volunteers: drop re-created broad policy ───────────────────────────────
DROP POLICY IF EXISTS "volunteers_owner_all"    ON public.volunteers;
-- Keep the per-operation policies from 20260422000001 — just ensure they exist.
DROP POLICY IF EXISTS "volunteers_owner_select" ON public.volunteers;
DROP POLICY IF EXISTS "volunteers_owner_update" ON public.volunteers;
DROP POLICY IF EXISTS "volunteers_owner_delete" ON public.volunteers;
DROP POLICY IF EXISTS "volunteers_owner_insert" ON public.volunteers;

CREATE POLICY "volunteers_owner_select"
  ON public.volunteers FOR SELECT
  USING (created_by = auth.uid());

CREATE POLICY "volunteers_owner_update"
  ON public.volunteers FOR UPDATE
  USING (created_by = auth.uid())
  WITH CHECK (created_by = auth.uid());

CREATE POLICY "volunteers_owner_delete"
  ON public.volunteers FOR DELETE
  USING (created_by = auth.uid());

-- INSERT — created_by must be caller AND list must belong to caller.
-- Removed the list_id IS NULL exception: every volunteer must belong to a list.
CREATE POLICY "volunteers_owner_insert"
  ON public.volunteers FOR INSERT
  WITH CHECK (
    created_by = auth.uid()
    AND list_id IN (
      SELECT id FROM public.door_knock_lists WHERE created_by = auth.uid()
    )
  );

-- ── 2. door_knock_shifts: replace permissive policies ────────────────────────
DROP POLICY IF EXISTS "shifts_select" ON public.door_knock_shifts;
DROP POLICY IF EXISTS "shifts_insert" ON public.door_knock_shifts;
DROP POLICY IF EXISTS "shifts_update" ON public.door_knock_shifts;
DROP POLICY IF EXISTS "shifts_delete" ON public.door_knock_shifts;

-- Scope to the owner of the parent door_knock_list
CREATE POLICY "shifts_select"
  ON public.door_knock_shifts FOR SELECT
  USING (
    list_id IN (SELECT id FROM public.door_knock_lists WHERE created_by = auth.uid())
  );

CREATE POLICY "shifts_insert"
  ON public.door_knock_shifts FOR INSERT
  WITH CHECK (
    created_by = auth.uid()
    AND list_id IN (SELECT id FROM public.door_knock_lists WHERE created_by = auth.uid())
  );

CREATE POLICY "shifts_update"
  ON public.door_knock_shifts FOR UPDATE
  USING (
    list_id IN (SELECT id FROM public.door_knock_lists WHERE created_by = auth.uid())
  )
  WITH CHECK (
    list_id IN (SELECT id FROM public.door_knock_lists WHERE created_by = auth.uid())
  );

CREATE POLICY "shifts_delete"
  ON public.door_knock_shifts FOR DELETE
  USING (
    list_id IN (SELECT id FROM public.door_knock_lists WHERE created_by = auth.uid())
  );

-- ── 3. canvass_messages: replace permissive policies ─────────────────────────
DROP POLICY IF EXISTS "messages_select" ON public.canvass_messages;
DROP POLICY IF EXISTS "messages_insert" ON public.canvass_messages;
DROP POLICY IF EXISTS "messages_delete" ON public.canvass_messages;

CREATE POLICY "messages_select"
  ON public.canvass_messages FOR SELECT
  USING (
    list_id IN (SELECT id FROM public.door_knock_lists WHERE created_by = auth.uid())
  );

CREATE POLICY "messages_insert"
  ON public.canvass_messages FOR INSERT
  WITH CHECK (
    list_id IN (SELECT id FROM public.door_knock_lists WHERE created_by = auth.uid())
  );

CREATE POLICY "messages_delete"
  ON public.canvass_messages FOR DELETE
  USING (
    list_id IN (SELECT id FROM public.door_knock_lists WHERE created_by = auth.uid())
  );

-- ── 4. volunteer_messages: ensure policies are applied ───────────────────────
ALTER TABLE public.volunteer_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "vol_messages_coordinator"        ON public.volunteer_messages;
DROP POLICY IF EXISTS "vol_messages_coordinator_select" ON public.volunteer_messages;
DROP POLICY IF EXISTS "vol_messages_coordinator_insert" ON public.volunteer_messages;
DROP POLICY IF EXISTS "vol_messages_coordinator_delete" ON public.volunteer_messages;

-- Coordinators can read/write messages for their own lists.
-- Volunteers access these via service-key calls in volunteer-auth.js, not direct client.
CREATE POLICY "vol_messages_coordinator_select"
  ON public.volunteer_messages FOR SELECT
  USING (
    list_id IN (SELECT id FROM public.door_knock_lists WHERE created_by = auth.uid())
  );

CREATE POLICY "vol_messages_coordinator_insert"
  ON public.volunteer_messages FOR INSERT
  WITH CHECK (
    list_id IN (SELECT id FROM public.door_knock_lists WHERE created_by = auth.uid())
  );

CREATE POLICY "vol_messages_coordinator_delete"
  ON public.volunteer_messages FOR DELETE
  USING (
    list_id IN (SELECT id FROM public.door_knock_lists WHERE created_by = auth.uid())
  );

-- ── 5. volunteer_notifications: ensure policies are applied ──────────────────
ALTER TABLE public.volunteer_notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "vol_notifs_coordinator"        ON public.volunteer_notifications;
DROP POLICY IF EXISTS "vol_notifs_coordinator_select" ON public.volunteer_notifications;
DROP POLICY IF EXISTS "vol_notifs_coordinator_insert" ON public.volunteer_notifications;
DROP POLICY IF EXISTS "vol_notifs_coordinator_delete" ON public.volunteer_notifications;

CREATE POLICY "vol_notifs_coordinator_select"
  ON public.volunteer_notifications FOR SELECT
  USING (
    list_id IN (SELECT id FROM public.door_knock_lists WHERE created_by = auth.uid())
  );

CREATE POLICY "vol_notifs_coordinator_insert"
  ON public.volunteer_notifications FOR INSERT
  WITH CHECK (
    created_by = auth.uid()
    AND list_id IN (SELECT id FROM public.door_knock_lists WHERE created_by = auth.uid())
  );

CREATE POLICY "vol_notifs_coordinator_delete"
  ON public.volunteer_notifications FOR DELETE
  USING (
    list_id IN (SELECT id FROM public.door_knock_lists WHERE created_by = auth.uid())
  );
