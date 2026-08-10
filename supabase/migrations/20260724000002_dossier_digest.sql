-- Migration: dossier change tracking + weekly digest (active monitoring v2)
-- The extended save in generate-dossier-background has ALWAYS fallen back to
-- the base save because these columns never existed — change detection was
-- computed and silently discarded on every dossier ever generated.

ALTER TABLE dossiers ADD COLUMN IF NOT EXISTS change_summary          text;
ALTER TABLE dossiers ADD COLUMN IF NOT EXISTS section_count           integer;
ALTER TABLE dossiers ADD COLUMN IF NOT EXISTS perplexity_sources_used integer;
ALTER TABLE dossiers ADD COLUMN IF NOT EXISTS has_verification_flags  boolean;
-- Structured week-in-review produced on monitored regenerations:
-- { summary: text, items: [{ category: news|social|podcast|controversy|polling|other, title, note }] }
ALTER TABLE dossiers ADD COLUMN IF NOT EXISTS weekly_digest           jsonb;

NOTIFY pgrst, 'reload schema';
