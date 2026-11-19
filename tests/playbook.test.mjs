// tests/playbook.test.mjs — the Candidate-plan Campaign Playbook's pure module
// (src/lib/playbook.js): Wisconsin date math for the spring and fall
// templates, election-type detection, the "past due at creation" rules, stale
// playbook detection, and the "this week" logic Home and the Playbook share.
import { readFileSync } from 'node:fs'
const P = await import('../src/lib/playbook.js')
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8')

let passed = 0, failed = 0
const t = (n, c) => { if (c) { passed++; console.log('  ✓ ' + n) } else { failed++; console.log('  ✗ ' + n) } }
const eq = (n, a, b) => t(`${n} (${JSON.stringify(a)})`, JSON.stringify(a) === JSON.stringify(b))

console.log('1 — Wisconsin election-day math')
eq('2026 general: first Tue after first Mon in Nov', P.fallGeneralDay(2026), '2026-11-03')
eq('2028 general', P.fallGeneralDay(2028), '2028-11-07')
eq('Nov 1 on a Tuesday is not election day (2022 → Nov 8)', P.fallGeneralDay(2022), '2022-11-08')
eq('2027 spring election: first Tue in April', P.springElectionDay(2027), '2027-04-06')
eq('2028 spring election', P.springElectionDay(2028), '2028-04-04')
eq('2027 spring primary: third Tue in Feb', P.springPrimaryDay(2027), '2027-02-16')
eq('2027 spring papers due: first Tue in Jan', P.springPapersDue(2027), '2027-01-05')
eq('2026 partisan primary: second Tue in Aug', P.partisanPrimaryDay(2026), '2026-08-11')
eq('2028 partisan primary', P.partisanPrimaryDay(2028), '2028-08-08')

console.log('2 — election-type detection')
eq('April → spring', P.detectElectionKind('2027-04-06'), 'spring')
eq('February (spring primary) → spring', P.detectElectionKind('2027-02-16'), 'spring')
eq('November → fall', P.detectElectionKind('2026-11-03'), 'fall')
eq('August → fall', P.detectElectionKind('2026-08-11'), 'fall')
eq('a June special → other', P.detectElectionKind('2027-06-15'), 'other')
eq('garbage → null', P.detectElectionKind('soon'), null)

console.log('3 — race cycles')
const spring = P.raceCycle('2027-04-06')
eq('spring cycle anchors', [spring.kind, spring.electionDay, spring.primaryDay, spring.papersFrom, spring.papersDue], ['spring', '2027-04-06', '2027-02-16', '2026-12-01', '2027-01-05'])
const fromPrimary = P.raceCycle('2027-02-16')
eq('picking the spring primary builds for the April election', [fromPrimary.electionDay, fromPrimary.primaryDay], ['2027-04-06', '2027-02-16'])
const fall = P.raceCycle('2028-11-07')
eq('fall cycle anchors', [fall.kind, fall.electionDay, fall.primaryDay, fall.papersFrom, fall.papersDue], ['fall', '2028-11-07', '2028-08-08', '2028-04-15', '2028-06-01'])
eq('picking the August primary builds for November', P.raceCycle('2028-08-08').electionDay, '2028-11-07')
const special = P.raceCycle('2027-06-15')
eq('special: no paper window, no primary', [special.kind, special.papersDue, special.primaryDay], ['other', null, null])

