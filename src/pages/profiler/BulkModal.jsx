// src/pages/profiler/BulkModal.jsx — bulk generate (SPEC-profiler §2).
//
// Three states, all reachable: empty · loaded · failed. Parsing is real (see
// bulkCsv.js / lib/csv.js) and the error state is gated on "a file was parsed",
// not on row count — a CSV with no `name` column parses fine and yields zero
// usable rows, which is exactly the case the red state exists for.
//
// The run itself belongs to the parent (it needs auth + the generate flow); the
// modal only reports per-row progress and can be closed while it continues.

import React, { useRef, useState } from 'react'
import { T, Btn, Spinner, plural } from './shared'
import { parseBulkCsv, bulkFailure, BULK_COLUMNS, rowOfficeLabel } from './bulkCsv'

const MAX_BYTES = 5 * 1024 * 1024
const MAX_ROWS  = 200

export default function BulkModal({ open, onClose, balance, onRun, runState }) {
  const [fileName, setFileName] = useState('')
  const [parsed, setParsed]     = useState(null)   // parseBulkCsv result
  const [failure, setFailure]   = useState(null)   // { title, body }
  const [truncated, setTruncated] = useState(0)
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef(null)

  if (!open) return null

  const reset = () => { setFileName(''); setParsed(null); setFailure(null); setTruncated(0) }
  const close = () => { reset(); onClose() }

  const readFile = (file) => {
    if (!file) return
    setFileName(file.name)
    setTruncated(0)
    if (file.size > MAX_BYTES) {
      setParsed(null)
      setFailure({
        title: 'That file is larger than 5 MB',
        body: 'Split it into smaller files and upload them one at a time.',
      })
      return
    }
    const reader = new FileReader()
    reader.onerror = () => {
      setParsed(null)
      setFailure({ title: 'That file could not be read', body: 'Re-export it as a plain .csv and try again.' })
    }
    reader.onload = () => {
      const result = parseBulkCsv(String(reader.result || ''))
      if (!result.ok) {
        setParsed(result)
        setFailure(bulkFailure(result))
        return
      }
      if (result.rows.length > MAX_ROWS) {
        setTruncated(result.rows.length - MAX_ROWS)
        result.rows = result.rows.slice(0, MAX_ROWS)
      }
      setParsed(result)
      setFailure(null)
    }
    reader.readAsText(file)
  }

  const rows      = parsed?.ok ? parsed.rows : []
  const loaded    = rows.length > 0
  const failed    = !!failure
  const noCtx     = rows.filter(r => !(r.research_context || '').trim()).length
  const unlimited = !!balance?.unlimited
  const left      = Number(balance?.left ?? 0)
  const overBy    = unlimited ? 0 : Math.max(0, rows.length - left)
  const running   = !!runState

  const footNote = running
    ? 'Running in the background — you can close this window and keep working.'
    : failed
      ? 'Fix the file and upload again — nothing has been generated.'
      : loaded
        ? (overBy > 0
            ? `${plural(rows.length, 'profile')} ${rows.length === 1 ? 'needs' : 'need'} ${overBy} more than the ${left} left on your plan. Buy a credit pack to run the whole file, or trim it to ${plural(left, 'row')}.`
            : unlimited
              ? `${plural(rows.length, 'profile')}. Each takes 2–4 minutes and runs in the background.`
              : `Uses ${rows.length} of the ${plural(left, 'profile')} left on your plan, leaving ${left - rows.length}. Each takes 2–4 minutes and runs in the background.`)
        : unlimited
          ? 'This plan has no monthly profile cap. Each row becomes a full 14-section profile.'
          : `${left} of ${balance?.limit} profiles left on your plan this month. Each row becomes a full 14-section profile and uses one.`

  const canRun = loaded && !running && overBy === 0

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Bulk generate profiles"
      onClick={close}
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
          width: '100%', maxWidth: 760, maxHeight: '100%', display: 'flex', flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <div style={{
          display: 'flex', alignItems: 'flex-start', gap: 14,
          padding: '20px 24px 16px', borderBottom: `1px solid ${T.divider}`,
        }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 16.5, fontWeight: 700 }}>Bulk generate profiles</div>
            <div style={{ fontSize: 12.5, color: T.muted, marginTop: 3, lineHeight: 1.5 }}>
              Upload a CSV of candidates and Profiler builds a full 14-section profile for each one.
            </div>
          </div>
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            style={{
              marginLeft: 'auto', flex: 'none', width: 34, height: 34, borderRadius: 8,
              border: 0, background: 'transparent', color: T.ink4, fontSize: 16, cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = T.chip }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
              <path d="M1.5 1.5l9 9M10.5 1.5l-9 9" fill="none" stroke="currentColor"
                strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px 22px' }}>

          {/* ── Running ─────────────────────────────────────────────────── */}
          {running && <RunProgress runState={runState} />}

          {/* ── Failed ──────────────────────────────────────────────────── */}
          {!running && failed && (
            <div style={{
              background: '#FEF2F2', border: '1px solid #FBD5D5', borderRadius: 14,
              padding: '18px 20px', marginBottom: 14,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 11, marginBottom: 7 }}>
                <span style={{
                  flex: 'none', width: 32, height: 32, borderRadius: 8, background: '#FBEAEA',
                  color: '#B91C1C', fontSize: 11, fontWeight: 800,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>CSV</span>
                <div style={{ minWidth: 0 }}>
                  <div style={{
                    fontSize: 12.5, fontWeight: 700, whiteSpace: 'nowrap',
                    overflow: 'hidden', textOverflow: 'ellipsis',
                  }}>{fileName}</div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: '#B91C1C', marginTop: 1 }}>
                    Could not use this file
                  </div>
                </div>
              </div>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: '#B91C1C', marginTop: 9 }}>{failure.title}</div>
              <div style={{ fontSize: 12, color: T.ink4, lineHeight: 1.6, marginTop: 4 }}>{failure.body}</div>
              {parsed?.rawHeaders?.length > 0 && (
                <div style={{ fontSize: 11.5, color: T.muted, marginTop: 8 }}>
                  Columns found: {parsed.rawHeaders.join(', ')}
                </div>
              )}
              <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
                <Btn kind="primary" onClick={() => inputRef.current?.click()}>Choose another file</Btn>
                <a
                  href="/bulk-profile-template.csv"
                  download
                  style={{
                    background: '#fff', border: `1px solid ${T.field}`, color: T.ink4,
                    borderRadius: 99, padding: '8px 15px', fontSize: 12, fontWeight: 600,
                    textDecoration: 'none', minHeight: 44, display: 'inline-flex', alignItems: 'center',
                  }}
                >Download template</a>
              </div>
            </div>
          )}

          {/* ── Empty ───────────────────────────────────────────────────── */}
          {!running && !loaded && !failed && (
            <>
              <label
                onDragOver={e => { e.preventDefault(); setDragging(true) }}
                onDragLeave={() => setDragging(false)}
                onDrop={e => {
                  e.preventDefault(); setDragging(false)
                  readFile(e.dataTransfer?.files?.[0])
                }}
                style={{
                  display: 'block', textAlign: 'center', cursor: 'pointer',
                  border: `1.5px dashed ${dragging ? T.red : T.field}`,
                  background: dragging ? '#FEFAFA' : 'transparent',
                  borderRadius: 14, padding: '34px 20px',
                }}
              >
                <input
                  ref={inputRef}
                  type="file"
                  accept=".csv,text/csv"
                  onChange={e => { readFile(e.target.files?.[0]); e.target.value = '' }}
                  style={{ display: 'none' }}
                />
                <div style={{ fontSize: 14, fontWeight: 700 }}>Drop your CSV here, or click to browse</div>
                <div style={{ fontSize: 12, color: T.muted, marginTop: 6 }}>
                  One candidate per row · up to 200 rows · 5 MB max
                </div>
              </label>

              <div style={{
                display: 'flex', alignItems: 'center', gap: 14, background: T.hover,
                border: `1px solid ${T.line}`, borderRadius: 12, padding: '14px 18px', marginTop: 14,
                flexWrap: 'wrap',
              }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 700 }}>Not sure how to format it?</div>
                  <div style={{ fontSize: 11.5, color: T.muted, marginTop: 3, lineHeight: 1.5 }}>
                    Download the template — 12 example rows already filled in the way Profiler reads best.
                  </div>
                </div>
                <a
                  href="/bulk-profile-template.csv"
                  download
                  style={{
                    marginLeft: 'auto', flex: 'none', background: T.red, color: '#fff',
                    borderRadius: 99, padding: '8px 15px', fontSize: 12, fontWeight: 600,
                    textDecoration: 'none', whiteSpace: 'nowrap', minHeight: 44,
                    display: 'inline-flex', alignItems: 'center',
                  }}
                >Download template</a>
              </div>

              <div style={{ marginTop: 18 }}>
                <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.9px', color: T.ink4, marginBottom: 9 }}>
                  COLUMNS
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                  {BULK_COLUMNS.map(c => (
                    <div key={c.key} style={{ display: 'flex', gap: 12, alignItems: 'baseline', flexWrap: 'wrap' }}>
                      <span style={{
                        flex: 'none', width: 132, fontSize: 12, fontWeight: 700, color: T.ink,
                        fontFamily: 'ui-monospace,SFMono-Regular,monospace',
                      }}>{c.key}</span>
                      <span style={{ flex: 'none', width: 94, fontSize: 11, fontWeight: 700, color: c.reqColor }}>
                        {c.req}
                      </span>
                      <span style={{ fontSize: 12.5, color: T.ink4, lineHeight: 1.5, flex: 1, minWidth: 180 }}>
                        {c.note}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}

          {/* ── Loaded ──────────────────────────────────────────────────── */}
          {!running && loaded && (
            <>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 12, background: T.hover,
                border: `1px solid ${T.line}`, borderRadius: 12, padding: '12px 16px', marginBottom: 14,
              }}>
                <span style={{
                  flex: 'none', width: 32, height: 32, borderRadius: 8, background: '#E6F5EC',
                  color: T.green, fontSize: 11, fontWeight: 800,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>CSV</span>
                <div style={{ minWidth: 0 }}>
                  <div style={{
                    fontSize: 12.5, fontWeight: 600, whiteSpace: 'nowrap',
                    overflow: 'hidden', textOverflow: 'ellipsis',
                  }}>{fileName}</div>
                  <div style={{ fontSize: 11, color: T.muted, marginTop: 1 }}>
                    {plural(rows.length, 'candidate')} found · {rows.length - noCtx} with research context
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => { reset(); setTimeout(() => inputRef.current?.click(), 0) }}
                  style={{
                    marginLeft: 'auto', flex: 'none', background: 'none', border: 0, cursor: 'pointer',
                    fontFamily: 'inherit', fontSize: 11.5, fontWeight: 600, color: T.faint,
                    textDecoration: 'underline', padding: '8px 0',
                  }}
                >Replace</button>
              </div>

              {(noCtx > 0 || truncated > 0) && (
                <div style={{
                  background: T.warmBg, border: `1px solid ${T.warmBr}`, borderRadius: 12,
                  padding: '12px 16px', marginBottom: 14,
                }}>
                  {truncated > 0 && (
                    <div style={{ fontSize: 12.5, fontWeight: 700, color: T.amber, marginBottom: 4 }}>
                      Only the first 200 rows will be used — {plural(truncated, 'row')} ignored
                    </div>
                  )}
                  {noCtx > 0 && (
                    <>
                      <div style={{ fontSize: 12.5, fontWeight: 700, color: T.amber, marginBottom: 4 }}>
                        {noCtx === 1 ? '1 row has' : `${noCtx} rows have`} no research context
                      </div>
                      <div style={{ fontSize: 12, color: T.ink4, lineHeight: 1.55 }}>
                        Those profiles will still generate, but context (city, employer, profession) makes the AI
                        far more likely to find the right person — especially for common names and
                        pre-announcement candidates.
                      </div>
                    </>
                  )}
                </div>
              )}

              <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, marginBottom: 9 }}>
                <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.9px', color: T.ink4 }}>PREVIEW</span>
                <span style={{ fontSize: 11.5, color: T.muted }}>{plural(rows.length, 'row')} ready</span>
              </div>
              <div style={{ border: `1px solid ${T.line}`, borderRadius: 12, overflow: 'hidden' }}>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 12, padding: '8px 14px',
                  background: T.hover, borderBottom: `1px solid ${T.line}`,
                }}>
                  <span style={{ flex: 1, minWidth: 0, fontSize: 11, fontWeight: 700, letterSpacing: '.7px', color: T.ink4 }}>NAME</span>
                  <span style={{ flex: 'none', width: 150, fontSize: 11, fontWeight: 700, letterSpacing: '.7px', color: T.ink4 }}>OFFICE</span>
                  <span style={{ flex: 'none', width: 96, fontSize: 11, fontWeight: 700, letterSpacing: '.7px', color: T.ink4 }}>CONTEXT</span>
                </div>
                {rows.slice(0, 6).map((r, i) => {
                  const ctx = (r.research_context || '').trim()
                  return (
                    <div key={i} style={{
                      display: 'flex', alignItems: 'center', gap: 12, padding: '9px 14px',
                      borderBottom: '1px solid #F5F4F1',
                    }}>
                      <span style={{
                        flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 500,
                        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                      }}>{r.name}</span>
                      <span style={{
                        flex: 'none', width: 150, fontSize: 12, color: T.ink4,
                        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                      }}>{rowOfficeLabel(r) || '—'}</span>
                      <span style={{
                        flex: 'none', width: 96, fontSize: 11, fontWeight: 700,
                        color: ctx ? T.green : T.amber,
                      }}>{ctx ? 'Provided' : 'Missing'}</span>
                    </div>
                  )
                })}
                {rows.length > 6 && (
                  <div style={{ padding: '9px 14px', fontSize: 11.5, color: T.muted }}>
                    + {plural(rows.length - 6, 'more row')}
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        <div style={{
          display: 'flex', alignItems: 'center', gap: 10, padding: '15px 24px',
          borderTop: `1px solid ${T.divider}`, background: '#FCFCFB', flexWrap: 'wrap',
        }}>
          <span style={{ fontSize: 11.5, color: T.muted, lineHeight: 1.5, flex: 1, minWidth: 220 }}>
            {footNote}
          </span>
          <Btn onClick={close}>{running ? 'Close' : 'Cancel'}</Btn>
          {!running && (
            <Btn
              kind="primary"
              disabled={!canRun}
              onClick={() => canRun && onRun(rows)}
              title={overBy > 0 ? 'More rows than profiles left on your plan' : undefined}
            >
              {loaded ? `Generate ${plural(rows.length, 'profile')}` : 'Generate profiles'}
            </Btn>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Per-row queue state ─────────────────────────────────────────────────────

const STATUS_META = {
  queued:  { label: 'Queued',  color: T.muted },
  started: { label: 'Started', color: T.green },
  error:   { label: 'Failed',  color: '#B91C1C' },
}

function RunProgress({ runState }) {
  const { rows = [], done } = runState
  const started = rows.filter(r => r.status === 'started').length
  const failed  = rows.filter(r => r.status === 'error').length

  return (
    <>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 11, background: T.hover,
        border: `1px solid ${T.line}`, borderRadius: 12, padding: '12px 16px', marginBottom: 14,
      }}>
        {!done && <Spinner />}
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 12.5, fontWeight: 700 }}>
            {done
              ? `${started} of ${plural(rows.length, 'profile')} started`
              : `Starting ${plural(rows.length, 'profile')}…`}
          </div>
          <div style={{ fontSize: 11.5, color: T.muted, marginTop: 2, lineHeight: 1.5 }}>
            {done
              ? 'Each one takes 2–4 minutes. They appear in the table below as they land.'
              : 'Each request is sent a few seconds apart so the research jobs queue cleanly.'}
            {failed > 0 && ` ${plural(failed, 'row')} could not be started.`}
          </div>
        </div>
      </div>

      <div style={{ border: `1px solid ${T.line}`, borderRadius: 12, overflow: 'hidden' }}>
        {rows.map((r, i) => {
          const meta = STATUS_META[r.status] || STATUS_META.queued
          return (
            <div key={i} style={{
              display: 'flex', alignItems: 'center', gap: 12, padding: '9px 14px',
              borderBottom: i === rows.length - 1 ? 'none' : '1px solid #F5F4F1',
            }}>
              <span style={{
                flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 500,
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}>{r.name}</span>
              {r.error && (
                <span style={{
                  flex: 'none', maxWidth: 260, fontSize: 11.5, color: T.muted,
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }} title={r.error}>{r.error}</span>
              )}
              <span style={{ flex: 'none', width: 70, textAlign: 'right', fontSize: 11, fontWeight: 700, color: meta.color }}>
                {meta.label}
              </span>
            </div>
          )
        })}
      </div>
    </>
  )
}
