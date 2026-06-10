-- ============================================================
-- Badger Board Dossier Legal Protection Tables Migration
-- Run this in Supabase SQL editor (Dashboard → SQL Editor)
-- ============================================================

-- ─── Dossier Acknowledgments ────────────────────────────────
-- Stores timestamped records of users acknowledging the
-- Research Use Disclaimer before accessing any dossier.
-- Used to demonstrate informed consent and assumption of risk.

CREATE TABLE IF NOT EXISTS public.dossier_acknowledgments (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid        NOT NULL,
  user_email       text        NOT NULL,
  disclaimer_version text      NOT NULL DEFAULT '1.0',
  acknowledged_at  timestamptz NOT NULL DEFAULT now(),
  ip_address       text,
  user_agent       text,
  -- Re-acknowledgment tracking
  is_current       boolean     NOT NULL DEFAULT true
);

ALTER TABLE public.dossier_acknowledgments ENABLE ROW LEVEL SECURITY;

-- Users can insert their own acknowledgments
CREATE POLICY "Users insert own acknowledgments"
  ON public.dossier_acknowledgments FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Users can read their own acknowledgments
CREATE POLICY "Users read own acknowledgments"
  ON public.dossier_acknowledgments FOR SELECT
  USING (auth.uid() = user_id);

-- ─── Dossier Claim Reviews ──────────────────────────────────
-- Stores user-level Confirmed / Rejected / Needs Research
-- annotations on flagged dossier claims. Creates an audit trail
-- showing the user reviewed and independently evaluated content
-- before any downstream use, reducing platform liability.

CREATE TABLE IF NOT EXISTS public.dossier_claim_reviews (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  dossier_id  uuid        NOT NULL,
  user_id     uuid        NOT NULL,
  section_id  text        NOT NULL,
  -- The original flagged text snippet (first 500 chars)
  claim_text  text        NOT NULL,
  -- User's determination
  status      text        NOT NULL
                          CHECK (status IN ('confirmed', 'rejected', 'needs_research')),
  -- Optional user note / justification
  note        text,
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.dossier_claim_reviews ENABLE ROW LEVEL SECURITY;

-- Users can insert their own reviews
CREATE POLICY "Users insert own claim reviews"
  ON public.dossier_claim_reviews FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Users can read their own reviews
CREATE POLICY "Users read own claim reviews"
  ON public.dossier_claim_reviews FOR SELECT
  USING (auth.uid() = user_id);

-- Users can update their own reviews
CREATE POLICY "Users update own claim reviews"
  ON public.dossier_claim_reviews FOR UPDATE
  USING (auth.uid() = user_id);

-- ─── Indexes for performance ─────────────────────────────────
CREATE INDEX IF NOT EXISTS dossier_ack_user_idx       ON public.dossier_acknowledgments (user_id);
CREATE INDEX IF NOT EXISTS dossier_ack_current_idx    ON public.dossier_acknowledgments (user_id, is_current);
CREATE INDEX IF NOT EXISTS dossier_review_dossier_idx ON public.dossier_claim_reviews (dossier_id);
CREATE INDEX IF NOT EXISTS dossier_review_user_idx    ON public.dossier_claim_reviews (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS dossier_review_unique_idx
  ON public.dossier_claim_reviews (dossier_id, user_id, section_id, claim_text(100));
