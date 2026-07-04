// Events.jsx — Outreach → District Events
// Pick one of your offices → AI researches upcoming community events in that
// office's district, classifies each event's political lean, and lets you add
// events to your connected calendars (personal feed) in one click.
import React, { useEffect, useState, useMemo, useCallback } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import {
  CalendarDays, RefreshCw, Loader2, Sparkles, MapPin, ChevronDown,
  Check, X, Settings as SettingsIcon, ExternalLink,
} from 'lucide-react'
import { supabase } from '../lib/supabase'
import { eventImage } from '../lib/imageProxy'

let _placesCache = null
async function loadPlaces() {
  if (!_placesCache) _placesCache = await fetch('/geodata/wi-district-places.json').then(r => r.json()).catch(() => ({}))
  return _placesCache
}
import { useAuth } from '../contexts/AuthContext'
import LoadingBar from '../components/LoadingBar'

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

  useEffect(() => { loadPlaces().then(setPlaces) }, [])

  const index   = useMemo(() => buildPlaceIndex(places), [places])
  const options = index[mode] || []
  const target  = options.find(o => o.key === sel) || null

  // Keep a valid selection when the mode changes or the dataset loads
  useEffect(() => {
    if (options.length && !options.find(o => o.key === sel)) setSel(options[0].key)
  }, [mode, index]) // eslint-disable-line react-hooks/exhaustive-deps

  const CACHE_MS = 24 * 3600 * 1000
  const loadEvents = useCallback(async (force = false) => {
    if (!target) return
    setLoading(true); setError(null); setPhase('Checking for cached events…')
    try {
      // 1. Cache first — shared across all users, refreshed daily
      if (!force) {
        const { data: row } = await supabase.from('district_events')
          .select('events, fetched_at').eq('district_key', target.key).maybeSingle()
        if (row?.events?.length && row.fetched_at && Date.now() - new Date(row.fetched_at).getTime() < CACHE_MS) {
          setEvents(row.events); setFetchedAt(row.fetched_at); setLoading(false)
          return
        }
      }
      // 2. Kick off the background research (202 returns immediately), then poll the cache
      const startedAt = Date.now()
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch('/.netlify/functions/research-district-events-background', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({
          district_key: target.key,
          district_name: target.name,
          counties: target.counties || [],
          force,
          area_description: target.area || target.name,
        }),
      })
      if (res.status !== 202 && !res.ok) throw new Error('Could not start event research — try again')
      setPhase('Searching for public events in your district…')
      for (let i = 0; i < 40; i++) {
        await new Promise(r => setTimeout(r, 3000))
        if (i === 8) setPhase('Classifying audiences and gathering addresses…')
        const { data: row } = await supabase.from('district_events')
          .select('events, fetched_at').eq('district_key', target.key).maybeSingle()
        if (row?.fetched_at && new Date(row.fetched_at).getTime() >= startedAt - 5000) {
          if (!row.events?.length) throw new Error('No public events found for this district right now — try Refresh later')
          setEvents(row.events); setFetchedAt(row.fetched_at); setLoading(false)
          return
        }
      }
      throw new Error('Research is taking longer than expected — try Refresh in a minute')
    } catch (e) { setError(e.message) }
    setLoading(false)
  }, [target?.key]) // eslint-disable-line react-hooks/exhaustive-deps

  // auto-load when office changes (cache-first — cheap)
  useEffect(() => { if (target?.key) { setEvents(null); loadEvents(false) } }, [target?.key]) // eslint-disable-line

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

  const leanMarkerPos = (lean) => {
    const score = Math.max(-100, Math.min(100, lean?.score ?? 0))
    return 50 + score * 0.44
  }

  return (
    <div className="space-y-5">
      <LoadingBar loading={loading} />

      {/* header */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <CalendarDays className="w-6 h-6 text-brand-red" /> District Events
          </h1>
          <p className="text-gray-500 text-sm mt-1">Community events where your campaign should show up — researched for your district, refreshed daily</p>
        </div>
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
              <select className="input font-semibold pr-8" value={sel} onChange={e => setSel(e.target.value)} disabled={!options.length}>
                {!options.length && <option>Loading…</option>}
                {options.map(o => (
                  <option key={o.key} value={o.key}>{o.name}</option>
                ))}
              </select>
            </div>
            {target && (
              <span className="text-xs font-bold bg-red-50 text-brand-red px-2.5 py-1 rounded-full whitespace-nowrap">{target.name}</span>
            )}
            <button onClick={() => loadEvents(true)} disabled={loading || !target} className="flex items-center gap-1.5 text-sm font-bold text-brand-red hover:underline disabled:opacity-50 whitespace-nowrap">
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Refresh events
            </button>
          </div>
          <p className="text-xs text-gray-400 font-semibold">
            Browse upcoming public events by legislative district, county, or city — pick any area in Wisconsin.
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
          </div>
        </div>
      )}

      {/* loading / error / empty */}
      {loading && !events && (
        <div className="card flex flex-col items-center justify-center py-16">
          <Loader2 className="w-8 h-8 text-brand-red animate-spin mb-3" />
          <p className="text-sm font-bold text-gray-700">{phase}</p>
          <p className="text-xs text-gray-400 font-semibold mt-1">First search for a district takes ~30 seconds, then it's cached for everyone</p>
        </div>
      )}
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

      {/* event grid */}
      {filtered.length > 0 && (
        <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(310px, 1fr))' }}>
          {filtered.map((ev, i) => {
            const cat = CATEGORY_META[ev.category] || CATEGORY_META.other
            const lean = ev.lean || { label: 'nonpartisan', certainty: 0, score: 0 }
            const pill = LEAN_PILL[lean.label] || LEAN_PILL.nonpartisan
            const day = new Date(ev.date_start + 'T12:00:00')
            const isAdded = added[ev.name]
            return (
              <div key={`${ev.name}-${i}`} className="bg-white rounded-2xl overflow-hidden border-2 border-transparent hover:border-brand-red transition-all shadow-sm hover:shadow-lg hover:-translate-y-0.5">
                <div className="h-28 relative flex items-center justify-center" style={ev.image
                  ? { backgroundImage: `linear-gradient(rgba(10,22,40,0.08), rgba(10,22,40,0.35)), url(${eventImage(ev.image)})`, backgroundSize: 'cover', backgroundPosition: 'center' }
                  : { backgroundImage: `${PATTERN}, ${cat.art}` }}>
                  {!ev.image && <span style={{ fontSize: 38, filter: 'drop-shadow(0 3px 6px rgba(0,0,0,0.35))' }}>{cat.emoji}</span>}
                  <span className="absolute top-2.5 left-2.5 text-[10px] font-extrabold uppercase tracking-wide text-white px-2.5 py-1 rounded-full" style={{ background: cat.color }}>{cat.label}</span>
                  <div className="absolute top-2.5 right-2.5 bg-white rounded-lg px-2.5 py-1.5 text-center shadow-lg">
                    <div className="text-base font-black text-brand-red leading-none">{day.getDate()}</div>
                    <div className="text-[9px] font-extrabold text-gray-400 uppercase tracking-wide">{day.toLocaleDateString('en-US', { month: 'short' })}</div>
                  </div>
                </div>
                <div className="p-4">
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
                      <span className="text-[10px] font-bold text-gray-400 truncate">{lean.basis || ''}</span>
                    </div>
                  </div>

                  <div className="mt-3 flex gap-2">
                    <button onClick={() => handleAdd(ev)} disabled={isAdded}
                      className={`flex-1 text-[13px] font-extrabold py-2.5 rounded-xl transition-colors ${isAdded ? 'bg-green-100 text-green-700' : 'bg-brand-red text-white hover:bg-red-800'}`}>
                      {isAdded ? '✓ Added to calendar' : '＋ Add to calendar'}
                    </button>
                    {ev.url && (
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
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
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
        </div>
      )}
    </div>
  )
}
