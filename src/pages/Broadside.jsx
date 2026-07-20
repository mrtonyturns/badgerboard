import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Swords, FileText, ChevronDown, Loader2 } from 'lucide-react'
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
      // topic: bolded lead or first clause; detail: the full line, cleaned
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
 * AI opposition sparring: an AI opponent attacks the candidate out loud with
 * their own vulnerabilities (from Profiler dossiers); they answer by voice.
 *
 * The module itself is the self-contained /broadside.html (public/), embedded
 * in a same-origin iframe for style/script isolation. This page:
 *   1. passes the caller's Supabase JWT into the module so its LLM + TTS calls
 *      route through the broadside-brain / broadside-voice Netlify proxies
 *      (no API keys in the browser), and
 *   2. lets the user pipe any of their Profiler dossiers straight in.
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
  const [selectedId, setSelectedId] = useState('')
  const [loadingDossier, setLoadingDossier] = useState(false)
  const [loadedTitle, setLoadedTitle] = useState(null)
  const [error, setError] = useState(null)

  // ── Dossier list (RLS-scoped, same pattern as CampaignConnect) ──────────────
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

  // ── Keep the module's proxy token fresh (JWTs expire ~hourly; a long
  //    sparring session would otherwise silently degrade to templates) ─────────
  useEffect(() => {
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'TOKEN_REFRESHED' && session?.access_token) {
        const cp = iframeRef.current?.contentWindow?.ControversyPrep
        if (cp?.configureProxy) cp.configureProxy({ token: session.access_token })
      }
    })
    return () => sub?.subscription?.unsubscribe()
  }, [])

  // ── Wire the module to the server-side proxies once the iframe loads ────────
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

  // ── Deep link: /broadside?dossier=<id> auto-loads (from "Spar" in Profiler) ──
  useEffect(() => {
    if (frameReady && deepLinkId && !deepLinkFired.current) {
      deepLinkFired.current = true
      loadDossier(deepLinkId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frameReady, deepLinkId])

  // ── Pipe a Profiler dossier into the module ─────────────────────────────────
  const loadDossier = useCallback(async (id) => {
    setSelectedId(id)
    setLoadedTitle(null)
    if (!id) return
    setLoadingDossier(true)
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
      // Prefer structured extraction (clean vectors); fall back to raw text
      // with the candidate name pinned so the module's regex can't misread it.
      cp.setDossierMeta?.({ id: data.id, title: data.title })
      const structured = dossierToStructured(data.title, data.content)
      if (structured) cp.loadDossier(structured)
      else {
        const name = (data.title || '').replace(/^.*?[—-]\s*/, '').trim()
        cp.loadDossier(name ? `Candidate: ${name}\n\n${data.content}` : data.content)
      }
      setLoadedTitle(data.title || 'Dossier')
    } catch (e) {
      console.error('[Broadside] dossier load failed:', e)
      setError('Could not load that dossier into Broadside.')
    } finally {
      setLoadingDossier(false)
    }
  }, [])

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar — flush strip between the app header and the module */}
      <div className="flex flex-wrap items-center gap-3 px-4 md:px-6 py-2.5 bg-brand-navy flex-shrink-0">
        <div className="flex items-center gap-2 text-white">
          <Swords className="w-5 h-5 text-brand-red" />
          <span className="font-bold tracking-wide">BROADSIDE</span>
          <span className="hidden sm:inline text-white/40 text-xs italic">Take the hit before it&apos;s real.</span>
          <span className="text-xs bg-white/15 text-white px-1.5 py-0.5 rounded-full">Beta</span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {loadedTitle && (
            <span className="hidden md:flex items-center gap-1.5 text-xs text-white/60">
              <FileText className="w-3.5 h-3.5" /> Loaded: {loadedTitle}
            </span>
          )}
          {loadingDossier && <Loader2 className="w-4 h-4 text-white/60 animate-spin" />}
          <div className="relative">
            <select
              value={selectedId}
              onChange={e => loadDossier(e.target.value)}
              disabled={!frameReady}
              className="appearance-none bg-white/10 text-white text-sm rounded-lg pl-3 pr-8 py-1.5 border border-white/15 focus:outline-none focus:border-brand-red disabled:opacity-50 max-w-56"
            >
              <option value="" className="text-gray-900">Load a Profiler dossier…</option>
              {dossiers.map(d => (
                <option key={d.id} value={d.id} className="text-gray-900">{d.title || 'Untitled dossier'}</option>
              ))}
            </select>
            <ChevronDown className="w-4 h-4 text-white/50 absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none" />
          </div>
        </div>
        {error && <p className="w-full text-xs text-red-300 -mt-1">{error}</p>}
      </div>

      {/* The module */}
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
