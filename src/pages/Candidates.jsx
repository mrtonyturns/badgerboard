import React, { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Users, Plus, Search, ExternalLink, Trash2, X, Phone, Mail, Globe, Telescope, Lock, Wand2, CheckCircle, AlertCircle, Map, LayoutList, Upload, Zap, FileText } from 'lucide-react'
import { supabase, getCandidates, getOffices, getElections, createCandidate, deleteCandidate, updateCandidate } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { getUserTier, getUserPlanType, getMonitoringSlotMax, canMonitorCandidates, monitoringUnlockLabel, hasFeature, SCOUT_CANDIDATE_LIMIT, featureUnlockLabel } from '../lib/tiers'
import { WebOnlyCta, NATIVE_PLAN_NOTE } from '../components/UpgradeCta'
import LeafletMapView from '../components/LeafletMapView'
import SearchableSelect from '../components/SearchableSelect'
import MapErrorBoundary from '../components/MapErrorBoundary'
import LoadingBar from '../components/LoadingBar'
import CityDemographicsPanel, { usePlaceLookup } from '../components/CityDemographicsPanel'
import { placePath } from '../lib/placeDemographics'
import { partyGroup, partyBadgeClasses, normalizePartyForDb } from '../lib/party'
import { SCOUT_CAP_MESSAGE, scoutCapMessage, monitoringToggleError } from '../lib/capErrors'

// ── Map view/selection persistence (sessionStorage) ───────────────────────────
// Lets "Back" from a city-demographics page (or any navigation away and back)
// restore the exact prior map state instead of resetting to the whole-state view.
const CANDIDATES_MAP_CTX_KEY = 'bb_map_ctx_candidates'

function readMapCtx(key) {
  try {
    const raw = sessionStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return (parsed && typeof parsed === 'object') ? parsed : null
  } catch (_) {
    return null
  }
}

function writeMapCtx(key, payload) {
  try {
    sessionStorage.setItem(key, JSON.stringify(payload))
  } catch (_) {
    // Likely quota exceeded (e.g. a large selectedDistrict.geometry) — retry without geometry
    try {
      const slim = {
        ...payload,
        selectedDistrict: payload.selectedDistrict
          ? { ...payload.selectedDistrict, geometry: undefined }
          : null,
      }
      sessionStorage.setItem(key, JSON.stringify(slim))
    } catch (_) {
      // give up silently — restoring the map view is a nicety, not critical
    }
  }
}

// Party list, status enum and the display-only label map (DB keeps 'exploring',
// users see 'Not Known') live in lib/campaignEnums.js so the plan dashboards
// show the same statuses this page writes.
import {
  PARTIES,
  CANDIDATE_STATUSES as STATUSES,
  candidateStatusLabel as statusLabel,
} from '../lib/campaignEnums'

const WI_COUNTIES = [
  'Adams', 'Ashland', 'Barron', 'Bayfield', 'Brown', 'Buffalo', 'Burnett', 'Calumet', 'Chippewa', 'Clark',
  'Columbia', 'Crawford', 'Dane', 'Dodge', 'Door', 'Douglas', 'Dunn', 'Eau Claire', 'Florence', 'Fond du Lac',
  'Forest', 'Grant', 'Green', 'Green Lake', 'Iowa', 'Iron', 'Jackson', 'Jefferson', 'Juneau', 'Kenosha',
  'Kewaunee', 'La Crosse', 'Lafayette', 'Langlade', 'Lincoln', 'Manitowoc', 'Marathon', 'Marinette', 'Marquette',
  'Menominee', 'Milwaukee', 'Monroe', 'Oconto', 'Oneida', 'Outagamie', 'Ozaukee', 'Pepin', 'Pierce', 'Polk',
  'Portage', 'Price', 'Racine', 'Richland', 'Rock', 'Rusk', 'Sauk', 'Sawyer', 'Shawano', 'Sheboygan',
  'St. Croix', 'Taylor', 'Trempealeau', 'Vernon', 'Vilas', 'Walworth', 'Washburn', 'Washington', 'Waukesha',
  'Waupaca', 'Waushara', 'Winnebago', 'Wood'
]

const WI_COUNTY_COORDS = {
  'Adams': [43.97, -89.82], 'Ashland': [46.58, -90.67], 'Barron': [45.42, -91.85],
  'Bayfield': [46.51, -91.29], 'Brown': [44.47, -88.02], 'Buffalo': [44.38, -91.73],
  'Burnett': [45.86, -92.37], 'Calumet': [44.07, -88.22], 'Chippewa': [45.09, -91.24],
  'Clark': [44.72, -90.61], 'Columbia': [43.47, -89.34], 'Crawford': [43.27, -90.87],
  'Dane': [43.07, -89.40], 'Dodge': [43.43, -88.71], 'Door': [44.95, -87.23],
  'Douglas': [46.60, -91.89], 'Dunn': [44.94, -91.89], 'Eau Claire': [44.73, -91.30],
  'Florence': [45.92, -88.27], 'Fond du Lac': [43.77, -88.49], 'Forest': [45.67, -88.94],
  'Grant': [42.89, -90.69], 'Green': [42.68, -89.59], 'Green Lake': [43.84, -89.00],
  'Iowa': [43.00, -90.14], 'Iron': [46.32, -90.27], 'Jackson': [44.33, -90.72],
  'Jefferson': [43.01, -88.78], 'Juneau': [43.97, -90.11], 'Kenosha': [42.57, -88.00],
  'Kewaunee': [44.55, -87.54], 'La Crosse': [43.90, -91.11], 'Lafayette': [42.66, -90.14],
  'Langlade': [45.28, -89.08], 'Lincoln': [45.34, -89.73], 'Manitowoc': [44.10, -87.67],
  'Marathon': [44.90, -89.77], 'Marinette': [45.33, -87.71], 'Marquette': [43.86, -89.38],
  'Menominee': [44.99, -88.73], 'Milwaukee': [43.02, -87.95], 'Monroe': [44.00, -90.63],
  'Oconto': [44.99, -88.27], 'Oneida': [45.70, -89.54], 'Outagamie': [44.42, -88.43],
  'Ozaukee': [43.37, -87.89], 'Pepin': [44.56, -92.13], 'Pierce': [44.74, -92.40],
  'Polk': [45.47, -92.63], 'Portage': [44.47, -89.50], 'Price': [45.68, -90.36],
  'Racine': [42.72, -87.84], 'Richland': [43.34, -90.41], 'Rock': [42.67, -89.07],
  'Rusk': [45.47, -91.14], 'Sauk': [43.43, -89.88], 'Sawyer': [45.89, -91.17],
  'Shawano': [44.79, -88.77], 'Sheboygan': [43.75, -87.82], 'St. Croix': [45.03, -92.43],
  'Taylor': [45.22, -90.49], 'Trempealeau': [44.27, -91.35], 'Vernon': [43.60, -90.84],
  'Vilas': [46.07, -89.49], 'Walworth': [42.67, -88.54], 'Washburn': [45.89, -91.76],
  'Washington': [43.36, -88.24], 'Waukesha': [43.02, -88.25], 'Waupaca': [44.35, -89.00],
  'Waushara': [44.12, -89.24], 'Winnebago': [44.05, -88.64], 'Wood': [44.45, -90.02],
}

// Keyed by partyGroup() so 'Democrat', 'Democratic' and 'DEM' share a badge.
const partyColor = (p) => ({
  R: 'badge-republican',
  D: 'badge-democrat',
  I: 'badge-independent',
  N: 'badge-nonpartisan',
}[partyGroup(p)] || 'badge-independent')

const statusColor = (s) => ({
  exploring:      'bg-gray-100 text-gray-600',
  declared:       'bg-blue-100 text-blue-700',
  primary_winner: 'bg-purple-100 text-purple-700',
  general:        'bg-yellow-100 text-yellow-700',
  elected:        'bg-green-100 text-green-700',
  lost:           'bg-red-100 text-red-600',
  withdrawn:      'bg-gray-100 text-gray-400',
}[s] || 'bg-gray-100 text-gray-600')

const defaultForm = {
  name: '', party: '', office_id: '', election_id: '', status: 'exploring',
  email: '', phone: '', website: '', campaign_address: '', campaign_city: '',
  campaign_zip: '', campaign_committee: '', campaign_manager: '', treasurer: '',
  occupation: '', employer: '', bio_summary: '', notes: '', twitter_handle: '',
  facebook_url: '', instagram_handle: '',
}

