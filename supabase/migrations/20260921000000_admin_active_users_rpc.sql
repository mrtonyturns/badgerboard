-- Admin "Active This Week" read 0 while an admin was signed in (Sep 21 sweep).
-- The card counted auth.users.last_sign_in_at within 7 days — but Supabase
-- only bumps that on a real sign-in, never on a refresh-token renewal, so a
-- persistent session (the owner's: signed in Aug 14, active daily since) reads
-- as inactive for weeks. auth.sessions.refreshed_at is the honest signal and
-- is not exposed over REST, hence this SECURITY DEFINER function. Service
-- role only — the admin function calls it; clients never can.

create or replace function public.admin_active_user_ids(since_days int default 7)
returns table(user_id uuid, last_active timestamptz)
language sql
security definer
set search_path = auth, public
as $$
  select s.user_id,
         max(coalesce(s.refreshed_at at time zone 'utc', s.updated_at)) as last_active
  from auth.sessions s
  where coalesce(s.refreshed_at at time zone 'utc', s.updated_at)
        > now() - make_interval(days => greatest(1, least(since_days, 90)))
  group by s.user_id
$$;

revoke all on function public.admin_active_user_ids(int) from public, anon, authenticated;
grant execute on function public.admin_active_user_ids(int) to service_role;
