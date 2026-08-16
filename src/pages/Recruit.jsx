// src/pages/Recruit.jsx — Recruit candidates from an uploaded voter list.
// Action-plan exclusive (tiers.js features.recruit).
//
// v1 is Tier A of RECRUIT-from-voterlist-gameplan.md: COLUMN-FIRST district
// matching. Pick a voter list → pick an office type (enumerated from the
// offices table, sub-state only) → pick the district from the values actually
// present in that list's own district column → confirm the residents → run the
// research pipeline.
//
// MAP-GEOMETRY INTEGRATION POINT (Tier B, DEFERRED): the gameplan's map-first
// walkthrough needs ward / county-supervisory / aldermanic polygons that do not
// exist in public/geodata yet. When they land, the district <select> in step 3
// becomes a map click: the map hands back the same { officeType, districtValue }
// pair this picker produces, and everything downstream is unchanged. Nothing
// else in this file assumes a list-driven picker.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { format } from 'date-fns'
import {
  UserPlus, Users, ListFilter, Search, Download, AlertTriangle, ChevronDown,
  ChevronRight, ExternalLink, RefreshCw, Check, MapPin, Info,
} from 'lucide-react'
import {
  getVoterLists, getOffices, supabase,
  getRecruitmentSearches, createRecruitmentSearch, updateRecruitmentSearch,
  getRecruitmentProspects, createRecruitmentProspects, getRecruitmentProgress,
} from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { getUserTier, hasFeature, getRecruitLookupLimit, RECRUIT_BATCH_CAP } from '../lib/tiers'
import {
  availableOfficeTypes, recruitOfficeType, districtColumnForOfficeType,
  districtOptionsFromVoters, matchVotersToDistrict, listSupportsOfficeType,
  isUnknownProspect, isRetryableProspect,
} from '../lib/recruit'
import UpgradePrompt from '../components/UpgradePrompt'
import { T, cardStyle, Btn, Pill, Spinner, EmptyNote, ProfilerShell } from './profiler/shared'

// Mirrors the stage constants in netlify/functions/recruit-research-background.js
const PHASE_LABELS = {
  1: 'Preparing the run…',
  2: 'Searching public sources…',
  3: 'Structuring findings…',
  4: 'Saving results…',
}
const POLL_MS = 3000
const HEARTBEAT_STALE_MS = 3 * 60 * 1000
const FIRST_BEAT_MS = 45 * 1000              // no progress row at all ⇒ never started
const MAX_WAIT_MS   = 15 * 60 * 1000         // Netlify's background budget

// ── Voter loading ────────────────────────────────────────────────────────────
// This used to be a single getVoters(listId, 5000) call. PostgREST orders by
// last_name, so on any list bigger than 5,000 rows Recruit matched seats
// against the alphabetical first 5,000 people ONLY — every resident from
// roughly the letter M on was invisible to the district picker and to the
// confirmed-resident list, with nothing on screen saying so. The list is now
// paged in full, the same way lib/supabase.getAllVoters() pages exports.
//
// The ceiling stays, because the whole list is held in browser memory and fed
// to the matchers on every keystroke — but it is now the same 50,000 rows
// VoterLists caps a single upload at (MAX_UPLOAD_ROWS), i.e. a complete list as
// this app can produce one, and hitting it renders an explicit warning that
// says how many rows were considered out of how many exist.
const VOTER_PAGE     = 1000                  // PostgREST's max_rows ceiling
const VOTER_LOAD_CAP = 50000

/**
 * Every voter in the list, paged, up to VOTER_LOAD_CAP.
 * `id` is the sort tiebreaker: last_name alone is not unique, and a non-total
 * order makes .range() pages overlap and silently drop rows.
 */
async function loadListVoters(listId, { onProgress, cancelled } = {}) {
  let all = []
  for (let offset = 0; offset < VOTER_LOAD_CAP; offset += VOTER_PAGE) {
    if (cancelled?.()) return { data: all, error: null, truncated: false }
    const size = Math.min(VOTER_PAGE, VOTER_LOAD_CAP - offset)
    const { data, error } = await supabase
      .from('voters')
      .select('*')
      .eq('voter_list_id', listId)
      .order('last_name')
      .order('id')
      .range(offset, offset + size - 1)
    if (error) return { data: all, error, truncated: false }
    if (!data?.length) return { data: all, error: null, truncated: false }
    all = all.concat(data)
    onProgress?.(all.length)
    if (data.length < size) return { data: all, error: null, truncated: false }
  }
  // Filled the cap exactly — there may be more rows we deliberately did not read.
  return { data: all, error: null, truncated: true }
}

const DISCLAIMER =
  'AI-assisted research from public sources. May be incomplete or inaccurate. Not a background check. ' +
  'Preliminary and for internal recruitment use only — not for publication.'

const ATTESTATION =
  'This list will be used for candidate recruitment, a permitted political use of this data.'

// ── Chips ────────────────────────────────────────────────────────────────────

