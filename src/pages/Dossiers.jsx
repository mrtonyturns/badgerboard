// src/pages/Dossiers.jsx — Profiler (SPEC-profiler.md).
//
// Two views on one route, each with the full canvas:
//   LIBRARY — v2.0 facelift: one action row (the quota as one quiet line,
//             Bulk generate where the plan has it, "New profile") · real
//             in-flight state · a shelf of short paper documents, one per
//             candidate (src/pages/profiler/ProfileTiles.jsx). The old generate
//             row, three stat boxes and profiles table are gone — the owner
//             found them hard to read; generating now lives in a dialog.
//   READER  — one quiet document (src/pages/profiler/ReportReader.jsx), with
//             a version switcher when the candidate has been profiled before.
//
// The old page split the canvas in two, stated the plan twice, and rendered 15
// section colour themes plus a badge on nearly every paragraph. Everything that
// reads or counts now lives in src/pages/profiler/reportModel.js so the reader,
// the table, the print document and the public share view can't disagree.

import { COMPARE_ENABLED } from '../lib/featureFlags'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams, createSearchParams, Link, useNavigate } from 'react-router-dom'
import { Search, Plus, FileText, Layers, ArrowLeft } from 'lucide-react'
import { format } from 'date-fns'

import {
  getCandidates, getDossiers, getDossier, deleteDossier, createCandidate,
  updateCandidate, supabase,
} from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import useFeature from '../lib/useFeature'
import { useDossierStatus } from '../contexts/DossierStatusContext'
import {
  getUserTier, getEffectiveProfileLimit, getBankedProfileCredits,
  hasFeature, isLiteProfileOnly,
} from '../lib/tiers'
import { useDialog } from '../lib/useDialog'
import LoadingBar from '../components/LoadingBar'
import SearchableSelect from '../components/SearchableSelect'
import DossierDisclaimerModal, { useDossierAck } from '../components/DossierDisclaimerModal'
import { UpgradeLink, WebOnlyCta } from '../components/UpgradeCta'
import { Tile, EmptyState, Button } from '../components/ui'

import {
  T, cardStyle, E5, ProfilerShell, Btn, relativeAge,
} from './profiler/shared'
import { DocTile, DocTileSkeleton, TileMenu } from './profiler/ProfileTiles'
import { groupProfiles, filterGroups, showSearch, quotaParts } from './profiler/library'
import ReportReader from './profiler/ReportReader'
import GenerationStrip from './profiler/GenerationStrip'
import ResearchNote from './profiler/ResearchNote'
import BulkModal from './profiler/BulkModal'
import ShareModal from './profiler/ShareModal'
import ClaimReviewer from './profiler/ClaimReviewer'
import {
  parseSections, buildReport, buildPrintHtml, sourcingStats, flagSummary,
  parseFlaggedClaims, verdictOf,
} from './profiler/reportModel'
import { rowToCandidatePatch } from './profiler/bulkCsv'
import { filterSections } from '../lib/profileContent'
import OnboardingStepHint from '../components/onboarding/OnboardingStepHint'

const PAGE_SIZE = 24   // tiles per page: divides evenly into 2, 3 and 4 columns
const PROGRESS_POLL_MS = 2500
const PROGRESS_STALE_MS = 15 * 60 * 1000
// generate-dossier-background has a 15-minute budget and a heavy run (7 research
// passes + Opus with web search + digest + diff) regularly outlives six minutes.
// The client used to stop watching at six, declare a timeout, and never look
// again — so a profile that landed at 6:30 stayed invisible until a hard reload.
const GENERATION_MAX_WAIT_MS = 15 * 60 * 1000
// Independent of any in-page run: catches profiles that finish while this tab is
// on another page, or after the watch above has given up.
const LIBRARY_WATCH_MS = 20 * 1000
const BULK_STAGGER_MS = 3000
const ANNOTATION_PREFIX = 'dossier_annotation_'

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const scrollPageTop = () => {
  const main = document.querySelector('main')
  if (main && main.scrollHeight > main.clientHeight) main.scrollTo({ top: 0 })
  else window.scrollTo({ top: 0 })
}

/** Escape user-written text before it is injected into the print document. */
const escapeForPrint = (s = '') => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')

const startOfThisMonth = () => {
  const d = new Date()
  d.setDate(1); d.setHours(0, 0, 0, 0)
  return d
}
const startOfNextMonth = () => {
  const d = startOfThisMonth()
  d.setMonth(d.getMonth() + 1)
  return d
}

