// src/pages/dashboard/FieldHome.jsx — the Candidate-plan home screen.
//
// Nov 15 2026 revamp (Tony): Candidate plans drop the old dashboard for a
// field home — the campaign's week at a glance. v0 shows what exists today:
// the next race, this week's to-dos (Game Plan), what changed with opponents
// (weekly monitoring) and the volunteer count. Doors knocked, yard signs to
// drop off and website sign-ups join as the door-knocking app and the
// campaign-website connection ship; until then the Field card says so plainly
// instead of showing invented numbers.

import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { endOfWeek, format } from 'date-fns'
import { useAuth } from '../../contexts/AuthContext'
import { supabase, getDashboardBootstrap, getCandidates, getElections, getDossiers, getTasks, updateTask } from '../../lib/supabase'
import { resolveSelfCandidate } from './CandidateDashboard'
import {
  T, DashboardShell, DashboardSkeleton, Card, CardHead, Pill, PartyPill,
  firstNameOf, officeLine, daysUntil, isUpcoming, isThisWeek,
} from './shared'

const todayISO = () => format(new Date(), 'yyyy-MM-dd')

function Stat({ label, value, sub, onClick }) {
  const Tag = onClick ? 'button' : 'div'
  return (
    <Tag onClick={onClick} style={{
      textAlign: 'left', background: T.page, border: `1px solid ${T.divider}`, borderRadius: 12,
      padding: '12px 14px', cursor: onClick ? 'pointer' : 'default', minWidth: 0,
    }}>
      <div style={{ fontSize: 11.5, color: T.muted, fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, marginTop: 2, color: value === null ? T.faint : T.ink }}>
        {value === null ? '—' : value}
      </div>
      {sub && <div style={{ fontSize: 11, color: T.faint, marginTop: 2, lineHeight: 1.4 }}>{sub}</div>}
    </Tag>
  )
}

