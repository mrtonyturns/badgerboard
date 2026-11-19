// ─── playbook.js — the Campaign Playbook for Candidate plans (pure, no JSX) ───
//
// The Todo screen for Candidate plans is a playbook built from the election
// date: every Wisconsin step a local or legislative campaign has to hit
// (registration, nomination papers, money, voter contact, GOTV, Election Day),
// dated from the race and grouped by week. This module is the whole brain of
// it — the page (src/pages/Playbook.jsx) and the Home hero tile
// (src/pages/dashboard/FieldHome.jsx) both read "this week" from here, so the
// two screens can never disagree. tests/playbook.test.mjs imports it under
// bare node, so it must stay free of JSX and of imports.
//
// Storage: a playbook is one gp_projects row named "Playbook — <race>", its
// sections are the six phases, and every step is a gp_tasks row labelled
// `playbook`, `step:<key>` and `race:<YYYY-MM-DD>` (the race's Election Day —
// the projects table has no election column, so the date rides on the tasks).
//
// Dates are 'YYYY-MM-DD' strings throughout and the math is done in UTC, so a
// step never slides a day because of the viewer's time zone or DST.
//
// ── Wisconsin calendar rules encoded here ────────────────────────────────────
//   Spring (nonpartisan: local, judicial, school board)
//     • Spring election: first Tuesday in April            (Wis. Stat. 5.02(21))
//     • Spring primary, when needed: third Tuesday in Feb  (Wis. Stat. 5.02(22))
//     • Nomination papers circulate from Dec 1 and are due 5 p.m. on the first
//       Tuesday in January                                  (Wis. Stat. 8.10(2)(a))
//   Fall (partisan)
//     • General: first Tuesday after the first Monday in Nov (Wis. Stat. 5.02(5))
//     • Partisan primary: second Tuesday in August          (Wis. Stat. 5.02(12s))
//     • Nomination papers circulate from April 15 and are due 5 p.m. June 1
//                                                           (Wis. Stat. 8.15(1))
//   Both
//     • Campaign registration statement (CF-1) before raising or spending
//       money and before circulating papers                 (Wis. Stat. ch. 11)
//     • Declaration of Candidacy filed with the papers      (Wis. Stat. 8.21)
//     • Statement of Economic Interests for state offices and judges, by the
//       third day after the paper deadline                  (Wis. Stat. 19.43(4))
//     • No electioneering within 100 feet of a polling place entrance (12.03)
//     • In-person absentee voting opens no earlier than 14 days out (6.86(1)(b))
//   Campaign finance report due dates are NOT pinned here — they move with
//   the calendar, so those steps say "check the calendar for your exact due
//   date" and carry a reminder date a little ahead of when they usually fall.

// ─── Dates ───────────────────────────────────────────────────────────────────

const pad = (n) => String(n).padStart(2, '0')
const ymdUTC = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
const isYmd = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)

/** 'YYYY-MM-DD' → a UTC-midnight Date (null when unparseable). */
export function parseYmd(s) {
  if (s == null) return null
  const str = String(s).slice(0, 10)
  if (!isYmd(str)) return null
  const [y, m, d] = str.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCMonth() === m - 1 ? dt : null
}

/** Today in the viewer's own calendar, as 'YYYY-MM-DD'. */
export function localToday(now = new Date()) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

export function addDays(s, n) {
  const d = parseYmd(s)
  if (!d) return null
  d.setUTCDate(d.getUTCDate() + n)
  return ymdUTC(d)
}

/** Whole days from a to b (b − a). */
export function daysBetween(a, b) {
  const x = parseYmd(a), y = parseYmd(b)
  if (!x || !y) return null
  return Math.round((y - x) / 864e5)
}

/** The nth (1-based) `weekday` (0 = Sunday … 6 = Saturday) of a month (1–12). */
export function nthWeekday(year, month, weekday, n) {
  const first = new Date(Date.UTC(year, month - 1, 1))
  const offset = (weekday - first.getUTCDay() + 7) % 7
  return ymdUTC(new Date(Date.UTC(year, month - 1, 1 + offset + (n - 1) * 7)))
}

