-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: 20260508000001_candidates_research_context
-- Adds research_context column to candidates table.
--
-- Purpose: Let users provide disambiguation context before generating a dossier.
-- Example values:
--   "Lives in Wausau, owns Marathon County Roofing, considering running for county board"
--   "Principal at Lincoln Elementary, Eau Claire — exploring state assembly"
--
-- This field is injected into all Perplexity queries and the main Claude prompt
-- to help the AI find the right person, especially for pre-announcement candidates
-- who don't yet have an electoral public record.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE candidates
  ADD COLUMN IF NOT EXISTS research_context TEXT;

COMMENT ON COLUMN candidates.research_context IS
  'User-provided disambiguation context for dossier generation. E.g. city, employer, profession, community role. Injected into AI research queries to help find the correct person.';
