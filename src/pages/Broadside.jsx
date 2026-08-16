import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'

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

/**
 * BROADSIDE — "Take the hit before it's real."
 * The self-contained module (public/broadside-app.html) owns the whole page in
 * a same-origin iframe. This wrapper only: (1) hands the module the caller's
 * JWT so AI + voice route through the server-side proxies, and (2) feeds the
 * module's Intel Intake panel the user's Profiler dossier list.
 *
 * BETA — the route is wrapped in <FeatureRoute feature="broadside"> (see
 * App.jsx), i.e. gated on the plan flag, not on admin email.
 */
export default function Broadside() {
  const { user } = useAuth()
  const [searchParams] = useSearchParams()
  const deepLinkId = searchParams.get('dossier')
  const deepLinkFired = useRef(false)
  const iframeRef = useRef(null)
  const resizeObsRef = useRef(null)
  const [frameReady, setFrameReady] = useState(false)
  const [frameHeight, setFrameHeight] = useState(null)
  const [dossiers, setDossiers] = useState([])
  const [error, setError] = useState(null)

  // ── Dossier list (RLS-scoped) ────────────────────────────────────────────────
  useEffect(() => {
    let alive = true
    ;(async () => {
      const { data, error: qErr } = await supabase
        .from('dossiers')
        .select('id, title, generated_at')
        .order('generated_at', { ascending: false })
        .limit(50)
      if (qErr) console.error('[Broadside] dossier list failed:', qErr)
      if (alive && data) setDossiers(data)
    })()
    return () => { alive = false }
  }, [user?.id])

  // ── Keep the module's proxy token fresh (JWTs expire ~hourly) ───────────────
  useEffect(() => {
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'TOKEN_REFRESHED' && session?.access_token) {
        const cp = iframeRef.current?.contentWindow?.ControversyPrep
        if (cp?.configureProxy) cp.configureProxy({ token: session.access_token })
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
      const cp = iframeRef.current?.contentWindow?.ControversyPrep
      if (!cp?.loadDossier) throw new Error('Module not ready')
      cp.setDossierMeta?.({ id: data.id, title: data.title })
      const structured = dossierToStructured(data.title, data.content)
      if (structured) cp.loadDossier(structured)
      else {
        const name = (data.title || '').replace(/^.*?[—-]\s*/, '').trim()
        cp.loadDossier(name ? `Candidate: ${name}\n\n${data.content}` : data.content)
      }
    } catch (e) {
      console.error('[Broadside] dossier load failed:', e)
      setError('Could not load that dossier into Broadside.')
    }
  }, [])

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
      const cp = iframeRef.current?.contentWindow?.ControversyPrep
      if (token && cp?.configureProxy) {
        cp.configureProxy({ token })
        setFrameReady(true)
      } else {
        setError('Broadside module failed to initialize — try refreshing the page.')
      }
    } catch (e) {
      console.error('[Broadside] init failed:', e)
      setError('Broadside module failed to initialize — try refreshing the page.')
    }
  }, [measureFrame])

  // ── Feed the module's Intel Intake picker ────────────────────────────────────
  useEffect(() => {
    if (!frameReady || !dossiers.length) return
    const cp = iframeRef.current?.contentWindow?.ControversyPrep
    const items = dossiers.map(d => ({
      id: d.id,
      title: d.title,
      label: d.generated_at
        ? `${d.title || 'Untitled dossier'} · ${new Date(d.generated_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`
        : d.title,
    }))
    cp?.setDossierPicker?.({ items, onPick: loadDossier })
  }, [frameReady, dossiers, loadDossier])

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
