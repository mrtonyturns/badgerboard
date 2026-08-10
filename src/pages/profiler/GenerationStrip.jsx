// src/pages/profiler/GenerationStrip.jsx — the in-flight state (SPEC §1).
//
// Four stages, each with its own track and status, driven by the REAL backend
// phase written to `dossier_generation_progress` by generate-dossier-background
// (reportStage()). Never a timer: if the row hasn't appeared yet we show stage 1
// as loading, which is exactly what is happening.
//
//   State   | Track                  | Dot          | Label
//   Done    | solid green fill       | green check  | Done
//   Loading | light red + shimmer    | spinning     | Loading
//   Queued  | light grey             | hollow ring  | Queued

import React, { useEffect, useState } from 'react'
import { T, cardStyle, elapsedLabel } from './shared'

export const STAGE_LABELS = [
  'Identifying the person',
  'Searching press & filings',
  'Drafting 14 sections',
  'Verifying claims',
]

export default function GenerationStrip({ candidateName, startedAt, stage = 1, status = 'running', onCancel, onRetry }) {
  // Re-render on a slow tick purely so the elapsed label stays true.
  const [, setTick] = useState(0)
  useEffect(() => {
    if (status !== 'running') return
    const iv = setInterval(() => setTick(t => t + 1), 5000)
    return () => clearInterval(iv)
  }, [status])

  const failed   = status === 'error'
  const complete = status === 'done'
  const activeIx = complete ? STAGE_LABELS.length : Math.min(Math.max(Number(stage) || 1, 1), 4) - 1

  return (
    <div style={{ ...cardStyle, border: `1px solid ${failed ? '#FBD5D5' : '#DDE1E7'}`, padding: '16px 22px', marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 11, marginBottom: 12, flexWrap: 'wrap' }}>
        <span style={{
          width: 7, height: 7, borderRadius: '50%', flex: 'none',
          background: failed ? '#B91C1C' : complete ? T.green : T.red,
          animation: failed || complete ? 'none' : 'pfPulse 1.6s infinite',
        }} />
        <span style={{ fontSize: 13.5, fontWeight: 700 }}>
          {failed ? 'Generation failed' : complete ? 'Finished' : 'Generating'}
          {candidateName ? ` — ${candidateName}` : ''}
        </span>
        <span style={{ fontSize: 11.5, color: T.muted }}>
          {failed
            ? `Stopped during "${STAGE_LABELS[activeIx]}". No profile was saved.`
            : complete
              ? 'Adding it to your profiles now'
              : `${elapsedLabel(startedAt)} · you can leave this page`}
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 14 }}>
          {failed && onRetry && (
            <button
              type="button" onClick={onRetry}
              style={{
                background: 'none', border: 0, padding: 0, cursor: 'pointer', fontFamily: 'inherit',
                fontSize: 11.5, fontWeight: 600, color: T.red, textDecoration: 'underline',
              }}
            >Try again</button>
          )}
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              title={failed ? 'Dismiss this message' : 'Stop watching here — a job that already started still finishes and saves'}
              style={{
                background: 'none', border: 0, padding: 0, cursor: 'pointer', fontFamily: 'inherit',
                fontSize: 11.5, color: T.muted, textDecoration: 'underline',
              }}
            >{failed ? 'Dismiss' : 'Cancel'}</button>
          )}
        </div>
      </div>

      <div className="pf-stages" style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        {STAGE_LABELS.map((label, i) => {
          const done   = i < activeIx
          const active = i === activeIx && !failed
          const errored = i === activeIx && failed
          const mark = done ? 'Done' : errored ? 'Failed' : active ? 'Loading' : 'Queued'
          const markColor = done ? T.green : errored ? '#B91C1C' : active ? T.red : T.faint
          return (
            <div key={label} style={{
              flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 7,
              transition: 'all .45s cubic-bezier(.2,.8,.2,1)',
            }}>
              <div style={{
                position: 'relative', height: 5, borderRadius: 99, overflow: 'hidden',
                background: done ? T.green : errored ? '#FBD5D5' : active ? '#F6E6E7' : T.track,
              }}>
                {done && <div style={{ position: 'absolute', inset: 0, background: T.green, borderRadius: 99 }} />}
                {active && (
                  <div style={{
                    position: 'absolute', top: 0, bottom: 0, left: 0, width: '38%', borderRadius: 99,
                    background: 'linear-gradient(90deg,rgba(165,28,36,0),rgba(165,28,36,.95),rgba(165,28,36,0))',
                    animation: 'pfSlide 1.5s linear infinite',
                  }} />
                )}
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {active && (
                  <span style={{
                    flex: 'none', width: 11, height: 11, borderRadius: '50%',
                    border: '2px solid #F0D9DB', borderTopColor: T.red,
                    animation: 'pfSpin .8s linear infinite',
                  }} />
                )}
                {done && (
                  <span style={{
                    flex: 'none', width: 11, height: 11, borderRadius: '50%', background: T.green,
                    color: '#fff', fontSize: 11, lineHeight: '11px', textAlign: 'center',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                    <svg width="7" height="7" viewBox="0 0 12 12" aria-hidden="true">
                      <path d="M1.5 6.2 4.4 9 10.5 2.8" fill="none" stroke="#fff" strokeWidth="2.4"
                        strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </span>
                )}
                {errored && (
                  <span style={{
                    flex: 'none', width: 11, height: 11, borderRadius: '50%', background: '#B91C1C',
                    color: '#fff', fontSize: 11, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                    <svg width="7" height="7" viewBox="0 0 12 12" aria-hidden="true">
                      <path d="M2 2l8 8M10 2l-8 8" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" />
                    </svg>
                  </span>
                )}
                {!done && !active && !errored && (
                  <span style={{ flex: 'none', width: 11, height: 11, borderRadius: '50%', border: '2px solid #E4E1DC' }} />
                )}
                <span style={{
                  fontSize: 11, fontWeight: 700, letterSpacing: '.7px', color: markColor,
                  transition: 'color .45s ease',
                }}>{mark}</span>
              </div>

              <span style={{
                fontSize: active ? 15 : 11.5,
                fontWeight: active ? 700 : done ? 600 : 500,
                color: done ? T.green : active ? T.ink : T.muted,
                opacity: active ? 1 : done ? 0.9 : 0.75,
                lineHeight: 1.3,
                animation: active ? 'pfBreathe 2.6s ease-in-out infinite' : 'none',
                transition: 'font-size .45s cubic-bezier(.2,.8,.2,1), color .45s ease, opacity .45s ease',
              }}>{label}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
