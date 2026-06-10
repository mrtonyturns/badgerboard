-- ============================================================
-- Badger Board Admin Tables Migration
-- Run this in Supabase SQL editor (Dashboard → SQL Editor)
-- ============================================================

-- ─── Announcements ───────────────────────────────────────────
-- Site-wide banners toggled by admin. Users see active ones.

CREATE TABLE IF NOT EXISTS public.announcements (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  message     text        NOT NULL,
  type        text        NOT NULL DEFAULT 'info'
                          CHECK (type IN ('info', 'warning', 'success', 'error')),
  is_active   boolean     NOT NULL DEFAULT true,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.announcements ENABLE ROW LEVEL SECURITY;

-- Anyone authenticated can read active announcements
CREATE POLICY "Read active announcements"
  ON public.announcements FOR SELECT
  USING (is_active = true);

-- ─── Account Notes ───────────────────────────────────────────
-- Admin-only sticky notes attached to user accounts.

CREATE TABLE IF NOT EXISTS public.account_notes (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL,
  note        text        NOT NULL,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.account_notes ENABLE ROW LEVEL SECURITY;
-- No user-facing policy — admin reads/writes via service role only.

-- ─── Activity Logs ───────────────────────────────────────────
-- Lightweight page-visit / action tracking for the admin panel.

CREATE TABLE IF NOT EXISTS public.activity_logs (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL,
  page        text,
  action      text,
  metadata    jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.activity_logs ENABLE ROW LEVEL SECURITY;

-- Users can insert their own activity
CREATE POLICY "Users insert own activity"
  ON public.activity_logs FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- ─── Error Logs ──────────────────────────────────────────────
-- Captured frontend / function errors with stack traces.

CREATE TABLE IF NOT EXISTS public.error_logs (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid,
  error_message text        NOT NULL,
  error_stack   text,
  component     text,
  url           text,
  user_agent    text,
  metadata      jsonb,
  resolved      boolean     NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.error_logs ENABLE ROW LEVEL SECURITY;

-- Any authenticated user can log an error (no user_id check so
-- we can log errors even before full auth resolves)
CREATE POLICY "Anyone can insert errors"
  ON public.error_logs FOR INSERT
  WITH CHECK (true);

-- ─── Indexes for performance ─────────────────────────────────
CREATE INDEX IF NOT EXISTS activity_logs_user_idx ON public.activity_logs (user_id);
CREATE INDEX IF NOT EXISTS activity_logs_created_idx ON public.activity_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS error_logs_created_idx ON public.error_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS error_logs_resolved_idx ON public.error_logs (resolved);
CREATE INDEX IF NOT EXISTS account_notes_user_idx ON public.account_notes (user_id);
