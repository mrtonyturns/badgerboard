-- Durable cross-instance rate limiting for LLM-spending endpoints (F2).
-- Service-role only: RLS is enabled with NO policies, so anon/authenticated
-- clients cannot read or write; the SECURITY DEFINER function below is the
-- only mutation path and is revoked from public roles.
-- Idempotent / non-destructive.

create table if not exists public.rate_limits (
  user_id      uuid        not null,
  endpoint     text        not null,
  window_start timestamptz not null,
  count        integer     not null default 1,
  primary key (user_id, endpoint, window_start)
);

alter table public.rate_limits enable row level security;
-- Intentionally no RLS policies: only the service role (bypasses RLS) may touch it.

create index if not exists rate_limits_window_idx
  on public.rate_limits (window_start);

-- Atomically bump both the per-minute and per-day counters for one call and
-- return the new counts. The day row is stored under endpoint||':day' so both
-- windows share the one table/PK.
create or replace function public.bump_rate_limit(
  p_user_id      uuid,
  p_endpoint     text,
  p_minute_start timestamptz,
  p_day_start    timestamptz
) returns table (minute_count integer, day_count integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_minute integer;
  v_day    integer;
begin
  insert into rate_limits as rl (user_id, endpoint, window_start, count)
       values (p_user_id, p_endpoint, p_minute_start, 1)
  on conflict (user_id, endpoint, window_start)
       do update set count = rl.count + 1
  returning rl.count into v_minute;

  insert into rate_limits as rl (user_id, endpoint, window_start, count)
       values (p_user_id, p_endpoint || ':day', p_day_start, 1)
  on conflict (user_id, endpoint, window_start)
       do update set count = rl.count + 1
  returning rl.count into v_day;

  -- Opportunistic cleanup (~1% of calls): drop windows older than 2 days.
  if random() < 0.01 then
    delete from rate_limits where window_start < now() - interval '2 days';
  end if;

  return query select v_minute, v_day;
end;
$$;

revoke all on function public.bump_rate_limit(uuid, text, timestamptz, timestamptz) from public;
revoke all on function public.bump_rate_limit(uuid, text, timestamptz, timestamptz) from anon;
revoke all on function public.bump_rate_limit(uuid, text, timestamptz, timestamptz) from authenticated;
