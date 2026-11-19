-- Candidate profile redesign (Nov 2026) — X posts cache + candidate photo.
--
-- NOT YET APPLIED. Run once against production (SQL editor or `supabase db
-- push`). Both changes are additive; the app works without them:
--   • without candidate_x_feed, fetch-candidate-x-feed still searches X but
--     cannot cache, so the browser keeps its own 6-hour copy instead;
--   • without candidates.photo_url, the Edit dialog saves every other field
--     and says the photo needs this migration.
--
-- 1. candidate_x_feed — one row per candidate: the last X search result
--    (posts by and about the candidate) from fetch-candidate-x-feed.js. The
--    function reads and writes it with the service role, scoped to the
--    caller's own candidate; browsers only ever get SELECT on their own rows.

create table if not exists public.candidate_x_feed (
  candidate_id uuid primary key references public.candidates(id) on delete cascade,
  created_by   uuid references auth.users(id) on delete cascade,
  handle       text,
  posts        jsonb not null default '[]'::jsonb,
  source       text,                       -- 'grok' (xAI x_search) | 'x_api'
  fetched_at   timestamptz not null default now()
);

alter table public.candidate_x_feed enable row level security;

drop policy if exists candidate_x_feed_select_owner on public.candidate_x_feed;
create policy candidate_x_feed_select_owner on public.candidate_x_feed
  for select using (
    exists (select 1 from public.candidates c
            where c.id = candidate_x_feed.candidate_id and c.created_by = auth.uid())
  );
-- No insert/update/delete policies: only the service role writes this table.

-- 2. candidates.photo_url — the photo shown in the profile header (a link the
--    user pastes in Edit). Nullable; nothing else reads it.
alter table public.candidates add column if not exists photo_url text;
