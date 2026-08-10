-- 20260721000001_app_settings_beta_trials.sql
-- v1.18 launch build: platform-wide settings table (global beta switch).
--
-- Per-user trial and beta state live in auth.users.app_metadata (service-role
-- writable only) — no schema change needed there. This table holds the few
-- platform-wide flags that every signed-in client needs to read.

create table if not exists public.app_settings (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now(),
  updated_by text
);

alter table public.app_settings enable row level security;

-- Any signed-in user may READ settings (the client needs the global beta flag
-- to resolve entitlements). Only the service role may write.
drop policy if exists "app_settings_read_authenticated" on public.app_settings;
create policy "app_settings_read_authenticated"
  on public.app_settings for select
  to authenticated
  using (true);

-- No insert/update/delete policies → only service-role key can write.

-- Default: beta program ON (per-user beta_mode flags decide who has access).
insert into public.app_settings (key, value, updated_by)
values ('beta_mode_enabled', 'on', 'migration')
on conflict (key) do nothing;
