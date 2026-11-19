// ─── Playbook.jsx — the Campaign Playbook (Candidate plans' Todo screen) ─────
//
// Replaces the Todoist-style TaskBoard for Candidate plans (Action plans keep
// TaskBoard — GamePlan.jsx branches on getUserPlanType). The playbook comes
// pre-loaded from the election date: filing deadlines, nomination papers,
// money, lit drops, doors, GOTV, grouped by week. Candidates tick things off
// and add their own steps. All the date logic and the "this week" rule live
// in src/lib/playbook.js, which Home's hero tile reads too, so the two
// screens always agree.
//
// Layout (docs/DESIGN.md): PageHead with the race and a countdown → "This
// week" as big cards with a one-tap Done (mycandidatepage's Sign-ups cards) →
// a phase strip in the colored-top-edge column style → the rest of the plan
// grouped by week, with "Add your own step" and a collapsible Done count.
//
// Storage is the existing gp_projects / gp_sections / gp_tasks tables via
// lib/supabase.js. A playbook whose race is over is archived (gp_projects
// .archived), never deleted, when the candidate starts the next one.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Check, Plus, Repeat, ChevronDown, ChevronRight, Undo2, ListChecks, CalendarDays, Archive, AlertCircle,
} from 'lucide-react'
import {
  getTaskProjects, createTaskProject, updateTaskProject, deleteTaskProject,
  getTaskSections, createTaskSectionsBatch,
  getTasks, getCompletedTasks, createTask, createTasksBatch, updateTask,
  getElections, getCandidates, primeTaskCaches, subscribeTaskChanges,
} from '../lib/supabase'
import { nextOccurrence } from '../lib/recurrence.js'
import { useAuth } from '../contexts/AuthContext'
import { resolveSelfCandidate } from './dashboard/CandidateDashboard'
import { daysUntil } from './dashboard/dueMath.js'
import {
  PHASES, phaseMeta, phaseOfTask, phaseProgress, playbookSnapshot, groupByWeek, buildPlaybook,
  raceCycle, cycleName, nextRace, raceOptions, playbookProjectName, playbookTaskRows,
  isCatchUp, isOwnStep, localToday, weekStart, weekEnd, fmtShort, fmtDay, fmtLong,
} from '../lib/playbook.js'
import { PageHead, Tile, TileHead, CountBadge, EmptyState, Button, ICON_COLORS } from '../components/ui'
import LoadingBar from '../components/LoadingBar'

const cx = (...a) => a.filter(Boolean).join(' ')
const colorOf = (phaseKey) => ICON_COLORS[phaseMeta(phaseKey)?.color] || ICON_COLORS.gray
// Countdowns use the dashboards' daysUntil convention so Home and the
// Playbook print the same number; `today` only differs from the real date
// when the view is drawn from fixed data.
const nowFor = (today) => (today === localToday() ? new Date() : new Date(`${today}T12:00:00`))
const KIND_EYEBROW = { spring: 'Spring election · nonpartisan', fall: 'Fall election · partisan', other: 'Special election' }
const daysWord = (n) => `${n} ${n === 1 ? 'day' : 'days'}`
const createdDay = (iso) => {
  const d = iso ? new Date(iso) : null
  return d && !Number.isNaN(d.getTime()) ? localToday(d) : null
}