console.log('4 — spring template, built well ahead')
{
  const b = P.buildPlaybook(spring, { today: '2026-09-01' })
  const due = Object.fromEntries(b.steps.map(s => [s.key, s.due]))
  eq('papers start Dec 1', due['papers-start'], '2026-12-01')
  eq('papers due first Tue in Jan', due['papers-file'], '2027-01-05')
  t('registration (CF-1) comes before papers circulate', due.registration < due['papers-start'])
  t('treasurer + bank account before any money is raised', due.treasurer < due['early-money'])
  eq('SEI three days after the paper deadline', due.sei, '2027-01-08')
  eq('spring primary is a step', due['primary-day'], '2027-02-16')
  eq('GOTV weekend is the Saturday before', due['gotv-weekend'], '2027-04-03')
  eq('Election Day', due['election-day'], '2027-04-06')
  t('nothing to catch up, nothing left out', b.steps.every(s => !s.catchUp) && b.leftOut.length === 0)
  t('steps come back in date order', b.steps.every((s, i) => i === 0 || b.steps[i - 1].due <= s.due))
  const keys = new Set(b.steps.map(s => s.key))
  for (const k of ['registration', 'papers-file', 'sei', 'treasurer', 'budget', 'early-money', 'voter-list', 'literature', 'lit-drop-1', 'signs-order', 'doors', 'volunteers', 'digital', 'absentee', 'gotv-weekend', 'election-day', 'thank-yous', 'pre-election-report', 'post-election-report'])
    t(`has ${k}`, keys.has(k))
  t('every step has a plain why/how line', b.steps.every(s => s.why && s.why.length > 20 && !/undefined/.test(s.why)))
  const pf = b.steps.find(s => s.key === 'papers-file')
  t('papers step names 5 p.m., the date and the statute', /5 p\.m\. Tue Jan 5/.test(pf.why) && /8\.10/.test(pf.why))
  t('finance reports never invent a due date', b.steps.filter(s => /report/.test(s.key)).every(s => /exact due date/.test(s.why)))
}

console.log('5 — fall template')
{
  const b = P.buildPlaybook(fall, { today: '2028-01-02' })
  const due = Object.fromEntries(b.steps.map(s => [s.key, s.due]))
  eq('papers circulate from April 15', due['papers-start'], '2028-04-15')
  eq('papers due June 1', due['papers-file'], '2028-06-01')
  t('papers step cites 8.15', /8\.15/.test(b.steps.find(s => s.key === 'papers-file').why))
  eq('partisan primary is a step', due['primary-day'], '2028-08-08')
  eq('Election Day', due['election-day'], '2028-11-07')
  t('registration before papers', due.registration < due['papers-start'])
}

console.log('6 — past due at creation')
{
  // The owner's case: started Nov 19 2026 for the April 2027 spring election.
  const b = P.buildPlaybook(spring, { today: '2026-11-19' })
  const cu = b.steps.filter(s => s.catchUp)
  t('already-past steps are caught up, not overdue', cu.length >= 3 && cu.every(s => s.due === '2026-11-19'))
  t('registration is among them (still required)', cu.some(s => s.key === 'registration'))
  t('nothing is ever dated before today', b.steps.every(s => s.due >= '2026-11-19'))
  t('catch-up keeps the original date for reference', cu.every(s => s.scheduled < '2026-11-19'))
  t('paper window still open → nothing left out', b.leftOut.length === 0)

  // Started after the paper deadline: papers make no sense any more.
  const late = P.buildPlaybook(spring, { today: '2027-01-20' })
  const keys = late.steps.map(s => s.key)
  t('papers left out after the deadline', !keys.includes('papers-start') && !keys.includes('papers-file') && !keys.includes('sei'))
  t('…with a plain note naming the deadline', late.leftOut.some(x => x.key === 'papers-file' && /Jan 5, 2027/.test(x.note)))
  t('registration is still caught up (you can\'t raise money without it)', late.steps.some(s => s.key === 'registration' && s.catchUp))
  t('the primary still ahead stays dated', late.steps.find(s => s.key === 'primary-day')?.due === '2027-02-16')

  const afterPrimary = P.buildPlaybook(spring, { today: '2027-03-01' })
  t('primary steps left out once the primary is over', !afterPrimary.steps.some(s => s.key === 'primary-day' || s.key === 'pre-primary-report'))

  const over = P.buildPlaybook(P.raceCycle('2026-11-03'), { today: '2026-11-19' })
  t('a race that is over builds nothing', over.over === true && over.steps.length === 0)
}

