import { useState, useEffect, useRef, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { supabase, getCandidates, createCandidate } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { useDossierStatus } from '../contexts/DossierStatusContext'
import DossierDisclaimerModal, { useDossierAck } from '../components/DossierDisclaimerModal'
import { STAGE_LABELS } from './profiler/GenerationStrip'

/**
 * Extract structured attack vectors from a Profiler dossier's markdown.
 * The module's native JSON shape ({name, controversies:[{topic,detail}]})
 * beats its text-sniffing parser: no misread names, no junk vectors.
 * Falls back to raw text (module parser) when structure can't be found.
 */
function dossierToStructured(title, content) {
  const name = (title || '').replace(/^.*?[—-]\s*/, '').trim() || 'the candidate'
  const secRe = /(?:^|\n)#{1,4}[^\n]*(?:CONTROVERS|VULNERAB|WEAKNESS|OPPOSITION|RED FLAG|LIABILIT)[^\n]*\n([\s\S]*?)(?=\n#{1,4}\s|$)/gi
  const items = []
  for (const m of content.matchAll(secRe)) {
    for (const line of m[1].split('\n')) {
      const t = line.trim().replace(/^[-*•]\s*|^\d+[.)]\s*/, '')
      if (t.length < 20 || /^#{1,4}\s/.test(line.trim())) continue
      const bold = t.match(/^\*\*(.+?)\*\*/)
      const clean = t.replace(/\*\*/g, '').replace(/\[(KNOWN|CONFIRMED|LIKELY|VERIFY|RESEARCH REQUIRED)\]/g, '').trim()
      const topic = (bold ? bold[1] : clean.split(/[:.—–]/)[0]).slice(0, 60).trim()
      if (clean.length >= 25) items.push({ topic, detail: clean.slice(0, 500) })
    }
  }
  return items.length >= 2 ? { name, controversies: items.slice(0, 20) } : null
}

// Mirrors Dossiers.jsx: generate-dossier-background has a 15-minute budget, and
// it stamps dossier_generation_progress (stage 1-4, status running|done|error).
const GENERATION_MAX_WAIT_MS = 15 * 60 * 1000
const GENERATION_POLL_MS     = 5000
const PROGRESS_STALE_MS      = 15 * 60 * 1000
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

/** The module's host API (window.ControversyPrep inside the same-origin iframe). */
const cpOf = (ref) => ref.current?.contentWindow?.ControversyPrep

/** Office label for a picker row ("Mayor · Wausau" / "State Assembly · District 87"). */
function officeLabel(c) {
  const o = c?.office
  if (!o) return ''
  const bits = [o.name, o.district_name || (o.district_number ? `District ${o.district_number}` : '')].filter(Boolean)
  return bits.join(' · ')
}

/**
 * BROADSIDE — "Take the hit before it's real."
 * The self-contained module (public/broadside-app.html) owns the whole page in
 * a same-origin iframe. This wrapper: (1) hands the module the caller's JWT so
 * AI + voice route through the server-side proxies, (2) feeds the module's
 * "WHO ARE YOU UP AGAINST?" picker the user's candidates (with each one's
 * latest Profiler dossier), (3) runs Generate-profile for a candidate that has
 * none — same trigger + watcher as the Profiler page — and (4) loads the
 * finished dossier into the module.
 *
 * BETA — the route is wrapped in <FeatureRoute feature="broadside"> (see
 * App.jsx), i.e. gated on the plan flag, not on admin email.
 */
export default function Broadside() {
  const { user } = useAuth()
  const [searchParams] = useSearchParams()
  const deepLinkId = searchParams.get('dossier')
  const deepLinkFired = useRef(false)
  // ?candidate=<id> preselects that candidate in the picker (one-shot).
  const preselectRef = useRef(searchParams.get('candidate'))
  const iframeRef = useRef(null)
  const resizeObsRef = useRef(null)
  const aliveRef = useRef(true)
  const [frameReady, setFrameReady] = useState(false)
  const [frameHeight, setFrameHeight] = useState(null)
  const [candidates, setCandidates] = useState([])
  const [latestDossier, setLatestDossier] = useState({})   // candidate_id → dossier id
  const [error, setError] = useState(null)
  const generatingRef = useRef(null)                        // candidate id of the run in flight

  // Research disclaimer gate — identical to the Profiler page.
  const { ackState, markAcknowledged } = useDossierAck()
  const [showDisclaimer, setShowDisclaimer] = useState(false)
  const [pendingAction, setPendingAction] = useState(null)
  const requireAck = useCallback((fn) => {
    if (ackState === 'acknowledged') fn()
    else { setPendingAction(() => fn); setShowDisclaimer(true) }
  }, [ackState])

  // Header status icon (Layout.jsx) follows the run, like it does from the Profiler.
  const { startGeneration, setReady: setDossierReady, clearStatus: clearDossierStatus } = useDossierStatus()

  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false } }, [])

  // ── Candidates + each one's latest dossier (RLS-scoped) ────────────────────
  const refreshCandidates = useCallback(async () => {
    const [{ data: cands, error: cErr }, { data: doss, error: dErr }] = await Promise.all([
      getCandidates({}),
      supabase
        .from('dossiers')
        .select('id, candidate_id, generated_at')
        .order('generated_at', { ascending: false })
        .limit(500),
    ])
    if (cErr) console.error('[Broadside] candidate list failed:', cErr)
    if (dErr) console.error('[Broadside] dossier list failed:', dErr)
    const latest = {}
    for (const d of doss || []) {
      if (d.candidate_id && !latest[d.candidate_id]) latest[d.candidate_id] = d.id   // ordered desc → first wins
    }
    if (aliveRef.current) {
      setCandidates(cands || [])
      setLatestDossier(latest)
    }
    return { candidates: cands || [], latest }
  }, [])

  useEffect(() => {
    if (!user?.id) return
    refreshCandidates()
  }, [user?.id, refreshCandidates])

  // Latest-value refs so the picker callbacks never see a stale list.
  const candidatesRef = useRef(candidates)
  candidatesRef.current = candidates

  // ── Keep the module's proxy token fresh (JWTs expire ~hourly) ───────────────
  useEffect(() => {
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'TOKEN_REFRESHED' && session?.access_token) {
        const c = cpOf(iframeRef)
        if (c?.configureProxy) c.configureProxy({ token: session.access_token })
      }
    })
    return () => sub?.subscription?.unsubscribe()
  }, [])

  // ── Load a dossier into the module (used by picker + deep link) ─────────────
  const loadDossier = useCallback(async (id) => {
    if (!id) return
    setError(null)
    try {
      const { data, error: qErr } = await supabase
        .from('dossiers')
        .select('id, title, content')
        .eq('id', id)
        .single()
      if (qErr || !data?.content) throw qErr || new Error('Dossier has no content')
      const c = cpOf(iframeRef)
      if (!c?.loadDossier) throw new Error('Module not ready')
      c.setDossierMeta?.({ id: data.id, title: data.title })
      const structured = dossierToStructured(data.title, data.content)
      if (structured) c.loadDossier(structured)
      else {
        const name = (data.title || '').replace(/^.*?[—-]\s*/, '').trim()
        c.loadDossier(name ? `Candidate: ${name}\n\n${data.content}` : data.content)
      }
    } catch (e) {
      console.error('[Broadside] dossier load failed:', e)
      setError('Could not load that dossier into Broadside.')
    }
  }, [])

  // ── Generate a profile for a candidate with none (mirrors Dossiers.jsx) ─────
  const runGenerate = useCallback(async (cid, candidateOverride = null) => {
    const candidate = candidateOverride || candidatesRef.current.find(c => c.id === cid)
    const c = cpOf(iframeRef)
    if (!candidate) { c?.setGenerationStatus?.({ state: 'error', message: 'That candidate could not be found.' }); return }
    if (generatingRef.current) { c?.setGenerationStatus?.({ state: 'error', message: 'A profile is already being generated — one at a time.' }); return }
    generatingRef.current = cid
    const startedAt = Date.now()
    const status = (st) => { if (aliveRef.current) cpOf(iframeRef)?.setGenerationStatus?.({ candidateId: cid, ...st, elapsedMs: Date.now() - startedAt }) }
    const progressLog = (stage) => `${STAGE_LABELS[Math.min(Math.max(stage, 1), STAGE_LABELS.length) - 1]}…`

    status({ state: 'running', stage: 1, message: progressLog(1) })
    startGeneration(candidate.name, cid)

    try {
      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token || ''
      // List mode, ids only: the before/after diff is what proves a new row landed.
      const { data: before } = await supabase.from('dossiers').select('id').eq('candidate_id', cid)
      const beforeIds = new Set((before || []).map(d => d.id))

      // The synchronous trigger validates auth and the monthly limit and returns
      // a real error; a direct background POST always answers 202.
      const res = await fetch('/.netlify/functions/generate-dossier', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ candidate, candidate_id: cid }),
      })
      if (!res.ok && res.status !== 202) {
        let msg = 'Could not start this profile.'
        try { const j = await res.json(); msg = j.error || msg } catch { /* no body */ }
        throw new Error(msg)
      }

      // Watch: progress row for the stage label + dossiers list for the finish.
      const deadline = startedAt + GENERATION_MAX_WAIT_MS
      let fresh = null
      let lastStage = 1
      while (aliveRef.current && Date.now() < deadline) {
        await sleep(GENERATION_POLL_MS)
        if (!aliveRef.current) return
        try {
          const [{ data: prog }, { data: current }] = await Promise.all([
            supabase.from('dossier_generation_progress').select('stage,status,updated_at').eq('candidate_id', cid).maybeSingle(),
            supabase.from('dossiers').select('id, generated_at').eq('candidate_id', cid).order('generated_at', { ascending: false }).limit(5),
          ])
          fresh = (current || []).find(d => !beforeIds.has(d.id)) || null
          if (fresh) break
          if (prog) {
            const age = Date.now() - new Date(prog.updated_at).getTime()
            // A row left behind by an earlier run tells us nothing about this one.
            if (Number.isFinite(age) && age <= PROGRESS_STALE_MS) {
              if (prog.status === 'error') throw new Error(`Generation stopped during "${STAGE_LABELS[Math.min(Math.max(prog.stage, 1), 4) - 1]}". No profile was saved — try again in a moment.`)
              lastStage = Math.min(Math.max(Number(prog.stage) || lastStage, 1), 4)
            }
          }
        } catch (e) {
          if (/Generation stopped/.test(e.message)) throw e
          /* transient — the next tick retries */
        }
        status({ state: 'running', stage: lastStage, message: progressLog(lastStage) })
      }
      if (!aliveRef.current) return
      // Giving up watching is not failing: the run keeps going on the server and
      // the Profiler page will show it when it saves.
      if (!fresh) throw new Error('This profile is taking longer than usual. It is still running on the server — it will appear in the Profiler as soon as it saves; pick the candidate again then.')

      await refreshCandidates()
      await loadDossier(fresh.id)
      setDossierReady({ id: fresh.id, candidateName: candidate.name })
      status({ state: 'done', dossierId: fresh.id, message: 'Profile ready — press START' })
    } catch (err) {
      clearDossierStatus()
      status({ state: 'error', message: err.message || 'Something went wrong generating this profile.' })
    } finally {
      generatingRef.current = null
    }
  }, [startGeneration, setDossierReady, clearDossierStatus, refreshCandidates, loadDossier])

  // ── "+ New candidate" → create, refresh the picker, then generate ────────────
  const createAndGenerate = useCallback(async ({ name, notes }) => {
    const trimmed = (name || '').trim()
    if (!trimmed) throw new Error('Give them a name first.')
    const { data: created, error: cErr } = await createCandidate({
      name: trimmed,
      status: 'exploring',
      research_context: (notes || '').trim() || null,
    })
    if (cErr) throw new Error(cErr.message || 'Could not add this candidate.')
    const { data: full } = await supabase
      .from('candidates')
      .select('*, office:offices(id, name, level, office_type, district_name, district_number, county)')
      .eq('id', created.id).single()
    const { candidates: list, latest } = await refreshCandidates()
    const c = cpOf(iframeRef)
    c?.setCandidatePicker?.({
      items: list.map(x => ({ id: x.id, name: x.name, office: officeLabel(x), party: x.party || '', dossierId: latest[x.id] || null })),
      selectedId: created.id,
    })
    requireAck(() => runGenerate(created.id, full || created))
  }, [refreshCandidates, requireAck, runGenerate])

  // ── Keep the frame as tall as the module's own document (B5) ────────────────
  // The module is ~1000px tall (scene + the SESSION CONSOLE strip at its base)
  // and the app gives it a ~800px slot, inside a full-bleed <main> that is
  // overflow:hidden — so the bottom strip used to be unreachable. We measure the
  // module's root `.layout` (NOT body/scrollHeight: body carries
  // `min-height:100vh`, and 100vh inside the frame is whatever height we just
  // set — measuring that would ratchet the frame taller on every pass) and let
  // this page's own wrapper scroll. Full-bleed survives: the iframe still spans
  // the full width and never renders shorter than the slot.
  const measureFrame = useCallback(() => {
    const doc = iframeRef.current?.contentDocument
    if (!doc) return
    const root = doc.querySelector('.layout') || doc.body
    if (!root) return
    const view = doc.defaultView
    const bodyStyle = view ? view.getComputedStyle(doc.body) : null
    const pad = bodyStyle
      ? (parseFloat(bodyStyle.paddingTop) || 0) + (parseFloat(bodyStyle.paddingBottom) || 0)
      : 0
    const h = Math.ceil(root.getBoundingClientRect().height + pad)
    if (h > 0) setFrameHeight(prev => (prev !== null && Math.abs(prev - h) < 2 ? prev : h))
  }, [])

  // Re-measure whenever the module's content changes size (dossier dock opens,
  // console fills, theme switch, window resize).
  useEffect(() => {
    const onResize = () => measureFrame()
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      resizeObsRef.current?.disconnect()
      resizeObsRef.current = null
    }
  }, [measureFrame])

  // ── Wire the module once the iframe loads ────────────────────────────────────
  const handleFrameLoad = useCallback(async () => {
    // Height first — it must work even if the proxy handshake below fails.
    measureFrame()
    try {
      const doc = iframeRef.current?.contentDocument
      if (doc?.body && typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(() => measureFrame())
        ro.observe(doc.body)
        const layout = doc.querySelector('.layout')
        if (layout) ro.observe(layout)
        resizeObsRef.current?.disconnect()
        resizeObsRef.current = ro
      }
    } catch (e) {
      console.warn('[Broadside] frame height observer failed:', e)
    }
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token
      const c = cpOf(iframeRef)
      if (token && c?.configureProxy) {
        c.configureProxy({ token })
        setFrameReady(true)
      } else {
        setError('Broadside module failed to initialize — try refreshing the page.')
      }
    } catch (e) {
      console.error('[Broadside] init failed:', e)
      setError('Broadside module failed to initialize — try refreshing the page.')
    }
  }, [measureFrame])

  // ── Feed the module's "Pick a candidate" picker ──────────────────────────────
  useEffect(() => {
    if (!frameReady) return
    const c = cpOf(iframeRef)
    if (!c?.setCandidatePicker) return
    const items = candidates.map(x => ({
      id: x.id,
      name: x.name,
      office: officeLabel(x),
      party: x.party || '',
      dossierId: latestDossier[x.id] || null,
    }))
    const cfg = {
      items,
      onPick: (dossierId) => loadDossier(dossierId),
      onGenerate: (cid) => requireAck(() => runGenerate(cid)),
      onCreate: createAndGenerate,
    }
    // ?candidate=<id>: preselect once the list actually contains it.
    if (preselectRef.current && items.some(i => i.id === preselectRef.current)) {
      cfg.selectedId = preselectRef.current
      preselectRef.current = null
    }
    c.setCandidatePicker(cfg)
  }, [frameReady, candidates, latestDossier, loadDossier, requireAck, runGenerate, createAndGenerate])

  // ── Deep link: /broadside?dossier=<id> (from "Spar" in Profiler) ─────────────
  useEffect(() => {
    if (frameReady && deepLinkId && !deepLinkFired.current) {
      deepLinkFired.current = true
      loadDossier(deepLinkId)
    }
  }, [frameReady, deepLinkId, loadDossier])

  return (
    // B5: this wrapper is the scroller. Layout renders /broadside full-bleed
    // with `overflow-hidden` on <main>, so nothing above us can scroll; owning
    // the scroll here keeps the edge-to-edge look and makes every part of the
    // module — including the SESSION CONSOLE strip at its base — reachable.
    <div className="flex flex-col h-full overflow-y-auto overscroll-contain">
      {error && (
        <div className="bg-red-700 text-white text-xs font-semibold px-4 py-1.5 flex-shrink-0">
          {error}
        </div>
      )}
      {showDisclaimer && (
        <DossierDisclaimerModal
          onAcknowledged={(at) => {
            markAcknowledged(at)
            setShowDisclaimer(false)
            const fn = pendingAction
            setPendingAction(null)
            if (fn) fn()
          }}
          onClose={() => {
            setShowDisclaimer(false)
            setPendingAction(null)
            cpOf(iframeRef)?.setGenerationStatus?.({ state: 'error', message: 'Acknowledge the research disclaimer to generate a profile.' })
          }}
        />
      )}
      <iframe
        ref={iframeRef}
        src="/broadside-app.html"
        title="Broadside — controversy sparring"
        onLoad={handleFrameLoad}
        allow="microphone; autoplay"
        className="w-full border-0 flex-shrink-0"
        style={{
          background: '#F4F5F7',
          // Tall enough for the module's whole document, never shorter than the
          // slot it sits in (so short content still fills the page).
          height: frameHeight ? `${frameHeight}px` : '100%',
          minHeight: '100%',
        }}
      />
    </div>
  )
}
