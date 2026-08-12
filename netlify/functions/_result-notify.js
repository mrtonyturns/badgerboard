// netlify/functions/_result-notify.js
// ─── Per-race election-result notifications ──────────────────────────────────
//
// SPEC: users subscribe to a single contest from the race card on the Results
// board (table `election_subscriptions`, migration 20260811000001) and pick a
// mode:
//
//   'every_change' — email whenever the numbers move (throttled to one every
//                    30 minutes, because the poller runs every 5)
//   'final_only'   — nothing until the race is decided
//
// Both modes always get the winner announcement and the "final numbers,
// recount possible" email; only 'every_change' gets running updates.
//
// The leading underscore keeps Netlify from publishing this as an endpoint.
//
// ─── Decision matrix (decideNotification, pure) ──────────────────────────────
//
//   contest state                          every_change      final_only
//   ─────────────────────────────────────  ────────────────  ────────────────
//   no baseline snapshot yet (first sight) none — seed only  none — seed only
//   called / certified / any declared row  winner  (once)    winner  (once)
//     …and winner_notified_at already set  none              none
//   recount_possible, newly entered        recount           recount
//     …status unchanged since last email   (falls through)   none
//   votes / precincts / status changed     update            none
//     …last email < 30 minutes ago         none (throttled)  none
//     …zero votes and still 'waiting'      none              none
//   nothing changed                        none              none
//
// A subscription with no last_snapshot is on its FIRST sight: no email goes
// out, the baseline is seeded, and (when the race was already decided before
// they subscribed) winner_notified_at is seeded too, so nobody gets a
// retroactive winner blast or a table full of zeros.
//
// Winner and recount emails IGNORE the throttle — they are the whole point of
// subscribing. Only the running-update email is rate-limited.
//
// notifyContestChanges() never throws. A notification failure must never break
// the poller or an admin write: everything is caught, logged, and reported in
// the return value.

// Called as `emailer.sendEmail(...)` rather than destructured, so the mailer can
// be swapped out in tests without re-loading this module.
const emailer = require('./_email')

// One running-update email per subscription per 30 minutes. The poller runs
// every 5 minutes on election night, so without this a single subscriber to a
// fast-moving statewide race would get ~12 emails an hour.
const THROTTLE_MS = 30 * 60 * 1000

const BOARD_URL = 'https://badgerboardwi.com/game-plan?tab=results&election='

// Wisconsin recount thresholds (Wis. Stat. § 9.01) — mirrored from
// _determination.js so the copy and the engine can never drift apart.
const RECOUNT_PCT  = 1.0
const FEE_FREE_PCT = 0.25

const DECIDED_STATUSES = new Set(['called', 'certified'])

const isUuid = (v) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)

// Everything below is called from a poller that must not die on a bad row, so
// the two hostile inputs — a null contest and an unparseable timestamp — are
// normalised once, here, rather than guarded at forty call sites.
const asObj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})
const asDate = (v) => {
  const d = v instanceof Date ? v : (v === undefined || v === null ? new Date() : new Date(v))
  return Number.isNaN(d.getTime()) ? new Date() : d
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure formatting helpers
// ─────────────────────────────────────────────────────────────────────────────

function esc(s) {
  if (s === null || s === undefined) return ''
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

const toInt = (v) => {
  const n = typeof v === 'string' ? Number(v.trim()) : Number(v)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0
}

/** 1234567 → "1,234,567" */
const nf = (n) => toInt(n).toLocaleString('en-US')

/** 62.349 → "62.3" */
const pf = (n) => {
  const v = Number(n)
  return Number.isFinite(v) ? v.toFixed(1) : '0.0'
}

/** "Sheriff — Republican Primary — Marathon County" style label. */
function raceName(rawContest = {}) {
  const contest = asObj(rawContest)
  const office = String(contest.office || 'this race').trim()
  const bits = [office]
  const district = contest.district ? String(contest.district).trim() : ''
  if (district && !office.toLowerCase().includes(district.toLowerCase())) bits.push(district)
  const county = contest.county ? String(contest.county).trim() : ''
  if (county && !office.toLowerCase().includes(county.toLowerCase())) bits.push(`${county} County`)
  return bits.join(' — ')
}

/** Central-time clock stamp — the board, the poller and the emails all speak CT. */
function ctStamp(when = new Date()) {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit', hour12: true,
    }).format(when instanceof Date ? when : new Date(when)) + ' CT'
  } catch {
    return 'just now'
  }
}

const reportingPct = (rawContest = {}) => {
  const contest = asObj(rawContest)
  const total = toInt(contest.precincts_total)
  if (total <= 0) return null
  return Math.min(100, Math.round((toInt(contest.precincts_rptg) / total) * 100))
}

