#!/usr/bin/env node
// Badger Board — PAGES-SWEEP-2: 13 page-level fixes (stale-response guards on
// VoterLists / Polling / ElectionResultsBoard / CandidateDetail + useBioSummary
// / Compare / Candidates, serialized saved-list adds, CalendarsPane save errors,
// usage-count error states, /dossiers payment-lock exemption, CampaignConnect
// confirms, Pricing refresh day, Profiler reader ↔ URL sync, disclaimer ack
// only after the server confirms).
//
// Source-text assertions against the real files — the repo convention for
// JSX/hook logic that can't be isolated — plus one behaviour test of the
// promise-chain pattern VoterLists uses to serialize read-modify-writes.
//
// Zero-config: node tests/pages-sweep-2.test.mjs

import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const src  = (p) => readFileSync(join(ROOT, p), 'utf8')

let pass = 0, fail = 0
const t = (name, cond) => { cond ? pass++ : fail++; console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${name}`) }
const between = (s, a, b) => { const i = s.indexOf(a); return i < 0 ? '' : s.slice(i, s.indexOf(b, i + a.length)) }

// ═══ 1 — VoterLists ═════════════════════════════════════════════════════════
console.log('1 — VoterLists: fetchVoters stale guard + serialized saved-list adds')
{
  const s = src('src/pages/VoterLists.jsx')
  const fv = between(s, 'const fetchVoters = async', 'const handleSelectList')
  t('fetchVoters takes a sequence number', /const reqId = \+\+votersReqRef\.current/.test(fv))
  t('…and drops a superseded response before writing', /if \(reqId !== votersReqRef\.current\) return/.test(fv)
    && fv.indexOf('reqId !== votersReqRef.current') < fv.indexOf('setVoters('))
  const add = between(s, 'const handleAddToList = useCallback', 'const handleAddToListFromModal')
  t('adds chain onto addChainRef (one at a time)', /addChainRef\.current\.then\(run, run\)/.test(add))
  t('each add re-reads the server row before writing', add.indexOf('getVoterSavedLists()') > -1
    && add.indexOf('getVoterSavedLists()') < add.indexOf('updateVoterSavedList('))
  t('write errors are surfaced, not ignored', /if \(writeErr\) throw writeErr/.test(add) && /alert\(/.test(add))
  t('no longer computes from the render-time savedLists closure', !/savedLists\.find/.test(add))
  t('modal button disabled while saving (saving is a block reason)',
    /disabled=\{!!addToListBlockReason\}/.test(s) && /: addingToList\s*\n?\s*\? 'Saving…'/.test(s))
}
// Behaviour: the chain pattern really serializes two racing read-modify-writes.
{
  let row = { ids: [] }
  const delay = (ms) => new Promise(r => setTimeout(r, ms))
  let chain = Promise.resolve()
  const add = (id, ms) => {
    const run = async () => { const ids = [...row.ids]; await delay(ms); row = { ids: [...ids, id] } }
    const next = chain.then(run, run); chain = next.catch(() => {}); return next
  }
  await Promise.all([add('a', 20), add('b', 1)])
  t('behaviour: two rapid chained adds both land', JSON.stringify(row.ids) === '["a","b"]')
}

// ═══ 2 — Polling ════════════════════════════════════════════════════════════
console.log('2 — Polling: loadIntel ignores responses for a district the user left')
{
  const s = src('src/pages/Polling.jsx')
  const li = between(s, 'const loadIntel = useCallback', '}, [])')
  t('sequence ref bumped per call', /const req = \+\+intelReqRef\.current/.test(li))
  t('stale/other-district response dropped before setIntel',
    /if \(req !== intelReqRef\.current \|\| d !== intelDistrictRef\.current\) return/.test(li)
    && li.indexOf('intelReqRef.current ||') < li.indexOf('setIntel(data'))
  t('district ref tracks the selection', /intelDistrictRef\.current = district/.test(s))
}

// ═══ 3 — ElectionResultsBoard ═══════════════════════════════════════════════
console.log('3 — ElectionResultsBoard: subscription load can\'t clobber a newer toggle')
{
  const s = src('src/pages/ElectionResultsBoard.jsx')
  t('load still cancels on user/election change', /if \(cancelled \|\| error\) return/.test(s))
  t('contests toggled mid-load keep their optimistic value',
    /notifyTouchedRef\.current = touched/.test(s) && /for \(const contestId of touched\)/.test(s))
  t('setNotifyMode records the touched contest', /notifyTouchedRef\.current\.add\(contestId\)/.test(s))
}

// ═══ 4 — CalendarsPane ══════════════════════════════════════════════════════
console.log('4 — CalendarsPane: updateUser errors surface and roll back')
{
  const s = src('src/pages/settings/CalendarsPane.jsx')
  const p = between(s, 'const persist = async', 'const toggleConnected')
  t('reads the error from updateUser', /\(\{ error \} = await supabase\.auth\.updateUser/.test(p))
  t('rolls back the optimistic keys on failure', /rolled\[k\] = prev\[k\]/.test(p) && /setLocal\(rolled\)/.test(p))
  t('shows an error message', /setSaveErr\(/.test(p) && /<Msg type="error">\{saveErr\.text\}<\/Msg>/.test(s))
  t('verify does not claim success when the save failed', /const saved = await toggleConnected\(key, true\)/.test(s))
}

// ═══ 5 — Settings / PlanPane ════════════════════════════════════════════════
console.log('5 — Settings/PlanPane: a failed usage count reads "—", not 0 used')
{
  const s = src('src/pages/Settings.jsx')
  t('per-count failure flags from each query error', /profilesUsed: !!monthly\.error/.test(s)
    && /monitored: !!monitored\.error/.test(s) && /candidates: !!candidates\.error/.test(s))
  t('a thrown query marks every count failed', /failed: ALL_FAILED/.test(s))
  t('hero tiles show — for a failed count', /usage\.loading \|\| usage\.failed\.profilesUsed \? '—'/.test(s))
  const p = src('src/pages/settings/PlanPane.jsx')
  t('Meter takes an unavailable flag', /function Meter\(\{ label, used, cap, note, loading, unavailable \}\)/.test(p))
  t('…which blanks the value and explains it', /const value = blank \? '—'/.test(p) && /Usage unavailable right now/.test(p))
  t('each meter wires its own failure flag', (p.match(/unavailable: !!usage\.failed\?\./g) || []).length === 3)
}

// ═══ 6 — PaymentLockOverlay ═════════════════════════════════════════════════
console.log('6 — PaymentLockOverlay: /dossiers exempt like /profiler')
{
  const s = src('src/components/PaymentLockOverlay.jsx')
  const list = between(s, 'const UNLOCKED_PATHS', ']')
  t('/profiler and /dossiers both unlocked', list.includes("'/profiler'") && list.includes("'/dossiers'"))
}

// ═══ 7 — CampaignConnect ════════════════════════════════════════════════════
console.log('7 — CampaignConnect: destructive actions confirm first')
{
  const s = src('src/pages/CampaignConnect.jsx')
  t('four confirm guards (remove link, decline, revoke manager, recall handoff)',
    (s.match(/if \(!window\.confirm\(/g) || []).length === 4)
  const recall = between(s, "const revoke = async (h) =>", "\n  }\n")
  t('handoff recall confirms before calling the API',
    recall.indexOf('window.confirm') > -1 && recall.indexOf('window.confirm') < recall.indexOf("api('profile-handoff'"))
}

// ═══ 8 — Pricing ════════════════════════════════════════════════════════════
console.log('8 — Pricing: FAQ refresh day matches the Monday schedule')
{
  const s = src('src/pages/Pricing.jsx')
  const toml = src('netlify.toml')
  t('auto-regenerate-dossiers runs Mondays', /\[functions\."auto-regenerate-dossiers"\]\s*\n\s*schedule = "0 15 \* \* 1"/.test(toml))
  t('FAQ says Monday', /fresh AI profile every Monday/.test(s))
  t('no "every Friday" left', !/every Friday/.test(s))
}

// ═══ 9 — CandidateDetail + candidate hooks ══════════════════════════════════
console.log('9 — CandidateDetail / useBioSummary: no cross-candidate overwrite')
{
  const s = src('src/pages/CandidateDetail.jsx')
  const fa = between(s, 'const fetchAll = useCallback', '}, [id])')
  t('fetchAll drops a response for a candidate no longer routed',
    /if \(idRef\.current !== id\) return null/.test(fa) && fa.indexOf('idRef.current !== id') < fa.indexOf('setCandidate('))
  t('refreshCandidate guarded the same way', /if \(idRef\.current !== reqId\) return/.test(s))
  const h = src('src/pages/candidate/shared.jsx')
  const bio = between(h, 'export function useBioSummary', 'return { summary, loading, error, generate }')
  t('useBioSummary sequences requests', /const req = \+\+reqRef\.current/.test(bio) && /reqRef\.current \+= 1/.test(bio))
  t('stale summary dropped before setSummary', bio.indexOf('if (isStale()) return') > -1
    && bio.indexOf('if (isStale()) return') < bio.indexOf('setSummary(stripped'))
  t('auto-fire waits for the new candidate\'s dossiers', /dossiersMatch/.test(bio))
  const sec = between(h, 'export function useDossierSection', 'return { content, loading, error }')
  t('useDossierSection cancels on cleanup', /if \(cancelled\) return/.test(sec) && /return \(\) => \{ cancelled = true \}/.test(sec))
}

// ═══ 10 — Compare ═══════════════════════════════════════════════════════════
console.log('10 — Compare: each side ignores out-of-order responses')
{
  const s = src('src/pages/Compare.jsx')
  t('one effect per side with a cancelled flag', (s.match(/loadSide\((left|right)Id\)\.then\(\(\[c, d\]\) => \{\s*if \(cancelled\) return/g) || []).length === 2)
  t('old shared Promise.all removed', !/Promise\.all\(\[loadSide\(leftId\), loadSide\(rightId\)\]\)/.test(s))
}

// ═══ 11 — Candidates ════════════════════════════════════════════════════════
console.log('11 — Candidates: only the newest list fetch writes')
{
  const s = src('src/pages/Candidates.jsx')
  const fd = between(s, 'const fetchData = useCallback', '}, [searchQuery, partyFilter, statusFilter, officeFilter])')
  t('sequence ref bumped per fetch', /const seq = \+\+fetchSeqRef\.current/.test(fd))
  t('stale response returns before setCandidates', fd.indexOf('if (isStale()) return') > -1
    && fd.indexOf('if (isStale()) return') < fd.indexOf('setCandidates('))
}

// ═══ 12 — Dossiers reader ↔ URL ═════════════════════════════════════════════
console.log('12 — Dossiers: browser Back closes the reader')
{
  const s = src('src/pages/Dossiers.jsx')
  t('live ?view= is read', /const viewParam\s+= searchParams\.get\('view'\)/.test(s))
  const sync = between(s, '// ── URL → reader sync', 'const closeReader')
  t('?view= disappearing closes the reader', /if \(!viewParam\)/.test(sync) && /setSelected\(null\)/.test(sync))
  t('?view= appearing opens it without writing the URL', /\{ fromUrl: true \}/.test(sync))
  t('acts only on a real ?view= change', /if \(prev === viewParam\) return/.test(sync))
  t('opens push only from the library, replace otherwise', /\{ replace: hadView \}/.test(s))
  t('"All profiles" steps back over our own entry', /navigate\(-1\)/.test(s) && /onClick=\{closeReader\}/.test(s))
}

// ═══ 13 — DossierDisclaimerModal ════════════════════════════════════════════
console.log('13 — DossierDisclaimerModal: ack persisted only after the server confirms')
{
  const s = src('src/components/DossierDisclaimerModal.jsx')
  const h = between(s, 'const handleAcknowledge = async', '\n  return (')
  t('no local fallback ack in the catch', !/catch[\s\S]*onAcknowledged\(/.test(h))
  t('requires ok + acknowledged_at from the server', /if \(!result\?\.ok \|\| !result\.acknowledged_at\) throw/.test(h))
  t('shows an error for retry', /setError\(`We couldn't record your acknowledgment/.test(h))
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
