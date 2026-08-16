// netlify/functions/election-results-poller.js
// ─── Automated election-night results poller (Phases 2–3) ────────────────────
//
// SPEC: RESULTS-live-election-game-plan.md → "Ingestion" + "Determination engine".
//
// A Netlify SCHEDULED function. The cron in netlify.toml fires every 5 minutes,
// all day, every day — this file decides whether the invocation is inside one
// of the owner's three election-night windows and exits immediately (no DB, no
// AI call, no log row) when it is not.
//
// ── Cadence (all times America/Chicago, computed with Intl, DST-safe) ────────
//
//   Election day 20:00–21:59  → every run (5-minute cadence)
//   Election day 22:00–23:59  → hourly (only when minute < 5)
//   Next day     00:00–03:59  → hourly (only when minute < 5)
//   Next day     10:00–10:04  → one final run
//   anything else             → skip, silently, before any I/O
//
//   The overnight window is "10 PM through 4 AM" read as SIX hourly runs —
//   22, 23, 00, 01, 02, 03 — with 04:00 the (exclusive) end of the window, so a
//   4 AM invocation does NOT run. See clockWindow().
//
// ── Run pipeline ────────────────────────────────────────────────────────────
//   1. Guard        the scheduler POSTs { next_run }; anything else needs an
//                   admin JWT and may pass { force, dry_run } for testing.
//   2. Load         election + contests + results (service role).
//   3. Bootstrap    zero contests and it is past 8:30 PM CT → ONE Perplexity
//                   discovery call to learn tonight's statewide contests and
//                   their candidates; create contests + zeroed result rows.
//   4. Update       TIERED. Tier 1 (office_type 'statewide') is one Perplexity
//                   call on EVERY run. Tier 2 (everything else — US House,
//                   state senate, state assembly, county) is sliced into chunks
//                   of TIER2_CHUNK_SIZE contests and up to TIER2_MAX_CALLS
//                   chunks are refreshed per run on a time-derived rotation.
//                   See "Tiered rotation" below.
//   5. Validate     every number, before anything is written (see
//                   validateContestUpdate) — failures are quarantined, noted
//                   in the log row's `error` field, and never written.
//   6. Write        upsert results → recompute vote_pct → precincts →
//                   determineStatus(), status written ONLY where
//                   status_source = 'auto'. `declared` is never touched.
//   6b. Notify      subscribers to any contest this run touched get an email
//                   via ./_result-notify.js (never on a dry run, never
//                   throwing, 30-minute throttle on running updates).
//   7. Log          one election_poller_log row per ACTIVE run.
//   8. Resilience   every throw is caught, logged, and answered with 200 —
//                   a scheduled function that 500s gets retried, and a retry
//                   storm on election night is worse than a missed cycle.
//
// Perplexity is used strictly as an EXTRACTOR of numbers somebody else has
// already published. Both prompts forbid estimating, projecting, modelling or
// rounding, and the update prompt requires a source per contest — a contest
// that comes back without one is quarantined.
//
// PLATFORM NOTE: Netlify will not route a public URL to a function that has a
// `schedule` in netlify.toml, so the admin force/dry-run path below is reachable
// via `netlify functions:invoke` (or with the schedule temporarily removed), not
// over https://badgerboardwi.com/.netlify/functions/election-results-poller. The
// Netlify UI's "Run now" button fires it with the scheduler's own payload, so
// that path runs as poller:auto and still obeys the time window. Scheduled
// functions also have a hard 30-second execution limit — see RUN_BUDGET_MS.
//
// ── Tiered rotation (full-ballot coverage) ──────────────────────────────────
//
// A full Wisconsin partisan primary ballot is 250+ contests: 9-ish statewide,
// 8 US House, 17 state senate, 99 assembly, plus whatever county primaries are
// contested. One batched call cannot carry that inside a 24-second budget, so
// each run refreshes a slice:
//
//   Tier 1  office_type = 'statewide'   → one call, EVERY run.
//   Tier 2  everything else             → chunks of 8, at most 2 chunks/run.
//
// The rotation cursor is derived from the Central-time clock rather than stored
// anywhere, so it needs no new table and no read-modify-write race between
// concurrent invocations. rotationTick() counts 5-minute ticks (or whole hours,
// on the hourly cadence) from 8 PM CT, and each run starts at
// (tick × chunksPerRun) mod nChunks — consecutive runs therefore cover disjoint
// chunks and the whole tier-2 field comes round on a predictable cycle.
//
// Chunk MEMBERSHIP is stable for the night: every tier-2 contest (including the
// called ones) is sorted by id and assigned chunkIndex = position mod nChunks.
// Nothing is filtered out of that list, so a race being called never reshuffles
// everybody else. Two things vary INSIDE a chunk instead:
//   · contests already 'called' or 'certified' are skipped — they cost nothing
//   · after 11 PM CT, contests still 'waiting' are ordered LAST, so the races
//     that are actually counting get the calls
//
// ── County discovery (manual only) ──────────────────────────────────────────
// {discover:'county', chunk:N} runs ONE Perplexity call over 12 of Wisconsin's
// 72 counties (N = 0…5, alphabetical) asking only for CONTESTED partisan
// county-office primaries. It is reached through admin-elections' run_poller,
// a normal 26-second function, hence one chunk per invocation — call it six
// times to sweep the state. Never runs on the scheduled path.
//
// Exports: handler plus the pure pieces, unit-tested in tests/remediation.test.mjs
//   decideWindow, clockWindow, ctParts, validateContestUpdate, matchCandidate,
//   chunkList, tierTwoQueue, selectRotationChunks, rotationTick, contestLine,
//   countyChunk, countyDiscoveryPrompt, shapeCountyContests, WI_COUNTIES

const { cors, json, serviceClient, requireAdmin } = require('./_shared')
const { normalizePartyForDb } = require('./_party')
const { determineStatus } = require('./_determination')
const { notifyContestChanges } = require('./_result-notify')
const COUNTY_SOURCES = require('./_county-sources.json')

// Read lazily: the key is looked up per call so a test (or a redeploy that sets
// the variable after cold start) never gets a stale null captured at require().
const pplxKey = () => process.env.PERPLEXITY_API_KEY
const PPLX_URL   = 'https://api.perplexity.ai/chat/completions'
const PPLX_MODEL = 'sonar'

// Wisconsin's entire electorate casts ~3.3M votes at a presidential general and
// well under 1.5M at a partisan primary. A contest at or above this is a parse
// error or a hallucination, never a real tally.
const MAX_TOTAL_VOTES = 4000000

// Whole-run wall-clock budget. Netlify scheduled functions are short-lived, so
// we stop making network calls before the platform kills us and the audit row
// still gets written. ONE deadline (startedAt + RUN_BUDGET_MS) is threaded
// through the AI calls, the database writes AND the notifier — everything that
// does not fit carries to the next run, and writeLog always gets its reserve.
const RUN_BUDGET_MS = Number(process.env.POLLER_BUDGET_MS) || 18000

// Never START another contest's write round-trips (or another subscriber's
// email) with less than this left — the audit row is worth more than one more
// contest, and the next run picks up whatever was deferred.
const WRITE_MIN_BUDGET_MS  = 2500
// What writeLog itself is allowed to need after everything else has stopped.
const LOG_RESERVE_MS = 1500

// Discovery only makes sense once polls have been closed a while.
const BOOTSTRAP_AFTER_MINUTES = 20 * 60 + 30   // 20:30 CT

// ── Tiered rotation knobs ───────────────────────────────────────────────────
// 8 contests is what one `sonar` reply carries comfortably inside the token cap
// (12 could truncate, and a truncated reply used to throw away the whole chunk);
// 2 chunks + the statewide call is 3 calls, which fits the 18s run budget with
// room left for the writes and the emails.
const TIER2_CHUNK_SIZE = Number(process.env.POLLER_CHUNK_SIZE) || 8
const TIER2_MAX_CALLS  = Number(process.env.POLLER_TIER2_CALLS) || 3 // parallel, staggered — 7 concurrent tripped Perplexity's 429 limit on election night

// Never START another chunk with less than this left in the budget — a chunk
// that gets killed mid-flight costs the whole run its audit row.
const CHUNK_MIN_BUDGET_MS = 8000

// Tier 1 runs on EVERY cycle, so one hung statewide call must never eat the
// down-ballot budget.
const TIER1_TIMEOUT_MS = 10000

// Nothing left to learn about these, so they leave the rotation entirely.
const DONE_STATUSES = new Set(['called', 'certified'])

// ── Election-night call embargo (owner directive, Aug 11 2026) ───────────────
// No race may be auto-called before 22:30 CT on election night: early county
// feeds carry junk precinct totals ("1 of 1 reporting") that made races look
// 100% counted at 8 PM. The clock, not the data, lifts this.
const CALL_EMBARGO_CT_MINUTES = Number(process.env.CALL_EMBARGO_CT_MINUTES) || (22 * 60 + 30)
function callEmbargoActive(when = new Date(), electionDates = []) {
  const ct = ctParts(when)
  const dates = toDateSet(electionDates)
  if (!dates.has(ct.date)) return false // day after: counting is done, calls allowed
  return ct.minutes < CALL_EMBARGO_CT_MINUTES
}

// A contest is only DONE (dropped from the update rotation) when there is
// nothing left to count: certified, or called WITH every precinct reported.
// A called race that is still counting keeps refreshing — the owner's rule:
// "do not stop sending the updates until all the votes are counted."
function doneCounting(c) {
  if (!c) return false
  if (c.status === 'certified') return true
  const total = parseInt(c.precincts_total, 10) || 0
  const rptg  = parseInt(c.precincts_rptg, 10) || 0
  return c.status === 'called' && total > 0 && rptg >= total
}

// County discovery is manual-only and arrives via admin-elections' run_poller,
// which is a regular 26-second function — hence ONE 12-county call per call.
const COUNTY_CHUNK_SIZE     = 12
const COUNTY_DISCOVER_BUDGET_MS = Number(process.env.POLLER_DISCOVER_BUDGET_MS) || 22000

/** Wisconsin's 72 counties, alphabetical — the same list the events researcher uses. */
const WI_COUNTIES = Object.keys(COUNTY_SOURCES).sort((a, b) => a.localeCompare(b, 'en'))
const COUNTY_CHUNKS = Math.ceil(WI_COUNTIES.length / COUNTY_CHUNK_SIZE)

