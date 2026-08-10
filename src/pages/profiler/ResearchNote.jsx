// src/pages/profiler/ResearchNote.jsx — the structured finding (SPEC §3).
//
// Replaces the reasoning leak. The generator no longer narrates "I need to flag
// a critical discrepancy…" into Section 0; it emits
//   dossiers.research_note = { finding, evidence, suggested_status, source }
// and this renders it as one amber callout above the document, with a resolving
// action when the fix is a status change and a Dismiss that is remembered.

import React, { useState } from 'react'
import { T } from './shared'
import { CANDIDATE_STATUS_LABELS } from '../../lib/campaignEnums'

const DISMISS_KEY = (id) => `bb_research_note_dismissed_${id}`

export function isNoteDismissed(dossierId) {
  if (!dossierId) return false
  try { return localStorage.getItem(DISMISS_KEY(dossierId)) === '1' } catch { return false }
}

export function dismissNote(dossierId) {
  try { localStorage.setItem(DISMISS_KEY(dossierId), '1') } catch { /* private mode — session-only */ }
}

export default function ResearchNote({ dossier, note, onResolveStatus }) {
  const [hidden, setHidden]   = useState(() => isNoteDismissed(dossier?.id))
  const [busy, setBusy]       = useState(false)
  const [resolved, setResolved] = useState(false)
  const [error, setError]     = useState('')

  if (!note || !note.finding || hidden) return null

  const status = note.suggested_status && CANDIDATE_STATUS_LABELS[note.suggested_status]
    ? note.suggested_status
    : null
  const statusLabel = status ? CANDIDATE_STATUS_LABELS[status] : ''
  const canResolve = !!status && !!dossier?.candidate_id && !!onResolveStatus

  const resolve = async () => {
    setBusy(true); setError('')
    try {
      await onResolveStatus(status)
      setResolved(true)
      setTimeout(() => setHidden(true), 1200)
    } catch (e) {
      setError(e?.message || 'Could not update the candidate record.')
    }
    setBusy(false)
  }

  return (
    <div style={{
      display: 'flex', gap: 12, background: T.warmBg, border: `1px solid ${T.warmBr}`,
      borderRadius: 14, padding: '14px 18px', marginBottom: 16,
    }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '1px', color: T.amber, marginBottom: 5 }}>
          RESEARCH NOTE
        </div>
        <div style={{ fontSize: 13, lineHeight: 1.6, color: T.ink3, maxWidth: '88ch' }}>
          {note.finding}
        </div>
        {note.evidence && (
          <div style={{ fontSize: 11.5, color: T.muted, lineHeight: 1.55, marginTop: 6, maxWidth: '88ch' }}>
            Evidence: {note.evidence}
          </div>
        )}
        {note.source === 'captured-preamble' && (
          <div style={{ fontSize: 11, color: T.muted, marginTop: 6 }}>
            Captured from the model's own note on this run rather than a structured finding — treat it as a lead, not a conclusion.
          </div>
        )}
        {error && (
          <div style={{ fontSize: 11.5, color: '#B91C1C', marginTop: 8 }}>{error}</div>
        )}
        <div style={{ display: 'flex', gap: 7, marginTop: 11, flexWrap: 'wrap' }}>
          {canResolve && (
            <button
              type="button"
              disabled={busy || resolved}
              onClick={resolve}
              style={{
                background: T.red, color: '#fff', border: 0, borderRadius: 99,
                padding: '9px 14px', fontSize: 11.5, fontWeight: 600, fontFamily: 'inherit',
                cursor: busy || resolved ? 'default' : 'pointer', opacity: busy ? 0.6 : 1, minHeight: 36,
              }}
            >
              {resolved ? `Status set to ${statusLabel}` : busy ? 'Updating…' : `Set status to ${statusLabel}`}
            </button>
          )}
          <button
            type="button"
            onClick={() => { dismissNote(dossier?.id); setHidden(true) }}
            style={{
              background: '#fff', border: '1px solid #E8D5C0', color: T.ink4, borderRadius: 99,
              padding: '9px 14px', fontSize: 11.5, fontWeight: 600, fontFamily: 'inherit',
              cursor: 'pointer', minHeight: 36,
            }}
          >Dismiss</button>
        </div>
      </div>
    </div>
  )
}
