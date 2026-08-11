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
//   4. Update       ONE batched Perplexity call for current unofficial totals.
//   5. Validate     every number, before anything is written (see
//                   validateContestUpdate) — failures are quarantined, noted
//                   in the log row's `error` field, and never written.
//   6. Write        upsert results → recompute vote_pct → precincts →
//                   determineStatus(), status written ONLY where
//                   status_source = 'auto'. `declared` is never touched.
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
// Exports: handler plus the pure pieces, unit-tested in tests/remediation.test.mjs
//   decideWindow, clockWindow, ctParts, validateContestUpdate, matchCandidate

const { cors, json, serviceClient, requireAdmin } = require('./_shared')
const { determineStatus } = require('./_determination')

const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY
const PPLX_URL   = 'https://api.perplexity.ai/chat/completions'
const PPLX_MODEL = 'sonar'

// Wisconsin's entire electorate casts ~3.3M votes at a presidential general and
// well under 1.5M at a partisan primary. A contest at or above this is a parse
// error or a hallucination, never a real tally.
const MAX_TOTAL_VOTES = 4000000

// Whole-run wall-clock budget. Netlify scheduled functions are short-lived, so
// we stop making network calls before the platform kills us and the audit row
// still gets written.
const RUN_BUDGET_MS = Number(process.env.POLLER_BUDGET_MS) || 24000