// The partisan county offices Wisconsin actually elects. Anything else coming
// back from discovery is a hallucination or a nonpartisan/spring office.
const COUNTY_OFFICES = [
  'Sheriff', 'County Clerk', 'County Treasurer', 'Register of Deeds', 'Coroner', 'District Attorney',
]

// ─────────────────────────────────────────────────────────────────────────────
// Time — America/Chicago via Intl, never a hardcoded UTC offset
// ─────────────────────────────────────────────────────────────────────────────

const CT_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
})

/**
 * Central-time calendar fields for an instant. DST is handled by the ICU time
 * zone database, so this stays correct across the March/November transitions
 * and any future change to US DST rules.
 * @returns {{date: string, hour: number, minute: number, minutes: number}}
 */
function ctParts(when = new Date()) {
  let d = when instanceof Date ? when : new Date(when)
  // An unparseable instant would make Intl throw; treat it as "now" so the
  // caller's decision path can never blow up on a bad clock value.
  if (Number.isNaN(d.getTime())) d = new Date()
  const p = {}
  for (const part of CT_FORMAT.formatToParts(d)) {
    if (part.type !== 'literal') p[part.type] = part.value
  }
  const hour   = parseInt(p.hour, 10) % 24        // some ICU builds render midnight as 24
  const minute = parseInt(p.minute, 10)
  return { date: `${p.year}-${p.month}-${p.day}`, hour, minute, minutes: hour * 60 + minute }
}

const pad2 = (n) => String(n).padStart(2, '0')