// ─── Local annotations (unchanged storage contract) ─────────────────────────
function useAnnotations(dossierId) {
  const key = dossierId ? `${ANNOTATION_PREFIX}${dossierId}` : null
  const [annotations, setAnnotations] = useState({})

  useEffect(() => {
    if (!key) { setAnnotations({}); return }
    try { setAnnotations(JSON.parse(localStorage.getItem(key) || '{}')) } catch { setAnnotations({}) }
  }, [key])

  const save = useCallback((sectionId, text) => {
    setAnnotations(prev => {
      const next = { ...prev }
      if (text.trim()) next[sectionId] = { text: text.trim(), savedAt: new Date().toISOString() }
      else delete next[sectionId]
      if (key) { try { localStorage.setItem(key, JSON.stringify(next)) } catch { /* private mode */ } }
      return next
    })
  }, [key])

  return [annotations, save]
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function Dossiers() {
  const { user, isAdmin } = useAuth()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const initCandidateId = searchParams.get('candidate')
  const initSection     = searchParams.get('section')
  const initViewOpened  = useRef(false)
  // The query string as it was when the page MOUNTED. The ?view=/&section=
  // and ?newname=/&context= deep links are one-shot "arrive here" intents, so
  // they're read from this snapshot (useRef keeps its first value) rather than
  // the live params, which openDossier/rememberSection rewrite as you read.
  const mountParamsRef  = useRef(searchParams)

  const userTier  = getUserTier(user)
  const limit     = getEffectiveProfileLimit(user)
  const unlimited = limit === Infinity
  const canBulk   = hasFeature(userTier, 'bulkProfiler')
  const canShare   = useFeature('sharing')
  const canCompare = useFeature('compare')
  const isLite    = isLiteProfileOnly(userTier)
  const bankedCredits = getBankedProfileCredits(user)

  const {
    phase: dossierPhase, candidateId: pendingCandidateId, startedAt: generationStartedAt,
    startGeneration, setReady: setDossierReady, clearStatus: clearDossierStatus,
  } = useDossierStatus()

  const { ackState, markAcknowledged } = useDossierAck()
  const [showDisclaimerModal, setShowDisclaimerModal] = useState(false)
  const [pendingAction, setPendingAction] = useState(null)

  const requireAck = (fn) => {
    if (ackState === 'acknowledged') fn()
    else { setPendingAction(() => fn); setShowDisclaimerModal(true) }
  }
  const handleAcknowledged = (at) => {
    markAcknowledged(at)
    setShowDisclaimerModal(false)
    if (pendingAction) { pendingAction(); setPendingAction(null) }
  }

  // ── Data ──────────────────────────────────────────────────────────────────
  const [candidates, setCandidates] = useState([])
  const [dossiers, setDossiers]     = useState([])
  const [dossiersUsed, setUsed]     = useState(0)
  const [loading, setLoading]       = useState(true)
  const [error, setError]           = useState('')

  // ── View ──────────────────────────────────────────────────────────────────
  const [selected, setSelected]   = useState(null)
  const [query, setQuery]         = useState('')
  const [shown, setShown]         = useState(PAGE_SIZE)

  // ── Generate ──────────────────────────────────────────────────────────────
  const [candidateId, setCandidateId]         = useState(initCandidateId || '')
  const [researchContext, setResearchContext] = useState('')
  const [generating, setGenerating]           = useState(false)
  const [genCandidateId, setGenCandidateId]   = useState(null)
  const [progress, setProgress]               = useState(null)  // { stage, status }
  // A failed run has to stay on screen after `generating` flips off, otherwise
  // the honest failure state would vanish the moment we stopped polling.
  const [genFailure, setGenFailure]           = useState(null)  // { stage, candidateName }
  const genAbortRef = useRef(false)

  // ── Modals / panels ───────────────────────────────────────────────────────
  const [bulkOpen, setBulkOpen]       = useState(false)
  const [bulkRun, setBulkRun]         = useState(null)
  // The New profile dialog: 'pick' an existing candidate, or 'create' one.
  const [newOpen, setNewOpen]         = useState(false)
  const [newMode, setNewMode]         = useState('pick')
  const [newCandForm, setNewCandForm] = useState({ name: '', research_context: '' })
  const [creatingCand, setCreatingCand] = useState(false)
  const [modalError, setModalError]   = useState('')
  const [confirmDelete, setConfirmDelete] = useState(null)
  const [deleting, setDeleting]       = useState(false)
  const [showShare, setShowShare]     = useState(false)
  const [showReviewer, setShowReviewer] = useState(false)
  const [showNotes, setShowNotes]     = useState(false)
  const [showEmpty, setShowEmpty]     = useState(false)
  const [moreOpen, setMoreOpen]       = useState(false)

  const [annotations, saveAnnotation] = useAnnotations(selected?.id)

  const aliveRef = useRef(true)
  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false } }, [])

  // ── Team verdicts on flagged claims (dossiers.claim_verdicts) ─────────────
  // Optimistic: the reader updates the moment a verdict is picked, and the row
  // is put back exactly as it was if the write fails.
  const [verdicts, setVerdicts] = useState({})
  useEffect(() => {
    const stored = selected?.claim_verdicts
    setVerdicts(stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {})
  }, [selected?.id, selected?.claim_verdicts])

  const saveVerdict = useCallback(async (claimKey, verdict) => {
    const dossierId = selected?.id
    if (!dossierId || !claimKey) return
    // Functional update: no stale closure can ever drop an earlier verdict or
    // leave the UI showing the old state after a save.
    let previous, next
    setVerdicts(curr => {
      previous = curr
      next = { ...curr }
      if (verdict) next[claimKey] = { verdict, at: new Date().toISOString(), by: user?.id || null }
      else delete next[claimKey]
      return next
    })
    setError('')
    // .select().single() so an RLS zero-row match (a profile this account
    // doesn't own) fails loudly instead of pretending to save.
    const { data: echoed, error: upErr } = await supabase
      .from('dossiers').update({ claim_verdicts: next }).eq('id', dossierId)
      .select('claim_verdicts').single()
    if (!aliveRef.current) return
    if (upErr || !echoed) {
      setVerdicts(previous)
      setError(upErr
        ? 'That verdict could not be saved. The claim has been left as it was.'
        : 'That verdict could not be saved — verdicts can only be recorded on profiles your account owns.')
      return
    }
    // The server's copy is authoritative; sync every surface to it.
    const authoritative = echoed.claim_verdicts || {}
    setVerdicts(authoritative)
    setSelected(prev => (prev && prev.id === dossierId ? { ...prev, claim_verdicts: authoritative } : prev))
    setDossiers(prev => prev.map(d => (d.id === dossierId ? { ...d, claim_verdicts: authoritative } : d)))
     
  }, [selected?.id, user?.id])

  // Opens a profile in the reader and records it in the URL. Uses navigate()
  // rather than setSearchParams: in react-router 6.30 (BrowserRouter)
  // setSearchParams is re-created on every query-string change, and this very
  // function writes the query string — so depending on it would give
  // openDossier (and fetchData + the effects below) a new identity on every
  // open. navigate() only changes identity when the route pathname changes.
  // Everything else it touches is a ref, a state setter or a module function.
  const openDossier = useCallback(async (id, section = null) => {
    const { data } = await getDossier(id)
    if (!data || !aliveRef.current) return
    setSelected(data)
    setShowReviewer(false); setShowNotes(false); setMoreOpen(false); setShowEmpty(false)
    // Refresh-proof: the open profile (and section) live in the URL.
    navigate({ search: `?${createSearchParams(section ? { view: id, section } : { view: id })}` }, { replace: false })
    scrollPageTop()
    if (section) {
      const jump = () => {
        const el = document.getElementById(`pf-${section}`)
        // 'auto' on purpose — smooth programmatic scrolling no-ops on this container
        if (el) el.scrollIntoView({ behavior: 'auto', block: 'start' })
        return !!el
      }
      setTimeout(() => { if (!jump()) setTimeout(jump, 700) }, 400)
    }
  }, [navigate])

  // ── Fetch ─────────────────────────────────────────────────────────────────
  // Stamped on every successful library load; the completed-run watcher below
  // uses it as the "what have I not seen yet" cutoff.
  const lastFetchRef = useRef(Date.now())
  const fetchData = useCallback(async () => {
    const [{ data: c }, { data: d }, { data: monthly }] = await Promise.all([
      getCandidates({}),
      getDossiers(),
      // Only the user's own manual generations draw down the monthly allowance;
      // auto-refreshes have generated_by = null and are free (SPEC §1).
      user?.id
        ? supabase.from('dossiers').select('id')
            .gte('generated_at', startOfThisMonth().toISOString())
            .eq('generated_by', user.id).not('generated_by', 'is', null)
        : Promise.resolve({ data: [] }),
    ])
    if (!aliveRef.current) return
    lastFetchRef.current = Date.now()
    setCandidates(c || [])
    setDossiers(d || [])
    setUsed((monthly || []).length)
    setLoading(false)
    // Mount-time ?view= deep link (snapshot, not live params — see
    // mountParamsRef). Reading the live values here would make fetchData
    // change identity on every open/scroll and refetch the library each time.
    const initView = mountParamsRef.current.get('view')
    if (initView && d && !initViewOpened.current) {
      const found = d.find(x => x.id === initView)
      if (found) { initViewOpened.current = true; openDossier(initView, mountParamsRef.current.get('section')) }
    }
  }, [user?.id, openDossier])

  useEffect(() => { fetchData() }, [fetchData])

  // ── Completed-run watcher (bug fix) ───────────────────────────────────────
  // The library only ever refreshed from the in-page generation loop in
  // runGenerate(). If that loop wasn't running — the six-minute deadline had
  // passed, the user had navigated away and the component unmounted, or the run
  // was started from the candidate record — nothing refetched `dossiers`, so a
  // finished profile never appeared until a hard reload. generate-dossier-
  // background already stamps `dossier_generation_progress` with status='done'
  // after the row is saved (reportStage(candidate_id, 4, 'done')), and RLS
  // scopes that table to candidates this account owns, so one cheap polled
  // query is enough to notice any run of ours finishing, whoever started it.
  useEffect(() => {
    if (!user?.id) return
    let alive = true
    const check = async () => {
      if (!alive || document.visibilityState === 'hidden') return
      try {
        const { data } = await supabase
          .from('dossier_generation_progress')
          .select('candidate_id')
          .eq('status', 'done')
          .gt('updated_at', new Date(lastFetchRef.current - 5000).toISOString())
          .limit(1)
        if (alive && data?.length) fetchData()
      } catch { /* transient — the next tick retries */ }
    }
    const iv = setInterval(check, LIBRARY_WATCH_MS)
    return () => { alive = false; clearInterval(iv) }
  }, [user?.id, fetchData])

  // Coming back to the tab (or the page) re-reads the library — the cheapest
  // possible catch-all for a run that finished while you were elsewhere.
  useEffect(() => {
    // focus and visibilitychange both fire on a tab return — one refetch is enough.
    const onWake = () => {
      if (document.visibilityState !== 'visible') return
      if (Date.now() - lastFetchRef.current < 3000) return
      fetchData()
    }
    window.addEventListener('focus', onWake)
    document.addEventListener('visibilitychange', onWake)
    return () => {
      window.removeEventListener('focus', onWake)
      document.removeEventListener('visibilitychange', onWake)
    }
  }, [fetchData])

  // Deep link from the District Dashboard: /profiler?newname=…&context=…
  // Mount-once: reads the mount-time snapshot, so the dep list is honestly empty.
  useEffect(() => {
    const params = mountParamsRef.current
    const newName = params.get('newname')
    if (newName) {
      setNewCandForm({ name: newName, research_context: params.get('context') || '' })
      setNewMode('create')
      setNewOpen(true)
    }
  }, [])

  // Deep link from the weekly digest email: open that candidate's latest profile
  const deepLinkedRef = useRef(false)
  useEffect(() => {
    if (deepLinkedRef.current || !initCandidateId || !dossiers.length) return
    const latest = dossiers
      .filter(d => d.candidate_id === initCandidateId)
      .sort((a, b) => new Date(b.generated_at) - new Date(a.generated_at))[0]
    if (!latest) return
    deepLinkedRef.current = true
    openDossier(latest.id, initSection)
    // initSection is a real input. Once deepLinkedRef is set every re-run
    // returns at the guard, so openDossier rewriting ?section= can't loop.
  }, [dossiers, initCandidateId, initSection, openDossier])

  // …and /profiler?candidate=X for someone with NO profile yet (the candidate
  // record's "Generate profile") lands in the New profile dialog, preselected.
  const autoNewRef = useRef(false)
  useEffect(() => {
    if (autoNewRef.current || loading || !initCandidateId) return
    autoNewRef.current = true
    if (!dossiers.some(d => d.candidate_id === initCandidateId)) { setNewMode('pick'); setNewOpen(true) }
  }, [loading, initCandidateId, dossiers])

  // As the reader scrolls or the rail navigates, remember the section in the
  // URL (replace, so history isn't spammed) — refresh lands where you were.
  const rememberSection = useCallback((sectionId) => {
    if (!sectionId) return
    setSearchParams(prev => {
      const p = new URLSearchParams(prev)
      if (!p.get('view')) return prev
      p.set('section', sectionId)
      return p
    }, { replace: true })
  }, [setSearchParams])

  // ── Real generation progress (dossier_generation_progress) ────────────────
  // `candidates` is only read (for the failure banner's name) and is written by
  // fetchData(), which this very poll calls on 'done'. As a dep it would
  // restart the poll after every refetch — which re-reads the still-'done' row
  // and refetches again: a poll loop. It is read through a latest-value ref.
  // fetchData / clearDossierStatus are stable (per user id / context
  // useCallback), so listing them doesn't add re-runs.
  const candidatesRef = useRef(candidates)
  candidatesRef.current = candidates
  useEffect(() => {
    const cid = genCandidateId || (dossierPhase === 'generating' ? pendingCandidateId : null)
    if (!generating || !cid) { setProgress(null); return }
    let alive = true
    let iv = null
    const stop = () => { if (iv) { clearInterval(iv); iv = null } }

    const poll = async () => {
      try {
        const { data } = await supabase
          .from('dossier_generation_progress')
          .select('stage,status,updated_at')
          .eq('candidate_id', cid)
          .maybeSingle()
        if (!alive) return
        if (!data) { setProgress(null); return }         // no row yet → stage 1 loading
        const age = Date.now() - new Date(data.updated_at).getTime()
        // A row left behind by an earlier run tells us nothing about this one.
        if (!Number.isFinite(age) || age > PROGRESS_STALE_MS) { setProgress(null); return }
        setProgress({ stage: data.stage, status: data.status })
        if (data.status === 'done') { stop(); fetchData() }
        if (data.status === 'error') {
          stop()
          genAbortRef.current = true
          setGenFailure({
            stage: data.stage,
            candidateId: cid,
            candidateName: candidatesRef.current.find(c => c.id === cid)?.name || '',
          })
          setGenerating(false)
          setGenCandidateId(null)
          clearDossierStatus()
        }
      } catch { /* transient — the next tick retries */ }
    }

    poll()
    iv = setInterval(poll, PROGRESS_POLL_MS)
    return () => { alive = false; stop() }
  }, [generating, genCandidateId, dossierPhase, pendingCandidateId, fetchData, clearDossierStatus])

  // ── Resume after a refresh (belt-and-suspenders: a NEW dossier row) ───────
  // Keyed on phase + candidate. generationStartedAt is set in the same context
  // update as those two and is only read once, as this run's cutoff, so it is
  // read via a latest-value ref. The callbacks are all stable (fetchData per
  // user id, openDossier per route, the context's own useCallbacks) — none of
  // them change as a result of what this loop does, so it can't restart itself.
  const generationStartedAtRef = useRef(generationStartedAt)
  generationStartedAtRef.current = generationStartedAt
  const resumeRef = useRef(false)
  useEffect(() => {
    if (dossierPhase !== 'generating' || !pendingCandidateId || resumeRef.current) return
    resumeRef.current = true
    setGenerating(true)
    setGenCandidateId(pendingCandidateId)

    const MAX_WAIT = GENERATION_MAX_WAIT_MS
    const generationStartedAt = generationStartedAtRef.current
    const pollStart = generationStartedAt ? new Date(generationStartedAt).getTime() : Date.now()
    const deadline = pollStart + MAX_WAIT
    const startISO = generationStartedAt || new Date(pollStart - 1000).toISOString()
    let stopped = false

    ;(async () => {
      // LIST MODE (id / candidate_id / generated_at / generated_by /
      // weekly_digest + the candidate join). These watchers only ever ask
      // "has a new row landed?" — they never read `content` — but they used
      // the default `*` selector, so every 5s tick re-downloaded the full
      // multi-KB report body of every profile for this candidate for up to
      // fifteen minutes. The body is fetched exactly once, by openDossier()
      // below, when the finished profile is actually opened.
      const findNew = (list) => (list || []).find(d => (d.generated_at || d.created_at || '') > startISO)
      const { data: immediate } = await getDossiers(pendingCandidateId, { list: true })
      const already = findNew(immediate)
      if (already && !stopped) {
        await fetchData(); await openDossier(already.id)
        setDossierReady({ id: already.id, candidateName: already.candidate?.name || '' })
        setGenerating(false); setGenCandidateId(null)
        return
      }
      while (!stopped && Date.now() < deadline) {
        await sleep(5000)
        const { data: current } = await getDossiers(pendingCandidateId, { list: true })
        const fresh = findNew(current)
        if (fresh) {
          await fetchData(); await openDossier(fresh.id)
          setDossierReady({ id: fresh.id, candidateName: fresh.candidate?.name || '' })
          setGenerating(false); setGenCandidateId(null)
          return
        }
      }
      if (!stopped) { clearDossierStatus(); setGenerating(false); setGenCandidateId(null) }
    })()

    return () => { stopped = true; resumeRef.current = false }
  }, [dossierPhase, pendingCandidateId, fetchData, openDossier, setDossierReady, clearDossierStatus])

  // Pre-fill research context from the candidate record
  useEffect(() => {
    const cand = candidates.find(c => c.id === candidateId)
    setResearchContext(cand?.research_context || '')
  }, [candidateId, candidates])

  const getToken = async () => {
    const { data: { session } } = await supabase.auth.getSession()
    return session?.access_token || ''
  }

  // ── Generate ──────────────────────────────────────────────────────────────
  const runGenerate = async (cid, candidateOverride = null) => {
    const candidate = candidateOverride || candidates.find(c => c.id === cid)
    if (!candidate) { setError('That candidate could not be found.'); return }
    setGenerating(true); setGenCandidateId(cid); setProgress(null)
    setGenFailure(null); setError('')
    genAbortRef.current = false
    startGeneration(candidate.name, cid)

    try {
      const token = await getToken()
      // List mode: the before/after diff is on ids alone — see the note on the
      // resume watcher above. Pulling `content` here (and again on every 5s
      // tick below) moved megabytes for a set-difference on UUIDs.
      const { data: before } = await getDossiers(cid, { list: true })
      const beforeIds = new Set((before || []).map(d => d.id))

      const payload = researchContext?.trim()
        ? { ...candidate, research_context: researchContext.trim() }
        : candidate

      // The synchronous trigger validates auth and the monthly limit and returns
      // a real error; a direct background POST always answers 202.
      const res = await fetch('/.netlify/functions/generate-dossier', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ candidate: payload, candidate_id: cid }),
      })
      if (!res.ok && res.status !== 202) {
        let msg = 'Could not start this profile.'
        try { const j = await res.json(); msg = j.error || msg } catch { /* no body */ }
        throw new Error(msg)
      }

      // Belt-and-suspenders alongside the progress poll: the new dossier row
      // appearing is the only thing that proves the report actually landed.
      const deadline = Date.now() + GENERATION_MAX_WAIT_MS
      let fresh = null
      while (aliveRef.current && !genAbortRef.current && Date.now() < deadline) {
        await sleep(5000)
        const { data: current } = await getDossiers(cid, { list: true })
        fresh = (current || []).find(d => !beforeIds.has(d.id))
        if (fresh) break
      }
      if (!aliveRef.current || genAbortRef.current) return
      // Giving up watching is not the same as failing: the run keeps going on the
      // server and the completed-run watcher above will pull it into the library.
      if (!fresh) throw new Error('This profile is taking longer than usual. It is still running on the server — it will appear here on its own as soon as it saves.')

      await fetchData()
      await openDossier(fresh.id)
      setDossierReady({ id: fresh.id, candidateName: candidate.name })
    } catch (err) {
      setError(err.message || 'Something went wrong generating this profile.')
      clearDossierStatus()
    }
    if (aliveRef.current) { setGenerating(false); setGenCandidateId(null) }
  }

  const handleGenerate = () => {
    if (!candidateId || generating) return
    requireAck(() => runGenerate(candidateId))
  }

  const handleRegenerate = () => {
    if (!selected?.candidate_id) return
    requireAck(() => runGenerate(selected.candidate_id))
  }

  const handleCreateAndRun = async () => {
    if (!newCandForm.name.trim()) return
    setCreatingCand(true); setModalError('')
    try {
      const { data: created, error: candErr } = await createCandidate({
        name: newCandForm.name.trim(),
        research_context: newCandForm.research_context.trim() || null,
        status: 'exploring',
      })
      if (candErr) throw new Error(candErr.message)
      const { data: full } = await supabase
        .from('candidates')
        .select('*, office:offices(id, name, level, office_type, district_name, district_number, county)')
        .eq('id', created.id).single()
      await fetchData()
      setNewOpen(false)
      setNewCandForm({ name: '', research_context: '' })
      setCandidateId(created.id)
      requireAck(() => runGenerate(created.id, full || created))
    } catch (err) {
      setModalError(err.message || 'Could not create this candidate.')
    }
    setCreatingCand(false)
  }

  // ── Bulk ──────────────────────────────────────────────────────────────────
  const runBulk = async (rows) => {
    setBulkRun({ rows: rows.map(r => ({ name: r.name, status: 'queued' })), done: false })
    const mark = (i, patch) => setBulkRun(prev => prev && ({
      ...prev, rows: prev.rows.map((r, ri) => (ri === i ? { ...r, ...patch } : r)),
    }))

    const createdByName = new Map()
    for (let i = 0; i < rows.length; i++) {
      if (!aliveRef.current) return
      const row = rows[i]
      const key = row.name.trim().toLowerCase()
      try {
        let candidate = candidates.find(c => (c.name || '').trim().toLowerCase() === key)
          || createdByName.get(key)
        if (!candidate) {
          const { data: created, error: cErr } = await createCandidate(rowToCandidatePatch(row))
          if (cErr) throw new Error(cErr.message)
          candidate = created
          createdByName.set(key, created)
        }
        const patch = rowToCandidatePatch(row)
        const payload = {
          ...candidate,
          research_context: patch.research_context || candidate.research_context || null,
        }
        const token = await getToken()
        const res = await fetch('/.netlify/functions/generate-dossier', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ candidate: payload, candidate_id: candidate.id }),
        })
        if (!res.ok && res.status !== 202) {
          let msg = 'Could not start'
          try { const j = await res.json(); msg = j.error || msg } catch { /* no body */ }
          throw new Error(msg)
        }
        mark(i, { status: 'started' })
      } catch (err) {
        mark(i, { status: 'error', error: err.message || 'Could not start' })
      }
      if (i < rows.length - 1) await sleep(BULK_STAGGER_MS)
    }
    setBulkRun(prev => prev && ({ ...prev, done: true }))
    await fetchData()
  }

  const handleDelete = async () => {
    if (!confirmDelete) return
    setDeleting(true)
    await deleteDossier(confirmDelete)
    if (selected?.id === confirmDelete) setSelected(null)
    setConfirmDelete(null); setDeleting(false)
    fetchData()
  }

  const resolveStatus = async (status) => {
    if (!selected?.candidate_id) throw new Error('This profile is not linked to a candidate record.')
    const { error: upErr } = await updateCandidate(selected.candidate_id, { status })
    if (upErr) throw new Error(upErr.message)
    await fetchData()
  }

  // Options come from the share dialog's PDF step (SPEC-share-dialog §4). A bare
  // call — ReportReader's own Export button passes a click event — keeps the
  // defaults: checklist on, disclaimer on, team notes OFF.
  const handleExportPdf = (opts) => {
    if (!selected) return
    const o = {
      checklist:  opts?.checklist  !== false,
      disclaimer: opts?.disclaimer !== false,
      notes:      opts?.notes === true,
    }
    const { sections } = filterSections(parseSections(selected.content || ''), showEmpty)
    // The printed copy carries the team's verdicts too — a claim the team has
    // settled must not print as unverified.
    const report = buildReport(selected.content || '', sections, verdicts)
    // Section 14 IS the verification checklist; turning the option off drops
    // that section and nothing else.
    const printReport = o.checklist
      ? report
      : { ...report, sections: (report.sections || []).filter(s => s.id !== 'section-14') }
    let html = buildPrintHtml(selected, printReport)

    if (!o.disclaimer) {
      // The only thing this removes is the standing footer line; the AI-research
      // markers inside the document stay exactly where they are.
      html = html.replace(/\s*<div class="footer">[\s\S]*?<\/div>\s*(?=<\/body>)/, '\n')
    }

    // Team notes are internal and never travel by default. The candidate-level
    // AI-access lock is authoritative: locked notes cannot be exported at all.
    if (o.notes && !notesLocked) {
      const labelFor = (id) =>
        (printReport.sections || []).find(s => s.id === id)?.label
        || (id === 'overview' ? 'Overview' : id.replace(/^section-/, 'Section '))
      const entries = Object.entries(annotations)
        .filter(([, n]) => n?.text?.trim())
        .sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))
      if (entries.length) {
        const rows = entries.map(([id, n]) => `
          <div class="note">
            <div class="note-h">${escapeForPrint(labelFor(id))}</div>
            <div class="note-t">${escapeForPrint(n.text)}</div>
          </div>`).join('')
        html = html.replace('</body>', `
  <section class="sec">
    <div class="sec-h"><span class="title">Internal team notes</span>
      <span class="grp">NOT PART OF THE PROFILE</span></div>
    <div class="p">Written by your team inside Badger Board. Not AI-generated, not
    published with any shared link, and not for distribution outside your organization.</div>
    <style>.note{margin:0 0 10px}.note-h{font-family:Arial,sans-serif;font-size:9pt;font-weight:700}
    .note-t{font-size:10.5pt;color:#27272A;white-space:pre-wrap}</style>
    ${rows}
  </section>
</body>`)
      }
    }

    const win = window.open('', '_blank')
    if (!win) { setError('Allow pop-ups to export a PDF.'); return }
    win.document.write(html)
    win.document.close()
    setTimeout(() => { win.focus(); win.print() }, 700)
  }

  // ── Derived ───────────────────────────────────────────────────────────────
  const candidateById = useMemo(() => {
    const m = new Map()
    for (const c of candidates) m.set(c.id, c)
    return m
  }, [candidates])

  // ── What the share dialog needs about the open profile ────────────────────
  // The AI-access lock lives on the candidate row; the PDF step disables the
  // team-notes option outright when it is engaged.
  const openProfileCandidate = selected
    ? (candidateById.get(selected.candidate_id) || selected.candidate || null)
    : null
  const notesLocked = openProfileCandidate?.ai_access_notes === false

  // Claims still waiting on a source — the same rule flagSummary uses, so the
  // PDF step's checklist line can't disagree with the reader.
  const openClaimCount = useMemo(() => {
    if (!selected) return 0
    return parseFlaggedClaims(selected.content || '').filter(c => {
      const v = verdictOf(verdicts, c.key)
      return !v || v.verdict === 'unsure'
    }).length
  }, [selected, verdicts])

  const rows = useMemo(() => dossiers.map(d => {
    const cand = candidateById.get(d.candidate_id) || d.candidate || {}
    const content = d.content || ''
    const src = sourcingStats(content)
    // Claims the team has ruled valid or false stop counting as "to verify".
    const flags = flagSummary(content, d.claim_verdicts)
    const ageDays = d.generated_at
      ? Math.floor((Date.now() - new Date(d.generated_at).getTime()) / 86400000) : null
    return {
      id: d.id,
      candidateId: d.candidate_id || null,
      generatedAt: d.generated_at || d.created_at || null,
      name: d.candidate?.name || cand.name || 'Unknown candidate',
      party: d.candidate?.party || cand.party || '',
      office: cand.office?.name || d.candidate?.office?.name || '',
      district: cand.office?.district_name || d.candidate?.office?.district_name || '',
      monitored: cand.section_timestamps?.monitoring === true,
      isNew: ageDays != null && ageDays < 7,
      date: d.generated_at ? format(new Date(d.generated_at), 'MMM d, yyyy') : '—',
      age: relativeAge(d.generated_at),
      good: src.strong, weak: src.weak, hasRatio: src.ratio != null,
      flags,
    }
  }), [dossiers, candidateById])

  // One paper tile per candidate: the newest profile, older versions behind it.
  const groups = useMemo(() => groupProfiles(rows), [rows])
  const filtered = useMemo(() => filterGroups(groups, query), [groups, query])
  const searchable = showSearch(groups.length)

  const left = unlimited ? Infinity : Math.max(0, limit - dossiersUsed)
  const pctUsed = unlimited || !limit ? 0 : dossiersUsed / limit
  // Low balance: the quota line turns amber and offers a credit pack.
  const runningLow = !unlimited && (left < 5 || pctUsed >= 0.85)
  const resetLabel = `resets ${format(startOfNextMonth(), 'MMM d')}`
  const balance = { unlimited, left, limit, resetLabel }
  const quota = quotaParts({ unlimited, left, limit, resetLabel, used: dossiersUsed, banked: bankedCredits })
  const outOfProfiles = !unlimited && left === 0

  const selectedCandidate = candidates.find(c => c.id === candidateId)
  const flaggedCount = selected ? parseFlaggedClaims(selected.content || '').length : 0
  const researchNote = selected?.research_note && typeof selected.research_note === 'object'
    ? selected.research_note : null

  // Every version of the open profile's candidate, newest first — the reader's
  // version switcher (older versions stay one click away inside the reader).
  const selectedVersions = useMemo(() => {
    if (!selected) return []
    const g = groups.find(x => x.versions.some(v => v.id === selected.id))
    return g ? g.versions : []
  }, [groups, selected])

  const openNewProfile = (cid = null) => {
    if (cid) setCandidateId(cid)
    setNewMode('pick'); setModalError(''); setNewOpen(true)
  }
  // ── Reader ────────────────────────────────────────────────────────────────
  if (selected) {
    return (
      <ProfilerShell>
        <LoadingBar loading={generating} />
        {showDisclaimerModal && (
          <DossierDisclaimerModal
            onAcknowledged={handleAcknowledged}
            onClose={() => { setShowDisclaimerModal(false); setPendingAction(null) }}
          />
        )}

        <ReportReader
          dossier={selected}
          content={selected.content || ''}
          showEmpty={showEmpty}
          onToggleEmpty={() => setShowEmpty(v => !v)}
          onExportPdf={handleExportPdf}
          annotations={annotations}
          onSaveAnnotation={saveAnnotation}
          showAnnotations={showNotes}
          verdicts={verdicts}
          onVerdict={saveVerdict}
          onSectionChange={rememberSection}
          headerExtra={selectedVersions.length > 1 ? (
            <VersionSwitcher
              versions={selectedVersions}
              currentId={selected.id}
              onPick={id => { if (id !== selected.id) openDossier(id) }}
            />
          ) : null}
          back={(
            <button
              type="button"
              onClick={() => { setSelected(null); setSearchParams({}, { replace: false }); scrollPageTop() }}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6, background: 'none',
                border: 0, padding: '0 0 16px', cursor: 'pointer', fontFamily: 'inherit',
                fontSize: 13.5, fontWeight: 600, color: T.muted,
              }}
            ><ArrowLeft style={{ width: 16, height: 16 }} aria-hidden="true" />All profiles</button>
          )}
          actions={(
            <>
              {isAdmin && (
                <Link
                  to={`/broadside?dossier=${selected.id}`}
                  title="Spar against this profile in Broadside"
                  style={{
                    background: '#fff', border: '1px solid rgba(17,22,28,.1)', borderRadius: 12,
                    padding: '10px 14px', fontSize: 13, fontWeight: 700, color: T.ink,
                    textDecoration: 'none', display: 'inline-flex', alignItems: 'center', minHeight: 40,
                  }}
                >Spar</Link>
              )}
              {COMPARE_ENABLED && canCompare && <Btn onClick={() => navigate('/compare')} tap={false} style={{ minHeight: 40 }}>Compare</Btn>}
              {canShare && <Btn onClick={() => setShowShare(true)} tap={false} style={{ minHeight: 40 }}>Share</Btn>}
              <div style={{ position: 'relative' }}>
                <Btn onClick={() => setMoreOpen(v => !v)} tap={false} style={{ minHeight: 40 }}>More</Btn>
                {moreOpen && (
                  <>
                    <div onClick={() => setMoreOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
                    <div style={{
                      position: 'absolute', right: 0, top: 'calc(100% + 6px)', zIndex: 41, width: 232,
                      ...cardStyle, borderRadius: 14, padding: 6, boxShadow: E5,
                    }}>
                      <MoreItem onClick={() => { setShowReviewer(true); setMoreOpen(false) }}>
                        Review flagged claims{flaggedCount ? ` (${flaggedCount})` : ''}
                      </MoreItem>
                      <MoreItem onClick={() => { setShowNotes(v => !v); setMoreOpen(false) }}>
                        {showNotes ? 'Hide section notes' : 'Add section notes'}
                      </MoreItem>
                      <MoreItem onClick={() => {
                        navigator.clipboard?.writeText(selected.content || '')
                        setMoreOpen(false)
                      }}>Copy report text</MoreItem>
                      {selected.candidate_id && (
                        <MoreItem onClick={() => navigate(`/candidates/${selected.candidate_id}`)}>
                          Open candidate record
                        </MoreItem>
                      )}
                      <MoreItem danger onClick={() => { setConfirmDelete(selected.id); setMoreOpen(false) }}>
                        Delete this profile
                      </MoreItem>
                    </div>
                  </>
                )}
              </div>
              <Btn kind="primary" onClick={handleRegenerate} disabled={generating} tap={false} style={{ minHeight: 40 }}>
                {generating ? 'Regenerating…' : 'Regenerate'}
              </Btn>
            </>
          )}
          researchNote={(
            <ResearchNote dossier={selected} note={researchNote} onResolveStatus={resolveStatus} />
          )}
          beforeDoc={(
            <>
              {error && <Banner tone="error" onDismiss={() => setError('')}>{error}</Banner>}
              {(generating || genFailure) && (
                <GenerationStrip
                  candidateName={selected.candidate?.name}
                  startedAt={generationStartedAt}
                  stage={genFailure?.stage || progress?.stage || 1}
                  status={genFailure ? 'error' : (progress?.status || 'running')}
                  onCancel={() => {
                    genAbortRef.current = true
                    setGenerating(false); setGenCandidateId(null); setGenFailure(null); clearDossierStatus()
                  }}
                  onRetry={genFailure ? () => { setGenFailure(null); handleRegenerate() } : null}
                />
              )}
              {selected.weekly_digest?.summary && (
                <div style={{ ...cardStyle, padding: '14px 18px', marginBottom: 16 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '1px', color: T.faint, marginBottom: 5 }}>
                    THIS WEEK'S MONITORING UPDATE
                  </div>
                  <div style={{ fontSize: 13, lineHeight: 1.6, color: T.ink3, maxWidth: '88ch' }}>
                    {selected.weekly_digest.summary}
                  </div>
                </div>
              )}
            </>
          )}
          afterDoc={isLite ? (
            <div style={{
              background: T.warmBg, border: `1px solid ${T.warmBr}`, borderRadius: 12,
              padding: '14px 18px', margin: '8px 0 0',
            }}>
              <div style={{ fontSize: 12.5, fontWeight: 700, marginBottom: 4 }}>
                This is the Scout lite profile
              </div>
              <div style={{ fontSize: 12, color: T.ink4, lineHeight: 1.55, maxWidth: '74ch' }}>
                Scout includes Biography, Political Record and the first two Affiliations. The other
                eleven sections are written but not stored on this plan.{' '}
                <UpgradeLink style={{ color: T.red, fontWeight: 600 }}>Compare plans</UpgradeLink>
              </div>
            </div>
          ) : null}
        />

        {showShare && (
          <ShareModal
            dossier={selected}
            candidate={openProfileCandidate}
            openClaimCount={openClaimCount}
            noteCount={Object.keys(annotations).length}
            onClose={() => setShowShare(false)}
            onExportPdf={handleExportPdf}
          />
        )}
        {showReviewer && <ClaimReviewer dossier={selected} onClose={() => setShowReviewer(false)} />}
        {confirmDelete && (
          <ConfirmDelete
            deleting={deleting}
            onCancel={() => setConfirmDelete(null)}
            onConfirm={handleDelete}
          />
        )}
      </ProfilerShell>
    )
  }

  // ── Library ───────────────────────────────────────────────────────────────
  // A shelf of short paper documents, one per candidate. Layout.jsx already
  // renders the page's one <h1> ("Profiler") and the Intelligence pill strip,
  // so this view starts at its own action row: what you have, what you have
  // left, and the one primary action.
  const shelfEmpty = !loading && groups.length === 0
  return (
    <ProfilerShell>
      <LoadingBar loading={generating} />
      {showDisclaimerModal && (
        <DossierDisclaimerModal
          onAcknowledged={handleAcknowledged}
          onClose={() => { setShowDisclaimerModal(false); setPendingAction(null) }}
        />
      )}

      <div className="pf-head" style={{ display: 'flex', alignItems: 'flex-end', gap: 16, marginBottom: 18, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <h2 className="display" style={{ fontSize: 22, lineHeight: 1.15, margin: 0 }}>
            Your profiles{groups.length > 0 && <span style={{ color: T.faint, fontWeight: 700 }}> · {groups.length}</span>}
          </h2>
          {/* The plan, stated once, as one quiet line. */}
          <div style={{ fontSize: 13.5, color: runningLow ? T.amber : T.muted, marginTop: 5, lineHeight: 1.5 }}>
            {quota.join(' · ')}
            {!unlimited && (
              // Hidden in the native app — store rules don't allow an in-app
              // link into an external purchase flow.
              <WebOnlyCta>
                {' · '}
                <Link to="/plans" style={{ color: T.red, fontWeight: 700, textDecoration: 'none' }}>
                  {outOfProfiles ? 'Buy a credit pack' : 'Add more'}
                </Link>
              </WebOnlyCta>
            )}
          </div>
        </div>
        <div className="pf-headright" style={{ flex: 'none', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {canBulk ? (
            <Button variant="secondary" icon={Layers} onClick={() => setBulkOpen(true)}>Bulk generate</Button>
          ) : null}
          {/* An empty shelf carries its own New profile button — one is enough. */}
          {!shelfEmpty && (
            <Button
              icon={Plus}
              onClick={() => openNewProfile()}
              disabled={generating}
              title={generating ? 'A profile is being written — one at a time' : undefined}
            >New profile</Button>
          )}
        </div>
      </div>

      {searchable && (
        // Only once the shelf is long enough to need it (more than ~8 tiles).
        <div style={{ position: 'relative', display: 'flex', maxWidth: 420, marginBottom: 18 }}>
          <Search
            aria-hidden="true"
            style={{
              position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)',
              width: 16, height: 16, color: T.faint, pointerEvents: 'none',
            }}
          />
          <input
            className="pf-input"
            value={query}
            onChange={e => { setQuery(e.target.value); setShown(PAGE_SIZE) }}
            placeholder="Search by name or office"
            aria-label="Search profiles"
            style={{
              flex: 1, minWidth: 0, boxSizing: 'border-box', border: '1px solid rgba(17,22,28,.12)',
              borderRadius: 12, padding: '11px 15px 11px 40px', fontSize: 14, fontFamily: 'inherit',
              color: T.ink, minHeight: 44, background: '#fff',
            }}
          />
        </div>
      )}

      {ackState === 'pending' && (
        <Banner tone="warm" action={<Btn kind="warm" onClick={() => setShowDisclaimerModal(true)}>Acknowledge</Btn>}>
          <strong style={{ fontWeight: 700 }}>Research use disclaimer required.</strong>{' '}
          You need to acknowledge it before generating or opening profiles.{' '}
          <a href="/dossier-disclaimer" target="_blank" rel="noopener noreferrer"
            style={{ color: T.amber, textDecoration: 'underline' }}>Read it</a>
        </Banner>
      )}

      {error && <Banner tone="error" onDismiss={() => setError('')}>{error}</Banner>}

      {/* ── In-flight ────────────────────────────────────────────────────── */}
      {(generating || genFailure) && (
        <GenerationStrip
          candidateName={genFailure
            ? genFailure.candidateName
            : candidates.find(c => c.id === (genCandidateId || pendingCandidateId))?.name || ''}
          startedAt={generationStartedAt}
          stage={genFailure?.stage || progress?.stage || 1}
          status={genFailure ? 'error' : (progress?.status || 'running')}
          onCancel={() => {
            genAbortRef.current = true
            setGenerating(false); setGenCandidateId(null); setGenFailure(null); clearDossierStatus()
          }}
          onRetry={genFailure ? () => {
            const cid = genFailure.candidateId || genCandidateId || candidateId
            setGenFailure(null)
            if (cid) requireAck(() => runGenerate(cid))
          } : null}
        />
      )}

      {/* ── The shelf ────────────────────────────────────────────────────── */}
      {shelfEmpty ? (
        <Tile className="p-6 md:p-8">
          <EmptyState
            icon={FileText}
            color="ink"
            title="No profiles yet"
            body="A profile is a 14-section research report on one candidate: who they are, their record, their money, and what still needs checking. Each one takes 5–8 minutes to write."
            action={<Button icon={Plus} onClick={() => openNewProfile()}>New profile</Button>}
          />
          <OnboardingStepHint stepId="profile" to="/" />
        </Tile>
      ) : (
        <>
          <div className="grid gap-5 [grid-template-columns:repeat(auto-fill,minmax(216px,1fr))] max-[520px]:grid-cols-2 max-[520px]:gap-3">
            {loading
              ? [0, 1, 2, 3].map(i => <DocTileSkeleton key={i} />)
              : filtered.slice(0, shown).map(g => (
                  <DocTile
                    key={g.key}
                    group={g}
                    onOpen={id => openDossier(id)}
                    menu={(
                      <TileMenu
                        group={g}
                        onOpen={id => openDossier(id)}
                        onCandidate={cid => navigate(`/candidates/${cid}`)}
                        onNewVersion={g.latest.candidateId && !generating ? () => openNewProfile(g.latest.candidateId) : null}
                      />
                    )}
                  />
                ))}
          </div>

          {!loading && query && filtered.length === 0 && (
            <div style={{ fontSize: 13.5, color: T.muted, padding: '18px 2px' }}>
              No profiles match “{query.trim()}”. Search looks at candidate names and offices.
            </div>
          )}
          {!loading && shown < filtered.length && (
            <div style={{ display: 'flex', justifyContent: 'center', marginTop: 20 }}>
              <Button variant="secondary" onClick={() => setShown(s => s + PAGE_SIZE)}>
                Show {Math.min(PAGE_SIZE, filtered.length - shown)} more
              </Button>
            </div>
          )}
        </>
      )}

      {/* ── Modals ───────────────────────────────────────────────────────── */}
      <BulkModal
        open={bulkOpen}
        onClose={() => { setBulkOpen(false); if (bulkRun?.done) setBulkRun(null) }}
        balance={balance}
        runState={bulkRun}
        onRun={rows => requireAck(() => runBulk(rows))}
      />

      {newOpen && (
        <Modal
          title={newMode === 'create' ? 'Profile someone new' : 'New profile'}
          onClose={() => setNewOpen(false)}
          maxWidth={520}
        >
          <div style={{ fontSize: 13, color: T.muted, lineHeight: 1.55, marginBottom: 18 }}>
            14 sections · 5–8 minutes. Claude confirms who they are, Grok and Perplexity search the
            web, news and filings, then Claude reads the primary sources and writes the report.
          </div>

          {newMode === 'pick' ? (
            <>
              <FieldLabel>Candidate</FieldLabel>
              <SearchableSelect
                value={candidateId}
                onChange={setCandidateId}
                options={(Array.isArray(candidates) ? candidates : []).map(c => ({
                  value: c.id,
                  label: `${c.name}${c.party ? ` (${c.party})` : ''} — ${c.office?.name || 'No office'}`,
                }))}
                placeholder="Choose a candidate"
                searchPlaceholder="Search candidates"
              />
              <button
                type="button"
                onClick={() => { setNewMode('create'); setModalError('') }}
                style={{
                  background: 'none', border: 0, padding: '8px 0 0', cursor: 'pointer', fontFamily: 'inherit',
                  fontSize: 13, fontWeight: 600, color: T.red,
                }}
              >Not on your list? Add someone new</button>

              <FieldLabel htmlFor="pf-context" hint="optional · recommended for pre-announcement candidates" style={{ marginTop: 16 }}>
                Research context
              </FieldLabel>
              <textarea
                id="pf-context"
                rows={2}
                className="pf-input"
                value={researchContext}
                onChange={e => setResearchContext(e.target.value)}
                maxLength={1000}
                placeholder="City, employer, profession — anything that disambiguates this person"
                style={fieldStyle}
              />
              {selectedCandidate && !selectedCandidate.research_context && !researchContext.trim() && (
                <div style={{ fontSize: 12.5, color: T.muted, marginTop: 8, lineHeight: 1.5 }}>
                  {selectedCandidate.name} has no saved research context. Adding one materially improves
                  the odds of profiling the right person.
                </div>
              )}
            </>
          ) : (
            <>
              <FieldLabel htmlFor="pf-newname">Full name</FieldLabel>
              <input
                id="pf-newname"
                autoFocus
                className="pf-input"
                value={newCandForm.name}
                onChange={e => setNewCandForm(p => ({ ...p, name: e.target.value }))}
                placeholder="First Last"
                style={{ ...fieldStyle, minHeight: 44 }}
              />
              <FieldLabel htmlFor="pf-newctx" hint="recommended" style={{ marginTop: 16 }}>Research context</FieldLabel>
              <textarea
                id="pf-newctx"
                rows={3}
                className="pf-input"
                maxLength={1000}
                value={newCandForm.research_context}
                onChange={e => setNewCandForm(p => ({ ...p, research_context: e.target.value }))}
                placeholder="City, employer, profession, office they're considering — anything that identifies the right person"
                style={fieldStyle}
              />
              <div style={{ fontSize: 12.5, color: T.muted, marginTop: 8, lineHeight: 1.5 }}>
                Adds them to your candidates, then starts their profile.{' '}
                <button
                  type="button"
                  onClick={() => { setNewMode('pick'); setModalError('') }}
                  style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, fontWeight: 600, color: T.red }}
                >Pick an existing candidate instead</button>
              </div>
            </>
          )}

          {modalError && (
            <div style={{ fontSize: 12.5, color: '#B91C1C', marginTop: 12 }}>{modalError}</div>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 22, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12.5, color: outOfProfiles ? T.red : T.muted, marginRight: 'auto' }}>
              {unlimited ? 'Unlimited on your account' : outOfProfiles ? 'No profiles left this month' : `${left} of ${limit} left this month`}
            </span>
            {/* Buttons stay together: on a phone the quota line wraps above them. */}
            <div style={{ display: 'flex', gap: 8, marginLeft: 'auto' }}>
              <Button variant="secondary" onClick={() => setNewOpen(false)}>Cancel</Button>
              {newMode === 'pick' ? (
                <Button
                  onClick={() => { setNewOpen(false); handleGenerate() }}
                  disabled={!candidateId || generating || outOfProfiles}
                  title={outOfProfiles ? 'No profiles left in this month’s allowance' : undefined}
                >{generating ? 'Generating…' : 'Generate profile'}</Button>
              ) : (
                <Button
                  disabled={creatingCand || !newCandForm.name.trim() || generating || outOfProfiles}
                  onClick={handleCreateAndRun}
                  title={outOfProfiles ? 'No profiles left in this month’s allowance' : undefined}
                >{creatingCand ? 'Creating…' : 'Create and generate'}</Button>
              )}
            </div>
          </div>
        </Modal>
      )}

      {confirmDelete && (
        <ConfirmDelete
          deleting={deleting}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={handleDelete}
        />
      )}
    </ProfilerShell>
  )
}

