-- Migration: Stripe webhook idempotency table (H4 remediation)
-- stripe-webhook.js inserts the Stripe event ID before processing; a
-- unique-key conflict (409) marks the delivery as a retry and it is skipped,
-- preventing double credit grants. Service-role access only.
CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  id          TEXT PRIMARY KEY,          -- Stripe event ID (evt_...)
  type        TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RLS on, no policies: only the service role can read/write.
ALTER TABLE stripe_webhook_events ENABLE ROW LEVEL SECURITY;

-- Housekeeping note: rows can be pruned after 30 days if desired;
-- Stripe retries never span that long.
