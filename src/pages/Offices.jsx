import React, { useEffect, useState, useMemo, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Building2, Search, Plus, ChevronDown, ChevronUp, ChevronsUpDown,
         MapPin, Briefcase, Scale, Map, LayoutList, X, Users, ChevronRight } from 'lucide-react'
import { getOffices, createOffice, getCandidates, getOfficeHistory } from '../lib/supabase'
import LeafletMapView from '../components/LeafletMapView'
import MapErrorBoundary from '../components/MapErrorBoundary'
import DistrictDashboard, { districtKeyFor } from '../components/DistrictDashboard'
import LoadingBar from '../components/LoadingBar'

const LEVELS     = ['', 'federal', 'state', 'county', 'municipal']
const TYPES      = ['', 'executive', 'legislative', 'judicial', 'administrative']
const LEVEL_LABELS = { federal:'Federal', state:'State', county:'County', municipal:'Municipal' }
const TYPE_LABELS  = { executive:'Executive', legislative:'Legislative', judicial:'Judicial', administrative:'Administrative' }

const levelColors = {
  federal:   'bg-blue-100 text-blue-800',
  state:     'bg-brand-red/10 text-brand-red',
  county:    'bg-purple-100 text-purple-800',
  municipal: 'bg-green-100 text-green-700',
}

const PANEL_HEADER_BG = {
  federal:   { bg:'#dbeafe', color:'#1e40af', badge:'bg-blue-100 text-blue-800' },
  state:     { bg:'#fee2e2', color:'#991b1b', badge:'bg-red-100 text-red-700' },
  county:    { bg:'#ede9fe', color:'#5b21b6', badge:'bg-purple-100 text-purple-700' },
  municipal: { bg:'#dcfce7', color:'#14532d', badge:'bg-green-100 text-green-700' },
}

const typeIcons = {
  executive:      Briefcase,
  legislative:    Building2,
  judicial:       Scale,
  administrative: MapPin,
}

const PARTY_COLOR = {
  Republican:  '#dc2626',
  Democrat:    '#2563eb',
  Independent: '#7c3aed',
  Libertarian: '#f97316',
  Green:       '#16a34a',
  Nonpartisan: '#6b7280',
}

const STATUS_CLS = {
  elected:        'bg-green-100 text-green-700',
  declared:       'bg-blue-100 text-blue-700',
  primary_winner: 'bg-purple-100 text-purple-700',
  general:        'bg-amber-100 text-amber-700',
  exploring:      'bg-gray-100 text-gray-500',
  lost:           'bg-red-100 text-red-500',
  withdrawn:      'bg-gray-100 text-gray-400',
}

