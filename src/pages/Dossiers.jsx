// src/pages/Dossiers.jsx — Profiler (SPEC-profiler.md).
//
// Two views on one route, each with the full canvas:
//   LIBRARY — generate row · real in-flight state · stat strip · conditional
//             credit CTA · the full profiles table
//   READER  — one quiet document (src/pages/profiler/ReportReader.jsx)
//
// The old page split the canvas in two, stated the plan twice, and rendered 15
// section colour themes plus a badge on nearly every paragraph. Everything that
// reads or counts now lives in src/pages/profiler/reportModel.js so the reader,
// the table, the print document and the public share view can't disagree.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams, Link, useNavigate } from 'react-router-dom'
import { format } from 'date-fns'

import {
  getCandidates, getDossiers, getDossier, deleteDossier, createCandidate,
  updateCandidate, supabase,
} from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { useDossierStatus } from '../contexts/DossierStatusContext'
import {
  getUserTier, getEffectiveProfileLimit, getBankedProfileCredits,
  hasFeature, isLiteProfileOnly,
} from '../lib/tiers'
import { CANDIDATE_STATUS_LABELS } from '../lib/campaignEnums'
import LoadingBar from '../components/LoadingBar'
import SearchableSelect from '../components/SearchableSelect'
import DossierDisclaimerModal, { useDossierAck } from '../components/DossierDisclaimerModal'

import {
  T, cardStyle, ProfilerShell, Btn, Pill, Avatar, StatStrip, StatCell, RatioBar,
  relativeAge, plural,
} from './profiler/shared'
import ReportReader from './profiler/ReportReader'
import GenerationStrip from './profiler/GenerationStrip'
import ResearchNote from './profiler/ResearchNote'
import BulkModal from './profiler/BulkModal'
import ShareModal from './profiler/ShareModal'
import ClaimReviewer from './profiler/ClaimReviewer'
import {
  parseSections, buildReport, buildPrintHtml, sourcingStats, flagSummary,
  parseFlaggedClaims,
} from './profiler/reportModel'
import { rowToCandidatePatch } from './profiler/bulkCsv'
import { filterSections } from '../lib/profileContent'