const AFFILIATION_TINT = {
  republican:  { bg: '#FDECEC', c: '#A51C24' },
  democrat:    { bg: '#E8EEFB', c: '#1D4ED8' },
  independent: { bg: '#F1F1EF', c: T.ink4 },
  other:       { bg: '#F1F1EF', c: T.ink4 },
  unknown:     { bg: '#F5F5F4', c: T.faint },
}
const LEVEL_TINT = {
  high:     { bg: '#FDECEC', c: '#A51C24' },
  medium:   { bg: '#FDF6F0', c: '#B45309' },
  low:      { bg: '#F1F1EF', c: T.ink4 },
  positive: { bg: '#E8F5EC', c: '#15803D' },
  mixed:    { bg: '#FDF6F0', c: '#B45309' },
  negative: { bg: '#FDECEC', c: '#A51C24' },
  unknown:  { bg: '#F5F5F4', c: T.faint },
}
const STATUS_TINT = {
  pending:       { bg: '#F5F5F4', c: T.faint,   label: 'Pending' },
  researching:   { bg: '#FDF6F0', c: '#B45309', label: 'Researching' },
  done:          { bg: '#E8F5EC', c: '#15803D', label: 'Researched' },
  error:         { bg: '#FDECEC', c: '#A51C24', label: 'Failed' },
  skipped_quota: { bg: '#F1F1EF', c: T.ink4,    label: 'Quota reached' },
}

function Chip({ tint, children }) {
  const t = tint || LEVEL_TINT.unknown
  return <Pill c={t.c} bg={t.bg}>{children}</Pill>
}

function StepCard({ n, title, sub, children, done }) {
  return (
    <div style={{ ...cardStyle, padding: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: sub || children ? 12 : 0 }}>
        <span style={{
          width: 22, height: 22, borderRadius: 99, flexShrink: 0,
          background: done ? T.green : T.chip, color: done ? '#fff' : T.ink4,
          fontSize: 11, fontWeight: 800, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        }}>{done ? <Check style={{ width: 12, height: 12 }} /> : n}</span>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: T.ink }}>{title}</div>
          {sub && <div style={{ fontSize: 11, color: T.muted, marginTop: 2 }}>{sub}</div>}
        </div>
      </div>
      {children}
    </div>
  )
}