/** First Tuesday after the first Monday in November — the general election. */
export function fallGeneralDay(year) {
  return addDays(nthWeekday(year, 11, 1, 1), 1)
}
export const springElectionDay  = (year) => nthWeekday(year, 4, 2, 1)   // 1st Tue of April
export const springPrimaryDay   = (year) => nthWeekday(year, 2, 2, 3)   // 3rd Tue of Feb
export const springPapersDue    = (year) => nthWeekday(year, 1, 2, 1)   // 1st Tue of Jan
export const partisanPrimaryDay = (year) => nthWeekday(year, 8, 2, 2)   // 2nd Tue of Aug

/** Monday of the week holding `s` (weeks run Monday → Sunday, as on Home). */
export function weekStart(s) {
  const d = parseYmd(s)
  if (!d) return null
  return addDays(s, -((d.getUTCDay() + 6) % 7))
}
export const weekEnd = (s) => addDays(weekStart(s), 6)

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const DAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** "Jan 5" (or "Jan 5, 2027" when `withYear`). */
export function fmtShort(s, withYear = false) {
  const d = parseYmd(s)
  if (!d) return ''
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}${withYear ? `, ${d.getUTCFullYear()}` : ''}`
}
/** "Tue Jan 5". */
export function fmtDay(s) {
  const d = parseYmd(s)
  return d ? `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}` : ''
}
/** "Tuesday, April 6, 2027". */
export function fmtLong(s) {
  const d = parseYmd(s)
  return d ? `${DAYS_LONG[d.getUTCDay()]}, ${MONTHS_LONG[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}` : ''
}

// ─── Election type and cycle ─────────────────────────────────────────────────

/**
 * Which template a race date calls for. Spring = the nonpartisan April
 * election and its February primary; fall = the partisan November general and
 * its August primary. Anything else (a special election) gets the generic plan.
 */
export function detectElectionKind(date) {
  const d = parseYmd(date)
  if (!d) return null
  const m = d.getUTCMonth() + 1
  if (m === 2 || m === 3 || m === 4) return 'spring'
  if (m === 8 || m === 11) return 'fall'
  return 'other'
}

/**
 * The whole cycle around one race date: the Election Day the playbook counts
 * down to, its primary, and the nomination-paper window. Picking the spring
 * primary builds the playbook for that spring's April election (the primary is
 * a step in it); picking the August primary builds November's.
 */
export function raceCycle(date) {
  const d = parseYmd(date)
  if (!d) return null
  const kind = detectElectionKind(date)
  const year = d.getUTCFullYear()
  const m = d.getUTCMonth() + 1
  const iso = ymdUTC(d)
  if (kind === 'spring') {
    const electionDay = m === 4 ? iso : springElectionDay(year)
    return {
      kind, year, electionDay,
      primaryDay: m === 2 ? iso : springPrimaryDay(year),
      papersFrom: `${year - 1}-12-01`,
      papersDue: springPapersDue(year),
      start: `${year - 1}-12-01`,
    }
  }
  if (kind === 'fall') {
    const electionDay = m === 11 ? iso : fallGeneralDay(year)
    return {
      kind, year, electionDay,
      primaryDay: m === 8 ? iso : partisanPrimaryDay(year),
      papersFrom: `${year}-04-15`,
      papersDue: `${year}-06-01`,
      start: `${year}-04-15`,
    }
  }
  // Special or unusual date: no statutory paper window we can pin, so the
  // planning steps hang off a start 120 days out and filing says "ask".
  return { kind, year, electionDay: iso, primaryDay: null, papersFrom: null, papersDue: null, start: addDays(iso, -120) }
}

const KIND_NAME = { spring: 'Spring Election', fall: 'November General', other: 'Election' }

/** A display name for a cycle: the matching election on file, else a plain one. */
export function cycleName(cycle, elections = []) {
  if (!cycle) return ''
  const same = (elections || []).filter(e => String(e?.election_date || '').slice(0, 10) === cycle.electionDay && !isTestElection(e) && e?.name)
  // Two rows can share a date (the 2028 presidential primary rides on the
  // spring election); name the race after the one that isn't a primary.
  const hit = same.find(e => !/primary/i.test(e.name)) || same[0]
  if (hit) return hit.name
  return cycle.kind === 'other' ? `Election on ${fmtShort(cycle.electionDay, true)}` : `${cycle.year} ${KIND_NAME[cycle.kind]}`
}

// Seed/QA rows never belong in a race picker (same rule as GamePlan.jsx).
export const isTestElection = (e) => /^(zz)?test(?![a-z])/i.test(String(e?.name || '').trim())

/**
 * The race a candidate's playbook should be built for: their own candidate
 * record's election when it's still ahead, else the soonest upcoming election
 * on file. Null means "let them pick a date".
 */
export function nextRace({ self = null, elections = [], today = localToday() } = {}) {
  const ahead = (e) => e && isYmd(String(e.election_date || '').slice(0, 10)) && String(e.election_date).slice(0, 10) >= today && !isTestElection(e)
  if (ahead(self?.election)) return self.election
  const linked = (elections || []).find(e => self?.election_id && e.id === self.election_id)
  if (ahead(linked)) return linked
  return (elections || []).filter(ahead)
    .sort((a, b) => String(a.election_date).localeCompare(String(b.election_date)))[0] || null
}

/**
 * Upcoming races to offer in the picker, one per cycle (the spring primary and
 * the spring election build the same playbook), soonest first.
 */
export function raceOptions(elections = [], today = localToday()) {
  const seen = new Map()
  const sorted = [...(elections || [])]
    .filter(e => !isTestElection(e) && String(e?.election_date || '').slice(0, 10) >= today)
    .sort((a, b) => String(a.election_date).localeCompare(String(b.election_date)))
  for (const e of sorted) {
    const cycle = raceCycle(String(e.election_date).slice(0, 10))
    if (!cycle || cycle.electionDay < today || seen.has(cycle.electionDay)) continue
    seen.set(cycle.electionDay, { date: cycle.electionDay, name: cycleName(cycle, elections), kind: cycle.kind, cycle })
  }
  return [...seen.values()]
}

// ─── Phases and steps ────────────────────────────────────────────────────────

export const PHASES = [
  { key: 'planning', name: 'Planning',      color: 'blue'   },
  { key: 'filing',   name: 'Filing',        color: 'ink'    },
  { key: 'money',    name: 'Money',         color: 'green'  },
  { key: 'voter',    name: 'Voter contact', color: 'red'    },
  { key: 'gotv',     name: 'GOTV',          color: 'orange' },
  { key: 'eday',     name: 'Election Day',  color: 'purple' },
]
const PHASE_BY_KEY = Object.fromEntries(PHASES.map(p => [p.key, p]))

// Section name → phase. Includes the old TaskBoard template's section names so
// a legacy "Campaign — <race>" project still reads into the right columns.
const SECTION_ALIASES = {
  planning: 'planning', filing: 'filing', money: 'money', fundraising: 'money',
  'voter contact': 'voter', gotv: 'gotv', 'election day': 'eday',
}
export const phaseForSectionName = (name) => SECTION_ALIASES[String(name || '').trim().toLowerCase()] || null

const papersLaw = (c) => (c.kind === 'spring' ? 'Wis. Stat. 8.10' : 'Wis. Stat. 8.15')
const CHECK_CAL = 'Check the Wisconsin Ethics Commission\'s campaign finance calendar (or ask your clerk) for your exact due date.'

/**
 * The template. `at(c)` dates a step from the cycle (null = the step doesn't
 * apply to this kind of race). `closes(c)` is the day after which the step no
 * longer makes sense — a playbook created later leaves it out with `gone(c)`
 * as the plain note. Steps without `closes` that are already past at creation
 * go into Catch up instead.
 */
export const STEPS = [
  // Planning
  { key: 'eligibility', phase: 'planning', title: 'Confirm your seat and the rules with your clerk',
    at: c => addDays(c.start, -35), closes: c => c.papersDue,
    why: () => 'Ask your filing officer which seat is up, the term, how many signatures you need, and where and when to file.' },
  { key: 'treasurer', phase: 'planning', title: 'Name a treasurer and open a campaign bank account',
    at: c => addDays(c.start, -28),
    why: () => 'Your committee needs a treasurer and its own account. Never mix campaign money with personal money.' },
  { key: 'budget', phase: 'planning', title: 'Write a simple budget and your one-line message',
    at: c => addDays(c.start, -21),
    why: () => 'Price out literature, signs and postage, then decide the one sentence you want every voter to hear.' },
  { key: 'digital', phase: 'planning', title: 'Set up a simple website and Facebook page',
    at: c => addDays(c.start, c.kind === 'fall' ? -30 : -7),
    why: () => 'Voters will look you up. Your photo, why you\'re running and how to help is enough. Add the "Paid for by" line.' },

  // Filing
  { key: 'registration', phase: 'filing', title: 'File your campaign registration statement (CF-1)',
    at: c => addDays(c.start, -14),
    why: () => 'File it before you raise or spend any money and before you circulate papers. Local offices file with the clerk; state offices with the Ethics Commission.' },
  { key: 'papers-start', phase: 'filing', title: 'Start circulating nomination papers',
    at: c => c.papersFrom, closes: c => c.papersDue,
    why: c => `Papers can circulate from ${fmtShort(c.papersFrom)} (${papersLaw(c)}). Collect more signatures than the minimum, because some will be struck.`,
    gone: c => `Nomination papers were due ${fmtShort(c.papersDue, true)}, so circulating them is left out. Not on the ballot? Ask your clerk about running as a registered write-in.` },
  { key: 'papers-file', phase: 'filing', title: 'Turn in nomination papers and your Declaration of Candidacy',
    at: c => c.papersDue, closes: c => c.papersDue,
    why: c => `Due by 5 p.m. ${fmtDay(c.papersDue)} to your filing officer (${papersLaw(c)}). File a few days early so there's time to fix a problem.`,
    gone: c => `The filing deadline (5 p.m. ${fmtShort(c.papersDue, true)}) has passed, so filing papers is left out.` },
  { key: 'papers-ask', phase: 'filing', title: 'Ask your filing officer for the nomination paper deadline',
    at: c => (c.kind === 'other' ? addDays(c.electionDay, -90) : null),
    why: () => 'Special and unusual elections set their own paper window. Get the dates in writing.' },
  { key: 'sei', phase: 'filing', title: 'Statement of Economic Interests (if your office requires one)',
    at: c => (c.papersDue ? addDays(c.papersDue, 3) : null), closes: c => (c.papersDue ? addDays(c.papersDue, 3) : null),
    why: () => 'State offices and judges file one with the Ethics Commission by the third day after the paper deadline (Wis. Stat. 19.43). Some counties and cities require one too, so ask your clerk.',
    gone: () => 'The Statement of Economic Interests deadline has passed, so it\'s left out.' },

  // Money
  { key: 'early-money', phase: 'money', title: 'Ask your closest supporters for early money',
    at: c => addDays(c.start, -7),
    why: () => 'Start with family, friends and coworkers. Early money pays for papers, literature and signs.' },
  { key: 'continuing-report', phase: 'money',
    title: 'Continuing finance report',
    at: c => (c.kind === 'spring' ? `${c.year}-01-08` : c.kind === 'fall' ? `${c.year}-07-08` : null),
    closes: c => c.electionDay,
    why: () => `Continuing reports come due in January and July. ${CHECK_CAL}` },
  { key: 'money-push', phase: 'money', title: 'Second money push: call or mail your donor list',
    at: c => addDays(c.electionDay, -60),
    why: () => 'Ask everyone who gave once to give again for the final stretch: lit drops, signs and GOTV.' },
  { key: 'pre-primary-report', phase: 'money', title: 'Pre-primary finance report (if you\'re in a primary)',
    at: c => (c.primaryDay ? addDays(c.primaryDay, -14) : null), closes: c => c.primaryDay,
    why: () => `If your race is on the primary ballot, a report comes due shortly before it. ${CHECK_CAL}` },
  { key: 'pre-election-report', phase: 'money', title: 'Pre-election finance report',
    at: c => addDays(c.electionDay, -14), closes: c => c.electionDay,
    why: () => `A report comes due shortly before Election Day. ${CHECK_CAL}` },
  { key: 'post-election-report', phase: 'money', title: 'Your next finance report after the election',
    at: c => addDays(c.electionDay, 21),
    why: () => `Your committee keeps reporting until it's closed out. ${CHECK_CAL}` },

  // Voter contact
  { key: 'voter-list', phase: 'voter', title: 'Get your voter list and pick who you\'ll talk to',
    at: c => addDays(c.electionDay, c.kind === 'fall' ? -150 : -120),
    why: () => 'Get it from your party, a vendor, or the state voter list (BadgerVoters). Start with people who reliably vote in this kind of election.' },
  { key: 'volunteers', phase: 'voter', title: 'Recruit volunteers: door knockers, lit droppers, sign hosts',
    at: c => addDays(c.electionDay, c.kind === 'fall' ? -145 : -105),
    why: () => 'Ask everyone who signed your papers or gave money. Give each person one clear job and a date.' },
  { key: 'literature', phase: 'voter', title: 'Design and print your literature',
    at: c => addDays(c.electionDay, c.kind === 'fall' ? -120 : -90),
    why: () => 'One card: your photo, three reasons, how to reach you, and the "Paid for by" line. Print enough for every door.' },
  { key: 'doors', phase: 'voter', title: 'Start knocking doors',
    at: c => addDays(c.electionDay, c.kind === 'fall' ? -140 : -70),
    why: () => 'Set a number of doors for each week and keep to it. Knocking yourself is the most persuasive thing you\'ll do.' },
  { key: 'signs-order', phase: 'voter', title: 'Order yard signs',
    at: c => addDays(c.electionDay, c.kind === 'fall' ? -90 : -60),
    why: () => 'Check local rules on when and where signs can go up, and get permission for every yard.' },
  { key: 'lit-drop-1', phase: 'voter', title: 'First lit drop',
    at: c => addDays(c.electionDay, c.kind === 'fall' ? -60 : -45),
    why: () => 'Cover your best neighborhoods first. Never put literature in a mailbox; use the door.' },
  { key: 'signs-up', phase: 'voter', title: 'Get yard signs up',
    at: c => addDays(c.electionDay, c.kind === 'fall' ? -50 : -35),
    why: () => 'Busy corners and supporters\' yards. Keep a list of where each one went so you can pick them up.' },
  { key: 'lit-drop-2', phase: 'voter', title: 'Final lit drop',
    at: c => addDays(c.electionDay, -12),
    why: () => 'One more pass at the doors that matter most, with the election date in big type.' },

  // GOTV
  { key: 'primary-day', phase: 'gotv', title: 'Primary day (if your race has a primary)',
    at: c => c.primaryDay, closes: c => c.primaryDay,
    why: () => 'If you\'re on the primary ballot, remind your supporters to vote and watch the results.' },
  { key: 'absentee', phase: 'gotv', title: 'Push absentee and early voting',
    at: c => addDays(c.electionDay, -21),
    why: () => 'In-person absentee voting opens up to 14 days before Election Day. Ask your supporters to make a plan to vote early.' },
  { key: 'gotv-plan', phase: 'gotv', title: 'Plan your GOTV weekend',
    at: c => addDays(c.electionDay, -10),
    why: () => 'Line up volunteers, walk lists and call lists for the last four days.' },
  { key: 'gotv-weekend', phase: 'gotv', title: 'GOTV weekend: knock and call your supporters',
    at: c => addDays(c.electionDay, -3),
    why: () => 'Only your supporters now. Remind them when and where to vote.' },

  // Election Day
  { key: 'election-day', phase: 'eday', title: 'Election Day: vote, cover the polls, thank people',
    at: c => c.electionDay,
    why: () => 'Vote early, visit polling places (no campaigning within 100 feet of the entrance), and plan your night.' },
  { key: 'signs-down', phase: 'eday', title: 'Pick up your yard signs',
    at: c => addDays(c.electionDay, 3),
    why: () => 'Use your list. Many towns set a deadline for taking signs down.' },
  { key: 'thank-yous', phase: 'eday', title: 'Thank-you notes to volunteers and donors',
    at: c => addDays(c.electionDay, 7),
    why: () => 'A handwritten note to everyone who helped. You\'ll need them again.' },
]