console.log('7 — task rows')
{
  const b = P.buildPlaybook(spring, { today: '2026-11-19' })
  const rows = P.playbookTaskRows(b, { projectId: 'p1', sectionIdByPhase: { filing: 's2' }, raceDate: '2027-04-06' })
  const reg = rows.find(r => r.labels.includes('step:registration'))
  t('one row per step', rows.length === b.steps.length)
  t('rows carry the playbook, step and race labels', reg.labels.includes('playbook') && reg.labels.includes('race:2027-04-06'))
  t('catch-up rows are labelled and bumped', reg.labels.includes('catch-up') && reg.priority === 2)
  t('section follows the phase', reg.section_id === 's2' && reg.project_id === 'p1')
  t('why/how goes in the description', reg.description.length > 20)
}

console.log('8 — picking the race')
{
  const elections = [
    { id: 'g26', name: '2026 November General', election_date: '2026-11-03' },
    { id: 'sp27', name: '2027 Spring Primary', election_date: '2027-02-16' },
    { id: 'sg27', name: '2027 Spring General', election_date: '2027-04-06' },
    { id: 'zz', name: 'TEST election', election_date: '2026-12-01' },
    { id: 'pp28', name: '2028 Presidential Primary', election_date: '2028-04-04' },
    { id: 'sg28', name: '2028 Spring General Election', election_date: '2028-04-04' },
  ]
  const today = '2026-11-19'
  eq('no candidate election → soonest upcoming (test rows skipped)', P.nextRace({ self: { election_id: null }, elections, today })?.id, 'sp27')
  eq('own candidate record wins', P.nextRace({ self: { election: elections[2] }, elections, today })?.id, 'sg27')
  eq('election_id lookup', P.nextRace({ self: { election_id: 'sg28' }, elections, today })?.id, 'sg28')
  eq('own race already over → next upcoming', P.nextRace({ self: { election: elections[0] }, elections, today })?.id, 'sp27')
  eq('nothing on file → null (they pick a date)', P.nextRace({ elections: [], today }), null)
  const opts = P.raceOptions(elections, today)
  eq('one option per cycle, named for the election (not the primary)', opts.map(o => [o.date, o.name]), [['2027-04-06', '2027 Spring General'], ['2028-04-04', '2028 Spring General Election']])
  eq('a cycle with nothing on file gets a plain name', P.cycleName(P.raceCycle('2030-11-05'), elections), '2030 November General')
}

console.log('9 — stale playbook detection')
{
  const elections = [{ id: 'g26', name: '2026 November General', election_date: '2026-11-03' }]
  const legacy = { id: 'old', name: 'Campaign — 2026 November General', archived: false }
  const tasks = [
    { id: 'a', project_id: 'old', content: 'Confirm eligibility', due_date: '2026-01-07', labels: ['legal'] },
    { id: 'b', project_id: 'old', content: 'Thank-you notes', due_date: '2026-11-17', labels: [] },
    { id: 'c', project_id: null, content: 'Call 25 folks about yard signs', due_date: '2026-08-20', labels: [] },
    { id: 'd', project_id: null, content: 'Call the clerk', due_date: '2026-11-20', labels: [] },
  ]
  eq('the old Todo template project reads its race from its name', P.projectRace(legacy, tasks, elections), { date: '2026-11-03', name: '2026 November General' })
  const snap = P.playbookSnapshot({ projects: [legacy], tasks, elections, today: '2026-11-19' })
  eq('race over → stale', snap.state, 'stale')
  t('stale steps never reach this week (no "316 days overdue")', !snap.thisWeek.some(x => x.project_id === 'old'))
  eq('own loose tasks this week still count', snap.thisWeek.map(x => x.id), ['d'])
  t('a months-old loose task is past due, not this week', P.groupByWeek(snap.scoped, '2026-11-19').find(g => g.label === 'Past due')?.tasks[0]?.id === 'c')

  const fresh = { id: 'new', name: 'Playbook — 2027 Spring General', archived: false }
  const ftasks = [{ id: 'x', project_id: 'new', content: 'File CF-1', due_date: '2026-11-19', labels: ['playbook', 'step:registration', 'race:2027-04-06', 'catch-up'] }]
  const s2 = P.playbookSnapshot({ projects: [legacy, fresh], tasks: [...tasks, ...ftasks], elections, today: '2026-11-19' })
  eq('a live playbook wins', [s2.state, s2.race?.date, s2.pick.stale.length], ['active', '2027-04-06', 1])
  eq('catch-up comes first this week', s2.thisWeek[0]?.id, 'x')
  eq('election-day fallback for an unnamed project', P.projectRace({ id: 'q', name: 'My list' }, [{ project_id: 'q', content: 'Election Day — polls', due_date: '2027-04-06' }], [])?.date, '2027-04-06')
  eq('not a playbook → null', P.projectRace({ id: 'q', name: 'Groceries' }, [], []), null)
}

