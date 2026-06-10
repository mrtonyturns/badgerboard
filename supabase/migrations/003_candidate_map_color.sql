-- ============================================================
-- Migration 003: Add map_color to candidates for turf builder
-- ============================================================
-- Each candidate can be assigned a hex color that appears in
-- the Door Knocking turf builder SVG.  Defaults to indigo.
-- ============================================================

ALTER TABLE candidates
  ADD COLUMN IF NOT EXISTS map_color TEXT DEFAULT '#4f46e5';

COMMENT ON COLUMN candidates.map_color IS
  'Hex color used in the DoorKnocking turf builder SVG. '
  'Defaults to #4f46e5 (indigo). Overridable per candidate.';
