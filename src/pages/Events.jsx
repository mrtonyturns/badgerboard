// Events.jsx — Outreach → District Events
// Pick an area (legislative district, county, or any Wisconsin city, village or
// town) → AI researches upcoming community events there, classifies each
// event's political lean, and lets you add events to your connected calendars
// (personal feed) in one click.
//
// Searches are never automatic: a new search can only be started by a click,
// and only when the area's stored results are EMPTY or OUT OF DATE (see
// isStaleCache). The server enforces the same rule.
import { useEffect, useState, useMemo, useCallback, useRef } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import {
  RefreshCw,
  Loader2,
  Sparkles,
  X,
  Settings as SettingsIcon,
  ExternalLink,
  Users,
  CheckSquare,
  Square,
  AlertTriangle,
  Clock,
} from 'lucide-react'
import { supabase, getCandidates } from '../lib/supabase'
import { getUserPlanType } from '../lib/tiers'
import { eventImage } from '../lib/imageProxy'
import { useDialog } from '../lib/useDialog'
import { useAuth } from '../contexts/AuthContext'
import LoadingBar from '../components/LoadingBar'
import SearchableSelect from '../components/SearchableSelect'
import { districtKeyForOffice } from './candidate/shared'

// Module-level caches: each dataset is fetched at most once per page load.
// The municipalities list (1,893 rows) is only fetched when City mode is used.
let _placesCache = null
async function loadPlaces() {
  if (!_placesCache) _placesCache = await fetch('/geodata/wi-district-places.json').then(r => r.json()).catch(() => ({}))
  return _placesCache
}
let _munisCache = null
async function loadMunicipalities() {
  if (!_munisCache) _munisCache = await fetch('/geodata/wi-municipalities.json').then(r => r.json()).catch(() => [])
  return _munisCache
}

// Last area this viewer picked — { mode, key } — so the page reopens there.
const AREA_STORAGE_KEY = 'bb.events.area'
function readSavedArea() {
  try {
    const v = JSON.parse(localStorage.getItem(AREA_STORAGE_KEY) || 'null')
    if (v && ['district', 'county', 'city'].includes(v.mode) && typeof v.key === 'string' && v.key) return v
  } catch {}
  return null
}
function saveArea(mode, key) {
  try { localStorage.setItem(AREA_STORAGE_KEY, JSON.stringify({ mode, key })) } catch {}
}

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