/** 'YYYY-MM-DD' → the calendar day before it. Pure string/UTC math, no TZ. */
function prevDay(ymd) {
  const [y, m, d] = String(ymd).split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d) - 86400000)
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`
}

/** Normalize whatever the DB / caller hands us into a Set of 'YYYY-MM-DD'. */
function toDateSet(dates) {
  const set = new Set()
  for (const d of (Array.isArray(dates) ? dates : dates ? [dates] : [])) {
    if (!d) continue
    if (d instanceof Date) { set.add(ctParts(d).date); continue }
    const s = typeof d === 'string' ? d : (d.election_date || '')
    if (s) set.add(String(s).slice(0, 10))
  }
  return set
}

/**
 * Clock-only half of the decision: which window would this instant belong to,
 * and which election date would it be serving? Runs before any DB access, so an
 * out-of-window invocation costs nothing.
 *
 * @returns {{phase: string|null, cadence: string|null, targetDate: string|null, ct: Object}}
 */
function clockWindow(when = new Date()) {
  const d = when instanceof Date ? when : new Date(when)
  const ct = ctParts(d)
  // Invalid instant → no window at all. Never guess a phase from a bad clock.
  if (Number.isNaN(d.getTime())) return { phase: null, cadence: null, targetDate: null, ct }
  const { hour, minute, date } = ct
  const topOfHour = minute < 5   // the cron fires at :00 :05 :10 … so <5 == "this hour's run"

  // 20:00–21:59 on election day — the two hours that matter most.
  if (hour >= 20 && hour < 22) {
    return { phase: 'peak', cadence: 'every 5 minutes', targetDate: date, ct }
  }
  // 22:00–23:59 on election day — hourly.
  if (hour >= 22 && topOfHour) {
    return { phase: 'overnight', cadence: 'hourly', targetDate: date, ct }
  }
  // 00:00–03:59 the morning after — hourly. 04:00 is the exclusive end of the
  // overnight window (22, 23, 00, 01, 02, 03 = the six hourly runs), so a 4 AM
  // invocation deliberately falls through to 'skip'.
  if (hour < 4 && topOfHour) {
    return { phase: 'overnight', cadence: 'hourly', targetDate: prevDay(date), ct }
  }
  // 10:00–10:04 the morning after — the single final sweep.
  if (hour === 10 && topOfHour) {
    return { phase: 'final', cadence: 'once', targetDate: prevDay(date), ct }
  }
  return { phase: null, cadence: null, targetDate: null, ct }
}

/**
 * Full decision: is this invocation an active run?
 *
 * @param {Date}  when            the instant to judge (injectable for tests)
 * @param {Array} electionDates   election_date values ('YYYY-MM-DD', Date, or rows)
 * @returns {{run: boolean, phase: string|null, cadence: string|null,
 *            electionDate: string|null, ct: Object, reason: string}}
 */
function decideWindow(when = new Date(), electionDates = []) {
  const w = clockWindow(when)
  const clock = `${pad2(w.ct.hour)}:${pad2(w.ct.minute)} CT on ${w.ct.date}`

  if (!w.phase) {
    return { run: false, phase: null, cadence: null, electionDate: null, ct: w.ct,
      reason: `${clock} is outside every polling window.` }
  }
  const known = toDateSet(electionDates)
  if (!known.has(w.targetDate)) {
    return { run: false, phase: w.phase, cadence: w.cadence, electionDate: null, ct: w.ct,
      reason: `${clock} is in the ${w.phase} window, but no election is on file for ${w.targetDate}.` }
  }
  return {
    run: true, phase: w.phase, cadence: w.cadence, electionDate: w.targetDate, ct: w.ct,
    reason: `${clock} — ${w.phase} window for the ${w.targetDate} election (${w.cadence}).`,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tiered rotation — PURE. No I/O, no randomness, no stored cursor.
// ─────────────────────────────────────────────────────────────────────────────

/** Tier 1 is exactly the statewide field; everything else rotates. */
function isTierOne(contest) {
  return Boolean(contest) && contest.office_type === 'statewide'
}

/** Split a list into fixed-size chunks. A 0/NaN size degrades to one chunk. */
function chunkList(list, size = TIER2_CHUNK_SIZE) {
  const arr = Array.isArray(list) ? list : []
  const n = Math.max(1, Math.floor(Number(size) || 0) || TIER2_CHUNK_SIZE)
  const out = []
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
  return out
}

/**
 * After 11 PM CT the races that are still 'waiting' are the ones nobody has
 * published a single number for — the counting races deserve the calls, so the
 * waiting ones sort last. 20:00–22:59 is "early"; everything else is "late",
 * which covers 23:00, the 00:00–03:59 hourly runs and the 10 AM final sweep.
 */
function deprioritizeWaiting(ct) {
  const h = Number(ct && ct.hour)
  if (!Number.isFinite(h)) return false
  return h >= 23 || h < 20
}

/**
 * The tier-2 field: everything that is not statewide, in ONE stable order —
 * lexicographic by id, INCLUDING contests that are already called or certified.
 *
 * Membership is deliberately unfiltered. Chunk assignment is derived from a
 * contest's position in this list, so dropping decided races (or re-sorting at
 * 11 PM) used to shuffle every contest into a different chunk and some races
 * were refreshed twice while others waited hours. Decided contests keep their
 * seat and cost nothing: they are skipped INSIDE the chunk.
 */
function tierTwoQueue(contests) {
  return (Array.isArray(contests) ? contests : [])
    .filter(c => c && !isTierOne(c))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
}

/**
 * Deal the stable tier-2 list into nChunks = ceil(total / size) chunks by
 * position mod nChunks. Position-derived, so a contest's chunk never moves
 * unless the ballot itself changes.
 */
function assignChunks(list, size = TIER2_CHUNK_SIZE) {
  const arr = Array.isArray(list) ? list : []
  const n = Math.max(1, Math.floor(Number(size) || 0) || TIER2_CHUNK_SIZE)
  const nChunks = Math.ceil(arr.length / n)
  const chunks = Array.from({ length: nChunks }, () => [])
  arr.forEach((item, i) => chunks[i % nChunks].push(item))
  return { nChunks, chunks }
}

/**
 * The work a chunk is actually worth this run: decided contests dropped (there
 * is nothing left to learn) and, late in the night, the races nobody has
 * published a single number for ordered last. Membership never changes — only
 * the order inside the chunk does.
 */
function orderChunk(chunk, ct = {}) {
  const late = deprioritizeWaiting(ct)
  return (Array.isArray(chunk) ? chunk : [])
    .filter(c => c && !doneCounting(c))
    .sort((a, b) => {
      if (late) {
        const aw = a.status === 'waiting' ? 1 : 0
        const bw = b.status === 'waiting' ? 1 : 0
        if (aw !== bw) return aw - bw
      }
      return String(a.id).localeCompare(String(b.id))
    })
}

/** Which chunk does one contest live in, given the whole tier-2 field? */
function chunkIndexOf(contestId, contests, size = TIER2_CHUNK_SIZE) {
  const queue = tierTwoQueue(contests)
  const n = Math.max(1, Math.floor(Number(size) || 0) || TIER2_CHUNK_SIZE)
  const nChunks = Math.ceil(queue.length / n)
  const pos = queue.findIndex(c => String(c.id) === String(contestId))
  return pos < 0 || !nChunks ? -1 : pos % nChunks
}

/**
 * A monotonically increasing tick across one election night, derived purely
 * from the Central-time clock.
 *
 *   5-minute cadence → 12 ticks an hour, counted from 20:00 CT
 *   hourly cadence   → one tick an hour, counted from 20:00 CT
 *
 * 20:00 is tick 0, so the night runs 20,21,22,23,00,01,02,03 → 0..7 without
 * wrapping, and the 10 AM final sweep lands at 14. That keeps the rotation
 * moving forward all night instead of jumping backwards at midnight.
 */
function rotationTick(ct = {}, cadence = 'every 5 minutes') {
  const hour   = Number(ct.hour)
  const minute = Number(ct.minute)
  const h = Number.isFinite(hour) ? ((hour + 4) % 24) : 0
  if (cadence === 'hourly' || cadence === 'once') return h
  return h * 12 + Math.floor((Number.isFinite(minute) ? minute : 0) / 5)
}

/**
 * Which tier-2 chunks does THIS run refresh? Deterministic for a given clock
 * reading, and disjoint from the previous run's slice (the cursor advances by
 * the number of chunks a run can actually make).
 *
 * `queue` is the UNFILTERED, stable tier-2 list (see tierTwoQueue): chunk
 * membership is fixed for the night, and `selected` carries only the contests
 * in those chunks that are still worth a call.
 *
 * @returns {{nChunks:number, indices:number[], selected:Array<Array>, chunks:Array<Array>}}
 */
function selectRotationChunks(queue, ct = {}, opts = {}) {
  const size     = opts.size || TIER2_CHUNK_SIZE
  const maxCalls = Math.max(1, Math.floor(Number(opts.maxCalls) || TIER2_MAX_CALLS))
  const cadence  = opts.cadence || 'every 5 minutes'
  const { nChunks: n, chunks } = assignChunks(queue, size)
  if (!n) return { nChunks: 0, indices: [], selected: [], chunks }

  const take  = Math.min(maxCalls, n)
  const start = ((rotationTick(ct, cadence) * take) % n + n) % n
  const indices = []
  for (let i = 0; i < take; i++) indices.push((start + i) % n)
  return { nChunks: n, indices, selected: indices.map(i => orderChunk(chunks[i], ct)), chunks }
}

/**
 * One line of a results prompt. Carries the district and county explicitly so
 * the extractor targets a single race — "State Assembly District 85" and
 * "State Assembly District 8" are otherwise one substring apart.
 */
function contestLine(contest, i = 0) {
  const c = contest || {}
  let line = `${i + 1}. ${c.office || 'unknown contest'}`
  const district = c.district ? String(c.district).trim() : ''
  if (district && !normName(c.office).includes(normName(district))) line += ` — ${district}`
  const county = c.county ? String(c.county).trim() : ''
  if (county && !normName(c.office).includes(normName(`${county} county`))) line += ` — ${county} County, Wisconsin`
  const names = (Array.isArray(c._results) ? c._results : []).map(r => r && r.candidate_name).filter(Boolean)
  if (names.length) line += ` (candidates on file: ${names.join(', ')})`
  return line
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation — nothing reaches the database without passing through here
// ─────────────────────────────────────────────────────────────────────────────

const NAME_SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v'])

/** lowercase, unaccented, punctuation-free, single-spaced. */
function normName(s) {
  return String(s == null ? '' : s)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')  // strip combining accents
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Last meaningful token of a name ("Sarah Rodriguez Jr." → "rodriguez"). */
function lastNameOf(s) {
  const parts = normName(s).split(' ').filter(w => w && !NAME_SUFFIXES.has(w))
  return parts.length ? parts[parts.length - 1] : ''
}

/** Non-negative integer, or null. Rejects NaN/Infinity/negatives/fractions/junk. */
function toInt(v) {
  if (v === null || v === undefined || v === '') return null
  if (typeof v === 'boolean') return null
  const n = typeof v === 'string' ? Number(v.replace(/[,\s]/g, '')) : Number(v)
  if (!Number.isFinite(n) || n < 0) return null
  if (!Number.isInteger(n)) return null
  return n
}

/**
 * Match a reported candidate name to a roster row: exact (normalized, so
 * case- and punctuation-insensitive) first, then a unique last-name fallback.
 * An ambiguous last name never matches.
 * @returns {{row: Object|null, by: string, ambiguous: boolean}}
 */
function matchCandidate(name, roster) {
  const rows = Array.isArray(roster) ? roster : []
  const want = normName(name)
  if (!want) return { row: null, by: 'none', ambiguous: false }

  const exact = rows.filter(r => normName(r.candidate_name) === want)
  if (exact.length === 1) return { row: exact[0], by: 'exact', ambiguous: false }
  if (exact.length > 1)   return { row: null, by: 'none', ambiguous: true }

  const last = lastNameOf(name)
  if (!last) return { row: null, by: 'none', ambiguous: false }
  const byLast = rows.filter(r => lastNameOf(r.candidate_name) === last)
  if (byLast.length === 1) return { row: byLast[0], by: 'last-name', ambiguous: false }
  if (byLast.length > 1)   return { row: null, by: 'none', ambiguous: true }

  return { row: null, by: 'none', ambiguous: false }
}

/**
 * Validate one contest's reported payload against what is already stored.
 * PURE — no I/O, never throws. Anything failing a rule is dropped and explained
 * in `notes`; the caller writes only what comes back in updates/inserts/precincts.
 *
 * Rules
 *   · a contest with no cited source is quarantined whole
 *   · votes must be whole numbers >= 0 and >= the value already stored (a
 *     decrease is skipped, never written — a genuine revision will confirm
 *     itself on the next pass)
 *   · names match case-insensitively, then by unique last name
 *   · an unmatched name may be INSERTED only in a contest this run just
 *     bootstrapped; in an established contest it is quarantined
 *   · precincts reporting is clamped to precincts total, and never moves backwards
 *   · a contest whose merged total reaches MAX_TOTAL_VOTES is quarantined whole
 *
 * @param {Object} payload   { office, candidates:[{name,votes}], precincts_reporting, precincts_total, source }
 * @param {Object} existing  { office, results:[{id,candidate_name,votes}], precincts_total, precincts_rptg }
 * @param {Object} opts      { allowInserts:boolean, maxTotalVotes:number }
 */
function validateContestUpdate(payload, existing = {}, opts = {}) {
  const notes = []
  const allowInserts  = opts.allowInserts === true
  const maxTotalVotes = Number(opts.maxTotalVotes) || MAX_TOTAL_VOTES
  const roster = Array.isArray(existing.results) ? existing.results : []
  const office = existing.office || (payload && payload.office) || 'unknown contest'
  const bail = (note) => {
    notes.push(`${office}: ${note}`)
    return { ok: false, office, source: null, updates: [], inserts: [], precincts: null, notes, total_votes: 0 }
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return bail('no usable payload returned — skipped')
  }
  const source = typeof payload.source === 'string' ? payload.source.trim() : ''
  if (!source) return bail('no source cited for these numbers — quarantined, nothing written')

  const reported = Array.isArray(payload.candidates) ? payload.candidates : []
  if (!reported.length) return bail('no candidate rows returned — skipped')

  const updates = []
  const inserts = []
  const claimed = new Set()

  for (const c of reported) {
    const rawName = c && typeof c.name === 'string' ? c.name.trim() : ''
    if (!rawName) { notes.push(`${office}: a reported row had no candidate name — skipped`); continue }

    const votes = toInt(c.votes)
    if (votes === null) {
      notes.push(`${office}: "${rawName}" reported votes ${JSON.stringify(c.votes)}, which is not a whole number — skipped`)
      continue
    }

    const m = matchCandidate(rawName, roster)
    if (m.ambiguous) {
      notes.push(`${office}: "${rawName}" matches more than one candidate on the roster — quarantined`)
      continue
    }
    if (m.row) {
      const key = m.row.id || normName(m.row.candidate_name)
      if (claimed.has(key)) {
        notes.push(`${office}: "${rawName}" is a duplicate report for ${m.row.candidate_name} — skipped`)
        continue
      }
      const current = toInt(m.row.votes) || 0
      if (votes < current) {
        notes.push(`${office}: ${m.row.candidate_name} reported ${votes} votes, below the stored ${current} — skipped (totals never go down; a real revision will confirm next pass)`)
        continue
      }
      claimed.add(key)
      updates.push({ id: m.row.id, candidate_name: m.row.candidate_name, votes, matched_by: m.by })
      continue
    }
    if (allowInserts) {
      const key = normName(rawName)
      if (claimed.has(key)) { notes.push(`${office}: duplicate reported candidate "${rawName}" — skipped`); continue }
      claimed.add(key)
      inserts.push({ candidate_name: rawName, votes })
      continue
    }
    notes.push(`${office}: "${rawName}" is not on this contest's roster — quarantined, not written`)
  }

  // ── precincts ────────────────────────────────────────────────────────────
  const storedTotal = toInt(existing.precincts_total) || 0
  const storedRptg  = toInt(existing.precincts_rptg)  || 0
  let total = toInt(payload.precincts_total)
  const rptg = toInt(payload.precincts_reporting)
  if (total === null) total = storedTotal

  // Before any actual votes exist (pre-election / polls just closed), sources
  // have nothing real to say about precinct counts — anything offered is noise
  // (e.g. "50" showed up pre-election on 2026-08-10). Ignore precinct changes
  // until the contest carries at least one nonzero vote, incoming or stored.
  // Implausibly tiny precinct totals are county-site partials ("1 of 1
  // reporting" on a page that has counted one ward) — the exact junk that made
  // races look 100% counted at 8 PM. No real contest here has < 5 precincts.
  if (total !== null && total > 0 && total < 5) {
    notes.push(`${office}: implausible precincts_total ${total} — ignored`)
    total = storedTotal
  }
  const anyVotes =
    updates.some(u => (u.votes || 0) > 0) ||
    (existing.results || []).some(r => (toInt(r.votes) || 0) > 0)
  if (!anyVotes && (rptg !== null || total !== storedTotal)) {
    if (total !== storedTotal) notes.push(`${office}: precinct figures offered before any votes exist — ignored`)
    total = storedTotal
  }

  let precincts = null
  if (anyVotes && (rptg !== null || total !== storedTotal)) {
    let nextRptg = rptg === null ? storedRptg : rptg
    if (total > 0 && nextRptg > total) {
      notes.push(`${office}: precincts reporting ${nextRptg} exceeded the ${total} total — clamped to ${total}`)
      nextRptg = total
    }
    if (nextRptg < storedRptg) {
      notes.push(`${office}: precincts reporting ${nextRptg} is below the stored ${storedRptg} — precinct count left alone`)
      nextRptg = storedRptg
    }
    precincts = { precincts_rptg: nextRptg, precincts_total: total }
    if (precincts.precincts_rptg === storedRptg && precincts.precincts_total === storedTotal) precincts = null
  }

  // ── sanity cap on the merged picture ─────────────────────────────────────
  const accepted = new Map(updates.map(u => [u.id || normName(u.candidate_name), u.votes]))
  let merged = 0
  for (const r of roster) {
    const k = r.id || normName(r.candidate_name)
    merged += accepted.has(k) ? accepted.get(k) : (toInt(r.votes) || 0)
  }
  for (const i of inserts) merged += i.votes
  if (merged >= maxTotalVotes) {
    return bail(`merged total of ${merged} votes is at or above the ${maxTotalVotes}-vote sanity cap — quarantined, nothing written`)
  }

  return {
    ok: Boolean(updates.length || inserts.length || precincts),
    office, source, updates, inserts, precincts, notes, total_votes: merged,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Perplexity — extraction only
// ─────────────────────────────────────────────────────────────────────────────

const EXTRACTOR_SYSTEM =
  'You are an election-results EXTRACTOR for Wisconsin. You report only numbers and facts ' +
  'that an official source or a major news organization has already published. You never ' +
  'estimate, project, model, extrapolate, average, round or infer a number, and you never ' +
  'invent a contest or a candidate. If something has not been published yet, you omit it. ' +
  'You reply with strict JSON and nothing else — no prose, no commentary, no markdown fences.'

/** Strip fences / prose and pull the first complete JSON value out of a reply. */
function parseJsonLoose(text) {
  if (!text || typeof text !== 'string') return null
  const s = text.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim()
  try { return JSON.parse(s) } catch { /* fall through */ }
  const slices = []
  const a = s.indexOf('['), z = s.lastIndexOf(']')
  if (a >= 0 && z > a) slices.push(s.slice(a, z + 1))
  const o = s.indexOf('{'), c = s.lastIndexOf('}')
  if (o >= 0 && c > o) slices.push(s.slice(o, c + 1))
  for (const slice of slices) {
    try { return JSON.parse(slice) } catch { /* next */ }
  }
  return null
}

/**
 * Last resort for a TRUNCATED reply: walk the contests array and keep every
 * complete top-level {...} object, dropping the half-written one at the end.
 * A cut-off reply used to fail parsing and cost the whole chunk; now the eight
 * contests that did arrive are written and the ninth waits for the next run.
 *
 * PURE. Returns an array of objects, or null when nothing whole survived.
 */
function salvageJsonObjects(text) {
  if (!text || typeof text !== 'string') return null
  const s = text.replace(/^```(?:json)?\s*/i, '')

  // Start inside the array so the (never-closed) envelope object is skipped.
  const keyed = s.search(/"(?:contests|results)"\s*:\s*\[/)
  let start = keyed >= 0 ? s.indexOf('[', keyed) : s.indexOf('[')
  if (start < 0) start = 0

  const out = []
  let depth = 0, objStart = -1, inStr = false, esc = false
  for (let i = start; i < s.length; i++) {
    const ch = s[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') { inStr = true; continue }
    if (ch === '{') { if (depth === 0) objStart = i; depth++; continue }
    if (ch === '}') {
      depth--
      if (depth <= 0) {
        if (objStart >= 0) {
          try {
            const v = JSON.parse(s.slice(objStart, i + 1))
            if (v && typeof v === 'object' && !Array.isArray(v)) out.push(v)
          } catch { /* a whole object that still will not parse is not usable */ }
        }
        depth = 0
        objStart = -1
      }
      continue
    }
    if (ch === ']' && depth === 0) break
  }
  return out.length ? out : null
}

/**
 * The parser the RESULTS path uses: strict JSON first, then salvage. Returns
 * { contests, salvaged } — `contests` is null only when nothing at all could be
 * read out of the reply.
 */
function parseContestsLoose(text) {
  const parsed = contestArrayFrom(parseJsonLoose(text))
  if (parsed) return { contests: parsed, salvaged: false }
  const salvaged = salvageJsonObjects(text)
  if (salvaged) return { contests: salvaged, salvaged: true }
  return { contests: null, salvaged: false }
}

/**
 * One Perplexity chat completion. Asks for a JSON schema when one is given and
 * silently retries without it if the API rejects the constraint, because the
 * prompts demand strict JSON on their own too. Never throws.
 */
/**
 * One run's Perplexity dispatch state. A 429 anywhere in a run means the next
 * call would 429 too, so the gate closes and the rest of the run's calls are
 * skipped instead of burning the clock on certain failures.
 */
function makeRunGate() {
  return { rateLimited: false }
}

async function queryPerplexity({ system, user, maxTokens = 2000, schema = null, timeoutMs = 20000, gate = null }) {
  const key = pplxKey()
  if (!key) return { text: null, error: 'PERPLEXITY_API_KEY is not set' }
  if (gate && gate.rateLimited) {
    return { text: null, error: 'skipped: Perplexity returned 429 earlier this run, so no further calls were dispatched' }
  }
  if (timeoutMs <= 1000) return { text: null, error: 'no time budget left for the Perplexity call' }

  const send = async (withSchema) => {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const body = {
        model: PPLX_MODEL,
        temperature: 0,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: system },
          { role: 'user',   content: user },
        ],
      }
      if (withSchema && schema) body.response_format = { type: 'json_schema', json_schema: { schema } }
      const res = await fetch(PPLX_URL, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        // Rate limited: close the gate so nothing else this run is dispatched.
        if (res.status === 429 && gate) gate.rateLimited = true
        return { status: res.status, text: null, error: `Perplexity ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}` }
      }
      const d = await res.json()
      return { status: 200, text: (d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || null, error: null }
    } catch (e) {
      return { status: 0, text: null, error: e.name === 'AbortError' ? 'Perplexity call timed out' : `Perplexity call failed: ${e.message}` }
    } finally {
      clearTimeout(timer)
    }
  }

  let out = await send(true)
  // 400/422 usually means this model or plan will not take a json_schema — the
  // prompt still demands strict JSON, so try once more unconstrained.
  if (schema && (out.status === 400 || out.status === 422)) out = await send(false)
  return { text: out.text, error: out.error, status: out.status }
}

const DISCOVERY_SCHEMA = {
  type: 'object',
  properties: {
    contests: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          office:     { type: 'string' },
          party:      { type: 'string' },
          candidates: { type: 'array', items: { type: 'string' } },
        },
        required: ['office', 'candidates'],
      },
    },
  },
  required: ['contests'],
}

const RESULTS_SCHEMA = {
  type: 'object',
  properties: {
    contests: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          office: { type: 'string' },
          candidates: {
            type: 'array',
            items: {
              type: 'object',
              properties: { name: { type: 'string' }, votes: { type: 'integer' } },
              required: ['name', 'votes'],
            },
          },
          precincts_reporting: { type: 'integer' },
          precincts_total:     { type: 'integer' },
          source:              { type: 'string' },
        },
        required: ['office', 'candidates', 'source'],
      },
    },
  },
  required: ['contests'],
}

function discoveryPrompt(election) {
  return [
    `Tonight is the ${election.name || 'Wisconsin election'} in Wisconsin, held ${election.election_date}.`,
    '',
    'List the STATEWIDE contests that were actually on tonight\'s ballot. In a partisan primary each',
    'party\'s primary is its own contest — for example "Governor — Democratic Primary" and',
    '"Governor — Republican Primary". Cover only the statewide offices genuinely on this ballot,',
    'which may include Governor, Attorney General, Secretary of State, State Treasurer and',
    'U.S. Senate. Omit any office that is not on the ballot this year.',
    '',
    'For each contest, list every candidate whose name appears on the ballot, spelled exactly as it',
    'is printed there.',
    '',
    'Rules:',
    '- Use only ballot information published by the Wisconsin Elections Commission, county clerks or',
    '  established news coverage of this election. Do not guess.',
    '- If you cannot confirm a contest or its full candidate list from a published source, omit it.',
    '- Never invent a contest, an office or a candidate.',
    '',
    'Return strict JSON in exactly this shape and nothing else:',
    '{"contests":[{"office":"Governor — Democratic Primary","party":"Democratic","candidates":["Full Name","Full Name"]}]}',
  ].join('\n')
}

function resultsPrompt(election, contests) {
  const list = contests.map((c, i) => contestLine(c, i)).join('\n')

  return [
    `Wisconsin ${election.name || 'election'}, ${election.election_date}. Report the CURRENT UNOFFICIAL`,
    'vote totals for each contest below, exactly as they are published right now by county clerks, the',
    'Wisconsin Elections Commission, the Associated Press, or Wisconsin news outlets carrying those',
    'returns.',
    '',
    'Contests:',
    list,
    '',
    'Rules — these are absolute:',
    '- Report ONLY numbers a source has already published. Do NOT estimate, project, model,',
    '  extrapolate, interpolate or round any figure. Copy the published number exactly.',
    '- If no numbers have been published yet for a contest, OMIT that contest entirely. An omitted',
    '  contest is correct; a guessed number is not.',
    '- Every contest you return MUST carry the source you took its numbers from (clerk site, wire',
    '  service or outlet name, with the URL if you have it). No source, no contest.',
    '- Vote counts are whole numbers with no separators. Precincts reporting can never exceed',
    '  precincts total. Use the candidate spellings listed above wherever they match.',
    '- Match the EXACT district number and county shown above. District 8 and District 85 are',
    '  different contests, and the same office exists in many counties — never merge or substitute',
    '  one for another. Echo the office string back exactly as it is written above.',
    '- Do not decide, call or project a winner. You are reporting counts only.',
    '',
    'Return strict JSON in exactly this shape and nothing else:',
    '{"contests":[{"office":"Governor — Democratic Primary","candidates":[{"name":"Full Name","votes":12345}],' +
      '"precincts_reporting":100,"precincts_total":300,"source":"Dane County Clerk (https://…)"}]}',
  ].join('\n')
}

// ── County discovery (manual only) ──────────────────────────────────────────

const COUNTY_SCHEMA = {
  type: 'object',
  properties: {
    contests: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          county:     { type: 'string' },
          office:     { type: 'string' },
          party:      { type: 'string' },
          candidates: { type: 'array', items: { type: 'string' } },
          source:     { type: 'string' },
        },
        required: ['county', 'office', 'party', 'candidates', 'source'],
      },
    },
  },
  required: ['contests'],
}

/** The Nth 12-county slice of Wisconsin's 72 counties, alphabetical. N = 0…5. */
function countyChunk(n) {
  const i = Math.floor(Number(n))
  const idx = Number.isFinite(i) ? Math.max(0, Math.min(COUNTY_CHUNKS - 1, i)) : 0
  return WI_COUNTIES.slice(idx * COUNTY_CHUNK_SIZE, (idx + 1) * COUNTY_CHUNK_SIZE)
}

function countyDiscoveryPrompt(election, counties) {
  return [
    `Wisconsin ${election.name || 'election'}, held ${election.election_date}.`,
    '',
    'For each of the counties listed below, report ONLY the CONTESTED PARTISAN COUNTY-OFFICE',
    'primaries that are actually on this ballot.',
    '',
    'Counties to check (and no others):',
    counties.map(c => `- ${c} County`).join('\n'),
    '',
    `County offices in scope, and nothing else: ${COUNTY_OFFICES.join(', ')}.`,
    '',
    'Definitions:',
    '- "Contested" means TWO OR MORE candidates appear on the ballot in the SAME party\'s primary for',
    '  the same county office. One candidate in a party primary is NOT contested — omit it.',
    '- Each party\'s primary for an office is its own contest. If both parties have a contested',
    '  primary for the same office, return two entries.',
    '',
    'Rules — these are absolute:',
    '- MOST WISCONSIN COUNTIES HAVE NO CONTESTED PARTISAN COUNTY PRIMARY on this ballot. Omitting a',
    '  county is the normal, correct answer. Returning an empty list is a valid and expected reply.',
    '- Never invent a county, an office, a primary or a candidate. If you cannot confirm a contest',
    '  and its full candidate list from a published source, omit it.',
    '- Use only ballot information published by the county clerk, the Wisconsin Elections Commission,',
    '  or established news coverage of this election. Do not reason from past elections.',
    '- Candidate names spelled exactly as they are printed on the ballot.',
    '- Every contest you return MUST carry the source you took it from (county clerk site, WEC, or',
    '  outlet name, with the URL if you have it). No source, no contest.',
    '- Report ballot lines only. No vote totals, no winners, no projections, no predictions.',
    '',
    'Return strict JSON in exactly this shape and nothing else:',
    '{"contests":[{"county":"Portage","office":"Sheriff","party":"Democratic",' +
      '"candidates":["Full Name","Full Name"],"source":"Portage County Clerk (https://…)"}]}',
    'If none of these counties has a contested partisan county primary, return exactly {"contests":[]}.',
  ].join('\n')
}

/** "Democrat" → "Democratic Primary"; anything else keeps its own adjective. */
function primaryLabel(party) {
  const p = PARTY_LABEL(party)
  if (p === 'Democrat') return 'Democratic'
  return p || ''
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Strip the county name, party adjective and "Primary" tail off a reported office. */
function countyOfficeCore(rawOffice, county) {
  let s = String(rawOffice == null ? '' : rawOffice).trim()
  s = s.split(/\s+[—–]\s+|\s+-\s+/)[0].trim()                 // drop a "— Democratic Primary" tail
  s = s.replace(new RegExp(`^${escapeRe(county)}\\s+County\\s+`, 'i'), '').trim()
  s = s.replace(/\s+Primary$/i, '').trim()
  s = s.replace(/^(Democratic|Democrat|Republican|GOP)\s+/i, '').trim()
  const want = normName(s)
  // Only the offices Wisconsin actually elects on a partisan county ballot.
  const canonical = COUNTY_OFFICES.find(o => {
    const n = normName(o)
    return n === want || want === n.replace(/^county /, '') || `county ${want}` === n
  })
  return canonical || null
}

/**
 * Shape a county-discovery reply into contest rows. PURE — never throws, never
 * invents. Anything the model returned that is out of slice, off the office
 * whitelist, uncontested or unsourced is dropped and explained in `notes`.
 *
 * @param {*} parsed            already-parsed JSON from the model
 * @param {string[]} counties   the 12 counties this call was allowed to answer for
 * @returns {{contests:Array, notes:string[]}}
 */
function shapeCountyContests(parsed, counties = []) {
  const notes = []
  const allowed = new Map((Array.isArray(counties) ? counties : []).map(c => [normName(c), c]))
  const rows = contestArrayFrom(parsed)
  if (!rows) {
    notes.push('County discovery JSON was unparseable — nothing created (never guessing).')
    return { contests: [], notes }
  }

  const out = []
  const seen = new Set()
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue

    const countyKey = normName(String(raw.county || '').replace(/\s+county$/i, ''))
    const county = allowed.get(countyKey)
    if (!county) {
      notes.push(`Discovery returned "${raw.county}", which is not in this chunk's county list — skipped.`)
      continue
    }

    const office = countyOfficeCore(raw.office, county)
    if (!office) {
      notes.push(`${county} County: "${raw.office}" is not a partisan county office Wisconsin elects — skipped.`)
      continue
    }

    const adjective = primaryLabel(raw.party)
    if (!adjective) {
      notes.push(`${county} County ${office}: no party given for the primary — skipped.`)
      continue
    }

    const source = typeof raw.source === 'string' ? raw.source.trim() : ''
    if (!source) {
      notes.push(`${county} County ${office} — ${adjective} Primary: no source cited — skipped.`)
      continue
    }

    const nameSeen = new Set()
    const candidates = (Array.isArray(raw.candidates) ? raw.candidates : [])
      .map(n => (typeof n === 'string' ? n : n && n.name))
      .filter(n => typeof n === 'string' && n.trim())
      .map(n => n.trim().slice(0, 150))
      .filter(n => { const k = normName(n); if (!k || nameSeen.has(k)) return false; nameSeen.add(k); return true })

    if (candidates.length < 2) {
      notes.push(`${county} County ${office} — ${adjective} Primary: ${candidates.length} candidate(s), so not a contested primary — skipped.`)
      continue
    }

    // "County Treasurer" + "Milwaukee County " would read "Milwaukee County
    // County Treasurer" — the county name already supplies the word.
    const suffix = office.replace(/^County\s+/i, '')
    const label = `${county} County ${suffix} — ${adjective} Primary`.slice(0, 200)
    const key = normName(label)
    if (seen.has(key)) {
      notes.push(`${label}: reported twice in one reply — kept once.`)
      continue
    }
    seen.add(key)
    out.push({ office: label, county, office_type: 'county', party: PARTY_LABEL(raw.party), candidates, source })
  }
  return { contests: out, notes }
}

