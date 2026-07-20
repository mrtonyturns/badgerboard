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
 * ADMIN-ONLY BETA — route is wrapped in AdminRoute (see App.jsx).
 */
export default function Broadside() {
  const { user } = useAuth()
  const [searchParams] = useSearchParams()
  const deepLinkId = searchParams.get('dossier')
  const deepLinkFired = useRef(false)
  const iframeRef = useRef(null)
  const [frameReady, setFrameReady] = useState(false)
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

  // ── Wire the module once the iframe loads ────────────────────────────────────
  const handleFrameLoad = useCallback(async () => {
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
  }, [])

  // ── Feed the module's Intel Intake picker ────────────────────────────────────
  useEffect(() => {
    if (!frameReady || !dossiers.length) return
    const cp = iframeRef.current?.contentWindow?.ControversyPrep
    cp?.setDossierPicker?.({ items: dossiers, onPick: loadDossier })
  }, [frameReady, dossiers, loadDossier])

  // ── Deep link: /broadside?dossier=<id> (from "Spar" in Profiler) ─────────────
  useEffect(() => {
    if (frameReady && deepLinkId && !deepLinkFired.current) {
      deepLinkFired.current = true
      loadDossier(deepLinkId)
    }
  }, [frameReady, deepLinkId, loadDossier])

  return (
    <div className="flex flex-col h-full">
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
        className="flex-1 min-h-0 w-full border-0"
        style={{ background: '#F4F5F7' }}
      />
    </div>
  )
}
