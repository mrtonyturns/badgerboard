#!/usr/bin/env node
// Badger Board — PAGES-SWEEP: 8 verified page-level fixes (VolunteerPortal OTP
// auth, ElectionResultsBoard paging + stale guard, CampaignConnect reload loop,
// VoterLists header aliases, Settings billing return, AdminDashboard bulk
// selection, ResetPassword lazy-load recovery race, RecordViews outcome label).
//
// Same loader trick as tests/vsweep.test.mjs: VoterLists brackets its pure
// helpers with
//   // ─── PSWEEP PURE HELPERS BEGIN ───  …  // ─── PSWEEP PURE HELPERS END ───
// and this file imports that block as a real ES module for behaviour tests.
// Everything else is a source-text assertion against the real file — the repo
// convention for JSX/hook logic that can't be isolated.
//
// Zero-config: node tests/pages-sweep.test.mjs

import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const src  = (p) => readFileSync(join(ROOT, p), 'utf8')

let pass = 0, fail = 0
const t = (name, cond) => { cond ? pass++ : fail++; console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${name}`) }
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) console.log(`      got ${JSON.stringify(got)} · want ${JSON.stringify(want)}`)
  t(name, ok)
}

async function loadPureBlock(file, tag = 'PSWEEP') {
  const s = src(file)
  const a = s.indexOf(`${tag} PURE HELPERS BEGIN`)
  const b = s.indexOf(`${tag} PURE HELPERS END`)
  if (a < 0 || b < 0 || b < a) throw new Error(`${file}: ${tag} pure-helper sentinels missing`)
  const block = s.slice(s.indexOf('\n', a) + 1, s.lastIndexOf('\n', b))
  if (/^\s*import\s/m.test(block)) throw new Error(`${file}: pure block must not import`)
  return import('data:text/javascript;base64,' + Buffer.from(block, 'utf8').toString('base64'))
}

// ═══ 1 — VolunteerPortal: OTP-path calls authenticate ═══════════════════════
console.log('1 — VolunteerPortal: self-service calls fall back to the Supabase JWT when no session_token')
{
  const s = src('src/pages/VolunteerPortal.jsx')
  const helper = s.slice(s.indexOf('const callVolunteerApi'), s.indexOf('const avatarInitials'))
  t('callVolunteerApi helper exists', helper.length > 0 && helper.includes('callApi('))
  t('it sends the durable session_token when one is stored',
    /session_token: sessionToken/.test(helper))
  t('otherwise it passes the live access_token as callApi\'s Bearer token argument',
    /supabase\.auth\.getSession\(\)/.test(helper) && /callApi\(action, params, session\?\.access_token/.test(helper))
  for (const action of ['log_knock', 'get_messages', 'get_notifications', 'send_message', 'mark_notif_read']) {
    t(`${action} goes through callVolunteerApi`,
      new RegExp(`callVolunteerApi\\('${action}'`).test(s) && !new RegExp(`callApi\\('${action}'`).test(s))
  }
  t('no call site sends session_token: loadSession()?.session_token (undefined on the OTP path)',
    !/session_token: loadSession\(\)\?\.session_token/.test(s))
  t('handleRefresh re-validates through callVolunteerApi',
    /callVolunteerApi\('get_volunteer', \{ volunteer_id: volunteer\.id \}\)/.test(s))

  // The server side the client relies on: authorizeVolunteer accepts a JWT.
  const fn = src('netlify/functions/volunteer-auth.js')
  const auth = fn.slice(fn.indexOf('async function authorizeVolunteer'), fn.indexOf('async function getMessages'))
  t('volunteer-auth authorizeVolunteer accepts a Bearer JWT whose email matches',
    /emailFromJwt\(authHeader\)/.test(auth))
}

// ═══ 2 — ElectionResultsBoard: paged results + stale-response guard ═════════
console.log('2 — ElectionResultsBoard: results paged past 1,000 rows; stale election responses dropped')
{
  const s = src('src/pages/ElectionResultsBoard.jsx')
  const load = s.slice(s.indexOf('const loadData = useCallback'), s.indexOf('// ── Race notification subscriptions'))
  t('results are read with .range() in a loop', /for \(let from = 0; ; from \+= PAGE\)/.test(load) && /\.range\(from, from \+ PAGE - 1\)/.test(load))
  t('page order is stable (votes desc, then id)', /\.order\('votes', \{ ascending: false \}\)\s*\.order\('id'\)/.test(load))
  t('loop stops on a short page', /page\.length < PAGE\) break/.test(load))
  t('an electionIdRef tracks the election on screen', /electionIdRef\.current = electionId/.test(s))
  t('loadData checks staleness after the contests read and after each results page',
    (load.match(/if \(isStale\(\)\) return/g) || []).length >= 3)
  t('isStale compares the captured id with the current one', /electionIdRef\.current !== id/.test(load))
  t('the 60s poll still goes through loadData (so it is guarded too)', /loadData\(electionId, true\)/.test(s))
}

// ═══ 3 — CampaignConnect: flash is stable ═══════════════════════════════════
console.log('3 — CampaignConnect: flash has a stable identity (no reload loop)')
{
  const s = src('src/pages/CampaignConnect.jsx')
  t('flash is wrapped in useCallback with no deps', /const flash = useCallback\([\s\S]*?\}, \[\]\)/.test(s))
  t('flash is no longer a plain per-render arrow', !/const flash = \(m, err\) =>/.test(s))
  t('the toast timer is held in a ref and reset per toast',
    /toastTimer = useRef\(null\)/.test(s) && /clearTimeout\(toastTimer\.current\)/.test(s))
  t('panels still key load on [flash] (now safe)', /\}, \[flash\]\)/.test(s))
}

// ═══ 4 — VoterLists: header aliases match spaced and underscored headers ════
console.log('4 — VoterLists: column aliases normalised like the headers')
{
  const { compactKey, pickField } = await loadPureBlock('src/pages/VoterLists.jsx')
  // Rows exactly as parseCSV builds them: raw lowercased header + compact alias.
  const build = (headers, values) => {
    const row = {}
    headers.forEach((h, i) => { row[h] = values[i]; const c = compactKey(h); if (!(c in row)) row[c] = values[i] })
    return row
  }
  const spaced = build(['state assembly district', 'party affiliation', 'congressional district'], ['86', 'DEM', '7'])
  eq('spaced "State Assembly District" resolves via state_assembly_district',
    pickField(spaced, 'assembly_dist', 'state_assembly_district', 'assem_dist'), '86')
  eq('spaced "Party Affiliation" resolves via party_affiliation',
    pickField(spaced, 'party', 'party_affiliation', 'party_pref'), 'DEM')
  eq('spaced "Congressional District" resolves', pickField(spaced, 'con_dist', 'congressional_district'), '7')
  const under = build(['state_assembly_district', 'party_affiliation'], ['35', 'REP'])
  eq('underscored headers still resolve', [pickField(under, 'state_assembly_district'), pickField(under, 'party_affiliation')], ['35', 'REP'])
  const camel = build(['stateassemblydistrict'], ['12'])
  eq('squashed headers resolve too', pickField(camel, 'state_assembly_district'), '12')
  eq('first non-empty alias wins', pickField({ a: '', b: 'x' }, 'a', 'b'), 'x')
  eq('missing columns return an empty string', pickField({}, 'zip', 'zip_code'), '')

  const s = src('src/pages/VoterLists.jsx')
  t('parseCSV maps state_assembly_district and party through pick()',
    /state_assembly_district:\s+pick\(/.test(s) && /party:\s+pick\(/.test(s))
  t('no raw underscored lookups remain in the column map', !/row\['state_assembly_district'\]|row\['party_affiliation'\]/.test(s))
}

// ═══ 5 — Settings: billing return lands on Plan & billing ═══════════════════
console.log('5 — Settings: ?billing= on bare /settings shows the plan pane')
{
  const s = src('src/pages/Settings.jsx')
  t('billingReturn is derived from the search when no pane/hash is in the URL',
    /const billingReturn = !paneParam && !hashPane && new URLSearchParams\(location\.search\)\.has\('billing'\)/.test(s))
  t('the pane resolves to plan for a billing return', /billingReturn \? 'plan' : DEFAULT_PANE/.test(s))
  t('the URL is normalised to /settings/plan keeping the search (replace)',
    /navigate\(`\/settings\/plan\$\{location\.search\}`, \{ replace: true \}\)/.test(s))
}

// ═══ 6 — AdminDashboard: bulk actions only touch visible selections ═════════
console.log('6 — AdminDashboard: bulk actions restricted to selected users in the current filter')
{
  const s = src('src/pages/AdminDashboard.jsx')
  t('visibleSelectedIds intersects filteredUsers with the selection',
    /const visibleSelectedIds = filteredUsers\.filter\(\(u\) => selected\.has\(u\.id\)\)/.test(s))
  const bulk = s.slice(s.indexOf('const handleBulkAction'), s.indexOf('const handleEditEmail'))
  t('handleBulkAction acts on visibleSelectedIds', /const ids = visibleSelectedIds/.test(bulk) && !/Array\.from\(selected\)/.test(bulk))
  t('the confirm count is the visible count', /for \$\{ids\.length\} user\(s\)/.test(bulk) && !/selected\.size/.test(bulk))
  t('the bulk bar shows the visible count', /\{visibleSelectedIds\.length\} selected/.test(s))
  t('no remaining selected.size reads', !/selected\.size/.test(s))
}

// ═══ 7 — ResetPassword: recovery captured at app boot ═══════════════════════
console.log('7 — ResetPassword: recovery marker/event captured in AuthContext before the lazy chunk mounts')
{
  const ac = src('src/contexts/AuthContext.jsx')
  const top = ac.slice(0, ac.indexOf('export const AuthProvider'))
  t('AuthContext reads type=recovery from the URL at module scope',
    /let recoveryPending = [\s\S]*?type=recovery/.test(top) && /window\.location\.hash/.test(top))
  t('AuthContext subscribes at module scope and flags PASSWORD_RECOVERY',
    /supabase\.auth\.onAuthStateChange\(\(event\) => \{[\s\S]*?PASSWORD_RECOVERY'\) recoveryPending = true/.test(top))
  t('isRecoveryPending getter is exported', /export const isRecoveryPending = \(\) => recoveryPending/.test(ac))
  t('a successful password update spends the flag', /if \(!error\) recoveryPending = false/.test(ac))

  const rp = src('src/pages/ResetPassword.jsx')
  t('ResetPassword imports isRecoveryPending', /import \{ useAuth, isRecoveryPending \} from '\.\.\/contexts\/AuthContext'/.test(rp))
  t('ResetPassword treats a boot-time recovery as recovery', /if \(isRecoveryPending\(\)\) return true/.test(rp))
  t('ResetPassword still listens for a late PASSWORD_RECOVERY', /event === 'PASSWORD_RECOVERY'\) setRecoveryEvent\(true\)/.test(rp))
}

// ═══ 8 — RecordViews: 'Lost' only for a finished race ═══════════════════════
console.log('8 — RecordViews: an undeclared race reads Pending, not Lost')
{
  const s = src('src/pages/candidate/RecordViews.jsx')
  t('raceFinal comes from the contest status (called / certified)',
    /const raceFinal = contest\?\.status === 'called' \|\| contest\?\.status === 'certified'/.test(s))
  t('Lost requires a final race and a non-winner row', /raceFinal && !result\.winner \? 'Lost' : 'Pending'/.test(s))
  t('votes > 0 alone no longer means Lost', !/result\.votes > 0 \? 'Lost'/.test(s))
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