/** Both shapes we accept back: a bare array, or { contests: [...] }. */
function contestArrayFrom(parsed) {
  if (Array.isArray(parsed)) return parsed
  if (parsed && Array.isArray(parsed.contests)) return parsed.contests
  if (parsed && Array.isArray(parsed.results))  return parsed.results
  return null
}

// ─────────────────────────────────────────────────────────────────────────────
// Contest matching + write helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Does a reported office string agree with a stored contest's district and
 * county? A district is compared as a STANDALONE number — "District 8" must not
 * be satisfied by "District 85", which is a different race entirely and the one
 * way a loose match can quietly write one contest's numbers into another.
 * PURE.
 */
function districtCountyAgree(reportedOffice, contest = {}) {
  const office = String(reportedOffice == null ? '' : reportedOffice)
  const norm = normName(office)

  const district = contest.district ? String(contest.district).trim() : ''
  if (district) {
    const num = (district.match(/\d+/) || [])[0]
    if (num) {
      // \d-boundary, not \b: \b8\b happily matches the "8" inside "85".
      if (!new RegExp(`(?:^|\\D)${num}(?:\\D|$)`).test(office)) return false
    } else if (!norm.includes(normName(district))) {
      return false
    }
  }

  const county = contest.county ? String(contest.county).trim() : ''
  if (county && !norm.includes(normName(county))) return false

  return true
}