// ═══ Container: loads and writes; the view below is pure props ══════════════
export default function Playbook() {
  const { user } = useAuth()
  const [data, setData] = useState({ projects: [], sections: [], tasks: [], completed: [], elections: [], candidates: [] })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(() => new Set())
  const [starting, setStarting] = useState(false)
  const [notice, setNotice] = useState(null)
  const [toast, setToast] = useState(null)
  const toastTimer = useRef(null)
  const loadSeq = useRef(0)

  const load = useCallback(async () => {
    const seq = ++loadSeq.current
    const safe = (p) => Promise.resolve(p).catch(err => ({ data: [], error: err }))
    const [p, s, t, c, e, cand] = await Promise.all([
      safe(getTaskProjects()), safe(getTaskSections()), safe(getTasks()), safe(getCompletedTasks()),
      safe(getElections()), safe(getCandidates({})),
    ])
    if (seq !== loadSeq.current) return
    setData({
      projects: p.data || [], sections: s.data || [], tasks: t.data || [], completed: c.data || [],
      elections: e.data || [], candidates: cand.data || [],
    })
    setError(p.error || t.error ? "We couldn't load your playbook. Check your connection and refresh." : null)
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  // Realtime: a campaign manager (Campaign Connect) editing this plan, or the
  // candidate on another device, shows up here without a refresh.
  useEffect(() => {
    let dispose = () => {}, timer = null, cancelled = false
    subscribeTaskChanges(null, () => { clearTimeout(timer); timer = setTimeout(load, 800) })
      .then(fn => { if (cancelled) fn(); else dispose = fn })
    return () => { cancelled = true; clearTimeout(timer); dispose() }
  }, [load])

  // Keep the offline snapshot current, as TaskBoard does.
  useEffect(() => {
    if (loading) return
    primeTaskCaches(null, { projects: data.projects, sections: data.sections, tasks: data.tasks })
  }, [loading, data.projects, data.sections, data.tasks])

  useEffect(() => () => clearTimeout(toastTimer.current), [])

  const self = useMemo(() => resolveSelfCandidate(user, data.candidates), [user, data.candidates])

  const fail = (msg) => { setError(msg); load() }
  const mark = (id, on) => setBusy(prev => { const n = new Set(prev); on ? n.add(id) : n.delete(id); return n })

  const complete = async (task) => {
    if (busy.has(task.id)) return
    mark(task.id, true)
    if (task.recurrence?.freq) {
      const nextDue = nextOccurrence(task.recurrence, task.due_date)
      setData(d => ({ ...d, tasks: d.tasks.map(x => x.id === task.id ? { ...x, due_date: nextDue } : x) }))
      const { error: err } = await updateTask(task.id, { due_date: nextDue })
      mark(task.id, false)
      if (err) fail("Couldn't save that. Are you online?")
      return
    }
    const stamp = new Date().toISOString()
    const subIds = data.tasks.filter(x => x.parent_id === task.id && !x.completed).map(x => x.id)
    setData(d => ({
      ...d,
      tasks: d.tasks.filter(x => x.id !== task.id && x.parent_id !== task.id),
      completed: [{ ...task, completed: true, completed_at: stamp }, ...d.completed],
    }))
    clearTimeout(toastTimer.current)
    setToast(task)
    toastTimer.current = setTimeout(() => setToast(null), 6000)
    for (const id of [task.id, ...subIds]) {
      const { error: err } = await updateTask(id, { completed: true, completed_at: stamp })
      if (err) { mark(task.id, false); fail("Couldn't mark that done. Are you online?"); return }
    }
    mark(task.id, false)
  }

  const reopen = async (task) => {
    setToast(null)
    setData(d => ({
      ...d,
      completed: d.completed.filter(x => x.id !== task.id),
      tasks: [...d.tasks, { ...task, completed: false, completed_at: null }],
    }))
    const { error: err } = await updateTask(task.id, { completed: false, completed_at: null })
    if (err) fail("Couldn't undo that. Are you online?")
  }

  const addOwn = async ({ content, due_date, projectId }) => {
    const { data: row, error: err } = await createTask({
      content, due_date: due_date || null, project_id: projectId || null,
      labels: ['mine'], priority: 4, sort_order: Date.now() % 1e9,
    })
    if (err || !row) { fail("Couldn't add your step. Are you online?"); return false }
    setData(d => ({ ...d, tasks: [...d.tasks, row] }))
    return true
  }

  // Build a playbook for `race` ({ date, name }) and archive the ones it
  // replaces. Archive happens last, so a failed build never leaves the
  // candidate with nothing.
  const start = async ({ race, replace = [] }) => {
    const today = localToday()
    const cycle = raceCycle(race.date)
    const built = buildPlaybook(cycle, { today })
    if (!cycle || built.over || !built.steps.length) { setError('Pick an election that is still ahead.'); return }
    setStarting(true); setError(null)
    const { data: proj, error: pe } = await createTaskProject({
      name: playbookProjectName(race.name), color: '#C0392B', is_favorite: true, sort_order: 0,
    })
    if (pe || !proj) { setStarting(false); fail("Couldn't start your playbook. Are you online?"); return }
    const { data: secs, error: se } = await createTaskSectionsBatch(PHASES.map((p, i) => ({ project_id: proj.id, name: p.name, sort_order: i })))
    const sectionIdByPhase = Object.fromEntries((secs || []).map(s => [PHASES.find(p => p.name === s.name)?.key, s.id]))
    const { error: te } = se ? { error: se } : await createTasksBatch(playbookTaskRows(built, { projectId: proj.id, sectionIdByPhase, raceDate: cycle.electionDay }))
    if (te) {
      await deleteTaskProject(proj.id)   // the half-built one only; nothing old is touched
      setStarting(false); fail("Couldn't build your playbook. Nothing was changed. Try again?")
      return
    }
    for (const old of replace) await updateTaskProject(old.id, { archived: true })
    const catchUp = built.steps.filter(s => s.catchUp).length
    setNotice(`Your playbook for the ${race.name} is ready: ${built.steps.length} steps${catchUp ? `, ${catchUp} to catch up on this week` : ''}.`)
    setStarting(false)
    await load()
  }

  if (loading) return <LoadingBar loading />

  return (
    <>
      <PlaybookView
        today={localToday()}
        {...data}
        self={self}
        busy={busy}
        starting={starting}
        error={error}
        notice={notice}
        onDismissNotice={() => setNotice(null)}
        onComplete={complete}
        onReopen={reopen}
        onAddOwn={addOwn}
        onStart={start}
      />
      {toast && (
        <div role="status" className="fixed inset-x-0 bottom-6 z-toast mx-auto flex w-[min(92vw,420px)] items-center gap-3 rounded-2xl bg-brand-ink px-4 py-3 text-white shadow-e5">
          <Check className="h-4 w-4 flex-shrink-0 text-[#7EE2A8]" />
          <span className="min-w-0 flex-1 truncate text-[14px] font-medium">Done: {toast.content}</span>
          <button type="button" onClick={() => reopen(toast)} className="flex items-center gap-1 rounded-lg px-2 py-1 text-[13px] font-bold hover:bg-white/10">
            <Undo2 className="h-3.5 w-3.5" /> Undo
          </button>
        </div>
      )}
    </>
  )
}

// ═══ View ═══════════════════════════════════════════════════════════════════
// Everything below renders from props, so it can be drawn from in-memory data.
export function PlaybookView({
  today, projects = [], sections = [], tasks = [], completed = [], elections = [], self = null,
  busy = new Set(), starting = false, error = null, notice = null,
  onDismissNotice, onComplete, onReopen, onAddOwn, onStart,
}) {
  const allTasks = useMemo(() => [...tasks, ...completed], [tasks, completed])
  const snap = useMemo(() => playbookSnapshot({ projects, tasks: allTasks, elections, today }), [projects, allTasks, elections, today])
  const [switching, setSwitching] = useState(false)
  const [phaseFilter, setPhaseFilter] = useState(null)

  const active = snap.pick.active
  const banner = (
    <>
      {error && (
        <div role="alert" className="mb-4 flex items-start gap-2.5 rounded-xl bg-brand-red-wash px-4 py-3 text-[14px] font-medium text-brand-red-dark">
          <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" /> {error}
        </div>
      )}
      {notice && (
        <div role="status" className="mb-4 flex items-start gap-2.5 rounded-xl bg-[#E8F5EC] px-4 py-3 text-[14px] font-medium text-[#14532D]">
          <Check className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span className="flex-1">{notice}</span>
          {onDismissNotice && <button type="button" onClick={onDismissNotice} className="text-[13px] font-bold underline">OK</button>}
        </div>
      )}
    </>
  )

  // ── No live playbook: offer to start one (stale or never made) ────────────
  if (!active) {
    const stale = snap.pick.stale[0] || null
    const staleOpen = stale ? tasks.filter(t => t.project_id === stale.project.id && !t.parent_id && !t.completed) : []
    // With no live playbook there's no "This week" section, so the candidate's
    // own to-dos carry their this-week items as the first group.
    const loose = [
      ...(snap.thisWeek.length ? [{ key: 'week', label: 'This week', tasks: snap.thisWeek }] : []),
      ...groupByWeek(snap.scoped, today),
    ]
    return (
      <div className="pb-6">
        <PageHead
          eyebrow={stale ? 'Race over' : null}
          title={stale ? `The ${stale.race.name} is over` : 'Build your campaign playbook'}
          sub={stale
            ? `Election Day was ${fmtLong(stale.race.date)}. Start a fresh playbook for your next race. The old one is archived, not deleted.`
            : 'Every Wisconsin deadline and campaign step, dated from your election and grouped by week. Tick things off and add your own.'}
        />
        {banner}
        <StartPanel
          today={today} elections={elections} self={self} starting={starting}
          replace={snap.pick.stale.map(x => x.project)}
          onStart={onStart}
        />
        {stale && staleOpen.length > 0 && (
          <WrapUp race={stale.race} open={staleOpen} sections={sections} busy={busy} onComplete={onComplete} />
        )}
        {loose.length > 0 && (
          <Tile className="mt-4 p-5 md:p-6">
            <TileHead icon={ListChecks} color="gray" title="Your own to-dos" right={<CountBadge n={snap.scoped.length} color="gray" />} />
            <p className="mt-1 text-[14px] text-brand-mute">Steps you added yourself. They stay put when you start a new playbook.</p>
            <WeekGroups groups={loose} sections={sections} busy={busy} onComplete={onComplete} />
          </Tile>
        )}
      </div>
    )
  }

  // ── Live playbook ──────────────────────────────────────────────────────────
  const project = active.project
  const race = active.race
  const cycle = raceCycle(race.date)
  const daysLeft = daysUntil(race.date, nowFor(today))
  const primaryAhead = cycle?.primaryDay && cycle.primaryDay >= today
  const focus = snap.thisWeek
  const inPhase = (t) => !phaseFilter || phaseOfTask(t, sections) === phaseFilter
  const groups = groupByWeek(snap.scoped.filter(inPhase), today)
  const progress = phaseProgress({ projectId: project.id, sections, tasks, completed })
  const doneHere = completed.filter(t => t.project_id === project.id && !t.parent_id)
  const made = createdDay(project.created_at)
  const leftOut = made && cycle ? buildPlaybook(cycle, { today: made }).leftOut : []

  return (
    <div className="pb-6">
      <PageHead
        // On a phone the title block takes the whole row so the countdown
        // wraps under it instead of squeezing the title into a sliver.
        className="[&>div:first-child]:basis-full sm:[&>div:first-child]:basis-0"
        eyebrow={KIND_EYEBROW[cycle?.kind] || 'Your race'}
        title={race.name}
        sub={<>
          {fmtLong(race.date)}
          {primaryAhead && <> · Primary {fmtShort(cycle.primaryDay)}, if your race has one</>}
        </>}
        right={<>
          {daysLeft != null && daysLeft >= 0 && (
            <div className="mr-1 text-right">
              <div className="text-[34px] font-extrabold leading-none tracking-display text-brand-red">{daysLeft === 0 ? 'Today' : daysLeft}</div>
              <div className="mt-0.5 text-[12.5px] font-semibold text-brand-mute">{daysLeft === 0 ? 'is Election Day' : `${daysLeft === 1 ? 'day' : 'days'} to Election Day`}</div>
            </div>
          )}
          <Button variant="secondary" icon={Repeat} onClick={() => setSwitching(v => !v)} aria-expanded={switching}>Switch race</Button>
        </>}
      />
      {banner}

      {switching && (
        <StartPanel
          today={today} elections={elections} self={self} starting={starting} light
          current={race}
          replace={[project, ...snap.pick.stale.map(x => x.project)]}
          onStart={async (args) => { await onStart(args); setSwitching(false) }}
          onCancel={() => setSwitching(false)}
        />
      )}

      {/* This week */}
      <section aria-labelledby="pb-week" className="mt-1">
        <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 id="pb-week" className="display text-[22px]">This week</h2>
          <span className="text-[14px] font-medium text-brand-mute">{fmtShort(weekStart(today))} to {fmtShort(weekEnd(today))} · {focus.length} {focus.length === 1 ? 'step' : 'steps'}</span>
        </div>
        {focus.length ? (
          <FocusCards items={focus} today={today} sections={sections} busy={busy} onComplete={onComplete} />
        ) : (
          <Tile className="p-6">
            <EmptyState
              icon={Check} color="green" title="Nothing due this week"
              body={groups[0]?.tasks[0]
                ? `Next up: ${groups[0].tasks[0].content}${groups[0].tasks[0].due_date ? `, ${fmtDay(groups[0].tasks[0].due_date)}` : ''}.`
                : 'Add a step of your own below.'}
            />
          </Tile>
        )}
      </section>

      {/* Phase strip */}
      <section aria-labelledby="pb-phases" className="mt-8">
        <div className="mb-3 flex flex-wrap items-baseline gap-x-3">
          <h2 id="pb-phases" className="display text-[22px]">Phases</h2>
          <span className="text-[14px] font-medium text-brand-mute">Tap one to see just its steps</span>
        </div>
        <PhaseStrip progress={progress} selected={phaseFilter} onSelect={(k) => setPhaseFilter(f => (f === k ? null : k))} />
      </section>

      {/* The rest of the plan */}
      <section aria-labelledby="pb-plan" className="mt-8">
        <Tile className="p-5 md:p-6">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <h2 id="pb-plan" className="display text-[22px]">The rest of the plan</h2>
            {phaseFilter && (
              <button type="button" onClick={() => setPhaseFilter(null)} className="inline-flex items-center gap-1.5 rounded-full bg-brand-gray px-3 py-1 text-[13px] font-semibold text-brand-ink">
                <span className="h-2 w-2 rounded-full" style={{ background: colorOf(phaseFilter) }} />
                {phaseMeta(phaseFilter)?.name} only · Show all
              </button>
            )}
          </div>
          <AddOwnStep today={today} onAdd={(row) => onAddOwn?.({ ...row, projectId: project.id })} />
          {groups.length
            ? <WeekGroups groups={groups} sections={sections} busy={busy} onComplete={onComplete} />
            : <p className="mt-5 text-[14px] text-brand-mute">{phaseFilter ? 'Nothing left in this phase after this week.' : 'Nothing scheduled after this week.'}</p>}
          <DoneList items={doneHere} onReopen={onReopen} />
        </Tile>
      </section>

      {leftOut.length > 0 && (
        <div className="mt-4 rounded-xl border border-black/5 bg-white/60 px-4 py-3 text-[13.5px] leading-relaxed text-brand-mute">
          <span className="font-semibold text-brand-ink">Left out because their window had closed when you started: </span>
          {leftOut.map(x => x.note).join(' ')}
        </div>
      )}
    </div>
  )
}

// ─── Start panel (dark hero when there's no live playbook) ──────────────────
function StartPanel({ today, elections, self, starting, replace = [], current = null, light = false, onStart, onCancel }) {
  const options = useMemo(() => raceOptions(elections, today).filter(o => o.date !== current?.date), [elections, today, current])
  const suggested = useMemo(() => {
    const n = nextRace({ self, elections, today })
    const c = n ? raceCycle(String(n.election_date).slice(0, 10)) : null
    return c && c.electionDay !== current?.date && c.electionDay >= today ? c.electionDay : (options[0]?.date || '')
  }, [self, elections, today, options, current])
  const [choice, setChoice] = useState(suggested || 'custom')
  const [customDate, setCustomDate] = useState('')
  useEffect(() => { if (suggested) setChoice(suggested) }, [suggested])

  const date = choice === 'custom' ? customDate : choice
  const cycle = date && date >= today ? raceCycle(date) : null
  const name = cycle ? (options.find(o => o.date === cycle.electionDay)?.name || cycleName(cycle, elections)) : ''
  const built = cycle ? buildPlaybook(cycle, { today }) : null
  const catchUp = built ? built.steps.filter(s => s.catchUp).length : 0
  const daysAway = cycle ? daysUntil(cycle.electionDay, nowFor(today)) : null
  const canGo = Boolean(cycle && built && !built.over && built.steps.length && !starting)
  const archiving = replace.filter(Boolean)

  const selectCls = light
    ? 'input mt-1.5 text-[15px]'
    : 'mt-1.5 w-full rounded-xl border border-white/20 bg-white/10 px-3 py-2.5 text-[15px] text-white focus:outline-none focus:ring-2 focus:ring-white/40 [color-scheme:dark]'

  return (
    <Tile dark={!light} className={cx('mb-4 p-5 md:p-7', light && 'ring-1 ring-black/5')}>
      <div className="relative grid gap-6 lg:grid-cols-[1.2fr_1fr]">
        <div className="min-w-0">
          <TileHead dark={!light} icon={ListChecks} color="ink" title={current ? 'Switch to another race' : 'Start your playbook'} />
          <div className={cx('mt-5 text-[26px] font-extrabold leading-tight tracking-display md:text-[32px]', light ? 'text-brand-ink' : 'text-white')}>
            {cycle ? <>Your playbook for the {name}</> : 'Pick your election'}
          </div>
          {cycle && (
            <p className={cx('mt-1.5 text-[15px]', light ? 'text-brand-mute' : 'text-white/70')}>
              {fmtLong(cycle.electionDay)}{daysAway != null && daysAway >= 0 ? ` · ${daysWord(daysAway)} away` : ''}
            </p>
          )}
          {built && !built.over && (
            <ul className={cx('mt-4 space-y-1.5 text-[15px]', light ? 'text-brand-ink' : 'text-white/90')}>
              <li><b>{built.steps.length} steps</b>, dated from Election Day and grouped by week</li>
              {catchUp > 0 && <li><b>{catchUp}</b> {catchUp === 1 ? 'step is' : 'steps are'} already due, so {catchUp === 1 ? 'it goes' : 'they go'} in “Catch up” this week</li>}
              {built.leftOut.map(x => <li key={x.key} className={light ? 'text-brand-mute' : 'text-white/70'}>{x.note}</li>)}
            </ul>
          )}
        </div>
        <div className="min-w-0">
          <label className={cx('block text-[13px] font-bold uppercase tracking-[0.1em]', light ? 'text-brand-mute' : 'text-white/60')} htmlFor="pb-race">Election</label>
          <select id="pb-race" className={selectCls} value={choice} onChange={e => setChoice(e.target.value)}>
            {options.map(o => <option key={o.date} value={o.date} className="text-brand-ink">{o.name} · {fmtShort(o.date, true)}</option>)}
            <option value="custom" className="text-brand-ink">Another date…</option>
          </select>
          {choice === 'custom' && (
            <>
              <label className={cx('mt-3 block text-[13px] font-bold uppercase tracking-[0.1em]', light ? 'text-brand-mute' : 'text-white/60')} htmlFor="pb-date">Election date</label>
              <input id="pb-date" type="date" min={today} className={selectCls} value={customDate} onChange={e => setCustomDate(e.target.value)} />
            </>
          )}
          <Button
            variant={light ? 'dark' : 'primary'}
            className="mt-4 w-full py-3 text-[15px]"
            disabled={!canGo}
            onClick={() => onStart?.({ race: { date: cycle.electionDay, name }, replace: archiving })}
          >
            {starting ? 'Building your playbook…' : cycle ? `Start your playbook for the ${name}` : 'Pick a date first'}
          </Button>
          {archiving.length > 0 && (
            <p className={cx('mt-2.5 flex items-start gap-1.5 text-[13px] leading-snug', light ? 'text-brand-mute' : 'text-white/60')}>
              <Archive className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
              {archiving.length === 1 ? `“${archiving[0].name}” is archived, with what you checked off.` : `${archiving.length} older playbooks are archived, with what you checked off.`}
            </p>
          )}
          {onCancel && <button type="button" onClick={onCancel} className="mt-2 w-full text-center text-[13px] font-semibold text-brand-mute hover:text-brand-ink">Keep my current playbook</button>}
        </div>
      </div>
    </Tile>
  )
}

// ─── This week: big cards with a one-tap Done ───────────────────────────────
function dueChip(t, today) {
  if (isCatchUp(t) && t.due_date <= today) return { text: 'Catch up', tone: 'red' }
  if (t.due_date < today) return { text: `Was due ${fmtShort(t.due_date)}`, tone: 'red' }
  if (t.due_date === today) return { text: 'Today', tone: 'ink' }
  return { text: fmtDay(t.due_date), tone: 'mute' }
}

function FocusCards({ items, today, sections, busy, onComplete }) {
  const [all, setAll] = useState(false)
  const shown = all ? items : items.slice(0, 6)
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {shown.map(t => {
          const ph = phaseOfTask(t, sections)
          const chip = dueChip(t, today)
          return (
            <article key={t.id} className="flex min-w-0 flex-col overflow-hidden rounded-tile bg-white shadow-e2" style={{ borderTop: `5px solid ${colorOf(ph)}` }}>
              <div className="flex flex-1 flex-col p-5">
                <div className="flex items-center justify-between gap-2 text-[12px] font-bold uppercase tracking-[0.08em]">
                  <span style={{ color: colorOf(ph) }}>{ph ? phaseMeta(ph).name : 'Your step'}</span>
                  <span className={cx('rounded-full px-2 py-0.5 normal-case tracking-normal',
                    chip.tone === 'red' ? 'bg-brand-red-wash text-brand-red' : chip.tone === 'ink' ? 'bg-brand-ink text-white' : 'bg-brand-gray text-brand-mute')}>{chip.text}</span>
                </div>
                <h3 className="mt-2 text-[17px] font-bold leading-snug text-brand-ink">{t.content}</h3>
                {t.description && <p className="mt-1.5 text-[14px] leading-relaxed text-brand-mute">{t.description}</p>}
                <div className="mt-auto pt-4">
                  <button
                    type="button"
                    onClick={() => onComplete?.(t)}
                    disabled={busy.has(t.id)}
                    aria-label={`Done: ${t.content}`}
                    className="inline-flex items-center gap-2 rounded-xl bg-brand-ink px-5 py-2.5 text-[15px] font-bold text-white transition-colors hover:bg-black disabled:opacity-60"
                  >
                    <Check className="h-4 w-4" /> Done
                  </button>
                </div>
              </div>
            </article>
          )
        })}
      </div>
      {items.length > 6 && (
        <button type="button" onClick={() => setAll(v => !v)} className="mt-3 text-[14px] font-semibold text-brand-ink underline-offset-2 hover:underline">
          {all ? 'Show fewer' : `Show ${items.length - 6} more this week`}
        </button>
      )}
    </>
  )
}

// ─── Phase strip: columns with a colored top edge ───────────────────────────
function PhaseStrip({ progress, selected, onSelect }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {progress.map(p => {
        const color = ICON_COLORS[p.color]
        const pct = p.total ? Math.round((p.done / p.total) * 100) : 0
        const on = selected === p.key
        const left = p.total - p.done
        return (
          <button
            key={p.key}
            type="button"
            onClick={() => onSelect?.(p.key)}
            aria-pressed={on}
            className={cx('flex min-w-0 flex-col rounded-tile bg-white p-4 text-left shadow-e2 transition-shadow hover:shadow-e4', on && 'ring-2 ring-brand-ink')}
            style={{ borderTop: `5px solid ${color}` }}
          >
            <div className="flex w-full items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-[15px] font-bold text-brand-ink">{p.name}</span>
              <CountBadge n={left} color={left ? p.color : 'gray'} />
            </div>
            <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-black/[0.07]" aria-hidden="true">
              <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
            </div>
            <div className="mt-1.5 text-[12.5px] font-semibold text-brand-mute">{p.total ? `${p.done} of ${p.total} done` : 'No steps'}</div>
            {p.next
              ? <div className="mt-2 line-clamp-2 text-[13px] leading-snug text-brand-ink">Next: {p.next.content}</div>
              : p.total > 0 && <div className="mt-2 text-[13px] font-semibold" style={{ color }}>All done</div>}
          </button>
        )
      })}
    </div>
  )
}