export default function FieldHome() {
  const { user } = useAuth()
  const nav = useNavigate()
  const [loading, setLoading]       = useState(true)
  const [candidates, setCandidates] = useState([])
  const [elections, setElections]   = useState([])
  const [dossiers, setDossiers]     = useState([])
  const [tasks, setTasks]           = useState([])
  const [volunteers, setVolunteers] = useState(null)
  const [busy, setBusy]             = useState(null)

  useEffect(() => {
    let dead = false
    ;(async () => {
      const boot = await getDashboardBootstrap(8)
      const [c, e, d] = boot
        ? [{ data: boot.candidates }, { data: boot.elections }, { data: boot.dossiers }]
        : await Promise.all([getCandidates({}), getElections(), getDossiers(null, { list: true })])
      const [t, v] = await Promise.all([
        getTasks().catch(() => ({ data: [] })),
        user?.id
          ? supabase.from('volunteers').select('id', { count: 'exact', head: true }).eq('created_by', user.id)
          : Promise.resolve({ count: null }),
      ])
      if (dead) return
      setCandidates(c.data || [])
      setElections(e.data || [])
      setDossiers(d.data || [])
      setTasks((t.data || []).filter(x => !x.parent_id && !x.completed))
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
    return elections.find(e => e.id === self?.election_id && isUpcoming(e.election_date)) || null
  }, [elections, self])
  const daysLeft = race ? daysUntil(race.election_date) : null

  // This week's to-dos: anything due by Sunday, overdue first.
  const weekEnd = format(endOfWeek(new Date(), { weekStartsOn: 1 }), 'yyyy-MM-dd')
  const todos = useMemo(() => tasks
    .filter(t => t.due_date && t.due_date <= weekEnd)
    .sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)) || (a.priority || 4) - (b.priority || 4))
    .slice(0, 8), [tasks, weekEnd])
  const overdue = todos.filter(t => t.due_date < todayISO()).length

  // What changed with each opponent this week (from weekly monitoring digests).
  const opponentNews = useMemo(() => opponents.map(o => {
    const mine = dossiers
      .filter(d => d.candidate_id === o.id)
      .sort((a, b) => String(b.generated_at || '').localeCompare(String(a.generated_at || '')))
    const week = mine.find(d => d.weekly_digest && isThisWeek(d.generated_at))
    return { o, items: week?.weekly_digest?.items || [], summary: week?.weekly_digest?.summary || '', last: mine[0]?.generated_at || null }
  }), [opponents, dossiers])

  const completeTask = async (t) => {
    setBusy(t.id)
    const { error } = await updateTask(t.id, { completed: true, completed_at: new Date().toISOString() })
    if (!error) setTasks(prev => prev.filter(x => x.id !== t.id))
    setBusy(null)
  }

  if (loading) return <DashboardShell><DashboardSkeleton /></DashboardShell>

  return (
    <DashboardShell>
      <div style={{ maxWidth: 1100, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* Greeting + the race */}
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 240 }}>
            <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0 }}>Hi {firstNameOf(user)}</h1>
            <div style={{ fontSize: 13.5, color: T.muted, marginTop: 4 }}>
              {self
                ? <>{self.name}{officeLine(self.office) ? ` · ${officeLine(self.office)}` : ''}</>
                : <>Tell us which candidate record is you — <button onClick={() => nav('/candidates')} style={{ color: T.red, fontWeight: 600 }}>add yourself on the Candidates page</button>.</>}
            </div>
          </div>
          {race && daysLeft !== null && (
            <Card style={{ padding: '10px 16px', display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <span style={{ fontSize: 26, fontWeight: 700, color: T.red }}>{daysLeft}</span>
              <span style={{ fontSize: 13, color: T.ink3 }}>{daysLeft === 1 ? 'day' : 'days'} to {race.name || 'Election Day'}</span>
            </Card>
          )}
        </div>

        {/* Field */}
        <Card style={{ padding: '16px 18px' }}>
          <CardHead title="Field this week" sub="Door knocking, yard signs and website sign-ups land here as those tools go live." />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10, marginTop: 10 }}>
            <Stat label="Doors knocked" value={null} sub="Arrives with the door-knocking app" />
            <Stat label="Volunteers" value={volunteers} sub={volunteers === null ? 'Not available' : 'Signed up to help'} />
            <Stat label="Yard signs to drop off" value={null} sub="Arrives with your website connection" />
            <Stat label="Website sign-ups" value={null} sub="Arrives with your website connection" />
          </div>
        </Card>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 }}>
          {/* To-dos */}
          <Card style={{ padding: '16px 18px' }}>
            <CardHead
              title="This week's to-dos"
              right={overdue ? <Pill c={T.redHot} bg="#FDECEC">{overdue} overdue</Pill> : null}
            />
            {todos.length === 0 ? (
              <div style={{ fontSize: 13, color: T.muted, lineHeight: 1.6 }}>
                Nothing due this week.{' '}
                <button onClick={() => nav('/game-plan')} style={{ color: T.red, fontWeight: 600 }}>Open your Game Plan</button>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {todos.map(t => (
                  <label key={t.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '8px 0', borderTop: `1px solid ${T.divider}`, cursor: 'pointer' }}>
                    <input type="checkbox" disabled={busy === t.id} onChange={() => completeTask(t)} style={{ marginTop: 3 }} />
                    <span style={{ flex: 1, minWidth: 0, fontSize: 13.5 }}>{t.content}</span>
                    <span style={{ fontSize: 11.5, color: t.due_date < todayISO() ? T.redHot : T.muted, whiteSpace: 'nowrap' }}>
                      {t.due_date === todayISO() ? 'Today' : format(new Date(`${t.due_date}T12:00:00`), 'EEE, MMM d')}
                    </span>
                  </label>
                ))}
                <button onClick={() => nav('/game-plan')} style={{ marginTop: 8, alignSelf: 'flex-start', fontSize: 12.5, color: T.red, fontWeight: 600 }}>All tasks</button>
              </div>
            )}
          </Card>

          {/* Opponents */}
          <Card style={{ padding: '16px 18px' }}>
            <CardHead title="Your opponents this week" />
            {opponentNews.length === 0 ? (
              <div style={{ fontSize: 13, color: T.muted, lineHeight: 1.6 }}>
                Add your opponents to research them and get a Monday update on what changed.{' '}
                <button onClick={() => nav('/candidates')} style={{ color: T.red, fontWeight: 600 }}>Add an opponent</button>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {opponentNews.map(({ o, items, summary, last }) => (
                  <button key={o.id} onClick={() => nav(`/candidates/${o.id}`)} style={{
                    textAlign: 'left', padding: '10px 0', borderTop: `1px solid ${T.divider}`, display: 'flex', flexDirection: 'column', gap: 3,
                  }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 14, fontWeight: 600 }}>{o.name}</span>
                      <PartyPill party={o.party} />
                      <span style={{ marginLeft: 'auto', fontSize: 11.5, color: items.length ? T.red : T.faint, fontWeight: 600 }}>
                        {items.length ? `${items.length} new this week` : last ? 'No changes this week' : 'No profile yet'}
                      </span>
                    </span>
                    {summary && <span style={{ fontSize: 12.5, color: T.ink3, lineHeight: 1.5 }}>{summary}</span>}
                  </button>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>
    </DashboardShell>
  )
}
