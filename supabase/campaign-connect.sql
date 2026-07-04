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
