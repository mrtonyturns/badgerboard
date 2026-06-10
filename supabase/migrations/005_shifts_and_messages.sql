-- ─── Migration 005: Volunteer Shifts + Canvass Messages ───────────────────────
-- Adds door_knock_shifts (Feature 3) and canvass_messages (Feature 5) tables.
-- Also adds default_list_id FK helper column to door_knock_lists for multi-list
-- candidates (used by DoorKnocking.jsx to resolve the active list per candKey).

-- ── Door Knock Shifts ──────────────────────────────────────────────────────────
create table if not exists public.door_knock_shifts (
  id              uuid primary key default gen_random_uuid(),
  list_id         uuid not null references public.door_knock_lists(id) on delete cascade,
  volunteer_name  text not null,
  volunteer_email text,
  volunteer_phone text,
  turf_assignment text,
  shift_date      date not null,
  start_time      time not null,
  end_time        time,
  status          text not null default 'scheduled'
                    check (status in ('scheduled','active','completed','cancelled')),
  notes           text,
  created_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Row-level security
alter table public.door_knock_shifts enable row level security;

create policy "shifts_select" on public.door_knock_shifts
  for select using (auth.uid() is not null);

create policy "shifts_insert" on public.door_knock_shifts
  for insert with check (auth.uid() is not null);

create policy "shifts_update" on public.door_knock_shifts
  for update using (auth.uid() is not null);

create policy "shifts_delete" on public.door_knock_shifts
  for delete using (auth.uid() is not null);

create index if not exists idx_shifts_list_id on public.door_knock_shifts(list_id);

-- ── Canvass Messages ───────────────────────────────────────────────────────────
create table if not exists public.canvass_messages (
  id          uuid primary key default gen_random_uuid(),
  list_id     uuid not null references public.door_knock_lists(id) on delete cascade,
  sent_by     uuid references auth.users(id) on delete set null,
  sender_name text,
  message     text not null,
  msg_type    text not null default 'broadcast'
                check (msg_type in ('broadcast','alert','reroute','praise')),
  sent_at     timestamptz not null default now()
);

-- Row-level security
alter table public.canvass_messages enable row level security;

create policy "messages_select" on public.canvass_messages
  for select using (auth.uid() is not null);

create policy "messages_insert" on public.canvass_messages
  for insert with check (auth.uid() is not null);

create policy "messages_delete" on public.canvass_messages
  for delete using (auth.uid() is not null);

create index if not exists idx_messages_list_id on public.canvass_messages(list_id);
create index if not exists idx_messages_sent_at  on public.canvass_messages(sent_at desc);

-- ── Enable realtime for messages (required for live canvass feed) ─────────────
-- Supabase realtime publication — add table if not already present.
-- (safe to run multiple times due to IF NOT EXISTS equivalent below)
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and tablename = 'canvass_messages'
  ) then
    alter publication supabase_realtime add table public.canvass_messages;
  end if;
end $$;
