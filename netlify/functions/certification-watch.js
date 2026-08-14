// netlify/functions/certification-watch.js
// ─── Weekly certification watch ──────────────────────────────────────────────
// Netlify Scheduled Function — Thursday 15:00 UTC (see netlify.toml).
//
// After election night the board freezes: every contest sits at 'called' and
// nothing ever moves it to 'certified', so a March election still reads like
// unofficial returns in July. In reality Wisconsin county boards of canvass
// finish and certify roughly two weeks after an election (Wis. Stat. § 7.60),
// and WEC posts the certified canvass after that. This function is the thing
// that notices.
//
// Once a week it:
//   1. finds elections 14–60 days past that still have at least one 'called'
//      contest (14 = the earliest a canvass is plausibly done, 60 = give up and
//      leave it to the admin rather than asking forever);
//   2. asks Perplexity ONE question per election — has the canvass been
//      completed and the results certified? CERTIFIED / NOT_YET / UNCLEAR, with
//      a source URL;
//   3. on a CITED "CERTIFIED", flips every 'called' contest to 'certified'
//      through the SAME writer the admin button uses (./_certify.js), with the
//      source URL recorded in status_detail.reason.
//
// Extractor discipline, identical to election-results-poller.js: temperature 0,
// strict JSON, report-only-what-was-published, and CITATIONS ARE MANDATORY — a
// "CERTIFIED" with no source URL is treated as UNCLEAR and nothing is written.
// NOT_YET / UNCLEAR / uncited simply wait for next Thursday; there is no penalty
// for being a week late and a real one for certifying an election that hasn't
// been.
//
// 'recount_possible' contests are never touched — the engine refused to call
// those races, so they belong to the admin (call_race / set_status). They are
// listed in every run's log so they cannot be quietly forgotten.
//
// Manual HTTP trigger (testing):
//   POST with header x-admin-trigger: ADMIN_TRIGGER_SECRET
//   body { dry_run?: true, election_id?: "<uuid>" }
//
// Every run that actually checks an election writes an election_poller_log row
// with source 'certification-watch'.
//
// Exports: handler plus the pure pieces, unit-tested in tests/remediation.test.mjs
//   shiftDays, certificationWindow, inCertificationWindow,
//   parseCertificationVerdict, certificationPrompt

const nodeCrypto = require('crypto')
const { serviceClient } = require('./_shared')
const { ctParts, queryPerplexity } = require('./election-results-poller')
const { certifyElectionContests } = require('./_certify')

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY

// ── Eligibility window ───────────────────────────────────────────────────────
// A canvass is not plausibly complete before two weeks, and after two months an
// election that still has not shown up as certified is a data problem for a
// human, not something to keep asking an AI about every week.
const CERT_MIN_DAYS = Number(process.env.CERT_WATCH_MIN_DAYS) || 14
const CERT_MAX_DAYS = Number(process.env.CERT_WATCH_MAX_DAYS) || 60

// Whole-run wall-clock budget — one Perplexity call plus the writes per
// election, and the audit rows still get written.
const RUN_BUDGET_MS   = Number(process.env.CERT_WATCH_BUDGET_MS) || 20000
// Never START another election with less than this left.
const PER_ELECTION_MIN_MS = 8000
const PPLX_TIMEOUT_MS = 12000
// More than this in one window means something is wrong upstream; the rest
// carry to next week.
const MAX_ELECTIONS_PER_RUN = 4

const isUuid = (v) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)

