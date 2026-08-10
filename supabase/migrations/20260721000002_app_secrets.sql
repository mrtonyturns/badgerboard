-- 20260721000002_app_secrets.sql
-- Server-only secrets store. RLS is ENABLED with NO policies, so only the
-- service-role key (which bypasses RLS) can read or write rows. Used by
-- stripe-webhook.js as a fallback for the webhook signing secret when the
-- STRIPE_WEBHOOK_SECRET env var is not set.
--
-- NOTE: secret VALUES are inserted operationally (SQL editor / service role),
-- never committed to this repo.

create table if not exists public.app_secrets (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);

alter table public.app_secrets enable row level security;
-- no policies on purpose: service-role access only
