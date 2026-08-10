-- Real signed-in devices list (Settings → Security).
-- auth.sessions is not exposed over REST, so two SECURITY DEFINER functions
-- give each user a view of exactly their own sessions and nothing else.
-- Idempotent.

create or replace function public.get_my_sessions()
returns table (
  id uuid,
  created_at timestamptz,
  last_active timestamptz,
  user_agent text,
  ip text,
  is_current boolean
)
language sql
security definer
set search_path = ''
as $$
  select
    s.id,
    s.created_at,
    greatest(
      coalesce(s.refreshed_at at time zone 'utc', s.updated_at),
      s.updated_at
    ) as last_active,
    s.user_agent,
    host(s.ip) as ip,
    (s.id::text = coalesce(auth.jwt() ->> 'session_id', '')) as is_current
  from auth.sessions s
  where s.user_id = auth.uid()
  order by 3 desc nulls last
$$;

revoke all on function public.get_my_sessions() from public, anon;
grant execute on function public.get_my_sessions() to authenticated;

-- Revoke one of MY OWN sessions (never the current one — use signOut for that).
-- Deleting the session row cascades to its refresh tokens, so the device's
-- next token refresh fails and it is signed out (access token lives out its
-- remaining <=1h TTL).
create or replace function public.revoke_my_session(sid uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from auth.sessions
  where id = sid
    and user_id = auth.uid()
    and id::text <> coalesce(auth.jwt() ->> 'session_id', '');
  return found;
end
$$;

revoke all on function public.revoke_my_session(uuid) from public, anon;
grant execute on function public.revoke_my_session(uuid) to authenticated;