/**
 * Match a reported office string to a stored contest; unique matches only.
 * An EXACT (normalized) name match is taken as-is. A loose substring match has
 * to survive the district/county cross-check above.
 */
function matchContest(office, contests) {
  const want = normName(office)
  if (!want) return null
  const list = Array.isArray(contests) ? contests : []
  const exact = list.filter(c => normName(c.office) === want)
  if (exact.length === 1) return exact[0]
  if (exact.length > 1) return null
  const loose = list.filter(c => {
    const have = normName(c.office)
    if (!have || !(have.includes(want) || want.includes(have))) return false
    return districtCountyAgree(office, c)
  })
  return loose.length === 1 ? loose[0] : null
}

// Canonicalize through the shared vocabulary (netlify/functions/_party.js).
// The old fallthrough `String(raw).slice(0, 40)` let unrecognized extractor
// text ('D', 'Dem.', 'Democratic Party of WI') straight into
// election_results.party — a column with NO CHECK — which is exactly how the
// dual-spelling AD77 lean bug got seeded. Now: canonical spelling for any
// recognized family; a real minor-party name survives (trimmed, capped) only
// when it doesn't resolve to a family; junk single letters resolve via
// partyGroup ('d' → 'Democrat').
const PARTY_LABEL = (raw) => {
  const s = String(raw ?? '').trim()
  if (!s) return null
  if (s.toLowerCase() === 'np') return 'Nonpartisan' // WEC shorthand, pre-existing
  return normalizePartyForDb(s) ?? s.slice(0, 40)
}

const votePct = (votes, total) =>
  total > 0 ? parseFloat(((votes / total) * 100).toFixed(1)) : 0

// ─────────────────────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────────────────────