// ─── Small pieces ────────────────────────────────────────────────────────────

const fieldStyle = {
  width: '100%', boxSizing: 'border-box', border: '1px solid rgba(17,22,28,.15)',
  borderRadius: 12, padding: '11px 13px', fontSize: 14, fontFamily: 'inherit',
  color: T.ink, resize: 'vertical', background: '#fff', display: 'block',
}

function FieldLabel({ children, htmlFor, hint, style }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, marginBottom: 6, flexWrap: 'wrap', ...style }}>
      <label htmlFor={htmlFor} style={{ fontSize: 13, fontWeight: 700, color: T.ink }}>{children}</label>
      {hint && <span style={{ fontSize: 12, color: T.muted }}>{hint}</span>}
    </div>
  )
}

/**
 * Inside the reader: every version of this candidate's profile, newest first.
 * The library shows only the newest as a tile; the older ones live here (and
 * in the tile's ⋯ menu).
 */
function VersionSwitcher({ versions, currentId, onPick }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 12, flexWrap: 'wrap' }}>
      <span style={{ fontSize: 12.5, fontWeight: 700, color: T.ink, marginRight: 2 }}>
        {versions.length} versions
      </span>
      {versions.map((v, i) => {
        const on = v.id === currentId
        return (
          <button
            key={v.id}
            type="button"
            aria-pressed={on}
            onClick={() => onPick(v.id)}
            title={v.age || undefined}
            style={{
              borderRadius: 10, padding: '5px 10px', fontSize: 12.5, fontWeight: 600,
              fontFamily: 'inherit', cursor: on ? 'default' : 'pointer', minHeight: 30,
              border: on ? '1px solid transparent' : '1px solid rgba(17,22,28,.1)',
              background: on ? T.ink : '#fff', color: on ? '#fff' : T.ink4,
            }}
          >{v.date}{i === 0 ? ' · latest' : ''}</button>
        )
      })}
    </div>
  )
}

