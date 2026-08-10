-- Profiler redesign: structured research note + real generation progress.
-- Idempotent / non-destructive.

-- Structured discrepancy finding (replaces the Section-0 reasoning leak).
-- { finding, evidence, suggested_status, source: 'structured'|'captured-preamble' }
alter table dossiers add column if not exists research_note jsonb;

-- Per-candidate generation progress, upserted by generate-dossier-background
-- at real phase boundaries; polled by the Profiler library UI.
create table if not exists public.dossier_generation_progress (
  candidate_id uuid primary key references public.candidates(id) on delete cascade,
  stage        integer not null default 1,      -- 1 identify · 2 search · 3 draft · 4 verify
  status       text    not null default 'running',  -- running | done | error
  updated_at   timestamptz not null default now()
);

alter table public.dossier_generation_progress enable row level security;

-- Owners of the candidate may read progress; writes are service-role only.
drop policy if exists dgp_select_own on public.dossier_generation_progress;
create policy dgp_select_own
  on public.dossier_generation_progress for select
  using (exists (
    select 1 from public.candidates c
    where c.id = candidate_id and c.created_by = auth.uid()
  ));
