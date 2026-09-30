-- Dashboard bootstrap in ONE round-trip (v1.42.1 perf).
--
-- Measured Sep 30 2026: the dashboard fired 7-10 REST queries in parallel
-- and each crawled at 3-4s on the owner's connection (≈500ms in isolation)
-- because they queue on the client link. One request carrying all seven
-- result sets takes one round-trip.
--
-- SECURITY INVOKER: runs as the caller, so every table's RLS applies exactly
-- as it does to the individual REST reads this replaces. The explicit
-- created_by / user_id filters mirror src/lib/supabase.js's helpers; dossiers
-- deliberately have no generated_by filter (auto-regenerated rows have
-- generated_by NULL — ownership is enforced by RLS), same as getDossiers().
-- Row shapes (including the embedded office/election/candidate objects) match
-- the PostgREST embeds the helpers request, so the dashboards render the RPC
-- payload and the fallback payload identically.

create or replace function public.dashboard_bootstrap(activity_limit int default 8)
returns jsonb
language sql
security invoker
stable
set search_path = public
as $$
  select jsonb_build_object(
    'candidates', coalesce((
      select jsonb_agg(row_to_json(c)::jsonb
        || jsonb_build_object(
          'office', (select row_to_json(o) from (select id, name, level, office_type, district_number, district_name, county from offices where id = c.office_id) o),
          'election', (select row_to_json(e) from (select id, name, election_date, type, year from elections where id = c.election_id) e)
        ) order by c.name)
      from candidates c where c.created_by = auth.uid()
    ), '[]'::jsonb),
    'milestones', coalesce((
      select jsonb_agg(row_to_json(m)::jsonb
        || jsonb_build_object(
          'candidate', (select row_to_json(x) from (select id, name, party from candidates where id = m.candidate_id) x),
          'election', (select row_to_json(e) from (select id, name, election_date from elections where id = m.election_id) e)
        ) order by m.due_date asc nulls last)
      from game_plan_milestones m where m.created_by = auth.uid()
    ), '[]'::jsonb),
    'elections', coalesce((
      select jsonb_agg(row_to_json(e)::jsonb order by e.election_date) from elections e
    ), '[]'::jsonb),
    'dossiers', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', d.id, 'candidate_id', d.candidate_id, 'generated_at', d.generated_at,
          'generated_by', d.generated_by, 'weekly_digest', d.weekly_digest,
          'candidate', (select row_to_json(x) from (
             select cc.id, cc.name, cc.party,
                    (select row_to_json(oo) from (select name, district_name from offices where id = cc.office_id) oo) as office
             from candidates cc where cc.id = d.candidate_id) x)
        ) order by d.generated_at desc)
      from dossiers d
    ), '[]'::jsonb),
    'prospecting_lists', coalesce((
      select jsonb_agg(row_to_json(p)::jsonb order by p.created_at desc)
      from prospecting_lists p where p.created_by = auth.uid()
    ), '[]'::jsonb),
    'voter_lists', coalesce((
      select jsonb_agg(row_to_json(v)::jsonb order by v.created_at desc)
      from voter_lists v where v.created_by = auth.uid()
    ), '[]'::jsonb),
    'activity', coalesce((
      select jsonb_agg(row_to_json(a)::jsonb order by a.created_at desc)
      from (select * from activity_log where user_id = auth.uid() order by created_at desc limit greatest(1, least(activity_limit, 50))) a
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.dashboard_bootstrap(int) from public, anon;
grant execute on function public.dashboard_bootstrap(int) to authenticated;
