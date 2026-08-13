import React, { createContext, useContext, useState, useCallback, useEffect } from 'react'

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
    // If we were generating but it's been more than 6 minutes, treat as idle
    // (background function timed out or failed; user can try again)
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
      phase:          'idle',
      candidateName:  '',
      candidateId:    null,
      readyDossier:   null,
      startedAt:      null,
      startGeneration: () => {},
      setReady:       () => {},
      clearStatus:    () => {},
    }
  }
  return ctx
}
