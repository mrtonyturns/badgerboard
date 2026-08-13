-- Prerequisites for the approved Recruit feature, live-confirmed missing on
-- prod during v1.29.0 QA: VoterLists.jsx writes both on every upload, so list
-- creation 400s ("Failed to create voter list record"). Scoped fix only —
-- the broader Tier-1A schema reconciliation remains unapproved. Idempotent.
ALTER TABLE voter_lists ADD COLUMN IF NOT EXISTS total_count INTEGER DEFAULT 0;
ALTER TABLE voters      ADD COLUMN IF NOT EXISTS state TEXT DEFAULT 'WI';

-- Live-QA fix #2: updateRecruitmentSearch() writes updated_at on every
-- attestation/status change; the recruitment migration never created it, so
-- the update 400d silently and the background function refused every run
-- ("Confirm the recruitment-use attestation").
ALTER TABLE recruitment_searches ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();
