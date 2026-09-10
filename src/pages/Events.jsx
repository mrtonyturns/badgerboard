// Events.jsx — Outreach → District Events
// Pick one of your offices → AI researches upcoming community events in that
// office's district, classifies each event's political lean, and lets you add
// events to your connected calendars (personal feed) in one click.
import React, { useEffect, useState, useMemo, useCallback, useRef } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import {
  CalendarDays, RefreshCw, Loader2, Sparkles, MapPin, ChevronDown,
  Check, X, Settings as SettingsIcon, ExternalLink, Users, CheckSquare, Square,
} from 'lucide-react'
import { supabase } from '../lib/supabase'
import { getUserPlanType } from '../lib/tiers'
import { eventImage } from '../lib/imageProxy'
import { useDialog } from '../lib/useDialog'

let _placesCache = null
async function loadPlaces() {
  if (!_placesCache) _placesCache = await fetch('/geodata/wi-district-places.json').then(r => r.json()).catch(() => ({}))
  return _placesCache
}
import { useAuth } from '../contexts/AuthContext'
import LoadingBar from '../components/LoadingBar'
import SearchableSelect from '../components/SearchableSelect'

// ── district derivation from an office row ───────────────────────────────────
export function officeToDistrict(office) {
  if (!office) return null
  const name = office.name || ''
  const num = office.district_number ? parseInt(office.district_number) : parseInt((name.match(/District\s+(\d+)/i) || [])[1])
  if (/assembly/i.test(name) && num) return { key: `assembly-${num}`, name: `Assembly District ${num}` }
  if (/senate/i.test(name) && /state|wisconsin/i.test(name) && num) return { key: `senate-${num}`, name: `State Senate District ${num}` }
  if (/u\.?s\.? house|congress/i.test(name) && num) return { key: `congress-${num}`, name: `Congressional District ${num}` }
  if (office.county) return { key: `county-${office.county}`, name: `${office.county} County` }
  return null
}

// ── Build selectable district / county / city index from the places dataset ──
export function buildPlaceIndex(places) {
  if (!places) return { district: [], county: [], city: [] }
  const districts = [], counties = [], cityMap = new Map()
  const labelFor = (key) => {
    const [t, n] = key.split('-')
    if (t === 'assembly') return `Assembly District ${n}`
    if (t === 'senate')   return `State Senate District ${n}`
    if (t === 'congress') return `Congressional District ${n}`
    return key
  }
  for (const [key, v] of Object.entries(places)) {
    const cts = v.counties || [], pls = v.places || []
    if (key.startsWith('county-')) {
      const cty = key.slice(7)
      counties.push({ key, name: `${cty} County`, counties: [cty],
        area: pls.length ? `${pls.slice(0, 8).join(', ')} (${cty} County)` : `${cty} County` })
      for (const city of pls) if (!cityMap.has(city)) cityMap.set(city, cty)
    } else {
      districts.push({ key, name: labelFor(key), counties: cts,
        area: `${pls.join(', ')}${cts.length ? ` (${cts.join(', ')} ${cts.length > 1 ? 'counties' : 'county'})` : ''}` })
    }
  }
  const ord = { congress: 0, senate: 1, assembly: 2 }
  districts.sort((a, b) => {
    const [ta, na] = a.key.split('-'), [tb, nb] = b.key.split('-')
    return (ord[ta] - ord[tb]) || (parseInt(na) - parseInt(nb))
  })
  counties.sort((a, b) => a.name.localeCompare(b.name))
  const cities = [...cityMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([city, cty]) => ({ key: `city-${city}-${cty}`, name: `${city}, WI`, counties: [cty], area: `${city}, WI (${cty} County)` }))
  return { district: districts, county: counties, city: cities }
}

const PATTERN = `url("data:image/svg+xml,%3Csvg width='44' height='44' viewBox='0 0 44 44' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='%23ffffff' fill-opacity='0.07'%3E%3Ccircle cx='6' cy='6' r='2.2'/%3E%3Ccircle cx='28' cy='18' r='1.6'/%3E%3Ccircle cx='14' cy='32' r='1.9'/%3E%3Ccircle cx='38' cy='38' r='2.4'/%3E%3C/g%3E%3C/svg%3E")`
const CATEGORY_META = {
  fair:     { label: 'County fair',    color: '#B45309', emoji: '◉', art: 'linear-gradient(135deg, #D97706 0%, #92400E 55%, #431407 100%)' },
  market:   { label: 'Farmers market', color: '#15803D', emoji: '❋', art: 'linear-gradient(135deg, #16A34A 0%, #14532D 60%, #052E16 100%)' },
  festival: { label: 'Festival',       color: '#B45309', emoji: '▲', art: 'linear-gradient(135deg, #F59E0B 0%, #B45309 45%, #7C2D12 100%)' },
  parade:   { label: 'Parade',         color: '#B91C1C', emoji: '✦', art: 'linear-gradient(135deg, #DC2626 0%, #7F1D1D 55%, #0A1628 100%)' },
  civic:    { label: 'Civic',          color: '#0369A1', emoji: '■', art: 'linear-gradient(135deg, #0284C7 0%, #075985 55%, #0A1628 100%)' },
  party:    { label: 'Party event',    color: '#7C3AED', emoji: '▣', art: 'linear-gradient(135deg, #8B5CF6 0%, #5B21B6 55%, #2E1065 100%)' },
  labor:    { label: 'Labor',          color: '#1D4ED8', emoji: '⨳', art: 'linear-gradient(135deg, #2563EB 0%, #1E40AF 55%, #172554 100%)' },
  church:   { label: 'Church',         color: '#92400E', emoji: '†', art: 'linear-gradient(135deg, #B45309 0%, #713F12 55%, #292018 100%)' },
  other:    { label: 'Community',      color: '#64748B', emoji: '●', art: 'linear-gradient(135deg, #64748B 0%, #334155 55%, #0F172A 100%)' },
}
const LEAN_PILL = {
  confirmed_conservative: { text: 'Confirmed conservative', bg: '#B91C1C', fg: '#fff' },
  likely_conservative:    { text: 'Likely conservative',    bg: '#FEE2E2', fg: '#B91C1C' },
  nonpartisan:            { text: 'Nonpartisan crowd',      bg: '#F1F5F9', fg: '#64748B' },
  likely_liberal:         { text: 'Likely liberal',         bg: '#DBEAFE', fg: '#1D4ED8' },
  confirmed_liberal:      { text: 'Confirmed liberal',      bg: '#1D4ED8', fg: '#fff' },
}
const CAL_META = {
  google:  { name: 'Google Calendar',  color: '#1A73E8', letter: 'G' },
  apple:   { name: 'Apple Calendar',   color: '#0F172A', letter: '' },
  outlook: { name: 'Outlook Calendar', color: '#0F6CBD', letter: 'O' },
}