function MoreItem({ children, onClick, danger }) {
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={e => { e.currentTarget.style.background = T.hover }}
      onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
      style={{
        display: 'block', width: '100%', textAlign: 'left', border: 0, background: 'transparent',
        borderRadius: 8, padding: '10px 12px', fontSize: 12.5, fontFamily: 'inherit',
        color: danger ? '#B91C1C' : T.ink3, cursor: 'pointer', minHeight: 40,
      }}
    >{children}</button>
  )
}

function Banner({ children, tone = 'warm', action, onDismiss }) {
  const tones = {
    warm:  { bg: T.warmBg, br: T.warmBr, fg: T.ink3 },
    error: { bg: '#FEF2F2', br: '#FBD5D5', fg: '#7F1D1D' },
  }
  const t = tones[tone] || tones.warm
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12, background: t.bg,
      border: `1px solid ${t.br}`, borderRadius: 16, padding: '12px 16px', marginBottom: 16,
      flexWrap: 'wrap',
    }}>
      <div style={{ fontSize: 12.5, color: t.fg, lineHeight: 1.55, flex: 1, minWidth: 220 }}>{children}</div>
      {action}
      {onDismiss && (
        <button
          type="button" onClick={onDismiss} aria-label="Dismiss"
          style={{
            background: 'none', border: 0, cursor: 'pointer', fontFamily: 'inherit',
            fontSize: 11.5, color: t.fg, textDecoration: 'underline', padding: '8px 0',
          }}
        >Dismiss</button>
      )}
    </div>
  )
}

