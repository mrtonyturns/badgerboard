-- Per-race result notifications. Users subscribe to individual contests and
-- choose a mode: email on every numbers change, or only when the final
-- result is in. Idempotent.

create table if not exists election_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  contest_id uuid not null references election_contests(id) on delete cascade,
  mode text not null default 'every_change' check (mode in ('every_change','final_only')),
  -- notifier bookkeeping (service-role writes only)
  last_notified_at timestamptz,
  last_snapshot jsonb,            -- votes/status hash last emailed, for change detection
  winner_notified_at timestamptz, -- winner announcement sent (once)
  created_at timestamptz not null default now(),
  unique (user_id, contest_id)
);

alter table election_subscriptions enable row level security;

drop policy if exists "subs select own" on election_subscriptions;
create policy "subs select own" on election_subscriptions
  for select to authenticated using (user_id = auth.uid());

drop policy if exists "subs insert own" on election_subscriptions;
create policy "subs insert own" on election_subscriptions
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists "subs update own" on election_subscriptions;
create policy "subs update own" on election_subscriptions
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "subs delete own" on election_subscriptions;
create policy "subs delete own" on election_subscriptions
  for delete to authenticated using (user_id = auth.uid());

create index if not exists election_subscriptions_contest_idx on election_subscriptions (contest_id);
