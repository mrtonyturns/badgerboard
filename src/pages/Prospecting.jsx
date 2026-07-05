import { useNavigate } from 'react-router-dom'
import React, { useEffect, useState, useRef } from 'react'
import { format } from 'date-fns'
import {
  ListChecks, Sparkles, Plus, Search, Trash2, Download,
  Copy, Check, AlertCircle, X, Users, FileText, Lock,
  PenLine, Bot, UserCheck, Mail, Upload, ChevronRight,
  TrendingUp, TrendingDown, HelpCircle, UserPlus, Filter,
} from 'lucide-react'
import {
  getCandidates, getOffices, getElections,
  getProspectingLists, createProspectingList, deleteProspectingList,
  createCandidate, supabase,
} from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { getUserTier, hasFeature } from '../lib/tiers'
import UpgradePrompt from '../components/UpgradePrompt'
import LoadingBar from '../components/LoadingBar'

// ── Lean badge ────────────────────────────────────────────────────────────────
function LeanBadge({ lean, confidence }) {
  if (lean === 'conservative') return (
    <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-semibold bg-red-100 text-brand-red border border-red-200">
      <TrendingUp className="w-3 h-3" /> Conservative {confidence ? `${confidence}%` : ''}
    </span>
  )
  if (lean === 'liberal') return (
    <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-semibold bg-blue-100 text-blue-700 border border-blue-200">
      <TrendingDown className="w-3 h-3" /> Liberal {confidence ? `${confidence}%` : ''}
    </span>
  )
  return (
    <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-semibold bg-gray-100 text-gray-600 border border-gray-200">
      <HelpCircle className="w-3 h-3" /> Unknown
    </span>
  )
}

// ── Simple CSV parser (handles quoted fields) ─────────────────────────────────
function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim())
  if (lines.length < 2) return { headers: [], rows: [] }

  function parseLine(line) {
    const fields = []
    let cur = ''
    let inQuote = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (ch === '"') {
        if (inQuote && line[i + 1] === '"') { cur += '"'; i++ }
        else inQuote = !inQuote
      } else if (ch === ',' && !inQuote) {
        fields.push(cur.trim())
        cur = ''
      } else {
        cur += ch
      }
    }
    fields.push(cur.trim())
    return fields
  }

  const headers = parseLine(lines[0])
  const rows = lines.slice(1).map(line => {
    const vals = parseLine(line)
    const row = {}
    headers.forEach((h, i) => { row[h] = vals[i] || '' })
    return row
  })
  return { headers, rows }
}