exports.handler = async (event = {}) => {
  const startedAt = Date.now()
  const headers = { ...cors(), 'Content-Type': 'application/json' }
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' }

  let body = {}
  try { body = JSON.parse(event.body || '{}') || {} } catch { body = {} }

  // ── 1. Guard ─────────────────────────────────────────────────────────────
  // Netlify's scheduler POSTs { next_run: <ISO> }. Anything without it is a
  // human (or a script) and needs an admin JWT.
  const scheduled = Boolean(body && body.next_run)
  let force = false, dryRun = false, discoverCounty = false, countyChunkIndex = 0
  if (!scheduled) {
    const auth = await requireAdmin(event)
    if (auth.errorResponse) return auth.errorResponse
    force  = body.force === true
    dryRun = body.dry_run === true
    // County discovery is an admin sweep, never a scheduled behaviour. It runs
    // whatever the clock says, so it implies force.
    if (body.discover === 'county') {
      discoverCounty = true
      force = true
      countyChunkIndex = Math.max(0, Math.min(COUNTY_CHUNKS - 1, Math.floor(Number(body.chunk) || 0)))
    }
  }

  const now = new Date()
  const clock = clockWindow(now)

  // Cheapest possible exit: wrong time of day, so no DB round-trip, no AI call,
  // no log row. This is the branch that runs ~280 times a day.
  if (!clock.phase && !force) {
    return json(200, { skipped: true, reason: decideWindow(now, []).reason }, headers)
  }

  const sb = serviceClient()
  // ONE deadline for the whole run: AI calls, database writes and the email
  // pass all measure themselves against it, and everything that does not fit
  // is carried to the next cycle rather than killed mid-flight.
  const deadline = startedAt + RUN_BUDGET_MS
  // One 429 closes this gate and the rest of the run stops dispatching.
  const gate = makeRunGate()
  // Counts are DISTINCT rows touched across discovery + update, not the number
  // of write calls — a contest that is bootstrapped and then filled in during
  // the same run is one contest, not two.
  const touched = { contests: new Set(), results: new Set() }
  const runMeta = {
    source: `poller:${scheduled ? 'auto' : 'manual'}${discoverCounty ? ':county-discovery' : ''}${dryRun ? ':dry' : ''}`,
    electionDate: null,
    touched,
    notes: [],
  }

  try {
    // ── 2. Which election? ─────────────────────────────────────────────────
    const ct = clock.ct
    const candidateDates = [ct.date, prevDay(ct.date)]
    if (body.election_date) candidateDates.push(String(body.election_date).slice(0, 10))

    const { data: elections, error: eErr } = await sb
      .from('elections')
      .select('id, name, election_date, type')
      .in('election_date', candidateDates)
      .order('election_date', { ascending: false })
    if (eErr) throw new Error(`elections lookup failed: ${eErr.message}`)

    const decision = decideWindow(now, (elections || []).map(e => e.election_date))
    if (!decision.run && !force) {
      return json(200, { skipped: true, reason: decision.reason }, headers)
    }

    const targetDate = decision.electionDate
      || (body.election_date ? String(body.election_date).slice(0, 10) : null)
      || (elections && elections[0] ? String(elections[0].election_date).slice(0, 10) : null)
    const election = (elections || []).find(e => String(e.election_date).slice(0, 10) === targetDate)
    if (!election) {
      return json(200, {
        skipped: true,
        reason: `Forced run, but no election is on file for ${candidateDates.join(' or ')}.`,
      }, headers)
    }
    runMeta.electionDate = String(election.election_date).slice(0, 10)

    // ── 2c. County discovery (manual sweep) ────────────────────────────────
    // One 12-county Perplexity call, then straight to the audit row. It shares
    // nothing with the results pipeline below and never touches a result total.
    if (discoverCounty) {
      const disc = await discoverCountyContests(sb, election, {
        chunkIndex: countyChunkIndex,
        dryRun,
        deadline: startedAt + COUNTY_DISCOVER_BUDGET_MS,
        touched,
        gate,
      })
      runMeta.notes.push(...disc.notes)
      await writeLog(sb, { ...runMeta, startedAt })
      return json(200, {
        ok: true,
        mode: 'county-discovery',
        dry_run: dryRun,
        chunk: countyChunkIndex,
        chunks_total: COUNTY_CHUNKS,
        counties: disc.counties,
        created: disc.created,
        skipped: disc.skipped,
        election: { id: election.id, name: election.name, election_date: runMeta.electionDate },
        contests_synced: touched.contests.size,
        results_upserted: touched.results.size,
        notes: runMeta.notes,
        duration_ms: Date.now() - startedAt,
      }, headers)
    }

    // ── 2b. Contests + results ─────────────────────────────────────────────
    let contests = await loadContests(sb, election.id)

    // ── 3. Bootstrap (discovery) ───────────────────────────────────────────
    const pastBootstrapTime = clock.phase !== 'peak' || ct.minutes >= BOOTSTRAP_AFTER_MINUTES
    let bootstrappedIds = new Set()
    if (!contests.length && pastBootstrapTime) {
      const boot = await bootstrapContests(sb, election, { dryRun, deadline, touched, gate })
      runMeta.notes.push(...boot.notes)
      bootstrappedIds = boot.contestIds
      if (!dryRun && boot.created) contests = await loadContests(sb, election.id)
    } else if (!contests.length) {
      runMeta.notes.push(`No contests on file and it is only ${pad2(ct.hour)}:${pad2(ct.minute)} CT — discovery waits until 20:30 CT.`)
    }

    // ── 4–6. Tiered update pass ────────────────────────────────────────────
    // The clock decides whether races may be called at all tonight.
    gate.embargo = callEmbargoActive(now, [election.election_date])
    if (gate.embargo) runMeta.notes.push('Call embargo active: no race is auto-called before 10:30 PM CT tonight.')

    // Every contest someone subscribed to refreshes EVERY run, like statewide.
    let prioritySet = new Set()
    try {
      const { data: subRows } = await sb.from('election_subscriptions').select('contest_id')
      prioritySet = new Set((subRows || []).map(r => r.contest_id))
    } catch { /* priority is best-effort */ }

    if (contests.length) {
      const remaining = deadline - Date.now()
      if (remaining < 4000) {
        runMeta.notes.push('Run budget exhausted after discovery — the results pull is deferred to the next cycle.')
      } else {
        const upd = await runTieredUpdates(sb, election, contests, {
          dryRun,
          bootstrappedIds,
          touched,
          ct,
          cadence: decision.cadence || clock.cadence || 'every 5 minutes',
          deadline,
          gate,
          prioritySet,
        })
        runMeta.notes.push(...upd.notes)
      }
    }

    // ── 6b. Per-race subscriber notifications ──────────────────────────────
    // Everything above has already landed in the database, so a notification
    // problem can only cost an email — never a result. notifyContestChanges
    // never throws and does nothing at all when no one is subscribed to any of
    // the contests this run touched. Dry runs write nothing, so they notify
    // nobody.
    let notified = null
    if (!dryRun && touched.contests.size) {
      // Same run deadline, minus the reserve writeLog needs: the notifier stops
      // before starting another subscriber's work rather than being killed
      // between the send and the bookkeeping write.
      notified = await notifyContestChanges(sb, touched.contests, {
        trigger: `poller:${scheduled ? 'auto' : 'manual'}`,
        deadline: deadline - LOG_RESERVE_MS,
      })
      runMeta.notes.push(...notified.notes)
      if (!notified.sent && !notified.failed && notified.subscriptions) {
        runMeta.notes.push(`Notifications: ${notified.subscriptions} subscription(s) checked, nothing worth emailing yet.`)
      }
    }

    // ── 7. Audit row for this ACTIVE run ───────────────────────────────────
    if (gate.rateLimited) {
      runMeta.notes.push('Perplexity rate-limited this run (HTTP 429) — remaining calls were skipped; the next cycle retries.')
    }
    await writeLog(sb, { ...runMeta, startedAt })
    return json(200, {
      ok: true,
      dry_run: dryRun,
      phase: decision.phase,
      rate_limited: gate.rateLimited,
      forced: force && !decision.run,
      election: { id: election.id, name: election.name, election_date: runMeta.electionDate },
      contests_synced: touched.contests.size,
      results_upserted: touched.results.size,
      emails_sent: notified ? notified.sent : 0,
      notifications: notified
        ? { sent: notified.sent, failed: notified.failed, skipped: notified.skipped, subscriptions: notified.subscriptions }
        : null,
      notes: runMeta.notes,
      duration_ms: Date.now() - startedAt,
    }, headers)
  } catch (e) {
    // ── 8. Resilience: never 500 on a schedule ─────────────────────────────
    console.error('[election-results-poller]', e && e.message)
    runMeta.notes.push(`FATAL: ${e && e.message ? e.message : String(e)}`)
    await writeLog(sb, { ...runMeta, startedAt })
    return json(200, { ok: false, error: e && e.message ? e.message : 'poller failed', notes: runMeta.notes }, headers)
  }
}

// ── loaders ─────────────────────────────────────────────────────────────────

async function loadContests(sb, electionId) {
  const { data: contests, error } = await sb
    .from('election_contests')
    // district + county come along so the chunk prompts can target a single
    // race — "Assembly District 8" and "Assembly District 85" are otherwise
    // one substring apart, and a county office exists 72 times over.
    .select('id, office, office_type, district, county, seats, precincts_total, precincts_rptg, status, status_source')
    .eq('election_id', electionId)
  if (error) throw new Error(`contest load failed: ${error.message}`)
  const list = contests || []
  if (!list.length) return list

  // FK-JOIN, never a 250-id .in(): a November general carries 400+ contests and
  // an .in() of that many uuids is a ~16KB request URL, which the gateway will
  // refuse. Filtering through the join keeps the URL constant-sized.
  const { data: results, error: rErr } = await sb
    .from('election_results')
    .select('*, election_contests!inner(election_id)')
    .eq('election_contests.election_id', electionId)
  if (rErr) throw new Error(`results load failed: ${rErr.message}`)

  // Strip the joined key back off so downstream sees exactly the row shape it
  // saw before the join.
  const rows = (results || []).map((r) => {
    if (!r || typeof r !== 'object') return r
    const { election_contests, ...rest } = r
    return rest
  })

  for (const c of list) c._results = rows.filter(r => r && r.contest_id === c.id)
  return list
}

// ── 3. discovery ────────────────────────────────────────────────────────────

async function bootstrapContests(sb, election, { dryRun, deadline, touched, gate = null }) {
  const notes = []
  const out = { created: 0, candidates: 0, contestIds: new Set(), notes }

  const budget = deadline - Date.now()
  if (budget < 5000) {
    notes.push('No time budget left for contest discovery — skipped.')
    return out
  }

  const { text, error } = await queryPerplexity({
    system: EXTRACTOR_SYSTEM,
    user: discoveryPrompt(election),
    schema: DISCOVERY_SCHEMA,
    maxTokens: 1500,
    timeoutMs: Math.min(budget - 2000, 12000),
    gate,
  })
  if (error || !text) {
    notes.push(`Contest discovery returned nothing (${error || 'empty reply'}) — no contests created.`)
    return out
  }

  const parsed = contestArrayFrom(parseJsonLoose(text))
  if (!parsed) {
    notes.push('Contest discovery JSON was unparseable — no contests created (never guessing).')
    return out
  }

  for (const c of parsed) {
    const office = c && typeof c.office === 'string' ? c.office.trim().slice(0, 200) : ''
    const names = Array.isArray(c && c.candidates)
      ? c.candidates
          .map(n => (typeof n === 'string' ? n : n && n.name))
          .filter(n => typeof n === 'string' && n.trim())
          .map(n => n.trim().slice(0, 150))
      : []
    if (!office || !names.length) {
      notes.push('Discovery returned a contest without an office or candidates — skipped.')
      continue
    }
    if (dryRun) {
      notes.push(`[dry run] would create "${office}" with ${names.length} candidate(s).`)
      out.created += 1
      out.candidates += names.length
      touched.contests.add(`office:${normName(office)}`)
      for (const n of names) touched.results.add(`office:${normName(office)}::${normName(n)}`)
      continue
    }

    const { data: rows, error: cErr } = await sb.from('election_contests').insert({
      election_id: election.id,
      office,
      office_type: 'statewide',
      seats: 1,
      status: 'waiting',
      status_source: 'auto',
      precincts_total: 0,
      precincts_rptg: 0,
    }).select('id')
    if (cErr || !rows || !rows.length) {
      notes.push(`Could not create contest "${office}": ${cErr ? cErr.message : 'no row returned'}`)
      continue
    }
    const contestId = rows[0].id
    out.contestIds.add(contestId)
    out.created += 1
    touched.contests.add(contestId)

    const party = PARTY_LABEL(c.party)
    const seen = new Set()
    const resultRows = names.filter(n => {
      const k = normName(n)
      if (!k || seen.has(k)) return false
      seen.add(k)
      return true
    }).map(n => ({ contest_id: contestId, candidate_name: n, party, votes: 0, vote_pct: 0 }))

    const { error: rErr } = await sb.from('election_results')
      .upsert(resultRows, { onConflict: 'contest_id,candidate_name' })
    if (rErr) {
      notes.push(`Contest "${office}" created, but its candidate rows failed: ${rErr.message}`)
    } else {
      out.candidates += resultRows.length
      for (const r of resultRows) touched.results.add(`${contestId}::${normName(r.candidate_name)}`)
    }
  }

  if (out.created) notes.push(`Discovery created ${out.created} contest(s) with ${out.candidates} candidate row(s).`)
  return out
}

