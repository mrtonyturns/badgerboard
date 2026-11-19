// src/pages/dashboard/FieldHome.jsx — the Candidate-plan home screen.
//
// v2.0 facelift (Nov 2026): a tile home in the mycandidatepage.com dashboard
// style — "What would you like to see?" over a grid of big tiles, each one a
// door into a part of the app. The dark hero tile is the campaign playbook
// (this week's to-dos, tick them off right here); the rest show one number
// or one line that matters and open their page.
//
// Tiles follow the plan lineup (tiers.js): a tile whose feature the plan
// doesn't include is not shown. Nothing here invents a number — a figure the
// app can't know yet is left out, not shown as a dash.

import { useEffect, useMemo, useState } from 'react'
import { format } from 'date-fns'
import {
  ListChecks, Users, FileText, CalendarDays, Swords, Users2, HandHeart, Check, Footprints,
} from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { supabase, getDashboardBootstrap, getCandidates, getElections, getDossiers, getTasks, getTaskProjects, updateTask } from '../../lib/supabase'
import { playbookSnapshot, localToday } from '../../lib/playbook.js'
import { getUserPlan, hasFeature, getUserTier } from '../../lib/tiers'
import { isNativeApp } from '../../lib/native'
import { resolveSelfCandidate } from './CandidateDashboard'
import { firstNameOf, officeLine, daysUntil, isUpcoming, isThisWeek } from './shared'
import { Tile, TileHead, BigNumber, OpenCue, Avatar, ICON_COLORS } from '../../components/ui'
import LoadingBar from '../../components/LoadingBar'

const todayISO = () => format(new Date(), 'yyyy-MM-dd')

// Faint outline icon in a tile's bottom-right corner (the mycandidatepage watermark).
function Watermark({ icon: Icon, color }) {
  return (
    <Icon
      aria-hidden="true"
      className="pointer-events-none absolute -bottom-5 -right-4 h-32 w-32"
      style={{ color, opacity: 0.09 }}
      strokeWidth={1.4}
    />
  )
}

// Thin arcs behind the hero tile's numbers.
function HeroArcs() {
  return (
    <svg aria-hidden="true" viewBox="0 0 600 320" preserveAspectRatio="none" className="pointer-events-none absolute inset-x-0 bottom-0 h-[62%] w-full opacity-60">
      {[0, 1, 2, 3].map(i => (
        <ellipse key={i} cx="300" cy={360 + i * 26} rx={330 - i * 30} ry={170 - i * 12} fill="none" stroke="#5B8CFF" strokeOpacity={0.35 - i * 0.07} strokeWidth="1.2" />
      ))}
      {Array.from({ length: 22 }).map((_, i) => {
        const t = (i / 21) * Math.PI
        return <circle key={i} cx={300 - Math.cos(t) * 300} cy={360 - Math.sin(t) * 160} r="2" fill="#8FB0FF" fillOpacity="0.7" />
      })}
    </svg>
  )
}

