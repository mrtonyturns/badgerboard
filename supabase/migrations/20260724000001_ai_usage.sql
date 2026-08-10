-- Migration: ai_usage — real AI cost metering (v1.20)
-- Every AI API call (Anthropic / Perplexity / xAI) logs one row with actual
-- token counts where the provider returns them, and the computed USD cost.
-- Replaces the phantom generation_logs table the old AI-costs tab read
-- (nothing ever wrote to it — the tab showed hardcoded guesses).
--
-- Service-role only: RLS enabled with NO policies. Admin dashboard reads
-- through the admin-dashboard function.

CREATE TABLE IF NOT EXISTS ai_usage (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid,                          -- verified caller (null = system/cron)
  endpoint      text        NOT NULL,          -- app section, e.g. 'profiler', 'events'
  provider      text        NOT NULL,          -- anthropic | perplexity | xai
  model         text,
  input_tokens  integer     NOT NULL DEFAULT 0,
  output_tokens integer     NOT NULL DEFAULT 0,
  cost_usd      numeric(12,6) NOT NULL DEFAULT 0,
  estimated     boolean     NOT NULL DEFAULT false,  -- true when tokens unavailable (flat estimate)
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_created  ON ai_usage (created_at);
CREATE INDEX IF NOT EXISTS idx_ai_usage_user     ON ai_usage (user_id);
CREATE INDEX IF NOT EXISTS idx_ai_usage_endpoint ON ai_usage (endpoint);

ALTER TABLE ai_usage ENABLE ROW LEVEL SECURITY;
-- No policies on purpose: only the service role reads/writes.