// ── Match GeoJSON feature to database offices ─────────────────────────────────
// GeoJSON NAME values: "Congressional District 3", "State Senate District 12",
//   "Assembly District 45", "Adams County", "Wausau city"
function matchOffices(district, allOffices) {
  if (!district || !allOffices.length) return []
  const { name, sublabel, layerKey } = district
  const num = parseInt((name.match(/\d+/) || [])[0])

  if (layerKey === 'federal') {
    // Match federal offices by district number (or statewide federal offices)
    return allOffices.filter(o => {
      if (o.level !== 'federal') return false
      if (num && o.district_number != null) return parseInt(o.district_number) === num
      return true // include statewide federal (US Senate)
    })
  }

  if (layerKey === 'state') {
    if (!num) return []
    const isSenate = sublabel === 'State Senate District'
    return allOffices.filter(o => {
      if (o.level !== 'state') return false
      if (parseInt(o.district_number) !== num) return false
      const n = (o.name || '').toLowerCase()
      return isSenate ? n.includes('senate') : (n.includes('assembly') || n.includes('representative') || !n.includes('senate'))
    })
  }

  if (layerKey === 'county') {
    // Match any office whose geography belongs to this county.
    // Three-tier fallback handles different import patterns:
    //   1. county field set (primary)
    //   2. district_name contains county name (e.g. "Marathon County Board District 1")
    //   3. office name contains county name (e.g. offices imported without county field)
    const norm = (s) => (s || '').replace(/ county$/i, '').trim().toLowerCase()
    const countyName = norm(name)
    if (!countyName) return []
    return allOffices.filter(o => {
      if (o.county  && norm(o.county)        === countyName) return true
      if (o.district_name && norm(o.district_name).includes(countyName)) return true
      if (o.name    && norm(o.name).includes(countyName))   return true
      return false
    })
  }

  if (layerKey === 'municipal') {
    // "Wausau city" → "Wausau". When the clicked feature carries its CTV type and
    // county (regenerated geodata), match precisely on district_name — this keeps
    // "Town of Grant" clicks from pulling in Grant County or Village of Grant
    // offices, and disambiguates same-named towns in different counties.
    const norm = (s) => (s || '').replace(/ (city|village|town|township|borough|cdp)$/i, '').trim().toLowerCase()
    const cityName = norm(name)
    if (!cityName) return []
    const { county, ctv } = district
    if (ctv === 'city' || ctv === 'village' || ctv === 'town') {
      const target = `${ctv} of ${cityName}`
      const precise = allOffices.filter(o => {
        if ((o.district_name || '').toLowerCase() !== target) return false
        if (ctv === 'town' && county && o.county) {
          return o.county.toLowerCase() === county.toLowerCase()
        }
        return true
      })
      if (precise.length > 0) return precise
    }
    // Fallback for offices imported without district_name
    return allOffices.filter(o => {
      if (norm(o.city) === cityName) return true
      if (o.district_name && norm(o.district_name).includes(cityName)) return true
      if (o.name         && norm(o.name).includes(cityName))          return true
      return false
    })
  }

  return []
}