/** The status badge, in plain English, for people reading email at 10pm. */
function statusLine(rawContest = {}, status = null) {
  const contest = asObj(rawContest)
  const st  = status || contest.status || 'reporting'
  const pct = reportingPct(contest)
  switch (st) {
    case 'waiting':          return 'Awaiting first returns'
    case 'reporting':        return pct === null ? 'Reporting — precinct counts not yet available' : `Reporting — ${pct}% of precincts in`
    case 'projected':        return 'Victory likely — not final'
    case 'called':           return 'Winner called'
    case 'too_close':        return 'Too close to call'
    case 'recount_possible': return "Recount possible — final margin inside Wisconsin's 1% window"
    case 'certified':        return 'Certified — official result'
    default:                 return pct === null ? 'Reporting' : `Reporting — ${pct}% of precincts in`
  }
}

const precinctsLine = (rawContest = {}) => {
  const contest = asObj(rawContest)
  const total = toInt(contest.precincts_total)
  if (total <= 0) return 'Precinct counts are not available for this race yet.'
  const rptg = Math.min(toInt(contest.precincts_rptg), total)
  return `${nf(rptg)} of ${nf(total)} precincts reporting (${Math.round((rptg / total) * 100)}%).`
}

/** Sorted desc by votes, defensive against junk rows. */
function rankResults(results = []) {
  return (Array.isArray(results) ? results : [])
    .filter(r => r && typeof r === 'object')
    .map(r => ({
      candidate_name: String(r.candidate_name || '').trim() || 'Unnamed candidate',
      party: r.party ? String(r.party) : '',
      votes: toInt(r.votes),
      vote_pct: Number.isFinite(Number(r.vote_pct)) && r.vote_pct !== null ? Number(r.vote_pct) : null,
      winner: r.winner === true,
      declared: r.declared === true,
    }))
    .sort((a, b) => b.votes - a.votes)
}

/**
 * Margin picture for a contest: leader, runner-up, raw margin, margin as a
 * share of all votes cast. Pure — used by every builder and by the tests.
 */
function marginOf(results = [], seats = 1) {
  const ranked = rankResults(results)
  const totalVotes = ranked.reduce((s, r) => s + r.votes, 0)
  const n = Math.max(1, toInt(seats) || 1)
  const leader = ranked[Math.min(n, ranked.length) - 1] || null
  const runnerUp = ranked[n] || null
  const margin = leader ? (runnerUp ? Math.max(0, leader.votes - runnerUp.votes) : leader.votes) : 0
  const marginPct = totalVotes > 0 ? (margin / totalVotes) * 100 : 0
  return { ranked, totalVotes, leader, runnerUp, margin, marginPct, unopposed: !runnerUp }
}

/** Who the email should crown: declared/flagged winners, else the vote leader. */
function winnersOf(results = [], seats = 1) {
  const ranked = rankResults(results)
  const flagged = ranked.filter(r => r.declared || r.winner)
  if (flagged.length) return flagged
  const n = Math.max(1, toInt(seats) || 1)
  return ranked.filter(r => r.votes > 0).slice(0, n)
}

const PARTY_COLOR = {
  Democrat: '#1D4ED8', Democratic: '#1D4ED8', Republican: '#B91C1C',
  Independent: '#7E22CE', Libertarian: '#B45309', Green: '#15803D', Nonpartisan: '#4B5563',
}

/**
 * The candidates table. The leader is bolded and carries a ▲; when `highlight`
 * is a Set of names those rows get the green winner treatment instead.
 */
