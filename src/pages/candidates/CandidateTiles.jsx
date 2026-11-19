// src/pages/candidates/CandidateTiles.jsx — the Candidates page for Candidate
// plans (scout, c_monitor, c_active, c_campaign).
//
// v2.0 facelift (Nov 2026): Candidate plans track a handful of people — the
// user and the people they're running against — so this is a grid of big
// tiles in the mycandidatepage.com dashboard style instead of the Action
// plans' table/map (Candidates.jsx keeps that view, untouched, for Action
// plans). The user's own record is the one dark hero tile, first; opponents
// follow by name; a dashed "Add a candidate" tile closes the grid.
//
// Each tile opens /candidates/:id. A small ⋯ menu on each tile holds the rare
// actions: "This is me" (pins user_metadata.self_candidate_id, which
// resolveSelfCandidate reads everywhere), monitoring on/off, and Remove.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Plus, Lock, Zap, MoreHorizontal, UserCheck, Trash2, AlertCircle, X } from 'lucide-react'
import { supabase, getCandidates, getDossiers, updateCandidate, deleteCandidate } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import {
  getUserTier, getUserPlanType, getMonitoringSlotMax, canMonitorCandidates, monitoringUnlockLabel,
  SCOUT_CANDIDATE_LIMIT,
} from '../../lib/tiers'
import { monitoringToggleError } from '../../lib/capErrors'
import { partyHex } from '../../lib/campaignEnums'
import { WebOnlyCta, NATIVE_PLAN_NOTE } from '../../components/UpgradeCta'
import { OpenCue, Button } from '../../components/ui'
import LoadingBar from '../../components/LoadingBar'
import OnboardingStepHint from '../../components/onboarding/OnboardingStepHint'
import { resolveSelfCandidate } from '../dashboard/CandidateDashboard'
import { orderForTiles, newThisWeekCount, tileOfficeLine } from './helpers'
import Portrait from './Portrait'
import AddCandidateSheet from './AddCandidateSheet'

const cx = (...a) => a.filter(Boolean).join(' ')
const isMonitored = (c) => c?.section_timestamps?.monitoring === true

/** Party pill — tinted on white tiles, glassy on the dark one. */
function PartyPill({ party, dark }) {
  if (!party) return null
  const { c, bg } = partyHex(party)
  return dark ? (
    <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[12px] font-bold text-white" style={{ background: 'rgba(255,255,255,.12)' }}>
      <span className="h-2 w-2 rounded-full" style={{ background: c }} aria-hidden="true" />{party}
    </span>
  ) : (
    <span className="inline-flex items-center rounded-full px-2.5 py-0.5 text-[12px] font-bold" style={{ background: bg, color: c }}>{party}</span>
  )
}