// ── Background research progress ──────────────────────────────────────────────
// research-district-events-background.js is a Netlify BACKGROUND function, so
// the browser gets a 202 before the handler even runs and every status code it
// returns is discarded. The real channel is `district_events_progress`, which
// the function writes at each phase boundary and on every terminal outcome.
// Because that row lives on the server, a run keeps going — and keeps being
// visible — after you navigate away from this page and come back.
// Stage numbers mirror STAGE_* in the function.
const PHASE_LABELS = [
  'Searching public calendars and community sources…',
  'Checking local news coverage…',
  'Organizing events and reading each crowd…',
  'Adding venues, addresses and photos…',
]
const POLL_MS            = 3000
const MAX_WAIT_MS        = 8 * 60 * 1000    // the function's budget is 15 min; real runs are 1–5
const HEARTBEAT_STALE_MS = 3 * 60 * 1000    // progress row untouched this long ⇒ the run died
const phaseLabel = (stage) => PHASE_LABELS[Math.min(Math.max(Number(stage) || 1, 1), 4) - 1]
const freshMs = (iso) => {
  const t = Date.parse(iso || '')
  return Number.isFinite(t) ? Date.now() - t : Infinity
}

// ── lean.basis → a neutral, human badge ──────────────────────────────────────
// `lean.basis` is the classifier's own audit trail ("T3: chamber of commerce
// host, unknown area lean", "Registry check: no partisan signal found"). It was
// printed raw on the card face and truncated mid-word. The tier codes come from
// the SIGNAL HIERARCHY in research-district-events-background.js:
//   T1 = registered partisan entity (party/candidate committee)
//   T2 = organisation with documented alignment (unions, advocacy orgs)
//   T3 = no org-level signal — the score is the area's crowd lean, not the event
//   "Registry check: …" = the second-pass verification against public registries
// Returns null when nothing useful can be said, so the badge simply isn't shown.
// ─── R2C PURE HELPERS BEGIN ───
export function leanBadge(basis) {
  const s = String(basis || '').trim()
  if (!s) return null
  if (/^t1\b/i.test(s))            return { text: 'Registered host',      title: s }
  if (/^t2\b/i.test(s))            return { text: 'Documented alignment', title: s }
  if (/^t3\b/i.test(s))            return { text: 'Area lean only',       title: s }
  if (/^registry check\b/i.test(s)) return { text: 'Registry checked',    title: s }
  return null
}

/** Month-over-day date badge, matching the rest of the app ("AUG" over "19"). */
export function dateBadgeParts(dateStr) {
  const d = new Date(`${dateStr}T12:00:00`)
  if (Number.isNaN(d.getTime())) return null
  return { month: d.toLocaleDateString('en-US', { month: 'short' }), day: String(d.getDate()) }
}
// ─── R2C PURE HELPERS END ───

// Escape + scroll-lock for this page's dialogs. Mounted only while the dialog
// is open, so the hook's effect is scoped to the dialog's lifetime.
function Dialog({ onClose, className = '', onClick, children }) {
  useDialog(onClose)
  return (
    <div className={`fixed inset-0 z-50 flex items-center justify-center p-4 ${className}`} onClick={onClick}>
      {children}
    </div>
  )
}

function fmtDate(e) {
  const opts = { month: 'short', day: 'numeric' }
  const s = new Date(e.date_start + 'T12:00:00')
  let out = s.toLocaleDateString('en-US', opts)
  if (e.date_end && e.date_end !== e.date_start) {
    out += `–${new Date(e.date_end + 'T12:00:00').toLocaleDateString('en-US', opts)}`
  }
  return out
}