/**
 * Build the playbook for a cycle as of `today`.
 *   steps    — [{ key, phase, title, why, due, catchUp, scheduled }] in date order
 *   leftOut  — [{ key, title, note }] steps whose window closed before today
 *   over     — the race is already past (nothing is built)
 * Past-due steps that still make sense are due `today` with catchUp: true, so
 * a late start never opens on a wall of "200 days overdue".
 */
export function buildPlaybook(cycle, { today = localToday() } = {}) {
  if (!cycle?.electionDay) return { steps: [], leftOut: [], over: false }
  if (cycle.electionDay < today) return { steps: [], leftOut: [], over: true }
  const steps = [], leftOut = []
  STEPS.forEach((s, i) => {
    const scheduled = s.at(cycle)
    if (!scheduled) return
    const base = { key: s.key, phase: s.phase, title: s.title, why: s.why(cycle), order: i, scheduled }
    if (scheduled >= today) { steps.push({ ...base, due: scheduled, catchUp: false }); return }
    const closes = s.closes ? s.closes(cycle) : null
    if (closes && closes < today) {
      leftOut.push({ key: s.key, title: s.title, note: s.gone ? s.gone(cycle) : `${s.title}: that window closed ${fmtShort(closes, true)}.` })
      return
    }
    steps.push({ ...base, due: today, catchUp: true })
  })
  steps.sort((a, b) => a.due.localeCompare(b.due) || a.order - b.order)
  return { steps, leftOut, over: false }
}