export default function FieldHome() {
  const { user } = useAuth()
  const plan = getUserPlan(user)
  const isPaid = getUserTier(user) !== 'scout'
  const [loading, setLoading]       = useState(true)
  const [candidates, setCandidates] = useState([])
  const [elections, setElections]   = useState([])
  const [dossiers, setDossiers]     = useState([])
  const [tasks, setTasks]           = useState([])
  const [projects, setProjects]     = useState([])
  const [volunteers, setVolunteers] = useState(null)
  const [busy, setBusy]             = useState(null)

  useEffect(() => {
    let dead = false
    ;(async () => {
      const boot = await getDashboardBootstrap(8)
      const [c, e, d] = boot
        ? [{ data: boot.candidates }, { data: boot.elections }, { data: boot.dossiers }]
        : await Promise.all([getCandidates({}), getElections(), getDossiers(null, { list: true })])
      const [t, v, p] = await Promise.all([
        getTasks().catch(() => ({ data: [] })),
        user?.id
          ? supabase.from('volunteers').select('id', { count: 'exact', head: true }).eq('created_by', user.id)
          : Promise.resolve({ count: null }),
        getTaskProjects().catch(() => ({ data: [] })),
      ])
      if (dead) return
      setCandidates(c.data || [])
      setElections(e.data || [])
      setDossiers(d.data || [])
      setTasks((t.data || []).filter(x => !x.parent_id && !x.completed))
      setProjects(p?.data || [])
      setVolunteers(v?.error ? null : (v?.count ?? null))
      setLoading(false)
    })()
    return () => { dead = true }
  }, [user?.id])

  const self = useMemo(() => resolveSelfCandidate(user, candidates), [user, candidates])
  const opponents = useMemo(() => candidates.filter(c => c.id !== self?.id), [candidates, self])

  // The race: the self record's election if it's upcoming, else the soonest upcoming election.
  const race = useMemo(() => {
    if (self?.election?.election_date && isUpcoming(self.election.election_date)) return self.election
    return elections.find(e => e.id === self?.election_id && isUpcoming(e.election_date))
      || elections.filter(e => isUpcoming(e.election_date)).sort((a, b) => String(a.election_date).localeCompare(String(b.election_date)))[0]
      || null
  }, [elections, self])
  const daysLeft = race ? daysUntil(race.election_date) : null

  // This week's to-dos come from the playbook module: the same rule the
  // Playbook screen uses, so the two always agree. A playbook whose race is
  // over is the Playbook screen's job to retire, never this tile's to shout
  // about as hundreds of days overdue.
  const playbook = useMemo(() => playbookSnapshot({ projects, tasks, elections, today: localToday() }), [projects, tasks, elections])
  const todos = playbook.thisWeek
  const overdue = todos.filter(t => t.due_date < todayISO()).length
  const emptyLine = playbook.state === 'stale'
    ? `The ${playbook.staleRace?.name || 'last race'} is over. Open the playbook to start the next one.`
    : playbook.state === 'none'
      ? 'Open the playbook to build your plan from your election date.'
      : "Nothing due this week. Open the playbook to see what's next."

  // What changed with each opponent this week (from weekly monitoring digests).
  const opponentNews = useMemo(() => opponents.map(o => {
    const mine = dossiers
      .filter(d => d.candidate_id === o.id)
      .sort((a, b) => String(b.generated_at || '').localeCompare(String(a.generated_at || '')))
    const week = mine.find(d => d.weekly_digest && isThisWeek(d.generated_at))
    return { o, items: week?.weekly_digest?.items || [], last: mine[0]?.generated_at || null }
  }), [opponents, dossiers])
  const newThisWeek = opponentNews.reduce((n, x) => n + x.items.length, 0)

  const latestProfile = useMemo(() => [...dossiers]
    .sort((a, b) => String(b.generated_at || '').localeCompare(String(a.generated_at || '')))[0] || null, [dossiers])
  const profileName = latestProfile ? (candidates.find(c => c.id === latestProfile.candidate_id)?.name || latestProfile.title || '') : ''

  const completeTask = async (e, t) => {
    e.preventDefault(); e.stopPropagation()
    setBusy(t.id)
    const { error } = await updateTask(t.id, { completed: true, completed_at: new Date().toISOString() })
    if (!error) setTasks(prev => prev.filter(x => x.id !== t.id))
    setBusy(null)
  }

  if (loading) return <LoadingBar loading />

  const can = (f) => hasFeature(plan, f)
  const lower = [
    can('events') && {
      key: 'events', to: '/events', icon: CalendarDays, color: 'orange', title: 'Events',
      big: 'Show up', line: 'Fairs, forums and meetings in your district worth your time.',
    },
    can('broadside') && !isNativeApp && {
      key: 'broadside', to: '/broadside', icon: Swords, color: 'purple', title: 'Broadside',
      big: 'Practice', line: opponents.length ? `Debate an AI version of ${opponents[0].name.split(' ')[0]} out loud.` : 'Debate an AI opponent out loud before the real one.',
    },
    isPaid && {
      key: 'connect', to: '/campaign-connect', icon: Users2, color: 'blue', title: 'Campaign Connect',
      big: 'Your team', line: 'Share your account with a campaign manager or consultant.',
    },
    {
      key: 'volunteers', icon: HandHeart, color: 'green', title: 'Volunteers',
      big: volunteers ?? 0, unit: volunteers === 1 ? 'person signed up' : 'people signed up',
      line: 'Door knocking is coming next — volunteers will get their lists here.', soon: true,
    },
  ].filter(Boolean)

  return (
    <div className="pt-6">
      {/* Greeting + the race */}
      <div className="mb-5 flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div className="min-w-0">
          <h1 className="display text-[28px] leading-tight md:text-[34px]">What would you like to see, {firstNameOf(user)}?</h1>
          {self && (
            <p className="mt-1 text-[15px] text-brand-mute">
              {self.name}{officeLine(self.office) ? ` · ${officeLine(self.office)}` : ''}
            </p>
          )}
        </div>
        {race && daysLeft !== null ? (
          <p className="text-[15px] font-semibold text-brand-mute">
            <span className="text-brand-red">{daysLeft} {daysLeft === 1 ? 'day' : 'days'}</span> to {race.name || 'Election Day'}
          </p>
        ) : null}
      </div>

      {/* Row 1: playbook hero · opponents · profiles */}
      <div className="grid gap-4 lg:grid-cols-[1.55fr_1fr_1fr]">
        <Tile dark to="/game-plan" className="min-h-[340px] p-6" ariaLabel="Open your playbook">
          <HeroArcs />
          <div className="relative flex h-full flex-col">
            <TileHead dark icon={ListChecks} title="Playbook" />
            <div className="mt-5">
              <BigNumber dark value={todos.length} unit={todos.length === 1 ? 'thing to do this week' : 'things to do this week'} size={64} />
              {overdue > 0 && <p className="mt-1 text-[14px] font-semibold text-[#FF8A80]">{overdue} past due</p>}
            </div>
            <ul className="mt-4 flex flex-col gap-1.5">
              {todos.slice(0, 3).map(t => (
                <li key={t.id} className="flex items-center gap-3">
                  <button
                    type="button"
                    aria-label={`Mark done: ${t.content}`}
                    disabled={busy === t.id}
                    onClick={(e) => completeTask(e, t)}
                    className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border-2 border-white/50 hover:border-white hover:bg-white/10"
                  >
                    {busy === t.id && <Check className="h-3.5 w-3.5" />}
                  </button>
                  <span className="min-w-0 flex-1 truncate text-[15px] font-medium">{t.content}</span>
                  <span className={`text-[12.5px] ${t.due_date < todayISO() ? 'text-[#FF8A80]' : 'text-white/60'}`}>
                    {t.due_date === todayISO() ? 'Today' : format(new Date(`${t.due_date}T12:00:00`), 'EEE MMM d')}
                  </span>
                </li>
              ))}
              {todos.length === 0 && <li className="text-[15px] text-white/70">{emptyLine}</li>}
            </ul>
            <div className="mt-auto flex justify-end pt-5"><OpenCue dark /></div>
          </div>
        </Tile>

        <Tile to="/candidates" className="flex min-h-[340px] flex-col p-6">
          <TileHead icon={Users} color="red" title="Opponents" />
          <div className="mt-5">
            <BigNumber value={opponents.length} unit={opponents.length === 1 ? 'opponent tracked' : 'opponents tracked'} />
            {newThisWeek > 0 && <p className="mt-1 text-[14px] font-semibold text-brand-red">{newThisWeek} new {newThisWeek === 1 ? 'item' : 'items'} this week</p>}
          </div>
          <ul className="mt-4 flex flex-col gap-2.5">
            {opponentNews.slice(0, 4).map(({ o, items }) => (
              <li key={o.id} className="flex items-center gap-2.5">
                <Avatar name={o.name} photo={o.photo_url} size={28} color={ICON_COLORS.ink} />
                <span className="min-w-0 flex-1 truncate text-[15px] font-semibold">{o.name}</span>
                {items.length > 0 && <span className="h-2 w-2 rounded-full bg-brand-red" aria-label="new this week" />}
              </li>
            ))}
            {opponents.length === 0 && <li className="text-[14px] leading-relaxed text-brand-mute">Add who you're running against. We'll research them and tell you each Monday what changed.</li>}
          </ul>
          <div className="mt-auto pt-5"><OpenCue label={opponents.length ? 'Open' : 'Add an opponent'} /></div>
        </Tile>

        <Tile to="/profiler" className="flex min-h-[340px] flex-col p-6">
          <TileHead icon={FileText} color="ink" title="Profiles" />
          <div className="mt-5">
            <BigNumber value={dossiers.length} unit={dossiers.length === 1 ? 'research profile' : 'research profiles'} />
          </div>
          {latestProfile ? (
            <div className="relative mt-5 flex-1">
              {/* a small "document" — the newest profile */}
              <div className="absolute left-3 top-2 h-full w-[78%] rotate-[-3deg] rounded-xl bg-[#F1F3F6]" aria-hidden="true" />
              <div className="relative w-[82%] rounded-xl border border-black/5 bg-white p-4 shadow-e2">
                <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-brand-red">Political profile</div>
                <div className="mt-1 truncate text-[17px] font-extrabold tracking-display">{profileName || 'Profile'}</div>
                <div className="mt-3 space-y-1.5" aria-hidden="true">
                  {[100, 92, 96, 70].map((w, i) => <div key={i} className="h-1.5 rounded-full bg-black/10" style={{ width: `${w}%` }} />)}
                </div>
              </div>
            </div>
          ) : (
            <p className="mt-4 text-[14px] leading-relaxed text-brand-mute">A full research profile on any candidate in Wisconsin: record, money, positions, weak spots.</p>
          )}
          <div className="mt-auto pt-5"><OpenCue /></div>
        </Tile>
      </div>

      {/* Row 2: one tile per remaining tool */}
      <div className={`mt-4 grid gap-4 sm:grid-cols-2 ${lower.length >= 4 ? 'lg:grid-cols-4' : 'lg:grid-cols-3'}`}>
        {lower.map(t => (
          <Tile key={t.key} to={t.to} className="flex min-h-[230px] flex-col p-5">
            <Watermark icon={t.soon ? Footprints : t.icon} color={ICON_COLORS[t.color]} />
            <TileHead icon={t.icon} color={t.color} title={t.title} />
            <div className="mt-4">
              {typeof t.big === 'number'
                ? <BigNumber value={t.big} unit={t.unit} size={38} />
                : <div className="text-[30px] font-extrabold leading-none tracking-display">{t.big}</div>}
            </div>
            <p className="mt-2 max-w-[24ch] text-[14px] leading-relaxed text-brand-mute">{t.line}</p>
            {t.to && <div className="relative mt-auto pt-4"><OpenCue /></div>}
          </Tile>
        ))}
      </div>
    </div>
  )
}