/** Constant-time secret compare (same shape as monitoring-digest.js). */
function safeEqual(a, b) {
  const A = nodeCrypto.createHash('sha256').update(String(a ?? '')).digest()
  const B = nodeCrypto.createHash('sha256').update(String(b ?? '')).digest()
  return nodeCrypto.timingSafeEqual(A, B)
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure logic — no I/O, unit-tested
// ─────────────────────────────────────────────────────────────────────────────

const pad2 = (n) => String(n).padStart(2, '0')

/** 'YYYY-MM-DD' shifted by n days. Pure UTC math, no time zone involved. */
function shiftDays(ymd, n) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || ''))
  if (!m) return null
  const t = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + Number(n || 0) * 86400000)
  if (Number.isNaN(t.getTime())) return null
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`
}

/**
 * The inclusive election_date range worth asking about today.
 *   from = today − CERT_MAX_DAYS   (oldest we still chase)
 *   to   = today − CERT_MIN_DAYS   (youngest whose canvass could be done)
 * @returns {{from: string|null, to: string|null}}
 */
function certificationWindow(todayCT, { minDays = CERT_MIN_DAYS, maxDays = CERT_MAX_DAYS } = {}) {
  return { from: shiftDays(todayCT, -maxDays), to: shiftDays(todayCT, -minDays) }
}

/** Is this election inside today's certification window? PURE. */
function inCertificationWindow(electionDate, todayCT, opts = {}) {
  const d = String(electionDate || '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false
  const { from, to } = certificationWindow(todayCT, opts)
  if (!from || !to) return false
  return d >= from && d <= to
}

// A citation is a real http(s) URL and nothing else. "the county clerk's
// website" is not a citation.
const URL_RE = /https?:\/\/[^\s"'<>)\]}]+/i

function firstUrl(s) {
  const m = URL_RE.exec(String(s == null ? '' : s))
  if (!m) return null
  // Trailing sentence punctuation is not part of the URL.
  return m[0].replace(/[.,;:]+$/, '') || null
}

/**
 * Read the certification verdict out of one Perplexity reply.
 *
 * Strict JSON first ({"status":"CERTIFIED","source_url":"https://…"}), then a
 * bare-word fallback for a reply that ignored the format — the same "salvage
 * what was actually said, never guess what wasn't" discipline the poller's
 * parser uses.
 *
 * CITATIONS ARE MANDATORY: `certify` is true only for CERTIFIED **with** a real
 * URL. An uncited CERTIFIED is reported (so the log can say so) but never acted
 * on. PURE.
 *
 * @returns {{verdict:'CERTIFIED'|'NOT_YET'|'UNCLEAR', sourceUrl:string|null,
 *            cited:boolean, certify:boolean, reason:string}}
 */
function parseCertificationVerdict(text) {
  const out = { verdict: 'UNCLEAR', sourceUrl: null, cited: false, certify: false, reason: '' }
  if (!text || typeof text !== 'string' || !text.trim()) {
    out.reason = 'empty reply'
    return out
  }

  let raw = ''
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
  let obj = null
  try { obj = JSON.parse(stripped) } catch {
    const o = stripped.indexOf('{'), c = stripped.lastIndexOf('}')
    if (o >= 0 && c > o) { try { obj = JSON.parse(stripped.slice(o, c + 1)) } catch { obj = null } }
  }
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    raw = String(obj.status ?? obj.verdict ?? obj.answer ?? '')
    out.sourceUrl = firstUrl(obj.source_url ?? obj.sourceUrl ?? obj.url ?? obj.source ?? '')
  }
  if (!raw) {
    // Not JSON (or JSON without a verdict): take the word it actually said.
    const m = /\b(CERTIFIED|NOT[_\s-]?YET|UNCLEAR)\b/i.exec(stripped)
    raw = m ? m[1] : ''
  }
  if (!out.sourceUrl) out.sourceUrl = firstUrl(stripped)

  const norm = raw.toUpperCase().replace(/[\s-]+/g, '_').trim()
  out.verdict = norm === 'CERTIFIED' ? 'CERTIFIED' : norm === 'NOT_YET' ? 'NOT_YET' : 'UNCLEAR'
  out.cited   = Boolean(out.sourceUrl)

  if (out.verdict === 'CERTIFIED' && out.cited) {
    out.certify = true
    out.reason  = `certified per ${out.sourceUrl}`
  } else if (out.verdict === 'CERTIFIED') {
    out.reason = 'CERTIFIED with no source URL — treated as unconfirmed, nothing written'
  } else if (out.verdict === 'NOT_YET') {
    out.reason = 'canvass not complete yet'
  } else {
    out.reason = raw ? `unrecognized verdict "${String(raw).slice(0, 40)}"` : 'no verdict in the reply'
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// Perplexity — one question, extraction only
// ─────────────────────────────────────────────────────────────────────────────

const CERT_EXTRACTOR_SYSTEM =
  'You are an election-records EXTRACTOR for Wisconsin. You report only what an official source ' +
  '(a county clerk, a county board of canvass, or the Wisconsin Elections Commission) or a major ' +
  'news organization has already published. You never estimate, project, infer or reason from how ' +
  'long a canvass usually takes, and you never invent a source or a URL. If certification has not ' +
  'been published, you say so. You reply with strict JSON and nothing else — no prose, no ' +
  'commentary, no markdown fences.'

const CERT_SCHEMA = {
  type: 'object',
  properties: {
    status:     { type: 'string' },
    source_url: { type: 'string' },
    as_of:      { type: 'string' },
  },
  required: ['status'],
}

function certificationPrompt(election) {
  return [
    `Wisconsin ${election.name || 'election'}, held ${election.election_date}.`,
    '',
    'Answer ONE question and nothing else: have the county boards of canvass — and, for statewide',
    'or multi-county offices, the Wisconsin Elections Commission — COMPLETED the canvass of this',
    'election and CERTIFIED the results?',
    '',
    'Answer with exactly one of these values:',
    '- "CERTIFIED" — a published official source states the canvass is complete and the results are certified',
    '- "NOT_YET"   — a published source shows the canvass is still under way or not yet certified',
    '- "UNCLEAR"   — you cannot confirm either way from a published source',
    '',
    'Rules — these are absolute:',
    '- Report only what has ALREADY been published by a county clerk, a county board of canvass, the',
    '  Wisconsin Elections Commission, or established news coverage of this election.',
    '- Never estimate, project or infer. Do not reason from the statutory deadline or from how long',
    '  canvasses usually take. A deadline having passed is NOT certification.',
    '- "CERTIFIED" REQUIRES a source URL you actually have. With no URL, answer "UNCLEAR".',
    '- Do not report vote totals, winners, margins or anything about individual contests.',
    '- If you are not sure, "UNCLEAR" is the correct answer.',
    '',
    'Return strict JSON in exactly this shape and nothing else:',
    '{"status":"CERTIFIED","source_url":"https://…","as_of":"YYYY-MM-DD"}',
  ].join('\n')
}

// ─────────────────────────────────────────────────────────────────────────────
// Audit
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One election_poller_log row per election checked. `error` carries only real
 * problems (an API failure, a refused write, an uncited CERTIFIED) — NOT_YET is
 * the expected answer for most of a run and must not read as a failure rate.
 */
async function logRun(sb, { electionDate, certified, problems, startedAt }) {
  try {
    const bad = (problems || []).filter(Boolean)
    await sb.from('election_poller_log').insert({
      source: 'certification-watch',
      election_date: electionDate || null,
      contests_synced: certified || 0,
      results_upserted: 0,
      error: bad.length ? bad.join(' | ').slice(0, 4000) : null,
      duration_ms: Date.now() - startedAt,
    })
  } catch (e) {
    console.warn('[certification-watch] poller-log write failed:', e.message)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────────────────────

exports.handler = async (event = {}) => {
  const startedAt = Date.now()
  const headers = { 'Content-Type': 'application/json' }

  let body = {}
  try { body = JSON.parse(event.body || '{}') || {} } catch { body = {} }

  // Netlify's scheduler POSTs { next_run: <ISO> } and some runtimes hand a
  // scheduled invocation no httpMethod at all. Anything else is a human and
  // needs the shared trigger secret (same gate as monitoring-digest.js).
  const scheduled = !event.httpMethod || Boolean(body.next_run)
  let opts = {}
  if (!scheduled) {
    const secret   = process.env.ADMIN_TRIGGER_SECRET
    const provided = event.headers?.['x-admin-trigger'] || event.headers?.['X-Admin-Trigger']
    if (!secret || !safeEqual(provided, secret)) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Not authorized' }) }
    }
    opts = body
  }

  // ── Env guards — cheap exits, no DB round-trip, no log row ────────────────
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Missing Supabase configuration' }) }
  }
  if (!process.env.PERPLEXITY_API_KEY) {
    return { statusCode: 200, headers, body: JSON.stringify({
      skipped: true, reason: 'PERPLEXITY_API_KEY is not set — no certification check was attempted',
    }) }
  }

  const dryRun   = opts.dry_run === true
  const deadline = startedAt + RUN_BUDGET_MS
  const sb = serviceClient()
  const todayCT = ctParts().date
  const { from, to } = certificationWindow(todayCT)
  const notes = []
  const summaries = []
  let certifiedTotal = 0

  try {
    let q = sb.from('elections')
      .select('id, name, election_date')
      .gte('election_date', from)
      .lte('election_date', to)
      .order('election_date', { ascending: false })
    if (isUuid(opts.election_id)) q = q.eq('id', opts.election_id)

    const { data: elections, error: eErr } = await q
    if (eErr) throw new Error(`elections lookup failed: ${eErr.message}`)

    if (!elections || !elections.length) {
      // Nothing in the window is the normal weekly answer — no log row for it.
      return { statusCode: 200, headers, body: JSON.stringify({
        ok: true, checked: 0, certified: 0, window: { from, to },
        reason: `No election falls between ${from} and ${to}.`,
      }) }
    }

    for (const election of elections.slice(0, MAX_ELECTIONS_PER_RUN)) {
      if (Date.now() > deadline - PER_ELECTION_MIN_MS) {
        notes.push(`deferred: ran out of run budget before "${election.name}" — it carries to next week.`)
        break
      }
      const electionDate = String(election.election_date).slice(0, 10)
      const problems = []
      let certified = 0

      // Which contests are still open? 'called' is by definition not yet
      // 'certified' — one status column, so no extra filter is needed.
      const { data: contests, error: cErr } = await sb
        .from('election_contests')
        .select('id, office, district, county, status')
        .eq('election_id', election.id)
        .in('status', ['called', 'recount_possible'])
      if (cErr) {
        problems.push(`contest load failed for ${electionDate}: ${cErr.message}`)
        await logRun(sb, { electionDate, certified: 0, problems, startedAt })
        summaries.push({ election: election.name, election_date: electionDate, error: cErr.message })
        continue
      }

      const called  = (contests || []).filter(c => c.status === 'called')
      const recount = (contests || []).filter(c => c.status === 'recount_possible')

      if (!called.length) {
        // Nothing to certify — do not spend a Perplexity call on it.
        notes.push(`${election.name} (${electionDate}): no contests left at 'called' — skipped.`)
        if (recount.length) {
          notes.push(`${election.name} (${electionDate}): ${recount.length} contest(s) at 'recount_possible' still awaiting an admin decision.`)
        }
        continue
      }

      const { text, error: aiErr } = await queryPerplexity({
        system: CERT_EXTRACTOR_SYSTEM,
        user: certificationPrompt({ ...election, election_date: electionDate }),
        schema: CERT_SCHEMA,
        maxTokens: 400,
        timeoutMs: Math.min(deadline - Date.now() - 3000, PPLX_TIMEOUT_MS),
      })

      const verdict = aiErr || !text
        ? { verdict: 'UNCLEAR', sourceUrl: null, cited: false, certify: false, reason: aiErr || 'empty reply' }
        : parseCertificationVerdict(text)

      if (aiErr) problems.push(`certification check for ${electionDate} failed: ${aiErr}`)
      if (verdict.verdict === 'CERTIFIED' && !verdict.cited) {
        problems.push(`skipped ${electionDate}: ${verdict.reason}`)
      }

      if (verdict.certify && !dryRun) {
        const out = await certifyElectionContests(sb, election.id, {
          reasonSuffix: `Source: ${verdict.sourceUrl}`,
          deadline,
        })
        if (out.error) problems.push(`certification write failed for ${electionDate}: ${out.error}`)
        if (out.failed)   problems.push(`${out.failed} contest(s) for ${electionDate} could not be certified`)
        if (out.deferred) problems.push(`deferred: ${out.deferred} contest(s) for ${electionDate} carry to next week`)
        certified = out.certified
        certifiedTotal += certified
        notes.push(`${election.name} (${electionDate}): CERTIFIED — ${certified} contest(s) moved to 'certified' per ${verdict.sourceUrl}.`)
      } else if (verdict.certify && dryRun) {
        notes.push(`[dry run] ${election.name} (${electionDate}): CERTIFIED per ${verdict.sourceUrl} — would certify ${called.length} contest(s).`)
      } else {
        // NOT_YET / UNCLEAR / uncited: no writes, ask again next Thursday.
        notes.push(`${election.name} (${electionDate}): ${verdict.verdict} (${verdict.reason}) — ${called.length} contest(s) left at 'called'; waiting for next week.`)
      }

      // Always name the races the sweep will not touch, in the log and the
      // response, so nobody has to go hunting for them.
      if (recount.length) {
        notes.push(`${election.name} (${electionDate}): ${recount.length} contest(s) at 'recount_possible' left for the admin — ${recount.map(c => [c.office, c.district, c.county].filter(Boolean).join(' ')).slice(0, 20).join('; ')}`)
      }

      summaries.push({
        election: election.name,
        election_date: electionDate,
        verdict: verdict.verdict,
        source_url: verdict.sourceUrl,
        called: called.length,
        certified,
        needs_resolution: recount.map(c => ({ contest_id: c.id, office: c.office, district: c.district, county: c.county })),
      })

      if (!dryRun) await logRun(sb, { electionDate, certified, problems, startedAt })
    }

    console.log(`[certification-watch] ${summaries.length} election(s) checked, ${certifiedTotal} contest(s) certified`, JSON.stringify(notes))
    return { statusCode: 200, headers, body: JSON.stringify({
      ok: true,
      dry_run: dryRun,
      window: { from, to },
      checked: summaries.length,
      certified: certifiedTotal,
      elections: summaries,
      notes,
      duration_ms: Date.now() - startedAt,
    }) }
  } catch (e) {
    // Never 500 on a schedule.
    console.error('[certification-watch]', e && e.message)
    await logRun(sb, { electionDate: null, certified: certifiedTotal, problems: [`FATAL: ${e && e.message ? e.message : String(e)}`], startedAt })
    return { statusCode: 200, headers, body: JSON.stringify({
      ok: false, error: e && e.message ? e.message : 'certification watch failed', notes,
    }) }
  }
}

// pure, unit-tested in tests/remediation.test.mjs
module.exports.shiftDays                 = shiftDays
module.exports.certificationWindow       = certificationWindow
module.exports.inCertificationWindow     = inCertificationWindow
module.exports.parseCertificationVerdict = parseCertificationVerdict
module.exports.certificationPrompt       = certificationPrompt
module.exports.CERT_MIN_DAYS             = CERT_MIN_DAYS
module.exports.CERT_MAX_DAYS             = CERT_MAX_DAYS
