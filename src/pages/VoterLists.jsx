import React, { useEffect, useState, useRef, useCallback } from 'react'
import { format } from 'date-fns'
import {
  Users, Upload, Download, MapPin, Search, Trash2, Plus,
  X, Check, ChevronDown, ChevronUp, List, Map as MapIcon,
  FileText, Filter, FolderPlus, Tag, BarChart2, ChevronRight,
  AlertTriangle,
} from 'lucide-react'

// ─── Vote history dot trail ───────────────────────────────────────────────────
// NOTE: This displays simulated/placeholder data. Integrate a real voter file
// provider (e.g. L2, TargetSmart, i360) to show actual voting history.
function VoteHistoryDots({ seed = 0 }) {
  // Deterministic pseudo-random from voter id seed
  let r = ((seed * 1103515245 + 12345) & 0x7fffffff)
  const elections = ['G22','P22','G20','P20','G18']
  const dots = elections.map(label => {
    r = ((r * 1103515245 + 12345) & 0x7fffffff)
    const voted = (r % 10) > 3
    return { label, voted }
  })
  return (
    <div style={{ display:'flex', gap:3, alignItems:'center' }} title="Simulated data — not from actual voter file">
      {dots.map(d => (
        <div key={d.label} title={`${d.label}: ${d.voted ? 'Voted' : 'Did not vote'} (simulated)`}
          style={{ width:8, height:8, borderRadius:'50%', background: d.voted ? '#16a34a' : '#e5e7eb', flexShrink:0, cursor:'default' }}
        />
      ))}
    </div>
  )
}

// ─── Propensity score bar ─────────────────────────────────────────────────────
// NOTE: This displays simulated/placeholder data. Integrate a real voter file
// provider to show actual propensity scores.
function PropensityBar({ seed = 0 }) {
  let r = ((seed * 6364136223846793005 + 1442695040888963407) & 0x7fffffff) || 1
  const score = Math.abs(r % 101)
  const color = score >= 70 ? '#16a34a' : score >= 40 ? '#eab308' : '#dc2626'
  return (
    <div style={{ display:'flex', alignItems:'center', gap:5 }} title="Simulated propensity score — not from actual voter file">
      <div style={{ width:44, height:5, background:'#e5e7eb', borderRadius:3, overflow:'hidden' }}>
        <div style={{ height:'100%', width:`${score}%`, background:color, borderRadius:3 }}/>
      </div>
      <span style={{ fontSize:10, fontWeight:700, color, minWidth:22 }}>{score}</span>
    </div>
  )
}

// ─── Simulated data banner ────────────────────────────────────────────────────
function SimulatedDataBanner() {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      background: '#fef9c3', border: '1px solid #fde047',
      borderRadius: 8, padding: '8px 12px', marginBottom: 12,
      fontSize: 12, color: '#854d0e',
    }}>
      <AlertTriangle style={{ width: 16, height: 16 }} />
      <span>
        <strong>Simulated data:</strong> Vote history dots and propensity scores shown here are placeholder values generated for display purposes only. They do not reflect actual voter records. Connect a voter data provider for real data.
      </span>
    </div>
  )
}
import {
  getVoterLists, createVoterList, deleteVoterList,
  getVoters, createVoters, deleteVotersByList, updateVoter,
  getVoterSavedLists, createVoterSavedList, updateVoterSavedList, deleteVoterSavedList,
} from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import SearchableSelect from '../components/SearchableSelect'
import { parseCsvRows } from '../lib/csv'
import LoadingBar from '../components/LoadingBar'

// ─── CSV parser ───────────────────────────────────────────────────────────────
function parseCSV(text) {
  // parseCsvRows handles quoted commas, escaped quotes, embedded newlines,
  // and CRLF — the old header split(',') broke on quoted headers and left
  // \r on the last column of every CRLF row.
  const records = parseCsvRows(text)
  if (records.length < 2) return []
  const headers = records[0].map(h => h.trim().replace(/^"|"$/g, '').toLowerCase())

  return records.slice(1).filter(r => r.some(c => c && c.trim())).map(rawCols => {
    const cols = rawCols.map(c => c.trim())
    const row = {}
    headers.forEach((h, i) => { row[h] = cols[i] || '' })

    // Normalize common Wisconsin voter file column names
    return {
      first_name: row['firstname'] || row['first_name'] || row['first'] || '',
      last_name:  row['lastname']  || row['last_name']  || row['last']  || '',
      full_name:  row['name'] || row['full_name'] || row['fullname'] || `${row['firstname'] || row['first_name'] || ''} ${row['lastname'] || row['last_name'] || ''}`.trim(),
      address:    row['address'] || row['res_address'] || row['street_address'] || row['address1'] || '',
      city:       row['city'] || row['municipality'] || row['muni'] || '',
      state:      row['state'] || 'WI',
      zip:        row['zip'] || row['zipcode'] || row['zip_code'] || row['postalcode'] || '',
      county:     row['county'] || row['countyname'] || '',
      ward:       row['ward'] || row['precinct'] || row['wardname'] || '',
      congressional_district:   row['con_dist'] || row['congressional_district'] || row['cong_dist'] || '',
      state_senate_district:    row['senate_dist'] || row['state_senate_district'] || row['sen_dist'] || '',
      state_assembly_district:  row['assembly_dist'] || row['state_assembly_district'] || row['assem_dist'] || '',
      party:      row['party'] || row['party_affiliation'] || row['party_pref'] || '',
      raw_data: row,
    }
  }).filter(r => r.full_name || r.address)
}