// ── 3b. county discovery (manual sweep) ─────────────────────────────────────

/**
 * ONE Perplexity call covering 12 Wisconsin counties, asking only for contested
 * partisan county-office primaries. Creates office_type='county' contests with
 * the county field set and offices like "Portage County Sheriff — Democratic
 * Primary". Existing offices are never duplicated and never overwritten.
 */
async function discoverCountyContests(sb, election, { chunkIndex, dryRun, deadline, touched, gate = null }) {
  const notes = []
  const counties = countyChunk(chunkIndex)
  const out = { counties, created: [], skipped: [], notes }

  const budget = deadline - Date.now()
  if (budget < 5000) {
    notes.push('No time budget left for county discovery — nothing attempted.')
    return out
  }

  const { text, error } = await queryPerplexity({
    system: EXTRACTOR_SYSTEM,
    user: countyDiscoveryPrompt(election, counties),
    schema: COUNTY_SCHEMA,
    maxTokens: 2000,
    timeoutMs: Math.min(budget - 2000, 20000),
    gate,
  })
  if (error || !text) {
    notes.push(`County discovery chunk ${chunkIndex} (${counties[0]}–${counties[counties.length - 1]}) returned nothing (${error || 'empty reply'}) — no contests created.`)
    return out
  }

  const shaped = shapeCountyContests(parseJsonLoose(text), counties)
  notes.push(...shaped.notes)
  if (!shaped.contests.length) {
    notes.push(`County discovery chunk ${chunkIndex} (${counties[0]}–${counties[counties.length - 1]}): no contested partisan county primaries found — that is the normal answer.`)
    return out
  }

  // Whatever is already on file for this election wins — discovery only adds.
  const { data: existing, error: exErr } = await sb
    .from('election_contests')
    .select('id, office')
    .eq('election_id', election.id)
  if (exErr) {
    notes.push(`County discovery could not read the existing contest list (${exErr.message}) — nothing created.`)
    return out
  }
  const onFile = new Set((existing || []).map(c => normName(c.office)))

  for (const c of shaped.contests) {
    if (onFile.has(normName(c.office))) {
      out.skipped.push(c.office)
      notes.push(`${c.office}: already on file — left alone.`)
      continue
    }
    onFile.add(normName(c.office))

    if (dryRun) {
      notes.push(`[dry run] would create "${c.office}" (${c.county} County) with ${c.candidates.length} candidate(s), source: ${c.source}.`)
      out.created.push({ office: c.office, county: c.county, candidates: c.candidates, source: c.source })
      touched.contests.add(`office:${normName(c.office)}`)
      for (const n of c.candidates) touched.results.add(`office:${normName(c.office)}::${normName(n)}`)
      continue
    }

    const { data: rows, error: cErr } = await sb.from('election_contests').insert({
      election_id: election.id,
      office: c.office,
      office_type: 'county',
      county: c.county,
      seats: 1,
      status: 'waiting',
      status_source: 'auto',
      precincts_total: 0,
      precincts_rptg: 0,
    }).select('id')
    if (cErr || !rows || !rows.length) {
      notes.push(`Could not create contest "${c.office}": ${cErr ? cErr.message : 'no row returned'}`)
      continue
    }
    const contestId = rows[0].id
    touched.contests.add(contestId)

    const resultRows = c.candidates.map(n => ({
      contest_id: contestId, candidate_name: n, party: c.party, votes: 0, vote_pct: 0,
    }))
    const { error: rErr } = await sb.from('election_results')
      .upsert(resultRows, { onConflict: 'contest_id,candidate_name' })
    if (rErr) {
      notes.push(`Contest "${c.office}" created, but its candidate rows failed: ${rErr.message}`)
    } else {
      for (const r of resultRows) touched.results.add(`${contestId}::${normName(r.candidate_name)}`)
    }
    out.created.push({ id: contestId, office: c.office, county: c.county, candidates: c.candidates, source: c.source })
  }

  notes.push(`County discovery chunk ${chunkIndex}/${COUNTY_CHUNKS - 1} (${counties[0]}–${counties[counties.length - 1]}): created ${out.created.length}, already on file ${out.skipped.length}.`)
  return out
}

// ── 4–6. the tiered update pass ─────────────────────────────────────────────

/**
 * Tier 1 (statewide) every run, then up to TIER2_MAX_CALLS rotating chunks of
 * everything else — stopping early whenever less than CHUNK_MIN_BUDGET_MS of
 * the run budget is left, so the audit row always gets written.
 */
async function runTieredUpdates(sb, election, contests, opts) {
  const { dryRun, bootstrappedIds, touched, ct, cadence, deadline, gate = null } = opts
  const notes = []
  const out = { contests: 0, results: 0, calls: 0, deferred: 0, notes }

  const call = async (list, label, timeoutCap = 20000) => {
    const remaining = deadline - Date.now()
    if (remaining < CHUNK_MIN_BUDGET_MS) {
      notes.push(`${label}: only ${Math.max(0, remaining)}ms of the run budget left — deferred to the next cycle.`)
      return false
    }
    const upd = await updatePass(sb, election, list, {
      dryRun, bootstrappedIds, touched, deadline, gate,
      timeoutMs: Math.min(remaining - 2000, timeoutCap),
    })
    notes.push(...upd.notes)
    out.contests += upd.contests
    out.results  += upd.results
    out.deferred += upd.deferred
    out.calls    += 1
    return true
  }

  // ── Tier 1 — statewide + every contest someone subscribed to, every run ──
  // Runs CONCURRENTLY with the tier-2 chunks (v1.27.3): wall time for a full
  // cycle is one Perplexity round-trip, not four, which is what makes a real
  // 5-minute statewide refresh fit inside the budget.
  const priority = opts.prioritySet instanceof Set ? opts.prioritySet : new Set()
  const tierOne = contests.filter(c => isTierOne(c) || priority.has(c.id))
  const parallel = []
  if (tierOne.length) {
    parallel.push(call(tierOne, `Tier 1 (${tierOne.length} statewide/subscribed contest(s))`, TIER1_TIMEOUT_MS))
  }

  // ── Tier 2 — rotating chunks of everything else ───────────────────────────
  // The queue is the UNFILTERED tier-2 field, so chunk membership is stable for
  // the night; decided contests are dropped inside their chunk, for free.
  const queue = tierTwoQueue(contests)
  const parked = queue.filter(doneCounting).length
  if (!queue.length) return out
  if (parked === queue.length) {
    notes.push(`Tier 2: all ${parked} down-ballot contest(s) are fully counted — nothing left to rotate.`)
    return out
  }

  const rot = selectRotationChunks(queue, ct, { cadence, size: TIER2_CHUNK_SIZE, maxCalls: TIER2_MAX_CALLS })
  notes.push(
    `Tier 2 rotation: chunk(s) ${rot.indices.join(', ')} of ${rot.nChunks} ` +
    `(${queue.length} contest(s) in the stable rotation${parked ? `, ${parked} parked as decided` : ''}, ` +
    `full sweep every ${Math.ceil(rot.nChunks / Math.max(1, rot.indices.length))} run(s)).`
  )

  let stagger = 0
  for (let i = 0; i < rot.selected.length; i++) {
    const list = rot.selected[i].filter(c => !priority.has(c.id)) // already covered in tier 1 this run
    if (!list.length) continue   // every contest in this chunk is already covered or fully counted
    const delay = stagger; stagger += 800 // spread call starts so we do not burst past the rate limit
    parallel.push((async () => {
      if (delay) await new Promise(res => setTimeout(res, delay))
      return call(list, `Tier 2 chunk ${rot.indices[i]}/${rot.nChunks - 1} (${list.length} contest(s))`)
    })())
  }
  await Promise.all(parallel)
  return out
}

async function updatePass(sb, election, contests, { dryRun, bootstrappedIds, touched, timeoutMs, deadline = null, gate = null }) {
  const notes = []
  const out = { contests: 0, results: 0, deferred: 0, notes }

  const { text, error } = await queryPerplexity({
    system: EXTRACTOR_SYSTEM,
    user: resultsPrompt(election, contests),
    schema: RESULTS_SCHEMA,
    // Roomy enough that an 8-contest chunk comes back whole; if it still gets
    // cut off, parseContestsLoose salvages the contests that did arrive.
    maxTokens: 4000,
    timeoutMs,
    gate,
  })
  if (error || !text) {
    notes.push(`Results pull returned nothing (${error || 'empty reply'}) — nothing written.`)
    return out
  }
  const { contests: reported, salvaged } = parseContestsLoose(text)
  if (!reported) {
    notes.push('Results JSON was unparseable — nothing written (never guessing).')
    return out
  }
  if (salvaged) {
    notes.push(`Results reply was truncated — salvaged ${reported.length} complete contest object(s); the rest wait for the next pass.`)
  }

  const deferredOffices = []
  for (const payload of reported) {
    // Deadline-aware WRITES: everything already written has landed, and the
    // contests we do not reach are picked up by the next run.
    if (deadline && !dryRun && deadline - Date.now() < WRITE_MIN_BUDGET_MS) {
      deferredOffices.push(String((payload && payload.office) || 'unnamed contest'))
      continue
    }
    const contest = matchContest(payload && payload.office, contests)
    if (!contest) {
      notes.push(`Reported contest "${payload && payload.office}" does not match any contest on file — skipped.`)
      continue
    }
    const roster = contest._results || []
    const verdict = validateContestUpdate(payload, {
      office: contest.office,
      results: roster,
      precincts_total: contest.precincts_total,
      precincts_rptg: contest.precincts_rptg,
    }, { allowInserts: bootstrappedIds.has(contest.id) || roster.length === 0 })

    notes.push(...verdict.notes)
    if (!verdict.ok) continue

    if (dryRun) {
      notes.push(`[dry run] ${contest.office}: would write ${verdict.updates.length} update(s), ${verdict.inserts.length} insert(s)${verdict.precincts ? `, precincts ${verdict.precincts.precincts_rptg}/${verdict.precincts.precincts_total}` : ''} (source: ${verdict.source}).`)
      out.contests += 1
      out.results  += verdict.updates.length + verdict.inserts.length
      touched.contests.add(contest.id)
      for (const u of verdict.updates) touched.results.add(`${contest.id}::${normName(u.candidate_name)}`)
      for (const i of verdict.inserts) touched.results.add(`${contest.id}::${normName(i.candidate_name)}`)
      continue
    }

    const written = await applyContestUpdate(sb, contest, verdict, notes, { embargo: gate && gate.embargo })
    if (written !== null) {
      out.contests += 1
      out.results  += written.length
      touched.contests.add(contest.id)
      for (const name of written) touched.results.add(`${contest.id}::${normName(name)}`)
    }
  }

  if (deferredOffices.length) {
    out.deferred = deferredOffices.length
    notes.push(
      `Run deadline reached mid-write: ${deferredOffices.length} contest(s) deferred to the next cycle — ` +
      `${deferredOffices.slice(0, 8).join('; ')}${deferredOffices.length > 8 ? '; …' : ''}`
    )
  }
  return out
}