/** Project name for a race. */
export const playbookProjectName = (raceName) => `Playbook — ${raceName}`

/** gp_tasks rows for a built playbook (feed to createTasksBatch). */
export function playbookTaskRows(built, { projectId, sectionIdByPhase = {}, raceDate }) {
  return (built?.steps || []).map((s, i) => ({
    content: s.title,
    description: s.why,
    project_id: projectId,
    section_id: sectionIdByPhase[s.phase] || null,
    due_date: s.due,
    labels: ['playbook', `step:${s.key}`, `race:${raceDate}`, ...(s.catchUp ? ['catch-up'] : [])],
    priority: s.catchUp ? 2 : 4,
    sort_order: (i + 1) * 1024,
  }))
}

// ─── Reading a stored playbook back ──────────────────────────────────────────

const hasLabel = (t, l) => Array.isArray(t?.labels) && t.labels.includes(l)
export const isCatchUp = (t) => hasLabel(t, 'catch-up')
export const stepKeyOf = (t) => (t?.labels || []).find(l => /^step:/.test(l))?.slice(5) || null
export const isOwnStep = (t) => !stepKeyOf(t)

/**
 * The race a project is for: a `race:` label on any of its tasks, else the
 * election its name points at ("Campaign — 2026 November General", the old
 * Todo template's naming), else its "Election Day" task's date. Null when the
 * project isn't a playbook at all.
 */
