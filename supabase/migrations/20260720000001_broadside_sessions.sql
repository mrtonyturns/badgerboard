-- BROADSIDE session history + report cards.
-- Written by broadside-debrief (service role); users read their own rows.
-- Idempotent / non-destructive. Code fails soft if this isn't applied yet.

create table if not exists public.broadside_sessions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  dossier_id    uuid references public.dossiers(id) on delete set null,
  dossier_name  text,
  stats         jsonb not null default '{}'::jsonb,   -- attacks, avg response, tics, tally
  transcript    jsonb not null default '[]'::jsonb,   -- [{who:'oppo'|'user', text}]
  debrief       text,                                  -- Sonnet report card (markdown)
  created_at    timestamptz not null default now()
);

alter table public.broadside_sessions enable row level security;

-- Users see their own session history; writes go through the service role only.
drop policy if exists broadside_sessions_select_own on public.broadside_sessions;
create policy broadside_sessions_select_own
  on public.broadside_sessions for select
  using (auth.uid() = user_id);

create index if not exists broadside_sessions_user_idx
  on public.broadside_sessions (user_id, created_at desc);