/**
 * Write one validated contest: results upsert (with recomputed vote_pct),
 * precincts, then the determination engine — status only where the contest is
 * still 'auto'. Returns the candidate names written, or null on failure.
 */
async function applyContestUpdate(sb, contest, verdict, notes, opts = {}) {
  const roster = contest._results || []
  // Captured before anything writes: "did this contest just ENTER
  // recount_possible?" is what decides whether stale winner flags come off.
  const previousStatus = contest.status
  const newVotes = new Map(verdict.updates.map(u => [u.id, u.votes]))

  // Merged picture: every row in the contest, carrying the accepted numbers.
  const merged = roster.map(r => ({
    id: r.id,
    candidate_name: r.candidate_name,
    votes: newVotes.has(r.id) ? newVotes.get(r.id) : (toInt(r.votes) || 0),
  })).concat(verdict.inserts.map(i => ({ id: null, candidate_name: i.candidate_name, votes: i.votes })))

  const totalVotes = merged.reduce((s, r) => s + r.votes, 0)

  // vote_pct is recomputed for EVERY row, because the denominator moved.
  const upsertRows = merged.map(r => ({
    contest_id: contest.id,
    candidate_name: r.candidate_name,
    votes: r.votes,
    vote_pct: votePct(r.votes, totalVotes),
  }))

  const { error: uErr } = await sb.from('election_results')
    .upsert(upsertRows, { onConflict: 'contest_id,candidate_name' })
  if (uErr) {
    notes.push(`${contest.office}: results upsert failed — ${uErr.message}`)
    return null
  }

  const precinctsTotal = verdict.precincts ? verdict.precincts.precincts_total : (toInt(contest.precincts_total) || 0)
  const precinctsRptg  = verdict.precincts ? verdict.precincts.precincts_rptg  : (toInt(contest.precincts_rptg)  || 0)
  if (verdict.precincts) {
    const { error: pErr } = await sb.from('election_contests')
      .update({ precincts_rptg: precinctsRptg, precincts_total: precinctsTotal })
      .eq('id', contest.id)
    if (pErr) notes.push(`${contest.office}: precinct update failed — ${pErr.message}`)
  }

  // ── determination engine ────────────────────────────────────────────────
  // Admin-pinned contests still get their numbers; they never get a status.
  if (contest.status_source === 'admin') {
    notes.push(`${contest.office}: numbers updated, status left alone (admin override).`)
    return upsertRows.map(r => r.candidate_name)
  }

  let { status, detail } = determineStatus({
    results: merged,
    precinctsTotal,
    precinctsRptg,
    seats: contest.seats,
  })
  // Election-night embargo: the clock, not the data, is allowed to call races.
  if (status === 'called' && opts.embargo) {
    detail = { ...(detail || {}), embargoed_call: true,
      reason: `${(detail && detail.reason) || ''} Call withheld — no race is called before 10:30 PM CT on election night.`.trim() }
    status = 'reporting'
    notes.push(`${contest.office}: engine result was 'called' — withheld under the 10:30 PM CT embargo.`)
  }
  const { error: sErr } = await sb.from('election_contests').update({
    status,
    status_detail: detail,
    status_updated_at: new Date().toISOString(),
  }).eq('id', contest.id)
  if (sErr) notes.push(`${contest.office}: status write failed — ${sErr.message}`)

  // Mirror the math onto the rows exactly as admin-elections does: winner flags
  // ONLY on a called contest with a real margin, and `declared` is NEVER
  // touched — declaring a winner stays an admin action.
  const action = winnerFlagAction(status, previousStatus, detail)
  if (action === 'apply') {
    const { data: rows } = await sb.from('election_results')
      .select('id, votes').eq('contest_id', contest.id)
    await applyWinnerFlags(sb, rows || [], contest.seats || 1)
  } else if (action === 'clear') {
    // The race just entered recount_possible: nobody has won it, so any green
    // "Winner" left over from an earlier pass has to come off the board.
    await clearWinnerFlags(sb, contest.id)
    notes.push(`${contest.office}: entered recount_possible — winner flags cleared (nobody has won this race).`)
  }

  return upsertRows.map(r => r.candidate_name)
}

/**
 * What should happen to the rows' winner flags, given the engine's new status
 * and the status the contest carried before? PURE.
 *
 *   'apply' — status is 'called' with a real margin: flag the top N
 *   'clear' — the contest just ENTERED recount_possible: strip stale flags
 *   'none'  — leave the rows alone
 *
 * 'recount_possible' deliberately does NOT flag a winner: the engine is
 * refusing to call the race, so the board must not paint anyone green.
 */
function winnerFlagAction(status, previousStatus = null, detail = null) {
  if (status === 'called' && detail && detail.margin > 0) return 'apply'
  if (status === 'recount_possible' && previousStatus !== 'recount_possible') return 'clear'
  return 'none'
}

async function applyWinnerFlags(sb, results, seats) {
  const ranked  = [...results].sort((a, b) => (b.votes || 0) - (a.votes || 0))
  const winners = ranked.slice(0, Math.max(1, seats)).filter(r => (r.votes || 0) > 0).map(r => r.id)
  if (!winners.length) return
  const losers = ranked.map(r => r.id).filter(id => !winners.includes(id))
  await sb.from('election_results').update({ winner: true }).in('id', winners)
  if (losers.length) await sb.from('election_results').update({ winner: false }).in('id', losers)
}

/** Take winner=true off every row in a contest. One statement, no id list. */
async function clearWinnerFlags(sb, contestId) {
  const { error } = await sb.from('election_results')
    .update({ winner: false }).eq('contest_id', contestId).eq('winner', true)
  if (error) console.warn('[election-results-poller] winner-flag clear failed:', error.message)
}

// ── 7. the audit row ────────────────────────────────────────────────────────

/**
 * The `error` column is for things that went WRONG — a healthy run must leave
 * it null, or "error is not null" reads as a 100% failure rate. Only fatals,
 * quarantines and work that was skipped/deferred qualify; the running commentary
 * lives in the JSON response. PURE.
 */
function fatalNotesOnly(notes) {
  return (Array.isArray(notes) ? notes : []).filter((n) => {
    const s = String(n == null ? '' : n)
    return /^\s*FATAL/.test(s) || /quarantin/i.test(s) || /skipped/i.test(s) || /deferred/i.test(s)
  })
}

async function writeLog(sb, { source, electionDate, touched, notes, startedAt }) {
  try {
    const bad = fatalNotesOnly(notes)
    const error = bad.length ? bad.join(' | ').slice(0, 4000) : null
    await sb.from('election_poller_log').insert({
      source,
      election_date: electionDate || null,
      contests_synced: touched ? touched.contests.size : 0,
      results_upserted: touched ? touched.results.size : 0,
      error,
      duration_ms: Date.now() - startedAt,
    })
  } catch (e) {
    console.warn('[election-results-poller] poller-log write failed:', e.message)
  }
}

module.exports.decideWindow          = decideWindow
// I/O halves, exported so the write path can be unit-tested against a mock client
module.exports.loadContests          = loadContests
module.exports.updatePass            = updatePass
module.exports.applyWinnerFlags      = applyWinnerFlags
module.exports.clearWinnerFlags      = clearWinnerFlags
module.exports.clockWindow           = clockWindow
module.exports.ctParts               = ctParts
module.exports.validateContestUpdate = validateContestUpdate
module.exports.matchCandidate        = matchCandidate
module.exports.matchContest          = matchContest
module.exports.districtCountyAgree   = districtCountyAgree
module.exports.parseJsonLoose        = parseJsonLoose
module.exports.salvageJsonObjects    = salvageJsonObjects
module.exports.parseContestsLoose    = parseContestsLoose
module.exports.queryPerplexity       = queryPerplexity
module.exports.makeRunGate           = makeRunGate
module.exports.winnerFlagAction      = winnerFlagAction
module.exports.callEmbargoActive     = callEmbargoActive
module.exports.doneCounting          = doneCounting
module.exports.fatalNotesOnly        = fatalNotesOnly
module.exports.MAX_TOTAL_VOTES       = MAX_TOTAL_VOTES
module.exports.RUN_BUDGET_MS         = RUN_BUDGET_MS
module.exports.TIER1_TIMEOUT_MS      = TIER1_TIMEOUT_MS

// full-ballot tiering (pure, unit-tested)
module.exports.chunkList             = chunkList
module.exports.tierTwoQueue          = tierTwoQueue
module.exports.assignChunks          = assignChunks
module.exports.orderChunk            = orderChunk
module.exports.chunkIndexOf          = chunkIndexOf
module.exports.selectRotationChunks  = selectRotationChunks
module.exports.rotationTick          = rotationTick
module.exports.contestLine           = contestLine
module.exports.countyChunk           = countyChunk
module.exports.countyDiscoveryPrompt = countyDiscoveryPrompt
module.exports.shapeCountyContests   = shapeCountyContests
module.exports.WI_COUNTIES           = WI_COUNTIES
module.exports.COUNTY_CHUNKS         = COUNTY_CHUNKS
module.exports.TIER2_CHUNK_SIZE      = TIER2_CHUNK_SIZE
module.exports.TIER2_MAX_CALLS       = TIER2_MAX_CALLS
