-- Migration 009: Drop residual permissive RLS policies on door_knock_shifts and canvass_messages
--
-- When migration 005 created these tables it added "Auth users *" policies that
-- allow any authenticated user to read/write all rows. Migration 006 added
-- owner-scoped replacements for "shifts_*" and "messages_*" policies, but the
-- original "Auth users *" names were never dropped. PostgreSQL ORs multiple
-- permissive policies together, so the old USING(true) policies override the
-- new owner-scoped checks and allow any auth user to read every row.
--
-- Fix: drop the old "Auth users" policies so only the owner-scoped ones remain.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── door_knock_shifts ──────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Auth users read door_knock_shifts"   ON public.door_knock_shifts;
DROP POLICY IF EXISTS "Auth users insert door_knock_shifts" ON public.door_knock_shifts;
DROP POLICY IF EXISTS "Auth users update door_knock_shifts" ON public.door_knock_shifts;
DROP POLICY IF EXISTS "Auth users delete door_knock_shifts" ON public.door_knock_shifts;

-- ── canvass_messages ───────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Auth users read canvass_messages"   ON public.canvass_messages;
DROP POLICY IF EXISTS "Auth users insert canvass_messages" ON public.canvass_messages;
DROP POLICY IF EXISTS "Auth users update canvass_messages" ON public.canvass_messages;
DROP POLICY IF EXISTS "Auth users delete canvass_messages" ON public.canvass_messages;
