-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: 20261119000000_candidate_photo_url
-- Adds candidates.photo_url — a headshot link for the Candidate-plan tiles.
--
-- The Candidates page for Candidate plans is a grid of big tiles (one per
-- person: you and your opponents), and the new add-candidate sheet can find a
-- photo (the share image on the candidate's own site) or take a pasted link.
--
-- Safe to run before or after the front end ships: the add sheet only names
-- photo_url when there is a photo, and retries without it if this column is
-- missing (src/pages/candidates/helpers.js isMissingColumnError). Tiles fall
-- back to initials when photo_url is null.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE candidates
  ADD COLUMN IF NOT EXISTS photo_url TEXT;

COMMENT ON COLUMN candidates.photo_url IS
  'https link to a headshot, shown on the Candidate-plan tiles (proxied through /.netlify/images). Optional.';