// ─── Weekly groups (one-tap complete rows) ──────────────────────────────────
function WeekGroups({ groups, sections, busy, onComplete }) {
  return (
    <div className="mt-4 space-y-6">
      {groups.map(g => (
        <div key={g.key}>
          <div className="mb-1 flex items-center gap-2 border-b border-black/5 pb-2">
            <h3 className={cx('text-[13px] font-extrabold uppercase tracking-[0.1em]', g.label === 'Past due' ? 'text-brand-red' : 'text-brand-ink')}>{g.label}</h3>
            <span className="text-[13px] font-semibold text-brand-faint">{g.tasks.length}</span>
          </div>
          <ul>
            {g.tasks.map(t => <StepRow key={t.id} t={t} sections={sections} busy={busy.has(t.id)} onComplete={onComplete} />)}
          </ul>
        </div>
      ))}
    </div>
  )
}

function StepRow({ t, sections, busy, onComplete }) {
  const ph = phaseOfTask(t, sections)
  return (
    <li className="flex items-start gap-3 py-3">
      <button
        type="button"
        onClick={() => onComplete?.(t)}
        disabled={busy}
        aria-label={`Mark done: ${t.content}`}
        className="group mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border-2 border-black/25 transition-colors hover:border-brand-ink hover:bg-brand-ink"
      >
        <Check className="h-3.5 w-3.5 text-white opacity-0 group-hover:opacity-100" />
      </button>
      <div className="min-w-0 flex-1">
        <div className="text-[15px] font-semibold leading-snug text-brand-ink">{t.content}</div>
        {t.description && <div className="mt-0.5 line-clamp-2 text-[13.5px] leading-snug text-brand-mute">{t.description}</div>}
      </div>
      <div className="flex flex-shrink-0 flex-col items-end gap-1 pt-0.5 text-right">
        <span className="whitespace-nowrap text-[13px] font-semibold text-brand-ink">{t.due_date ? fmtDay(t.due_date) : ''}</span>
        <span className="hidden items-center gap-1.5 text-[12px] font-medium text-brand-mute sm:inline-flex">
          <span className="h-2 w-2 rounded-full" style={{ background: ph ? colorOf(ph) : ICON_COLORS.gray }} />
          {ph ? phaseMeta(ph).name : isOwnStep(t) ? 'Your step' : ''}
        </span>
      </div>
    </li>
  )
}

