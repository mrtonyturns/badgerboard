import React, { useState, useEffect, useRef, useCallback } from 'react'
import { Swords, FileText, ChevronDown, Loader2 } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'

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
      cp.loadDossier(data.content)
      setLoadedTitle(data.title || 'Dossier')
    } catch (e) {
      console.error('[Broadside] dossier load failed:', e)
      setError('Could not load that dossier into Broadside.')
    } finally {
      setLoadingDossier(false)
    }
  }, [])

  return (
    <div className="flex flex-col h-[calc(100vh-8rem)] md:h-[calc(100vh-7rem)]">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3 px-4 py-3 bg-brand-navy rounded-t-xl">
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
        className="flex-1 w-full border-0 rounded-b-xl bg-white"
      />
    </div>
  )
}
