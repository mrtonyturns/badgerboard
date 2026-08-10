-- Candidate profile redesign: AI access lock, persisted refresh diff,
-- per-user profile view tracking. Idempotent / non-destructive.

-- One candidate-level switch governs whether AI features may read that
-- candidate's notes & documents. Locked_at drives the 5-minute grace window.
alter table candidates add column if not exists ai_access_notes boolean not null default true;
alter table candidates add column if not exists ai_access_locked_at timestamptz;

-- Section-level diff between the two newest dossiers, computed once at
-- generation time (never per render).
alter table dossiers add column if not exists refresh_diff jsonb;

-- Per-user "last opened this profile" marker for unread tracking.
create table if not exists public.profile_views (
  user_id      uuid not null references auth.users(id) on delete cascade,
  candidate_id uuid not null references public.candidates(id) on delete cascade,
  viewed_at    timestamptz not null default now(),
  primary key (user_id, candidate_id)
);

alter table public.profile_views enable row level security;

drop policy if exists profile_views_own on public.profile_views;
create policy profile_views_own
  on public.profile_views for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