// ─── District options for filter ─────────────────────────────────────────────
const DISTRICT_TYPES = [
  { key: 'county', label: 'County' },
  { key: 'state_assembly_district', label: 'Assembly District' },
  { key: 'state_senate_district',   label: 'Senate District' },
  { key: 'congressional_district',  label: 'Congressional District' },
]

// ─── Voter pin map (Leaflet-based) ────────────────────────────────────────────
function VoterMapView({ voters, savedLists, onAddToList }) {
  const mapRef = useRef(null)
  const mapInstanceRef = useRef(null)
  const markersRef = useRef([])

  useEffect(() => {
    if (mapInstanceRef.current) return
    // Dynamically load leaflet to avoid SSR issues
    const L = window.L
    if (!L) return

    const map = L.map(mapRef.current, {
      center: [44.5, -89.5],
      zoom: 7,
      zoomControl: true,
    })
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors',
    }).addTo(map)
    mapInstanceRef.current = map
    return () => { map.remove(); mapInstanceRef.current = null }
  }, [])

  useEffect(() => {
    const L = window.L
    const map = mapInstanceRef.current
    if (!L || !map) return

    // Clear existing markers
    markersRef.current.forEach(m => map.removeLayer(m))
    markersRef.current = []

    const geocoded = voters.filter(v => v.latitude && v.longitude)
    geocoded.forEach(voter => {
      const icon = L.divIcon({
        className: '',
        html: `<div style="
          width:10px;height:10px;border-radius:50%;
          background:${voter.party === 'Republican' ? '#dc2626' : voter.party === 'Democrat' ? '#2563eb' : '#6b7280'};
          border:2px solid white;box-shadow:0 1px 3px rgba(0,0,0,.4);
          transition:all .15s;cursor:pointer;
        " class="voter-pin"></div>`,
        iconSize: [10, 10],
        iconAnchor: [5, 5],
      })

      const marker = L.marker([voter.latitude, voter.longitude], { icon })
        .addTo(map)

      marker.on('mouseover', function () {
        this._icon.firstChild.style.transform = 'scale(1.5)'
        this._icon.firstChild.style.boxShadow = '0 0 0 3px rgba(220,38,38,.4), 0 2px 6px rgba(0,0,0,.4)'
      })
      marker.on('mouseout', function () {
        this._icon.firstChild.style.transform = ''
        this._icon.firstChild.style.boxShadow = '0 1px 3px rgba(0,0,0,.4)'
      })
      marker.on('click', function () {
        const listOptions = savedLists.map(sl =>
          `<div data-list-id="${sl.id}" style="padding:4px 8px;cursor:pointer;font-size:12px;border-radius:4px;hover:background:#f3f4f6">+ Add to "${sl.name}"</div>`
        ).join('')

        const popup = L.popup({ maxWidth: 220, closeButton: true })
          .setLatLng([voter.latitude, voter.longitude])
          .setContent(`
            <div style="font-family:sans-serif;font-size:12px;">
              <div style="font-weight:700;margin-bottom:2px">${voter.full_name || 'Voter'}</div>
              <div style="color:#6b7280;margin-bottom:4px">${voter.address || ''}, ${voter.city || ''}</div>
              ${voter.party ? `<div style="color:#374151;margin-bottom:6px">Party: <strong>${voter.party}</strong></div>` : ''}
              <div style="border-top:1px solid #e5e7eb;padding-top:6px;margin-top:4px">
                <div style="font-size:11px;font-weight:600;color:#9ca3af;margin-bottom:4px">ADD TO LIST</div>
                <div id="voter-list-options-${voter.id}">${listOptions || '<div style="color:#9ca3af;font-size:11px">No saved lists yet</div>'}</div>
              </div>
            </div>
          `)
          .openOn(map)

        // Event delegation for list buttons inside popup
        setTimeout(() => {
          const container = document.getElementById(`voter-list-options-${voter.id}`)
          if (container) {
            container.querySelectorAll('[data-list-id]').forEach(btn => {
              btn.addEventListener('click', () => {
                onAddToList(voter, btn.getAttribute('data-list-id'))
                map.closePopup()
              })
            })
          }
        }, 100)
      })

      markersRef.current.push(marker)
    })

    if (geocoded.length > 0) {
      const group = L.featureGroup(markersRef.current)
      map.fitBounds(group.getBounds().pad(0.1))
    }
  }, [voters, savedLists, onAddToList])

  return (
    <div ref={mapRef} style={{ height: '500px', borderRadius: '12px', overflow: 'hidden' }} />
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function VoterLists() {
  const { user } = useAuth()
  const [voterLists, setVoterLists]       = useState([])
  const [selectedList, setSelectedList]   = useState(null)
  const [voters, setVoters]               = useState([])
  const [votersTruncated, setVotersTruncated] = useState(false)
  const [savedLists, setSavedLists]       = useState([])
  const [loading, setLoading]             = useState(false)
  const [uploading, setUploading]         = useState(false)
  const [error, setError]                 = useState(null)   // was referenced but never defined — crashed the failure path
  const [uploadProgress, setUploadProgress] = useState(null) // { done, total } chunks
  const [viewMode, setViewMode]           = useState('table') // 'table' | 'map'
  const [searchVoter, setSearchVoter]     = useState('')
  const [districtFilter, setDistrictFilter] = useState({ type: 'county', value: '' })
  const [partyFilter, setPartyFilter]       = useState('')
  const [showSuppressed, setShowSuppressed] = useState(false)
  const [showVANExport, setShowVANExport]   = useState(false)
  const [showUploadModal, setShowUploadModal] = useState(false)
  const [uploadName, setUploadName]       = useState('')
  const [csvFile, setCsvFile]             = useState(null)
  const [csvPreview, setCsvPreview]       = useState([])
  const [showNewListModal, setShowNewListModal] = useState(false)
  const [newListName, setNewListName]     = useState('')
  const [addToListModal, setAddToListModal] = useState(null) // { voter, mode: 'new'|'existing' }
  const [addToExistingId, setAddToExistingId] = useState('')
  const [newListColor, setNewListColor]   = useState('#3B82F6')
  const fileInputRef = useRef(null)

  useEffect(() => { fetchAll() }, [])

  const fetchAll = async () => {
    const [{ data: vl }, { data: sl }] = await Promise.all([
      getVoterLists(),
      getVoterSavedLists(),
    ])
    setVoterLists(vl || [])
    setSavedLists(sl || [])
  }

  const VOTER_DISPLAY_LIMIT = 1000
  const fetchVoters = async (listId) => {
    setLoading(true)
    const { data } = await getVoters(listId, VOTER_DISPLAY_LIMIT + 1)
    const rows = data || []
    setVotersTruncated(rows.length > VOTER_DISPLAY_LIMIT)
    setVoters(rows.slice(0, VOTER_DISPLAY_LIMIT))
    setLoading(false)
  }

  const handleSelectList = (list) => {
    setSelectedList(list)
    fetchVoters(list.id)
    setSearchVoter('')
    setDistrictFilter({ type: 'county', value: '' })
  }

  const handleFileChange = (e) => {
    const file = e.target.files[0]
    if (!file) return
    setCsvFile(file)
    const reader = new FileReader()
    reader.onload = (ev) => {
      const rows = parseCSV(ev.target.result)
      setCsvPreview(rows)
    }
    reader.readAsText(file)
  }

  const handleUpload = async () => {
    if (!csvFile || csvPreview.length === 0 || !uploadName.trim()) return
    setUploading(true)
    try {
      // Create the voter list record
      const { data: newList } = await createVoterList({
        name: uploadName.trim(),
        source_filename: csvFile.name,
        total_count: csvPreview.length,
        created_by: user?.id,
      })

      if (!newList?.id) { setError('Failed to create voter list record.'); setUploading(false); return }

      // Strip raw_data before inserting (avoids large payloads) and batch in 200-row chunks
      // created_by is REQUIRED by the voters RLS insert policy (migration
      // 20260422000004) — without it every chunk is rejected with 403.
      const rows = csvPreview.map(({ raw_data, ...r }) => ({ ...r, voter_list_id: newList.id, created_by: user?.id }))
      const totalChunks = Math.ceil(rows.length / 200)
      for (let i = 0; i < rows.length; i += 200) {
        const { error: insertErr } = await createVoters(rows.slice(i, i + 200))
        if (insertErr) {
          setError(`Upload failed at row ${i + 1}: ${insertErr.message}`)
          setUploading(false)
          return
        }
        setUploadProgress({ done: Math.floor(i / 200) + 1, total: totalChunks })
      }

      await fetchAll()
      setShowUploadModal(false)
      setCsvFile(null)
      setCsvPreview([])
      setUploadName('')
      setUploadProgress(null)
      // Select the new list in the sidebar but do NOT auto-fetch voters —
      // large lists would freeze the browser. User can click "Load voters" themselves.
      setSelectedList(newList)
      setVoters([])
    } catch (err) {
      alert('Upload failed: ' + err.message)
      setUploadProgress(null)
    }
    setUploading(false)
  }

  const handleDeleteList = async (listId) => {
    if (!window.confirm('Delete this voter list and all its records?')) return
    await deleteVotersByList(listId)
    await deleteVoterList(listId)
    if (selectedList?.id === listId) {
      setSelectedList(null)
      setVoters([])
    }
    fetchAll()
  }

  const handleAddToList = useCallback(async (voter, savedListId) => {
    const sl = savedLists.find(s => s.id === savedListId)
    if (!sl) return
    const ids = sl.voter_ids || []
    if (!ids.includes(voter.id)) {
      await updateVoterSavedList(savedListId, { voter_ids: [...ids, voter.id] })
      fetchAll()
    }
  }, [savedLists])

  const handleAddToListFromModal = async () => {
    if (!addToListModal) return
    const { voter, mode } = addToListModal
    if (mode === 'new') {
      if (!newListName.trim()) return
      await createVoterSavedList({
        name: newListName.trim(),
        color: newListColor,
        voter_ids: [voter.id],
        created_by: user?.id,
      })
    } else {
      if (!addToExistingId) return
      await handleAddToList(voter, addToExistingId)
    }
    setAddToListModal(null)
    setNewListName('')
    fetchAll()
  }

  // Get unique district values for filtering
  const districtValues = [...new Set(
    voters.map(v => v[districtFilter.type]).filter(Boolean)
  )].sort()

  const filteredVoters = voters.filter(v => {
    const matchSearch = !searchVoter || [v.full_name, v.address, v.city, v.party].some(
      f => f?.toLowerCase().includes(searchVoter.toLowerCase())
    )
    const matchDistrict = !districtFilter.value || v[districtFilter.type] === districtFilter.value
    const matchParty = !partyFilter || (v.party || '').toLowerCase().startsWith(partyFilter.toLowerCase())
    return matchSearch && matchDistrict && matchParty
  })

  // VAN export format
  const handleVANExport = () => {
    if (filteredVoters.length === 0) return
    const cols = ['VANID','FirstName','LastName','PreferredPhone','Address','City','Zip','PrecinctName','PartyCode']
    const header = cols.join('\t')
    const rows = filteredVoters.map((v, i) => [
      `WI${String(v.id || i).padStart(8,'0')}`,
      v.first_name || '',
      v.last_name || v.full_name?.split(' ').slice(-1)[0] || '',
      v.phone || '',
      v.address || '',
      v.city || '',
      v.zip || '',
      v.ward || v.county || '',
      (v.party || '').toUpperCase().charAt(0) || 'U',
    ].map(c => `"${String(c).replace(/"/g,'""')}"`).join('\t'))
    const tsv = [header, ...rows].join('\n')
    const blob = new Blob([tsv], { type: 'text/tab-separated-values' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `VAN_export_${format(new Date(), 'yyyy-MM-dd')}.txt`
    a.click()
  }

  // Export filtered voters as CSV
  const handleExport = () => {
    if (filteredVoters.length === 0) return
    const cols = ['full_name','address','city','zip','county','ward','state_assembly_district','state_senate_district','congressional_district','party']
    const header = cols.join(',')
    const rows = filteredVoters.map(v =>
      cols.map(c => `"${String(v[c] ?? '').replace(/"/g, '""')}"`).join(',')
    )
    const csv = [header, ...rows].join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    const suffix = districtFilter.value ? `_${districtFilter.value.replace(/\s+/g,'_')}` : ''
    a.download = `voters${suffix}_${format(new Date(), 'yyyy-MM-dd')}.csv`
    a.click()
  }

  return (
    <div className="space-y-6">
      <LoadingBar loading={loading} />
      {error && (
        <div className="flex items-center justify-between bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-2.5">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="text-red-400 hover:text-red-600 font-bold ml-3">✕</button>
        </div>
      )}
      <div className="flex items-start justify-end">
        <button onClick={() => setShowUploadModal(true)} className="btn-primary flex items-center gap-2">
          <Upload className="w-4 h-4" /> Upload CSV
        </button>
      </div>

      <div className="grid lg:grid-cols-4 gap-6">
        {/* Left: Voter lists sidebar */}
        <div className="space-y-4">
          {/* Uploaded lists */}
          <div className="card">
            <h2 className="text-sm font-bold text-gray-900 mb-3">Uploaded Lists ({voterLists.length})</h2>
            {voterLists.length === 0 ? (
              <div className="text-center py-6">
                <Upload className="w-8 h-8 text-gray-200 mx-auto mb-2" />
                <p className="text-xs text-gray-400 mb-2">No voter lists yet</p>
                <button onClick={() => setShowUploadModal(true)} className="text-xs text-brand-red font-medium hover:underline">
                  Upload CSV →
                </button>
              </div>
            ) : (
              <div className="space-y-1">
                {voterLists.map(vl => (
                  <div
                    key={vl.id}
                    onClick={() => handleSelectList(vl)}
                    className={`group flex items-center justify-between p-2.5 rounded-lg cursor-pointer transition-colors ${selectedList?.id === vl.id ? 'bg-brand-red/10 border border-brand-red/20' : 'hover:bg-gray-50'}`}
                  >
                    <div className="flex-1 min-w-0">
                      <p className={`text-xs font-semibold truncate ${selectedList?.id === vl.id ? 'text-brand-red' : 'text-gray-800'}`}>{vl.name}</p>
                      <p className="text-xs text-gray-400">{vl.total_count?.toLocaleString()} voters</p>
                    </div>
                    <button
                      onClick={e => { e.stopPropagation(); handleDeleteList(vl.id) }}
                      className="opacity-0 group-hover:opacity-100 p-1 rounded hover:text-brand-red transition-all"
                    >
                      <Trash2 className="w-3 h-3 text-gray-400 hover:text-brand-red" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Saved Lists */}
          <div className="card">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-bold text-gray-900">Saved Lists ({savedLists.length})</h2>
              <button
                onClick={() => setShowNewListModal(true)}
                className="text-xs text-brand-red hover:underline font-medium"
              >+ New</button>
            </div>
            {savedLists.length === 0 ? (
              <p className="text-xs text-gray-400 text-center py-3">Click a voter on the map to save them to a list</p>
            ) : (
              <div className="space-y-1">
                {savedLists.map(sl => (
                  <div key={sl.id} className="flex items-center gap-2 p-2 rounded-lg hover:bg-gray-50">
                    <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: sl.color }} />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-semibold text-gray-800 truncate">{sl.name}</p>
                      <p className="text-xs text-gray-400">{(sl.voter_ids || []).length} voters</p>
                    </div>
                    <button
                      onClick={async () => {
                        if (!window.confirm(`Delete list "${sl.name}"?`)) return
                        await deleteVoterSavedList(sl.id)
                        fetchAll()
                      }}
                      className="p-1 rounded hover:text-brand-red"
                    >
                      <Trash2 className="w-3 h-3 text-gray-300 hover:text-brand-red" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right: Voter table / map */}
        <div className="lg:col-span-3">
          {!selectedList ? (
            <div className="card flex flex-col items-center justify-center py-24 text-center">
              <Users className="w-16 h-16 text-gray-200 mb-4" />
              <p className="text-gray-500 font-semibold">No voter list selected</p>
              <p className="text-gray-400 text-sm mt-1">Upload a CSV voter file or select a list from the left</p>
              <button onClick={() => setShowUploadModal(true)} className="btn-primary mt-6 flex items-center gap-2">
                <Upload className="w-4 h-4" /> Upload CSV
              </button>
            </div>
          ) : (
            <div className="card space-y-4">
              {/* Header */}
              <div className="flex items-start justify-between gap-4 pb-3 border-b border-gray-100">
                <div>
                  <h2 className="text-lg font-bold text-gray-900">{selectedList.name}</h2>
                  <p className="text-sm text-gray-400 mt-0.5">
                    {filteredVoters.length.toLocaleString()} of {voters.length.toLocaleString()} voters shown
                    {districtFilter.value && ` · Filtered by ${districtFilter.value}`}
                  </p>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <button
                    onClick={() => setViewMode(v => v === 'table' ? 'map' : 'table')}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${viewMode === 'map' ? 'bg-brand-navy text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
                  >
                    {viewMode === 'map' ? <List className="w-3.5 h-3.5" /> : <MapIcon className="w-3.5 h-3.5" />}
                    {viewMode === 'map' ? 'Table View' : 'Map View'}
                  </button>
                  <div className="relative">
                    <button onClick={() => setShowVANExport(v => !v)} className="btn-secondary text-xs flex items-center gap-1.5 py-1.5">
                      <Download className="w-3.5 h-3.5" />
                      Export <ChevronRight className={`w-3 h-3 transition-transform ${showVANExport ? 'rotate-90' : ''}`}/>
                    </button>
                    {showVANExport && (
                      <div className="absolute right-0 top-full mt-1 w-48 bg-white rounded-xl shadow-xl border border-gray-200 py-1 z-50">
                        <button onClick={() => { handleExport(); setShowVANExport(false) }} className="w-full flex items-center gap-2 px-3 py-2 text-xs text-gray-700 hover:bg-gray-50">
                          <FileText className="w-3.5 h-3.5 text-gray-400"/> Standard CSV
                        </button>
                        <button onClick={() => { handleVANExport(); setShowVANExport(false) }} className="w-full flex items-center gap-2 px-3 py-2 text-xs text-gray-700 hover:bg-gray-50">
                          <BarChart2 className="w-3.5 h-3.5 text-blue-500"/> VAN / VoteBuilder Format
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Filters */}
              <div className="flex flex-wrap gap-2">
                <div className="relative flex-1 min-w-40">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
                  <input
                    className="input pl-8 text-xs py-1.5"
                    placeholder="Search voters..."
                    value={searchVoter}
                    onChange={e => setSearchVoter(e.target.value)}
                  />
                </div>
                <select className="input text-xs py-1.5 w-28" value={partyFilter} onChange={e => setPartyFilter(e.target.value)}>
                  <option value="">All Parties</option>
                  <option value="r">Republican</option>
                  <option value="d">Democrat</option>
                  <option value="i">Independent</option>
                </select>
                <select
                  className="input text-xs py-1.5 w-40"
                  value={districtFilter.type}
                  onChange={e => setDistrictFilter({ type: e.target.value, value: '' })}
                >
                  {DISTRICT_TYPES.map(d => <option key={d.key} value={d.key}>{d.label}</option>)}
                </select>
                <SearchableSelect
                  className="w-40"
                  buttonClassName="text-xs py-1.5"
                  value={districtFilter.value}
                  onChange={v => setDistrictFilter(p => ({ ...p, value: v }))}
                  options={[{ value: '', label: `All ${districtFilter.type.replace(/_/g,' ')}` }, ...districtValues.map(v => ({ value: v, label: v }))]}
                  placeholder={`All ${districtFilter.type.replace(/_/g,' ')}`} />
                <button
                  onClick={() => setShowSuppressed(s => !s)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${showSuppressed ? 'bg-orange-50 border-orange-200 text-orange-700' : 'bg-white border-gray-200 text-gray-500 hover:bg-gray-50'}`}
                >
                  {showSuppressed ? '✓' : ''} Suppression
                </button>
              </div>

              {/* After upload, voters are not auto-loaded — show a prompt instead */}
              {!loading && voters.length === 0 && selectedList && (
                <div className="flex flex-col items-center py-12 gap-3">
                  <Users className="w-10 h-10 text-gray-300" />
                  <p className="text-sm text-gray-500 font-medium">
                    {selectedList.total_count?.toLocaleString() ?? '?'} voters in this list
                  </p>
                  <button
                    type="button"
                    onClick={() => fetchVoters(selectedList.id)}
                    className="btn-primary text-sm px-5"
                  >
                    Load Voters
                  </button>
                  <p className="text-xs text-gray-400">First 1,000 rows shown</p>
                </div>
              )}

              {loading ? (
                <div className="flex justify-center py-12">
                  <div className="w-8 h-8 border-4 border-brand-red border-t-transparent rounded-full animate-spin" />
                </div>
              ) : viewMode === 'map' ? (
                <div>
                  {filteredVoters.filter(v => v.latitude).length === 0 ? (
                    <div className="text-center py-12 text-gray-400">
                      <MapPin className="w-10 h-10 mx-auto mb-2 opacity-30" />
                      <p className="text-sm">No geocoded addresses in this list.</p>
                      <p className="text-xs mt-1">Voter files with lat/lng columns will show pins here.</p>
                    </div>
                  ) : (
                    <VoterMapView
                      voters={filteredVoters}
                      savedLists={savedLists}
                      onAddToList={handleAddToList}
                    />
                  )}
                  <p className="text-xs text-gray-400 mt-2 text-center">
                    {filteredVoters.filter(v => v.latitude).length} geocoded pins shown · Click a pin to add voter to a list
                  </p>
                </div>
              ) : (
                /* Table view */
                <div className="overflow-x-auto">
                  {votersTruncated && (
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      background: '#fef3c7', border: '1px solid #fcd34d',
                      borderRadius: 8, padding: '8px 12px', marginBottom: 8,
                      fontSize: 12, color: '#92400e',
                    }}>
                      <AlertTriangle style={{ width: 16, height: 16 }} />
                      <span>
                        Showing first 1,000 voters. This list has more records — use filters to narrow results or export for the full list.
                      </span>
                    </div>
                  )}
                  <SimulatedDataBanner />
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-gray-100">
                        {['Name','Address','City','Party','Vote History','Propensity','Assembly Dist.','Action'].map(h => (
                          <th key={h} className="text-left text-gray-400 font-semibold pb-2 pr-3 whitespace-nowrap text-xs">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {filteredVoters.slice(0, 500).map(v => (
                        <tr key={v.id} className="hover:bg-gray-50 transition-colors">
                          <td className="py-2 pr-3 font-medium text-gray-900 whitespace-nowrap">{v.full_name || '—'}</td>
                          <td className="py-2 pr-3 text-gray-600 max-w-36 truncate">{v.address || '—'}</td>
                          <td className="py-2 pr-3 text-gray-600 whitespace-nowrap">{v.city || '—'}</td>
                          <td className="py-2 pr-3">
                            {v.party ? (
                              <span className={`px-1.5 py-0.5 rounded-full font-medium text-xs ${
                                v.party.toLowerCase().startsWith('r') ? 'bg-red-100 text-red-700' :
                                v.party.toLowerCase().startsWith('d') ? 'bg-blue-100 text-blue-700' :
                                'bg-gray-100 text-gray-600'
                              }`}>{v.party.charAt(0).toUpperCase()}</span>
                            ) : '—'}
                          </td>
                          <td className="py-2 pr-3">
                            <VoteHistoryDots seed={v.id ? parseInt(String(v.id).replace(/\D/g,'').slice(0,8) || '0') : 0} />
                          </td>
                          <td className="py-2 pr-3">
                            <PropensityBar seed={v.id ? parseInt(String(v.id).replace(/\D/g,'').slice(0,8) || '1') + 7 : 7} />
                          </td>
                          <td className="py-2 pr-3 text-gray-500 text-xs">{v.state_assembly_district || '—'}</td>
                          <td className="py-2">
                            <button
                              onClick={() => setAddToListModal({ voter: v, mode: 'existing' })}
                              className="text-brand-red hover:underline font-medium whitespace-nowrap text-xs"
                            >
                              + List
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {filteredVoters.length > 500 && (
                    <p className="text-xs text-gray-400 text-center py-3">
                      Showing first 500 of {filteredVoters.length.toLocaleString()} voters. Export CSV for full list.
                    </p>
                  )}
                  {filteredVoters.length === 0 && (
                    <p className="text-sm text-gray-400 text-center py-8">No voters match your search</p>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Upload CSV Modal */}
      {showUploadModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/50" onClick={() => setShowUploadModal(false)} />
          <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-lg">
            <div className="flex items-center justify-between p-6 border-b border-gray-100">
              <div className="flex items-center gap-2">
                <Upload className="w-5 h-5 text-brand-red" />
                <h2 className="text-lg font-bold text-gray-900">Upload Voter CSV</h2>
              </div>
              <button onClick={() => setShowUploadModal(false)}><X className="w-5 h-5 text-gray-400" /></button>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className="label text-xs">List Name *</label>
                <input className="input" value={uploadName} onChange={e => setUploadName(e.target.value)} placeholder="e.g. Milwaukee County Voter File 2026" />
              </div>

              <div>
                <label className="label text-xs">CSV File *</label>
                <div
                  onClick={() => fileInputRef.current?.click()}
                  className="border-2 border-dashed border-gray-200 rounded-xl p-6 text-center cursor-pointer hover:border-brand-red hover:bg-red-50/30 transition-colors"
                >
                  {csvFile ? (
                    <div>
                      <FileText className="w-8 h-8 text-brand-red mx-auto mb-2" />
                      <p className="text-sm font-medium text-gray-800">{csvFile.name}</p>
                      <p className="text-xs text-gray-500 mt-1">{csvPreview.length.toLocaleString()} voters parsed</p>
                    </div>
                  ) : (
                    <div>
                      <Upload className="w-8 h-8 text-gray-300 mx-auto mb-2" />
                      <p className="text-sm text-gray-500">Click to select or drop a CSV file</p>
                      <p className="text-xs text-gray-400 mt-1">Wisconsin voter file format supported</p>
                    </div>
                  )}
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".csv,.txt"
                    className="hidden"
                    onChange={handleFileChange}
                  />
                </div>
              </div>

              {csvPreview.length > 0 && (
                <div className="p-3 bg-gray-50 rounded-lg">
                  <p className="text-xs font-semibold text-gray-700 mb-2">Preview (first 3 rows)</p>
                  {csvPreview.slice(0, 3).map((r, i) => (
                    <div key={i} className="text-xs text-gray-600 py-1 border-b border-gray-100 last:border-0">
                      {r.full_name} · {r.address}, {r.city} · {r.party || 'No party'}
                    </div>
                  ))}
                </div>
              )}

              <div className="flex gap-3">
                <button onClick={() => setShowUploadModal(false)} className="btn-secondary flex-1 text-sm">Cancel</button>
                <button
                  onClick={handleUpload}
                  disabled={uploading || !csvFile || !uploadName.trim() || csvPreview.length === 0}
                  className="btn-primary flex-1 text-sm flex items-center justify-center gap-2"
                >
                  {uploading ? (
                    <>
                      <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                      {uploadProgress
                        ? `Chunk ${uploadProgress.done}/${uploadProgress.total}…`
                        : 'Creating list…'}
                    </>
                  ) : (
                    <><Upload className="w-4 h-4" /> Upload {csvPreview.length > 0 ? `${csvPreview.length.toLocaleString()} Voters` : ''}</>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* New Saved List Modal */}
      {showNewListModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/40" onClick={() => setShowNewListModal(false)} />
          <div className="relative bg-white rounded-xl shadow-xl p-6 w-full max-w-sm">
            <h3 className="font-bold text-gray-900 mb-4 flex items-center gap-2">
              <FolderPlus className="w-4 h-4 text-brand-red" /> New Saved List
            </h3>
            <div className="space-y-3">
              <input className="input" value={newListName} onChange={e => setNewListName(e.target.value)} placeholder="List name..." autoFocus />
              <div>
                <label className="label text-xs">Color</label>
                <div className="flex gap-2 flex-wrap">
                  {['#3B82F6','#DC2626','#16A34A','#D97706','#7C3AED','#EC4899','#374151'].map(col => (
                    <button
                      key={col}
                      onClick={() => setNewListColor(col)}
                      className={`w-6 h-6 rounded-full border-2 transition-all ${newListColor === col ? 'border-gray-900 scale-110' : 'border-transparent'}`}
                      style={{ backgroundColor: col }}
                    />
                  ))}
                </div>
              </div>
            </div>
            <div className="flex gap-3 mt-4">
              <button onClick={() => setShowNewListModal(false)} className="btn-secondary flex-1 text-sm">Cancel</button>
              <button
                onClick={async () => {
                  if (!newListName.trim()) return
                  await createVoterSavedList({ name: newListName.trim(), color: newListColor, voter_ids: [], created_by: user?.id })
                  setShowNewListModal(false)
                  setNewListName('')
                  fetchAll()
                }}
                disabled={!newListName.trim()}
                className="btn-primary flex-1 text-sm"
              >
                Create List
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add to List Modal */}
      {addToListModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/40" onClick={() => setAddToListModal(null)} />
          <div className="relative bg-white rounded-xl shadow-xl p-6 w-full max-w-sm">
            <h3 className="font-bold text-gray-900 mb-1">Add to List</h3>
            <p className="text-sm text-gray-500 mb-4">{addToListModal.voter.full_name}</p>

            <div className="grid grid-cols-2 gap-3 mb-4">
              <button
                onClick={() => setAddToListModal(p => ({ ...p, mode: 'existing' }))}
                className={`p-3 rounded-lg border-2 text-sm font-medium transition-all ${addToListModal.mode === 'existing' ? 'border-brand-red bg-brand-red/5 text-brand-red' : 'border-gray-200 text-gray-600'}`}
              >
                Existing List
              </button>
              <button
                onClick={() => setAddToListModal(p => ({ ...p, mode: 'new' }))}
                className={`p-3 rounded-lg border-2 text-sm font-medium transition-all ${addToListModal.mode === 'new' ? 'border-brand-navy bg-brand-navy/5 text-brand-navy' : 'border-gray-200 text-gray-600'}`}
              >
                New List
              </button>
            </div>

            {addToListModal.mode === 'existing' ? (
              savedLists.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-3">No saved lists yet. Create one first.</p>
              ) : (
                <div className="space-y-1 mb-4 max-h-48 overflow-y-auto">
                  {savedLists.map(sl => (
                    <button
                      key={sl.id}
                      onClick={() => setAddToExistingId(sl.id)}
                      className={`w-full flex items-center gap-2 p-2.5 rounded-lg text-left transition-colors ${addToExistingId === sl.id ? 'bg-brand-red/10 border border-brand-red/20' : 'hover:bg-gray-50 border border-transparent'}`}
                    >
                      <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: sl.color }} />
                      <span className="text-sm font-medium text-gray-800 flex-1">{sl.name}</span>
                      <span className="text-xs text-gray-400">{(sl.voter_ids || []).length}</span>
                    </button>
                  ))}
                </div>
              )
            ) : (
              <div className="space-y-3 mb-4">
                <input className="input" value={newListName} onChange={e => setNewListName(e.target.value)} placeholder="New list name..." autoFocus />
                <div className="flex gap-2">
                  {['#3B82F6','#DC2626','#16A34A','#D97706','#7C3AED'].map(col => (
                    <button key={col} onClick={() => setNewListColor(col)}
                      className={`w-5 h-5 rounded-full border-2 ${newListColor === col ? 'border-gray-900 scale-110' : 'border-transparent'}`}
                      style={{ backgroundColor: col }} />
                  ))}
                </div>
              </div>
            )}

            <div className="flex gap-3">
              <button onClick={() => setAddToListModal(null)} className="btn-secondary flex-1 text-sm">Cancel</button>
              <button onClick={handleAddToListFromModal} className="btn-primary flex-1 text-sm">Add to List</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
