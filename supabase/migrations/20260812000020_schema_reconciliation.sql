-- ═══ Tier 1A — Schema reconciliation (APP-full-test-report.md, approved) ═════
-- The app writes columns/tables that exist in no migration file. Prod mostly
-- has them (they were applied by hand or via schema.sql lineages); this
-- migration makes the CHAIN authoritative so a clean rebuild matches prod, and
-- closes the two gaps prod really had: notification_preferences.weekly_digest
-- and the candidate-files storage bucket. Every statement is idempotent.

-- ── 1. calendar_feed_items.reminder_minutes ─────────────────────────────────
-- Written by Events.jsx / campaign-connect.js, read by calendar-feed.js (ICS).
DO $$ BEGIN
  IF to_regclass('public.calendar_feed_items') IS NOT NULL THEN
    ALTER TABLE public.calendar_feed_items
      ADD COLUMN IF NOT EXISTS reminder_minutes INTEGER NOT NULL DEFAULT 60;
  END IF;
END $$;

-- ── 2. candidates.swot_data ─────────────────────────────────────────────────
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS swot_data JSONB;

-- ── 3. dossiers.user_id ─────────────────────────────────────────────────────
ALTER TABLE dossiers ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id);

-- ── 4. notification_preferences — the FLAT-COLUMN shape is authoritative ────
-- Prod has flat columns; the migration chain had a `prefs jsonb` nothing read.
-- Recreate the flat shape idempotently (no-ops on prod, converges rebuilds),
-- and add weekly_digest — the one column prod was missing, which made the
-- Monday-digest opt-out dead (getNotificationPrefs defaulted it to true).
ALTER TABLE notification_preferences ADD COLUMN IF NOT EXISTS payment_failed  BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE notification_preferences ADD COLUMN IF NOT EXISTS payment_receipt BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE notification_preferences ADD COLUMN IF NOT EXISTS plan_changed    BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE notification_preferences ADD COLUMN IF NOT EXISTS account_locked  BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE notification_preferences ADD COLUMN IF NOT EXISTS dossier_ready   BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE notification_preferences ADD COLUMN IF NOT EXISTS weekly_digest   BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE notification_preferences ADD COLUMN IF NOT EXISTS ai_access_default BOOLEAN NOT NULL DEFAULT true;

-- ── 5. candidate-files storage bucket ───────────────────────────────────────
-- Policies have been in the chain since 20260516000001; the bucket itself was
-- only created by an admin one-off. Missing on prod until now.
INSERT INTO storage.buckets (id, name, public)
VALUES ('candidate-files', 'candidate-files', false)
ON CONFLICT (id) DO NOTHING;

-- ── 6. district_intel (from PENDING_MAINTENANCE.sql, now chain-owned) ───────
CREATE TABLE IF NOT EXISTS district_intel (
  district_key text PRIMARY KEY,
  layer        text,
  name         text,
  history      jsonb,
  history_at   timestamptz,
  updated_at   timestamptz DEFAULT now()
);
ALTER TABLE district_intel ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='district_intel' AND policyname='district_intel_read') THEN
    CREATE POLICY district_intel_read ON district_intel FOR SELECT TO authenticated USING (true);
  END IF;
END $$;

-- ── 7. Campaign Connect schema (from supabase/campaign-connect.sql) ─────────
-- Folded into the chain so 20260704000002's gp_can_edit() (which references
-- account_links) can be created on a clean rebuild. That migration file is
-- also being switched to LANGUAGE plpgsql in the same commit, so creation no
-- longer validates the body against not-yet-existing tables.
-- Campaign Connect schema — account linking between Action & Candidate accounts.
create extension if not exists pgcrypto;

create table if not exists account_links (
  id uuid primary key default gen_random_uuid(),
  action_user_id uuid not null references auth.users(id) on delete cascade,
  candidate_email text not null,
  candidate_user_id uuid references auth.users(id) on delete cascade,
  relationship_type text not null default 'team' check (relationship_type in ('team','outside')),
  invite_code text unique,
  status text not null default 'invited' check (status in ('invited','active','revoked','declined')),
  permissions jsonb not null default '{"view":true,"manage_tasks":true,"manage_page":true,"receive_profiles":true}'::jsonb,
  invited_at timestamptz not null default now(),
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_links_action on account_links(action_user_id);
create index if not exists idx_links_candidate on account_links(candidate_user_id);
create index if not exists idx_links_email on account_links(lower(candidate_email));

create table if not exists profile_handoffs (
  id uuid primary key default gen_random_uuid(),
  link_id uuid references account_links(id) on delete set null,
  from_action_user uuid not null references auth.users(id) on delete cascade,
  to_candidate_user uuid not null references auth.users(id) on delete cascade,
  dossier_id uuid not null references dossiers(id) on delete cascade,
  title text,
  candidate_name text,
  expires_at timestamptz not null,
  viewed_at timestamptz,
  status text not null default 'active' check (status in ('active','expired','revoked')),
  created_at timestamptz not null default now()
);
create index if not exists idx_handoff_to on profile_handoffs(to_candidate_user);
create index if not exists idx_handoff_from on profile_handoffs(from_action_user);

create table if not exists cc_activity (
  id uuid primary key default gen_random_uuid(),
  link_id uuid references account_links(id) on delete cascade,
  actor_user_id uuid,
  candidate_user_id uuid,
  action text not null,
  detail jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_cc_activity_candidate on cc_activity(candidate_user_id);

alter table account_links enable row level security;
alter table profile_handoffs enable row level security;
alter table cc_activity enable row level security;

drop policy if exists cc_links_sel on account_links;
create policy cc_links_sel on account_links for select using (
  auth.uid() = action_user_id or auth.uid() = candidate_user_id
);
drop policy if exists cc_handoff_sel on profile_handoffs;
create policy cc_handoff_sel on profile_handoffs for select using (
  auth.uid() = from_action_user or auth.uid() = to_candidate_user
);
drop policy if exists cc_activity_sel on cc_activity;
create policy cc_activity_sel on cc_activity for select using (
  auth.uid() = candidate_user_id or auth.uid() = actor_user_id
);
-- All writes performed by service-role functions (bypass RLS). No client write policies.

