-- District Events: real background-generation progress.
--
-- research-district-events-background.js is a Netlify BACKGROUND function, so
-- Netlify answers the browser with 202 before the handler runs and EVERY status
-- code the handler returns (401 / 429 / 502 …) is discarded. Until now the only
-- durable signal the function produced was the final district_events upsert, so
-- any failure — rate limit, research provider down, unparsable model output, an
-- uncaught throw — was completely invisible to the client, which sat on a
-- spinner for two minutes and then guessed at a timeout message.
--
-- This table is the same pattern dossier_generation_progress uses for the
-- Profiler: the function writes a row at every real phase boundary and on every
-- terminal outcome, and the client polls it. Progress therefore lives on the
-- server, which also means it survives navigating away from the Events page.
--
-- Shared cache semantics, exactly like district_events: any authenticated user
-- may read (districts are not user-scoped), writes are service-role only.
-- Idempotent / non-destructive.

CREATE TABLE IF NOT EXISTS public.district_events_progress (
  district_key TEXT PRIMARY KEY,
  stage        INTEGER     NOT NULL DEFAULT 1,        -- 1 search · 2 local news · 3 structuring · 4 enrichment
  status       TEXT        NOT NULL DEFAULT 'running',-- running | done | error
  message      TEXT,                                  -- human-readable failure reason when status = 'error'
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.district_events_progress ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS district_events_progress_read ON public.district_events_progress;
CREATE POLICY district_events_progress_read
  ON public.district_events_progress FOR SELECT TO authenticated USING (true);
-- writes: service role only (shared status row)
