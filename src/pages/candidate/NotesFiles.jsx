// candidate/NotesFiles.jsx — SPEC-candidate-profile.md §7.
//
// The notes and documents themselves are the EXISTING v2 JSON store in
// candidates.notes ({ v:2, notes:[], files:[] }) and the existing
// `candidate-files` storage bucket. Per-item ai_access chips are unchanged.
//
// What is new is the section-level control: a candidate-level AI lock backed by
// candidates.ai_access_notes / ai_access_locked_at and the
// /.netlify/functions/candidate-ai-lock endpoint. Locking is instant; unlocking
// is free for five minutes and password-confirmed after that. The password is
// never compared here — it is posted to the endpoint, which is also responsible
// for the audit log entry.

import React, { useEffect, useRef, useState } from 'react'
import { format } from 'date-fns'
import { supabase, updateCandidate } from '../../lib/supabase'
import {
  T, Card, EmptyState, Btn, TextLink,
  parseNotesData, fileGlyph, FILE_TILE, formatBytes,
} from './shared'

export const GRACE_MS = 5 * 60 * 1000
const MAX_BYTES = 25 * 1024 * 1024

// ── Lock state ────────────────────────────────────────────────────────────────
// Read from the candidate row in exactly one place so every consumer (this
// view, the section pill, the nav's AI OFF marker) agrees.
export function readLockState(candidate) {
  const locked = candidate?.ai_access_notes === false
  const lockedAt = locked ? candidate?.ai_access_locked_at || null : null
  const graceLeft = locked && lockedAt
    ? Math.max(0, GRACE_MS - (Date.now() - Date.parse(lockedAt)))
    : 0
  return { locked, lockedAt, graceLeft, inGrace: locked && graceLeft > 0 }
}

export function graceText(ms) {
  const mm = Math.floor(ms / 60000)
  const ss = Math.floor((ms % 60000) / 1000)
  return `${mm}:${String(ss).padStart(2, '0')}`
}

const LOCK_COPY = {
  on: 'Profiler, Compare, Broadside and the weekly monitoring refresh can read these notes and documents and factor them into what they generate.',
  off: 'Nothing below is sent to any AI feature. Profiler, Compare, Broadside and the weekly monitoring refresh cannot read, see, or factor in these notes or documents. They stay visible to your team only.',
}

function AiChip({ on, onClick, busy, disabledReason }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      title={disabledReason || (on ? 'AI features may use this item — click to turn off' : 'AI features may not use this item — click to turn on')}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10,
        fontWeight: 700, borderRadius: 99, padding: '4px 9px', cursor: busy ? 'wait' : 'pointer',
        fontFamily: 'inherit', minHeight: 26,
        border: `1px solid ${on ? '#F4D8D9' : T.border}`,
        background: on ? '#FBEAEA' : T.chip,
        color: on ? T.red : T.faint,
        opacity: disabledReason ? 0.65 : 1,
      }}
    >{on ? 'AI ON' : 'AI OFF'}</button>
  )
}

