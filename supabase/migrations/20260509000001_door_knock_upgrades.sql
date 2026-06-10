-- Migration: Door Knock Upgrades
-- Adds survey questions per candidate, survey answers per knock,
-- and multi-candidate support level tracking per knock.
--
-- Safe to run multiple times (IF NOT EXISTS / DO $$ blocks).

-- ─── 1. Survey questions stored on the candidate record ──────────────────────
-- Structure: [{ id: string, text: string, type: 'yes_no'|'text'|'choice', options: string[] }]
ALTER TABLE candidates
  ADD COLUMN IF NOT EXISTS survey_questions JSONB NOT NULL DEFAULT '[]';

-- ─── 2. Survey answers stored on the door_knock record ───────────────────────
-- Structure: { [questionId]: string | boolean }
ALTER TABLE door_knocks
  ADD COLUMN IF NOT EXISTS survey_answers JSONB NOT NULL DEFAULT '{}';

-- ─── 3. Multi-candidate support levels stored on the door_knock record ───────
-- Structure: { [candidateId]: 'strong_support'|'lean_support'|'undecided'|'lean_against'|'strong_against' }
ALTER TABLE door_knocks
  ADD COLUMN IF NOT EXISTS support_levels JSONB NOT NULL DEFAULT '{}';

-- ─── 4. Indexes for efficient querying ───────────────────────────────────────
-- Allow fast lookup of knocks that have survey answers or support levels
CREATE INDEX IF NOT EXISTS idx_door_knocks_survey_answers
  ON door_knocks USING GIN (survey_answers)
  WHERE survey_answers != '{}';

CREATE INDEX IF NOT EXISTS idx_door_knocks_support_levels
  ON door_knocks USING GIN (support_levels)
  WHERE support_levels != '{}';

-- ─── 5. Comment documentation ────────────────────────────────────────────────
COMMENT ON COLUMN candidates.survey_questions IS
  'Array of survey questions asked at the door for this candidate. Format: [{ id, text, type, options }]';

COMMENT ON COLUMN door_knocks.survey_answers IS
  'Answers to candidate survey questions captured at the door. Format: { [questionId]: answer }';

COMMENT ON COLUMN door_knocks.support_levels IS
  'Voter support levels for multiple candidates at this address. Format: { [candidateId]: level }';