// ─── Add your own step ──────────────────────────────────────────────────────
function AddOwnStep({ today, onAdd }) {
  const [content, setContent] = useState('')
  const [due, setDue] = useState(today)
  const [saving, setSaving] = useState(false)
  const submit = async (e) => {
    e.preventDefault()
    const text = content.trim()
    if (!text || saving) return
    setSaving(true)
    const ok = await onAdd?.({ content: text, due_date: due || null })
    setSaving(false)
    if (ok !== false) { setContent(''); setDue(today) }
  }
  return (
    <form onSubmit={submit} className="mt-4 flex flex-col gap-2 rounded-xl bg-brand-gray p-2 sm:flex-row sm:items-center">
      <label className="sr-only" htmlFor="pb-own">Add your own step</label>
      <input
        id="pb-own" className="input flex-1 border-transparent py-2.5 text-[15px]" placeholder="Add your own step, like “Call the county party chair”"
        value={content} onChange={e => setContent(e.target.value)} maxLength={300}
      />
      <div className="flex gap-2">
        <label className="sr-only" htmlFor="pb-own-date">Date</label>
        <input id="pb-own-date" type="date" className="input w-auto flex-1 border-transparent py-2.5 text-[15px] sm:flex-none" value={due} onChange={e => setDue(e.target.value)} />
        <Button type="submit" variant="dark" icon={Plus} disabled={!content.trim() || saving}>Add</Button>
      </div>
    </form>
  )
}

