-- Account deletion was impossible for any user who owned data.
--
-- delete-account.js deletes the auth.users row and relies on FK cascades to
-- clean up. 14 public tables referenced auth.users(id) with the default
-- ON DELETE NO ACTION, so Postgres refused the delete for anyone with so much
-- as one candidate (found Sep 19 2026: campaign@braydenmyer.com, 4 candidates
-- → 500 "An internal error occurred" in admin). Every other FK in the schema
-- already cascades, so only these 14 stood in the way.
--
-- Ownership columns → CASCADE (the user's own data goes with the account).
-- Attribution columns → SET NULL (the row belongs to something that outlives
-- the user: a dossier belongs to its candidate, a door-knock to its list, a
-- canvass message to its shift — keep the record, drop the author).
-- All 14 columns are nullable, verified against prod before writing this.
-- Idempotent: DROP CONSTRAINT IF EXISTS before each ADD.

DO $$
DECLARE
  spec record;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      ('candidates',            'created_by', 'candidates_created_by_fkey',            'CASCADE'),
      ('prospecting_lists',     'created_by', 'prospecting_lists_created_by_fkey',     'CASCADE'),
      ('incumbent_records',     'created_by', 'incumbent_records_created_by_fkey',     'CASCADE'),
      ('voter_lists',           'created_by', 'voter_lists_created_by_fkey',           'CASCADE'),
      ('voters',                'created_by', 'voters_created_by_fkey',                'CASCADE'),
      ('voter_saved_lists',     'created_by', 'voter_saved_lists_created_by_fkey',     'CASCADE'),
      ('door_knock_lists',      'created_by', 'door_knock_lists_created_by_fkey',      'CASCADE'),
      ('door_knock_shifts',     'created_by', 'door_knock_shifts_created_by_fkey',     'CASCADE'),
      ('recruitment_searches',  'created_by', 'recruitment_searches_created_by_fkey',  'CASCADE'),
      ('recruitment_prospects', 'created_by', 'recruitment_prospects_created_by_fkey', 'CASCADE'),
      ('activity_log',          'user_id',    'activity_log_user_id_fkey',             'CASCADE'),
      ('dossiers',              'generated_by','dossiers_generated_by_fkey',           'SET NULL'),
      ('door_knocks',           'knocked_by', 'door_knocks_knocked_by_fkey',           'SET NULL'),
      ('canvass_messages',      'sent_by',    'canvass_messages_sent_by_fkey',         'SET NULL')
    ) AS t(tbl, col, con, rule)
  LOOP
    IF to_regclass('public.' || spec.tbl) IS NULL THEN
      RAISE NOTICE 'skip %: table absent', spec.tbl;
      CONTINUE;
    END IF;
    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS %I', spec.tbl, spec.con);
    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES auth.users(id) ON DELETE %s',
      spec.tbl, spec.con, spec.col, spec.rule
    );
  END LOOP;
END $$;