// ── MultiSelect ───────────────────────────────────────────────────────────────
function MultiSelect({ label, options, selected, onChange, open, setOpen, labelFn = (o) => o }) {
  const optionsArray = Array.isArray(options) ? options : []
  const selectedArray = Array.isArray(selected) ? selected : []
  const displayLabel = selectedArray.length === 0 ? `All ${label}` : `${selectedArray.length} selected`

  return (
    <div className="relative">
      <label className="label text-xs">{label}</label>
      <button
        type="button"
        onClick={() => setOpen(open === label ? null : label)}
        className="input text-sm w-full text-left flex items-center justify-between cursor-pointer"
      >
        <span>{displayLabel}</span>
        <span className="text-xs">▼</span>
      </button>
      {open === label && (
        <div className="absolute top-full left-0 right-0 z-10 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg p-2 max-h-48 overflow-y-auto">
          {optionsArray.map((opt) => {
            const val = typeof opt === 'object' && opt.id ? opt.id : opt
            const display = typeof labelFn === 'function' ? labelFn(opt) : (typeof opt === 'object' ? opt.name : opt)
            const isSelected = selectedArray.includes(val)
            return (
              <label key={val} className="flex items-center gap-2 p-2 hover:bg-gray-50 rounded cursor-pointer text-sm">
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => {
                    if (isSelected) onChange(selectedArray.filter(s => s !== val))
                    else onChange([...selectedArray, val])
                  }}
                  className="w-4 h-4 accent-brand-red"
                />
                {display}
              </label>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Add to Candidates modal ───────────────────────────────────────────────────
function AddToCandidatesModal({ prospects, onClose, onSuccess }) {
  const [selected, setSelected] = useState(new Set(prospects.map((_, i) => i)))
  const [saving, setSaving] = useState(false)
  const [done, setDone] = useState(false)
  const [count, setCount] = useState(0)

  const toggle = (i) => setSelected(prev => {
    const next = new Set(prev)
    next.has(i) ? next.delete(i) : next.add(i)
    return next
  })

  const handleAdd = async () => {
    setSaving(true)
    let added = 0
    for (const i of selected) {
      const p = prospects[i]
      try {
        await createCandidate({
          name:   p.name || 'Unknown',
          email:  p.email  || null,
          phone:  p.phone  || null,
          party:  p.lean === 'conservative' ? 'Republican' : p.lean === 'liberal' ? 'Democrat' : null,
          status: 'exploring',
          notes:  p.reasoning ? `AI Classification: ${p.lean} (${p.confidence}% confidence). ${p.reasoning}` : null,
        })
        added++
      } catch (e) {
        console.error('Failed to add', p.name, e)
      }
    }
    setCount(added)
    setDone(true)
    setSaving(false)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between p-5 border-b border-gray-100 flex-shrink-0">
          <div className="flex items-center gap-2">
            <UserPlus className="w-5 h-5 text-brand-red" />
            <h2 className="text-lg font-bold text-gray-900">Add to Candidates</h2>
          </div>
          <button onClick={onClose}><X className="w-5 h-5 text-gray-400" /></button>
        </div>

        {done ? (
          <div className="p-8 text-center">
            <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-3">
              <Check className="w-8 h-8 text-green-600" />
            </div>
            <p className="text-lg font-bold text-gray-900 mb-1">{count} candidate{count !== 1 ? 's' : ''} added</p>
            <p className="text-sm text-gray-500 mb-4">They now appear in your Candidates section with "Exploring" status.</p>
            <button onClick={onSuccess} className="btn-primary">View Candidates →</button>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between px-5 py-2 bg-gray-50 border-b border-gray-100 flex-shrink-0">
              <p className="text-xs text-gray-500">{selected.size} of {prospects.length} selected</p>
              <div className="flex gap-3 text-xs text-brand-red font-medium">
                <button onClick={() => setSelected(new Set(prospects.map((_, i) => i)))}>All</button>
                <button onClick={() => setSelected(new Set())}>None</button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto divide-y divide-gray-100">
              {prospects.map((p, i) => (
                <label key={i} className={`flex items-center gap-3 px-5 py-3 cursor-pointer hover:bg-gray-50 ${selected.has(i) ? 'bg-brand-red/5' : ''}`}>
                  <input
                    type="checkbox"
                    checked={selected.has(i)}
                    onChange={() => toggle(i)}
                    className="w-4 h-4 accent-brand-red flex-shrink-0"
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-gray-900 truncate">{p.name}</p>
                    {p.email && <p className="text-xs text-gray-400 truncate">{p.email}</p>}
                  </div>
                  <LeanBadge lean={p.lean} confidence={p.confidence} />
                </label>
              ))}
            </div>

            <div className="p-4 border-t border-gray-100 flex-shrink-0">
              <button
                onClick={handleAdd}
                disabled={saving || selected.size === 0}
                className="btn-primary w-full flex items-center justify-center gap-2"
              >
                {saving ? (
                  <><span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> Adding...</>
                ) : (
                  <><UserPlus className="w-4 h-4" /> Add {selected.size} to Candidates</>
                )}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────
export default function Prospecting() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const [lists, setLists]           = useState([])
  const [selected, setSelected]     = useState(null)
  const [candidates, setCandidates] = useState([])
  const [offices, setOffices]       = useState([])
  const [elections, setElections]   = useState([])
  const [loading, setLoading]       = useState(false)
  const [generating, setGenerating] = useState(false)
  const [error, setError]           = useState('')
  const [showBuilder, setShowBuilder]     = useState(false)
  const [listTypeModal, setListTypeModal] = useState(false)
  const [builderMode, setBuilderMode]     = useState('ai')   // 'ai' | 'manual' | 'csv'
  const [copied, setCopied]               = useState(false)
  const [searchList, setSearchList]       = useState('')
  const [leanFilter, setLeanFilter]       = useState('all')  // 'all' | 'conservative' | 'liberal' | 'unknown'
  const [showAddModal, setShowAddModal]   = useState(false)

  // Manual list state
  const [manualSelected, setManualSelected]   = useState(new Set())
  const [manualSearch, setManualSearch]       = useState('')

  // CSV state
  const fileInputRef                = useRef(null)
  const [csvHeaders, setCsvHeaders] = useState([])
  const [csvRows, setCsvRows]       = useState([])
  const [csvProgress, setCsvProgress] = useState(null) // { done, total }
  const [csvFileName, setCsvFileName] = useState('')

  // Builder form state
  const [listName, setListName]         = useState('')
  const [listDesc, setListDesc]         = useState('')
  const [filterLevel, setFilterLevel]   = useState('')
  const [filterParties, setFilterParties]   = useState([])
  const [filterElections, setFilterElections] = useState([])
  const [filterStatuses, setFilterStatuses]   = useState(['declared'])
  const [includeContact, setIncludeContact]   = useState(true)
  const [customInstructions, setCustomInstructions] = useState('')
  const [openDropdown, setOpenDropdown]             = useState(null)

  const userTier = getUserTier(user)

  useEffect(() => { fetchData() }, [])

  const fetchData = async () => {
    const [{ data: l }, { data: c }, { data: o }, { data: e }] = await Promise.all([
      getProspectingLists(),
      getCandidates({}),
      getOffices(),
      getElections(),
    ])
    setLists(l || [])
    setCandidates(c || [])
    setOffices(o || [])
    setElections(e || [])
  }

  // ── AI list generation ──────────────────────────────────────────────────────
  const handleGenerate = async () => {
    if (!listName) return
    setGenerating(true)
    setError('')

    let filtered = candidates
    if (filterLevel) filtered = filtered.filter(c => c.office?.level === filterLevel)
    if (filterParties.length > 0) filtered = filtered.filter(c => filterParties.includes(c.party))
    if (filterElections.length > 0) filtered = filtered.filter(c => filterElections.includes(c.election_id))
    if (filterStatuses.length > 0) filtered = filtered.filter(c => filterStatuses.includes(c.status))

    try {
      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token
      const res = await fetch('/.netlify/functions/generate-prospecting', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          listName, listDesc,
          candidates: filtered,
          filters: { filterLevel, filterParties, filterElections, filterStatuses },
          includeContact, customInstructions,
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Generation failed')

      const { data } = await createProspectingList({
        name: listName, description: listDesc,
        filters: { filterLevel, filterParties, filterElections, filterStatuses },
        candidates: json.candidates,
        total_count: json.candidates?.length || filtered.length,
        notes: json.notes || '',
        created_by: user?.id,
      })
      await fetchData()
      setSelected(data)
      setShowBuilder(false)
      resetForm()
    } catch (err) {
      setError(err.message || 'Generation failed. Check your Anthropic API key in Settings.')
    }
    setGenerating(false)
  }

  // ── Manual list save ────────────────────────────────────────────────────────
  const handleSaveManualList = async () => {
    if (!listName) return
    setGenerating(true)
    setError('')
    try {
      const entries = candidates
        .filter(c => manualSelected.has(c.id))
        .map(c => ({
          name: c.name, party: c.party,
          office: c.office?.name, district: c.office?.district_name,
          status: c.status,
          email: includeContact ? c.email : undefined,
          phone: includeContact ? c.phone : undefined,
          website: includeContact ? c.website : undefined,
        }))

      const { data } = await createProspectingList({
        name: listName, description: listDesc || 'Manual list',
        filters: { type: 'manual' },
        candidates: entries, total_count: entries.length,
        notes: 'Manually assembled prospecting list',
        created_by: user?.id,
      })
      await fetchData()
      setSelected(data)
      setShowBuilder(false)
      resetForm()
    } catch (err) {
      setError(err.message || 'Failed to save list.')
    }
    setGenerating(false)
  }

  // ── CSV: file picked ────────────────────────────────────────────────────────
  const handleCsvFile = (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    setCsvFileName(file.name)
    const reader = new FileReader()
    reader.onload = (ev) => {
      const { headers, rows } = parseCSV(ev.target.result)
      setCsvHeaders(headers)
      setCsvRows(rows)
      setCsvProgress(null)
    }
    reader.readAsText(file)
    // Reset input so same file can be re-uploaded
    e.target.value = ''
  }

  // ── CSV: run AI classification ──────────────────────────────────────────────
  const handleClassifyAndSave = async () => {
    if (!listName || csvRows.length === 0) return
    setGenerating(true)
    setError('')
    setCsvProgress({ done: 0, total: csvRows.length })

    try {
      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token

      // Send ALL rows at once — the function batches internally (20/batch)
      const res = await fetch('/.netlify/functions/classify-csv-prospects', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ prospects: csvRows }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Classification failed')

      const results = json.results || []
      setCsvProgress({ done: results.length, total: results.length })

      const { data } = await createProspectingList({
        name: listName,
        description: listDesc || `CSV import — ${csvFileName}`,
        filters: { type: 'csv', source_file: csvFileName },
        candidates: results,
        total_count: results.length,
        notes: `AI-classified ${results.length} prospects from CSV. Conservative: ${results.filter(r => r.lean === 'conservative').length}, Liberal: ${results.filter(r => r.lean === 'liberal').length}, Unknown: ${results.filter(r => r.lean === 'unknown').length}.`,
        created_by: user?.id,
      })

      await fetchData()
      setSelected(data)
      setShowBuilder(false)
      resetForm()
    } catch (err) {
      setError(err.message || 'CSV classification failed.')
      setCsvProgress(null)
    }
    setGenerating(false)
  }

  const resetForm = () => {
    setListName(''); setListDesc(''); setFilterLevel('')
    setFilterParties([]); setFilterElections([])
    setFilterStatuses(['declared']); setIncludeContact(true)
    setCustomInstructions('')
    setManualSelected(new Set()); setManualSearch('')
    setCsvHeaders([]); setCsvRows([]); setCsvProgress(null); setCsvFileName('')
    setError('')
  }

  const openNewListModal = () => setListTypeModal(true)

  const filteredManualCandidates = manualSearch
    ? candidates.filter(c =>
        c.name?.toLowerCase().includes(manualSearch.toLowerCase()) ||
        c.office?.name?.toLowerCase().includes(manualSearch.toLowerCase())
      )
    : candidates

  const handleDelete = async (id) => {
    if (!window.confirm('Delete this prospecting list?')) return
    await deleteProspectingList(id)
    if (selected?.id === id) setSelected(null)
    fetchData()
  }

  const handleCopy = () => {
    if (!selected) return
    navigator.clipboard?.writeText(formatListAsText(selected))
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleDownload = () => {
    if (!selected) return
    const text = formatListAsText(selected)
    const blob = new Blob([text], { type: 'text/plain' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${selected.name.replace(/\s+/g, '_')}_${format(new Date(), 'yyyy-MM-dd')}.txt`
    a.click()
  }

  const formatListAsText = (list) => {
    const lines = [`PROSPECTING LIST: ${list.name}`, `Generated: ${format(new Date(list.created_at), 'MMMM d, yyyy')}`, '']
    if (list.description) lines.push(list.description, '')
    lines.push('='.repeat(60), '')
    const items = list.candidates || []
    items.forEach((c, i) => {
      lines.push(`${i + 1}. ${c.name || c.candidate_name || 'Unknown'}`)
      if (c.lean) lines.push(`   Political Lean: ${c.lean}${c.confidence ? ` (${c.confidence}% confidence)` : ''}`)
      if (c.party) lines.push(`   Party: ${c.party}`)
      if (c.office) lines.push(`   Office: ${c.office}`)
      if (c.district) lines.push(`   District: ${c.district}`)
      if (c.status) lines.push(`   Status: ${c.status}`)
      if (c.email) lines.push(`   Email: ${c.email}`)
      if (c.phone) lines.push(`   Phone: ${c.phone}`)
      if (c.website) lines.push(`   Website: ${c.website}`)
      if (c.reasoning) lines.push(`   AI Notes: ${c.reasoning}`)
      lines.push('')
    })
    return lines.join('\n')
  }

  const previewCount = (() => {
    let f = candidates
    if (filterLevel) f = f.filter(c => c.office?.level === filterLevel)
    if (filterParties.length > 0) f = f.filter(c => filterParties.includes(c.party))
    if (filterElections.length > 0) f = f.filter(c => filterElections.includes(c.election_id))
    if (filterStatuses.length > 0) f = f.filter(c => filterStatuses.includes(c.status))
    return f.length
  })()

  const filteredLists = searchList
    ? lists.filter(l => (l?.name || '').toLowerCase().includes(searchList.toLowerCase()))
    : lists

  const selectedCandidates = selected?.candidates || []
  const isCsvList = selected?.filters?.type === 'csv'

  // Filter prospecting list by lean
  const visibleCandidates = leanFilter === 'all'
    ? selectedCandidates
    : selectedCandidates.filter(c => c.lean === leanFilter)

  // Lean summary counts
  const leanCounts = {
    conservative: selectedCandidates.filter(c => c.lean === 'conservative').length,
    liberal:      selectedCandidates.filter(c => c.lean === 'liberal').length,
    unknown:      selectedCandidates.filter(c => !c.lean || c.lean === 'unknown').length,
  }

  // Feature gate
  if (!hasFeature(userTier, 'prospecting')) return (
    <div className="max-w-xl mx-auto pt-12">
      <UpgradePrompt
        feature="Outreach Prospecting"
        hook="Stop guessing who to target. Campaign plan generates AI-filtered candidate lists sorted by race competitiveness, party, office, and district — ready to export and act on."
        plan="Campaign"
        price="from $69/mo"
        benefits={[
          'AI-generated prospecting lists with custom filters',
          'Filter by party, office type, district, competitiveness',
          'CSV upload with AI political lean classification',
          'Export to CSV for outreach campaigns',
          'Unlimited Campaign Intel briefs',
        ]}
      />
    </div>
  )

  return (
    <div className="space-y-6">
      <LoadingBar loading={loading} />
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <ListChecks className="w-6 h-6 text-brand-red" /> Prospecting Lists
          </h1>
          <p className="text-gray-500 text-sm mt-1">AI-powered candidate prospecting for political marketing outreach</p>
        </div>
        <button onClick={openNewListModal} className="btn-primary flex items-center gap-2">
          <Plus className="w-4 h-4" /> New List
        </button>
      </div>

      <div className="grid lg:grid-cols-3 gap-6">
        {/* Left: saved lists */}
        <div className="space-y-4">
          <div className="card">
            <h2 className="text-sm font-bold text-gray-900 mb-3">Saved Lists ({lists.length})</h2>
            <div className="relative mb-3">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
              <input className="input pl-8 text-xs py-1.5" placeholder="Search lists..." value={searchList} onChange={e => setSearchList(e.target.value)} />
            </div>
            <div className="space-y-1.5 max-h-[60vh] overflow-y-auto">
              {filteredLists.length === 0 ? (
                <div className="text-center py-8">
                  <ListChecks className="w-8 h-8 text-gray-200 mx-auto mb-2" />
                  <p className="text-xs text-gray-400">No lists yet</p>
                  <button onClick={openNewListModal} className="text-xs text-brand-red font-medium mt-1 hover:underline">Build first list →</button>
                </div>
              ) : (
                filteredLists.map(l => (
                  <div
                    key={l.id}
                    onClick={() => { setSelected(l); setLeanFilter('all') }}
                    className={`group p-3 rounded-lg cursor-pointer transition-colors border ${selected?.id === l.id ? 'bg-brand-red/10 border-brand-red/30' : 'hover:bg-gray-50 border-transparent'}`}
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <p className={`text-xs font-semibold truncate ${selected?.id === l.id ? 'text-brand-red' : 'text-gray-800'}`}>{l.name}</p>
                          {l.filters?.type === 'csv' && (
                            <span className="text-xs px-1.5 py-0.5 rounded bg-purple-100 text-purple-700 font-medium flex-shrink-0">CSV</span>
                          )}
                        </div>
                        <p className="text-xs text-gray-400 mt-0.5">{l.total_count} entries · {format(new Date(l.created_at), 'MMM d, yyyy')}</p>
                        {l.description && <p className="text-xs text-gray-400 truncate mt-0.5 italic">{l.description}</p>}
                      </div>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDelete(l.id) }}
                        className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-red-50 text-gray-300 hover:text-brand-red transition-all ml-1"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        {/* Right: selected list detail */}
        <div className="lg:col-span-2">
          {!selected ? (
            <div className="card flex flex-col items-center justify-center py-24 text-center">
              <ListChecks className="w-16 h-16 text-gray-200 mb-4" />
              <p className="text-gray-500 font-semibold">No list selected</p>
              <p className="text-gray-400 text-sm mt-1">Build a new prospecting list or select one from the left</p>
              <button onClick={openNewListModal} className="btn-primary mt-6 flex items-center gap-2">
                <Plus className="w-4 h-4" /> New List
              </button>
            </div>
          ) : (
            <div className="card">
              <div className="flex items-start justify-between mb-4 pb-4 border-b border-gray-100">
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-xl font-bold text-gray-900">{selected.name}</h2>
                    {isCsvList && <span className="text-xs px-2 py-0.5 rounded-full bg-purple-100 text-purple-700 font-semibold border border-purple-200">CSV Import</span>}
                  </div>
                  {selected.description && <p className="text-sm text-gray-500 mt-1">{selected.description}</p>}
                  <div className="flex items-center gap-3 mt-2 text-xs text-gray-400">
                    <span><span className="font-semibold text-gray-700">{selectedCandidates.length}</span> entries</span>
                    <span>Created {format(new Date(selected.created_at), 'MMM d, yyyy')}</span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={handleCopy} className="btn-secondary text-xs flex items-center gap-1.5 py-1.5">
                    {copied ? <Check className="w-3.5 h-3.5 text-green-600" /> : <Copy className="w-3.5 h-3.5" />}
                    {copied ? 'Copied!' : 'Copy'}
                  </button>
                  <button onClick={handleDownload} className="btn-secondary text-xs flex items-center gap-1.5 py-1.5">
                    <Download className="w-3.5 h-3.5" /> Export
                  </button>
                </div>
              </div>

              {/* AI notes */}
              {selected.notes && (
                <div className="mb-4 p-3 bg-brand-red/5 border border-brand-red/20 rounded-lg">
                  <p className="text-xs font-semibold text-brand-red mb-1">AI Summary</p>
                  <p className="text-xs text-gray-600">{selected.notes}</p>
                </div>
              )}

              {/* Lean breakdown + filter (CSV lists only) */}
              {isCsvList && selectedCandidates.some(c => c.lean) && (
                <div className="mb-4 flex flex-wrap gap-2">
                  {[
                    { key: 'all',          label: `All (${selectedCandidates.length})`, cls: 'bg-gray-100 text-gray-700 border-gray-200' },
                    { key: 'conservative', label: `Conservative (${leanCounts.conservative})`, cls: 'bg-red-50 text-brand-red border-red-200' },
                    { key: 'liberal',      label: `Liberal (${leanCounts.liberal})`, cls: 'bg-blue-50 text-blue-700 border-blue-200' },
                    { key: 'unknown',      label: `Unknown (${leanCounts.unknown})`, cls: 'bg-gray-50 text-gray-500 border-gray-200' },
                  ].map(({ key, label, cls }) => (
                    <button
                      key={key}
                      onClick={() => setLeanFilter(key)}
                      className={`text-xs px-3 py-1 rounded-full border font-medium transition-all ${cls} ${leanFilter === key ? 'ring-2 ring-offset-1 ring-gray-400' : 'opacity-70 hover:opacity-100'}`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}

              {/* Candidate/prospect list */}
              <div className="space-y-3">
                {visibleCandidates.length === 0 ? (
                  <p className="text-sm text-gray-400 text-center py-8">No entries in this view</p>
                ) : (
                  visibleCandidates.map((c, i) => (
                    <div key={i} className="p-4 rounded-xl border border-gray-200 hover:border-brand-red/30 hover:bg-brand-red/5 transition-all">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-bold text-gray-900">{c.name || c.candidate_name}</span>
                            {c.lean && <LeanBadge lean={c.lean} confidence={c.confidence} />}
                            {c.party && !c.lean && (
                              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                                c.party === 'Republican' ? 'bg-red-100 text-brand-red' :
                                c.party === 'Democrat'   ? 'bg-blue-100 text-blue-700' :
                                'bg-gray-100 text-gray-600'
                              }`}>{c.party}</span>
                            )}
                            {c.status && <span className="text-xs text-gray-400 capitalize">{c.status?.replace('_', ' ')}</span>}
                          </div>
                          {c.office && <p className="text-sm text-gray-600 mt-0.5">{c.office}{c.district ? ` · ${c.district}` : ''}</p>}
                          {c.reasoning && <p className="text-xs text-gray-400 mt-1 italic">{c.reasoning}</p>}
                          {c.notes && !c.reasoning && <p className="text-xs text-gray-400 mt-1 italic">{c.notes}</p>}
                        </div>

                        {/* Contact actions */}
                        <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
                          {c.email && (
                            <a
                              href={`mailto:${c.email}`}
                              className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg bg-brand-navy/10 text-brand-navy hover:bg-brand-navy hover:text-white transition-all font-medium"
                              title={c.email}
                            >
                              <Mail className="w-3 h-3" /> Email
                            </a>
                          )}
                          {c.phone && <p className="text-xs text-gray-500">{c.phone}</p>}
                          {c.website && (
                            <a href={c.website} target="_blank" rel="noopener noreferrer" className="text-xs text-brand-red hover:underline">Website →</a>
                          )}
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>

              {/* Add to Candidates button (CSV lists only) */}
              {isCsvList && selectedCandidates.length > 0 && (
                <div className="mt-6 pt-4 border-t border-gray-100">
                  <button
                    onClick={() => setShowAddModal(true)}
                    className="w-full flex items-center justify-center gap-2 py-3 rounded-xl border-2 border-dashed border-brand-navy/30 text-brand-navy hover:border-brand-navy hover:bg-brand-navy/5 transition-all text-sm font-semibold"
                  >
                    <UserPlus className="w-4 h-4" />
                    Add Selected Prospects to Candidates
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* List Type Choice Modal */}
      {listTypeModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/50" onClick={() => setListTypeModal(false)} />
          <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-lg">
            <div className="flex items-center justify-between p-6 border-b border-gray-100">
              <div className="flex items-center gap-2">
                <Plus className="w-5 h-5 text-brand-red" />
                <h2 className="text-lg font-bold text-gray-900">Create New List</h2>
              </div>
              <button onClick={() => setListTypeModal(false)}><X className="w-5 h-5 text-gray-400" /></button>
            </div>
            <div className="p-6">
              <p className="text-sm text-gray-500 mb-6 text-center">How would you like to build this list?</p>
              <div className="grid grid-cols-3 gap-3">
                {/* Manual */}
                <button
                  onClick={() => { setListTypeModal(false); setBuilderMode('manual'); setShowBuilder(true) }}
                  className="flex flex-col items-center gap-3 p-5 rounded-xl border-2 border-gray-200 hover:border-brand-navy hover:bg-brand-navy/5 transition-all group"
                >
                  <div className="w-10 h-10 rounded-xl bg-gray-100 group-hover:bg-brand-navy/10 flex items-center justify-center transition-colors">
                    <PenLine className="w-5 h-5 text-gray-500 group-hover:text-brand-navy" />
                  </div>
                  <div className="text-center">
                    <p className="font-bold text-gray-900 group-hover:text-brand-navy text-sm">Manual</p>
                    <p className="text-xs text-gray-500 mt-0.5">Pick from your candidates</p>
                  </div>
                </button>

                {/* AI */}
                <button
                  onClick={() => { setListTypeModal(false); setBuilderMode('ai'); setShowBuilder(true) }}
                  className="flex flex-col items-center gap-3 p-5 rounded-xl border-2 border-gray-200 hover:border-brand-red hover:bg-brand-red/5 transition-all group"
                >
                  <div className="w-10 h-10 rounded-xl bg-gray-100 group-hover:bg-brand-red/10 flex items-center justify-center transition-colors">
                    <Bot className="w-5 h-5 text-gray-500 group-hover:text-brand-red" />
                  </div>
                  <div className="text-center">
                    <p className="font-bold text-gray-900 group-hover:text-brand-red text-sm">AI List</p>
                    <p className="text-xs text-gray-500 mt-0.5">Let Claude filter & rank</p>
                  </div>
                </button>

                {/* CSV Upload */}
                <button
                  onClick={() => { setListTypeModal(false); setBuilderMode('csv'); setShowBuilder(true) }}
                  className="flex flex-col items-center gap-3 p-5 rounded-xl border-2 border-gray-200 hover:border-purple-500 hover:bg-purple-50 transition-all group"
                >
                  <div className="w-10 h-10 rounded-xl bg-gray-100 group-hover:bg-purple-100 flex items-center justify-center transition-colors">
                    <Upload className="w-5 h-5 text-gray-500 group-hover:text-purple-600" />
                  </div>
                  <div className="text-center">
                    <p className="font-bold text-gray-900 group-hover:text-purple-600 text-sm">CSV Upload</p>
                    <p className="text-xs text-gray-500 mt-0.5">AI classifies each person</p>
                  </div>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Builder modal */}
      {showBuilder && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/50" onClick={() => { setShowBuilder(false); resetForm(); }} />
          <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-xl max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between p-6 border-b border-gray-100 flex-shrink-0">
              <div className="flex items-center gap-2">
                {builderMode === 'ai'     && <><Bot    className="w-5 h-5 text-brand-red"    /><h2 className="text-lg font-bold text-gray-900">AI Prospecting List</h2></>}
                {builderMode === 'manual' && <><PenLine className="w-5 h-5 text-brand-navy"  /><h2 className="text-lg font-bold text-gray-900">Manual Prospecting List</h2></>}
                {builderMode === 'csv'    && <><Upload  className="w-5 h-5 text-purple-600"  /><h2 className="text-lg font-bold text-gray-900">CSV Import &amp; Classify</h2></>}
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => { setShowBuilder(false); setListTypeModal(true) }} className="text-xs text-gray-400 hover:text-gray-600 font-medium">← Back</button>
                <button onClick={() => { setShowBuilder(false); resetForm() }}><X className="w-5 h-5 text-gray-400" /></button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-4">
              {error && (
                <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">
                  <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />{error}
                </div>
              )}

              <div>
                <label className="label">List Name *</label>
                <input className="input" value={listName} onChange={e => setListName(e.target.value)} placeholder="e.g. 2026 Assembly Targets — Southeast WI" required />
              </div>
              <div>
                <label className="label">Description</label>
                <input className="input" value={listDesc} onChange={e => setListDesc(e.target.value)} placeholder="Brief description of this list's purpose..." />
              </div>

              {/* ── CSV MODE ── */}
              {builderMode === 'csv' && (
                <div className="space-y-4">
                  <div className="p-4 bg-purple-50 rounded-xl border border-purple-200">
                    <p className="text-xs font-bold text-purple-700 uppercase tracking-wider mb-2">How it works</p>
                    <p className="text-xs text-purple-600 leading-relaxed">Upload any CSV file with names and optional fields (email, city, employer, etc.). Claude will classify each person as <strong>Conservative</strong>, <strong>Liberal</strong>, or <strong>Unknown</strong> based on a 70% confidence threshold. Results save as a prospecting list — no one is added to Candidates unless you choose to.</p>
                  </div>

                  {/* File drop zone */}
                  <div
                    onClick={() => fileInputRef.current?.click()}
                    className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-all ${
                      csvRows.length > 0 ? 'border-purple-400 bg-purple-50' : 'border-gray-200 hover:border-purple-300 hover:bg-purple-50/50'
                    }`}
                  >
                    <Upload className={`w-8 h-8 mx-auto mb-2 ${csvRows.length > 0 ? 'text-purple-500' : 'text-gray-300'}`} />
                    {csvRows.length > 0 ? (
                      <>
                        <p className="text-sm font-semibold text-purple-700">{csvFileName}</p>
                        <p className="text-xs text-purple-500 mt-1">{csvRows.length} rows · {csvHeaders.length} columns detected</p>
                        <p className="text-xs text-gray-400 mt-2">Click to replace</p>
                      </>
                    ) : (
                      <>
                        <p className="text-sm font-semibold text-gray-600">Click to upload CSV</p>
                        <p className="text-xs text-gray-400 mt-1">Accepts any .csv with a name column</p>
                      </>
                    )}
                    <input ref={fileInputRef} type="file" accept=".csv,text/csv" onChange={handleCsvFile} className="hidden" />
                  </div>

                  {/* Detected columns preview */}
                  {csvHeaders.length > 0 && (
                    <div className="p-3 bg-gray-50 rounded-lg">
                      <p className="text-xs font-semibold text-gray-600 mb-1.5">Detected columns:</p>
                      <div className="flex flex-wrap gap-1.5">
                        {csvHeaders.map(h => (
                          <span key={h} className="text-xs px-2 py-0.5 rounded bg-white border border-gray-200 text-gray-600">{h}</span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Progress bar during classification */}
                  {generating && csvProgress && (
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between text-xs text-gray-500">
                        <span>Classifying prospects...</span>
                        <span>{csvProgress.done} / {csvProgress.total}</span>
                      </div>
                      <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-purple-500 rounded-full transition-all duration-300"
                          style={{ width: `${Math.max(5, (csvProgress.done / Math.max(1, csvProgress.total)) * 100)}%` }}
                        />
                      </div>
                    </div>
                  )}

                  <button
                    onClick={handleClassifyAndSave}
                    disabled={!listName || generating || csvRows.length === 0}
                    className="w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-purple-600 hover:bg-purple-700 text-white font-semibold text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {generating ? (
                      <><span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> Classifying with Claude AI...</>
                    ) : (
                      <><Sparkles className="w-4 h-4" /> Classify {csvRows.length > 0 ? csvRows.length : ''} Prospects</>
                    )}
                  </button>
                </div>
              )}

              {/* ── MANUAL MODE ── */}
              {builderMode === 'manual' && (
                <>
                  <div className="p-4 bg-gray-50 rounded-xl space-y-3">
                    <div className="flex items-center justify-between">
                      <p className="text-xs font-bold text-gray-700 uppercase tracking-wider">Select Candidates</p>
                      <span className="text-xs text-gray-500 font-medium">{manualSelected.size} selected</span>
                    </div>
                    <div className="relative">
                      <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
                      <input
                        className="input pl-8 text-xs py-1.5"
                        placeholder="Search candidates or office..."
                        value={manualSearch}
                        onChange={e => setManualSearch(e.target.value)}
                      />
                    </div>
                    <div className="border border-gray-200 rounded-lg divide-y divide-gray-100 max-h-56 overflow-y-auto">
                      {filteredManualCandidates.length === 0 ? (
                        <p className="text-xs text-gray-400 text-center py-4 italic">No candidates found</p>
                      ) : (
                        filteredManualCandidates.map(c => (
                          <label
                            key={c.id}
                            className={`flex items-center gap-2.5 px-3 py-2 cursor-pointer hover:bg-gray-50 transition-colors ${manualSelected.has(c.id) ? 'bg-brand-navy/5' : ''}`}
                          >
                            <input
                              type="checkbox"
                              checked={manualSelected.has(c.id)}
                              onChange={() => {
                                setManualSelected(prev => {
                                  const next = new Set(prev)
                                  next.has(c.id) ? next.delete(c.id) : next.add(c.id)
                                  return next
                                })
                              }}
                              className="rounded border-gray-300"
                            />
                            <div className="flex-1 min-w-0">
                              <p className="text-xs font-semibold text-gray-800 truncate">{c.name}</p>
                              <p className="text-xs text-gray-400 truncate">{c.office?.name || 'No office'}{c.office?.district_name ? ` · ${c.office.district_name}` : ''}</p>
                            </div>
                            {c.party && <span className="text-xs text-gray-500 flex-shrink-0">{c.party}</span>}
                          </label>
                        ))
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-3 p-3 bg-blue-50 rounded-lg">
                    <input type="checkbox" id="include-contact-manual" checked={includeContact} onChange={e => setIncludeContact(e.target.checked)} className="w-4 h-4 accent-brand-red" />
                    <label htmlFor="include-contact-manual" className="text-sm text-gray-700 cursor-pointer">Include available contact info in export</label>
                  </div>

                  <button
                    onClick={handleSaveManualList}
                    disabled={!listName || generating || manualSelected.size === 0}
                    className="btn-primary w-full flex items-center justify-center gap-2"
                    style={{ backgroundColor: '#1e3a5f', borderColor: '#1e3a5f' }}
                  >
                    {generating ? (
                      <><span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> Saving...</>
                    ) : (
                      <><UserCheck className="w-4 h-4" /> Save Manual List ({manualSelected.size} selected)</>
                    )}
                  </button>
                </>
              )}

              {/* ── AI MODE ── */}
              {builderMode === 'ai' && (
                <>
                  <div className="p-4 bg-gray-50 rounded-xl space-y-3">
                    <p className="text-xs font-bold text-gray-700 uppercase tracking-wider">Filter Candidates</p>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="label text-xs">Office Level</label>
                        <select className="input text-sm" value={filterLevel} onChange={e => setFilterLevel(e.target.value)}>
                          <option value="">All Levels</option>
                          <option value="federal">Federal</option>
                          <option value="state">State</option>
                          <option value="county">County</option>
                          <option value="municipal">Municipal</option>
                        </select>
                      </div>
                      <div>
                        <MultiSelect label="Parties" options={['Republican','Democrat','Independent','Nonpartisan','Libertarian']} selected={filterParties} onChange={setFilterParties} open={openDropdown} setOpen={setOpenDropdown} />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <MultiSelect label="Elections" options={elections} selected={filterElections} onChange={setFilterElections} open={openDropdown} setOpen={setOpenDropdown} labelFn={(e) => e.name} />
                      </div>
                      <div>
                        <MultiSelect label="Status" options={['exploring','declared','primary_winner','general','elected']} selected={filterStatuses} onChange={setFilterStatuses} open={openDropdown} setOpen={setOpenDropdown} labelFn={(s) => s.replace('_', ' ')} />
                      </div>
                    </div>
                    <div className="pt-1">
                      <div className="flex items-center gap-2">
                        <Users className="w-4 h-4 text-brand-red" />
                        <span className="text-sm font-semibold text-gray-900">{previewCount} candidates match your filters</span>
                      </div>
                    </div>
                  </div>

                  <div>
                    <label className="label">Custom Instructions for AI</label>
                    <textarea
                      className="input"
                      rows={3}
                      value={customInstructions}
                      onChange={e => setCustomInstructions(e.target.value)}
                      placeholder="e.g. Focus on candidates who are first-time runners, prioritize competitive districts..."
                    />
                  </div>

                  <div className="flex items-center gap-3 p-3 bg-blue-50 rounded-lg">
                    <input type="checkbox" id="include-contact" checked={includeContact} onChange={e => setIncludeContact(e.target.checked)} className="w-4 h-4 accent-brand-red" />
                    <label htmlFor="include-contact" className="text-sm text-gray-700 cursor-pointer">Include all available contact information in the list</label>
                  </div>

                  <button
                    onClick={handleGenerate}
                    disabled={!listName || generating || previewCount === 0}
                    className="btn-primary w-full flex items-center justify-center gap-2"
                  >
                    {generating ? (
                      <><span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> Building with Claude AI...</>
                    ) : (
                      <><Sparkles className="w-4 h-4" /> Generate Prospect List ({previewCount} candidates)</>
                    )}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Add to Candidates modal */}
      {showAddModal && selected && (
        <AddToCandidatesModal
          prospects={selectedCandidates}
          onClose={() => setShowAddModal(false)}
          onSuccess={() => { setShowAddModal(false); navigate('/candidates') }}
        />
      )}
    </div>
  )
}