// ─── Done (collapsed count you can open) ────────────────────────────────────
function DoneList({ items, onReopen }) {
  const [open, setOpen] = useState(false)
  if (!items.length) return null
  const sorted = [...items].sort((a, b) => String(b.completed_at || '').localeCompare(String(a.completed_at || '')))
  return (
    <div className="mt-6 border-t border-black/5 pt-4">
      <button type="button" onClick={() => setOpen(v => !v)} aria-expanded={open} className="flex items-center gap-2 text-[15px] font-bold text-brand-ink">
        {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        Done <CountBadge n={items.length} color="green" />
      </button>
      {open && (
        <ul className="mt-2">
          {sorted.map(t => (
            <li key={t.id} className="flex items-center gap-3 py-2.5">
              <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-[#16803C] text-white"><Check className="h-3.5 w-3.5" /></span>
              <span className="min-w-0 flex-1 text-[15px] text-brand-mute line-through decoration-black/20">{t.content}</span>
              <button type="button" onClick={() => onReopen?.(t)} className="flex-shrink-0 rounded-lg px-2 py-1 text-[13px] font-semibold text-brand-mute hover:bg-black/5 hover:text-brand-ink">Undo</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// ─── Wrap-up for a playbook whose race is over ──────────────────────────────
function WrapUp({ race, open, sections, busy, onComplete }) {
  const [show, setShow] = useState(false)
  const sorted = [...open].sort((a, b) => String(a.due_date || '').localeCompare(String(b.due_date || '')))
  return (
    <Tile className="p-5 md:p-6">
      <TileHead icon={CalendarDays} color="gray" title={`Left open from the ${race.name}`} right={<CountBadge n={open.length} color="gray" />} />
      <p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-brand-mute">
        {open.length === 1 ? 'One step was' : `${open.length} steps were`} still open when that race ended. They're archived with the old playbook when you start the new one, so nothing here is overdue any more.
      </p>
      <button type="button" onClick={() => setShow(v => !v)} aria-expanded={show} className="mt-3 flex items-center gap-1.5 text-[14px] font-semibold text-brand-ink">
        {show ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />} {show ? 'Hide them' : 'See them'}
      </button>
      {show && <ul className="mt-1">{sorted.map(t => <StepRow key={t.id} t={t} sections={sections} busy={busy.has(t.id)} onComplete={onComplete} />)}</ul>}
    </Tile>
  )
}