const selectStyle = {
  width: '100%', minHeight: 40, padding: '9px 12px', borderRadius: 10,
  border: `1px solid ${T.field}`, background: '#fff', color: T.ink,
  fontSize: 12, fontFamily: 'inherit',
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function Recruit() {
  const { user } = useAuth()
  const userTier = getUserTier(user)

  const [lists, setLists]         = useState([])
  const [listId, setListId]       = useState('')
  const [voters, setVoters]       = useState([])
  const [votersTruncated, setVotersTruncated] = useState(false)
  const [votersLoaded, setVotersLoaded]       = useState(0)   // paging progress
  const [loadingVoters, setLoadingVoters] = useState(false)
  const [offices, setOffices]     = useState([])
  // Distinguishes "offices haven't arrived yet" from "there genuinely are none".
  // Without it, `offices === []` during the initial fetch renders the step-2
  // empty state, which tells the user no offices are seeded when the query is
  // simply still in flight.
  const [officesLoaded, setOfficesLoaded] = useState(false)
  const [typeKey, setTypeKey]     = useState('')
  const [districtValue, setDistrictValue] = useState('')
  const [searches, setSearches]   = useState([])
  const [activeSearch, setActiveSearch] = useState(null)
  const [prospects, setProspects] = useState([])
  const [attested, setAttested]   = useState(false)
  const [busy, setBusy]           = useState(false)
  const [phase, setPhase]         = useState('')
  const [progress, setProgress]   = useState(null)
  const [error, setError]         = useState(null)
  const [schemaMissing, setSchemaMissing] = useState(false)
  const [sort, setSort]           = useState({ key: 'name', dir: 'asc' })
  const [excludeUnknowns, setExcludeUnknowns] = useState(false)
  const [expanded, setExpanded]   = useState(() => new Set())
  const pollGenRef = useRef(0)
  useEffect(() => () => { pollGenRef.current++ }, [])

  const monthlyLimit = getRecruitLookupLimit(userTier)

  // ── Load reference data ────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const [{ data: l }, { data: o }] = await Promise.all([getVoterLists(), getOffices()])
      if (cancelled) return
      setLists(l || [])
      setOffices(o || [])
      setOfficesLoaded(true)
      const { data: s, error: sErr } = await getRecruitmentSearches()
      if (cancelled) return
      // The tables ship with migration 20260812000011 — until it is applied the
      // page still renders, it just can't save a search.
      if (sErr && /relation .* does not exist|schema cache/i.test(sErr.message || '')) setSchemaMissing(true)
      else setSearches(s || [])
    })()
    return () => { cancelled = true }
  }, [])

  // ── Load the voters of the chosen list ─────────────────────────────────────
  useEffect(() => {
    if (!listId) { setVoters([]); setVotersTruncated(false); setVotersLoaded(0); return }
    let cancelled = false
    setLoadingVoters(true)
    setVotersTruncated(false)
    setVotersLoaded(0)
    ;(async () => {
      const { data, error: e, truncated } = await loadListVoters(listId, {
        cancelled: () => cancelled,
        onProgress: (n) => { if (!cancelled) setVotersLoaded(n) },
      })
      if (cancelled) return
      if (e) setError(e.message)
      setVoters(data || [])
      setVotersTruncated(Boolean(truncated))
      setLoadingVoters(false)
    })()
    return () => { cancelled = true }
  }, [listId])

  // ── Derived: office types, districts, matched residents ────────────────────
  const selectedList = useMemo(() => lists.find(l => l.id === listId) || null, [lists, listId])
  // The office-type menu is ENUMERATED FROM THE offices TABLE, never hard-coded:
  // availableOfficeTypes() classifies every seeded row and returns only the
  // types that actually matched something, with their seat counts. That is what
  // keeps Recruit from selling an office type with nothing behind it — the WI
  // seed carries no `Town of …` board seats, so "Town Board" simply never
  // appears in the menu (and would appear the moment such rows are seeded or
  // added through Offices/admin-offices). getOffices() pages through the whole
  // table in 1000-row batches, so the count is over every office, not a page.
  //
  // NOTE (known limitation, deliberately not changed here): the menu is scoped
  // to the offices table as a whole, not to the geography of the chosen voter
  // list. A type can therefore be offered when the seeded seats of that type
  // are in a different county than the list. That is not a silent empty — the
  // district step below already tells the user when their list lacks the column
  // the type needs, and the resident count is shown before anything is created.
  const officeTypes = useMemo(() => availableOfficeTypes(offices), [offices])
  const typeMeta    = useMemo(() => recruitOfficeType(typeKey), [typeKey])
  const districtOptions = useMemo(
    () => (typeKey ? districtOptionsFromVoters(voters, typeKey) : []),
    [voters, typeKey]
  )
  const columnPresent = useMemo(
    () => (typeKey ? listSupportsOfficeType(voters, typeKey) : true),
    [voters, typeKey]
  )
  const residents = useMemo(
    () => (typeKey && districtValue ? matchVotersToDistrict(voters, typeKey, districtValue) : []),
    [voters, typeKey, districtValue]
  )

  useEffect(() => { setDistrictValue('') }, [typeKey, listId])

  // ── Prospect + progress polling ────────────────────────────────────────────
  const loadProspects = useCallback(async (searchId) => {
    if (!searchId) return []
    const { data } = await getRecruitmentProspects(searchId)
    setProspects(data || [])
    return data || []
  }, [])

  // `runStartedAt` fences out the progress row left behind by an EARLIER run of
  // the same search — without it a second "Research" press would read the old
  // row's status:'done' and return before the new run had written anything.
  const watchRun = useCallback(async (searchId, alive, runStartedAt) => {
    let sawProgress = false
    const startedAt = runStartedAt || Date.now()
    for (;;) {
      await new Promise(r => setTimeout(r, POLL_MS))
      if (!alive()) return
      const { data: prog } = await getRecruitmentProgress(searchId)
      if (!alive()) return
      // A run that never writes a heartbeat never started (auth/deploy problem).
      if (!sawProgress && Date.now() - startedAt > FIRST_BEAT_MS) {
        throw new Error('The research run never started — check that you are still signed in, then try again.')
      }
      if (Date.now() - startedAt > MAX_WAIT_MS) {
        await loadProspects(searchId)
        throw new Error('This is taking longer than expected. The run is still going in the background — come back in a minute and press Refresh.')
      }
      const fromThisRun = prog && new Date(prog.updated_at).getTime() >= startedAt - 5000
      if (prog && fromThisRun) {
        setProgress(prog)
        const fresh = Date.now() - new Date(prog.updated_at).getTime() < HEARTBEAT_STALE_MS
        if (prog.status === 'error') { await loadProspects(searchId); throw new Error(prog.message || 'Research failed — try again.') }
        if (prog.status === 'done')  { await loadProspects(searchId); setPhase(''); return }
        if (fresh) { sawProgress = true; setPhase(PHASE_LABELS[prog.stage] || 'Researching…') }
        else if (sawProgress) { await loadProspects(searchId); throw new Error('The research run stopped unexpectedly — press Research again.') }
      }
      await loadProspects(searchId)
    }
  }, [loadProspects])

  // ── Create the search + its prospect rows ──────────────────────────────────
  const createSearch = async () => {
    if (!residents.length || !typeMeta) return
    setBusy(true); setError(null)
    try {
      const list = selectedList
      const name = `${typeMeta.label} — ${typeMeta.districtLabel} ${districtValue} (${format(new Date(), 'MMM yyyy')})`
      // ── `office_type` MEANS THREE DIFFERENT THINGS IN THIS SCHEMA ──────────
      // Nothing enforces that, and the columns share a name, so read every use
      // against its own table before assuming a value is portable:
      //
      //   recruitment_searches.office_type  ← WHAT IS WRITTEN HERE.
      //       A Recruit office-type KEY from lib/recruit.js RECRUIT_OFFICE_TYPES:
      //       'county_board' | 'city_council' | 'village_board' | 'town_board'
      //       | 'school_board'. A UI/matching bucket, not a DB enum.
      //
      //   offices.office_type
      //       The BRANCH of government: 'executive' | 'legislative' | 'judicial'
      //       | 'administrative' (admin-offices.js VALID_TYPES). Recruit never
      //       writes this — it reads offices.level + offices.name and classifies
      //       them itself (classifyOffice), because "county board" is a name
      //       pattern, not a branch.
      //
      //   election_contests.office_type
      //       A RESULTS-TIER bucket: 'statewide' | 'county' | … used to group
      //       and order the results board. Unrelated to both of the above.
      //
      // Never copy a value from one of these columns into another.
      const { data: search, error: sErr } = await createRecruitmentSearch({
        name,
        voter_list_id: listId,
        office_type: typeKey,   // Recruit type key — see the block above
        office_scope: {
          office_type: typeKey,   // same Recruit type key, denormalized for replay
          district_column: districtColumnForOfficeType(typeKey),
          district_value: districtValue,
          voter_list_name: list?.name || null,
          // Tier B would add: { match_method:'geocode_point_in_polygon', polygon_id }
        },
        district_level: typeMeta.scope,
        district_column: districtColumnForOfficeType(typeKey),
        district_value: districtValue,
        district_key: `${typeMeta.scope}:${districtValue}`,
        match_method: 'csv_column',
        total_matched: residents.length,
        status: 'ready',
      })
      if (sErr) throw sErr

      const rows = residents.map(v => ({
        search_id: search.id,
        voter_id: v.id,
        full_name: v.full_name || [v.first_name, v.last_name].filter(Boolean).join(' '),
        first_name: v.first_name || null,
        last_name: v.last_name || null,
        address: v.address || null,
        city: v.city || null,
        zip: v.zip || null,
        county: v.county || null,
        ward: v.ward || null,
        district_value: districtValue,
        research_status: 'pending',
        created_by: user?.id,
      }))
      for (let i = 0; i < rows.length; i += 200) {
        const { error: pErr } = await createRecruitmentProspects(rows.slice(i, i + 200))
        if (pErr) throw pErr
      }
      setActiveSearch(search)
      setSearches(prev => [search, ...prev])
      await loadProspects(search.id)
      setAttested(false)
    } catch (e) {
      setError(e.message || 'Could not create the recruitment search.')
    } finally { setBusy(false) }
  }

  // ── Run the background research pipeline ───────────────────────────────────
  const runResearch = async () => {
    if (!activeSearch) return
    setBusy(true); setError(null); setPhase(PHASE_LABELS[1]); setProgress(null)
    const gen = ++pollGenRef.current
    const alive = () => pollGenRef.current === gen
    const runStartedAt = Date.now()
    try {
      // Attestation is recorded BEFORE the run — the background function
      // refuses to research a search that isn't attested.
      if (!activeSearch.attested_use) {
        const { data: updated } = await updateRecruitmentSearch(activeSearch.id, {
          attested_use: true, attested_at: new Date().toISOString(), status: 'researching',
        })
        if (updated) setActiveSearch(updated)
      }
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch('/.netlify/functions/recruit-research-background', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ search_id: activeSearch.id }),
      })
      if (res.status !== 202 && !res.ok) throw new Error('Could not start prospect research — try again.')
      await watchRun(activeSearch.id, alive, runStartedAt)
    } catch (e) {
      if (alive()) { setError(e.message); setPhase('') }
    } finally {
      if (alive()) setBusy(false)
    }
  }

  // ── Results view: filter → sort → export ───────────────────────────────────
  const NOTORIETY_RANK = { high: 0, medium: 1, low: 2, unknown: 3 }
  const SENTIMENT_RANK = { positive: 0, mixed: 1, negative: 2, unknown: 3 }
  const STATUS_RANK    = { done: 0, researching: 1, pending: 2, skipped_quota: 3, error: 4 }

  const view = useMemo(() => {
    let rows = prospects.filter(p => !p.excluded)
    if (excludeUnknowns) rows = rows.filter(p => !isUnknownProspect(p))
    const dir = sort.dir === 'asc' ? 1 : -1
    const key = sort.key
    return [...rows].sort((a, b) => {
      let av, bv
      if (key === 'name')             { av = (a.full_name || '').toLowerCase(); bv = (b.full_name || '').toLowerCase() }
      else if (key === 'affiliation') { av = a.affiliation_value || 'unknown';  bv = b.affiliation_value || 'unknown' }
      else if (key === 'notoriety')   { av = NOTORIETY_RANK[a.notoriety] ?? 3;  bv = NOTORIETY_RANK[b.notoriety] ?? 3 }
      else if (key === 'sentiment')   { av = SENTIMENT_RANK[a.sentiment] ?? 3;  bv = SENTIMENT_RANK[b.sentiment] ?? 3 }
      else                            { av = STATUS_RANK[a.research_status] ?? 9; bv = STATUS_RANK[b.research_status] ?? 9 }
      if (av < bv) return -1 * dir
      if (av > bv) return 1 * dir
      return (a.full_name || '').localeCompare(b.full_name || '')
    })
  }, [prospects, excludeUnknowns, sort])

  const toggleSort = (key) =>
    setSort(s => ({ key, dir: s.key === key && s.dir === 'asc' ? 'desc' : 'asc' }))

  /** CSV of the CURRENT VIEW — all fields, evidence URLs semicolon-joined. */
  const exportCsv = () => {
    if (!view.length) return
    const cols = [
      'full_name', 'address', 'city', 'zip', 'county', 'ward', 'district_value',
      'affiliation_value', 'affiliation_confidence', 'affiliation_basis',
      'notoriety', 'sentiment', 'research_summary', 'research_status',
      'research_error', 'researched_at', 'model_version',
    ]
    const header = [...cols, 'evidence'].join(',')
    const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`
    const rows = view.map(p => [
      ...cols.map(c => cell(p[c])),
      cell((p.evidence || []).map(e => `${e.title || ''} <${e.url}>`).join('; ')),
    ].join(','))
    const blob = new Blob([[header, ...rows].join('\n')], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `recruit_prospects_${format(new Date(), 'yyyy-MM-dd')}.csv`
    a.click()
  }

  const openSearch = async (s) => {
    setActiveSearch(s)
    setPhase(''); setProgress(null); setError(null)
    await loadProspects(s.id)
  }

  // `pending` drives both the "still to research" line and whether the Research
  // button is enabled, so it has to use the same retryable set the background
  // function selects on — otherwise a search whose remaining rows are all
  // `skipped_quota` reads "0 still to research" and the button stays disabled,
  // stranding those people permanently even after the monthly allowance resets.
  const counts = useMemo(() => ({
    total:   prospects.length,
    done:    prospects.filter(p => p.research_status === 'done').length,
    pending: prospects.filter(p => !p.excluded && isRetryableProspect(p)).length,
    skipped: prospects.filter(p => p.research_status === 'skipped_quota').length,
  }), [prospects])

  // ── Feature gate (same shape as Prospecting.jsx) ───────────────────────────
  if (!hasFeature(userTier, 'recruit')) return (
    <div className="max-w-xl mx-auto pt-12">
      <UpgradePrompt
        feature="Recruit"
        hook="Your next county board or school board candidate is already on a voter list you own. Recruit finds them, matches them to the exact seat, and vets them against public records before you make the call."
        plan="Action"
        price="from $89/mo"
        benefits={[
          'Match residents to county board, council, town, village and school board seats',
          'AI research on affiliation, local notoriety and coverage sentiment',
          'Every finding cited with a public-source link — evidence, never verdicts',
          'Exclude unknowns, sort, and export the whole vetted list to CSV',
        ]}
      />
    </div>
  )

  return (
    <ProfilerShell>
      <div style={{ display: 'grid', gap: 14, maxWidth: 1180, margin: '0 auto' }}>

        {/* Disclaimer — same visual pattern as VoterLists' SimulatedDataBanner */}
        <div style={{
          display: 'flex', alignItems: 'flex-start', gap: 8,
          background: '#fef9c3', border: '1px solid #fde047', borderRadius: 10,
          padding: '9px 12px', fontSize: 11.5, color: '#854d0e',
        }}>
          <AlertTriangle style={{ width: 15, height: 15, flexShrink: 0, marginTop: 1 }} />
          <span><strong>Research disclaimer:</strong> {DISCLAIMER}</span>
        </div>

        {schemaMissing && (
          <div style={{ ...cardStyle, padding: 14, borderColor: '#fde047', background: '#FEFCE8', fontSize: 12, color: '#854d0e' }}>
            Recruit&apos;s tables aren&apos;t in this database yet — apply migration
            <code style={{ margin: '0 4px' }}>20260812000011_recruitment.sql</code>
            to save searches.
          </div>
        )}

        {error && (
          <div style={{ ...cardStyle, padding: '10px 14px', borderColor: '#FCA5A5', background: '#FEF2F2', color: '#991B1B', fontSize: 12, display: 'flex', justifyContent: 'space-between', gap: 12 }}>
            <span>{error}</span>
            <button onClick={() => setError(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#991B1B', fontWeight: 800 }}>✕</button>
          </div>
        )}

        {/* ── Step 1: voter list ─────────────────────────────────────────── */}
        <StepCard n={1} title="Pick a voter list" sub="Recruit matches seats off the district columns in your uploaded list." done={Boolean(listId)}>
          <select style={selectStyle} value={listId} onChange={e => setListId(e.target.value)}>
            <option value="">Select a list…</option>
            {lists.map(l => (
              <option key={l.id} value={l.id}>{l.name} · {l.total_count || 0} rows</option>
            ))}
          </select>
          {loadingVoters && (
            <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: T.muted }}>
              <Spinner size={13} /> Loading residents…{votersLoaded ? ` ${votersLoaded.toLocaleString()} so far` : ''}
            </div>
          )}
          {!loadingVoters && listId && !votersTruncated && (
            <div style={{ marginTop: 10, fontSize: 11, color: T.muted }}>
              {voters.length.toLocaleString()} residents loaded — the whole list.
            </div>
          )}
          {/* Truncation is never silent: it changes which people Recruit can
              find, so it gets a warning that states both numbers. */}
          {!loadingVoters && listId && votersTruncated && (
            <div style={{
              marginTop: 10, display: 'flex', alignItems: 'flex-start', gap: 8,
              background: '#FEF3C7', border: '1px solid #FCD34D', borderRadius: 10,
              padding: '9px 12px', fontSize: 11.5, color: '#92400E',
            }}>
              <AlertTriangle style={{ width: 15, height: 15, flexShrink: 0, marginTop: 1 }} />
              <span>
                <strong>Only part of this list was read.</strong> Recruit considered{' '}
                {voters.length.toLocaleString()} rows
                {selectedList?.total_count ? ` of the ${selectedList.total_count.toLocaleString()} in the list` : ''}
                {' '}(the per-page ceiling is {VOTER_LOAD_CAP.toLocaleString()}, in last-name order). Districts and
                residents below cover those rows only — split the file into smaller lists (for example one per
                municipality) to search the rest.
              </span>
            </div>
          )}
        </StepCard>

        {/* ── Step 2: office type ────────────────────────────────────────── */}
        {listId && (
          <StepCard
            n={2}
            title="Pick an office type"
            sub="Sub-state seats only — federal, statewide and state-legislative offices are excluded by construction."
            done={Boolean(typeKey)}
          >
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {officeTypes.map(t => {
                const on = t.key === typeKey
                return (
                  <button key={t.key} onClick={() => setTypeKey(on ? '' : t.key)} className="pf-btn"
                    style={{
                      border: `1px solid ${on ? T.red : T.border}`, background: on ? '#FDECEC' : '#fff',
                      color: on ? T.red : T.ink, borderRadius: 12, padding: '10px 14px', cursor: 'pointer',
                      fontFamily: 'inherit', textAlign: 'left', minHeight: 44,
                    }}>
                    <div style={{ fontSize: 12, fontWeight: 700 }}>{t.label}</div>
                    <div style={{ fontSize: 10.5, color: on ? T.red : T.faint, marginTop: 1 }}>
                      {t.officeCount.toLocaleString()} seats · matched on {t.districtLabel.toLowerCase()}
                    </div>
                  </button>
                )
              })}
              {/* Three distinct states, never conflated: still loading, loaded
                  but empty, and (the normal case) the buttons above. The empty
                  copy names the reason and the fix instead of leaving the step
                  blank. */}
              {!officesLoaded && <EmptyNote>Loading the office list…</EmptyNote>}
              {officesLoaded && !officeTypes.length && (
                <EmptyNote>
                  No offices on file for any Recruit-eligible type yet. Recruit only
                  offers types that have seeded seats behind them (county board, city
                  council, village board, town board, school board), so this list fills
                  in as county and municipal offices are added on the Offices page.
                </EmptyNote>
              )}
            </div>
          </StepCard>
        )}

        {/* ── Step 3: district ───────────────────────────────────────────── */}
        {listId && typeKey && (
          <StepCard
            n={3}
            title={`Pick the ${typeMeta.districtLabel.toLowerCase()}`}
            sub={`Values found in this list's ${districtColumnForOfficeType(typeKey)} column.`}
            done={Boolean(districtValue)}
          >
            {!columnPresent ? (
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', background: T.warmBg, border: `1px solid ${T.warmBr}`, borderRadius: 10, padding: '10px 12px', fontSize: 11.5, color: T.ink4 }}>
                <Info style={{ width: 14, height: 14, flexShrink: 0, marginTop: 1 }} />
                <span>
                  This list doesn&apos;t include a <strong>{typeMeta.districtLabel}</strong> column. Re-export from
                  Badger Voters with County Supervisory District / Aldermanic District / School District included, or
                  pick a different office type. (Drawing the seat on the map instead is a planned fast-follow.)
                </span>
              </div>
            ) : (
              <>
                <select style={selectStyle} value={districtValue} onChange={e => setDistrictValue(e.target.value)}>
                  <option value="">Select…</option>
                  {districtOptions.map(d => (
                    <option key={d.value} value={d.value}>{typeMeta.districtLabel} {d.value} · {d.count} residents</option>
                  ))}
                </select>
                <div style={{ marginTop: 8, fontSize: 10.5, color: T.faint, display: 'flex', alignItems: 'center', gap: 5 }}>
                  <MapPin style={{ width: 12, height: 12 }} />
                  Matched from the list&apos;s own column — no geocoding.
                </div>
              </>
            )}
          </StepCard>
        )}

        {/* ── Step 4: confirm residents ──────────────────────────────────── */}
        {/* typeMeta, not just districtValue: toggling the office type off clears
            typeKey immediately, but the effect that clears districtValue runs
            after the commit — so for one render districtValue is still set while
            recruitOfficeType('') is undefined, and typeMeta.districtLabel below
            throws. Both have to be present for this step to mean anything. */}
        {districtValue && typeMeta && (
          <StepCard
            n={4}
            title="Confirmed residents"
            sub={`${residents.length.toLocaleString()} people in ${typeMeta.districtLabel} ${districtValue}.`}
            done={Boolean(activeSearch)}
          >
            <div style={{ maxHeight: 220, overflowY: 'auto', border: `1px solid ${T.border}`, borderRadius: 10 }}>
              {residents.slice(0, 200).map(v => (
                <div key={v.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '7px 12px', borderBottom: `1px solid ${T.line}`, fontSize: 11.5 }}>
                  <span style={{ fontWeight: 600, color: T.ink }}>{v.full_name || [v.first_name, v.last_name].filter(Boolean).join(' ')}</span>
                  <span style={{ color: T.muted }}>{[v.address, v.city].filter(Boolean).join(', ')}</span>
                </div>
              ))}
              {!residents.length && <EmptyNote style={{ padding: 14 }}>No residents carry that district value.</EmptyNote>}
            </div>
            {residents.length > 200 && <div style={{ fontSize: 10.5, color: T.faint, marginTop: 6 }}>Showing the first 200 of {residents.length.toLocaleString()}.</div>}
            {votersTruncated && (
              <div style={{ fontSize: 10.5, color: '#92400E', marginTop: 6 }}>
                Matched against the {voters.length.toLocaleString()} rows Recruit read
                {selectedList?.total_count ? ` of ${selectedList.total_count.toLocaleString()} in the list` : ''} — see the warning in step 1.
              </div>
            )}
            <div style={{ marginTop: 12 }}>
              <Btn kind="primary" onClick={createSearch} disabled={busy || !residents.length || schemaMissing}>
                <UserPlus style={{ width: 13, height: 13 }} /> Create recruitment search
              </Btn>
            </div>
          </StepCard>
        )}

        {/* ── Step 5: research ───────────────────────────────────────────── */}
        {activeSearch && (
          <StepCard
            n={5}
            title="Research prospects"
            sub={`${counts.pending} of ${counts.total} still to research${counts.skipped ? ` (including ${counts.skipped} parked when the allowance ran out — eligible again)` : ''} · up to ${RECRUIT_BATCH_CAP} per run${monthlyLimit ? ` · ${monthlyLimit.toLocaleString()} lookups/month on your plan` : ''}.`}
            done={counts.total > 0 && counts.pending === 0}
          >
            <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 11.5, color: T.ink4, cursor: 'pointer' }}>
              <input type="checkbox" checked={attested || Boolean(activeSearch.attested_use)}
                disabled={Boolean(activeSearch.attested_use)}
                onChange={e => setAttested(e.target.checked)} style={{ marginTop: 2 }} />
              <span>{ATTESTATION}</span>
            </label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
              <Btn kind="primary" onClick={runResearch}
                disabled={busy || (!attested && !activeSearch.attested_use) || counts.pending === 0}>
                <Search style={{ width: 13, height: 13 }} /> Research prospects
              </Btn>
              {phase && (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 11.5, color: T.muted }}>
                  <Spinner size={13} /> {phase}
                  {progress?.total ? ` (${progress.processed}/${progress.total})` : ''}
                </span>
              )}
            </div>
            {progress?.total > 0 && (
              <div style={{ marginTop: 10, height: 5, borderRadius: 3, background: T.track, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${Math.min(100, Math.round((progress.processed / progress.total) * 100))}%`, background: T.red, borderRadius: 3, transition: 'width .3s ease' }} />
              </div>
            )}
          </StepCard>
        )}

        {/* ── Results ─────────────────────────────────────────────────────── */}
        {activeSearch && prospects.length > 0 && (
          <div style={{ ...cardStyle, padding: 0, overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '13px 16px', borderBottom: `1px solid ${T.divider}`, flexWrap: 'wrap' }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: T.ink, marginRight: 'auto' }}>
                {activeSearch.name}
                <span style={{ fontSize: 11, fontWeight: 500, color: T.muted, marginLeft: 8 }}>
                  {counts.done} researched · {view.length} shown
                </span>
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: T.ink4, cursor: 'pointer' }}>
                <input type="checkbox" checked={excludeUnknowns} onChange={e => setExcludeUnknowns(e.target.checked)} />
                <ListFilter style={{ width: 13, height: 13 }} /> Exclude unknowns
              </label>
              <Btn onClick={() => loadProspects(activeSearch.id)} tap={false}><RefreshCw style={{ width: 12, height: 12 }} /> Refresh</Btn>
              {/* exportCsv() bails on an empty view, so an always-enabled
                  button was a dead click. Disable it and say why in visible
                  text — a title= on a disabled button never renders. */}
              <Btn onClick={exportCsv} tap={false} disabled={view.length === 0}><Download style={{ width: 12, height: 12 }} /> Export CSV</Btn>
              {view.length === 0 && (
                <span style={{ flexBasis: '100%', textAlign: 'right', fontSize: 11, color: T.faint }}>
                  Nothing to export — the current filters hide every row.
                </span>
              )}
            </div>

            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
                <thead>
                  <tr style={{ background: T.hover }}>
                    {[
                      ['name', 'Name'], ['affiliation', 'Affiliation'], ['notoriety', 'Notoriety'],
                      ['sentiment', 'Sentiment'], ['status', 'Research'],
                    ].map(([k, label]) => (
                      <th key={k} onClick={() => toggleSort(k)}
                        style={{ textAlign: 'left', padding: '9px 14px', fontSize: 10.5, fontWeight: 700, color: T.muted, textTransform: 'uppercase', letterSpacing: '.4px', cursor: 'pointer', whiteSpace: 'nowrap', borderBottom: `1px solid ${T.divider}` }}>
                        {label}{sort.key === k ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}
                      </th>
                    ))}
                    <th style={{ textAlign: 'left', padding: '9px 14px', fontSize: 10.5, fontWeight: 700, color: T.muted, textTransform: 'uppercase', letterSpacing: '.4px', borderBottom: `1px solid ${T.divider}` }}>Evidence</th>
                  </tr>
                </thead>
                <tbody>
                  {view.map(p => {
                    const open = expanded.has(p.id)
                    const ev = p.evidence || []
                    return (
                      <React.Fragment key={p.id}>
                        <tr style={{ borderBottom: `1px solid ${T.line}` }}>
                          <td style={{ padding: '9px 14px' }}>
                            <div style={{ fontWeight: 600, color: T.ink }}>{p.full_name}</div>
                            <div style={{ fontSize: 10.5, color: T.faint }}>{[p.address, p.city].filter(Boolean).join(', ')}</div>
                          </td>
                          <td style={{ padding: '9px 14px' }}>
                            <Chip tint={AFFILIATION_TINT[p.affiliation_value] || AFFILIATION_TINT.unknown}>
                              {p.affiliation_value || 'unknown'}{p.affiliation_confidence ? ` ${p.affiliation_confidence}%` : ''}
                            </Chip>
                          </td>
                          <td style={{ padding: '9px 14px' }}><Chip tint={LEVEL_TINT[p.notoriety]}>{p.notoriety || 'unknown'}</Chip></td>
                          <td style={{ padding: '9px 14px' }}><Chip tint={LEVEL_TINT[p.sentiment]}>{p.sentiment || 'unknown'}</Chip></td>
                          <td style={{ padding: '9px 14px' }}>
                            <Chip tint={STATUS_TINT[p.research_status] || STATUS_TINT.pending}>
                              {(STATUS_TINT[p.research_status] || STATUS_TINT.pending).label}
                            </Chip>
                          </td>
                          <td style={{ padding: '9px 14px' }}>
                            {ev.length ? (
                              <button onClick={() => setExpanded(s => { const n = new Set(s); n.has(p.id) ? n.delete(p.id) : n.add(p.id); return n })}
                                style={{ background: 'none', border: 'none', cursor: 'pointer', color: T.ink4, fontSize: 11.5, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4, fontFamily: 'inherit' }}>
                                {open ? <ChevronDown style={{ width: 13, height: 13 }} /> : <ChevronRight style={{ width: 13, height: 13 }} />}
                                {ev.length} source{ev.length === 1 ? '' : 's'}
                              </button>
                            ) : <span style={{ color: T.faint }}>—</span>}
                          </td>
                        </tr>
                        {open && (
                          <tr style={{ borderBottom: `1px solid ${T.line}`, background: T.hover }}>
                            <td colSpan={6} style={{ padding: '10px 14px 12px 14px' }}>
                              {p.research_summary && <div style={{ fontSize: 11.5, color: T.ink3, marginBottom: 8 }}>{p.research_summary}</div>}
                              {p.affiliation_basis && <div style={{ fontSize: 11, color: T.muted, marginBottom: 8 }}>Affiliation basis: {p.affiliation_basis}</div>}
                              <div style={{ display: 'grid', gap: 5 }}>
                                {ev.map((e, i) => (
                                  <a key={i} href={e.url} target="_blank" rel="noopener noreferrer"
                                    style={{ fontSize: 11.5, color: T.ink, display: 'inline-flex', alignItems: 'center', gap: 5, textDecoration: 'underline', textUnderlineOffset: 2 }}>
                                    <ExternalLink style={{ width: 12, height: 12, flexShrink: 0 }} />{e.title || e.url}
                                  </a>
                                ))}
                              </div>
                              {p.research_error && <div style={{ fontSize: 11, color: '#991B1B', marginTop: 8 }}>{p.research_error}</div>}
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    )
                  })}
                </tbody>
              </table>
              {!view.length && <EmptyNote style={{ padding: 20 }}>Nothing matches the current filter.</EmptyNote>}
            </div>
          </div>
        )}

        {/* ── Earlier searches ────────────────────────────────────────────── */}
        {searches.length > 0 && (
          <div style={{ ...cardStyle, padding: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: T.ink, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 7 }}>
              <Users style={{ width: 14, height: 14 }} /> Your recruitment searches
            </div>
            <div style={{ display: 'grid', gap: 6 }}>
              {searches.map(s => (
                <div key={s.id} className="pf-row" onClick={() => openSearch(s)}
                  style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '9px 11px', borderRadius: 9, border: `1px solid ${s.id === activeSearch?.id ? T.field : T.border}`, fontSize: 11.5 }}>
                  <span style={{ fontWeight: 600, color: T.ink }}>{s.name}</span>
                  <span style={{ color: T.muted }}>
                    {s.total_matched || 0} matched · {s.research_completed_count || 0} researched · {s.status}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </ProfilerShell>
  )
}