// ── Build selectable district / county index from the places dataset ──────
// `places` is the FULL list for the area, ordered by population; it is sent to
// the server as-is. `area` is the short human description.
export function buildPlaceIndex(places) {
  if (!places) return { district: [], county: [] }
  const districts = [], counties = []
  const labelFor = (key) => {
    const [t, n] = key.split('-')
    if (t === 'assembly') return `Assembly District ${n}`
    if (t === 'senate')   return `State Senate District ${n}`
    if (t === 'congress') return `Congressional District ${n}`
    return key
  }
  for (const [key, v] of Object.entries(places)) {
    const cts = v?.counties || [], pls = v?.places || []
    if (key.startsWith('county-')) {
      const cty = key.slice(7)
      counties.push({ key, name: `${cty} County`, counties: cts.length ? cts : [cty], places: pls,
        area: areaDescription(pls, cts.length ? cts : [cty]) })
    } else {
      districts.push({ key, name: labelFor(key), counties: cts, places: pls, area: areaDescription(pls, cts) })
    }
  }
  const ord = { congress: 0, senate: 1, assembly: 2 }
  districts.sort((a, b) => {
    const [ta, na] = a.key.split('-'), [tb, nb] = b.key.split('-')
    return ((ord[ta] ?? 9) - (ord[tb] ?? 9)) || (parseInt(na) - parseInt(nb))
  })
  counties.sort((a, b) => a.name.localeCompare(b.name))
  return { district: districts, county: counties }
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
// The function's budget is 15 min and it heartbeats every 30 s; real runs are
// 2–5 min. We stop polling at 12 min — and only ever say "still running in the
// background" then if a heartbeat arrived in the last 3 min.
const MAX_WAIT_MS        = 12 * 60 * 1000
const HEARTBEAT_STALE_MS = 3 * 60 * 1000    // no updated_at change this long ⇒ the run died
const clampStage = (stage) => Math.min(Math.max(Number(stage) || 1, 1), PHASE_LABELS.length)
// Used ONLY to decide whether a running row seen on page open is live enough
// to attach to. Polling never compares server timestamps to this clock.
const freshMs = (iso) => {
  const t = Date.parse(iso || '')
  return Number.isFinite(t) ? Date.now() - t : Infinity
}
const fmtElapsed = (ms) => {
  const sec = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`
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

// ── Upcoming / staleness rules ───────────────────────────────────────────────
// "Upcoming" and "out of date" are both measured from TODAY in Wisconsin
// (America/Chicago), never from when the search ran. isStaleCache mirrors the
// server's rule in research-district-events-background.js exactly — a new
// search is only allowed (client AND server) when it returns true.
// ─── R4 PURE HELPERS BEGIN ───
const STALE_AFTER_MS = 7 * 24 * 3600 * 1000

/** Today's date in Wisconsin as YYYY-MM-DD. */
export function centralTodayIso(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now)
  const get = (t) => (parts.find(p => p.type === t) || {}).value
  return `${get('year')}-${get('month')}-${get('day')}`
}

/** First 10 chars of a date string if they are a real calendar day, else null. */
export function isoDay(value) {
  const d = String(value ?? '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null
  const t = Date.parse(`${d}T12:00:00Z`)
  if (!Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== d) return null
  return d
}

/** The day an event is over: (date_end || date_start), or null if unparseable. */
export function eventEndDay(ev) {
  return isoDay(ev?.date_end || ev?.date_start)
}

/** Stale ⇒ the area may be searched again. Stale when the row is missing, has
 * no events, has no event ending today or later, or was fetched more than 7
 * days ago (a missing/unparseable fetched_at can't prove freshness). */
export function isStaleCache(row, todayIso, nowMs = Date.now()) {
  if (!row || !Array.isArray(row.events) || row.events.length === 0) return true
  const today = todayIso || centralTodayIso()
  if (!row.events.some(ev => { const end = eventEndDay(ev); return end !== null && end >= today })) return true
  const fetched = Date.parse(row.fetched_at || '')
  if (!Number.isFinite(fetched)) return true
  return nowMs - fetched > STALE_AFTER_MS
}

/** Events still worth showing: a valid start date, and (date_end || date_start)
 * on or after today — so a multi-day fair stays listed until it ends. Events
 * with unparseable dates are hidden (they would render as "Invalid Date").
 * Sorted by start date. `today` is a YYYY-MM-DD string or a Date. */
export function filterUpcoming(events, today = new Date()) {
  if (!Array.isArray(events)) return []
  const todayIso = today instanceof Date ? centralTodayIso(today) : String(today)
  const out = []
  for (const ev of events) {
    const start = isoDay(ev?.date_start)
    const end = eventEndDay(ev)
    if (!start || !end) continue
    if (end >= todayIso) out.push({ ev, start })
  }
  out.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))
  return out.map(x => x.ev)
}

/** "Oct 3" in Wisconsin time, or '' for a missing/bad timestamp. */
export function fmtMonDay(iso) {
  const t = Date.parse(iso || '')
  if (!Number.isFinite(t)) return ''
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Chicago' })
}

/** "Wausau, Weston, Kronenwetter and 52 more (Marathon County)". */
export function areaDescription(places, counties) {
  const pls = Array.isArray(places) ? places.filter(Boolean) : []
  const cts = Array.isArray(counties) ? counties.filter(Boolean) : []
  const head = pls.slice(0, 3).join(', ')
  const more = pls.length > 3 ? ` and ${pls.length - 3} more` : ''
  const cty = cts.length === 0 ? ''
    : cts.length === 1 ? `${cts[0]} County`
    : cts.length <= 3 ? `${cts.join(', ')} counties`
    : `${cts.slice(0, 3).join(', ')} and ${cts.length - 3} more counties`
  if (!head) return cty
  return cty ? `${head}${more} (${cty})` : `${head}${more}`
}

/** City-mode options from wi-municipalities.json (already population-sorted).
 * key = `city-${label}-${county}` (server contract). The picker label always
 * carries the type and county, so same-named places are distinguishable. If
 * two rows collide on key (e.g. a city and a village with the same name in one
 * county), the more populous one wins. */
export function buildCityOptions(munis) {
  if (!Array.isArray(munis)) return []
  const counties = new Map()
  for (const m of munis) {
    if (!m?.label || !m?.c) continue
    if (!counties.has(m.label)) counties.set(m.label, new Set())
    counties.get(m.label).add(m.c)
  }
  const seen = new Set(), out = []
  for (const m of munis) {
    if (!m?.label || !m?.c || !m?.n) continue
    const key = `city-${m.label}-${m.c}`
    if (seen.has(key)) continue
    seen.add(key)
    const multi = counties.get(m.label).size > 1
    out.push({
      key,
      name: multi ? `${m.label} (${m.c} Co.)` : `${m.label}, WI`,
      pickLabel: `${m.n} \u2014 ${m.t}, ${m.c} Co.`,
      counties: [m.c],
      places: [m.n],
      area: `${m.n} (${m.t}, ${m.c} County)`,
    })
  }
  return out
}
// ─── R4 PURE HELPERS END ───

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
  const start = isoDay(e?.date_start)
  if (!start) return ''
  let out = new Date(`${start}T12:00:00`).toLocaleDateString('en-US', opts)
  const end = isoDay(e.date_end)
  if (end && end !== start) {
    out += `–${new Date(`${end}T12:00:00`).toLocaleDateString('en-US', opts)}`
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
  const [areaReady, setAreaReady]     = useState(false)       // default area resolved
  const [places, setPlaces]           = useState(null)
  const [munis, setMunis]             = useState(null)        // lazy: City mode only
  const [row, setRow]                 = useState(null)        // district_events cache row
  const [cacheChecked, setCacheChecked] = useState(false)     // cache looked up for this area
  const [loadError, setLoadError]     = useState(null)        // cache/progress query failed
  const [reloadKey, setReloadKey]     = useState(0)
  const [run, setRun]                 = useState(null)        // { stage, startedAt } while a search runs
  const [runError, setRunError]       = useState(null)
  const [runNotice, setRunNotice]     = useState(null)
  const [nowMs, setNowMs]             = useState(() => Date.now())
  const [filter, setFilter]           = useState('all')
  const [pickerEvent, setPickerEvent] = useState(null)   // event awaiting calendar choice
  const [pickerChecked, setPickerChecked] = useState({})
  const [pickerRemember, setPickerRemember] = useState(false)
  const [added, setAdded]             = useState({})     // event name → true
  const [toast, setToast]             = useState(null)

  const events    = row?.events || null
  const fetchedAt = row?.fetched_at || null

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
  useEffect(() => {
    if (mode === 'city' && !munis) loadMunicipalities().then(setMunis)
  }, [mode, munis])

  // ── Default area ─────────────────────────────────────────────────────────────
  // (a) the area this viewer last picked, else (b) the district of their first
  // candidate with an office, else (c) Congressional District 1.
  useEffect(() => {
    let cancelled = false
    const saved = readSavedArea()
    if (saved) { setMode(saved.mode); setSel(saved.key); setAreaReady(true); return }
    getCandidates()
      .then(({ data }) => {
        if (cancelled) return
        let key = null
        for (const c of data || []) {
          if (!c?.office) continue
          key = districtKeyForOffice(c.office) || officeToDistrict(c.office)?.key || null
          if (key) break
        }
        if (key) { setMode(key.startsWith('county-') ? 'county' : 'district'); setSel(key) }
        else { setMode('district'); setSel('congress-1') }
      })
      .catch(() => { if (!cancelled) { setMode('district'); setSel('congress-1') } })
      .finally(() => { if (!cancelled) setAreaReady(true) })
    return () => { cancelled = true }
  }, [])

  // Poll-generation counter: every new area/search (or unmount) bumps it,
  // which cancels older in-flight loops — no setState after unmount, and a
  // slow response for a previously-selected area can never overwrite the
  // current area's results (stale-response-wins race).
  const pollGenRef = useRef(0)
  useEffect(() => () => { pollGenRef.current++ }, [])

  const index       = useMemo(() => buildPlaceIndex(places), [places])
  const cityOptions = useMemo(() => buildCityOptions(munis), [munis])
  // Memoized so both keep one identity until the data/mode/sel actually change.
  const options = useMemo(() => (mode === 'city' ? cityOptions : index[mode]) || [], [index, cityOptions, mode])
  const pickerOptions = useMemo(() => options.map(o => ({ value: o.key, label: o.pickLabel || o.name })), [options])
  const target  = useMemo(() => options.find(o => o.key === sel) || null, [options, sel])

  // Keep a valid selection when the mode changes or a dataset loads (only once
  // the default area is resolved, so it can't clobber it). The only write is
  // a key that IS in options, so the effect converges in one step.
  useEffect(() => {
    if (!areaReady) return
    if (options.length && !options.find(o => o.key === sel)) setSel(options[0].key)
  }, [areaReady, options, sel])

  const chooseArea = (key) => { setSel(key); saveArea(mode, key) }

  // Query errors are THROWN so a failed read can never masquerade as
  // "nothing has been searched yet".
  const readCache = useCallback(async (key) => {
    const { data, error } = await supabase.from('district_events')
      .select('events, fetched_at').eq('district_key', key).maybeSingle()
    if (error) throw error
    return data || null
  }, [])

  const readProgress = useCallback(async (key) => {
    const { data, error } = await supabase.from('district_events_progress')
      .select('stage, status, message, started_at, updated_at')
      .eq('district_key', key).maybeSingle()
    if (error) throw error
    return data || null
  }, [])

  /** Poll a run to completion. Resolves 'done' | 'empty' | 'background'; throws
   * on a server-reported error or a dead run.
   *  - progSnapshot: the progress row's updated_at read BEFORE we POSTed (or
   *    null). Rows with updated_at <= it belong to an earlier run and are
   *    ignored — a server-vs-server comparison, never against this clock.
   *  - attachTo: a live running row we are joining instead of starting one.
   *  - cacheSnapshot: the cache row's fetched_at before the run; a newer cache
   *    row is proof the run finished.
   * Liveness is judged by LOCAL elapsed time since the last observed change of
   * updated_at (the server heartbeats every 30 s). */
  const watchRun = useCallback(async (key, { progSnapshot = null, attachTo = null, cacheSnapshot = null, alive }) => {
    const startedLocal = Date.now()
    const snapMs = progSnapshot ? Date.parse(progSnapshot) : -Infinity
    const cacheSnapMs = cacheSnapshot ? Date.parse(cacheSnapshot) : -Infinity
    let lastSeen = attachTo?.updated_at ?? null
    let lastChangeLocal = Date.now()
    for (;;) {
      await new Promise(r => setTimeout(r, POLL_MS))
      if (!alive()) return 'cancelled'
      let prog = null, cache = null
      try {
        ;[prog, cache] = await Promise.all([readProgress(key), readCache(key)])
      } catch {
        // A transient read failure is not a verdict on the run; the heartbeat
        // timeout below still bounds how long we wait.
      }
      if (!alive()) return 'cancelled'

      const cacheMs = Date.parse(cache?.fetched_at || '')
      if (cache?.events?.length && Number.isFinite(cacheMs) && cacheMs > cacheSnapMs) {
        setRow(cache)
        return 'done'
      }

      const progMs = Date.parse(prog?.updated_at || '')
      if (prog && Number.isFinite(progMs) && progMs > snapMs) {
        if (prog.updated_at !== lastSeen) { lastSeen = prog.updated_at; lastChangeLocal = Date.now() }
        if (prog.status === 'error') throw new Error(prog.message || 'The event search failed.')
        if (prog.status === 'done') {
          if (cache) setRow(cache)
          return cache?.events?.length ? 'done' : 'empty'
        }
        const stage = clampStage(prog.stage)
        setRun(r => (r && r.stage !== stage ? { ...r, stage } : r))
      }

      if (Date.now() - lastChangeLocal > HEARTBEAT_STALE_MS) {
        throw new Error('The event search stopped responding — no progress for 3 minutes, so it most likely failed.')
      }
      // Only reachable with a heartbeat inside the last 3 minutes.
      if (Date.now() - startedLocal > MAX_WAIT_MS) return 'background'
    }
  }, [readCache, readProgress])

  /** Show the progress card for a run and follow it to its outcome. */
  const followRun = useCallback(async (key, opts) => {
    const { alive, attachTo } = opts
    const serverStart = Date.parse(attachTo?.started_at || '')
    setRunError(null); setRunNotice(null)
    setRun({
      stage: clampStage(attachTo?.stage),
      // Display only (elapsed timer).
      startedAt: Number.isFinite(serverStart) && serverStart <= Date.now() ? serverStart : Date.now(),
    })
    try {
      const outcome = await watchRun(key, opts)
      if (!alive()) return
      if (outcome === 'background') {
        setRunNotice('This search is taking longer than usual but is still reporting progress. Results are saved for everyone — check back in a few minutes.')
      } else if (outcome === 'empty') {
        setRunNotice('The search finished but found no upcoming public events for this area.')
      }
    } catch (e) {
      if (alive()) setRunError(e.message)
    }
    if (alive()) setRun(null)
  }, [watchRun])

  // Area change → show what is stored, attach to a live run if there is one,
  // and NOTHING else: no search ever starts without a click.
  useEffect(() => {
    // Bumping the generation cancels the previous area's watch loop (also when
    // the new mode's list is still loading and there is no target yet).
    const gen = ++pollGenRef.current
    const alive = () => pollGenRef.current === gen
    setRow(null); setCacheChecked(false); setLoadError(null)
    setRun(null); setRunError(null); setRunNotice(null)
    if (!target?.key) return
    const key = target.key
    ;(async () => {
      let cached, prog
      try {
        ;[cached, prog] = await Promise.all([readCache(key), readProgress(key)])
      } catch {
        if (alive()) { setLoadError("Couldn't load events — retry"); setCacheChecked(true) }
        return
      }
      if (!alive()) return
      setRow(cached); setCacheChecked(true)
      // A run already in flight (this viewer's, from before they navigated
      // away, or anyone else's) is watched, not restarted.
      if (prog?.status === 'running' && freshMs(prog.updated_at) < HEARTBEAT_STALE_MS) {
        await followRun(key, { attachTo: prog, cacheSnapshot: cached?.fetched_at ?? null, alive })
      } else if (prog?.status === 'error') {
        const errMs = Date.parse(prog.updated_at || ''), cacheMs = Date.parse(cached?.fetched_at || '')
        // Only surface the failure if nothing succeeded after it.
        if (!Number.isFinite(cacheMs) || !Number.isFinite(errMs) || errMs > cacheMs) {
          setRunError(prog.message || 'The last search for this area failed.')
        }
      }
    })()
  }, [target?.key, reloadKey, readCache, readProgress, followRun])

  // Elapsed-time ticker for the progress card.
  useEffect(() => {
    if (!run) return
    const id = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(id)
  }, [run])

  const todayIso = centralTodayIso()
  const stale    = isStaleCache(row, todayIso)
  // Owner policy: a new search is only offered when results are empty or out of date.
  const canSearch = Boolean(target) && cacheChecked && !loadError && !run && stale

  /** The ONLY way a search starts: an explicit click, and only on a stale/empty area. */
  const startSearch = useCallback(async () => {
    if (!target || run) return
    if (!isStaleCache(row, centralTodayIso())) return
    const key = target.key
    const gen = ++pollGenRef.current
    const alive = () => pollGenRef.current === gen
    setRunError(null); setRunNotice(null)
    setRun({ stage: 1, startedAt: Date.now() })
    try {
      // Snapshot both durable channels BEFORE posting (see watchRun).
      const [prog, cache] = await Promise.all([readProgress(key), readCache(key)])
      if (!alive()) return
      if (prog?.status === 'running' && freshMs(prog.updated_at) < HEARTBEAT_STALE_MS) {
        await followRun(key, { attachTo: prog, cacheSnapshot: cache?.fetched_at ?? null, alive })
        return
      }
      if (cache && !isStaleCache(cache, centralTodayIso())) {
        // Someone else refreshed this area in the meantime.
        setRow(cache); setRun(null)
        return
      }
      const { data: { session } } = await supabase.auth.getSession()
      // The server silently drops unauthenticated requests (it must not let
      // them mark a shared area as failed), so report a lost session here.
      if (!session?.access_token) {
        setRunError('Your sign-in has expired — refresh the page, sign in again and retry.')
        setRun(null)
        return
      }
      const res = await fetch('/.netlify/functions/research-district-events-background', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({
          district_key: key,
          district_name: target.name,
          counties: target.counties || [],
          places: target.places || [],
          area_description: target.area || target.name,
          force: false,
        }),
      })
      if (!alive()) return
      if (res.status !== 202 && !res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j.error || 'Could not start the event search — try again.')
      }
      await followRun(key, { progSnapshot: prog?.updated_at ?? null, cacheSnapshot: cache?.fetched_at ?? null, alive })
    } catch (e) {
      if (alive()) { setRunError(e.message || 'Could not start the event search — try again.'); setRun(null) }
    }
  }, [target, run, row, readCache, readProgress, followRun])

  // Everything rendered derives from `upcoming` (Central-time today), never
  // straight from `events`.
  const upcoming = useMemo(() => filterUpcoming(events, todayIso), [events, todayIso])

  const filtered = useMemo(() => {
    if (!upcoming.length) return []
    if (filter === 'all') return upcoming
    return upcoming.filter(e => {
      const l = e.lean?.label || 'nonpartisan'
      if (filter === 'conservative') return l.includes('conservative')
      if (filter === 'liberal') return l.includes('liberal')
      return l === 'nonpartisan'
    })
  }, [upcoming, filter])

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
      <LoadingBar loading={Boolean(run) || (Boolean(target) && !cacheChecked)} />

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

      {/* area selector: district / county / city, village or town */}
      <div className="card py-4">
        <div className="flex flex-col gap-3">
          <div className="flex gap-1.5 flex-wrap">
            {[['district', 'District'], ['county', 'County'], ['city', 'City / village / town']].map(([k, label]) => (
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
                onChange={chooseArea}
                options={pickerOptions}
                placeholder={options.length ? 'Select an area…' : 'Loading…'}
                buttonClassName="font-semibold"
                disabled={!options.length}
                searchPlaceholder={`Search ${mode === 'district' ? 'districts' : mode === 'county' ? 'counties' : 'cities, villages and towns'}…`}
              />
            </div>
            {target && (
              <span className="text-xs font-bold bg-red-50 text-brand-red px-2.5 py-1 rounded-full whitespace-nowrap">{target.name}</span>
            )}
          </div>
          <p className="text-xs text-gray-400 font-semibold">
            Pick a district, county, or any Wisconsin city, village or town
            {target?.area && target.area !== target.name ? <> — {target.area}</> : null}
          </p>
        </div>
      </div>

      {/* Couldn't read the stored results — say so; never show "no events". */}
      {loadError && (
        <div className="card py-8 text-center">
          <AlertTriangle className="w-7 h-7 text-red-500 mx-auto mb-2" />
          <p className="text-sm font-bold text-red-600">{loadError}</p>
          <button onClick={() => setReloadKey(k => k + 1)} className="btn-secondary text-sm mt-3">Retry</button>
        </div>
      )}

      {/* Running — shown for EVERY running state, including over old results. */}
      {run && (() => {
        const activeStage = clampStage(run.stage) - 1
        return (
          <div className="card flex flex-col items-center justify-center py-10">
            <Loader2 className="w-8 h-8 text-brand-red animate-spin mb-3" />
            <p className="text-sm font-bold text-gray-700">{PHASE_LABELS[activeStage]}</p>
            <div className="flex gap-1.5 mt-4 w-full max-w-sm px-6">
              {PHASE_LABELS.map((_, i) => (
                <span key={i} className={`h-1.5 flex-1 rounded-full ${
                  i < activeStage ? 'bg-brand-red'
                  : i === activeStage ? 'bg-brand-red/40 animate-pulse'
                  : 'bg-gray-200'}`} />
              ))}
            </div>
            <p className="text-xs text-gray-400 font-semibold mt-2 flex items-center gap-1.5">
              Step {activeStage + 1} of {PHASE_LABELS.length}
              <span aria-hidden>·</span>
              <Clock className="w-3 h-3" /> {fmtElapsed(nowMs - run.startedAt)} elapsed
            </p>
            <p className="text-xs text-gray-400 font-semibold mt-2 text-center max-w-md">
              Searches take 2–5 minutes. You can leave this page — results are saved for everyone.
            </p>
          </div>
        )
      })()}

      {/* A run outlived our polling window while still heartbeating, or finished empty. */}
      {runNotice && !run && (
        <div className="card py-6 text-center">
          <p className="text-sm font-bold text-gray-700 max-w-lg mx-auto">{runNotice}</p>
          <button onClick={() => setReloadKey(k => k + 1)} className="btn-secondary text-sm mt-3">Check again</button>
        </div>
      )}

      {/* The search failed (stored progress error, dead run, or failed start). */}
      {runError && !run && (
        <div className="card py-6 text-center">
          <AlertTriangle className="w-7 h-7 text-red-500 mx-auto mb-2" />
          <p className="text-sm font-bold text-red-600 max-w-lg mx-auto">{runError}</p>
          {canSearch && (
            <button onClick={startSearch} className="btn-secondary text-sm mt-3">Try again</button>
          )}
        </div>
      )}

      {/* Never searched — no stored row, nothing running, no error. */}
      {cacheChecked && !loadError && !row && !run && !runError && (
        <div className="card py-14 text-center">
          <Sparkles className="w-8 h-8 text-brand-red mx-auto mb-3" />
          <p className="text-[11px] font-extrabold uppercase tracking-wide text-gray-400">Find events in your district</p>
          <p className="text-base font-extrabold text-gray-900 mt-1">No events for {target?.name || 'this area'} yet</p>
          <p className="text-sm text-gray-500 font-medium mt-1.5 max-w-md mx-auto leading-relaxed">
            Badger Board will research public calendars, local news and community sources, then read each crowd&rsquo;s lean.
          </p>
          <button onClick={startSearch} disabled={!canSearch}
            className="mt-5 inline-flex items-center gap-2 bg-brand-red text-white text-sm font-extrabold px-5 py-3 rounded-xl hover:bg-red-800 disabled:opacity-50 transition-colors">
            <Sparkles className="w-4 h-4" /> Search for events
          </button>
          <p className="text-xs text-gray-400 font-semibold mt-3">Takes 2–5 minutes. You can leave this page — results are saved for everyone.</p>
        </div>
      )}

      {/* Out of date — stored results exist but nothing is upcoming, or they
          are more than 7 days old. Prompt; never auto-search. When nothing
          upcoming is left, this banner IS the empty state. */}
      {cacheChecked && !loadError && row && stale && !run && !runError && (
        <div className={`flex items-center gap-3 flex-wrap bg-amber-50 border-2 border-amber-200 text-amber-900 rounded-xl ${upcoming.length ? 'px-4 py-3' : 'px-5 py-8 justify-center text-center'}`}>
          <RefreshCw className="w-4 h-4 flex-shrink-0" />
          <span className="text-sm font-semibold">
            These results are out of date{fetchedAt && fmtMonDay(fetchedAt) ? ` (last searched ${fmtMonDay(fetchedAt)})` : ''}. Run a new search to find upcoming events.
          </span>
          <button onClick={startSearch} disabled={!canSearch}
            className={`${upcoming.length ? 'ml-auto' : ''} inline-flex items-center gap-1.5 bg-amber-900 text-white text-xs font-extrabold px-3.5 py-2 rounded-lg hover:bg-amber-800 disabled:opacity-50 whitespace-nowrap`}>
            <RefreshCw className="w-3.5 h-3.5" /> Run new search
          </button>
        </div>
      )}

      {/* meta + filters (no re-run control here: fresh results can't be re-searched) */}
      {upcoming.length > 0 && (
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-sm font-bold text-gray-900">{filtered.length} event{filtered.length !== 1 ? 's' : ''}</span>
          {!stale && fetchedAt && fmtMonDay(fetchedAt) && (
            <span className="text-xs text-gray-400 font-semibold">Updated {fmtMonDay(fetchedAt)}</span>
          )}
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

      {upcoming.length > 0 && filtered.length === 0 && (
        <div className="card py-12 text-center">
          <Sparkles className="w-7 h-7 text-gray-300 mx-auto mb-2" />
          <p className="text-sm font-bold text-gray-500">No {filter !== 'all' ? filter + ' ' : ''}events found</p>
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

      {upcoming.length > 0 && (
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