export function projectRace(project, tasks = [], elections = []) {
  if (!project) return null
  const own = (tasks || []).filter(t => t.project_id === project.id)
  const m = /^(?:Playbook|Campaign)\s+[—–-]\s+(.+)$/.exec(String(project.name || '').trim())
  const name = m ? m[1].trim() : String(project.name || '')
  const label = own.flatMap(t => t.labels || []).find(l => /^race:\d{4}-\d{2}-\d{2}$/.test(l))
  if (label) return { date: label.slice(5), name }
  if (m) {
    const el = (elections || []).find(e => String(e?.name || '').trim() === name && e.election_date)
    if (el) return { date: String(el.election_date).slice(0, 10), name }
  }
  const eday = own.find(t => /^election day\b/i.test(String(t.content || '')) && isYmd(String(t.due_date || '')))
  if (eday) return { date: eday.due_date, name }
  return null
}

/**
 * Sort a plan's projects into the live playbook (race still ahead, soonest
 * first) and stale ones (race over). Archived projects never reach here —
 * getTaskProjects filters them out.
 */
export function pickPlaybook(projects = [], tasks = [], elections = [], today = localToday()) {
  const found = (projects || []).filter(p => !p.archived)
    .map(p => ({ project: p, race: projectRace(p, tasks, elections) }))
    .filter(x => x.race)
  const live = found.filter(x => x.race.date >= today).sort((a, b) => a.race.date.localeCompare(b.race.date))
  const stale = found.filter(x => x.race.date < today).sort((a, b) => b.race.date.localeCompare(a.race.date))
  return { active: live[0] || null, stale, others: live.slice(1) }
}