export default function NotesFiles({ candidate, userId, userName, onSaved, onLockChanged }) {
  const [data, setData] = useState(() => parseNotesData(candidate.notes))
  const [draft, setDraft] = useState('')
  const [savingNote, setSavingNote] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState('')
  const [togglingId, setTogglingId] = useState(null)
  const [busyId, setBusyId] = useState(null)
  const [dragOver, setDragOver] = useState(false)
  const fileRef = useRef(null)

  // Lock UI state
  const [lockBusy, setLockBusy] = useState(false)
  const [lockError, setLockError] = useState('')
  const [pwPrompt, setPwPrompt] = useState(false)
  const [pw, setPw] = useState('')
  const [pwError, setPwError] = useState('')
  const [, forceTick] = useState(0)

  useEffect(() => { setData(parseNotesData(candidate.notes)) }, [candidate.notes])

  // ── lock state is read here, from the candidate row ──
  const lock = readLockState(candidate)

  // Tick once a second while inside the grace window so the countdown is live.
  useEffect(() => {
    if (!lock.locked) return undefined
    const t = setInterval(() => forceTick(n => n + 1), 1000)
    return () => clearInterval(t)
  }, [lock.locked])

  const persist = async (newData) => {
    setData(newData)
    await updateCandidate(candidate.id, { notes: JSON.stringify(newData) })
    onSaved?.()
  }

  // ── notes ──
  const addNote = async () => {
    if (!draft.trim()) return
    setSavingNote(true)
    const note = {
      id: crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36),
      text: draft.trim(),
      ts: new Date().toISOString(),
      by: userName || 'You',
      ai_access: false,   // AI never sees a note unless the user turns it on
    }
    await persist({ ...data, notes: [note, ...(data.notes || [])] })
    setDraft(''); setSavingNote(false)
  }

  const deleteNote = async (noteId) => {
    setBusyId(noteId)
    await persist({ ...data, notes: (data.notes || []).filter(n => n.id !== noteId) })
    setBusyId(null)
  }

  const toggleNoteAi = async (noteId) => {
    setTogglingId(noteId)
    await persist({ ...data, notes: (data.notes || []).map(n => n.id === noteId ? { ...n, ai_access: !n.ai_access } : n) })
    setTogglingId(null)
  }

  // ── files ──
  const uploadFile = async (file) => {
    if (!file) return
    setUploadError('')
    if (file.size > MAX_BYTES) {
      setUploadError(`${file.name} is ${formatBytes(file.size)} — the limit is 25 MB.`)
      return
    }
    setUploading(true)
    const fileId = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36)
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_')
    const path = `${userId}/${candidate.id}/${fileId}-${safeName}`
    try {
      const { error: upErr } = await supabase.storage
        .from('candidate-files')
        .upload(path, file, { cacheControl: '3600', upsert: false })
      if (upErr) throw new Error(upErr.message)
      await persist({
        ...data,
        files: [...(data.files || []), {
          id: fileId, name: file.name, path,
          size: file.size, type: file.type || 'application/octet-stream',
          by: userName || 'You',
          ai_access: false, ts: new Date().toISOString(),
        }],
      })
    } catch (err) {
      setUploadError(err.message || 'Upload failed')
    }
    setUploading(false)
  }

  const toggleFileAi = async (fileId) => {
    setTogglingId(fileId)
    await persist({ ...data, files: (data.files || []).map(f => f.id === fileId ? { ...f, ai_access: !f.ai_access } : f) })
    setTogglingId(null)
  }

  const removeFile = async (file) => {
    if (!window.confirm(`Remove "${file.name}"? This cannot be undone.`)) return
    setBusyId(file.id)
    try { await supabase.storage.from('candidate-files').remove([file.path]) } catch { /* row is removed regardless */ }
    await persist({ ...data, files: (data.files || []).filter(f => f.id !== file.id) })
    setBusyId(null)
  }

  const download = async (file) => {
    const { data: urlData, error } = await supabase.storage
      .from('candidate-files').createSignedUrl(file.path, 3600)
    if (error || !urlData?.signedUrl) { setUploadError('Could not generate a download link.'); return }
    window.open(urlData.signedUrl, '_blank', 'noopener')
  }

  // ── the candidate-level AI lock ──
  const callLock = async (body) => {
    const { data: { session } } = await supabase.auth.getSession()
    const res = await fetch('/.netlify/functions/candidate-ai-lock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token || ''}` },
      body: JSON.stringify({ candidate_id: candidate.id, ...body }),
    })
    let payload = {}
    try { payload = await res.json() } catch { /* non-JSON error body */ }
    return { res, payload }
  }

  const doLock = async () => {
    setLockBusy(true); setLockError('')
    try {
      const { res, payload } = await callLock({ action: 'lock' })
      if (!res.ok) throw new Error(payload.error || `Could not lock (HTTP ${res.status})`)
      setPwPrompt(false); setPw(''); setPwError('')
      await onLockChanged?.()
    } catch (e) {
      setLockError(e.message)
    }
    setLockBusy(false)
  }

  const doUnlock = async (password) => {
    setLockBusy(true); setLockError('')
    try {
      const { res, payload } = await callLock(password ? { action: 'unlock', password } : { action: 'unlock' })
      if (res.status === 401 && payload.error === 'invalid-password') {
        setPw('')
        setPwError('That password is not correct. Try again.')
        setLockBusy(false)
        return
      }
      if (!res.ok) throw new Error(payload.error || `Could not unlock (HTTP ${res.status})`)
      setPwPrompt(false); setPw(''); setPwError('')
      await onLockChanged?.()
    } catch (e) {
      setLockError(e.message)
    }
    setLockBusy(false)
  }

  const onToggleLock = () => {
    if (!lock.locked) { doLock(); return }
    if (lock.graceLeft > 0) { doUnlock(); return }
    setPwPrompt(true); setPw(''); setPwError('')
  }

  const notes = data.notes || []
  const files = data.files || []

  const cardBg     = lock.locked ? '#F6F7F9' : T.warmBg
  const cardBorder = lock.locked ? '#DDE1E7' : T.warmBr
  const labelColor = lock.locked ? T.navy : T.warmInk
  const pillBg     = lock.locked ? '#E4E7EC' : '#F8ECDC'
  const trackBg    = lock.locked ? '#9AA3AF' : T.warmInk
  const shortLabel = lock.locked ? 'AI BLOCKED' : 'AI CAN READ'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* ── the AI access control ── */}
      <div style={{ background: cardBg, border: `1px solid ${cardBorder}`, borderRadius: 16, padding: '18px 22px' }}>
        <div className="cp-head" style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
          <div style={{
            flexShrink: 0, width: 34, height: 34, borderRadius: 10, background: pillBg,
            color: labelColor, display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 11, fontWeight: 800, letterSpacing: '.5px',
          }}>AI</div>

          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13.5, fontWeight: 700, color: labelColor }}>
                {lock.locked ? 'AI access is LOCKED' : 'AI access is ON'}
              </span>
              <span style={{
                fontSize: 9, fontWeight: 700, background: pillBg, color: labelColor,
                borderRadius: 99, padding: '3px 8px', letterSpacing: '.3px',
              }}>NOTES &amp; DOCUMENTS</span>
            </div>
            <div style={{ fontSize: 12, color: T.ink3, lineHeight: 1.55, marginTop: 5, maxWidth: 640 }}>
              {lock.locked ? LOCK_COPY.off : LOCK_COPY.on}
            </div>
            {lock.locked && lock.graceLeft > 0 && (
              <div style={{ fontSize: 11.5, color: T.muted, marginTop: 8 }}>
                You can re-enable AI access without the password for another{' '}
                <span style={{ fontWeight: 700, color: T.ink }}>{graceText(lock.graceLeft)}</span>. After that,
                unlocking requires your account password.
              </div>
            )}
            {lock.locked && lock.graceLeft <= 0 && (
              <div style={{ fontSize: 11.5, color: T.muted, marginTop: 8 }}>
                Locked for more than 5 minutes — re-enabling AI access requires your account password.
              </div>
            )}
            {lockError && (
              <div style={{ fontSize: 11.5, color: T.redHot, marginTop: 8 }}>{lockError}</div>
            )}
          </div>

          <div className="cp-headright" style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 9, minHeight: 44 }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: T.muted }}>{lock.locked ? 'OFF' : 'ON'}</span>
            <button
              type="button"
              role="switch"
              aria-checked={!lock.locked}
              aria-label={lock.locked ? 'Give AI features access to these notes and documents' : 'Block AI features from these notes and documents'}
              disabled={lockBusy}
              onClick={onToggleLock}
              style={{
                width: 34, height: 19, borderRadius: 99, background: trackBg, border: 0,
                position: 'relative', cursor: lockBusy ? 'wait' : 'pointer', padding: 0, flexShrink: 0,
              }}
            >
              <span style={{
                position: 'absolute', top: 2, left: lock.locked ? 2 : 17,
                width: 15, height: 15, borderRadius: '50%', background: '#fff',
                transition: 'left .15s ease',
              }} />
            </button>
          </div>
        </div>

        {pwPrompt && (
          <form
            onSubmit={e => { e.preventDefault(); if (pw) doUnlock(pw) }}
            style={{
              background: '#fff', border: '1px solid #DDE1E7', borderRadius: 12,
              padding: '15px 18px', marginTop: 14, maxWidth: 420,
            }}
          >
            <div style={{ fontSize: 12.5, fontWeight: 700, marginBottom: 3 }}>Confirm your password</div>
            <div style={{ fontSize: 11.5, color: T.muted, lineHeight: 1.5, marginBottom: 11 }}>
              Enter your BadgerBoard account password to give AI features access to these notes and documents again.
            </div>
            <input
              type="password"
              autoFocus
              value={pw}
              onChange={e => { setPw(e.target.value); setPwError('') }}
              placeholder="Account password"
              autoComplete="current-password"
              style={{
                width: '100%', boxSizing: 'border-box', border: '1px solid #DEDEDA', borderRadius: 9,
                padding: '11px 12px', fontSize: 12.5, fontFamily: 'inherit', outline: 'none', minHeight: 44,
              }}
            />
            {pwError && <div style={{ fontSize: 11.5, color: T.redHot, marginTop: 7 }}>{pwError}</div>}
            <div style={{ display: 'flex', gap: 7, marginTop: 12 }}>
              <Btn kind="primary" type="submit" disabled={lockBusy || !pw}>
                {lockBusy ? 'Checking…' : 'Unlock AI access'}
              </Btn>
              <Btn onClick={() => { setPwPrompt(false); setPw(''); setPwError('') }}>Cancel</Btn>
            </div>
          </form>
        )}
      </div>

      {/* ── notes + documents ── */}
      <div className="cp-cols" style={{ display: 'grid', gridTemplateColumns: '1.35fr 1fr', gap: 16, alignItems: 'start' }}>

        <Card style={{ padding: '20px 24px' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, marginBottom: 14, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 14, fontWeight: 700 }}>Notes</span>
            <span style={{ fontSize: 11.5, color: T.faint }}>visible to your team</span>
            <span style={{
              marginLeft: 'auto', fontSize: 9, fontWeight: 700, background: pillBg, color: labelColor,
              borderRadius: 99, padding: '3px 8px', letterSpacing: '.3px',
            }}>{shortLabel}</span>
          </div>

          <textarea
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) addNote() }}
            placeholder="Add a note about this candidate…"
            style={{
              width: '100%', boxSizing: 'border-box', minHeight: 76, border: '1px solid #DEDEDA',
              borderRadius: 11, padding: '11px 13px', fontSize: 12.5, lineHeight: 1.55,
              fontFamily: 'inherit', resize: 'vertical', outline: 'none',
            }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginTop: 10, flexWrap: 'wrap' }}>
            <Btn kind="primary" onClick={addNote} disabled={savingNote || !draft.trim()}>
              {savingNote ? 'Saving…' : 'Save note'}
            </Btn>
            <span style={{ fontSize: 11, color: T.faint }}>
              {lock.locked
                ? 'Saved notes stay hidden from all AI features.'
                : 'A saved note is only read by AI features if you switch that note to AI ON.'}
            </span>
          </div>

          {notes.length === 0 ? (
            <EmptyState
              title="No notes yet"
              body="Anything your team needs to remember about this candidate — a document trail, a conversation, a warning — goes here."
            />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', marginTop: 8 }}>
              {notes.map(n => (
                <div key={n.id} style={{
                  padding: '14px 0', borderTop: `1px solid ${T.divider}`,
                  opacity: busyId === n.id ? 0.5 : 1,
                }}>
                  <div style={{ fontSize: 12.5, lineHeight: 1.6, color: T.ink2, whiteSpace: 'pre-line' }}>{n.text}</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginTop: 6, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 10.5, color: T.faint }}>
                      {[n.by, n.ts ? format(new Date(n.ts), 'MMM d, yyyy · h:mm a') : 'Saved before timestamps were recorded']
                        .filter(Boolean).join(' · ')}
                    </span>
                    <AiChip
                      on={!!n.ai_access}
                      busy={togglingId === n.id}
                      onClick={() => toggleNoteAi(n.id)}
                      disabledReason={lock.locked ? 'AI access is locked for this candidate — nothing here is sent to any AI feature regardless of this switch.' : null}
                    />
                    <span style={{ marginLeft: 'auto' }}>
                      <TextLink onClick={() => deleteNote(n.id)}>Delete</TextLink>
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card style={{ padding: '20px 24px' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, marginBottom: 13 }}>
            <span style={{ fontSize: 14, fontWeight: 700 }}>Documents</span>
            <span style={{ marginLeft: 'auto', fontSize: 11.5, color: T.faint }}>
              {files.length} file{files.length === 1 ? '' : 's'}
            </span>
          </div>

          <div
            role="button"
            tabIndex={0}
            onClick={() => fileRef.current?.click()}
            onKeyDown={e => { if (e.key === 'Enter') fileRef.current?.click() }}
            onDragOver={e => { e.preventDefault(); setDragOver(true) }}
            onDragLeave={() => setDragOver(false)}
            onDrop={e => {
              e.preventDefault(); setDragOver(false)
              const file = e.dataTransfer?.files?.[0]
              if (file) uploadFile(file)
            }}
            style={{
              border: `1.5px dashed ${dragOver ? T.red : '#DEDEDA'}`,
              background: dragOver ? '#FEFAFA' : 'transparent',
              borderRadius: 12, padding: '22px 16px', textAlign: 'center', cursor: 'pointer',
            }}
          >
            <div style={{ fontSize: 12.5, fontWeight: 600 }}>
              {uploading ? 'Uploading…' : 'Drop files here or browse'}
            </div>
            <div style={{ fontSize: 11, color: T.faint, marginTop: 4 }}>
              PDF, DOCX, XLSX, images · up to 25 MB each
            </div>
          </div>
          <input
            ref={fileRef}
            type="file"
            style={{ display: 'none' }}
            accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.png,.jpg,.jpeg,.gif,.webp"
            onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; uploadFile(file) }}
          />

          {uploadError && (
            <div style={{ fontSize: 11.5, color: T.redHot, marginTop: 10 }}>{uploadError}</div>
          )}

          {files.length === 0 ? (
            <EmptyState
              title="No documents attached"
              body="Leases, filings, opposition mailers, position drafts — anything the team needs on hand. Files stay in your BadgerBoard storage."
            />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', marginTop: 10 }}>
              {files.map(file => {
                const glyph = fileGlyph(file.type)
                const tile = FILE_TILE[glyph] || FILE_TILE.FILE
                return (
                  <div key={file.id} className="cp-row" style={{
                    display: 'flex', alignItems: 'center', gap: 11, padding: '11px 10px', margin: '0 -10px',
                    borderTop: `1px solid ${T.divider}`, opacity: busyId === file.id ? 0.5 : 1, minHeight: 44,
                  }}>
                    <span style={{
                      flexShrink: 0, width: 32, height: 32, borderRadius: 8,
                      background: tile.bg, color: tile.fg, fontSize: 9, fontWeight: 800,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>{glyph}</span>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div
                        role="button"
                        tabIndex={0}
                        onClick={() => download(file)}
                        onKeyDown={e => { if (e.key === 'Enter') download(file) }}
                        style={{
                          fontSize: 12.5, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden',
                          textOverflow: 'ellipsis', cursor: 'pointer',
                        }}
                      >{file.name}</div>
                      <div style={{ fontSize: 10.5, color: T.faint, marginTop: 1 }}>
                        {[glyph, formatBytes(file.size),
                          file.by ? `uploaded by ${file.by}` : null,
                          file.ts ? format(new Date(file.ts), 'MMM d') : null,
                        ].filter(Boolean).join(' · ')}
                      </div>
                    </div>
                    <AiChip
                      on={!!file.ai_access}
                      busy={togglingId === file.id}
                      onClick={() => toggleFileAi(file.id)}
                      disabledReason={lock.locked ? 'AI access is locked for this candidate — nothing here is sent to any AI feature regardless of this switch.' : null}
                    />
                    <span style={{ flexShrink: 0 }}>
                      <TextLink onClick={() => removeFile(file)}>Remove</TextLink>
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </Card>
      </div>
    </div>
  )
}
