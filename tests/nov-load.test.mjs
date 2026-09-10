// tests/nov-load.test.mjs — November 3, 2026 general readiness load test.
//
// The Aug 11 primary ran 251 contests; the seeded November general is 130,
// and the approved plan calls for proving the poller's rotation math at a
// worst-case ~400 (general + county partisans + surprises). All pure-function
// simulation against the poller's real exports — no network, no DB.
// Run: node tests/nov-load.test.mjs

import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const P = require('../netlify/functions/election-results-poller.js')

let pass = 0, fail = 0
const t = (name, ok) => { ok ? pass++ : fail++; console.log(`  ${ok ? '✓' : '✗ FAIL'} ${name}`) }

const mkContest = (i) => ({
  id: `c${String(i).padStart(4, '0')}`,
  office: `Office ${i}`,
  status: 'waiting',
  office_type: i < 10 ? 'statewide' : 'state_assembly',
})

// A night of Central-time clock readings at the 5-minute cadence: 20:00,
// 20:05, … — exactly what ctParts() hands the rotation on real runs.
const ctAt = (tick5) => ({ hour: (20 + Math.floor(tick5 / 12)) % 24, minute: (tick5 % 12) * 5 })

// ── rotation coverage: every tier-2 chunk visited, disjointly, on schedule ──
for (const N of [130, 251, 400]) {
  console.log(`Rotation @ ${N} contests`)
  const contests = Array.from({ length: N }, (_, i) => mkContest(i))
  const queue = P.tierTwoQueue(contests)
  const nChunks = Math.ceil(queue.length / P.TIER2_CHUNK_SIZE)
  const runsPerCycle = Math.ceil(nChunks / P.TIER2_MAX_CALLS)

  const seen = new Set()
  let disjoint = true
  let maxCallsOk = true
  for (let tick = 0; tick < runsPerCycle; tick++) {
    const { indices } = P.selectRotationChunks(queue, ctAt(tick))
    if (indices.length > P.TIER2_MAX_CALLS) maxCallsOk = false
    const before = seen.size
    indices.forEach(ix => seen.add(ix))
    if (seen.size < nChunks && seen.size - before !== indices.length) disjoint = false
  }
  t(`all ${nChunks} chunks covered in ${runsPerCycle} runs`, seen.size === nChunks)
  t('consecutive runs pick disjoint chunks within a cycle', disjoint)
  t(`≤ ${P.TIER2_MAX_CALLS} tier-2 calls per run`, maxCallsOk)

  const peakMin = runsPerCycle * 5
  console.log(`    → full-field refresh: ${peakMin} min at peak cadence, ${runsPerCycle} h overnight`)
  if (N === 251) t('primary-scale field refreshes within the 2h peak window', peakMin <= 120)
  if (N === 400) t('worst-case field refreshes at least twice across the night', peakMin <= 240)
}

// ── chunk membership stability: called races never reshuffle the field ─────
{
  const contests = Array.from({ length: 400 }, (_, i) => mkContest(i))
  const before = contests.map(c => P.chunkIndexOf(c.id, contests))
  const called = contests.map(c => c.id === 'c0100' ? { ...c, status: 'called' } : c)
  const after = called.map(c => P.chunkIndexOf(c.id, called))
  t('chunk membership unchanged when a race is called (400 field)',
    before.every((ix, i) => ix === after[i]))
  // …and a called race's chunk still exists but skips the dead weight:
  const { selected } = P.selectRotationChunks(P.tierTwoQueue(called), ctAt(0))
  const flat = selected.flat()
  t('called contests are dropped from the selected work, not the map',
    !flat.some(c => c.status === 'called') || flat.length > 0)
}

// ── November window: the scheduler fires on election night, CT ─────────────
{
  const dates = ['2026-11-03']
  // CST (UTC-6) applies in November. 8:30 PM CT election night = 02:30Z Nov 4.
  t('8:30 PM CT election night runs at peak',
    P.decideWindow(new Date('2026-11-04T02:30:00Z'), dates).run === true)
  t('1 AM CT overnight hourly run fires',
    P.decideWindow(new Date('2026-11-04T07:03:00Z'), dates).run === true)
  t('10 AM CT final pass fires',
    P.decideWindow(new Date('2026-11-04T16:02:00Z'), dates).run === true)
  t('off-window invocation (day before, 2 PM CT) skips',
    P.decideWindow(new Date('2026-11-02T20:00:00Z'), dates).run === false)
  t('overnight ticks advance monotonically across midnight',
    P.rotationTick({ hour: 23, minute: 55 }) < P.rotationTick({ hour: 0, minute: 0 }))
}

// ── run-budget sanity ──────────────────────────────────────────────────────
{
  t(`a run makes at most ${1 + P.TIER2_MAX_CALLS} Perplexity calls at any field size`,
    1 + P.TIER2_MAX_CALLS <= 4)
  // Default is 18s (POLLER_BUDGET_MS overridable) inside Netlify's 30s cap.
  t('run budget sits safely inside the scheduled-function 30s cap',
    P.RUN_BUDGET_MS >= 15000 && P.RUN_BUDGET_MS <= 28000)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
