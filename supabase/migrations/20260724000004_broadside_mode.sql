-- v1.24: attack sessions — record which side the trainee played
ALTER TABLE public.broadside_sessions
  ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'defend'
  CHECK (mode IN ('defend','attack'));