// candidates.notes holds the v2 note store ({ v:2, notes:[], files:[] }).
// Every note created outside the Notes tab is written in that shape with
// ai_access: false so the UI switch and the server-side AI filter
// (_candidate-context.js, which requires ai_access === true) agree.
const notesToV2 = (text, by = 'You') => {
  const t = String(text ?? '').trim()
  if (!t) return null
  return JSON.stringify({
    v: 2,
    notes: [{
      id: (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : Date.now().toString(36),
      text: t,
      ts: new Date().toISOString(),
      by,
      ai_access: false,
    }],
    files: [],
  })
}

export default function Candidates() {
  const { user, session } = useAuth()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const preFilterOfficeId = searchParams.get('officeId') || ''

  const [candidates, setCandidates]             = useState([])
  const [totalCandidateCount, setTotalCandidateCount] = useState(0) // unfiltered total, for Scout cap
  const [activeMonitoringCount, setActiveMonitoringCount] = useState(0) // unfiltered server count, for the slot cap
  const [offices, setOffices]       = useState([])
  const [elections, setElections]   = useState([])
  const [loading, setLoading]       = useState(true)
  const [search, setSearch]         = useState('')
  const [partyFilter, setPartyFilter]   = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [officeFilter, setOfficeFilter] = useState(preFilterOfficeId)
  const [showModal, setShowModal]   = useState(false)
  const [saving, setSaving]         = useState(false)
  const [modalError, setModalError] = useState('')
  const [showCsvModal, setShowCsvModal] = useState(false)
  const [csvRows, setCsvRows]           = useState([])     // parsed preview rows
  const [csvHeaders, setCsvHeaders]     = useState([])     // detected column headers
  const [csvImporting, setCsvImporting] = useState(false)
  const [csvResult, setCsvResult]       = useState(null)   // { inserted, skipped, errors }
  const [csvError, setCsvError]         = useState('')
  const [form, setForm]             = useState(defaultForm)
  const [tab, setTab]               = useState('basic')
  const [autofilling, setAutofilling] = useState(false)
  const [autofillNote, setAutofillNote] = useState('')
  const [showDiscover, setShowDiscover] = useState(false)
  // Restored once, synchronously, from sessionStorage — safe against stale/malformed
  // payloads (readMapCtx already try/catches the parse).
  const [restoredMapCtx] = useState(() => readMapCtx(CANDIDATES_MAP_CTX_KEY))

  const [viewMode, setViewMode] = useState(() => restoredMapCtx?.viewMode === 'map' ? 'map' : 'table')
  const [mapEverShown, setMapEverShown] = useState(() => restoredMapCtx?.viewMode === 'map')
  const [activeLayer, setActiveLayer] = useState(() =>
    typeof restoredMapCtx?.activeLayer === 'string' ? restoredMapCtx.activeLayer : '')
  // A restored selection must still look like a district (a `name` to parse a
  // district number out of and a `layerKey` to branch on). A stale or truncated
  // payload used to restore `{}`, and the first render then called
  // `name.match(...)` on undefined and took the whole page down.
  const [selectedDistrict, setSelectedDistrict] = useState(() => {
    const d = restoredMapCtx?.selectedDistrict
    if (!d || typeof d !== 'object') return null
    return (typeof d.name === 'string' && typeof d.layerKey === 'string') ? d : null
  })
  const [mapView, setMapView] = useState(() =>
    (restoredMapCtx?.view && Array.isArray(restoredMapCtx.view.center) && typeof restoredMapCtx.view.zoom === 'number')
      ? restoredMapCtx.view : null)

  const switchView = (mode) => {
    if (mode === 'map') setMapEverShown(true)
    setViewMode(mode)
  }

  const toggleLayer = (key) => {
    setSelectedDistrict(null)
    setActiveLayer(prev => prev === key ? '' : key)
  }

  const handleDistrictClick = (info) => setSelectedDistrict(info)

  // Persist map context (layer, selection, view) whenever it changes so that
  // navigating to a city page and back restores the exact prior map state.
  useEffect(() => {
    writeMapCtx(CANDIDATES_MAP_CTX_KEY, { activeLayer, viewMode, selectedDistrict, view: mapView })
  }, [activeLayer, viewMode, selectedDistrict, mapView])

  const LAYER_BUTTONS = [
    { key: 'federal',   label: 'Federal',   activeCls: 'bg-blue-600 text-white border-blue-600',    dotColor: '#1d4ed8' },
    { key: 'state',     label: 'State',     activeCls: 'bg-brand-red text-white border-brand-red',   dotColor: '#dc2626' },
    { key: 'county',    label: 'County',    activeCls: 'bg-purple-600 text-white border-purple-600', dotColor: '#7c3aed' },
    { key: 'municipal', label: 'Municipal', activeCls: 'bg-green-600 text-white border-green-600',   dotColor: '#16a34a' },
  ]

  // Candidates visible in the selected district
  const panelCandidates = selectedDistrict ? (() => {
    // Defensive: `selectedDistrict` can come back from sessionStorage as well as
    // from a live map click, so never assume the fields are present.
    const { sublabel, layerKey } = selectedDistrict
    const name = String(selectedDistrict.name ?? '')
    const num = parseInt((name.match(/\d+/) || [])[0])
    return candidates.filter(c => {
      const o = c.office
      if (!o) return false
      if (layerKey === 'federal') return o.level === 'federal' && (!num || o.district_number === num)
      if (layerKey === 'state') {
        if (o.level !== 'state' || o.district_number !== num) return false
        const n = (o.name || '').toLowerCase()
        return sublabel === 'State Senate District' ? n.includes('senate') : !n.includes('senate')
      }
      if (layerKey === 'county') {
        const stripCounty = (s) => (s || '').replace(/ county$/i, '').trim().toLowerCase()
        const county = stripCounty(name)
        return o.level === 'county' && stripCounty(o.county) === county
      }
      if (layerKey === 'municipal') {
        const stripMuni = (s) => (s || '').replace(/ (city|village|town|township|borough|cdp)$/i, '').trim().toLowerCase()
        const city = stripMuni(name)
        return o.level === 'municipal' && stripMuni(o.city) === city
      }
      return false
    })
  })() : []

  // Municipal-click demographics lookup — resolves to null (no-op) for
  // non-municipal clicks, or once the JSON is loaded and no entry exists.
  const { loading: placeLoading, place: cityPlace } = usePlaceLookup(selectedDistrict)

  // Group panel candidates by their office
  const panelByOffice = panelCandidates.reduce((acc, c) => {
    const key = c.office_id || 'unknown'
    if (!acc[key]) acc[key] = { office: c.office, candidates: [] }
    acc[key].candidates.push(c)
    return acc
  }, {})
  const [discoverMode, setDiscoverMode] = useState('county')
  const [discoverCounty, setDiscoverCounty] = useState('')
  const [discoverLevel, setDiscoverLevel] = useState('state')
  const [discoverOffice, setDiscoverOffice] = useState('')
  const [discoverYear, setDiscoverYear] = useState(new Date().getFullYear().toString())
  const [discoverLoading, setDiscoverLoading] = useState(false)
  const [discoverResults, setDiscoverResults] = useState([])
  const [discoverError, setDiscoverError] = useState('')
  const [saveProgress, setSaveProgress] = useState({})

  // Keep an unfiltered total count for the Scout plan cap — refreshed after any save/delete
  const refreshTotalCount = async () => {
    if (!user?.id) return
    const { count } = await supabase
      .from('candidates')
      .select('id', { count: 'exact', head: true })
      .eq('created_by', user.id)
    setTotalCandidateCount(count ?? 0)
  }

  // Active-monitoring slots must come from an UNFILTERED server count, exactly
  // like CandidateDetail.jsx's toggle guard. Counting the rendered `candidates`
  // array instead let any filter (search, party, office, "unmonitored only")
  // hide monitored rows, drop activeCount below the cap and re-open slots the
  // account does not have.
  const refreshActiveCount = async () => {
    if (!user?.id) return
    const { count, error } = await supabase
      .from('candidates')
      .select('id', { count: 'exact', head: true })
      .eq('created_by', user.id)
      .contains('section_timestamps', { monitoring: true })
    if (!error) setActiveMonitoringCount(count ?? 0)
  }

  useEffect(() => {
    fetchData()
    fetchOfficesAndElections()
    refreshTotalCount()
    refreshActiveCount()
  }, [])

  useEffect(() => { fetchData() }, [search, partyFilter, statusFilter, officeFilter])

  const fetchOfficesAndElections = async () => {
    try {
      const [{ data: o, error: oErr }, { data: e, error: eErr }] = await Promise.all([getOffices(), getElections()])
      if (oErr) console.error('Failed to load offices:', oErr)
      if (eErr) console.error('Failed to load elections:', eErr)
      setOffices(o || [])
      setElections(e || [])
    } catch (err) {
      console.error('fetchOfficesAndElections error:', err)
    }
  }

  const fetchData = async () => {
    setLoading(true)
    try {
      const { data, error } = await getCandidates({
        search: search || undefined,
        party: partyFilter || undefined,
        status: undefined,   // status filter removed — monitoring filters are client-side
        office_id: officeFilter || undefined,
      })
      if (error) { console.error('Failed to load candidates:', error); setLoading(false); return }
      // Client-side monitoring filters
      const filtered = statusFilter === '__monitored__'
        ? (data || []).filter(c => c.section_timestamps?.monitoring === true)
        : statusFilter === '__unmonitored__'
          ? (data || []).filter(c => c.section_timestamps?.monitoring !== true)
          : (data || [])
      setCandidates(filtered)
    } catch (err) {
      console.error('fetchData error:', err)
    }
    setLoading(false)
  }

  const handleSave = async (e) => {
    e.preventDefault()
    // Scout plan cap: check the real DB total (not the filtered view).
    // This pre-check is the polite half only — the cap is genuinely enforced
    // server-side by the `scout_candidate_cap` trigger (migration
    // 20260812000030). Checking here just saves a doomed round trip; the
    // insert below still handles the trigger's error if the counts disagree
    // (another tab, another device, a stale count).
    if (getUserTier(user) === 'scout') {
      const { count } = await supabase
        .from('candidates')
        .select('id', { count: 'exact', head: true })
        .eq('created_by', user.id)
      if ((count ?? 0) >= SCOUT_CANDIDATE_LIMIT) {
        setModalError(`The free Scout plan is limited to ${SCOUT_CANDIDATE_LIMIT} candidates. Upgrade your plan to add more.`)
        setTotalCandidateCount(count ?? 0)
        return
      }
    }
    setSaving(true)
    const { error } = await createCandidate({
      ...form,
      office_id: form.office_id || null,
      election_id: form.election_id || null,
      party: form.party || null,
      notes: notesToV2(form.notes, user?.email || 'You'),
    })
    if (!error) {
      setShowModal(false)
      setForm(defaultForm)
      setTab('basic')
      fetchData()
      refreshTotalCount()
    } else {
      // The cap trigger fires when the pre-check above passed but the row count
      // moved underneath us. Show the plan sentence, not a raw 400, and resync
      // the badge/banner counts so the UI stops offering the button.
      const capped = scoutCapMessage(error)
      setModalError(capped || error.message || 'Failed to save candidate. Please try again.')
      if (capped) refreshTotalCount()
    }
    setSaving(false)
  }

  const handleDelete = async (id, name) => {
    if (!window.confirm(`Delete candidate "${name}"? This will also delete their profiles.`)) return
    const { error } = await deleteCandidate(id)
    if (error) {
      alert(`Failed to delete candidate: ${error.message}`)
      return
    }
    fetchData()
    refreshTotalCount()
    refreshActiveCount()   // deleting a monitored candidate frees a slot
  }

  const grouped = candidates.reduce((acc, c) => {
    const key = c.office?.level || 'other'
    if (!acc[key]) acc[key] = []
    acc[key].push(c)
    return acc
  }, {})

  const levelOrder = ['federal', 'state', 'county', 'municipal', 'other']
  const levelLabels = { federal: 'Federal', state: 'State', county: 'County', municipal: 'Municipal', other: 'Other' }

  const handleAutofill = async () => {
    if (!form.name) return
    setAutofilling(true)
    setAutofillNote('')
    try {
      const selectedOffice   = offices.find(o => o.id === form.office_id)
      const selectedElection = elections.find(e => e.id === form.election_id)
      const res = await fetch('/.netlify/functions/autofill-candidate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({
          name:     form.name,
          party:    form.party,
          office:   selectedOffice?.name || '',
          election: selectedElection?.name || '',
        }),
      })
      const json = await res.json().catch(() => ({}))
      // A 403/429/500 is not "no information found" — say what actually happened.
      if (!res.ok) {
        if (res.status === 401) {
          setAutofillNote('Your session expired. Sign in again to use AI autofill.')
        } else if (res.status === 403) {
          setAutofillNote(json.error || 'AI autofill is available on the Campaign plan and above.')
        } else if (res.status === 429) {
          setAutofillNote(json.error || 'AI autofill rate limit reached — try again in a few minutes.')
        } else {
          setAutofillNote(`Autofill failed (HTTP ${res.status}). ${json.error || 'Please fill in the fields manually.'}`)
        }
        setAutofilling(false)
        return
      }
      if (json.fields && Object.keys(json.fields).length > 0) {
        // Strip the notes field before merging into form
        const { notes, ...formFields } = json.fields
        setForm(prev => ({ ...prev, ...formFields }))
        const count = Object.keys(formFields).length
        const context = notes ? ` ${notes}` : ''
        setAutofillNote(`Note: ${count} field${count !== 1 ? 's' : ''} pre-filled from AI training data — accuracy is not guaranteed, especially for local officials. Verify every field before saving.${context}`)
      } else {
        setAutofillNote('No information found. AI autofill works best for well-known state/federal candidates — local officials should be entered manually.')
      }
    } catch {
      setAutofillNote('Autofill failed. Please fill in the fields manually.')
    }
    setAutofilling(false)
  }

  const handleDiscoverSearch = async () => {
    setDiscoverLoading(true)
    setDiscoverError('')
    setDiscoverResults([])
    try {
      const payload = { mode: discoverMode }
      if (discoverMode === 'county') {
        payload.county = discoverCounty
        payload.electionYear = discoverYear
      } else if (discoverMode === 'level') {
        payload.level = discoverLevel
      } else if (discoverMode === 'office') {
        payload.officeName = discoverOffice
        payload.electionYear = discoverYear
      }
      const res = await fetch('/.netlify/functions/discover-candidates', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify(payload),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Discovery failed')
      setDiscoverResults(json.candidates || [])
    } catch (err) {
      setDiscoverError(err.message || 'Discovery failed')
    }
    setDiscoverLoading(false)
  }

  const handleAddToCandidate = async (candidate, key) => {
    setSaveProgress(p => ({ ...p, [key]: true }))
    try {
      const { error } = await createCandidate({
        name: candidate.name,
        // The model returns whatever the sources said — 'Democratic', 'GOP',
        // 'Rep.'. candidates.party has a CHECK constraint, so raw text 400s the
        // insert and the Add button just flashes red. Same normalizer as the
        // two CSV paths.
        party: normalizePartyForDb(candidate.party),
        status: candidate.status || 'exploring',
        notes: notesToV2(candidate.notes, user?.email || 'You'),
      })
      if (!error) {
        setSaveProgress(p => ({ ...p, [key]: 'success' }))
        await fetchData()
        setTimeout(() => setSaveProgress(p => ({ ...p, [key]: null })), 2000)
      } else {
        setSaveProgress(p => ({ ...p, [key]: 'error' }))
        setTimeout(() => setSaveProgress(p => ({ ...p, [key]: null })), 2000)
      }
    } catch {
      setSaveProgress(p => ({ ...p, [key]: 'error' }))
      setTimeout(() => setSaveProgress(p => ({ ...p, [key]: null })), 2000)
    }
  }

  const [monitoringToggles, setMonitoringToggles] = useState({}) // candidateId → true while saving
  const [monitorError, setMonitorError] = useState('')           // why the last toggle failed

  const f = (key) => (e) => setForm(prev => ({ ...prev, [key]: e.target.value }))
  const userTier    = getUserTier(user)
  const canDiscover = hasFeature(userTier, 'discoverCandidates')
  // Active Monitoring is sold as SLOTS, so the gate is "does your plan include
  // one" — not features.weeklyProfile, which is the separate weekly auto-refresh
  // perk and is false on c_active and on every Action plan. Gating on it hid the
  // switch from Active (1 slot) and from every bracket-priced Action plan, i.e.
  // from everyone who had actually paid for monitoring. Same helper as maxSlots
  // below, so the gate and the counter can't drift.
  const canMonitor  = canMonitorCandidates(user)
  // CSV bulk import is sold from Monitor up (pricing page "CSV bulk import" row,
  // tiers.js features.csvImport) — enforce it here, the only place it ships.
  const canCsvImport = hasFeature(userTier, 'csvImport')

  // Plan names for the locked-feature badges/blurbs, derived from PLAN_CONFIG.
  // These read "Pro" and "Campaign & Agency plans" before — neither has ever
  // been a real plan name in this app.
  const discoverPlanName = featureUnlockLabel('discoverCandidates', getUserPlanType(user))
  const csvPlanName      = featureUnlockLabel('csvImport', getUserPlanType(user))
  const monitorPlanNames = monitoringUnlockLabel(getUserPlanType(user))

  // Scout plan cap (use totalCandidateCount — not the filtered view). The number
  // itself lives in lib/tiers.js so this page, PlanPane and the copy in both
  // can never disagree.
  //
  // NOTE: server enforcement is pending. Candidates are inserted straight from
  // the client and the RLS policy only checks ownership, so this gate — and the
  // two DB-count checks in handleSave / the CSV import below — are UI, not a
  // security boundary. Closing it needs an RLS/trigger migration (out of scope).
  const atScoutCandidateLimit = userTier === 'scout' && totalCandidateCount >= SCOUT_CANDIDATE_LIMIT

  // Active monitoring slot accounting — getMonitoringSlotMax() in lib/tiers.js
  // is the one ladder (admin → Infinity, candidate → activeCandidateLimit,
  // action → bracket max) shared with CandidateDetail, Settings, the dashboards
  // and the canMonitor gate above.
  const userPlanType  = getUserPlanType(user)
  const maxSlots      = getMonitoringSlotMax(user)
  // Server count, not `candidates.filter(...)` — the rendered array is filtered
  // and paginated, so counting it would let filters manufacture free slots.
  // The slot counter in the header reads this same value.
  const activeCount   = activeMonitoringCount
  const slotsLeft     = maxSlots === Infinity ? Infinity : Math.max(0, maxSlots - activeCount)
  const atLimit       = maxSlots !== Infinity && activeCount >= maxSlots
  const slotPct       = maxSlots === Infinity ? 0 : Math.min(100, Math.round((activeCount / maxSlots) * 100))

  const handleToggleMonitoring = async (candidate) => {
    if (!canMonitor) return
    const isActive = candidate.section_timestamps?.monitoring === true
    if (!isActive && atLimit) return  // slot limit reached — block new activations

    setMonitorError('')
    setMonitoringToggles(prev => ({ ...prev, [candidate.id]: true }))

    const newVal = !isActive
    const newTimestamps = {
      ...(candidate.section_timestamps || {}),
      monitoring: newVal,
      monitoring_updated_at: new Date().toISOString(),
      monitoring_updated_by: user?.email || 'You',
    }

    // Optimistic local update — UI responds instantly
    setCandidates(prev => prev.map(c =>
      c.id === candidate.id ? { ...c, section_timestamps: newTimestamps } : c
    ))
    setActiveMonitoringCount(prev => Math.max(0, prev + (newVal ? 1 : -1)))

    const { data: updated, error } = await updateCandidate(candidate.id, { section_timestamps: newTimestamps })

    if (error) {
      // Revert optimistic update so UI doesn't lie about state
      setCandidates(prev => prev.map(c =>
        c.id === candidate.id ? { ...c, section_timestamps: candidate.section_timestamps } : c
      ))
      setActiveMonitoringCount(prev => Math.max(0, prev + (newVal ? -1 : 1)))
      // A switch that flips back with no explanation reads as a broken toggle.
      // The `monitoring_cap` trigger is the usual cause (another tab filled the
      // last slot after this page's count was read) and it writes its own
      // sentence; anything else shows its real message.
      setMonitorError(monitoringToggleError(error))
      refreshActiveCount()
    } else if (updated) {
      // Reconcile with actual server response
      setCandidates(prev => prev.map(c =>
        c.id === candidate.id ? { ...c, ...updated } : c
      ))
      // Re-read the authoritative count (another tab/device may have changed it)
      refreshActiveCount()
    }

    setMonitoringToggles(prev => {
      const next = { ...prev }
      delete next[candidate.id]
      return next
    })
  }

  return (
    <div className="space-y-6">
      <LoadingBar loading={loading} />

      {/* Scout plan candidate limit banner */}
      {atScoutCandidateLimit && (
        <div className="flex items-center gap-3 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
          <Lock className="w-4 h-4 text-amber-600 flex-shrink-0" />
          <p className="text-sm text-amber-800 flex-1">
            <span className="font-semibold">Free plan limit reached.</span> The Scout plan supports up to {SCOUT_CANDIDATE_LIMIT} candidates.{' '}
            <WebOnlyCta native={NATIVE_PLAN_NOTE}>
              <Link to="/plans" className="underline font-semibold">Upgrade your plan</Link> to track more.
            </WebOnlyCta>
          </p>
        </div>
      )}

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-4">
        <p className="text-sm text-gray-500"><span className="font-semibold text-gray-700">{candidates.length}</span> tracked</p>
        <div className="sm:ml-auto flex items-center gap-2">
          <div className="flex items-center gap-1 bg-gray-100 rounded-lg p-1">
            <button
              onClick={() => switchView('table')}
              className={`p-1.5 rounded transition-colors ${viewMode === 'table' ? 'bg-white text-brand-red shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
              title="Table view"
            >
              <LayoutList className="w-4 h-4" />
            </button>
            <button
              onClick={() => switchView('map')}
              className={`p-1.5 rounded transition-colors ${viewMode === 'map' ? 'bg-white text-brand-red shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
              title="Map view"
            >
              <Map className="w-4 h-4" />
            </button>
          </div>
          {canDiscover ? (
            <button
              onClick={() => setShowDiscover(true)}
              className="btn-secondary flex items-center gap-2 text-sm"
              title="AI-powered candidate discovery"
            >
              <Telescope className="w-4 h-4" /> Discover
            </button>
          ) : (
            <span className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm text-gray-400 bg-gray-100 cursor-not-allowed"
              title={`AI candidate discovery unlocks on ${discoverPlanName}`}>
              <Lock className="w-3.5 h-3.5" /> Discover
              <span className="text-xs font-bold bg-gray-300 text-gray-600 px-1.5 py-0.5 rounded-full">{discoverPlanName}</span>
            </span>
          )}
          {canCsvImport ? (
            <button onClick={() => { setCsvRows([]); setCsvHeaders([]); setCsvResult(null); setCsvError(''); setShowCsvModal(true) }}
              className="btn-secondary flex items-center gap-2">
              <Upload className="w-4 h-4" /> Upload CSV
            </button>
          ) : (
            <div className="relative group">
              <span className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm text-gray-400 bg-gray-100 cursor-not-allowed">
                <Lock className="w-3.5 h-3.5" /> Upload CSV
                <span className="text-xs font-bold bg-gray-300 text-gray-600 px-1.5 py-0.5 rounded-full">{csvPlanName}</span>
              </span>
              <div className="absolute bottom-full right-0 mb-2 w-56 bg-gray-900 text-white text-xs rounded-lg px-3 py-2 shadow-xl hidden group-hover:block z-20 leading-relaxed">
                CSV bulk import unlocks on {csvPlanName} and above.{' '}
                <WebOnlyCta native={NATIVE_PLAN_NOTE}>
                  <Link to="/plans" className="underline font-semibold text-yellow-300">Upgrade</Link> to import candidates in bulk.
                </WebOnlyCta>
              </div>
            </div>
          )}
          {atScoutCandidateLimit ? (
            <div className="relative group">
              <button
                disabled
                className="btn-primary flex items-center gap-2 opacity-50 cursor-not-allowed"
                title={`Scout plan is limited to ${SCOUT_CANDIDATE_LIMIT} candidates`}
              >
                <Lock className="w-4 h-4" /> Add Candidate
              </button>
              <div className="absolute bottom-full right-0 mb-2 w-56 bg-gray-900 text-white text-xs rounded-lg px-3 py-2 shadow-xl hidden group-hover:block z-20 leading-relaxed">
                The free Scout plan allows up to {SCOUT_CANDIDATE_LIMIT} candidates.{' '}
                <WebOnlyCta native={NATIVE_PLAN_NOTE}>
                  <Link to="/plans" className="underline font-semibold text-yellow-300">Upgrade</Link> to add more.
                </WebOnlyCta>
              </div>
            </div>
          ) : (
            <button onClick={() => { setShowModal(true); setTab('basic') }} className="btn-primary flex items-center gap-2">
              <Plus className="w-4 h-4" /> Add Candidate
            </button>
          )}
        </div>
      </div>

      {/* ── Monitoring toggle failure ──────────────────────────────────── */}
      {monitorError && (
        <div className="flex items-start gap-3 px-4 py-3 rounded-xl border border-red-200 bg-red-50">
          <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-red-700 flex-1">{monitorError}</p>
          <button
            onClick={() => setMonitorError('')}
            className="text-red-400 hover:text-red-600 font-bold text-xs flex-shrink-0"
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      )}

      {/* ── Active Monitoring Slot Counter ─────────────────────────────── */}
      {canMonitor ? (
        <div className={`flex items-center gap-4 px-4 py-3 rounded-xl border ${
          atLimit ? 'bg-amber-50 border-amber-200' : 'bg-emerald-50 border-emerald-200'
        }`}>
          <div className="flex items-center gap-2 flex-shrink-0">
            <Zap className={`w-4 h-4 ${atLimit ? 'text-amber-500' : 'text-emerald-500'}`} />
            <span className={`text-sm font-bold ${atLimit ? 'text-amber-800' : 'text-emerald-800'}`}>
              Active Monitoring
            </span>
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between mb-1">
              <span className={`text-xs font-semibold ${atLimit ? 'text-amber-700' : 'text-emerald-700'}`}>
                {maxSlots === Infinity
                  ? `${activeCount} candidate${activeCount !== 1 ? 's' : ''} active — unlimited slots`
                  : atLimit
                    ? userPlanType === 'action'
                      ? `All ${maxSlots} slots used — upgrade your bracket to monitor more candidates`
                      : `All ${maxSlots} slot${maxSlots !== 1 ? 's' : ''} used — deactivate one to add another`
                    : `${activeCount} of ${maxSlots} slot${maxSlots !== 1 ? 's' : ''} used — ${slotsLeft} remaining`}
              </span>
              {maxSlots !== Infinity && (
                <span className="text-xs text-gray-400 ml-3 whitespace-nowrap">{activeCount}/{maxSlots}</span>
              )}
              {atLimit && userPlanType === 'action' && (
                <WebOnlyCta>
                  <button
                    onClick={() => navigate('/plans')}
                    className="ml-3 flex-shrink-0 text-xs font-bold px-2.5 py-1 rounded-lg bg-brand-red text-white hover:bg-red-700 transition-all whitespace-nowrap"
                  >
                    Upgrade bracket
                  </button>
                </WebOnlyCta>
              )}
            </div>
            {maxSlots !== Infinity && (
              <div className="h-1.5 bg-white/70 rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-500"
                  style={{
                    width: `${slotPct}%`,
                    backgroundColor: atLimit ? '#f59e0b' : slotPct >= 80 ? '#f97316' : '#10b981',
                  }}
                />
              </div>
            )}
          </div>
          {activeCount > 0 && (
            <button
              onClick={() => setStatusFilter(statusFilter === '__monitored__' ? '' : '__monitored__')}
              className={`flex-shrink-0 text-xs font-semibold px-2.5 py-1 rounded-lg border transition-all ${
                statusFilter === '__monitored__'
                  ? 'bg-emerald-600 text-white border-emerald-600'
                  : 'bg-white text-emerald-700 border-emerald-300 hover:bg-emerald-50'
              }`}
            >
              {statusFilter === '__monitored__' ? 'Show all' : 'Show active only'}
            </button>
          )}
        </div>
      ) : (
        <div className="flex items-center gap-3 px-4 py-3 rounded-xl border border-dashed border-gray-200 bg-gray-50">
          <Zap className="w-4 h-4 text-gray-300 flex-shrink-0" />
          <p className="text-xs text-gray-500 flex-1">
            <span className="font-semibold text-gray-600">Active Monitoring</span> — track a candidate week to week and get a weekly digest of news, endorsements and controversy. Your plan includes no monitoring slots; they start on {monitorPlanNames}.
          </p>
          <WebOnlyCta
            native={<span className="text-xs text-gray-400 flex-shrink-0 max-w-[16rem]">{NATIVE_PLAN_NOTE}</span>}
          >
            <Link to="/plans" className="text-xs font-semibold text-brand-red hover:underline flex-shrink-0">Upgrade →</Link>
          </WebOnlyCta>
        </div>
      )}

      {/* Filters */}
      <div className="card py-4">
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input className="input pl-9" placeholder="Search candidates..." value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <SearchableSelect className="sm:w-40" value={partyFilter} onChange={setPartyFilter}
            options={[{ value: '', label: 'All Parties' }, ...PARTIES.map(p => ({ value: p, label: p }))]}
            placeholder="All Parties" />
          <SearchableSelect className="sm:w-44" value={statusFilter} onChange={setStatusFilter}
            options={[
              { value: '', label: 'All Candidates' },
              { value: '__monitored__', label: 'Monitoring on' },
              { value: '__unmonitored__', label: 'Monitoring off' },
            ]}
            placeholder="All Candidates" />
        </div>
        {/* Office filter badge — shown when navigated from district panel */}
        {officeFilter && (
          <div className="flex items-center gap-2 mt-3 pt-3 border-t border-gray-100">
            <span className="text-xs text-gray-500">Filtered by office:</span>
            <span className="flex items-center gap-1 text-xs bg-blue-50 text-blue-700 border border-blue-200 px-2 py-0.5 rounded-full font-medium">
              {offices.find(o => o.id === officeFilter)?.name || 'Selected Office'}
              <button onClick={() => setOfficeFilter('')} className="ml-1 hover:text-blue-900" title="Clear filter">
                <X className="w-3 h-3" />
              </button>
            </span>
          </div>
        )}
      </div>

      {/* Candidate List / Map */}
      {loading ? (
        <div className="flex justify-center py-20">
          <div className="w-8 h-8 border-4 border-brand-red border-t-transparent rounded-full animate-spin" />
        </div>
      ) : candidates.length === 0 ? (
        <div className="text-center py-20">
          <Users className="w-16 h-16 text-gray-200 mx-auto mb-4" />
          <p className="text-gray-500 font-semibold text-lg">No candidates yet</p>
          <p className="text-gray-400 text-sm mt-1">Add candidates to start building your prospecting database</p>
          <button onClick={() => setShowModal(true)} className="btn-primary mt-6">Add First Candidate</button>
        </div>
      ) : (
        <>
          {/* District layer toggles */}
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
              {activeLayer && <span className="text-xs text-gray-400 ml-1">— click a district to see its candidates</span>}
            </div>
          )}

          {/* Map view with district side panel */}
          {mapEverShown && (
            <div style={{ display: viewMode === 'map' ? 'block' : 'none', position: 'relative' }}
                 className="rounded-xl overflow-hidden h-[420px] sm:h-[520px] md:h-[600px]">
              <MapErrorBoundary>
                <LeafletMapView
                  candidates={candidates}
                  activeLayer={activeLayer}
                  onDistrictClick={handleDistrictClick}
                  initialView={mapView}
                  onViewChange={setMapView}
                  onLearnMore={(county, name) => navigate(placePath(county, name))}
                />
              </MapErrorBoundary>

              {/* Candidate district panel — municipal clicks with a Census demographics
                  entry get the richer CityDemographicsPanel instead; everything else
                  (county/state/federal, or a municipality with no data) keeps this
                  original inline panel exactly as before. */}
              {selectedDistrict && selectedDistrict.layerKey === 'municipal' && (cityPlace || placeLoading) ? (
                <CityDemographicsPanel
                  place={cityPlace}
                  loading={placeLoading}
                  panelOffices={Object.values(panelByOffice).map(g => g.office).filter(Boolean)}
                  allCandidates={candidates}
                  onClose={() => setSelectedDistrict(null)}
                />
              ) : selectedDistrict && (
                <div style={{
                  position:'absolute', left:0, top:0, bottom:0,
                  width: 'min(300px, 85vw)', zIndex:2000,
                  background:'white', boxShadow:'4px 0 24px rgba(0,0,0,0.18)',
                  display:'flex', flexDirection:'column', borderRadius:'12px 0 0 12px',
                }}>
                  {/* Header */}
                  {(() => {
                    const themes = { federal:{bg:'#dbeafe',color:'#1e40af'}, state:{bg:'#fee2e2',color:'#991b1b'}, county:{bg:'#ede9fe',color:'#5b21b6'}, municipal:{bg:'#dcfce7',color:'#14532d'} }
                    const t = themes[selectedDistrict.layerKey] || themes.county
                    return (
                      <div style={{ background:t.bg, padding:'14px 16px', borderBottom:'1px solid rgba(0,0,0,0.07)', borderRadius:'12px 0 0 0', display:'flex', alignItems:'flex-start', gap:10 }}>
                        <div style={{ flex:1 }}>
                          <div style={{ fontSize:10, fontWeight:700, textTransform:'uppercase', letterSpacing:1, color:t.color, marginBottom:3 }}>{selectedDistrict.sublabel}</div>
                          <div style={{ fontSize:15, fontWeight:800, color:'#111' }}>{selectedDistrict.name}</div>
                        </div>
                        <button onClick={() => setSelectedDistrict(null)} style={{ color:t.color, opacity:0.6, background:'none', border:'none', cursor:'pointer', padding:2, marginTop:1 }}><X size={16} /></button>
                      </div>
                    )
                  })()}

                  {/* Body */}
                  <div style={{ flex:1, overflowY:'auto', padding:'12px 0' }}>
                    {Object.keys(panelByOffice).length === 0 ? (
                      <div style={{ padding:'32px 20px', textAlign:'center' }}>
                        <Users size={32} style={{ margin:'0 auto 10px', color:'#d1d5db' }} />
                        <div style={{ fontSize:13, color:'#6b7280', fontWeight:600 }}>No candidates tracked</div>
                        <div style={{ fontSize:12, color:'#9ca3af', marginTop:4 }}>No candidates have been added for this district yet.</div>
                      </div>
                    ) : Object.values(panelByOffice).map(({ office, candidates: cands }) => (
                      <div key={office?.id || 'unknown'} style={{ margin:'0 10px 10px', borderRadius:10, border:'1px solid #e5e7eb', overflow:'hidden' }}>
                        <div style={{ padding:'10px 12px', background:'#f9fafb', borderBottom:'1px solid #e5e7eb' }}>
                          <div style={{ fontSize:13, fontWeight:700, color:'#111' }}>{office?.name || 'Unknown Office'}</div>
                          {office?.office_type && <div style={{ fontSize:11, color:'#6b7280', marginTop:1 }}>{office.office_type}</div>}
                        </div>
                        <div style={{ padding:'6px 0' }}>
                          {cands.map((c, idx) => {
                            const partyColors = { R:'#dc2626', D:'#2563eb', I:'#7c3aed', L:'#f97316', G:'#16a34a', N:'#6b7280' }
                            const statusCls = { elected:'bg-green-100 text-green-700', declared:'bg-blue-100 text-blue-700', primary_winner:'bg-purple-100 text-purple-700', general:'bg-amber-100 text-amber-700', exploring:'bg-gray-100 text-gray-500', lost:'bg-red-100 text-red-500', withdrawn:'bg-gray-100 text-gray-400' }
                            return (
                              <div key={c.id} style={{ padding:'6px 12px', display:'flex', alignItems:'center', gap:8, background: idx%2===0 ? 'white' : '#fafafa' }}>
                                <div style={{ width:8, height:8, borderRadius:'50%', flexShrink:0, background: partyColors[partyGroup(c.party)] || '#6b7280' }} />
                                <div style={{ flex:1, minWidth:0 }}>
                                  <div style={{ fontSize:13, fontWeight:600, color:'#111', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{c.name}</div>
                                  {c.party && <div style={{ fontSize:11, color:'#6b7280' }}>{c.party}</div>}
                                </div>
                                {c.section_timestamps?.monitoring === true && (
                                  <span className="text-xs px-1.5 py-0.5 rounded-full font-semibold flex-shrink-0 bg-emerald-100 text-emerald-700" style={{ fontSize:10 }}>
                                    Monitoring
                                  </span>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Table view */}
          <div style={{ display: viewMode === 'table' ? 'block' : 'none' }}
               className="space-y-6">
          {levelOrder.map(level => {
            const group = grouped[level]
            if (!group || group.length === 0) return null
            return (
              <div key={level}>
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-sm font-bold text-gray-700">{levelLabels[level]}</span>
                  <span className="text-xs bg-gray-200 text-gray-600 px-2 py-0.5 rounded-full">{group.length}</span>
                  <div className="flex-1 h-px bg-gray-200" />
                </div>
                <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                  <table className="w-full">
                    <thead className="bg-gray-50 border-b border-gray-200">
                      <tr>
                        <th className="table-header">Candidate</th>
                        <th className="table-header hidden md:table-cell">Office / District</th>
                        <th className="table-header hidden lg:table-cell">Election</th>
                        <th className="table-header">Monitoring</th>
                        <th className="table-header hidden sm:table-cell">Contact</th>
                        <th className="table-header">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {group.map((c, i) => (
                        <tr key={c.id} className={`table-row ${i % 2 === 0 ? '' : 'bg-gray-50/50'}`}>
                          <td className="table-cell">
                            <div className="flex items-center gap-3">
                              <div className="w-8 h-8 rounded-full bg-brand-red/10 text-brand-red flex items-center justify-center text-sm font-bold flex-shrink-0">
                                {(c.name || '?')[0]}
                              </div>
                              <div>
                                <Link to={`/candidates/${c.id}`} className="font-semibold text-gray-900 hover:text-brand-red transition-colors">
                                  {c.name}
                                </Link>
                                {c.party && (
                                  <div className="mt-0.5">
                                    <span className={partyColor(c.party)}>{c.party}</span>
                                  </div>
                                )}
                              </div>
                            </div>
                          </td>
                          <td className="table-cell hidden md:table-cell">
                            {c.office ? (
                              <div>
                                <p className="text-sm font-medium text-gray-800">{c.office.name}</p>
                                <p className="text-xs text-gray-400">{c.office.district_name || c.office.district_number && `District ${c.office.district_number}` || 'Statewide'}</p>
                              </div>
                            ) : <span className="text-gray-300">—</span>}
                          </td>
                          <td className="table-cell hidden lg:table-cell text-gray-500 text-xs">
                            {c.election?.name || <span className="text-gray-300">—</span>}
                          </td>
                          <td className="table-cell">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              {c.section_timestamps?.monitoring === true ? (
                                <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 font-semibold" title="Active monitoring — weekly profile refresh enabled">
                                  <Zap className="w-2.5 h-2.5" />
                                  Monitoring
                                </span>
                              ) : (
                                <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-500 font-medium" title="Active monitoring is off for this candidate">
                                  Not monitored
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="table-cell hidden sm:table-cell">
                            <div className="flex items-center gap-2">
                              {c.email && (
                                <a href={`mailto:${c.email}`} className="text-gray-400 hover:text-brand-red transition-colors" title={c.email}>
                                  <Mail className="w-4 h-4" />
                                </a>
                              )}
                              {c.phone && (
                                <a href={`tel:${c.phone}`} className="text-gray-400 hover:text-brand-red transition-colors" title={c.phone}>
                                  <Phone className="w-4 h-4" />
                                </a>
                              )}
                              {c.website && (
                                <a href={c.website} target="_blank" rel="noopener noreferrer" className="text-gray-400 hover:text-brand-red transition-colors">
                                  <Globe className="w-4 h-4" />
                                </a>
                              )}
                              {!c.email && !c.phone && !c.website && <span className="text-gray-300 text-xs">No contact</span>}
                            </div>
                          </td>
                          <td className="table-cell">
                            <div className="flex items-center gap-1">
                              {canMonitor && (() => {
                                const isActive = c.section_timestamps?.monitoring === true
                                const isSaving = !!monitoringToggles[c.id]
                                const blocked  = !isActive && atLimit
                                return (
                                  <button
                                    onClick={() => handleToggleMonitoring(c)}
                                    disabled={isSaving || blocked}
                                    title={
                                      blocked ? `Slot limit reached (${maxSlots}/${maxSlots}) — deactivate another candidate first`
                                      : isActive ? 'Deactivate monitoring'
                                      : 'Activate monitoring'
                                    }
                                    className={`p-1.5 rounded-lg transition-all ${
                                      isSaving ? 'opacity-40 cursor-wait' :
                                      blocked   ? 'opacity-30 cursor-not-allowed' :
                                      isActive  ? 'text-emerald-600 bg-emerald-50 hover:bg-emerald-100' :
                                                  'text-gray-300 hover:text-emerald-500 hover:bg-emerald-50'
                                    }`}
                                  >
                                    <Zap className={`w-4 h-4 ${isSaving ? 'animate-pulse' : ''}`} />
                                  </button>
                                )
                              })()}
                              {/* Primary click (the name) opens the candidate RECORD.
                                  This is the separate, explicit affordance for the
                                  AI-generated profile — never the row's default. */}
                              <Link
                                to={`/dossiers?candidate=${c.id}`}
                                className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-700 transition-colors"
                                title={`Open ${c.name}'s AI-generated profile`}
                              >
                                <FileText className="w-4 h-4" />
                              </Link>
                              <Link to={`/candidates/${c.id}`} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-700 transition-colors" title="Open candidate record">
                                <ExternalLink className="w-4 h-4" />
                              </Link>
                              <button onClick={() => handleDelete(c.id, c.name)} className="p-1.5 rounded-lg hover:bg-red-50 text-gray-400 hover:text-brand-red transition-colors">
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )
          })}
          </div>
        </>
      )}

      {/* Discover Candidates Modal */}
      {showDiscover && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/50" onClick={() => setShowDiscover(false)} />
          <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[92vh] flex flex-col">
            <div className="flex items-center justify-between p-6 border-b border-gray-100 flex-shrink-0">
              <div>
                <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2">
                  <Telescope className="w-5 h-5 text-brand-red" /> Discover Candidates
                </h2>
                <p className="text-sm text-gray-500 mt-0.5">AI-powered candidate discovery across Wisconsin</p>
              </div>
              <button onClick={() => setShowDiscover(false)}><X className="w-5 h-5 text-gray-400" /></button>
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-4">
              {/* Discovery Mode Selection */}
              <div>
                <label className="label">Discovery Mode</label>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  {['county', 'level', 'office'].map(m => (
                    <button
                      key={m}
                      onClick={() => setDiscoverMode(m)}
                      className={`py-2 px-3 rounded-lg text-sm font-medium transition-colors ${
                        discoverMode === m
                          ? 'bg-brand-red text-white'
                          : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                      }`}
                    >
                      {m === 'county' ? 'By County' : m === 'level' ? 'By Level' : 'By Office'}
                    </button>
                  ))}
                </div>
              </div>

              {/* County Mode */}
              {discoverMode === 'county' && (
                <>
                  <div>
                    <label className="label">County *</label>
                    <SearchableSelect
                      value={discoverCounty}
                      onChange={setDiscoverCounty}
                      options={WI_COUNTIES.map(c => ({ value: c, label: `${c} County` }))}
                      placeholder="Select a county..."
                      searchPlaceholder="Search counties..."
                    />
                  </div>
                  <div>
                    <label className="label">Election Year (Optional)</label>
                    <input
                      className="input"
                      type="number"
                      value={discoverYear}
                      onChange={e => setDiscoverYear(e.target.value)}
                      min={2024}
                      max={2035}
                    />
                  </div>
                </>
              )}

              {/* Level Mode */}
              {discoverMode === 'level' && (
                <div>
                  <label className="label">Government Level *</label>
                  <select
                    className="input"
                    value={discoverLevel}
                    onChange={e => setDiscoverLevel(e.target.value)}
                  >
                    <option value="federal">Federal</option>
                    <option value="state">State</option>
                    <option value="county">County</option>
                    <option value="municipal">Municipal</option>
                  </select>
                </div>
              )}

              {/* Office Mode */}
              {discoverMode === 'office' && (
                <>
                  <div>
                    <label className="label">Office Name *</label>
                    <input
                      className="input"
                      value={discoverOffice}
                      onChange={e => setDiscoverOffice(e.target.value)}
                      placeholder="e.g. State Representative, County Sheriff"
                    />
                  </div>
                  <div>
                    <label className="label">Election Year (Optional)</label>
                    <input
                      className="input"
                      type="number"
                      value={discoverYear}
                      onChange={e => setDiscoverYear(e.target.value)}
                      min={2024}
                      max={2035}
                    />
                  </div>
                </>
              )}

              {discoverError && (
                <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">
                  <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  {discoverError}
                </div>
              )}

              {/* Results */}
              {discoverResults.length > 0 && (
                <div>
                  <h3 className="text-sm font-bold text-gray-900 mb-3">Discovered Candidates ({discoverResults.length})</h3>
                  <div className="space-y-2 max-h-96 overflow-y-auto">
                    {discoverResults.map((cand, i) => (
                      <div key={i} className="p-3 border border-gray-200 rounded-lg hover:border-brand-red/30 hover:bg-brand-red/5 transition-all">
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-semibold text-gray-900">{cand.name}</span>
                              {cand.party && (
                                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${partyBadgeClasses(cand.party)}`}>{cand.party}</span>
                              )}
                            </div>
                            {cand.office && <p className="text-xs text-gray-600 mt-1">{cand.office}{cand.district ? ` · ${cand.district}` : ''}</p>}
                            {cand.status && <p className="text-xs text-gray-500 mt-0.5">Status: {cand.status}</p>}
                            {cand.confidence && (
                              <p className={`text-xs font-medium mt-1 ${
                                cand.confidence === 'HIGH' ? 'text-green-600' :
                                cand.confidence === 'MEDIUM' ? 'text-yellow-600' :
                                'text-red-600'
                              }`}>
                                Confidence: {cand.confidence}
                              </p>
                            )}
                            {cand.notes && <p className="text-xs text-gray-400 mt-1 italic">{cand.notes}</p>}
                          </div>
                          <button
                            onClick={() => handleAddToCandidate(cand, `result_${i}`)}
                            disabled={saveProgress[`result_${i}`] === 'success'}
                            className={`flex-shrink-0 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                              saveProgress[`result_${i}`] === true ? 'bg-gray-200 text-gray-500 cursor-not-allowed' :
                              saveProgress[`result_${i}`] === 'success' ? 'bg-green-100 text-green-700' :
                              saveProgress[`result_${i}`] === 'error' ? 'bg-red-100 text-red-700' :
                              'bg-brand-red/10 text-brand-red hover:bg-brand-red/20'
                            }`}
                          >
                            {saveProgress[`result_${i}`] === true ? 'Saving...' :
                             saveProgress[`result_${i}`] === 'success' ? '✓ Saved' :
                             saveProgress[`result_${i}`] === 'error' ? 'Error' :
                             'Add'}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {discoverLoading && (
                <div className="flex justify-center py-8">
                  <div className="w-8 h-8 border-4 border-brand-red border-t-transparent rounded-full animate-spin" />
                </div>
              )}
            </div>

            <div className="flex gap-3 p-6 pt-0 border-t border-gray-100">
              <button
                type="button"
                onClick={() => setShowDiscover(false)}
                className="btn-secondary flex-1"
              >
                Close
              </button>
              <button
                onClick={handleDiscoverSearch}
                disabled={discoverLoading || (discoverMode === 'county' && !discoverCounty) || (discoverMode === 'office' && !discoverOffice)}
                className="btn-primary flex-1"
              >
                {discoverLoading ? 'Searching...' : 'Search'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add Candidate Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/50" onClick={() => setShowModal(false)} />
          <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[92vh] flex flex-col">
            <div className="flex items-center justify-between p-6 border-b border-gray-100 flex-shrink-0">
              <div>
                <h2 className="text-lg font-bold text-gray-900">Add Candidate</h2>
                <p className="text-sm text-gray-500 mt-0.5">Enter name, party, and office, then use AI Autofill</p>
              </div>
              <button onClick={() => { setShowModal(false); setAutofillNote('') }}><X className="w-5 h-5 text-gray-400" /></button>
            </div>

            {/* Tabs */}
            <div className="flex border-b border-gray-100 px-6 flex-shrink-0">
              {[['basic','Basic Info'],['contact','Contact'],['campaign','Campaign'],['social','Social / Bio']].map(([id, label]) => (
                <button key={id} onClick={() => setTab(id)}
                  className={`py-3 px-4 text-sm font-medium border-b-2 transition-colors ${tab === id ? 'border-brand-red text-brand-red' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
                  {label}
                </button>
              ))}
            </div>

            <form onSubmit={handleSave} className="flex-1 overflow-y-auto">
              <div className="p-6 space-y-4">
                {tab === 'basic' && (
                  <>
                    <div>
                      <label className="label">Full Name *</label>
                      <input className="input" value={form.name} onChange={f('name')} placeholder="Jane Smith" required />
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <label className="label">Party</label>
                        <SearchableSelect value={form.party} onChange={v => f('party')({ target: { value: v } })}
                          options={PARTIES.map(p => ({ value: p, label: p }))}
                          placeholder="Select party..." />
                      </div>
                      <div>
                        <label className="label">Status</label>
                        <select className="input" value={form.status} onChange={f('status')}>
                          {STATUSES.map(s => <option key={s} value={s}>{statusLabel(s)}</option>)}
                        </select>
                      </div>
                    </div>
                    <div>
                      <label className="label">Running For (Office)</label>
                      <SearchableSelect value={form.office_id} onChange={v => f('office_id')({ target: { value: v } })}
                        options={offices.map(o => ({
                          value: o.id,
                          label: `${o.name}${o.district_number ? ` — District ${o.district_number}` : ''}${o.district_name ? ` (${o.district_name})` : ''}${o.county ? ` · ${o.county}` : ''}`,
                        }))}
                        placeholder="Select office..."
                        searchPlaceholder="Search offices..." />
                    </div>
                    <div>
                      <label className="label">Election</label>
                      <SearchableSelect value={form.election_id} onChange={v => f('election_id')({ target: { value: v } })}
                        options={elections.map(e => ({ value: e.id, label: e.name }))}
                        placeholder="Select election..."
                        searchPlaceholder="Search elections..." />
                    </div>
                    {/* AI Autofill */}
                    <div className="pt-1">
                      {hasFeature(userTier, 'campaignIntel') ? (
                        <>
                          <button
                            type="button"
                            onClick={handleAutofill}
                            disabled={!form.name || autofilling}
                            className={`w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl text-sm font-semibold transition-all border-2 ${
                              !form.name
                                ? 'border-gray-200 text-gray-300 cursor-not-allowed bg-gray-50'
                                : 'border-brand-red/40 text-brand-red bg-brand-red/5 hover:bg-brand-red/10'
                            }`}
                          >
                            {autofilling ? (
                              <><span className="w-4 h-4 border-2 border-brand-red/30 border-t-brand-red rounded-full animate-spin" /> Searching for candidate info...</>
                            ) : (
                              <><Wand2 className="w-4 h-4" /> AI Autofill — Fill remaining fields automatically</>
                            )}
                          </button>
                          {autofillNote && (
                            <div className="flex items-start gap-2 mt-2 p-2.5 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800">
                              <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5 text-amber-500" />
                              <span>{autofillNote}</span>
                            </div>
                          )}
                        </>
                      ) : (
                        <div className="w-full flex items-center gap-3 py-2.5 px-4 rounded-xl text-sm border-2 border-gray-200 bg-gray-50 text-gray-400 cursor-not-allowed">
                          <Wand2 className="w-4 h-4 flex-shrink-0 text-gray-300" />
                          <span>AI Autofill — <span className="text-brand-red/60 font-semibold">Active plan or higher required.</span> <a href="/settings" className="underline text-brand-red/60 hover:text-brand-red" onClick={(e) => { e.stopPropagation(); }}>Upgrade your plan</a> to use this feature.</span>
                        </div>
                      )}
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <label className="label">Occupation</label>
                        <input className="input" value={form.occupation} onChange={f('occupation')} placeholder="Attorney" />
                      </div>
                      <div>
                        <label className="label">Employer</label>
                        <input className="input" value={form.employer} onChange={f('employer')} placeholder="Smith Law Group" />
                      </div>
                    </div>
                  </>
                )}

                {tab === 'contact' && (
                  <>
                    <div>
                      <label className="label">Email</label>
                      <input className="input" type="email" value={form.email} onChange={f('email')} placeholder="jane@janeforwisconsin.com" />
                    </div>
                    <div>
                      <label className="label">Phone</label>
                      <input className="input" type="tel" value={form.phone} onChange={f('phone')} placeholder="(608) 555-0100" />
                    </div>
                    <div>
                      <label className="label">Campaign Website</label>
                      <input className="input" type="url" value={form.website} onChange={f('website')} placeholder="https://janeforwisconsin.com" />
                    </div>
                    <div>
                      <label className="label">Campaign Address</label>
                      <input className="input" value={form.campaign_address} onChange={f('campaign_address')} placeholder="123 Main St" />
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <label className="label">City</label>
                        <input className="input" value={form.campaign_city} onChange={f('campaign_city')} placeholder="Madison" />
                      </div>
                      <div>
                        <label className="label">ZIP Code</label>
                        <input className="input" value={form.campaign_zip} onChange={f('campaign_zip')} placeholder="53703" />
                      </div>
                    </div>
                  </>
                )}

                {tab === 'campaign' && (
                  <>
                    <div>
                      <label className="label">Campaign Committee Name</label>
                      <input className="input" value={form.campaign_committee} onChange={f('campaign_committee')} placeholder="Friends of Jane Smith" />
                    </div>
                    <div>
                      <label className="label">Campaign Manager</label>
                      <input className="input" value={form.campaign_manager} onChange={f('campaign_manager')} placeholder="John Doe" />
                    </div>
                    <div>
                      <label className="label">Treasurer</label>
                      <input className="input" value={form.treasurer} onChange={f('treasurer')} placeholder="Mary Johnson" />
                    </div>
                    <div>
                      <label className="label">Notes</label>
                      <textarea className="input" rows={4} value={form.notes} onChange={f('notes')} placeholder="Internal notes about this candidate..." />
                    </div>
                  </>
                )}

                {tab === 'social' && (
                  <>
                    <div>
                      <label className="label">Twitter / X Handle</label>
                      <input className="input" value={form.twitter_handle} onChange={f('twitter_handle')} placeholder="@JaneForWI" />
                    </div>
                    <div>
                      <label className="label">Facebook URL</label>
                      <input className="input" value={form.facebook_url} onChange={f('facebook_url')} placeholder="https://facebook.com/JaneForWisconsin" />
                    </div>
                    <div>
                      <label className="label">Instagram Handle</label>
                      <input className="input" value={form.instagram_handle} onChange={f('instagram_handle')} placeholder="@JaneForWI" />
                    </div>
                    <div>
                      <label className="label">Bio / Summary</label>
                      <textarea className="input" rows={5} value={form.bio_summary} onChange={f('bio_summary')} placeholder="Brief candidate background, political history, key issues..." />
                    </div>
                  </>
                )}
              </div>

              {modalError && (
                <div className="mx-6 mb-3 px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">{modalError}</div>
              )}
              <div className="flex gap-3 p-6 pt-0 border-t border-gray-100">
                <button type="button" onClick={() => { setShowModal(false); setModalError('') }} className="btn-secondary flex-1">Cancel</button>
                <button type="submit" className="btn-primary flex-1" disabled={saving} onClick={() => setModalError('')}>
                  {saving ? 'Saving...' : 'Add Candidate'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── CSV Upload Modal ── (canCsvImport re-checked so stale state can't open it) */}
      {showCsvModal && canCsvImport && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/50" onClick={() => setShowCsvModal(false)} />
          <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <div className="p-6 border-b border-gray-100">
              <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2">
                <Upload className="w-5 h-5 text-brand-red" /> Bulk Import Candidates (CSV)
              </h2>
              <p className="text-sm text-gray-500 mt-1">
                Upload a CSV file with candidate data. Required column: <code className="bg-gray-100 px-1 rounded">name</code>.
                Optional: <code className="bg-gray-100 px-1 rounded">party</code>, <code className="bg-gray-100 px-1 rounded">status</code>, <code className="bg-gray-100 px-1 rounded">office</code>, <code className="bg-gray-100 px-1 rounded">email</code>, <code className="bg-gray-100 px-1 rounded">phone</code>, <code className="bg-gray-100 px-1 rounded">website</code>, <code className="bg-gray-100 px-1 rounded">notes</code>
              </p>
            </div>

            <div className="p-6 space-y-4">
              {/* File picker */}
              {!csvRows.length && !csvResult && (
                <label className="flex flex-col items-center justify-center w-full h-36 border-2 border-dashed border-gray-300 rounded-xl cursor-pointer hover:border-brand-red hover:bg-red-50/30 transition-colors">
                  <Upload className="w-8 h-8 text-gray-300 mb-2" />
                  <span className="text-sm text-gray-500 font-medium">Click to select a CSV file</span>
                  <span className="text-xs text-gray-400 mt-1">or drag and drop</span>
                  <input
                    type="file"
                    accept=".csv,text/csv"
                    className="hidden"
                    onChange={e => {
                      const file = e.target.files?.[0]
                      if (!file) return
                      setCsvError('')
                      const reader = new FileReader()
                      reader.onload = (ev) => {
                        try {
                          const text = ev.target.result
                          const lines = text.split(/\r?\n/).filter(l => l.trim())
                          if (lines.length < 2) { setCsvError('CSV must have a header row and at least one data row.'); return }
                          // Parse CSV manually (handles quoted fields)
                          const parseRow = (line) => {
                            const result = []
                            let cur = '', inQ = false
                            for (let i = 0; i < line.length; i++) {
                              const ch = line[i]
                              if (ch === '"') {
                                if (inQ && line[i+1] === '"') { cur += '"'; i++ }
                                else inQ = !inQ
                              } else if (ch === ',' && !inQ) {
                                result.push(cur.trim()); cur = ''
                              } else {
                                cur += ch
                              }
                            }
                            result.push(cur.trim())
                            return result
                          }
                          const headers = parseRow(lines[0]).map(h => h.toLowerCase().replace(/\s+/g, '_'))
                          if (!headers.includes('name')) { setCsvError('CSV must have a "name" column.'); return }
                          const rows = lines.slice(1).map(line => {
                            const vals = parseRow(line)
                            const obj = {}
                            headers.forEach((h, i) => { obj[h] = vals[i] || '' })
                            return obj
                          }).filter(r => r.name)
                          setCsvHeaders(headers)
                          setCsvRows(rows)
                        } catch (err) {
                          setCsvError('Failed to parse CSV: ' + err.message)
                        }
                      }
                      reader.readAsText(file)
                    }}
                  />
                </label>
              )}

              {csvError && (
                <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                  <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  {csvError}
                </div>
              )}

              {/* Preview */}
              {csvRows.length > 0 && !csvResult && (
                <>
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold text-gray-700">{csvRows.length} rows detected — preview (first 5):</p>
                    <button className="text-xs text-gray-400 hover:text-red-600" onClick={() => { setCsvRows([]); setCsvHeaders([]) }}>Clear</button>
                  </div>
                  <div className="overflow-x-auto rounded-lg border border-gray-200">
                    <table className="w-full text-xs">
                      <thead className="bg-gray-50">
                        <tr>{csvHeaders.map(h => <th key={h} className="px-3 py-2 text-left font-semibold text-gray-600 whitespace-nowrap">{h}</th>)}</tr>
                      </thead>
                      <tbody>
                        {csvRows.slice(0, 5).map((row, i) => (
                          <tr key={i} className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                            {csvHeaders.map(h => <td key={h} className="px-3 py-1.5 text-gray-700 max-w-[160px] truncate">{row[h] || '—'}</td>)}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="text-xs text-gray-400">
                    Columns detected: {csvHeaders.join(', ')}. The <strong>office</strong> column will be matched by name to existing offices.
                  </p>
                </>
              )}

              {/* Import result */}
              {csvResult && (
                <div className="p-4 bg-green-50 border border-green-200 rounded-xl text-sm">
                  <div className="flex items-center gap-2 font-bold text-green-800 mb-2">
                    <CheckCircle className="w-4 h-4" /> Import Complete
                  </div>
                  <p className="text-green-700">✓ {csvResult.inserted} candidates imported successfully</p>
                  {csvResult.skipped > 0 && <p className="text-amber-700 mt-1">⚠ {csvResult.skipped} rows skipped (missing name or duplicate)</p>}
                  {csvResult.errors > 0 && <p className="text-red-700 mt-1">✗ {csvResult.errors} rows failed to save</p>}
                </div>
              )}
            </div>

            <div className="p-6 border-t border-gray-100 flex gap-3">
              <button onClick={() => setShowCsvModal(false)} className="btn-secondary flex-1">
                {csvResult ? 'Close' : 'Cancel'}
              </button>
              {csvRows.length > 0 && !csvResult && (
                <button
                  onClick={async () => {
                    setCsvImporting(true)
                    setCsvError('')
                    let inserted = 0, skipped = 0, errors = 0

                    // Scout plan cap on CSV import too. Same story as
                    // handleSave: the `scout_candidate_cap` trigger (migration
                    // 20260812000030) is the real enforcement, this pre-check
                    // just stops us firing a row-per-error import at a wall.
                    let slotsRemaining = Infinity
                    let capHit = false
                    if (getUserTier(user) === 'scout') {
                      const { count } = await supabase
                        .from('candidates')
                        .select('id', { count: 'exact', head: true })
                        .eq('created_by', user.id)
                      const currentCount = count ?? 0
                      slotsRemaining = Math.max(0, SCOUT_CANDIDATE_LIMIT - currentCount)
                      if (slotsRemaining === 0) {
                        setCsvError(`The free Scout plan is limited to ${SCOUT_CANDIDATE_LIMIT} candidates. Upgrade your plan to import more.`)
                        setCsvImporting(false)
                        setTotalCandidateCount(currentCount)
                        return
                      }
                    }

                    // Build a set of existing candidate names for deduplication
                    const existingNames = new Set(candidates.map(c => c.name?.toLowerCase().trim()).filter(Boolean))
                    for (const row of csvRows) {
                      // Stop importing once the Scout slot limit is reached —
                      // either by our own count, or because the server trigger
                      // has already said no (capHit).
                      if (capHit || inserted >= slotsRemaining) { skipped++; continue }
                      if (!row.name?.trim()) { skipped++; continue }
                      if (existingNames.has(row.name.trim().toLowerCase())) { skipped++; continue }
                      // Match office by name if column exists
                      let officeId = null
                      if (row.office || row.office_name) {
                        const oName = (row.office || row.office_name || '').toLowerCase().trim()
                        const match = offices.find(o => o.name.toLowerCase().includes(oName) || oName.includes(o.name.toLowerCase()))
                        if (match) officeId = match.id
                      }
                      const validStatuses = ['exploring','declared','primary_winner','general','elected','lost','withdrawn']
                      // null, not '' — the party CHECK constraint rejects an empty
                      // string. normalizePartyForDb does exact-name-then-family
                      // ('Democratic', 'DEM', 'GOP' → a valid value); it is the
                      // same helper the bulk profiler CSV and Discover use.
                      const party = normalizePartyForDb(row.party)
                      const status = validStatuses.find(s => s === (row.status||'').toLowerCase()) || 'exploring'
                      const { error } = await createCandidate({
                        name: row.name.trim(),
                        party,
                        status,
                        office_id: officeId,
                        email: row.email || null,
                        phone: row.phone || null,
                        website: row.website || null,
                        notes: notesToV2(row.notes, user?.email || 'CSV import'),
                        occupation: row.occupation || null,
                        employer: row.employer || null,
                        campaign_city: row.campaign_city || row.city || null,
                      })
                      if (error) {
                        // The cap trigger rejected this row. Every remaining
                        // row would be rejected too, so stop counting them as
                        // failures and show the plan sentence instead of 400s.
                        if (scoutCapMessage(error)) { capHit = true; skipped++; continue }
                        errors++
                      }
                      else inserted++
                    }
                    setCsvResult({ inserted, skipped, errors })
                    setCsvImporting(false)
                    if (inserted > 0) { fetchData(); refreshTotalCount() }
                    // Surface limit-hit message for Scout users
                    if (capHit) {
                      refreshTotalCount()
                      setCsvError(SCOUT_CAP_MESSAGE)
                    } else if (slotsRemaining !== Infinity && skipped > 0) {
                      setCsvError(`Scout plan limit: ${inserted} candidate${inserted !== 1 ? 's' : ''} imported. Remaining rows were skipped — upgrade to add more.`)
                    }
                  }}
                  disabled={csvImporting}
                  className="btn-primary flex-1 flex items-center justify-center gap-2"
                >
                  {csvImporting
                    ? <><span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> Importing…</>
                    : <><Upload className="w-4 h-4" /> Import {csvRows.length} Candidates</>
                  }
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