/** The ⋯ menu in a tile's top-right corner. */
function TileMenu({ name, dark, items }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])
  if (!items.length) return null
  return (
    // An open menu rises above the next tile's own ⋯ button (z-popover > z-10).
    <div ref={ref} className={cx('absolute right-3 top-3', open ? 'z-popover' : 'z-10')}>
      <button
        type="button"
        aria-label={`More for ${name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
        className={cx(
          'flex h-9 w-9 items-center justify-center rounded-full transition-colors',
          dark ? 'bg-white/10 text-white hover:bg-white/20' : 'bg-white/80 text-brand-ink shadow-e1 hover:bg-white',
        )}
      >
        <MoreHorizontal className="h-5 w-5" />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-11 w-60 rounded-xl bg-white py-1.5 text-brand-ink shadow-e4">
          {items.map(it => (
            <button
              key={it.key}
              type="button"
              role="menuitem"
              disabled={it.disabled}
              onClick={() => { setOpen(false); it.onClick() }}
              className={cx(
                'flex w-full items-start gap-2.5 px-3.5 py-2.5 text-left text-[14px] font-semibold hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-50',
                it.danger && 'text-brand-red',
              )}
            >
              <it.icon className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <span className="min-w-0">
                {it.label}
                {it.hint && <span className="mt-0.5 block text-[12px] font-medium text-brand-mute">{it.hint}</span>}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function CandidateTile({ c, isSelf, newCount, menuItems, monitorOn }) {
  const dark = isSelf
  const office = tileOfficeLine(c)
  const hex = c.party ? partyHex(c.party) : null
  return (
    <div
      className={cx(
        'group relative flex min-h-[260px] sm:min-h-[300px] flex-col rounded-tile transition-shadow duration-200 hover:shadow-e4',
        dark ? 'text-white shadow-e3' : 'bg-white text-brand-ink shadow-e2',
      )}
      style={dark ? { background: 'radial-gradient(120% 90% at 20% 0%, #1D2F63 0%, #0E1A3A 55%, #0A1330 100%)' } : undefined}
    >
      {/* The whole tile opens the record; the ⋯ menu sits above this link. */}
      <Link
        to={`/candidates/${c.id}`}
        aria-label={`Open ${c.name}${isSelf ? ' (you)' : ''}`}
        className="absolute inset-0 rounded-tile focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-red focus-visible:ring-offset-2"
      />
      <div className="pointer-events-none relative flex flex-1 flex-col p-5">
        {/* colored band: the party's wash on white tiles, nothing on the hero */}
        <div
          aria-hidden="true"
          className="-mx-5 -mt-5 h-[78px] rounded-t-tile"
          style={{ background: dark ? 'transparent' : (hex?.bg || '#F1F3F6') }}
        />
        <div className="-mt-[50px] flex items-end gap-3">
          <span className="relative inline-flex">
            <Portrait
              name={c.name}
              photo={c.photo_url}
              size={92}
              color={dark ? '#2A3B6E' : (hex?.c || '#11161C')}
              className={dark ? 'ring-4 ring-white/15' : 'ring-4 ring-white'}
            />
            {newCount > 0 && (
              <span
                className={cx('absolute right-1 top-1 h-4 w-4 rounded-full bg-brand-red ring-[3px]', dark ? 'ring-[#132250]' : 'ring-white')}
                aria-label={`${newCount} new this week`}
              />
            )}
          </span>
          {isSelf && (
            <span className="mb-1 rounded-full bg-white px-2.5 py-0.5 text-[12px] font-extrabold uppercase tracking-[0.08em] text-brand-ink">You</span>
          )}
        </div>

        <h3 className="mt-4 text-[24px] font-extrabold leading-[1.1] tracking-display md:text-[26px]">{c.name}</h3>
        {(c.party || office) && (
          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5">
            <PartyPill party={c.party} dark={dark} />
            {office && <span className={cx('text-[14px] leading-snug', dark ? 'text-white/75' : 'text-brand-mute')}>{office}</span>}
          </div>
        )}

        <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 pt-6">
          {monitorOn ? (
            <span className={cx('inline-flex items-center gap-1.5 text-[13px] font-semibold', dark ? 'text-[#7EE2A8]' : 'text-[#16803C]')}>
              <Zap className="h-3.5 w-3.5" /> Monitoring on
            </span>
          ) : (
            <span className={cx('text-[13px] font-semibold', dark ? 'text-white/50' : 'text-brand-faint')}>Monitoring off</span>
          )}
          {newCount > 0 && (
            <span className={cx('text-[13px] font-bold', dark ? 'text-[#FF8A80]' : 'text-brand-red')}>
              {newCount} new this week
            </span>
          )}
          <span className="ml-auto"><OpenCue dark={dark} /></span>
        </div>
      </div>
      <TileMenu name={c.name} dark={dark} items={menuItems} />
    </div>
  )
}

/** The dashed "Something else" tile from mycandidatepage's Events picker. */
function AddTile({ onClick, empty }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex min-h-[176px] sm:min-h-[300px] flex-col items-start justify-between rounded-tile border-2 border-dashed border-black/15 bg-white/40 p-6 text-left transition-colors hover:border-brand-ink/40 hover:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-red"
    >
      <Plus className="h-8 w-8 text-brand-ink" strokeWidth={2} />
      <span>
        <span className="block text-[22px] font-extrabold leading-tight tracking-display text-brand-ink">
          {empty ? 'Add yourself first' : 'Add a candidate'}
        </span>
        <span className="mt-1 block text-[14px] text-brand-mute">
          {empty ? 'Then the people you’re running against.' : 'Type a name — we’ll look them up.'}
        </span>
      </span>
    </button>
  )
}

/** Same dashed tile, closed: Scout's limit is reached. */
function CapTile({ count }) {
  return (
    <div className="flex min-h-[176px] sm:min-h-[300px] flex-col items-start justify-between rounded-tile border-2 border-dashed border-black/10 bg-white/40 p-6">
      <Lock className="h-7 w-7 text-brand-faint" />
      <div>
        <div className="text-[20px] font-extrabold leading-tight tracking-display text-brand-ink">
          That’s {count} of {SCOUT_CANDIDATE_LIMIT} on Scout
        </div>
        <p className="mt-1 text-[14px] leading-relaxed text-brand-mute">
          The free plan tracks {SCOUT_CANDIDATE_LIMIT} people.{' '}
          <WebOnlyCta native={NATIVE_PLAN_NOTE}>
            <Link to="/plans" className="font-semibold text-brand-red underline-offset-2 hover:underline">Upgrade</Link> to add everyone in your race.
          </WebOnlyCta>
        </p>
      </div>
    </div>
  )
}

/** One compact line: how many people, and the Active Monitoring slots. */
function MonitoringLine({ canMonitor, maxSlots, used, planType }) {
  if (!canMonitor) {
    return (
      <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl bg-white px-3 py-2 text-[13px] text-brand-mute shadow-e1">
        <Zap className="h-3.5 w-3.5 text-brand-faint" />
        <span>Weekly monitoring starts on {monitoringUnlockLabel(planType)}.</span>
        <WebOnlyCta><Link to="/plans" className="font-semibold text-brand-red hover:underline">Upgrade</Link></WebOnlyCta>
      </span>
    )
  }
  const unlimited = maxSlots === Infinity
  const full = !unlimited && used >= maxSlots
  const pct = unlimited ? 0 : Math.min(100, Math.round((used / Math.max(1, maxSlots)) * 100))
  return (
    <span
      className="inline-flex items-center gap-2.5 rounded-xl bg-white px-3 py-2 text-[13px] font-semibold text-brand-ink shadow-e1"
      title="Monitored people get a fresh look every Monday and a digest of what changed."
    >
      <Zap className={cx('h-3.5 w-3.5', full ? 'text-amber-500' : 'text-[#16803C]')} />
      {unlimited
        ? <span>Monitoring {used} · no slot limit</span>
        : <span>Monitoring {used} of {maxSlots} {maxSlots === 1 ? 'slot' : 'slots'}{full ? ' — all used' : ''}</span>}
      {!unlimited && (
        <span className="hidden h-1.5 w-14 overflow-hidden rounded-full bg-black/10 sm:inline-block" aria-hidden="true">
          <span className="block h-full rounded-full" style={{ width: `${pct}%`, background: full ? '#F59E0B' : '#16803C' }} />
        </span>
      )}
    </span>
  )
}

export default function CandidateTiles() {
  const { user } = useAuth()
  const userId = user?.id
  const [candidates, setCandidates] = useState([])
  const [dossiers, setDossiers]     = useState([])
  const [loading, setLoading]       = useState(true)
  const [activeCount, setActiveCount] = useState(0)
  const [pinnedSelfId, setPinnedSelfId] = useState(null)
  const [busyId, setBusyId]         = useState(null)
  const [error, setError]           = useState('')
  const [adding, setAdding]         = useState(false)

  const load = useCallback(async () => {
    const [c, d] = await Promise.all([
      getCandidates({}),
      getDossiers(null, { list: true }).catch(() => ({ data: [] })),
    ])
    if (c.error) console.error('Failed to load candidates:', c.error)
    setCandidates(c.data || [])
    setDossiers(d?.data || [])
    setLoading(false)
  }, [])

  // Monitoring slots come from an UNFILTERED server count — the same query as
  // Candidates.jsx refreshActiveCount() and CandidateDetail's toggle guard.
  const refreshActiveCount = useCallback(async () => {
    if (!userId) return
    const { count, error: err } = await supabase
      .from('candidates')
      .select('id', { count: 'exact', head: true })
      .eq('created_by', userId)
      .contains('section_timestamps', { monitoring: true })
    if (!err) setActiveCount(count ?? 0)
  }, [userId])

  useEffect(() => { load() }, [load, userId])
  useEffect(() => { refreshActiveCount() }, [refreshActiveCount])

  // "Which one is you": a pin made on this page wins at once; otherwise the
  // app-wide guess (user_metadata.self_candidate_id, then name match, …).
  const self = useMemo(() => {
    const pinned = pinnedSelfId && candidates.find(c => c.id === pinnedSelfId)
    return pinned || resolveSelfCandidate(user, candidates)
  }, [user, candidates, pinnedSelfId])
  const ordered = useMemo(() => orderForTiles(candidates, self?.id), [candidates, self])

  const tier      = getUserTier(user)
  const planType  = getUserPlanType(user)
  const canMonitor = canMonitorCandidates(user)
  const maxSlots  = getMonitoringSlotMax(user)
  const atSlotLimit = maxSlots !== Infinity && activeCount >= maxSlots
  const atScoutCap  = tier === 'scout' && candidates.length >= SCOUT_CANDIDATE_LIMIT

  const pinSelf = async (c) => {
    setError('')
    const { error: err } = await supabase.auth.updateUser({ data: { self_candidate_id: c.id } })
    if (err) { setError(`Couldn’t save that: ${err.message}`); return }
    // AuthContext picks up USER_UPDATED and refreshes `user`; this makes the
    // tile move first right away.
    setPinnedSelfId(c.id)
  }

  // Same rules as Candidates.jsx handleToggleMonitoring: optimistic, reverted
  // with the trigger's own sentence when the monitoring_cap trigger refuses.
  const toggleMonitoring = async (c) => {
    if (!canMonitor) return
    const on = isMonitored(c)
    if (!on && atSlotLimit) return
    setError('')
    setBusyId(c.id)
    const next = {
      ...(c.section_timestamps || {}),
      monitoring: !on,
      monitoring_updated_at: new Date().toISOString(),
      monitoring_updated_by: user?.email || 'You',
    }
    setCandidates(prev => prev.map(x => (x.id === c.id ? { ...x, section_timestamps: next } : x)))
    setActiveCount(n => Math.max(0, n + (on ? -1 : 1)))
    const { data: updated, error: err } = await updateCandidate(c.id, { section_timestamps: next })
    if (err) {
      setCandidates(prev => prev.map(x => (x.id === c.id ? { ...x, section_timestamps: c.section_timestamps } : x)))
      setError(monitoringToggleError(err))
    } else if (updated) {
      setCandidates(prev => prev.map(x => (x.id === c.id ? { ...x, ...updated } : x)))
    }
    refreshActiveCount()
    setBusyId(null)
  }

  const remove = async (c) => {
    if (!window.confirm(`Remove ${c.name}? This also deletes their research profiles.`)) return
    setError('')
    const { error: err } = await deleteCandidate(c.id)
    if (err) { setError(`Couldn’t remove ${c.name}: ${err.message}`); return }
    setCandidates(prev => prev.filter(x => x.id !== c.id))
    refreshActiveCount()
  }

  const menuFor = (c, isSelf) => {
    const on = isMonitored(c)
    const items = []
    if (!isSelf) items.push({ key: 'self', icon: UserCheck, label: 'This is me', hint: 'Shows as You and comes first', onClick: () => pinSelf(c) })
    if (canMonitor) {
      const blocked = !on && atSlotLimit
      items.push({
        key: 'monitor', icon: Zap,
        label: on ? 'Turn monitoring off' : 'Turn monitoring on',
        hint: blocked ? `All ${maxSlots} ${maxSlots === 1 ? 'slot is' : 'slots are'} in use — turn one off first` : (on ? 'Frees a slot' : 'A fresh look every Monday'),
        disabled: blocked || busyId === c.id,
        onClick: () => toggleMonitoring(c),
      })
    }
    items.push({ key: 'remove', icon: Trash2, label: 'Remove', danger: true, onClick: () => remove(c) })
    return items
  }

  const saved = async (row, role) => {
    setAdding(false)
    if (role === 'self' && row?.id) setPinnedSelfId(row.id)
    await load()
  }

  const count = candidates.length

  return (
    <div className="pb-4">
      <LoadingBar loading={loading} />

      {/* count · monitoring slots · add */}
      <div className="mb-5 flex flex-wrap items-center gap-x-4 gap-y-3">
        <span className="text-[15px] text-brand-mute">
          <span className="font-extrabold text-brand-ink">{count}</span> {count === 1 ? 'person' : 'people'} in your race
        </span>
        <MonitoringLine canMonitor={canMonitor} maxSlots={maxSlots} used={activeCount} planType={planType} />
        {!atScoutCap && count > 0 && (
          <Button icon={Plus} className="w-full sm:ml-auto sm:w-auto" onClick={() => setAdding(true)}>Add candidate</Button>
        )}
      </div>

      {error && (
        <div role="alert" className="mb-4 flex items-start gap-3 rounded-xl bg-brand-red-wash px-4 py-3 text-[14px] text-brand-red-dark">
          <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <p className="flex-1">{error}</p>
          <button type="button" onClick={() => setError('')} aria-label="Dismiss" className="text-brand-red-dark/70 hover:text-brand-red-dark"><X className="h-4 w-4" /></button>
        </div>
      )}

      {loading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-hidden="true">
          {[0, 1, 2].map(i => <div key={i} className="min-h-[300px] animate-pulse rounded-tile bg-white shadow-e1" />)}
        </div>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {ordered.map(c => {
              const isSelf = c.id === self?.id
              return (
                <CandidateTile
                  key={c.id}
                  c={c}
                  isSelf={isSelf}
                  monitorOn={isMonitored(c)}
                  newCount={newThisWeekCount(dossiers, c.id)}
                  menuItems={menuFor(c, isSelf)}
                />
              )
            })}
            {atScoutCap ? <CapTile count={count} /> : <AddTile empty={count === 0} onClick={() => setAdding(true)} />}
          </div>
          {count === 0 && <OnboardingStepHint stepId="candidate" style={{ marginTop: 16 }} />}
        </>
      )}

      {adding && (
        <AddCandidateSheet
          candidates={candidates}
          onClose={() => setAdding(false)}
          onSaved={saved}
        />
      )}
    </div>
  )
}