function candidateTable(results = [], { highlight = null } = {}) {
  const ranked = rankResults(results)
  if (!ranked.length) {
    return `<p style="margin:18px 0;color:#9ca3af;font-size:14px">No candidate rows on file for this race yet.</p>`
  }
  const totalVotes = ranked.reduce((s, r) => s + r.votes, 0)

  const rows = ranked.map((r, i) => {
    const isHighlighted = highlight ? highlight.has(r.candidate_name) : false
    const isLeader = !highlight && i === 0 && r.votes > 0
    const bold = isHighlighted || isLeader
    const bg = isHighlighted ? '#E6F5EC' : (i % 2 === 1 ? '#FAFAF9' : '#ffffff')
    const nameColor = isHighlighted ? '#14532D' : '#111827'
    const pct = r.vote_pct != null ? r.vote_pct : (totalVotes > 0 ? (r.votes / totalVotes) * 100 : 0)
    const mark = isHighlighted ? '🏆 ' : (isLeader ? '▲ ' : '')
    const partyColor = PARTY_COLOR[r.party] || '#6b7280'
    return `<tr style="background:${bg}">
      <td style="padding:9px 10px;border-bottom:1px solid #f3f4f6;color:${nameColor};font-weight:${bold ? 700 : 400}">${mark}${esc(r.candidate_name)}</td>
      <td style="padding:9px 10px;border-bottom:1px solid #f3f4f6;color:${partyColor};font-size:13px">${esc(r.party || '—')}</td>
      <td align="right" style="padding:9px 10px;border-bottom:1px solid #f3f4f6;color:#111827;font-weight:${bold ? 700 : 400};font-variant-numeric:tabular-nums">${nf(r.votes)}</td>
      <td align="right" style="padding:9px 10px;border-bottom:1px solid #f3f4f6;color:#4b5563;font-weight:${bold ? 700 : 400};font-variant-numeric:tabular-nums">${pf(pct)}%</td>
    </tr>`
  }).join('\n')

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:18px 0;font-size:14px;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden">
  <thead><tr style="background:#F1F1EF">
    <th align="left"  style="padding:8px 10px;font-size:11px;letter-spacing:.4px;text-transform:uppercase;color:#57534E">Candidate</th>
    <th align="left"  style="padding:8px 10px;font-size:11px;letter-spacing:.4px;text-transform:uppercase;color:#57534E">Party</th>
    <th align="right" style="padding:8px 10px;font-size:11px;letter-spacing:.4px;text-transform:uppercase;color:#57534E">Votes</th>
    <th align="right" style="padding:8px 10px;font-size:11px;letter-spacing:.4px;text-transform:uppercase;color:#57534E">%</th>
  </tr></thead>
  <tbody>
${rows}
  </tbody>
</table>`
}

const MANAGE_NOTE = 'Manage or turn off notifications from the race card on your Results board.'
const UPDATE_FOOTER = `You asked for updates every time this race's numbers change. ${MANAGE_NOTE}`
const FINAL_FOOTER  = `You asked to hear about this race on Badger Board. ${MANAGE_NOTE}`

const ctaUrlFor = (contest = {}, opts = {}) => `${BOARD_URL}${encodeURIComponent(asObj(opts).electionId || asObj(contest).election_id || '')}`

const electionLine = (contest, opts = {}) => {
  const name = asObj(opts).electionName || asObj(contest).election_name || ''
  return name ? `<p style="margin:0 0 4px;color:#6b7280;font-size:13px">${esc(name)}</p>` : ''
}

// ─────────────────────────────────────────────────────────────────────────────
// Email builders — pure, unit-tested, previewable
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Running-numbers update. Sent to 'every_change' subscribers when the votes,
 * precinct count or status moved and the 30-minute throttle has cleared.
 * @returns {{subject,title,preheader,body,ctaText,ctaUrl,footerNote}}
 */
function buildUpdateEmail(rawContest = {}, results = [], rawOpts = {}) {
  const contest = asObj(rawContest)
  const opts = asObj(rawOpts)
  const now = asDate(opts.now)
  const name = raceName(contest)
  const { leader, margin, marginPct, totalVotes, unopposed } = marginOf(results, contest.seats)
  const status = opts.status || contest.status || 'reporting'

  // One basic summary line — nothing else above the table (owner's spec).
  const lead = leader
    ? (unopposed
        ? `${esc(leader.candidate_name)} has ${nf(leader.votes)} votes, unopposed.`
        : `${esc(leader.candidate_name)} leads by ${nf(margin)} vote${margin === 1 ? '' : 's'} (${pf(marginPct)}%).`)
    : 'No votes have been reported yet.'

  const body = `<p style="margin:0">${lead}</p>
${candidateTable(results)}
<p style="margin:0 0 6px">${esc(precinctsLine(contest))}</p>
<p style="margin:0 0 6px"><strong>Status:</strong> ${esc(statusLine(contest, status))}</p>
<p style="margin:14px 0 0;color:#9ca3af;font-size:12px">Numbers as of ${esc(ctStamp(now))}. These are unofficial returns and can change.</p>`

  const leaderPct = leader
    ? (leader.vote_pct != null ? leader.vote_pct : (totalVotes > 0 ? (leader.votes / totalVotes) * 100 : 0))
    : 0

  return {
    subject: `📊 ${String(contest.office || 'Your race')}: new numbers in`,
    title: name,
    preheader: leader
      ? `${leader.candidate_name} ${unopposed ? 'is at' : 'leads with'} ${pf(leaderPct)}%. ${statusLine(contest, status)}.`
      : `${statusLine(contest, status)}.`,
    body,
    ctaText: 'View live results',
    ctaUrl: ctaUrlFor(contest, opts),
    flagBar: false,
    footerNote: UPDATE_FOOTER,
  }
}

/**
 * Winner announcement. Sent once per subscription, to BOTH modes, the moment
 * the contest goes 'called'/'certified' or a result row is declared.
 */
function buildWinnerEmail(rawContest = {}, results = [], rawOpts = {}) {
  const contest = asObj(rawContest)
  const opts = asObj(rawOpts)
  const now = asDate(opts.now)
  const name = raceName(contest)
  const office = String(contest.office || 'this race')
  const winners = winnersOf(results, contest.seats)
  const winnerNames = winners.map(w => w.candidate_name)
  const { margin, marginPct, totalVotes, runnerUp, unopposed } = marginOf(results, contest.seats)
  const highlight = new Set(winnerNames)

  const headline = winnerNames.length
    ? `${winnerNames.join(', ')} ${winnerNames.length > 1 ? 'have' : 'has'} won.`
    : 'This race has been decided.'

  const marginSentence = !winnerNames.length ? ''
    : (unopposed || !runnerUp)
      ? `${winnerNames[0]} finishes with ${nf(winners[0] ? winners[0].votes : 0)} votes and no opponent to displace.`
      : `Final margin: ${nf(margin)} vote${margin === 1 ? '' : 's'} (${pf(marginPct)}%) over ${runnerUp.candidate_name}, out of ${nf(totalVotes)} cast.`

  const detail = contest.status_detail && typeof contest.status_detail === 'object' ? contest.status_detail : null
  const reason = detail && typeof detail.reason === 'string' && detail.reason.trim()
    ? detail.reason.trim()
    : (contest.status === 'certified'
        ? 'The result has been certified by the canvassing authority.'
        : 'Decided from the reported returns on file.')

  // Owner's spec: no banner box — the centered trophy headline IS the
  // announcement; the body opens with the final margin.
  const body = `${marginSentence ? `<p style="margin:0">${esc(marginSentence)}</p>` : ''}
${candidateTable(results, { highlight })}
<p style="margin:0 0 6px">${esc(precinctsLine(contest))}</p>
<p style="margin:0 0 6px"><strong>How it was decided:</strong> ${esc(reason)}</p>
<p style="margin:14px 0 0;color:#9ca3af;font-size:12px">Result as of ${esc(ctStamp(now))}. Unofficial until the canvass is certified.</p>`

  return {
    subject: `🏆 Winner: ${winnerNames.length ? winnerNames.join(', ') : 'race decided'} — ${office}`,
    title: `🏆 ${headline}`,
    titleCenter: true,
    preheader: marginSentence || `The ${office} has been decided.`,
    body,
    ctaText: 'View live results',
    ctaUrl: ctaUrlFor(contest, opts),
    flagBar: false,
    footerNote: FINAL_FOOTER,
  }
}

/**
 * Final numbers, recount possible. Sent to BOTH modes when the contest first
 * lands on 'recount_possible' — every precinct is in, but the margin is inside
 * Wisconsin's recount window, so nobody has won anything yet.
 */
function buildRecountEmail(rawContest = {}, results = [], rawOpts = {}) {
  const contest = asObj(rawContest)
  const opts = asObj(rawOpts)
  const now = asDate(opts.now)
  const name = raceName(contest)
  const office = String(contest.office || 'this race')
  const { leader, runnerUp, margin, marginPct, totalVotes } = marginOf(results, contest.seats)
  const detail = contest.status_detail && typeof contest.status_detail === 'object' ? contest.status_detail : null
  const feeFree = detail && detail.fee_free !== undefined ? detail.fee_free === true : marginPct <= FEE_FREE_PCT

  const marginSentence = leader && runnerUp
    ? `${leader.candidate_name} finished ahead of ${runnerUp.candidate_name} by ${nf(margin)} vote${margin === 1 ? '' : 's'} — ${pf(marginPct)}% of the ${nf(totalVotes)} votes cast.`
    : `The final unofficial margin in this race is ${pf(marginPct)}% of ${nf(totalVotes)} votes cast.`

  const banner = leader && runnerUp
    ? `Recount possible — ${leader.candidate_name} leads ${runnerUp.candidate_name} by ${nf(margin)} vote${margin === 1 ? '' : 's'} (${pf(marginPct)}%).`
    : `Recount possible — the final margin is ${pf(marginPct)}%.`
  const body = `<p style="margin:0 0 6px;padding:18px 20px;background:#FEF0E6;border:1px solid #fbd0aa;border-radius:10px;font-size:16px;line-height:1.45;font-weight:700;color:#9A3412">⚖️ ${esc(banner)}</p>
${candidateTable(results)}
<p style="margin:0 0 6px">${esc(precinctsLine(contest))}</p>
<p style="margin:14px 0 0;padding:14px 16px;background:#FAFAF9;border-left:3px solid #C2410C;border-radius:0 6px 6px 0;font-size:14px;color:#4b5563">
  <strong style="color:#111827">Wisconsin's recount thresholds (Wis. Stat. &sect; 9.01).</strong>
  A losing candidate may petition for a recount when the margin is ${RECOUNT_PCT}% of the votes cast or less.
  When the margin is ${FEE_FREE_PCT}% or less, the recount is fee-free — the petitioner pays nothing.
  ${feeFree
    ? `At ${pf(marginPct)}%, this race is inside the fee-free band: a recount can be requested at no cost to the petitioner.`
    : `At ${pf(marginPct)}%, this race is inside the petition window but outside the fee-free band, so a petitioner would have to cover the cost.`}
</p>
<p style="margin:14px 0 0;color:#9ca3af;font-size:12px">Final unofficial numbers as of ${esc(ctStamp(now))}. Nothing is official until the canvass is certified.</p>`

  return {
    subject: `⚖️ Final numbers — recount possible: ${office}`,
    title: `Final numbers — recount possible in the ${office}`,
    preheader: marginSentence,
    body,
    ctaText: 'View live results',
    ctaUrl: ctaUrlFor(contest, opts),
    flagBar: false,
    footerNote: FINAL_FOOTER,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Change detection + the decision (pure)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What we compare against last time: every candidate's vote total, the
 * precincts reported, and the status. Nothing else — a vote_pct that moved
 * only because the denominator moved is not news on its own.
 */
function snapshotOf(rawContest = {}, results = []) {
  const contest = asObj(rawContest)
  const votes = {}
  for (const r of rankResults(results)) votes[r.candidate_name] = r.votes
  return {
    votes,
    precincts_rptg: toInt(contest.precincts_rptg),
    status: contest.status || null,
  }
}

/**
 * Delivery bookkeeping rides inside last_snapshot under a reserved key so it
 * needs no migration on election day. It is NOT part of the change picture:
 * snapshotChanged compares votes, precincts and status only, and hasBaseline
 * below ignores a row that carries nothing but `_delivery`.
 */
const DELIVERY_KEY = '_delivery'
const MAX_DELIVERY_FAILS = 5
const DELIVERY_BACKOFF_MS = 6 * 60 * 60 * 1000
const SNAPSHOT_KEYS = ['votes', 'status', 'precincts_rptg']

/** Does this stored snapshot actually describe the race (vs. only _delivery)? */
function hasBaseline(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
  return SNAPSHOT_KEYS.some(k => k in raw)
}

/** Current failed-delivery state for a subscription. Never throws. */
function deliveryStateOf(sub) {
  const snap = asObj(asObj(sub).last_snapshot)
  const d = asObj(snap[DELIVERY_KEY])
  const at = d.last_fail_at ? new Date(d.last_fail_at).getTime() : NaN
  return { fails: toInt(d.fails), last_fail_at: Number.isFinite(at) ? at : null }
}

/**
 * Five consecutive failures inside six hours is a hard bounce, not a blip —
 * stop paying for it every five minutes. A success clears the counter.
 */
function shouldBackOff(sub, now = new Date()) {
  const { fails, last_fail_at } = deliveryStateOf(sub)
  if (fails < MAX_DELIVERY_FAILS || last_fail_at === null) return false
  return asDate(now).getTime() - last_fail_at < DELIVERY_BACKOFF_MS
}

/** last_snapshot with the failure counter bumped; the race picture is kept. */
function markDeliveryFailure(sub, now = new Date()) {
  const prev = asObj(asObj(sub).last_snapshot)
  const { fails } = deliveryStateOf(sub)
  return {
    ...prev,
    [DELIVERY_KEY]: { fails: fails + 1, last_fail_at: asDate(now).toISOString() },
  }
}

/** A snapshot without the delivery bookkeeping — what a SUCCESS writes back. */
function clearDeliveryState(snapshot) {
  const { [DELIVERY_KEY]: _drop, ...rest } = asObj(snapshot)
  return rest
}

function snapshotChanged(prev, next) {
  if (!hasBaseline(prev)) return true
  if ((prev.status || null) !== (next.status || null)) return true
  if (toInt(prev.precincts_rptg) !== toInt(next.precincts_rptg)) return true
  const a = prev.votes && typeof prev.votes === 'object' ? prev.votes : {}
  const b = next.votes || {}
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const k of keys) if (toInt(a[k]) !== toInt(b[k])) return true
  return false
}


// ── Election-night winner embargo (duplicated tiny CT clock; requiring the
// poller here would be a circular import) ────────────────────────────────────
const NOTIFY_CT_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago', hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
})
const EMBARGO_CT_MINUTES = Number(process.env.CALL_EMBARGO_CT_MINUTES) || (22 * 60 + 30)
function winnerEmbargoActive(electionDate, when = new Date()) {
  try {
    const p = {}
    for (const part of NOTIFY_CT_FORMAT.formatToParts(when)) if (part.type !== 'literal') p[part.type] = part.value
    const today = `${p.year}-${p.month}-${p.day}`
    if (String(electionDate || '').slice(0, 10) !== today) return false
    return ((parseInt(p.hour, 10) % 24) * 60 + parseInt(p.minute, 10)) < EMBARGO_CT_MINUTES
  } catch { return false }
}