const PAGE_SIZE = 25
const PROGRESS_POLL_MS = 2500
const PROGRESS_STALE_MS = 15 * 60 * 1000
const BULK_STAGGER_MS = 3000
const ANNOTATION_PREFIX = 'dossier_annotation_'

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

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
  const [searchParams] = useSearchParams()
  const initCandidateId = searchParams.get('candidate')
  const initViewId      = searchParams.get('view')
  const initSection     = searchParams.get('section')
  const initViewOpened  = useRef(false)

  const userTier  = getUserTier(user)
  const limit     = getEffectiveProfileLimit(user)
  const unlimited = limit === Infinity
  const canBulk   = hasFeature(userTier, 'bulkProfiler')
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
  const [showNewCand, setShowNewCand] = useState(false)
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

  // ── Fetch ─────────────────────────────────────────────────────────────────
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
    setCandidates(c || [])
    setDossiers(d || [])
    setUsed((monthly || []).length)
    setLoading(false)
    if (initViewId && d && !initViewOpened.current) {
      const found = d.find(x => x.id === initViewId)
      if (found) { initViewOpened.current = true; openDossier(initViewId) }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id])

  useEffect(() => { fetchData() }, [fetchData])

  // Deep link from the District Dashboard: /profiler?newname=…&context=…
  useEffect(() => {
    const newName = searchParams.get('newname')
    if (newName) {
      setNewCandForm({ name: newName, research_context: searchParams.get('context') || '' })
      setShowNewCand(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dossiers, initCandidateId])

  const openDossier = async (id, section = null) => {
    const { data } = await getDossier(id)
    if (!data || !aliveRef.current) return
    setSelected(data)
    setShowReviewer(false); setShowNotes(false); setMoreOpen(false); setShowEmpty(false)
    scrollPageTop()
    if (section) setTimeout(() => {
      const el = document.getElementById(`pf-${section}`)
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 500)
  }

  const scrollPageTop = () => {
    const main = document.querySelector('main')
    if (main && main.scrollHeight > main.clientHeight) main.scrollTo({ top: 0 })
    else window.scrollTo({ top: 0 })
  }

  // ── Real generation progress (dossier_generation_progress) ────────────────
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
            candidateName: candidates.find(c => c.id === cid)?.name || '',
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generating, genCandidateId, dossierPhase, pendingCandidateId])

  // ── Resume after a refresh (belt-and-suspenders: a NEW dossier row) ───────
  const resumeRef = useRef(false)
  useEffect(() => {
    if (dossierPhase !== 'generating' || !pendingCandidateId || resumeRef.current) return
    resumeRef.current = true
    setGenerating(true)
    setGenCandidateId(pendingCandidateId)

    const MAX_WAIT = 6 * 60 * 1000
    const pollStart = generationStartedAt ? new Date(generationStartedAt).getTime() : Date.now()
    const deadline = pollStart + MAX_WAIT
    const startISO = generationStartedAt || new Date(pollStart - 1000).toISOString()
    let stopped = false

    ;(async () => {
      const findNew = (list) => (list || []).find(d => (d.generated_at || d.created_at || '') > startISO)
      const { data: immediate } = await getDossiers(pendingCandidateId)
      const already = findNew(immediate)
      if (already && !stopped) {
        await fetchData(); await openDossier(already.id)
        setDossierReady({ id: already.id, candidateName: already.candidate?.name || '' })
        setGenerating(false); setGenCandidateId(null)
        return
      }
      while (!stopped && Date.now() < deadline) {
        await sleep(5000)
        const { data: current } = await getDossiers(pendingCandidateId)
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dossierPhase, pendingCandidateId])

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
      const { data: before } = await getDossiers(cid)
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
      const deadline = Date.now() + 6 * 60 * 1000
      let fresh = null
      while (aliveRef.current && !genAbortRef.current && Date.now() < deadline) {
        await sleep(5000)
        const { data: current } = await getDossiers(cid)
        fresh = (current || []).find(d => !beforeIds.has(d.id))
        if (fresh) break
      }
      if (!aliveRef.current || genAbortRef.current) return
      if (!fresh) throw new Error('This profile is taking longer than six minutes. It may still be saving — check back shortly.')

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
      setShowNewCand(false)
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

  const handleExportPdf = () => {
    if (!selected) return
    const { sections } = filterSections(parseSections(selected.content || ''), showEmpty)
    const report = buildReport(selected.content || '', sections)
    const html = buildPrintHtml(selected, report)
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

  const rows = useMemo(() => dossiers.map(d => {
    const cand = candidateById.get(d.candidate_id) || d.candidate || {}
    const content = d.content || ''
    const src = sourcingStats(content)
    const flags = flagSummary(content)
    const ageDays = d.generated_at
      ? Math.floor((Date.now() - new Date(d.generated_at).getTime()) / 86400000) : null
    return {
      id: d.id,
      name: d.candidate?.name || cand.name || 'Unknown candidate',
      party: d.candidate?.party || cand.party || '',
      office: cand.office?.name || d.candidate?.office?.name || '',
      district: cand.office?.district_name || d.candidate?.office?.district_name || '',
      status: cand.status ? (CANDIDATE_STATUS_LABELS[cand.status] || cand.status) : '',
      monitored: cand.section_timestamps?.monitoring === true,
      isNew: ageDays != null && ageDays < 7,
      date: d.generated_at ? format(new Date(d.generated_at), 'MMM d, yyyy') : '—',
      age: relativeAge(d.generated_at),
      sourced: src.ratio == null ? '—' : `${src.strong} of ${src.total}`,
      good: src.strong, weak: src.weak, hasRatio: src.ratio != null,
      flags,
    }
  }), [dossiers, candidateById])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return rows
    return rows.filter(r =>
      r.name.toLowerCase().includes(q) ||
      r.office.toLowerCase().includes(q) ||
      r.district.toLowerCase().includes(q))
  }, [rows, query])

  const monthStats = useMemo(() => {
    const som = startOfThisMonth().getTime()
    let auto = 0, manual = 0
    for (const d of dossiers) {
      const t = d.generated_at ? new Date(d.generated_at).getTime() : NaN
      if (!Number.isFinite(t) || t < som) continue
      if (d.generated_by) manual++
      else auto++
    }
    return { auto, manual, total: auto + manual }
  }, [dossiers])

  const candidateCount = useMemo(
    () => new Set(dossiers.map(d => d.candidate_id).filter(Boolean)).size, [dossiers])

  const left = unlimited ? Infinity : Math.max(0, limit - dossiersUsed)
  const pctUsed = unlimited || !limit ? 0 : dossiersUsed / limit
  const showUpsell = !unlimited && (left < 5 || pctUsed >= 0.85)
  const resetLabel = `resets ${format(startOfNextMonth(), 'MMM d')}`
  const balance = { unlimited, left, limit, resetLabel }

  const selectedCandidate = candidates.find(c => c.id === candidateId)
  const flaggedCount = selected ? parseFlaggedClaims(selected.content || '').length : 0
  const researchNote = selected?.research_note && typeof selected.research_note === 'object'
    ? selected.research_note : null

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
          back={(
            <button
              type="button"
              onClick={() => { setSelected(null); scrollPageTop() }}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6, background: 'none',
                border: 0, padding: '0 0 16px', cursor: 'pointer', fontFamily: 'inherit',
                fontSize: 12, color: T.faint,
              }}
            >← All profiles</button>
          )}
          actions={(
            <>
              {isAdmin && (
                <Link
                  to={`/broadside?dossier=${selected.id}`}
                  title="Spar against this profile in Broadside"
                  style={{
                    background: '#fff', border: `1px solid ${T.border}`, borderRadius: 99,
                    padding: '10px 14px', fontSize: 12, fontWeight: 600, color: T.ink,
                    textDecoration: 'none', display: 'inline-flex', alignItems: 'center', minHeight: 40,
                  }}
                >Spar</Link>
              )}
              <Btn onClick={() => navigate('/compare')} tap={false} style={{ minHeight: 40 }}>Compare</Btn>
              <Btn onClick={() => setShowShare(true)} tap={false} style={{ minHeight: 40 }}>Share</Btn>
              <div style={{ position: 'relative' }}>
                <Btn onClick={() => setMoreOpen(v => !v)} tap={false} style={{ minHeight: 40 }}>More</Btn>
                {moreOpen && (
                  <>
                    <div onClick={() => setMoreOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
                    <div style={{
                      position: 'absolute', right: 0, top: 'calc(100% + 6px)', zIndex: 41, width: 232,
                      ...cardStyle, borderRadius: 12, padding: 6, boxShadow: '0 12px 30px rgba(13,21,38,.14)',
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
                <Link to="/plans" style={{ color: T.red, fontWeight: 600 }}>Compare plans</Link>
              </div>
            </div>
          ) : null}
        />

        {showShare && (
          <ShareModal dossier={selected} onClose={() => setShowShare(false)} onExportPdf={handleExportPdf} />
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
  return (
    <ProfilerShell>
      <LoadingBar loading={generating} />
      {showDisclaimerModal && (
        <DossierDisclaimerModal
          onAcknowledged={handleAcknowledged}
          onClose={() => { setShowDisclaimerModal(false); setPendingAction(null) }}
        />
      )}

      <div className="pf-head" style={{ display: 'flex', alignItems: 'flex-start', gap: 16, marginBottom: 20 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <h1 style={{ fontSize: 23, fontWeight: 700, letterSpacing: '-.3px', margin: 0 }}>Profiler</h1>
          <div style={{ fontSize: 13, color: T.ink4, marginTop: 4 }}>
            AI-generated opposition intelligence profiles.
          </div>
        </div>
        <div className="pf-headright" style={{ flex: 'none', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Btn onClick={() => { setShowNewCand(true); setModalError('') }}>New candidate</Btn>
          {canBulk ? (
            <Btn onClick={() => setBulkOpen(true)}>Bulk generate</Btn>
          ) : (
            <Btn
              onClick={() => navigate('/plans')}
              title="Bulk generate is part of the Action Campaign plan"
            >Bulk generate</Btn>
          )}
        </div>
      </div>

      {ackState === 'pending' && (
        <Banner tone="warm" action={<Btn kind="warm" onClick={() => setShowDisclaimerModal(true)}>Acknowledge</Btn>}>
          <strong style={{ fontWeight: 700 }}>Research use disclaimer required.</strong>{' '}
          You need to acknowledge it before generating or opening profiles.{' '}
          <a href="/dossier-disclaimer" target="_blank" rel="noopener noreferrer"
            style={{ color: T.amber, textDecoration: 'underline' }}>Read it</a>
        </Banner>
      )}

      {error && <Banner tone="error" onDismiss={() => setError('')}>{error}</Banner>}

      {/* ── Generate row ─────────────────────────────────────────────────── */}
      <div style={{ ...cardStyle, padding: '18px 22px', marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 14, fontWeight: 700 }}>Generate a profile</span>
          <span style={{ fontSize: 11.5, color: T.muted }}>
            14 sections · 2–4 minutes · Grok and Perplexity search the web, news and filings; Claude writes the report
          </span>
        </div>
        <div className="pf-genrow" style={{
          display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1.5fr) auto',
          gap: 12, alignItems: 'end',
        }}>
          <div>
            <div style={{ fontSize: 11.5, fontWeight: 600, color: T.ink3, marginBottom: 6 }}>
              Candidate
            </div>
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
          </div>
          <div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, marginBottom: 6, flexWrap: 'wrap' }}>
              <label htmlFor="pf-context" style={{ fontSize: 11.5, fontWeight: 600, color: T.ink3 }}>
                Research context
              </label>
              <span style={{ fontSize: 11, color: T.muted }}>recommended for pre-announcement candidates</span>
            </div>
            <input
              id="pf-context"
              className="pf-input"
              value={researchContext}
              onChange={e => setResearchContext(e.target.value)}
              maxLength={1000}
              placeholder="City, employer, profession — anything that disambiguates this person"
              style={{
                width: '100%', boxSizing: 'border-box', border: `1px solid ${T.field}`,
                borderRadius: 10, padding: '12px 13px', fontSize: 13, fontFamily: 'inherit',
                color: T.ink, minHeight: 44,
              }}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <Btn
              kind="primary"
              onClick={handleGenerate}
              disabled={!candidateId || generating || (!unlimited && left === 0)}
              style={{ borderRadius: 10, padding: '12px 22px', fontSize: 13 }}
              title={!unlimited && left === 0 ? 'No profiles left in this month’s allowance' : undefined}
            >
              {generating ? 'Generating…' : 'Generate profile'}
            </Btn>
          </div>
        </div>
        {selectedCandidate && !selectedCandidate.research_context && !researchContext.trim() && (
          <div style={{ fontSize: 11.5, color: T.muted, marginTop: 10 }}>
            {selectedCandidate.name} has no saved research context. Adding one materially improves
            the odds of profiling the right person.
          </div>
        )}
      </div>

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

      {/* ── Stat strip: the ONE place the plan is stated ─────────────────── */}
      <StatStrip cols={3}>
        <StatCell
          center
          label="Saved profiles"
          value={dossiers.length}
          sub={candidateCount ? `across ${plural(candidateCount, 'candidate')}` : 'no candidates profiled yet'}
        />
        <StatCell
          center
          label="Generated this month"
          value={monthStats.total}
          sub={monthStats.total
            ? `${monthStats.auto} automatic · ${monthStats.manual} manual`
            : 'nothing generated yet this month'}
        />
        {unlimited ? (
          <StatCell
            center
            label="Profiles this month"
            value={dossiersUsed}
            sub="this plan has no monthly cap"
          />
        ) : (
          <StatCell
            center
            label="Profiles left on your plan"
            value={left}
            of={`of ${limit}`}
            valueColor={left === 0 ? T.red : left <= 5 ? T.amber : T.ink}
            sub={left === 0 ? 'monthly allowance used' : resetLabel}
            right={(
              <Btn
                kind="primary"
                tap={false}
                onClick={() => navigate('/plans')}
                style={{ padding: '5px 11px', fontSize: 11, minHeight: 28 }}
              >Add more</Btn>
            )}
          />
        )}
      </StatStrip>

      {/* ── Credit CTA: ≥85% consumed or fewer than 5 left ───────────────── */}
      {showUpsell && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 14, background: T.warmBg,
          border: `1px solid ${T.warmBr}`, borderRadius: 14, padding: '14px 18px',
          marginBottom: 16, flexWrap: 'wrap',
        }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 700 }}>
              {left === 0
                ? 'You’ve used every profile in this month’s allowance'
                : `${plural(left, 'profile')} left this month — need more before ${format(startOfNextMonth(), 'MMM d')}?`}
            </div>
            <div style={{ fontSize: 12, color: T.ink4, lineHeight: 1.55, marginTop: 3, maxWidth: '74ch' }}>
              Credit packs add profiles on top of your monthly allowance and never expire. Weekly
              Active Monitoring refreshes stay free and don't draw from this balance.
              {bankedCredits > 0 && ` You have ${plural(bankedCredits, 'credit')} banked, already counted above.`}
            </div>
          </div>
          <div style={{ marginLeft: 'auto', flex: 'none', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Btn kind="warm" onClick={() => navigate('/plans')}>Compare plans</Btn>
            <Btn kind="primary" onClick={() => navigate('/plans')}>Buy a credit pack</Btn>
          </div>
        </div>
      )}

      {/* ── Profiles table ───────────────────────────────────────────────── */}
      <div style={{ ...cardStyle, overflow: 'hidden' }}>
        <div className="pf-controls" style={{
          display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 9,
          padding: '15px 20px', borderBottom: `1px solid ${T.divider}`,
        }}>
          <input
            className="pf-input"
            value={query}
            onChange={e => { setQuery(e.target.value); setShown(PAGE_SIZE) }}
            placeholder="Search candidates or offices"
            aria-label="Search profiles"
            style={{
              flex: 1, minWidth: 160, boxSizing: 'border-box', border: `1px solid ${T.field}`,
              borderRadius: 99, padding: '11px 15px', fontSize: 12.5, fontFamily: 'inherit',
              color: T.ink, minHeight: 44,
            }}
          />
          <span style={{ fontSize: 11.5, color: T.muted, whiteSpace: 'nowrap' }}>
            {query
              ? `${filtered.length} of ${plural(rows.length, 'profile')}`
              : plural(rows.length, 'profile')}
          </span>
        </div>

        <div style={{
          display: 'flex', alignItems: 'center', gap: 14, padding: '9px 20px',
          background: T.hover, borderBottom: `1px solid ${T.divider}`,
        }}>
          <span style={{ flex: 1, minWidth: 200, fontSize: 11, fontWeight: 700, letterSpacing: '.7px', color: T.ink4 }}>CANDIDATE</span>
          <span className="pf-rowmeta" style={{ flex: 'none', width: 150, fontSize: 11, fontWeight: 700, letterSpacing: '.7px', color: T.ink4 }}>GENERATED</span>
          <span className="pf-rowmeta" style={{ flex: 'none', width: 132, fontSize: 11, fontWeight: 700, letterSpacing: '.7px', color: T.ink4 }}>SOURCING</span>
          <span className="pf-rowmeta" style={{ flex: 'none', width: 112, fontSize: 11, fontWeight: 700, letterSpacing: '.7px', color: T.ink4 }}>FLAGS</span>
          <span style={{ flex: 'none', width: 62 }} />
        </div>

        {filtered.length === 0 ? (
          <div style={{ padding: '38px 20px', textAlign: 'center' }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 5 }}>
              {loading ? 'Loading profiles…' : rows.length === 0 ? 'No profiles yet' : 'No profiles match that search'}
            </div>
            {!loading && (
              <div style={{ fontSize: 12.5, color: T.muted, lineHeight: 1.6 }}>
                {rows.length === 0
                  ? 'Pick a candidate above and generate the first one — it takes 2–4 minutes.'
                  : 'Search runs over candidate names and offices.'}
              </div>
            )}
          </div>
        ) : filtered.slice(0, shown).map(r => (
          <div
            key={r.id}
            className="pf-row"
            role="button"
            tabIndex={0}
            onClick={() => openDossier(r.id)}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDossier(r.id) } }}
            style={{
              display: 'flex', alignItems: 'center', gap: 14, padding: '13px 20px',
              borderBottom: '1px solid #F5F4F1', minHeight: 60,
            }}
          >
            <div style={{ flex: 1, minWidth: 200, display: 'flex', alignItems: 'center', gap: 12 }}>
              <Avatar name={r.name} party={r.party} />
              <div style={{ minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{
                    fontSize: 13.5, fontWeight: 600, whiteSpace: 'nowrap',
                    overflow: 'hidden', textOverflow: 'ellipsis',
                  }}>{r.name}</span>
                  {r.monitored && <Pill c={T.green} bg="#E6F5EC">WEEKLY</Pill>}
                  {r.isNew && <Pill c={T.red} bg="#FBEAEA">NEW</Pill>}
                </div>
                <div style={{
                  fontSize: 11.5, color: T.muted, marginTop: 2, whiteSpace: 'nowrap',
                  overflow: 'hidden', textOverflow: 'ellipsis',
                }}>
                  {[r.office || 'No office linked', r.party, r.status].filter(Boolean).join(' · ')}
                </div>
              </div>
            </div>
            <div className="pf-rowmeta" style={{ flex: 'none', width: 150 }}>
              <div style={{ fontSize: 12.5, fontWeight: 500 }}>{r.date}</div>
              <div style={{ fontSize: 11, color: T.muted, marginTop: 1 }}>{r.age}</div>
            </div>
            <div className="pf-rowmeta" style={{ flex: 'none', width: 132 }}>
              <div style={{ fontSize: 12, fontWeight: 600 }}>{r.sourced}</div>
              {r.hasRatio
                ? <RatioBar good={r.good} weak={r.weak} style={{ marginTop: 5 }} />
                : <div style={{ fontSize: 11, color: T.muted, marginTop: 2 }}>under 5 tagged claims</div>}
            </div>
            <div className="pf-rowmeta" style={{ flex: 'none', width: 112, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {r.flags.riskLabel && (
                <span style={{ fontSize: 11, fontWeight: 700, color: r.flags.riskColor }}>{r.flags.riskLabel}</span>
              )}
              {r.flags.verifyLabel && (
                <span style={{ fontSize: 11, fontWeight: 700, color: T.amber }}>{r.flags.verifyLabel}</span>
              )}
              {r.flags.clean && <span style={{ fontSize: 11, fontWeight: 600, color: T.muted }}>None</span>}
            </div>
            <span style={{ flex: 'none', width: 62, textAlign: 'right', fontSize: 11.5, fontWeight: 600, color: T.faint }}>
              Open
            </span>
          </div>
        ))}

        {filtered.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '13px 20px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11.5, color: T.muted }}>
              Showing {Math.min(shown, filtered.length)} of {plural(filtered.length, 'profile')}
            </span>
            {shown < filtered.length && (
              <Btn style={{ marginLeft: 'auto' }} onClick={() => setShown(s => s + PAGE_SIZE)}>Load more</Btn>
            )}
          </div>
        )}
      </div>

      {/* ── Modals ───────────────────────────────────────────────────────── */}
      <BulkModal
        open={bulkOpen}
        onClose={() => { setBulkOpen(false); if (bulkRun?.done) setBulkRun(null) }}
        balance={balance}
        runState={bulkRun}
        onRun={rows => requireAck(() => runBulk(rows))}
      />

      {showNewCand && (
        <Modal title="Add a candidate and generate" onClose={() => setShowNewCand(false)}>
          <div style={{ fontSize: 12.5, color: T.ink4, lineHeight: 1.55, marginBottom: 14 }}>
            Creates the candidate record, then starts a full 14-section profile.
          </div>
          <label style={{ display: 'block', fontSize: 11.5, fontWeight: 600, color: T.ink3, marginBottom: 6 }}>
            Full name
          </label>
          <input
            autoFocus
            className="pf-input"
            value={newCandForm.name}
            onChange={e => setNewCandForm(p => ({ ...p, name: e.target.value }))}
            placeholder="First Last"
            style={{
              width: '100%', boxSizing: 'border-box', border: `1px solid ${T.field}`,
              borderRadius: 10, padding: '12px 13px', fontSize: 13, fontFamily: 'inherit',
              marginBottom: 14, minHeight: 44,
            }}
          />
          <label style={{ display: 'block', fontSize: 11.5, fontWeight: 600, color: T.ink3, marginBottom: 6 }}>
            Research context <span style={{ fontWeight: 500, color: T.muted }}>— recommended</span>
          </label>
          <textarea
            rows={3}
            className="pf-input"
            maxLength={1000}
            value={newCandForm.research_context}
            onChange={e => setNewCandForm(p => ({ ...p, research_context: e.target.value }))}
            placeholder="City, employer, profession, office they're considering — anything that identifies the right person"
            style={{
              width: '100%', boxSizing: 'border-box', border: `1px solid ${T.field}`,
              borderRadius: 10, padding: '12px 13px', fontSize: 13, fontFamily: 'inherit',
              resize: 'vertical',
            }}
          />
          {modalError && (
            <div style={{ fontSize: 12, color: '#B91C1C', marginTop: 10 }}>{modalError}</div>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 18, justifyContent: 'flex-end' }}>
            <Btn onClick={() => setShowNewCand(false)}>Cancel</Btn>
            <Btn kind="primary" disabled={creatingCand || !newCandForm.name.trim()} onClick={handleCreateAndRun}>
              {creatingCand ? 'Creating…' : 'Create and generate'}
            </Btn>
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
      border: `1px solid ${t.br}`, borderRadius: 14, padding: '12px 16px', marginBottom: 16,
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

function Modal({ title, children, onClose }) {
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
          background: '#fff', borderRadius: 18, boxShadow: '0 24px 60px rgba(13,21,38,.28)',
          width: '100%', maxWidth: 460, padding: '20px 24px 22px',
        }}
      >
        <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 10 }}>{title}</div>
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
