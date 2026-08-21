import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react'
import { supabase } from '../lib/supabase'

// ─── Dossier Status Context ───────────────────────────────────────────────────
// Provides global state for dossier generation progress so the header status
// icon in Layout.jsx can reflect real-time generation state from any page.
//
// States:
//   idle        — no generation running, no recent completion
//   generating  — a dossier is actively being generated (spinner)
//   ready       — generation just completed, user hasn't viewed it yet (green badge)
//
// State is persisted to sessionStorage so it survives page refreshes within the
// same browser session. The 'generating' phase is restored visually after a
// refresh (showing the spinner) so the user knows a dossier is still in progress.
//
// Detection strategy:
//   Primary:  Supabase Realtime channel — fires the instant a new dossier row is
//             inserted.  Reliable, zero polling overhead, immune to timestamp skew.
//             This is the fix for the "spinner never shows Ready" bug — the old
//             approach relied on polling in Dossiers.jsx which could miss the new
//             row if getDossiers returned null data or there was clock skew.
//   Fallback: 15-second polling loop that runs alongside Realtime in case the
//             websocket isn't available (e.g. corporate network firewall).

const STORAGE_KEY = 'badgerboard_dossier_status'
// Matches GENERATION_MAX_WAIT_MS in Dossiers.jsx and the background function's
// own 15-minute budget. At six minutes this context used to drop a perfectly
// healthy run, which took the resume-after-refresh poll down with it.
const MAX_GENERATING_AGE_MS = 15 * 60 * 1000

function loadFromStorage() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    // If we were generating but it's been longer than MAX_GENERATING_AGE_MS
    // (15 min), treat as idle — the background function timed out or failed,
    // and the user can try again.
    if (parsed.phase === 'generating' && parsed.startedAt) {
      const age = Date.now() - new Date(parsed.startedAt).getTime()
      if (age > MAX_GENERATING_AGE_MS) return null
    }
    return parsed
  } catch {
    return null
  }
}

function saveToStorage(state) {
  try {
    if (state.phase === 'idle') {
      sessionStorage.removeItem(STORAGE_KEY)
    } else {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    }
  } catch {
    // sessionStorage unavailable (private browsing, quota exceeded) — silently ignore
  }
}

const INITIAL_STATE = {
  phase:          'idle',    // 'idle' | 'generating' | 'ready'
  candidateName:  '',
  candidateId:    null,      // UUID — stored so Dossiers.jsx can resume polling after refresh
  readyDossier:   null,      // { id, candidateName, generatedAt }
  startedAt:      null,      // ISO string — when generation started
}

const DossierStatusContext = createContext(null)

export function DossierStatusProvider({ children }) {
  const [state, setState] = useState(() => {
    const stored = loadFromStorage()
    return stored ? { ...INITIAL_STATE, ...stored } : INITIAL_STATE
  })

  // Keep sessionStorage in sync whenever state changes
  useEffect(() => {
    saveToStorage(state)
  }, [state])

  const startGeneration = useCallback((candidateName, candidateId = null) => {
    setState({
      phase:         'generating',
      candidateName,
      candidateId,
      readyDossier:  null,
      startedAt:     new Date().toISOString(),
    })
  }, [])

  const setReady = useCallback(({ id, candidateName }) => {
    setState({
      phase:         'ready',
      candidateName: '',
      candidateId:   null,  // clear so stale ID isn't persisted to sessionStorage in ready phase
      readyDossier:  { id, candidateName, generatedAt: new Date().toISOString() },
      startedAt:     null,
    })
  }, [])

  const clearStatus = useCallback(() => {
    setState(INITIAL_STATE)
  }, [])

  // ── Realtime detection + fallback polling ────────────────────────────────
  // Subscribe to INSERT events on the dossiers table while phase=generating.
  // Fires setReady() the instant the background function saves the row —
  // regardless of which page the user is on, and regardless of whether the
  // polling in Dossiers.jsx has timed out or missed the row.
  const firedRef     = useRef(false)  // idempotent guard
  const channelRef   = useRef(null)
  const fallbackRef  = useRef(null)

  useEffect(() => {
    if (state.phase !== 'generating' || !state.candidateId) return

    firedRef.current = false
    const { candidateId, candidateName, startedAt } = state

    const markReady = (id, rawTitle) => {
      if (firedRef.current) return
      firedRef.current = true
      const name = rawTitle
        ? rawTitle.replace(/^Political Profile\s*[—–-]\s*/i, '').trim() || candidateName
        : candidateName
      setReady({ id, candidateName: name })
    }

    // ── Primary: Supabase Realtime ───────────────────────────────────────
    const ch = supabase
      .channel(`dossier-ready-${candidateId}`)
      .on(
        'postgres_changes',
        {
          event:  'INSERT',
          schema: 'public',
          table:  'dossiers',
          filter: `candidate_id=eq.${candidateId}`,
        },
        ({ new: row }) => {
          // Guard: ignore a row that predates this generation run
          const rowTime = row.generated_at || row.created_at || ''
          if (startedAt && rowTime && rowTime < startedAt) return
          markReady(row.id, row.title)
        }
      )
      .subscribe()
    channelRef.current = ch

    // ── Fallback: poll every 15s in case websocket is blocked ────────────
    const deadline = startedAt
      ? new Date(startedAt).getTime() + MAX_GENERATING_AGE_MS
      : Date.now() + MAX_GENERATING_AGE_MS

    const poll = async () => {
      if (firedRef.current) return
      if (Date.now() >= deadline) { clearStatus(); return }

      try {
        const { data: { user } } = await supabase.auth.getUser()
        if (user) {
          let q = supabase
            .from('dossiers')
            .select('id, generated_at, created_at, title')
            .eq('candidate_id', candidateId)
            .eq('generated_by', user.id)
            .order('created_at', { ascending: false })
            .limit(1)
          if (startedAt) q = q.gte('created_at', startedAt)
          const { data } = await q
          if (data?.length) { markReady(data[0].id, data[0].title); return }
        }
      } catch { /* transient — retry next tick */ }

      if (!firedRef.current) {
        fallbackRef.current = setTimeout(poll, 15000)
      }
    }

    // Start fallback after 15s so Realtime gets first shot
    fallbackRef.current = setTimeout(poll, 15000)

    return () => {
      if (channelRef.current) { supabase.removeChannel(channelRef.current); channelRef.current = null }
      if (fallbackRef.current) { clearTimeout(fallbackRef.current); fallbackRef.current = null }
      firedRef.current = false
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.phase, state.candidateId])

  return (
    <DossierStatusContext.Provider value={{ ...state, startGeneration, setReady, clearStatus }}>
      {children}
    </DossierStatusContext.Provider>
  )
}

export function useDossierStatus() {
  const ctx = useContext(DossierStatusContext)
  // Safe fallback when used outside provider (shouldn't happen in prod)
  if (!ctx) {
    return {
      phase:           'idle',
      candidateName:   '',
      candidateId:     null,
      readyDossier:    null,
      startedAt:       null,
      startGeneration: () => {},
      setReady:        () => {},
      clearStatus:     () => {},
    }
  }
  return ctx
}