// Discovery only makes sense once polls have been closed a while.
const BOOTSTRAP_AFTER_MINUTES = 20 * 60 + 30   // 20:30 CT

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

  let precincts = null
  if (rptg !== null || total !== storedTotal) {
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
 * One Perplexity chat completion. Asks for a JSON schema when one is given and
 * silently retries without it if the API rejects the constraint, because the
 * prompts demand strict JSON on their own too. Never throws.
 */
async function queryPerplexity({ system, user, maxTokens = 2000, schema = null, timeoutMs = 20000 }) {
  if (!PERPLEXITY_API_KEY) return { text: null, error: 'PERPLEXITY_API_KEY is not set' }
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
        headers: { Authorization: `Bearer ${PERPLEXITY_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
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
  return { text: out.text, error: out.error }
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
  const list = contests.map((c, i) => {
    const names = (c._results || []).map(r => r.candidate_name).filter(Boolean)
    return `${i + 1}. ${c.office}${names.length ? ` (candidates on file: ${names.join(', ')})` : ''}`
  }).join('\n')

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
    '- Do not decide, call or project a winner. You are reporting counts only.',
    '',
    'Return strict JSON in exactly this shape and nothing else:',
    '{"contests":[{"office":"Governor — Democratic Primary","candidates":[{"name":"Full Name","votes":12345}],' +
      '"precincts_reporting":100,"precincts_total":300,"source":"Dane County Clerk (https://…)"}]}',
  ].join('\n')
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

/** Match a reported office string to a stored contest; unique matches only. */
function matchContest(office, contests) {
  const want = normName(office)
  if (!want) return null
  const exact = contests.filter(c => normName(c.office) === want)
  if (exact.length === 1) return exact[0]
  if (exact.length > 1) return null
  const loose = contests.filter(c => {
    const have = normName(c.office)
    return have && (have.includes(want) || want.includes(have))
  })
  return loose.length === 1 ? loose[0] : null
}

const PARTY_LABEL = (raw) => {
  const p = normName(raw)
  if (!p) return null
  if (p.startsWith('dem')) return 'Democrat'
  if (p.startsWith('rep') || p.startsWith('gop')) return 'Republican'
  if (p.startsWith('ind')) return 'Independent'
  if (p.startsWith('lib')) return 'Libertarian'
  if (p.startsWith('gre')) return 'Green'
  if (p.startsWith('non') || p === 'np') return 'Nonpartisan'
  return String(raw).slice(0, 40)
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
  let force = false, dryRun = false
  if (!scheduled) {
    const auth = await requireAdmin(event)
    if (auth.errorResponse) return auth.errorResponse
    force  = body.force === true
    dryRun = body.dry_run === true
  }

  const now = new Date()
  const clock = clockWindow(now)

  // Cheapest possible exit: wrong time of day, so no DB round-trip, no AI call,
  // no log row. This is the branch that runs ~280 times a day.
  if (!clock.phase && !force) {
    return json(200, { skipped: true, reason: decideWindow(now, []).reason }, headers)
  }

  const sb = serviceClient()
  // Counts are DISTINCT rows touched across discovery + update, not the number
  // of write calls — a contest that is bootstrapped and then filled in during
  // the same run is one contest, not two.
  const touched = { contests: new Set(), results: new Set() }
  const runMeta = {
    source: `poller:${scheduled ? 'auto' : 'manual'}${dryRun ? ':dry' : ''}`,
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

    // ── 2b. Contests + results ─────────────────────────────────────────────
    let contests = await loadContests(sb, election.id)

    // ── 3. Bootstrap (discovery) ───────────────────────────────────────────
    const pastBootstrapTime = clock.phase !== 'peak' || ct.minutes >= BOOTSTRAP_AFTER_MINUTES
    let bootstrappedIds = new Set()
    if (!contests.length && pastBootstrapTime) {
      const boot = await bootstrapContests(sb, election, { dryRun, deadline: startedAt + RUN_BUDGET_MS, touched })
      runMeta.notes.push(...boot.notes)
      bootstrappedIds = boot.contestIds
      if (!dryRun && boot.created) contests = await loadContests(sb, election.id)
    } else if (!contests.length) {
      runMeta.notes.push(`No contests on file and it is only ${pad2(ct.hour)}:${pad2(ct.minute)} CT — discovery waits until 20:30 CT.`)
    }

    // ── 4–6. Update pass ───────────────────────────────────────────────────
    if (contests.length) {
      const remaining = startedAt + RUN_BUDGET_MS - Date.now()
      if (remaining < 4000) {
        runMeta.notes.push('Run budget exhausted after discovery — the results pull waits for the next cycle.')
      } else {
        const upd = await updatePass(sb, election, contests, {
          dryRun,
          bootstrappedIds,
          touched,
          timeoutMs: Math.min(remaining - 2000, 20000),
        })
        runMeta.notes.push(...upd.notes)
      }
    }

    // ── 7. Audit row for this ACTIVE run ───────────────────────────────────
    await writeLog(sb, { ...runMeta, startedAt })
    return json(200, {
      ok: true,
      dry_run: dryRun,
      phase: decision.phase,
      forced: force && !decision.run,
      election: { id: election.id, name: election.name, election_date: runMeta.electionDate },
      contests_synced: touched.contests.size,
      results_upserted: touched.results.size,
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
    .select('id, office, office_type, seats, precincts_total, precincts_rptg, status, status_source')
    .eq('election_id', electionId)
  if (error) throw new Error(`contest load failed: ${error.message}`)
  const list = contests || []
  if (!list.length) return list

  const { data: results, error: rErr } = await sb
    .from('election_results')
    .select('id, contest_id, candidate_name, votes, party')
    .in('contest_id', list.map(c => c.id))
  if (rErr) throw new Error(`results load failed: ${rErr.message}`)

  for (const c of list) c._results = (results || []).filter(r => r.contest_id === c.id)
  return list
}

// ── 3. discovery ────────────────────────────────────────────────────────────

async function bootstrapContests(sb, election, { dryRun, deadline, touched }) {
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
    timeoutMs: Math.min(budget - 2000, 18000),
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

// ── 4–6. the batched update pass ────────────────────────────────────────────

async function updatePass(sb, election, contests, { dryRun, bootstrappedIds, touched, timeoutMs }) {
  const notes = []
  const out = { contests: 0, results: 0, notes }

  const { text, error } = await queryPerplexity({
    system: EXTRACTOR_SYSTEM,
    user: resultsPrompt(election, contests),
    schema: RESULTS_SCHEMA,
    maxTokens: 2500,
    timeoutMs,
  })
  if (error || !text) {
    notes.push(`Results pull returned nothing (${error || 'empty reply'}) — nothing written.`)
    return out
  }
  const reported = contestArrayFrom(parseJsonLoose(text))
  if (!reported) {
    notes.push('Results JSON was unparseable — nothing written (never guessing).')
    return out
  }

  for (const payload of reported) {
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

    const written = await applyContestUpdate(sb, contest, verdict, notes)
    if (written !== null) {
      out.contests += 1
      out.results  += written.length
      touched.contests.add(contest.id)
      for (const name of written) touched.results.add(`${contest.id}::${normName(name)}`)
    }
  }
  return out
}

/**
 * Write one validated contest: results upsert (with recomputed vote_pct),
 * precincts, then the determination engine — status only where the contest is
 * still 'auto'. Returns the candidate names written, or null on failure.
 */
async function applyContestUpdate(sb, contest, verdict, notes) {
  const roster = contest._results || []
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

  const { status, detail } = determineStatus({
    results: merged,
    precinctsTotal,
    precinctsRptg,
    seats: contest.seats,
  })
  const { error: sErr } = await sb.from('election_contests').update({
    status,
    status_detail: detail,
    status_updated_at: new Date().toISOString(),
  }).eq('id', contest.id)
  if (sErr) notes.push(`${contest.office}: status write failed — ${sErr.message}`)

  // Mirror the math onto the rows exactly as admin-elections does: winner flags
  // on a decided contest with a real margin, and `declared` is NEVER touched —
  // declaring a winner stays an admin action.
  if ((status === 'called' || status === 'recount_possible') && detail && detail.margin > 0) {
    const { data: rows } = await sb.from('election_results')
      .select('id, votes').eq('contest_id', contest.id)
    await applyWinnerFlags(sb, rows || [], contest.seats || 1)
  }

  return upsertRows.map(r => r.candidate_name)
}

async function applyWinnerFlags(sb, results, seats) {
  const ranked  = [...results].sort((a, b) => (b.votes || 0) - (a.votes || 0))
  const winners = ranked.slice(0, Math.max(1, seats)).filter(r => (r.votes || 0) > 0).map(r => r.id)
  if (!winners.length) return
  const losers = ranked.map(r => r.id).filter(id => !winners.includes(id))
  await sb.from('election_results').update({ winner: true }).in('id', winners)
  if (losers.length) await sb.from('election_results').update({ winner: false }).in('id', losers)
}

// ── 7. the audit row ────────────────────────────────────────────────────────

async function writeLog(sb, { source, electionDate, touched, notes, startedAt }) {
  try {
    const error = notes && notes.length ? notes.join(' | ').slice(0, 4000) : null
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
module.exports.clockWindow           = clockWindow
module.exports.ctParts               = ctParts
module.exports.validateContestUpdate = validateContestUpdate
module.exports.matchCandidate        = matchCandidate
module.exports.parseJsonLoose        = parseJsonLoose
module.exports.MAX_TOTAL_VOTES       = MAX_TOTAL_VOTES