// ── Office history modal — past elections & previous office holders ──────────
function OfficeHistoryModal({ office, onClose }) {
  const [history, setHistory] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let mounted = true
    getOfficeHistory(office.name).then(({ data }) => {
      if (mounted) { setHistory(data || []); setLoading(false) }
    }).catch(() => { if (mounted) setLoading(false) })
    return () => { mounted = false }
  }, [office.name])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col">
        <div className="p-6 border-b border-gray-100 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-bold text-gray-900">{office.name}</h2>
            <p className="text-sm text-gray-500 mt-1">
              {office.current_officeholder
                ? <>Current officeholder: <span className="font-semibold text-gray-900">{office.current_officeholder}</span></>
                : 'No current officeholder on record'}
            </p>
          </div>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-600 flex-shrink-0">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-6 overflow-y-auto flex-1">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <div className="w-8 h-8 border-4 border-brand-red border-t-transparent rounded-full animate-spin" />
            </div>
          ) : history.length === 0 ? (
            <div className="text-center py-10">
              <p className="text-gray-500 font-medium">No election records for this office yet</p>
              <p className="text-gray-400 text-sm mt-1">
                Past results appear here once elections for this office are recorded on the Elections page.
              </p>
            </div>
          ) : (
            <div className="space-y-5">
              {history.map(contest => {
                const winners = (contest.results || []).filter(r => r.winner && r.declared)
                const others  = (contest.results || []).filter(r => !(r.winner && r.declared))
                  .sort((a, b) => (b.votes || 0) - (a.votes || 0))
                return (
                  <div key={contest.id} className="rounded-xl border border-gray-200 overflow-hidden">
                    <div className="px-4 py-2.5 bg-gray-50 border-b border-gray-100 flex items-center justify-between gap-2 flex-wrap">
                      <span className="text-sm font-semibold text-gray-900">{contest.election?.name || contest.office}</span>
                      <span className="text-xs text-gray-400">
                        {contest.election?.election_date
                          ? new Date(contest.election.election_date + 'T12:00:00').toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' })
                          : ''}
                      </span>
                    </div>
                    <div className="divide-y divide-gray-50">
                      {winners.map(r => (
                        <div key={r.id} className="px-4 py-2.5 flex items-center justify-between gap-2 bg-green-50/50">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="text-xs font-bold text-green-700 bg-green-100 px-1.5 py-0.5 rounded flex-shrink-0">WON</span>
                            <span className="text-sm font-semibold text-gray-900 truncate">{r.candidate_name}</span>
                            {r.party && <span className="text-xs text-gray-400 flex-shrink-0">({r.party})</span>}
                          </div>
                          <span className="text-sm text-gray-600 flex-shrink-0">
                            {(r.votes || 0).toLocaleString()} votes{r.vote_pct != null ? ` · ${Number(r.vote_pct).toFixed(1)}%` : ''}
                          </span>
                        </div>
                      ))}
                      {others.map(r => (
                        <div key={r.id} className="px-4 py-2 flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="text-sm text-gray-600 truncate">{r.candidate_name}</span>
                            {r.party && <span className="text-xs text-gray-400 flex-shrink-0">({r.party})</span>}
                          </div>
                          <span className="text-sm text-gray-400 flex-shrink-0">
                            {(r.votes || 0).toLocaleString()} votes{r.vote_pct != null ? ` · ${Number(r.vote_pct).toFixed(1)}%` : ''}
                          </span>
                        </div>
                      ))}
                      {(contest.results || []).length === 0 && (
                        <div className="px-4 py-3 text-sm text-gray-400">No results recorded for this contest</div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── District side panel ───────────────────────────────────────────────────────
function DistrictPanel({ district, panelOffices, allCandidates, onClose, navigate }) {
  const theme = PANEL_HEADER_BG[district.layerKey] || PANEL_HEADER_BG.county

  return (
    <div style={{
      position: 'absolute', left: 0, top: 0, bottom: 0, width: 300,
      zIndex: 2000, background: 'white',
      boxShadow: '4px 0 24px rgba(0,0,0,0.18)',
      display: 'flex', flexDirection: 'column',
      borderRadius: '12px 0 0 12px',
    }}>
      {/* Header */}
      <div style={{
        background: theme.bg, padding: '14px 16px',
        borderBottom: '1px solid rgba(0,0,0,0.07)',
        borderRadius: '12px 0 0 0',
        display: 'flex', alignItems: 'flex-start', gap: 10,
      }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1, color: theme.color, marginBottom: 3 }}>
            {district.sublabel}
          </div>
          <div style={{ fontSize: 15, fontWeight: 800, color: '#111', lineHeight: 1.3 }}>
            {district.name}
          </div>
        </div>
        <button
          onClick={onClose}
          style={{ color: theme.color, opacity: 0.6, flexShrink: 0, marginTop: 1, background: 'none', border: 'none', cursor: 'pointer', padding: 2 }}
          title="Close"
        >
          <X size={16} />
        </button>
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 0' }}>
        {panelOffices.length === 0 ? (
          <div style={{ padding: '32px 20px', textAlign: 'center' }}>
            <Building2 size={32} style={{ margin: '0 auto 10px', color: '#d1d5db' }} />
            <div style={{ fontSize: 13, color: '#6b7280', fontWeight: 600 }}>No offices tracked</div>
            <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 4 }}>
              No positions have been added for this district yet.
            </div>
          </div>
        ) : (
          panelOffices.map(office => {
            const TypeIcon = typeIcons[office.office_type] || Building2
            const candidates = allCandidates.filter(c => c.office_id === office.id)

            const handleOfficeClick = () => {
              if (candidates.length === 1) {
                navigate(`/candidates/${candidates[0].id}`)
              } else {
                navigate(`/candidates?officeId=${office.id}`)
              }
            }

            return (
              <div key={office.id}
                onClick={handleOfficeClick}
                style={{
                  margin: '0 10px 10px',
                  borderRadius: 10,
                  border: '1px solid #e5e7eb',
                  overflow: 'hidden',
                  cursor: 'pointer',
                  transition: 'box-shadow 0.15s, border-color 0.15s',
                }}
                onMouseEnter={e => {
                  e.currentTarget.style.boxShadow = '0 2px 8px rgba(0,0,0,0.12)'
                  e.currentTarget.style.borderColor = '#cbd5e1'
                }}
                onMouseLeave={e => {
                  e.currentTarget.style.boxShadow = 'none'
                  e.currentTarget.style.borderColor = '#e5e7eb'
                }}
              >
                {/* Office header */}
                <div style={{
                  padding: '10px 12px',
                  background: '#f9fafb',
                  borderBottom: candidates.length ? '1px solid #e5e7eb' : 'none',
                  display: 'flex', alignItems: 'flex-start', gap: 8,
                }}>
                  <TypeIcon size={15} style={{ color: '#9ca3af', marginTop: 2, flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#111', lineHeight: 1.3 }}>
                      {office.name}
                    </div>
                    <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>
                      {[
                        TYPE_LABELS[office.office_type],
                        office.term_years ? `${office.term_years}-yr term` : null,
                        office.district_number ? `District ${office.district_number}` : null,
                      ].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                  <ChevronRight size={13} style={{ color: '#9ca3af', flexShrink: 0, marginTop: 3 }} />
                </div>

                {/* Candidates */}
                {candidates.length === 0 ? (
                  <div style={{ padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 6 }}>
                    <Users size={12} style={{ color: '#d1d5db' }} />
                    <span style={{ fontSize: 12, color: '#9ca3af', fontStyle: 'italic' }}>No candidates tracked — click to add</span>
                  </div>
                ) : (
                  <div style={{ padding: '6px 0' }}>
                    {candidates.map((c, idx) => (
                      <div key={c.id} style={{
                        padding: '6px 12px',
                        display: 'flex', alignItems: 'center', gap: 8,
                        background: idx % 2 === 0 ? 'white' : '#fafafa',
                      }}>
                        {/* Party dot */}
                        <div style={{
                          width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                          background: PARTY_COLOR[c.party] || '#6b7280',
                        }} />
                        {/* Name + party */}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 600, color: '#111', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {c.name}
                          </div>
                          {c.party && (
                            <div style={{ fontSize: 11, color: '#6b7280' }}>{c.party}</div>
                          )}
                        </div>
                        {/* Status badge */}
                        {c.status && (
                          <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium capitalize flex-shrink-0 ${STATUS_CLS[c.status] || 'bg-gray-100 text-gray-500'}`}
                            style={{ fontSize: 10 }}>
                            {c.status.replace(/_/g, ' ')}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function Offices() {
  const navigate = useNavigate()
  const [offices, setOffices]     = useState([])
  const [allOfficesUnfiltered, setAllOfficesUnfiltered] = useState([])
  const [loading, setLoading]     = useState(true)
  const [allCandidates, setAllCandidates] = useState([])
  const [search, setSearch]       = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [levelFilter, setLevelFilter] = useState('')
  const [typeFilter, setTypeFilter]   = useState('')
  const [showModal, setShowModal]     = useState(false)
  const [historyOffice, setHistoryOffice] = useState(null)   // office row for history modal
  const [expandedGroups, setExpandedGroups] = useState({})   // level → true (show all rows)
  const [saving, setSaving]           = useState(false)
  const [fetchError, setFetchError]   = useState(null)
  const [sortField, setSortField]     = useState(null)
  const [sortDir, setSortDir]         = useState('asc')
  const [viewMode, setViewMode]       = useState('map')
  const [mapEverShown, setMapEverShown] = useState(true)
  const [activeLayer, setActiveLayer]   = useState('')
  const [selectedDistrict, setSelectedDistrict] = useState(null)
  const searchDebounceRef = useRef(null)

  const [form, setForm] = useState({
    name: '', level: 'state', office_type: 'legislative',
    district_number: '', district_name: '', county: '', city: '',
    term_years: 4, notes: '',
  })

  // Debounce search input — only fire Supabase query 300ms after typing stops
  useEffect(() => {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current)
    searchDebounceRef.current = setTimeout(() => setDebouncedSearch(search), 300)
    return () => clearTimeout(searchDebounceRef.current)
  }, [search])

  // Fetch offices whenever debounced search or filters change
  useEffect(() => { fetchOffices() }, [debouncedSearch, levelFilter, typeFilter])

  // Load all candidates once for the panel
  useEffect(() => {
    getCandidates().then(({ data }) => setAllCandidates(data || []))
  }, [])

  // Load all offices (unfiltered) once for the map panel
  useEffect(() => {
    getOffices({}).then(({ data }) => setAllOfficesUnfiltered(data || []))
  }, [])

  const fetchOffices = async () => {
    setLoading(true)
    setFetchError(null)
    const { data, error } = await getOffices({
      search:      debouncedSearch || undefined,
      level:       levelFilter     || undefined,
      office_type: typeFilter      || undefined,
    })
    if (error) {
      setFetchError(error.message || 'Failed to load offices. Please try again.')
    } else {
      setOffices(data || [])
    }
    setLoading(false)
  }

  // Offices matching the currently-selected district polygon
  const panelOffices = useMemo(
    () => matchOffices(selectedDistrict, allOfficesUnfiltered),
    [selectedDistrict, allOfficesUnfiltered]
  )

  const switchView = (mode) => {
    if (mode === 'map') setMapEverShown(true)
    setViewMode(mode)
  }

  const toggleLayer = (key) => {
    setSelectedDistrict(null)
    setActiveLayer(prev => prev === key ? '' : key)
  }

  const handleDistrictClick = (info) => setSelectedDistrict(info)

  const handleSave = async (e) => {
    e.preventDefault()
    setSaving(true)
    const { error } = await createOffice({
      ...form,
      term_years:      parseInt(form.term_years),
      district_number: form.district_number || null,
      district_name:   form.district_name   || null,
      county:          form.county          || null,
      city:            form.city            || null,
    })
    if (!error) {
      setShowModal(false)
      setForm({ name:'', level:'state', office_type:'legislative', district_number:'', district_name:'', county:'', city:'', term_years:4, notes:'' })
      fetchOffices()
    }
    setSaving(false)
  }

  const handleSort = (field) => {
    if (sortField === field) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortField(field); setSortDir('asc') }
  }

  const sortOffices = (list) => {
    if (!sortField) return list
    return [...list].sort((a, b) => {
      let av, bv
      if (sortField === 'district') {
        av = a.district_number != null ? String(a.district_number).padStart(4,'0') : (a.district_name || '')
        bv = b.district_number != null ? String(b.district_number).padStart(4,'0') : (b.district_name || '')
      } else if (sortField === 'location') {
        av = [a.county, a.city].filter(Boolean).join(' ')
        bv = [b.county, b.city].filter(Boolean).join(' ')
      } else if (sortField === 'term_years') {
        return sortDir === 'asc' ? (a.term_years??0)-(b.term_years??0) : (b.term_years??0)-(a.term_years??0)
      } else {
        av = (a[sortField]||'').toLowerCase()
        bv = (b[sortField]||'').toLowerCase()
      }
      if (av < bv) return sortDir === 'asc' ? -1 : 1
      if (av > bv) return sortDir === 'asc' ?  1 : -1
      return 0
    })
  }

  const SortIcon = ({ field }) => {
    if (sortField !== field) return <ChevronsUpDown className="w-3 h-3 ml-1 opacity-40" />
    return sortDir === 'asc'
      ? <ChevronUp className="w-3 h-3 ml-1 text-brand-red" />
      : <ChevronDown className="w-3 h-3 ml-1 text-brand-red" />
  }

  const grouped    = offices.reduce((acc, o) => { acc[o.level] = [...(acc[o.level]||[]), o]; return acc }, {})
  const levelOrder = ['federal','state','county','municipal']
  const thClass    = 'table-header cursor-pointer select-none hover:bg-gray-100 transition-colors'

  const LAYER_BUTTONS = [
    { key:'federal',   label:'Federal',   activeCls:'bg-blue-600 text-white border-blue-600',    dotColor:'#1d4ed8' },
    { key:'state',     label:'State',     activeCls:'bg-brand-red text-white border-brand-red',   dotColor:'#dc2626' },
    { key:'county',    label:'County',    activeCls:'bg-purple-600 text-white border-purple-600', dotColor:'#7c3aed' },
    { key:'municipal', label:'Municipal', activeCls:'bg-green-600 text-white border-green-600',   dotColor:'#16a34a' },
  ]

  return (
    <div className="space-y-6">
      <LoadingBar loading={loading} />
      {/* ── Header ── */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Building2 className="w-6 h-6 text-brand-red" /> Offices & Districts
          </h1>
          <p className="text-gray-500 text-sm mt-1">All political offices tracked across Wisconsin</p>
        </div>
        <div className="sm:ml-auto flex items-center gap-2">
          <div className="flex items-center gap-1 bg-gray-100 rounded-lg p-1">
            <button onClick={() => switchView('table')}
              className={`p-1.5 rounded transition-colors ${viewMode==='table' ? 'bg-white text-brand-red shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
              title="Table view"><LayoutList className="w-4 h-4" /></button>
            <button onClick={() => switchView('map')}
              className={`p-1.5 rounded transition-colors ${viewMode==='map' ? 'bg-white text-brand-red shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
              title="Map view"><Map className="w-4 h-4" /></button>
          </div>
          <button onClick={() => setShowModal(true)} className="btn-primary flex items-center gap-2 whitespace-nowrap">
            <Plus className="w-4 h-4" /> Add Office
          </button>
        </div>
      </div>

      {/* ── Filters ── */}
      <div className="card py-4">
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input className="input pl-9" placeholder="Search offices..." value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <select className="input sm:w-44" value={levelFilter} onChange={e => setLevelFilter(e.target.value)}>
            <option value="">All Levels</option>
            {LEVELS.slice(1).map(l => <option key={l} value={l}>{LEVEL_LABELS[l]}</option>)}
          </select>
          <select className="input sm:w-44" value={typeFilter} onChange={e => setTypeFilter(e.target.value)}>
            <option value="">All Types</option>
            {TYPES.slice(1).map(t => <option key={t} value={t}>{TYPE_LABELS[t]}</option>)}
          </select>
        </div>
        <div className="flex items-center gap-4 mt-3 pt-3 border-t border-gray-100">
          <span className="text-sm text-gray-500"><span className="font-semibold text-gray-900">{offices.length}</span> offices</span>
          <div className="flex gap-2 flex-wrap">
            {Object.entries(grouped).map(([level, items]) => (
              <span key={level} className={`text-xs px-2 py-0.5 rounded-full font-medium ${levelColors[level]}`}>
                {LEVEL_LABELS[level]}: {items.length}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* ── Map district toggles ── */}
      {viewMode === 'map' && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-gray-400 font-medium mr-1">Show district outlines:</span>
          {LAYER_BUTTONS.map(({ key, label, activeCls, dotColor }) => {
            const isActive = activeLayer === key
            return (
              <button key={key} onClick={() => toggleLayer(key)}
                title={isActive ? `Hide ${label}` : `Show ${label} boundaries`}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium border-2 transition-all ${
                  isActive ? activeCls : 'bg-white text-gray-500 border-gray-300 hover:border-gray-400'
                }`}>
                <span style={{ width:9, height:9, borderRadius:'50%', flexShrink:0, display:'inline-block',
                  background: isActive ? 'white' : dotColor }} />
                {label}
              </button>
            )
          })}
          {activeLayer && (
            <span className="text-xs text-gray-400 ml-1">— click a district to see its offices</span>
          )}
        </div>
      )}

      {/* ── Map view (with deferred mount + side panel) ── */}
      {mapEverShown && (
        <div
          style={{ display: viewMode === 'map' ? 'block' : 'none', position: 'relative' }}
          className="rounded-xl overflow-hidden h-[640px]"
        >
          <MapErrorBoundary>
            <LeafletMapView
              offices={allOfficesUnfiltered}
              activeLayer={activeLayer}
              onDistrictClick={handleDistrictClick}
            />
          </MapErrorBoundary>

          {/* District side panel (county/municipal) — state & federal open the full dashboard */}
          {selectedDistrict && !districtKeyFor(selectedDistrict) && (
            <DistrictPanel
              district={selectedDistrict}
              panelOffices={panelOffices}
              allCandidates={allCandidates}
              onClose={() => setSelectedDistrict(null)}
              navigate={navigate}
            />
          )}
        </div>
      )}

      {/* ── Table view ── */}
      {viewMode === 'table' && (fetchError ? (
        <div className="flex flex-col items-center justify-center py-20 gap-4">
          <Building2 className="w-10 h-10 text-gray-300" />
          <p className="text-sm font-medium text-red-600">{fetchError}</p>
          <button type="button" onClick={fetchOffices} className="btn-secondary text-sm px-5">
            Retry
          </button>
        </div>
      ) : loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="w-8 h-8 border-4 border-brand-red border-t-transparent rounded-full animate-spin" />
        </div>
      ) : (
        <div className="space-y-6">
          {levelOrder.map(level => {
            const group = grouped[level]
            if (!group || group.length === 0) return null
            return (
              <div key={level}>
                <div className="flex items-center gap-3 mb-3">
                  <span className={`px-3 py-1 rounded-full text-sm font-semibold ${levelColors[level]}`}>{LEVEL_LABELS[level]}</span>
                  <span className="text-sm text-gray-400">{group.length} offices</span>
                  <div className="flex-1 h-px bg-gray-200" />
                </div>
                <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                  <table className="w-full">
                    <thead className="bg-gray-50 border-b border-gray-200">
                      <tr>
                        <th className={thClass} onClick={() => handleSort('name')}><span className="flex items-center">Office <SortIcon field="name" /></span></th>
                        <th className={`${thClass} hidden md:table-cell`} onClick={() => handleSort('district')}><span className="flex items-center">District <SortIcon field="district" /></span></th>
                        <th className={`${thClass} hidden lg:table-cell`} onClick={() => handleSort('location')}><span className="flex items-center">County / City <SortIcon field="location" /></span></th>
                        <th className={thClass} onClick={() => handleSort('office_type')}><span className="flex items-center">Type <SortIcon field="office_type" /></span></th>
                        <th className={`${thClass} hidden sm:table-cell`} onClick={() => handleSort('term_years')}><span className="flex items-center">Term <SortIcon field="term_years" /></span></th>
                        <th className={`${thClass} hidden lg:table-cell`} onClick={() => handleSort('current_officeholder')}><span className="flex items-center">Current Officeholder <SortIcon field="current_officeholder" /></span></th>
                        <th className={`${thClass} hidden xl:table-cell`} onClick={() => handleSort('notes')}><span className="flex items-center">Notes <SortIcon field="notes" /></span></th>
                        <th className="table-header w-20"><span className="sr-only">History</span></th>
                      </tr>
                    </thead>
                    <tbody>
                      {(expandedGroups[level] ? sortOffices(group) : sortOffices(group).slice(0, 150)).map((office, i) => {
                        const TypeIcon = typeIcons[office.office_type] || Building2
                        return (
                          <tr key={office.id} className={`table-row ${i%2===0?'bg-white':'bg-gray-50/50'}`}>
                            <td className="table-cell">
                              <div className="flex items-center gap-2">
                                <TypeIcon className="w-4 h-4 text-gray-400 flex-shrink-0" />
                                <span className="font-medium text-gray-900">{office.name}</span>
                              </div>
                            </td>
                            <td className="table-cell hidden md:table-cell text-gray-500">
                              {office.district_number ? <span>District {office.district_number}</span>
                                : office.district_name ? <span>{office.district_name}</span>
                                : <span className="text-gray-300">—</span>}
                            </td>
                            <td className="table-cell hidden lg:table-cell text-gray-500">
                              {office.county||office.city ? [office.county,office.city].filter(Boolean).join(' / ')
                                : <span className="text-gray-300">Statewide</span>}
                            </td>
                            <td className="table-cell">
                              <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 capitalize">
                                {TYPE_LABELS[office.office_type]||office.office_type}
                              </span>
                            </td>
                            <td className="table-cell hidden sm:table-cell text-gray-500">{office.term_years}yr</td>
                            <td className="table-cell hidden lg:table-cell text-gray-600 text-sm">
                              {office.current_officeholder || <span className="text-gray-300">—</span>}
                            </td>
                            <td className="table-cell hidden xl:table-cell text-gray-400 text-xs max-w-xs truncate">{office.notes||'—'}</td>
                            <td className="table-cell text-right">
                              <button
                                type="button"
                                onClick={() => setHistoryOffice(office)}
                                title="Election history & previous office holders"
                                className="text-xs font-medium text-brand-red hover:underline whitespace-nowrap"
                              >
                                History
                              </button>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                  {!expandedGroups[level] && group.length > 150 && (
                    <div className="p-3 text-center border-t border-gray-100 bg-gray-50/50">
                      <button
                        type="button"
                        onClick={() => setExpandedGroups(g => ({ ...g, [level]: true }))}
                        className="text-sm font-medium text-brand-red hover:underline"
                      >
                        Show all {group.length.toLocaleString()} {LEVEL_LABELS[level].toLowerCase()} offices
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      ))}

      {/* ── District intelligence dashboard (state & federal districts) ── */}
      {selectedDistrict && districtKeyFor(selectedDistrict) && (
        <DistrictDashboard
          district={selectedDistrict}
          panelOffices={panelOffices}
          allCandidates={allCandidates}
          onClose={() => setSelectedDistrict(null)}
          navigate={navigate}
        />
      )}

      {/* ── Office history modal ── */}
      {historyOffice && (
        <OfficeHistoryModal office={historyOffice} onClose={() => setHistoryOffice(null)} />
      )}

      {/* ── Add Office Modal ── */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/50" onClick={() => setShowModal(false)} />
          <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
            <div className="p-6 border-b border-gray-100">
              <h2 className="text-lg font-bold text-gray-900">Add Political Office</h2>
              <p className="text-sm text-gray-500 mt-1">Add a new tracked office or district</p>
            </div>
            <form onSubmit={handleSave} className="p-6 space-y-4">
              <div>
                <label className="label">Office Name *</label>
                <input className="input" value={form.name} onChange={e => setForm({...form, name:e.target.value})} placeholder="e.g. State Assembly Representative" required />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="label">Level *</label>
                  <select className="input" value={form.level} onChange={e => setForm({...form, level:e.target.value})}>
                    {LEVELS.slice(1).map(l => <option key={l} value={l}>{LEVEL_LABELS[l]}</option>)}
                  </select>
                </div>
                <div>
                  <label className="label">Type *</label>
                  <select className="input" value={form.office_type} onChange={e => setForm({...form, office_type:e.target.value})}>
                    {TYPES.slice(1).map(t => <option key={t} value={t}>{TYPE_LABELS[t]}</option>)}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="label">District Number</label>
                  <input className="input" value={form.district_number} onChange={e => setForm({...form, district_number:e.target.value})} placeholder="e.g. 42" />
                </div>
                <div>
                  <label className="label">Term (years)</label>
                  <input className="input" type="number" value={form.term_years} onChange={e => setForm({...form, term_years:e.target.value})} min={1} max={10} />
                </div>
              </div>
              <div>
                <label className="label">District Name</label>
                <input className="input" value={form.district_name} onChange={e => setForm({...form, district_name:e.target.value})} placeholder="e.g. Madison (central)" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="label">County</label>
                  <input className="input" value={form.county} onChange={e => setForm({...form, county:e.target.value})} placeholder="e.g. Dane" />
                </div>
                <div>
                  <label className="label">City</label>
                  <input className="input" value={form.city} onChange={e => setForm({...form, city:e.target.value})} placeholder="e.g. Madison" />
                </div>
              </div>
              <div>
                <label className="label">Notes</label>
                <textarea className="input" rows={2} value={form.notes} onChange={e => setForm({...form, notes:e.target.value})} placeholder="Additional context..." />
              </div>
              <div className="flex gap-3 pt-2">
                <button type="button" onClick={() => setShowModal(false)} className="btn-secondary flex-1">Cancel</button>
                <button type="submit" className="btn-primary flex-1" disabled={saving}>{saving ? 'Saving...' : 'Save Office'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
