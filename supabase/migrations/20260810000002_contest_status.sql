-- Live results Phase 1: explicit contest status model (SPEC: RESULTS-live-election-game-plan.md).
-- Idempotent.

alter table election_contests add column if not exists status text not null default 'waiting'
  check (status in ('waiting','reporting','projected','called','too_close','recount_possible','certified'));
alter table election_contests add column if not exists status_source text not null default 'auto'
  check (status_source in ('auto','admin'));
alter table election_contests add column if not exists status_updated_at timestamptz;
alter table election_contests add column if not exists status_detail jsonb; -- engine trace: margin, ceiling, reason
alter table election_contests add column if not exists verified_at timestamptz; -- morning-after audit stamp (Phase 4 writes it)

-- Backfill: contests that already have a declared winner are 'called'; ones with
-- votes are 'reporting'.
update election_contests c set status = 'called', status_source = 'admin', status_updated_at = now()
  where c.status = 'waiting'
    and exists (select 1 from election_results r where r.contest_id = c.id and r.winner = true);
update election_contests c set status = 'reporting', status_updated_at = now()
  where c.status = 'waiting'
    and exists (select 1 from election_results r where r.contest_id = c.id and coalesce(r.votes,0) > 0);