const isDecided = (contest = {}, results = []) =>
  DECIDED_STATUSES.has(asObj(contest).status) || rankResults(results).some(r => r.declared)

/**
 * The whole decision, as one pure function.
 *
 * @param {Object} sub      election_subscriptions row
 * @param {Object} contest  election_contests row
 * @param {Array}  results  election_results rows for that contest
 * @param {Date}   now
 * @returns {{kind:'winner'|'recount'|'update'|'none', reason:string, snapshot:Object, patch:Object|null}}
 */
function decideNotification(rawSub = {}, rawContest = {}, results = [], now = new Date(), opts = {}) {
  const winnerEmbargo = opts.winnerEmbargo === true
  const sub = asObj(rawSub)
  const contest = asObj(rawContest)
  const at = asDate(now)
  const iso = at.toISOString()
  const snapshot = snapshotOf(contest, results)
  const stored = sub.last_snapshot && typeof sub.last_snapshot === 'object' && !Array.isArray(sub.last_snapshot)
    ? sub.last_snapshot
    : null
  const prev = hasBaseline(stored) ? stored : null
  const mode = sub.mode === 'final_only' ? 'final_only' : 'every_change'
  const none = (reason) => ({ kind: 'none', reason, snapshot, patch: null })

  // ── 0. First sight of this subscription — seed, never email ───────────────
  // A brand-new subscription has no baseline, so EVERYTHING looks like a
  // change: the old code emailed "new numbers in" with a table of zeros the
  // first time the poller touched the race. Seed the baseline silently; the
  // next real movement is the first email.
  if (!prev) {
    const patch = { last_snapshot: snapshot }
    let reason = 'first sight of this subscription — baseline seeded silently, no email'
    // …and if the race was ALREADY decided when they subscribed, seed the
    // winner stamp too: nobody wants a "🏆 Winner" blast for a race that was
    // called before they ever pressed the bell.
    if (!winnerEmbargo && isDecided(contest, results) && !sub.winner_notified_at) {
      patch.winner_notified_at = iso
      reason = 'first sight of an already-decided race — baseline seeded, no retroactive winner email'
    }
    return { kind: 'none', reason, snapshot, patch }
  }

  // ── a. Winner announcement — both modes, once, throttle ignored ───────────
  if (isDecided(contest, results)) {
    if (winnerEmbargo) {
      // Owner directive: nobody is told a race is won before 10:30 PM CT on
      // election night. Bookkeeping is deliberately NOT written — the first
      // touch after the embargo lifts sends the real announcement.
      return none('winner email withheld under the 10:30 PM CT election-night embargo')
    }
    if (!sub.winner_notified_at) {
      return {
        kind: 'winner',
        reason: 'race decided and the winner announcement has not been sent',
        snapshot,
        // last_notified_at moves too, so an 'every_change' subscriber does not
        // get a "new numbers" email seconds after the winner email.
        patch: { winner_notified_at: iso, last_notified_at: iso, last_snapshot: snapshot },
      }
    }
    return none('winner announcement already sent for this race')
  }

  // ── b. Final numbers / recount possible — both modes, throttle ignored ────
  // Only on the TRANSITION into recount_possible: the poller re-writes the same
  // status every 5 minutes and none of those repeats are news.
  if (contest.status === 'recount_possible' && (!prev || prev.status !== 'recount_possible')) {
    return {
      kind: 'recount',
      reason: 'contest entered recount_possible',
      snapshot,
      // Deliberately NOT winner_notified_at: nobody has won yet, so the winner
      // email is still owed once the recount resolves.
      patch: { last_notified_at: iso, last_snapshot: snapshot },
    }
  }

  // ── c. Running update — 'every_change' only, 30-minute throttle ───────────
  if (mode !== 'every_change') return none('final_only subscriber; nothing final has happened')
  if (!snapshotChanged(prev, snapshot)) return none('no change since the last email')

  // Nothing to report: no votes anywhere and the race has not started counting.
  // An all-zero table is never news, whatever else moved.
  const totalVotes = Object.values(snapshot.votes || {}).reduce((s, v) => s + toInt(v), 0)
  if (totalVotes === 0 && snapshot.status === 'waiting') {
    return none('no votes reported yet and the race is still waiting — nothing worth emailing')
  }

  const last = sub.last_notified_at ? new Date(sub.last_notified_at).getTime() : null
  if (last !== null && Number.isFinite(last) && at.getTime() - last < THROTTLE_MS) {
    return none('throttled — an update went out less than 30 minutes ago')
  }

  return {
    kind: 'update',
    reason: 'numbers changed and the throttle has cleared',
    snapshot,
    patch: { last_notified_at: iso, last_snapshot: snapshot },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The runner
// ─────────────────────────────────────────────────────────────────────────────

// auth.users is not REST-exposed, so there is no single-query join that gets
// every subscriber's address — the lookups stay per-user, but they run four at
// a time and each address is resolved ONCE per run (the promise, not the
// result, is cached, so four concurrent workers on the same user share a call).
const NOTIFY_CONCURRENCY = 4

// Never START another subscriber's pipeline (lookup → send → bookkeeping) with
// less than this left on the run clock: a send that lands after the platform
// kills us would email the subscriber with no bookkeeping written, and they
// would get the same email again next run.
const NOTIFY_MIN_BUDGET_MS = 2500

/** Resolve one subscriber's email, cached per run. Never throws. */
function resolveEmail(sb, userId, cache) {
  if (cache.has(userId)) return cache.get(userId)
  const p = (async () => {
    try {
      const { data, error } = await sb.auth.admin.getUserById(userId)
      if (error) return null
      return (data && data.user && data.user.email) || null
    } catch (e) {
      console.warn('[result-notify] user lookup failed for', userId, '—', e.message)
      return null
    }
  })()
  cache.set(userId, p)
  return p
}

/**
 * Run `worker` over `items`, `size` at a time, in order. Each item's errors are
 * the worker's problem — this never rejects and never lets one bad row stop the
 * rest.
 */
async function runPool(items, size, worker) {
  const list = Array.isArray(items) ? items : []
  const width = Math.max(1, Math.min(Math.floor(size) || 1, list.length))
  if (!list.length) return
  let cursor = 0
  const lane = async () => {
    while (cursor < list.length) {
      const item = list[cursor++]
      try { await worker(item) } catch (e) {
        console.warn('[result-notify] pool worker threw:', e && e.message)
      }
    }
  }
  await Promise.all(Array.from({ length: width }, lane))
}

/**
 * Notify every subscriber of every contest in `contestIds` about whatever just
 * changed. Service-role client required (it reads other users' subscriptions
 * and writes the notifier bookkeeping columns).
 *
 * NEVER THROWS — the caller's write has already succeeded and must not be
 * failed by an email problem.
 *
 * @param {Object} sb          service-role Supabase client
 * @param {Array|Set} contestIds  contest ids actually touched (non-uuids ignored)
 * @param {Object} [options]
 * @param {string} [options.trigger]  'poller' | 'admin:save_result' | …
 * @param {number} [options.deadline] epoch ms; stop starting new work past it.
 *                                    Unnotified subscriptions retry next run —
 *                                    their bookkeeping was simply never written.
 * @returns {Promise<{sent:number,failed:number,skipped:number,deferred:number,subscriptions:number,contests:number,notes:string[]}>}
 */
async function notifyContestChanges(sb, contestIds, { trigger = 'unknown', now = new Date(), deadline = null } = {}) {
  const out = { sent: 0, failed: 0, skipped: 0, deferred: 0, subscriptions: 0, contests: 0, notes: [] }
  try {
    const ids = [...new Set([...(contestIds || [])])].filter(isUuid)
    if (!ids.length) return out
    if (!sb || typeof sb.from !== 'function') {
      out.notes.push('no Supabase client — notifications skipped')
      return out
    }

    const { data: subs, error: sErr } = await sb
      .from('election_subscriptions')
      .select('id, user_id, contest_id, mode, last_notified_at, last_snapshot, winner_notified_at')
      .in('contest_id', ids)
    if (sErr) { out.notes.push(`subscription load failed: ${sErr.message}`); return out }
    if (!subs || !subs.length) return out

    const liveIds = [...new Set(subs.map(s => s.contest_id))]
    out.subscriptions = subs.length
    out.contests = liveIds.length

    const { data: contests, error: cErr } = await sb
      .from('election_contests')
      .select('id, election_id, office, district, county, seats, status, status_detail, precincts_rptg, precincts_total')
      .in('id', liveIds)
    if (cErr) { out.notes.push(`contest load failed: ${cErr.message}`); return out }

    const { data: results, error: rErr } = await sb
      .from('election_results')
      .select('contest_id, candidate_name, party, votes, vote_pct, winner, declared')
      .in('contest_id', liveIds)
    if (rErr) { out.notes.push(`results load failed: ${rErr.message}`); return out }

    const electionIds = [...new Set((contests || []).map(c => c.election_id).filter(isUuid))]
    const electionNames = {}
    const electionDates = {}
    if (electionIds.length) {
      const { data: elections } = await sb.from('elections').select('id, name, election_date').in('id', electionIds)
      for (const e of elections || []) electionNames[e.id] = e.name, electionDates[e.id] = e.election_date
    }

    const byId = new Map((contests || []).map(c => [c.id, c]))
    const resultsById = new Map()
    for (const r of results || []) {
      if (!resultsById.has(r.contest_id)) resultsById.set(r.contest_id, [])
      resultsById.get(r.contest_id).push(r)
    }

    const emailCache = new Map()
    const at = asDate(now)

    const writePatch = async (sub, patch, label) => {
      const { error: uErr } = await sb.from('election_subscriptions')
        .update(patch).eq('id', sub.id)
      if (uErr) out.notes.push(`${label}: notification bookkeeping write failed — ${uErr.message}`)
    }

    // Four subscriptions in flight at a time: the user lookup, the Resend call
    // and the bookkeeping write are all latency, and a statewide race can carry
    // hundreds of subscribers. Errors stay isolated to one subscription.
    await runPool(subs, NOTIFY_CONCURRENCY, async (sub) => {
      // Deadline: never START another subscriber's pipeline without room to
      // finish it. Whatever is left is retried next run — no bookkeeping was
      // written for it, so nothing was consumed.
      if (deadline && deadline - Date.now() < NOTIFY_MIN_BUDGET_MS) { out.deferred++; return }
      try {
        const contest = byId.get(sub.contest_id)
        if (!contest) { out.skipped++; return }
        const rows = resultsById.get(sub.contest_id) || []

        if (shouldBackOff(sub, at)) {
          out.skipped++
          out.notes.push(`${contest.office}: a subscriber's address has failed ${MAX_DELIVERY_FAILS}+ times — skipped, backing off for 6 hours.`)
          return
        }

        const decision = decideNotification(sub, contest, rows, at, { winnerEmbargo: winnerEmbargoActive(electionDates[contest.election_id], at) })
        if (decision.kind === 'none') {
          out.skipped++
          // A 'none' can still carry a patch — first sight seeds the baseline
          // (and the winner stamp on an already-decided race) so the very next
          // pass compares against something real instead of emailing zeros.
          if (decision.patch) await writePatch(sub, decision.patch, contest.office)
          return
        }

        const to = await resolveEmail(sb, sub.user_id, emailCache)
        if (!to) { out.skipped++; return }

        const opts = {
          now: at,
          electionId: contest.election_id,
          electionName: electionNames[contest.election_id] || null,
        }
        const built = decision.kind === 'winner' ? buildWinnerEmail(contest, rows, opts)
          : decision.kind === 'recount' ? buildRecountEmail(contest, rows, opts)
          : buildUpdateEmail(contest, rows, opts)

        const res = await emailer.sendEmail({ to, ...built })
        // `skipped` means the mail never left the building (no RESEND_API_KEY,
        // no recipient). That is a FAILURE, not a delivery: writing the
        // bookkeeping here would mark a winner email as sent and it would never
        // be retried — the email would silently vanish forever.
        if (res && (res.error || res.skipped === true)) {
          out.failed++
          const why = res.error ? String(res.error).slice(0, 120) : 'the mailer skipped it (no API key or no recipient)'
          out.notes.push(`${contest.office}: ${decision.kind} email to a subscriber failed (${why}).`)
          // No last_notified_at / winner_notified_at — the next pass retries.
          // Only the failure counter moves, so a hard bounce eventually backs off.
          await writePatch(sub, { last_snapshot: markDeliveryFailure(sub, at) }, contest.office)
          return
        }
        out.sent++

        if (decision.patch) {
          // A successful delivery clears the backoff counter.
          const patch = { ...decision.patch }
          if (patch.last_snapshot) patch.last_snapshot = clearDeliveryState(patch.last_snapshot)
          await writePatch(sub, patch, contest.office)
        }
      } catch (e) {
        out.failed++
        console.warn('[result-notify] subscription', sub && sub.id, 'failed:', e.message)
      }
    })

    if (out.deferred) {
      out.notes.push(`Notifications (${trigger}): ${out.deferred} subscription(s) deferred at the run deadline — the next run picks them up.`)
    }
    if (out.sent || out.failed) {
      out.notes.push(`Notifications (${trigger}): ${out.sent} email(s) sent, ${out.failed} failed, ${out.skipped} subscription(s) with nothing to say.`)
    }
    return out
  } catch (e) {
    console.error('[result-notify] notifyContestChanges failed:', e && e.message)
    out.notes.push(`notification pass failed: ${e && e.message ? e.message : String(e)}`)
    return out
  }
}

module.exports = {
  winnerEmbargoActive,
  notifyContestChanges,
  // pure, testable, previewable
  decideNotification,
  buildUpdateEmail,
  buildWinnerEmail,
  buildRecountEmail,
  snapshotOf,
  snapshotChanged,
  hasBaseline,
  deliveryStateOf,
  shouldBackOff,
  markDeliveryFailure,
  clearDeliveryState,
  runPool,
  marginOf,
  winnersOf,
  statusLine,
  raceName,
  candidateTable,
  THROTTLE_MS,
  DELIVERY_KEY,
  MAX_DELIVERY_FAILS,
  DELIVERY_BACKOFF_MS,
  NOTIFY_CONCURRENCY,
  NOTIFY_MIN_BUDGET_MS,
}
