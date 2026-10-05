#!/usr/bin/env node
// Badger Board — DB bug sweep 2 + migration-chain replayability (static checks).
//   1. 00000000000001_legacy_v2_v5_schema.sql folds the hand-run
//      migration_v2.sql / migration_v5 objects the chain depends on
//      (door_knock_lists, door_knocks, candidates.created_by /
//      section_timestamps, dossiers.user_id) plus volunteers (needed by
//      20260422000001 one file before 20260422000002 creates it) into the
//      chain, idempotently and WITHOUT their permissive policies.
//   2. 20261005000001_bug_sweep_2.sql: advisory locks in both cap triggers,
//      AI-lock column guard, exec_sql lockdown, voters UPDATE WITH CHECK,
//      baseline USING(true) policies dropped (activity_log owner policies
//      ensured first).
// Behavioural proof (full chain replay on PGlite + RLS scenarios) lives
// outside the repo because PGlite is not a dependency; this suite only pins
// the files' presence, order and key statements.
// Zero-config: node tests/db-sweep.test.mjs

import { readFileSync, readdirSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MIG = join(ROOT, 'supabase', 'migrations')
const read = (f) => readFileSync(join(MIG, f), 'utf8')
// Strip SQL line comments so assertions only match executable statements.
const code = (s) => s.split('\n').map(l => l.replace(/--.*$/, '')).join('\n')

let pass = 0, fail = 0
const t = (name, cond) => { cond ? pass++ : fail++; console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${name}`) }

const EARLY = '00000000000001_legacy_v2_v5_schema.sql'
const SWEEP = '20261005000001_bug_sweep_2.sql'
const files = readdirSync(MIG).filter(f => f.endsWith('.sql')).sort()

// ── ordering ────────────────────────────────────────────────────────────────
t('early legacy migration exists', files.includes(EARLY))
t('bug_sweep_2 migration exists', files.includes(SWEEP))
t('early migration sorts right after the baseline', files.indexOf(EARLY) === files.indexOf('00000000000000_baseline.sql') + 1)
t('early migration sorts before 001_admin_tables.sql and 005_shifts_and_messages.sql',
  files.indexOf(EARLY) < files.indexOf('001_admin_tables.sql') && files.indexOf(EARLY) < files.indexOf('005_shifts_and_messages.sql'))
t('bug_sweep_2 sorts after 20261005000000 (it replaces that file\'s monitoring-cap body)',
  files.indexOf(SWEEP) > files.indexOf('20261005000000_bug_sweep_rls_trigger_fixes.sql'))
t('every migration filename has a numeric version prefix', files.every(f => /^\d+_.+\.sql$/.test(f)))

// ── early legacy migration ──────────────────────────────────────────────────
const early = code(read(EARLY))
for (const col of ['weaknesses', 'section_timestamps', 'is_incumbent', 'incumbent_since', 'created_by']) {
  t(`candidates.${col} added idempotently`, new RegExp(`ALTER TABLE public\\.candidates ADD COLUMN IF NOT EXISTS ${col}\\b`).test(early))
}
t('dossiers.user_id added idempotently', /ALTER TABLE public\.dossiers ADD COLUMN IF NOT EXISTS user_id\b/.test(early))
for (const tbl of ['door_knock_lists', 'door_knocks', 'volunteers']) {
  t(`${tbl} created only when absent (to_regclass guard)`,
    new RegExp(`to_regclass\\('public\\.${tbl}'\\) IS NULL THEN\\s+CREATE TABLE public\\.${tbl}\\b`).test(early))
  t(`${tbl} gets RLS enabled`, new RegExp(`ALTER TABLE public\\.${tbl} ENABLE ROW LEVEL SECURITY`).test(early))
}
t('early migration creates NO policies (no permissive v2/v5 policy resurrected)', !/CREATE POLICY/i.test(early))
t('early migration has no USING (true)', !/USING\s*\(\s*true\s*\)/i.test(early))
t('every CREATE TABLE in the early migration is guarded',
  (early.match(/CREATE TABLE/g) || []).length === (early.match(/IS NULL THEN\s+CREATE TABLE/g) || []).length)

// ── bug_sweep_2 ─────────────────────────────────────────────────────────────
const sweep = code(read(SWEEP))
const fnBody = (name) => {
  const i = sweep.indexOf(`CREATE OR REPLACE FUNCTION ${name}()`)
  return i < 0 ? '' : sweep.slice(i, sweep.indexOf('$$;', i))
}
for (const fn of ['enforce_scout_candidate_cap', 'enforce_monitoring_cap']) {
  const b = fnBody(fn)
  const lock = b.indexOf('PERFORM pg_advisory_xact_lock(hashtext(NEW.created_by::text));')
  const count = b.indexOf('SELECT count(*)')
  t(`${fn}: per-owner advisory xact lock`, lock > 0)
  t(`${fn}: lock taken before the count`, lock > 0 && count > lock)
  t(`${fn}: still bypasses service_role`, b.includes("IN ('service_role', 'supabase_admin')"))
}
t('monitoring cap keeps the Oct-5 NULL-safe turning_on fix', /coalesce\(\(NEW\.section_timestamps ->> 'monitoring'\) = 'true', false\)/.test(fnBody('enforce_monitoring_cap')))

const guard = fnBody('guard_candidate_ai_lock')
t('AI-lock guard compares ai_access_notes', guard.includes('NEW.ai_access_notes     IS NOT DISTINCT FROM OLD.ai_access_notes'))
t('AI-lock guard compares ai_access_locked_at', guard.includes('NEW.ai_access_locked_at IS NOT DISTINCT FROM OLD.ai_access_locked_at'))
t('AI-lock guard allows service_role only', guard.includes("role IN ('service_role', 'supabase_admin')") && /RAISE EXCEPTION/.test(guard))
t('AI-lock guard is not SECURITY DEFINER (needs caller current_user)', !/SECURITY DEFINER/.test(guard))
t('AI-lock guard trigger is BEFORE INSERT OR UPDATE on candidates',
  /CREATE TRIGGER candidates_ai_lock_guard\s+BEFORE INSERT OR UPDATE ON candidates/.test(sweep))
t('AI-lock guard resets forged lock fields on API-role inserts',
  /TG_OP = 'INSERT'[\s\S]*NEW\.ai_access_locked_at := NULL/.test(sweep))
t('002 unique index uses Postgres syntax (no MySQL prefix claim_text(100))',
  !/claim_text\(100\)\);/.test(read('002_dossier_review_tables.sql')))

t('exec_sql: every overload found via pg_proc', /p\.proname = 'exec_sql'/.test(sweep) && /n\.nspname = 'public'/.test(sweep))
t('exec_sql: revoked from PUBLIC, anon, authenticated', sweep.includes("REVOKE EXECUTE ON ROUTINE %s FROM PUBLIC, anon, authenticated"))
t('exec_sql: granted to service_role', sweep.includes("GRANT EXECUTE ON ROUTINE %s TO service_role"))

t('voters UPDATE WITH CHECK requires a caller-owned target list',
  /CREATE POLICY "voters_update_own"[\s\S]*?WITH CHECK \([\s\S]*?voter_list_id IN \(SELECT id FROM public\.voter_lists WHERE created_by = auth\.uid\(\)\)/.test(sweep))
t('legacy voters UPDATE policies dropped (OR-ed policies would bypass the check)',
  ['Auth users update voters', 'Users update own voters', 'Users manage own voters'].every(n => sweep.includes(`DROP POLICY IF EXISTS "${n}"`)))

const baseline = read('00000000000000_baseline.sql')
const permissive = [...baseline.matchAll(/CREATE POLICY "(Authenticated users can \w+ (dossiers|prospecting_lists|activity_log))"/g)].map(m => [m[1], m[2]])
t('baseline still defines the 10 permissive policies this sweep targets', permissive.length === 10)
for (const [name, tbl] of permissive) {
  t(`drops "${name}"`, new RegExp(`DROP POLICY IF EXISTS "${name}"\\s+ON public\\.${tbl}`).test(sweep))
}
const ensure = sweep.indexOf('CREATE POLICY "Users read own activity"')
t('activity_log owner SELECT policy ensured (guarded)', ensure > 0 && /policyname = 'Users read own activity'/.test(sweep))
t('activity_log owner INSERT policy ensured (guarded)', /policyname = 'Users insert own activity'/.test(sweep) && sweep.includes('CREATE POLICY "Users insert own activity"'))
t('activity_log owner policies created BEFORE the permissive ones are dropped',
  ensure > 0 && ensure < sweep.indexOf('DROP POLICY IF EXISTS "Authenticated users can read activity_log"'))
t('dossiers / prospecting_lists owner-scoped replacements exist earlier in the chain',
  /CREATE POLICY "prospecting_(select|insert|update|delete)_own"/.test(read('20260422000005_dossier_prospecting_rls.sql')) &&
  (read('20260704000004_backend_hardening.sql').match(/CREATE POLICY "dossiers_(select|insert|update|delete)_own"/g) || []).length === 4)
t('bug_sweep_2 creates no USING (true) policy', !/USING\s*\(\s*true\s*\)/i.test(sweep) && !/WITH CHECK\s*\(\s*true\s*\)/i.test(sweep))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