const openTop = (t) => t && !t.parent_id && !t.completed

/**
 * Open tasks the playbook screen and Home count: the live playbook's steps,
 * plus anything the candidate keeps outside a playbook (Inbox, own lists).
 * Tasks of a stale playbook or of an archived/unknown project are excluded.
 */
export function scopeTasks({ projects = [], tasks = [], pick }) {
  const known = new Set((projects || []).filter(p => !p.archived).map(p => p.id))
  const staleIds = new Set((pick?.stale || []).map(x => x.project.id))
  return (tasks || []).filter(t => openTop(t) && (!t.project_id || (known.has(t.project_id) && !staleIds.has(t.project_id))))
}

// How far back "this week" reaches for things that slipped. Older open items
// are listed under "Past due" in the plan, not pushed at the candidate.
export const SLIP_DAYS = 14

const byDue = (a, b) =>
  (isCatchUp(b) - isCatchUp(a)) ||
  String(a.due_date || '9999').localeCompare(String(b.due_date || '9999')) ||
  ((a.sort_order ?? 0) - (b.sort_order ?? 0))

/** This week's focus: open, dated through Sunday, and no more than SLIP_DAYS late. */
export function thisWeek(tasks = [], today = localToday()) {
  const end = weekEnd(today), floor = addDays(today, -SLIP_DAYS)
  return (tasks || []).filter(t => openTop(t) && t.due_date && t.due_date <= end && t.due_date >= floor).sort(byDue)
}