console.log('10 — this week and the weekly groups')
{
  const today = '2026-11-19' // a Thursday
  eq('weeks run Monday → Sunday', [P.weekStart(today), P.weekEnd(today)], ['2026-11-16', '2026-11-22'])
  const tasks = [
    { id: 'old', due_date: '2026-10-01' },
    { id: 'slip', due_date: '2026-11-10' },
    { id: 'sun', due_date: '2026-11-22' },
    { id: 'next', due_date: '2026-11-25' },
    { id: 'dec', due_date: '2026-12-08' },
    { id: 'jan', due_date: '2027-01-05' },
    { id: 'none', due_date: null },
    { id: 'done', due_date: '2026-11-19', completed: true },
    { id: 'sub', due_date: '2026-11-19', parent_id: 'x' },
  ]
  eq('this week = through Sunday, up to 14 days late, open, top-level', P.thisWeek(tasks, today).map(x => x.id), ['slip', 'sun'])
  eq('the rest is grouped by week', P.groupByWeek(tasks, today).map(g => [g.label, g.tasks.map(x => x.id)]),
    [['Past due', ['old']], ['Next week', ['next']], ['Week of Dec 7', ['dec']], ['Week of Jan 4, 2027', ['jan']], ['Anytime', ['none']]])
}

console.log('11 — phase progress')
{
  const sections = [{ id: 's1', project_id: 'p', name: 'Filing' }, { id: 's2', project_id: 'p', name: 'Fundraising' }]
  const open = [{ id: 'a', project_id: 'p', section_id: 's1', due_date: '2026-12-01', content: 'papers' }]
  const done = [{ id: 'b', project_id: 'p', section_id: 's1', completed: true }, { id: 'c', project_id: 'p', section_id: 's2', completed: true }]
  const pr = Object.fromEntries(P.phaseProgress({ projectId: 'p', sections, tasks: open, completed: done }).map(x => [x.key, [x.done, x.total, x.next?.id || null]]))
  eq('filing 1 of 2, next = papers', pr.filing, [1, 2, 'a'])
  eq('legacy "Fundraising" section reads as Money', pr.money, [1, 1, null])
  eq('six phases in order', P.PHASES.map(p => p.name), ['Planning', 'Filing', 'Money', 'Voter contact', 'GOTV', 'Election Day'])
}

console.log('12 — wiring')
{
  const gp = read('src/pages/GamePlan.jsx'), home = read('src/pages/dashboard/FieldHome.jsx'), pb = read('src/pages/Playbook.jsx'), layout = read('src/components/Layout.jsx')
  t('GamePlan branches on plan type: Candidate → Playbook, Action → TaskBoard', /getUserPlanType\(user\)/.test(gp) && /<Playbook \/>/.test(gp) && /<TaskBoard \/>/.test(gp))
  t('Home hero reads this week from the playbook module', /playbookSnapshot\(/.test(home) && !/staleBefore/.test(home))
  t('Playbook archives (never deletes) a stale playbook', /archived: true/.test(pb) && !/deleteTaskProject\(stale|deleteTaskProject\(old/.test(pb))
  t('nav says Playbook for Candidate plans', /key: 'todo',[^\n]*candidateLabel: 'Playbook'/.test(layout))
  t('page header says Playbook for Candidate plans, Todo for Action', /title: isActionPlan \? 'Todo' : 'Playbook'/.test(layout))
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) process.exitCode = 1