export default function Events() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const meta = user?.user_metadata || {}
  const connectedCals = Object.keys(CAL_META).filter(k => meta[`cal_${k}`])
  const defaultCals   = (meta.cal_defaults || []).filter(k => connectedCals.includes(k))
  const askPref       = meta.cal_ask !== false   // default: ask when multiple
  const reminderMins  = meta.cal_reminder ?? 60

  const [mode, setMode]               = useState('district')  // district | county | city
  const [sel, setSel]                 = useState('')
  const [events, setEvents]           = useState(null)
  const [fetchedAt, setFetchedAt]     = useState(null)
  const [cacheChecked, setCacheChecked] = useState(false)  // stored events looked up for this area
  const [loading, setLoading]         = useState(false)
  const [phase, setPhase]             = useState('')
  const [error, setError]             = useState(null)
  const [filter, setFilter]           = useState('all')
  const [pickerEvent, setPickerEvent] = useState(null)   // event awaiting calendar choice
  const [pickerChecked, setPickerChecked] = useState({})
  const [pickerRemember, setPickerRemember] = useState(false)
  const [added, setAdded]             = useState({})     // event name → true
  const [toast, setToast]             = useState(null)
  const [places, setPlaces]           = useState(null)

  // ── Campaign Connect: push events to connected candidates (Action plans) ────
  const isAction = getUserPlanType(user) === 'action'
  const [connectedCands, setConnectedCands] = useState([])   // [{ id, email }]
  const [selectMode, setSelectMode]         = useState(false)
  const [selectedEvents, setSelectedEvents] = useState({})   // event name → event obj
  const [candPicker, setCandPicker]         = useState(null) // { events: [ev] } | null
  const [candChecked, setCandChecked]       = useState({})   // candidate id → bool
  const [pushing, setPushing]               = useState(false)

  useEffect(() => {
    if (!isAction || !user?.id) return
    supabase.from('account_links')
      .select('candidate_user_id, candidate_email')
      .eq('action_user_id', user.id)
      .eq('status', 'active')
      .not('candidate_user_id', 'is', null)
      .then(({ data }) => {
        setConnectedCands((data || []).map(l => ({ id: l.candidate_user_id, email: l.candidate_email })))
      })
  }, [isAction, user?.id])

  useEffect(() => { loadPlaces().then(setPlaces) }, [])

  // Poll-generation counter: every new loadEvents run (or unmount) bumps it,
  // which cancels older in-flight loops — no setState after unmount, and a
  // slow response for a previously-selected district can never overwrite the
  // current district's results (stale-response-wins race).
  const pollGenRef = useRef(0)
  useEffect(() => () => { pollGenRef.current++ }, [])

  const index   = useMemo(() => buildPlaceIndex(places), [places])
  const options = index[mode] || []
  const target  = options.find(o => o.key === sel) || null

  // Keep a valid selection when the mode changes or the dataset loads
  useEffect(() => {
    if (options.length && !options.find(o => o.key === sel)) setSel(options[0].key)
  }, [mode, index]) // eslint-disable-line react-hooks/exhaustive-deps

  const CACHE_MS = 24 * 3600 * 1000

  const readCache = useCallback(async (key) => {
    const { data } = await supabase.from('district_events')
      .select('events, fetched_at').eq('district_key', key).maybeSingle()
    return data || null
  }, [])

  // Returns null when the row doesn't exist AND when the table isn't there yet
  // (migration not applied) — callers then fall back to watching the cache row,
  // so this is a pure upgrade, never a new failure mode.
  const readProgress = useCallback(async (key) => {
    const { data } = await supabase.from('district_events_progress')
      .select('stage, status, message, started_at, updated_at')
      .eq('district_key', key).maybeSingle()
    return data || null
  }, [])

  /** Watch a run that is already in flight (ours or someone else's) to completion. */
  const watchRun = useCallback(async (key, startedAt, alive) => {
    const deadline = startedAt + MAX_WAIT_MS
    let sawProgress = false
    for (;;) {
      await new Promise(r => setTimeout(r, POLL_MS))
      if (!alive()) return
      const [prog, row] = await Promise.all([readProgress(key), readCache(key)])
      if (!alive()) return

      // The cache row landing is proof the run finished, whatever the status row says.
      if (row?.fetched_at && new Date(row.fetched_at).getTime() >= startedAt - 5000 && row.events?.length) {
        setEvents(row.events); setFetchedAt(row.fetched_at); setPhase(''); setLoading(false)
        return
      }

      if (prog && freshMs(prog.updated_at) < HEARTBEAT_STALE_MS) {
        sawProgress = true
        if (prog.status === 'error') {
          throw new Error(prog.message || 'Event research failed — try Refresh again.')
        }
        if (prog.status === 'done') {
          // Includes the "your cache is still good" case, where nothing new is written.
          if (row?.events?.length) {
            setEvents(row.events); setFetchedAt(row.fetched_at); setPhase(''); setLoading(false)
            return
          }
          throw new Error('No public events found for this area right now — try Refresh later.')
        }
        setPhase(phaseLabel(prog.stage))
      } else if (sawProgress) {
        // We had a heartbeat and lost it: the function died mid-run. Say so now
        // instead of sitting on a spinner until the deadline.
        throw new Error('The event search stopped unexpectedly — try Refresh again.')
      }

      if (Date.now() > deadline) {
        throw new Error('This area is taking longer than expected. The search is still running in the background — come back in a minute and press Refresh.')
      }
    }
  }, [readCache, readProgress])

  const loadEvents = useCallback(async (force = false) => {
    if (!target) return
    const key = target.key
    const gen = ++pollGenRef.current
    const alive = () => pollGenRef.current === gen
    setLoading(true); setError(null); setPhase('Checking for cached events…')
    try {
      // 1. Cache first — shared across all users, refreshed daily
      if (!force) {
        const row = await readCache(key)
        if (!alive()) return
        if (row?.events?.length && row.fetched_at && Date.now() - new Date(row.fetched_at).getTime() < CACHE_MS) {
          setEvents(row.events); setFetchedAt(row.fetched_at); setPhase(''); setLoading(false)
          return
        }
      }

      // 2. Is a run for this area already in flight? Then attach to it instead of
      //    starting a second one — this is what makes progress survive leaving
      //    the page (and stops two users burning double the research spend).
      const existing = await readProgress(key)
      if (!alive()) return
      if (existing?.status === 'running' && freshMs(existing.updated_at) < HEARTBEAT_STALE_MS) {
        setPhase(phaseLabel(existing.stage))
        await watchRun(key, Date.parse(existing.started_at || existing.updated_at) || Date.now(), alive)
        return
      }

      // 3. Kick off the background research (Netlify answers 202 immediately —
      //    every real outcome comes back through the progress row).
      const startedAt = Date.now()
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch('/.netlify/functions/research-district-events-background', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({
          district_key: key,
          district_name: target.name,
          counties: target.counties || [],
          force,
          area_description: target.area || target.name,
        }),
      })
      if (!alive()) return
      if (res.status !== 202 && !res.ok) throw new Error('Could not start event research — try again')
      setPhase(PHASE_LABELS[0])
      await watchRun(key, startedAt, alive)
    } catch (e) {
      if (alive()) { setError(e.message); setPhase(''); setLoading(false) }
      return
    }
    if (alive()) setLoading(false)
  }, [target?.key, readCache, readProgress, watchRun]) // eslint-disable-line react-hooks/exhaustive-deps

  // Area change → show what is already stored, and nothing else.
  //
  // This used to call loadEvents(false), which on a cache miss kicked off the
  // ~2-minute server research job on page LOAD, with no user action. The search
  // now only ever starts from the explicit "Search for new events" button
  // below; mounting is a single cheap SELECT against the shared cache.
  useEffect(() => {
    if (!target?.key) return
    const key = target.key
    // Same generation guard loadEvents uses: bumping it cancels the previous
    // area's watch loop, and makes this one cancellable in turn.
    const gen = ++pollGenRef.current
    const alive = () => pollGenRef.current === gen
    setEvents(null); setFetchedAt(null); setError(null); setPhase(''); setLoading(false); setCacheChecked(false)
    ;(async () => {
      const [row, prog] = await Promise.all([readCache(key), readProgress(key)])
      if (!alive()) return
      if (row?.events?.length) { setEvents(row.events); setFetchedAt(row.fetched_at) }
      setCacheChecked(true)
      // Attaching to a run that is ALREADY in flight (this user's, from before
      // they navigated away, or another user's) starts nothing — it only
      // watches — so it keeps the documented "leave the page and come back"
      // behavior without reintroducing the auto-start.
      if (prog?.status === 'running' && freshMs(prog.updated_at) < HEARTBEAT_STALE_MS) {
        setLoading(true); setPhase(phaseLabel(prog.stage))
        try {
          await watchRun(key, Date.parse(prog.started_at || prog.updated_at) || Date.now(), alive)
        } catch (e) {
          if (alive()) { setError(e.message); setPhase('') }
        }
        if (alive()) setLoading(false)
      }
    })()
  }, [target?.key, readCache, readProgress, watchRun])

  const filtered = useMemo(() => {
    if (!events) return []
    if (filter === 'all') return events
    return events.filter(e => {
      const l = e.lean?.label || 'nonpartisan'
      if (filter === 'conservative') return l.includes('conservative')
      if (filter === 'liberal') return l.includes('liberal')
      return l === 'nonpartisan'
    })
  }, [events, filter])

  // ── add-to-calendar flow ────────────────────────────────────────────────────
  const pushToFeed = async (ev) => {
    const { error: insErr } = await supabase.from('calendar_feed_items').insert({
      user_id: user.id, event: ev, reminder_minutes: reminderMins,
    })
    if (insErr) throw insErr
  }

  const downloadIcs = (ev) => {
    const d = ev.date_start.replace(/-/g, '')
    const m = String(ev.time || '9:00 AM').match(/(\d{1,2}):?(\d{2})?\s*(AM|PM)?/i)
    let h = m ? parseInt(m[1]) : 9; const min = m?.[2] ? parseInt(m[2]) : 0
    if (m?.[3]?.toUpperCase() === 'PM' && h < 12) h += 12
    const pad = (n) => String(n).padStart(2, '0')
    const ics = ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Badger Board//EN','BEGIN:VEVENT',
      `UID:${Date.now()}@badgerboardwi.com`,
      `DTSTAMP:${new Date().toISOString().replace(/[-:]/g,'').slice(0,15)}Z`,
      `DTSTART:${d}T${pad(h)}${pad(min)}00`,
      `DTEND:${d}T${pad(Math.min(h+2,23))}${pad(min)}00`,
      `SUMMARY:${ev.name}`,
      `LOCATION:${[ev.venue, ev.address, ev.city ? `${ev.city}, WI` : null].filter(Boolean).join(', ')}`,
      `DESCRIPTION:${(ev.description || '').replace(/\n/g,' ')}`,
      'BEGIN:VALARM','ACTION:DISPLAY',`TRIGGER:-PT${reminderMins}M`,`DESCRIPTION:${ev.name}`,'END:VALARM',
      'END:VEVENT','END:VCALENDAR'].join('\r\n')
    const blob = new Blob([ics], { type: 'text/calendar' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${ev.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.ics`
    a.click()
  }

  const completeAdd = async (ev) => {
    try {
      await pushToFeed(ev)
      setAdded(a => ({ ...a, [ev.name]: true }))
      setToast(`Added "${ev.name}" — appears in your connected calendars with a ${reminderMins >= 60 ? `${reminderMins / 60}-hour` : `${reminderMins}-minute`} reminder`)
      setTimeout(() => setToast(null), 4000)
    } catch (e) { setToast(`Could not add: ${e.message}`); setTimeout(() => setToast(null), 4000) }
  }

  const handleAdd = (ev) => {
    if (connectedCals.length === 0) { setPickerEvent(ev); setPickerChecked({}); return }
    if (connectedCals.length === 1 || (!askPref && defaultCals.length)) { completeAdd(ev); return }
    const init = {}
    ;(defaultCals.length ? defaultCals : connectedCals).forEach(k => { init[k] = true })
    setPickerChecked(init); setPickerRemember(false); setPickerEvent(ev)
  }

  const confirmPicker = async () => {
    const chosen = Object.keys(pickerChecked).filter(k => pickerChecked[k])
    if (pickerRemember && chosen.length) {
      await supabase.auth.updateUser({ data: { cal_ask: false, cal_defaults: chosen } })
    }
    await completeAdd(pickerEvent)
    setPickerEvent(null)
  }

  // ── push to candidate calendars (Campaign Connect) ─────────────────────────
  const openCandPicker = (evs) => {
    const init = {}
    connectedCands.forEach(c => { init[c.id] = connectedCands.length === 1 })
    setCandChecked(init)
    setCandPicker({ events: evs })
  }

  const toggleSelectEvent = (ev) => {
    setSelectedEvents(prev => {
      const next = { ...prev }
      if (next[ev.name]) delete next[ev.name]
      else next[ev.name] = ev
      return next
    })
  }

  const confirmCandPush = async () => {
    const candidateIds = Object.keys(candChecked).filter(id => candChecked[id])
    if (!candidateIds.length || !candPicker?.events?.length) return
    setPushing(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch('/.netlify/functions/campaign-connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ action: 'push_events', candidate_user_ids: candidateIds, events: candPicker.events }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error || 'Could not add events')
      const nEv = candPicker.events.length, nCand = candidateIds.length
      setToast(`Added ${nEv} event${nEv > 1 ? 's' : ''} to ${nCand} candidate calendar${nCand > 1 ? 's' : ''}`)
      setTimeout(() => setToast(null), 4000)
      setCandPicker(null)
      setSelectedEvents({})
      setSelectMode(false)
    } catch (e) {
      setToast(`Could not add: ${e.message}`)
      setTimeout(() => setToast(null), 4000)
    }
    setPushing(false)
  }

  const selectedList = Object.values(selectedEvents)

  const leanMarkerPos = (lean) => {
    const score = Math.max(-100, Math.min(100, lean?.score ?? 0))
    return 50 + score * 0.44
  }

  return (
    <div className="space-y-5">
      <LoadingBar loading={loading} />

      {/* header */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="sm:ml-auto flex items-center gap-2 flex-wrap">
          <Link to="/settings#calendars" className="flex items-center gap-2 bg-white border-2 border-gray-200 rounded-xl px-3.5 py-2 text-xs font-semibold text-gray-600 hover:border-gray-300">
            {connectedCals.length ? (
              <>
                {connectedCals.map(k => (
                  <span key={k} className="w-5 h-5 rounded-md flex items-center justify-center text-white text-[10px] font-black" style={{ background: CAL_META[k].color }}>{CAL_META[k].letter}</span>
                ))}
                {connectedCals.length} calendar{connectedCals.length > 1 ? 's' : ''} connected
              </>
            ) : (
              <><SettingsIcon className="w-3.5 h-3.5" /> Connect calendars</>
            )}
          </Link>
        </div>
      </div>

      {/* area selector: district / county / city + refresh */}
      <div className="card py-4">
        <div className="flex flex-col gap-3">
          <div className="flex gap-1.5">
            {[['district', 'District'], ['county', 'County'], ['city', 'City']].map(([k, label]) => (
              <button key={k} onClick={() => setMode(k)}
                className={`text-xs font-bold px-3.5 py-1.5 rounded-full border-2 transition-colors ${mode === k ? 'bg-brand-navy border-brand-navy text-white' : 'bg-white border-gray-200 text-gray-500 hover:border-gray-300'}`}>
                {label}
              </button>
            ))}
          </div>
          <div className="flex flex-col sm:flex-row gap-3 sm:items-center">
            <div className="relative flex-1 max-w-xl">
              <SearchableSelect
                value={sel}
                onChange={setSel}
                options={options.map(o => ({ value: o.key, label: o.name }))}
                placeholder={options.length ? 'Select an area…' : 'Loading…'}
                buttonClassName="font-semibold"
                disabled={!options.length}
                searchPlaceholder={`Search ${mode === 'district' ? 'districts' : mode === 'county' ? 'counties' : 'cities'}…`}
              />
            </div>
            {target && (
              <span className="text-xs font-bold bg-red-50 text-brand-red px-2.5 py-1 rounded-full whitespace-nowrap">{target.name}</span>
            )}
            {/* The only thing that starts the AI search — never a page load. */}
            <button onClick={() => loadEvents(true)} disabled={loading || !target}
              className="flex items-center gap-1.5 bg-brand-red text-white text-sm font-extrabold px-4 py-2 rounded-xl hover:bg-red-800 disabled:opacity-50 whitespace-nowrap transition-colors">
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              {loading ? 'Searching…' : events ? 'Search for new events' : 'Search for events'}
            </button>
          </div>
          <p className="text-xs text-gray-400 font-semibold">
            Browse upcoming public events by legislative district, county, or city — pick any area in Wisconsin.
            {fetchedAt ? ` Last searched ${new Date(fetchedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}.` : ''}
          </p>
        </div>
      </div>

      {/* meta + filters */}
      {events && (
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-sm font-bold text-gray-900">{filtered.length} event{filtered.length !== 1 ? 's' : ''}</span>
          <span className="text-xs text-gray-400 font-semibold">
            next 60 days{fetchedAt ? ` · updated ${new Date(fetchedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : ''}
          </span>
          <div className="ml-auto flex gap-1.5 flex-wrap">
            {[['all','All'],['conservative','Conservative'],['liberal','Liberal'],['nonpartisan','Nonpartisan']].map(([k, label]) => (
              <button key={k} onClick={() => setFilter(k)}
                className={`text-xs font-bold px-3 py-1.5 rounded-full border-2 transition-colors ${filter === k ? 'bg-brand-navy border-brand-navy text-white' : 'bg-white border-gray-200 text-gray-500 hover:border-gray-300'}`}>
                {label}
              </button>
            ))}
            {isAction && connectedCands.length > 0 && (
              <button onClick={() => { setSelectMode(m => !m); setSelectedEvents({}) }}
                className={`text-xs font-bold px-3 py-1.5 rounded-full border-2 transition-colors flex items-center gap-1.5 ${selectMode ? 'bg-brand-red border-brand-red text-white' : 'bg-white border-gray-200 text-gray-500 hover:border-gray-300'}`}>
                <CheckSquare className="w-3.5 h-3.5" /> {selectMode ? 'Cancel selection' : 'Select multiple'}
              </button>
            )}
          </div>
        </div>
      )}

      {/* bulk-selection action bar */}
      {selectMode && selectedList.length > 0 && (
        <div className="sticky top-2 z-40 flex items-center gap-3 bg-brand-navy text-white rounded-2xl px-5 py-3 shadow-2xl">
          <CheckSquare className="w-4 h-4 flex-shrink-0" />
          <span className="text-sm font-bold">{selectedList.length} event{selectedList.length > 1 ? 's' : ''} selected</span>
          <div className="ml-auto flex items-center gap-2">
            <button onClick={() => setSelectedEvents({})} className="text-xs font-bold text-white/60 hover:text-white px-2 py-1.5">Clear</button>
            <button onClick={() => openCandPicker(selectedList)}
              className="flex items-center gap-1.5 bg-brand-red hover:bg-red-700 text-white text-xs font-extrabold px-4 py-2 rounded-xl transition-colors">
              <Users className="w-3.5 h-3.5" /> Add to candidate calendars
            </button>
          </div>
        </div>
      )}

      {/* loading / error / empty */}
      {loading && !events && (() => {
        const activeStage = PHASE_LABELS.indexOf(phase)   // -1 while checking the cache
        return (
          <div className="card flex flex-col items-center justify-center py-16">
            <Loader2 className="w-8 h-8 text-brand-red animate-spin mb-3" />
            <p className="text-sm font-bold text-gray-700">{phase || 'Checking for cached events…'}</p>
            {activeStage >= 0 && (
              <>
                <div className="flex gap-1.5 mt-4 w-full max-w-sm px-6">
                  {PHASE_LABELS.map((_, i) => (
                    <span key={i} className={`h-1.5 flex-1 rounded-full ${
                      i < activeStage ? 'bg-brand-red'
                      : i === activeStage ? 'bg-brand-red/40 animate-pulse'
                      : 'bg-gray-200'}`} />
                  ))}
                </div>
                <p className="text-xs text-gray-400 font-semibold mt-2">Step {activeStage + 1} of {PHASE_LABELS.length}</p>
              </>
            )}
            <p className="text-xs text-gray-400 font-semibold mt-2 text-center max-w-md">
              This runs on the server — you can leave this page and come back. A first search takes a couple of minutes, then it&rsquo;s cached for everyone.
            </p>
          </div>
        )
      })()}
      {error && (
        <div className="card py-6 text-center">
          <p className="text-sm font-bold text-red-600">{error}</p>
          <button onClick={() => loadEvents(false)} className="btn-secondary text-sm mt-3">Try again</button>
        </div>
      )}
      {events && filtered.length === 0 && (
        <div className="card py-12 text-center">
          <Sparkles className="w-7 h-7 text-gray-300 mx-auto mb-2" />
          <p className="text-sm font-bold text-gray-500">No {filter !== 'all' ? filter + ' ' : ''}events found</p>
        </div>
      )}

      {/* Start state — nothing stored for this area yet, and nothing is running.
          The search is a couple of minutes of server work, so it waits for a click. */}
      {cacheChecked && !events && !loading && !error && (
        <div className="card py-14 text-center">
          <Sparkles className="w-8 h-8 text-brand-red mx-auto mb-3" />
          <p className="text-base font-extrabold text-gray-900">Find conservative events in your districts</p>
          <p className="text-sm text-gray-500 font-medium mt-1.5 max-w-md mx-auto leading-relaxed">
            Nothing has been searched for {target?.name || 'this area'} yet. Badger Board will research public
            calendars, local news and community sources, then read each crowd&rsquo;s lean.
          </p>
          <button onClick={() => loadEvents(true)} disabled={!target}
            className="mt-5 inline-flex items-center gap-2 bg-brand-red text-white text-sm font-extrabold px-5 py-3 rounded-xl hover:bg-red-800 disabled:opacity-50 transition-colors">
            <Sparkles className="w-4 h-4" /> Search for new events
          </button>
          <p className="text-xs text-gray-400 font-semibold mt-3">Takes a couple of minutes — it runs on the server, so you can leave this page.</p>
        </div>
      )}

      {/* event grid */}
      {filtered.length > 0 && (
        <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(310px, 1fr))' }}>
          {filtered.map((ev, i) => {
            const cat = CATEGORY_META[ev.category] || CATEGORY_META.other
            const lean = ev.lean || { label: 'nonpartisan', certainty: 0, score: 0 }
            const pill = LEAN_PILL[lean.label] || LEAN_PILL.nonpartisan
            const dayBadge = dateBadgeParts(ev.date_start)
            const isAdded = added[ev.name]
            const isSelected = Boolean(selectedEvents[ev.name])
            return (
              <div key={`${ev.name}-${i}`}
                onClick={selectMode ? () => toggleSelectEvent(ev) : undefined}
                {...(selectMode ? {
                  role: 'button',
                  tabIndex: 0,
                  'aria-pressed': isSelected,
                  onKeyDown: (e) => {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSelectEvent(ev) }
                  },
                } : {})}
                className={`bg-white rounded-2xl overflow-hidden border-2 transition-all shadow-sm hover:shadow-lg hover:-translate-y-0.5 flex flex-col ${
                  selectMode
                    ? `cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-navy ${isSelected ? 'border-brand-red ring-2 ring-brand-red/30' : 'border-gray-200 hover:border-brand-red/50'}`
                    : 'border-transparent hover:border-brand-red'
                }`}>
                <div className="h-28 flex-shrink-0 relative flex items-center justify-center" style={ev.image
                  ? { backgroundImage: `linear-gradient(rgba(10,22,40,0.08), rgba(10,22,40,0.35)), url(${eventImage(ev.image)})`, backgroundSize: 'cover', backgroundPosition: 'center' }
                  : { backgroundImage: `${PATTERN}, ${cat.art}` }}>
                  {!ev.image && <span style={{ fontSize: 38, filter: 'drop-shadow(0 3px 6px rgba(0,0,0,0.35))' }}>{cat.emoji}</span>}
                  {/* multi-select checkbox — upper corner */}
                  {selectMode && (
                    <span className="absolute top-2.5 left-2.5 w-6 h-6 rounded-md bg-white shadow-lg flex items-center justify-center">
                      {isSelected
                        ? <CheckSquare className="w-4.5 h-4.5 text-brand-red" style={{ width: 18, height: 18 }} />
                        : <Square className="w-4.5 h-4.5 text-gray-300" style={{ width: 18, height: 18 }} />}
                    </span>
                  )}
                  <span className={`absolute top-2.5 text-[10px] font-extrabold uppercase tracking-wide text-white px-2.5 py-1 rounded-full ${selectMode ? 'left-10' : 'left-2.5'}`} style={{ background: cat.color }}>{cat.label}</span>
                  {/* Month over day — the rest of the app reads month-first
                      ("Aug 19"); this badge used to read "19 / AUG". */}
                  {dayBadge && (
                    <div className="absolute top-2.5 right-2.5 bg-white rounded-lg px-2.5 py-1.5 text-center shadow-lg">
                      <div className="text-[9px] font-extrabold text-gray-400 uppercase tracking-wide">{dayBadge.month}</div>
                      <div className="text-base font-black text-brand-red leading-none">{dayBadge.day}</div>
                    </div>
                  )}
                </div>
                <div className="p-4 flex flex-col flex-1">
                  <h3 className="text-[15px] font-extrabold text-gray-900 leading-snug">{ev.name}</h3>
                  <p className="text-xs text-gray-400 font-bold mt-1">
                    {fmtDate(ev)}{ev.time ? ` · ${ev.time}` : ''} · {[ev.venue, ev.address, ev.city].filter(Boolean).join(', ')}
                  </p>
                  <p className="text-[13px] text-gray-600 font-medium leading-relaxed mt-2">{ev.description}</p>
                  {ev.source_note && (
                    <p className="text-[11px] text-gray-400 font-bold mt-1.5">
                      {ev.source === 'x' ? '𝕏 ' : ev.source === 'news' ? '§ ' : ''}via {ev.source_note}
                    </p>
                  )}

                  {/* lean strip */}
                  <div className="mt-3">
                    <div className="h-2 rounded-full relative" style={{ background: 'linear-gradient(to right, #1D4ED8, #93C5FD 38%, #E2E8F0 50%, #FCA5A5 62%, #B91C1C)' }}>
                      <div className="absolute rounded" style={{ left: `${leanMarkerPos(lean)}%`, top: -4, width: 4, height: 16, background: '#0F172A', border: '1.5px solid #fff', transform: 'translateX(-50%)' }} />
                    </div>
                    <div className="flex justify-between items-center mt-1.5 gap-2">
                      <span className="text-[10px] font-black uppercase tracking-wide px-2 py-0.5 rounded-full whitespace-nowrap" style={{ background: pill.bg, color: pill.fg }}>
                        {pill.text}{lean.label.startsWith('likely') && lean.certainty ? ` · ${lean.certainty}%` : ''}
                      </span>
                      {/* The raw classifier string (tier codes, registry notes)
                          is internal — show the evidence class, keep the full
                          string on hover for anyone who needs it. */}
                      {(() => {
                        const badge = leanBadge(lean.basis)
                        return badge ? (
                          <span title={badge.title}
                            className="text-[10px] font-bold text-gray-400 bg-gray-100 rounded-full px-2 py-0.5 whitespace-nowrap">
                            {badge.text}
                          </span>
                        ) : null
                      })()}
                    </div>
                  </div>

                  {/* mt-auto: the CTA sits on the card's bottom edge whatever the
                      description length, so the row of buttons lines up. */}
                  <div className="mt-auto pt-3 flex gap-2" onClick={e => selectMode && e.stopPropagation()}>
                    <button onClick={() => handleAdd(ev)} disabled={isAdded || selectMode}
                      className={`flex-1 text-[13px] font-extrabold py-2.5 rounded-xl transition-colors ${isAdded ? 'bg-green-100 text-green-700' : 'bg-brand-red text-white hover:bg-red-800'} ${selectMode ? 'opacity-40' : ''}`}>
                      {isAdded ? '✓ Added to calendar' : '＋ Add to calendar'}
                    </button>
                    {isAction && connectedCands.length > 0 && !selectMode && (
                      <button onClick={() => openCandPicker([ev])} title="Add to a connected candidate's calendar"
                        className="flex items-center gap-1 px-3 rounded-xl border-2 border-brand-navy/20 text-brand-navy text-[12px] font-extrabold hover:border-brand-navy hover:bg-brand-navy hover:text-white transition-colors whitespace-nowrap">
                        <Users className="w-3.5 h-3.5" /> Candidate
                      </button>
                    )}
                    {ev.url && !selectMode && (
                      <a href={ev.url} target="_blank" rel="noreferrer" title="Event website"
                        className="w-10 rounded-xl border-2 border-gray-200 flex items-center justify-center text-gray-400 hover:text-brand-red hover:border-brand-red">
                        <ExternalLink className="w-4 h-4" />
                      </a>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {events && (
        <p className="text-xs text-gray-400 font-semibold">
          ✦ AI-researched from public sources — verify dates with the organizer before committing your schedule. Lean labels: confirmed = partisan host (100%), likely = 80%+ certainty, otherwise nonpartisan.
        </p>
      )}

      {/* toast */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-brand-navy text-white text-sm font-bold px-5 py-3 rounded-xl shadow-2xl z-50 max-w-md text-center">
          {toast}
        </div>
      )}

      {/* calendar picker modal */}
      {pickerEvent && (
        <Dialog onClose={() => setPickerEvent(null)}>
          <div className="fixed inset-0 bg-black/50" onClick={() => setPickerEvent(null)} />
          <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
            <div className="p-5 border-b border-gray-100">
              <h3 className="font-extrabold text-gray-900">{connectedCals.length ? 'Add to which calendar?' : 'No calendars connected yet'}</h3>
              <p className="text-xs text-gray-400 font-semibold mt-0.5">
                {pickerEvent.name} · {fmtDate(pickerEvent)}{pickerEvent.time ? ` · ${pickerEvent.time}` : ''} · {reminderMins >= 60 ? `${reminderMins / 60}-hour` : `${reminderMins}-min`} reminder
              </p>
            </div>
            {connectedCals.length ? (
              <>
                {connectedCals.map(k => (
                  <label key={k} className="flex items-center gap-3 px-5 py-3 border-b border-gray-50 cursor-pointer hover:bg-red-50/40">
                    <span className="w-9 h-9 rounded-xl flex items-center justify-center text-white text-sm font-black" style={{ background: CAL_META[k].color }}>{CAL_META[k].letter}</span>
                    <div className="flex-1">
                      <div className="text-sm font-extrabold text-gray-900">{CAL_META[k].name}</div>
                      <div className="text-[11px] text-gray-400 font-semibold">Badger Board Events feed</div>
                    </div>
                    <input type="checkbox" className="w-4 h-4 accent-brand-red"
                      checked={!!pickerChecked[k]}
                      onChange={e => setPickerChecked(p => ({ ...p, [k]: e.target.checked }))} />
                  </label>
                ))}
                <div className="p-5">
                  <label className="flex items-center gap-2 text-xs font-semibold text-gray-600 cursor-pointer">
                    <input type="checkbox" className="w-3.5 h-3.5 accent-brand-red" checked={pickerRemember} onChange={e => setPickerRemember(e.target.checked)} />
                    Don't ask again — always use the calendars checked above
                  </label>
                  <button onClick={confirmPicker} disabled={!Object.values(pickerChecked).some(Boolean)}
                    className="w-full mt-3 bg-brand-red text-white text-sm font-extrabold py-3 rounded-xl disabled:opacity-40">
                    Add event with {reminderMins >= 60 ? `${reminderMins / 60}-hour` : `${reminderMins}-minute`} reminder
                  </button>
                </div>
              </>
            ) : (
              <div className="p-5">
                <p className="text-sm text-gray-600 font-medium leading-relaxed">
                  Connect Google, Apple, or Outlook in Settings for one-click adds — or download this event now:
                </p>
                <button onClick={() => { downloadIcs(pickerEvent); setPickerEvent(null) }} className="w-full mt-3 bg-brand-navy text-white text-sm font-extrabold py-3 rounded-xl">
                  ↓ Download event (.ics) with reminder
                </button>
                <button onClick={() => { setPickerEvent(null); navigate('/settings#calendars') }} className="w-full mt-2 border-2 border-gray-200 text-gray-700 text-sm font-extrabold py-3 rounded-xl">
                  Connect calendars in Settings →
                </button>
              </div>
            )}
          </div>
        </Dialog>
      )}

      {/* candidate calendar picker (Campaign Connect) */}
      {candPicker && (
        <Dialog onClose={() => !pushing && setCandPicker(null)} className="bg-black/40 backdrop-blur-sm" onClick={() => !pushing && setCandPicker(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="p-5 border-b border-gray-100 flex items-start justify-between gap-3">
              <div>
                <h3 className="font-extrabold text-gray-900 flex items-center gap-2">
                  <Users className="w-4 h-4 text-brand-navy" /> Add to candidate calendars
                </h3>
                <p className="text-xs text-gray-400 font-semibold mt-0.5">
                  {candPicker.events.length === 1
                    ? `${candPicker.events[0].name} · ${fmtDate(candPicker.events[0])}`
                    : `${candPicker.events.length} events selected`}
                </p>
              </div>
              <button onClick={() => !pushing && setCandPicker(null)} className="p-1 rounded-lg hover:bg-gray-100 text-gray-400"><X className="w-4 h-4" /></button>
            </div>
            <div className="max-h-72 overflow-y-auto">
              {connectedCands.map(c => (
                <label key={c.id} className="flex items-center gap-3 px-5 py-3 border-b border-gray-50 cursor-pointer hover:bg-red-50/40">
                  <span className="w-9 h-9 rounded-xl bg-gradient-to-br from-brand-navy to-slate-700 flex items-center justify-center text-white text-sm font-black">
                    {(c.email || '?')[0].toUpperCase()}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-extrabold text-gray-900 truncate">{c.email}</div>
                    <div className="text-[11px] text-gray-400 font-semibold">Connected via Campaign Connect</div>
                  </div>
                  <input type="checkbox" className="w-4 h-4 accent-brand-red"
                    checked={!!candChecked[c.id]}
                    onChange={e => setCandChecked(p => ({ ...p, [c.id]: e.target.checked }))} />
                </label>
              ))}
            </div>
            <div className="p-5">
              <p className="text-[11px] text-gray-400 font-semibold mb-3">
                Events land on each selected candidate's Badger Board calendar feed and flow into their connected Google/Apple/Outlook calendars.
              </p>
              <button onClick={confirmCandPush} disabled={pushing || !Object.values(candChecked).some(Boolean)}
                className="w-full bg-brand-red text-white text-sm font-extrabold py-3 rounded-xl disabled:opacity-40 flex items-center justify-center gap-2">
                {pushing && <Loader2 className="w-4 h-4 animate-spin" />}
                {pushing ? 'Adding…' : `Add ${candPicker.events.length > 1 ? `${candPicker.events.length} events` : 'event'} to ${Object.values(candChecked).filter(Boolean).length || ''} calendar${Object.values(candChecked).filter(Boolean).length !== 1 ? 's' : ''}`}
              </button>
            </div>
          </div>
        </Dialog>
      )}
    </div>
  )
}