/**
 * Everything after this week, grouped: "Past due", "Next week",
 * "Week of Dec 7", …, then "Anytime" for undated steps.
 */
export function groupByWeek(tasks = [], today = localToday()) {
  const end = weekEnd(today), floor = addDays(today, -SLIP_DAYS)
  const nextStart = addDays(end, 1), thisYear = today.slice(0, 4)
  const groups = new Map()
  const push = (key, label, t) => { if (!groups.has(key)) groups.set(key, { key, label, tasks: [] }); groups.get(key).tasks.push(t) }
  for (const t of [...(tasks || [])].filter(openTop).sort(byDue)) {
    if (!t.due_date) { push('~anytime', 'Anytime', t); continue }
    if (t.due_date < floor) { push('0-past', 'Past due', t); continue }
    if (t.due_date <= end) continue   // shown in This week
    const ws = weekStart(t.due_date)
    if (ws === nextStart) push(ws, 'Next week', t)
    else push(ws, `Week of ${fmtShort(ws, ws.slice(0, 4) !== thisYear)}`, t)
  }
  return [...groups.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

/** Per-phase progress for a playbook project (open + completed tasks). */
export function phaseProgress({ projectId, sections = [], tasks = [], completed = [] }) {
  const phaseOfSection = Object.fromEntries((sections || []).filter(s => s.project_id === projectId).map(s => [s.id, phaseForSectionName(s.name)]))
  const out = PHASES.map(p => ({ ...p, done: 0, total: 0, next: null }))
  const idx = Object.fromEntries(PHASES.map((p, i) => [p.key, i]))
  const seen = new Set()
  for (const t of [...(tasks || []), ...(completed || [])]) {
    if (!t || t.parent_id || t.project_id !== projectId || seen.has(t.id)) continue
    seen.add(t.id)
    const ph = phaseOfSection[t.section_id]
    if (ph == null) continue
    const row = out[idx[ph]]
    row.total++
    if (t.completed) row.done++
    else if (!row.next || byDue(t, row.next) < 0) row.next = t
  }
  return out
}

/** Phase key of a task in a playbook project (null for own steps). */
export function phaseOfTask(t, sections = []) {
  const s = (sections || []).find(x => x.id === t?.section_id)
  return s ? phaseForSectionName(s.name) : null
}
export const phaseMeta = (key) => PHASE_BY_KEY[key] || null

/**
 * One call for Home and the Playbook screen: which state the playbook is in
 * and what's on for this week.
 *   state: 'active' (a live playbook) | 'stale' (only a playbook whose race is
 *          over) | 'none' (never made one)
 */
export function playbookSnapshot({ projects = [], tasks = [], elections = [], today = localToday() } = {}) {
  const pick = pickPlaybook(projects, tasks, elections, today)
  const scoped = scopeTasks({ projects, tasks, pick })
  const state = pick.active ? 'active' : pick.stale.length ? 'stale' : 'none'
  return {
    state,
    pick,
    race: pick.active?.race || null,
    staleRace: pick.stale[0]?.race || null,
    scoped,
    thisWeek: thisWeek(scoped, today),
  }
}