function Modal({ title, children, onClose, maxWidth = 460 }) {
  // Escape closes and the library behind stops scrolling. The backdrop click
  // and every child's own Cancel/X button are untouched.
  useDialog(onClose)

  return (
    <div
      role="dialog" aria-modal="true" aria-label={title}
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 70, background: 'rgba(13,21,38,.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
        fontFamily: T.font, color: T.ink,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: '#fff', borderRadius: 20, boxShadow: E5,
          width: '100%', maxWidth, padding: '24px 24px 22px',
        }}
      >
        <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-0.03em', marginBottom: 8 }}>{title}</div>
        {children}
      </div>
    </div>
  )
}

function ConfirmDelete({ onCancel, onConfirm, deleting }) {
  return (
    <Modal title="Delete this profile?" onClose={onCancel}>
      <div style={{ fontSize: 12.5, color: T.ink4, lineHeight: 1.6 }}>
        This permanently deletes the generated report. The candidate record and any earlier
        profiles are untouched. It does not return a profile to your monthly allowance.
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 18, justifyContent: 'flex-end' }}>
        <Btn onClick={onCancel}>Cancel</Btn>
        <Btn kind="primary" disabled={deleting} onClick={onConfirm}>
          {deleting ? 'Deleting…' : 'Delete profile'}
        </Btn>
      </div>
    </Modal>
  )
}
