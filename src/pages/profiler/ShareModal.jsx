// src/pages/profiler/ShareModal.jsx — share dialog (SPEC-share-dialog.md).
//
// Four steps, one job each:
//   CHOOSE → two entry cards (private PDF vs public timed link)
//   LINK   → the restructured disclosure · duration · explicit acknowledgment
//   LIVE   → the URL that now exists: copy, expiry, views, deactivate
//   PDF    → export options, wired to the existing buildPrintHtml flow
//
// The old dialog stacked the PDF export on top of the link flow, buried the
// disclosure in an amber block, and had no state for "a link exists" — the
// footer described deactivation that nothing in the dialog performed.
//
// LEGAL COPY — the disclosure below is a RESTRUCTURE of the previous modal's
// amber block, not a rewrite. Every legally meaningful phrase is carried over:
//   · "AI-generated from public(ly available) sources" + "needs independent
//     verification"                                    → responsibility sentence
//   · "you are solely responsible for who accesses this profile and how they
//     use the information"                             → responsibility sentence
//   · "FCRA-regulated purposes (employment screening, credit, housing)",
//     "formal legal proceedings", "publishing without independent
//     corroboration"                                   → DO NOT SHARE FOR items
//   · "The Bluejack Group assumes no liability for the use of shared profile
//     links."                                          → liability line, verbatim
//   · "Links are public and don't require a Badger Board account to view" and
//     "Deactivating a link immediately stops access for anyone who has it"
//                                → choose card / access strip / live-step lines
// FLAG FOR COUNSEL: the final wording of the disclosure panel, the
// acknowledgment sentence and SHARE_DISCLAIMER below needs sign-off before
// release. Nothing here was softened, but the reorganisation changed sentence
// boundaries and counsel should confirm the intent survives intact.

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useDialog } from '../../lib/useDialog'
import { T, Btn, plural, relativeAge } from './shared'

const APP_URL = 'https://www.badgerboardwi.com'

// Server accepts 1..168 hours; these are the six offered cells (SPEC §2).
const DURATIONS = [
  { hours: 1,   label: '1 hour'   },
  { hours: 3,   label: '3 hours'  },
  { hours: 12,  label: '12 hours' },
  { hours: 24,  label: '24 hours' },
  { hours: 72,  label: '3 days'   },
  { hours: 168, label: '7 days'   },
]

// Carried into every email / pasted link so the verification duty travels with
// the URL. Same restrictions as the in-dialog disclosure.
const SHARE_DISCLAIMER = [
  'This is an unverified, AI-generated research profile built from public sources. Verify it independently before acting on it.',
  'Do not use it for employment, credit or housing decisions (FCRA-regulated purposes), for formal legal proceedings, or for publication or broadcast without independent corroboration.',
  'The Bluejack Group assumes no liability for the use of shared profile links.',
].join('\n\n')

const PROHIBITED = [
  { k: 'Employment, credit or housing decisions', v: 'FCRA-regulated purposes' },
  { k: 'Formal legal proceedings',                v: 'filings, discovery, sworn statements' },
  { k: 'Publishing or broadcast',                 v: 'not without independent corroboration' },
]

const ACK_TEXT = 'I understand this profile is unverified AI research, and I accept responsibility for who I share it with and how they use it.'

// ─── Time helpers ────────────────────────────────────────────────────────────
function remainingLabel(iso) {
  const t = iso ? new Date(iso).getTime() : NaN
  if (!Number.isFinite(t)) return '—'
  const ms = t - Date.now()
  if (ms <= 0) return 'Expired'
  const mins = Math.floor(ms / 60000)
  if (mins < 1) return 'Under a minute'
  if (mins < 60) return plural(mins, 'minute')
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return mins % 60 ? `${hrs}h ${mins % 60}m` : plural(hrs, 'hour')
  const days = Math.floor(hrs / 24)
  return hrs % 24 ? `${days}d ${hrs % 24}h` : plural(days, 'day')
}

function isExpired(iso) {
  const t = iso ? new Date(iso).getTime() : NaN
  return Number.isFinite(t) ? t <= Date.now() : false
}

function createdLabel(iso) {
  const t = iso ? new Date(iso).getTime() : NaN
  if (!Number.isFinite(t)) return 'Created by you'
  const mins = Math.floor(Math.max(0, Date.now() - t) / 60000)
  if (mins < 1) return 'Created just now by you'
  if (mins < 60) return `Created ${plural(mins, 'minute')} ago by you`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `Created ${plural(hrs, 'hour')} ago by you`
  return `Created ${relativeAge(iso)} by you`
}

function expiryStamp(iso) {
  const t = iso ? new Date(iso) : null
  if (!t || Number.isNaN(+t)) return ''
  return t.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

// ─── Small pieces ────────────────────────────────────────────────────────────
function CheckBox({ on, tone = T.ink }) {
  return (
    <span
      aria-hidden="true"
      style={{
        flex: 'none', width: 17, height: 17, borderRadius: 5,
        border: `1.5px solid ${on ? tone : '#D6D6D2'}`,
        background: on ? tone : '#fff', color: '#fff',
        fontSize: 11, fontWeight: 800, lineHeight: 1,
        display: 'flex', alignItems: 'center', justifyContent: 'center', marginTop: 1,
      }}
    >{on ? '✓' : ''}</span>
  )
}

function BackLink({ onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, background: 'none', border: 0,
        padding: '0 0 14px', cursor: 'pointer', fontFamily: 'inherit', fontSize: 11.5, color: T.faint,
      }}
    >← Sharing options</button>
  )
}

function Stat({ label, value }) {
  return (
    <div style={{ background: '#fff', padding: '11px 14px' }}>
      <div style={{ fontSize: 11, color: T.muted }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 700, marginTop: 2 }}>{value}</div>
    </div>
  )
}

function Pill({ children, onClick, danger, style }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="pf-btn"
      onMouseEnter={e => { e.currentTarget.style.background = danger ? '#FEF2F2' : T.hover }}
      onMouseLeave={e => { e.currentTarget.style.background = '#fff' }}
      style={{
        background: '#fff',
        border: `1px solid ${danger ? '#FBD5D5' : T.border}`,
        color: danger ? '#B91C1C' : T.ink,
        borderRadius: 99, padding: '8px 15px', fontSize: 12, fontWeight: 600,
        fontFamily: 'inherit', cursor: 'pointer', minHeight: 40, whiteSpace: 'nowrap',
        display: 'inline-flex', alignItems: 'center', ...style,
      }}
    >{children}</button>
  )
}

// ─── Dialog ──────────────────────────────────────────────────────────────────
export default function ShareModal({
  dossier,
  candidate,            // candidate row — carries the AI-access lock for notes
  openClaimCount = 0,   // claims still waiting on a source (Section 14)
  noteCount = 0,        // section notes saved on this profile
  onClose,
  onExportPdf,
}) {
  const [step, setStep]   = useState('choose')   // choose | link | live | pdf
  const [hours, setHours] = useState(24)
  const [ack, setAck]     = useState(false)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')

  const [live, setLive]       = useState(null)   // the share this step is about
  const [shares, setShares]   = useState([])
  const [loadingShares, setLoadingShares] = useState(false)
  const [deactivating, setDeactivating]   = useState(null)
  const [copiedKey, setCopiedKey] = useState('')
  const [, setTick] = useState(0)                // re-renders the countdown

  // Team notes never ride along by default (SPEC rule 2); the AI-access lock on
  // the candidate's notes disables the option outright.
  const notesLocked = candidate?.ai_access_notes === false
  const [pdfOpts, setPdfOpts] = useState({ checklist: true, disclaimer: true, notes: false })

  const aliveRef = useRef(true)
  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false } }, [])

  const cand = candidate || dossier?.candidate || {}
  const candidateName = cand.name || dossier?.candidate?.name || dossier?.title || 'This profile'
  const office   = cand.office?.name || cand.offices?.name || dossier?.candidate?.office?.name || ''
  const district = cand.office?.district_name || cand.offices?.district_name || dossier?.candidate?.office?.district_name || ''
  const subtitle = [candidateName, [office, district].filter(Boolean).join(', ')].filter(Boolean).join(' · ')

  const getToken = async () => {
    const { data: { session } } = await supabase.auth.getSession()
    return session?.access_token || null
  }

  // ── Existing links (unchanged endpoint + shape) ───────────────────────────
  const loadShares = useCallback(async () => {
    if (!dossier?.id) return []
    setLoadingShares(true)
    try {
      const token = await getToken()
      const res = await fetch('/.netlify/functions/get-shared-dossier', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'list', dossier_id: dossier.id }),
      })
      const data = await res.json()
      const list = Array.isArray(data?.shares) ? data.shares : []
      if (aliveRef.current) setShares(list)
      return list
    } catch {
      return []          // offline — create/deactivate report their own errors
    } finally {
      if (aliveRef.current) setLoadingShares(false)
    }
  }, [dossier?.id])

  useEffect(() => { loadShares() }, [loadShares])

  // The live step's view count comes from the create response, then from a
  // refetch — it is never invented.
  useEffect(() => {
    if (step !== 'live' || !live?.id) return
    let cancelled = false
    loadShares().then(list => {
      if (cancelled || !aliveRef.current) return
      const row = list.find(s => s.id === live.id)
      if (row) setLive(prev => (prev && prev.id === row.id ? { ...prev, ...row } : prev))
    })
    return () => { cancelled = true }
  }, [step, live?.id, loadShares])

  // Countdown ticks so "Expires in" stays true while the dialog is open.
  useEffect(() => {
    if (step !== 'live' && step !== 'choose') return undefined
    const id = setInterval(() => aliveRef.current && setTick(n => n + 1), 30000)
    return () => clearInterval(id)
  }, [step])

  // Was a hand-rolled Escape listener with no scroll-lock, so the page kept
  // scrolling behind the modal. Same close path, plus the shared lock.
  useDialog(() => onClose?.())

  const activeShares = shares.filter(s => s.is_active && !isExpired(s.expires_at))
  const shareUrl = live ? (live.share_url || `${APP_URL}/temporary-dossier/${live.token}`) : ''
  const liveExpired = live ? isExpired(live.expires_at) : false

  const copy = (key, text) => {
    if (!text) return
    navigator.clipboard?.writeText(text)
    setCopiedKey(key)
    setTimeout(() => aliveRef.current && setCopiedKey(''), 1800)
  }

  // ── Create ────────────────────────────────────────────────────────────────
  const handleCreate = async () => {
    if (!ack || creating) return          // the checkbox is the gate, not a caption
    setCreating(true); setError('')
    try {
      const token = await getToken()
      const res = await fetch('/.netlify/functions/create-dossier-share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        // acknowledged drives the server-side ack record (ack_at / ack_by /
        // ack_duration_hours). The server refuses to create a link without it.
        body: JSON.stringify({
          dossier_id: dossier.id,
          expires_hours: hours,
          acknowledged: true,
          ack_text: ACK_TEXT,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data.error || 'That link could not be created. Nothing has been shared.')
        setCreating(false)
        return
      }
      const row = {
        id: data.id,
        token: data.token,
        share_url: data.share_url,
        expires_at: data.expires_at,
        created_at: data.created_at || new Date().toISOString(),
        view_count: data.view_count ?? 0,
        is_active: true,
      }
      if (!aliveRef.current) return
      setLive(row)
      setShares(prev => [row, ...prev.filter(s => s.id !== row.id)])
      setStep('live')
      setAck(false)   // every link needs its own acknowledgment, not a sticky one
    } catch (e) {
      setError(e.message || 'Network error — the link was not created.')
    }
    if (aliveRef.current) setCreating(false)
  }

  // ── Deactivate (same endpoint the old dialog used) ────────────────────────
  const handleDeactivate = async (shareId) => {
    if (!shareId) return
    setDeactivating(shareId); setError('')
    try {
      const token = await getToken()
      const res = await fetch('/.netlify/functions/get-shared-dossier', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'deactivate', share_id: shareId }),
      })
      if (!res.ok) throw new Error('That link could not be deactivated. It is still live.')
      if (!aliveRef.current) return
      setShares(prev => prev.map(s => (s.id === shareId ? { ...s, is_active: false } : s)))
      if (live?.id === shareId) { setLive(null); setAck(false); setStep('choose') }
    } catch (e) {
      if (aliveRef.current) setError(e.message || 'That link could not be deactivated. It is still live.')
    }
    if (aliveRef.current) setDeactivating(null)
  }

  const durationLabel = (DURATIONS.find(d => d.hours === hours) || DURATIONS[3]).label

  const emailHref = () => {
    const subject = `Candidate profile: ${candidateName}`
    const body = [
      SHARE_DISCLAIMER,
      shareUrl,
      live?.expires_at ? `This link stops working on ${expiryStamp(live.expires_at)}.` : '',
    ].filter(Boolean).join('\n\n')
    return `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
  }

  const disclaimerBlock = () => [
    SHARE_DISCLAIMER,
    shareUrl,
    live?.expires_at ? `This link stops working on ${expiryStamp(live.expires_at)}.` : '',
  ].filter(Boolean).join('\n\n')

  // ── Footer ────────────────────────────────────────────────────────────────
  const footNote =
    step === 'choose' ? 'Both options carry unverified AI research. Verify before acting on it.'
    : step === 'pdf'  ? 'Downloads to your device. Nothing is published.'
    : step === 'live' ? (liveExpired
        ? 'This link has expired. Nobody can open it.'
        : 'Anyone with this link can read the profile until it expires.')
    : ack ? `Expires ${durationLabel} after you create it.`
          : 'Accept the acknowledgment to continue.'

  const showPrimary = step === 'link' || step === 'pdf'
  const primaryLabel = step === 'pdf'
    ? 'Download PDF'
    : creating ? 'Creating link…' : 'Create link'
  const primaryDisabled = step === 'link' && (!ack || creating)

  const runPrimary = () => {
    if (step === 'link') { handleCreate(); return }
    if (step === 'pdf') {
      onExportPdf?.({ ...pdfOpts, notes: pdfOpts.notes && !notesLocked })
      onClose?.()
    }
  }

  const backToChoice = () => { setStep('choose'); setAck(false); setError('') }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Share this profile"
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 70, background: 'rgba(13,21,38,.42)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        padding: '36px 20px', overflowY: 'auto',
        fontFamily: T.font, color: T.ink,
      }}
    >
      <style>{`
        @keyframes bbLivePulse { 0%,100% { opacity: 1 } 50% { opacity: .4 } }
        @media (max-width: 620px) {
          .pf-paths     { grid-template-columns: 1fr !important }
          .pf-durations { grid-template-columns: repeat(3,minmax(0,1fr)) !important }
        }
      `}</style>
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: '#fff', borderRadius: 18, boxShadow: '0 26px 64px rgba(13,21,38,.3)',
          width: '100%', maxWidth: 560, display: 'flex', flexDirection: 'column', overflow: 'hidden',
        }}
      >
        {/* ── Header ───────────────────────────────────────────────────── */}
        <div style={{
          display: 'flex', alignItems: 'flex-start', gap: 14,
          padding: '20px 24px 16px', borderBottom: `1px solid ${T.divider}`,
        }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 16.5, fontWeight: 700 }}>Share this profile</div>
            <div style={{ fontSize: 12.5, color: T.muted, marginTop: 3, lineHeight: 1.5 }}>{subtitle}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            onMouseEnter={e => { e.currentTarget.style.background = T.chip }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
            style={{
              marginLeft: 'auto', flex: 'none', width: 34, height: 34, borderRadius: 8,
              border: 0, background: 'transparent', color: T.ink4, cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
              <path d="M1.5 1.5l9 9M10.5 1.5l-9 9" fill="none" stroke="currentColor"
                strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '18px 24px 20px' }}>

          {/* ── 1 · Choose ─────────────────────────────────────────────── */}
          {step === 'choose' && (
            <>
              <div className="pf-paths" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <PathCard
                  title="Export as PDF"
                  body="Download a printable copy to your device. Nothing is published."
                  tag="PRIVATE"
                  tone={T.green}
                  onClick={() => { setError(''); setStep('pdf') }}
                />
                <PathCard
                  title="Create a timed link"
                  body="A public URL that stops working on its own. No account needed to view."
                  tag="YOUR RESPONSIBILITY"
                  tone={T.amber}
                  onClick={() => { setError(''); setStep('link') }}
                />
              </div>

              {/* Existing links stay reachable from here — the old dialog's
                  listing and deactivation, unchanged in behaviour. */}
              {(loadingShares || activeShares.length > 0) && (
                <div style={{ marginTop: 18 }}>
                  <div style={{
                    fontSize: 11, fontWeight: 700, letterSpacing: '.9px', color: T.ink4, marginBottom: 9,
                  }}>
                    {loadingShares && activeShares.length === 0
                      ? 'CHECKING FOR ACTIVE LINKS'
                      : `ACTIVE LINKS · ${activeShares.length}`}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {activeShares.map(s => (
                      <div
                        key={s.id}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
                          border: `1px solid ${T.line}`, borderRadius: 12, padding: '10px 13px',
                        }}
                      >
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div style={{
                            fontSize: 12, fontFamily: 'ui-monospace,SFMono-Regular,monospace',
                            color: T.ink3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                          }}>/temporary-dossier/{String(s.token || '').slice(0, 12)}…</div>
                          <div style={{ fontSize: 11.5, color: T.muted, marginTop: 2 }}>
                            Expires in {remainingLabel(s.expires_at)} · {plural(s.view_count || 0, 'view')}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => { setLive(s); setStep('live') }}
                          style={{
                            flex: 'none', background: 'none', border: 0, padding: '8px 0', cursor: 'pointer',
                            fontFamily: 'inherit', fontSize: 11.5, fontWeight: 600, color: T.ink,
                            textDecoration: 'underline',
                          }}
                        >Open</button>
                        <button
                          type="button"
                          disabled={deactivating === s.id}
                          onClick={() => handleDeactivate(s.id)}
                          style={{
                            flex: 'none', background: 'none', border: 0, padding: '8px 0',
                            cursor: deactivating === s.id ? 'default' : 'pointer',
                            fontFamily: 'inherit', fontSize: 11.5, fontWeight: 600, color: '#B91C1C',
                            textDecoration: 'underline', opacity: deactivating === s.id ? 0.55 : 1,
                          }}
                        >{deactivating === s.id ? 'Deactivating…' : 'Deactivate'}</button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          {/* ── 2 · Link setup ─────────────────────────────────────────── */}
          {step === 'link' && (
            <>
              <BackLink onClick={backToChoice} />

              <div style={{
                border: `1px solid ${T.line}`, borderRadius: 14, overflow: 'hidden', marginBottom: 16,
              }}>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 9, padding: '11px 16px',
                  background: T.warmBg, borderBottom: `1px solid ${T.warmBr}`,
                }}>
                  <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.9px', color: T.amber }}>
                    BEFORE YOU SHARE
                  </span>
                </div>
                <div style={{ padding: '14px 16px' }}>
                  <div style={{ fontSize: 12.5, lineHeight: 1.6, color: T.ink3, marginBottom: 13 }}>
                    This profile is AI-generated from public sources and needs independent verification.
                    Anyone with the link can read it, and{' '}
                    <span style={{ fontWeight: 700 }}>
                      you are solely responsible for who you give it to and how they use it
                    </span>.
                  </div>
                  <div style={{
                    fontSize: 11, fontWeight: 700, letterSpacing: '.7px', color: T.ink4, marginBottom: 8,
                  }}>DO NOT SHARE FOR</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                    {PROHIBITED.map(x => (
                      <div key={x.k} style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
                        <span style={{
                          flex: 'none', width: 4, height: 4, borderRadius: '50%',
                          background: '#B91C1C', marginTop: 7,
                        }} />
                        <div style={{ fontSize: 12, lineHeight: 1.5, color: T.ink2 }}>
                          <span style={{ fontWeight: 600 }}>{x.k}</span> — {x.v}
                        </div>
                      </div>
                    ))}
                  </div>
                  <div style={{
                    fontSize: 11.5, color: T.muted, lineHeight: 1.55,
                    marginTop: 13, paddingTop: 12, borderTop: '1px solid #F5F4F1',
                  }}>
                    The Bluejack Group assumes no liability for the use of shared profile links.
                  </div>
                </div>
              </div>

              <div style={{ fontSize: 12, fontWeight: 700, color: T.ink3, marginBottom: 8 }}>
                Link expires after
              </div>
              <div
                className="pf-durations"
                role="radiogroup"
                aria-label="Link expires after"
                style={{ display: 'grid', gridTemplateColumns: 'repeat(6,minmax(0,1fr))', gap: 5, marginBottom: 9 }}
              >
                {DURATIONS.map(d => {
                  const on = d.hours === hours
                  return (
                    <button
                      key={d.hours}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      onClick={() => setHours(d.hours)}
                      style={{
                        textAlign: 'center', border: `1px solid ${on ? T.ink : T.field}`,
                        background: on ? T.ink : '#fff', color: on ? '#fff' : T.ink3,
                        borderRadius: 9, padding: '9px 4px', fontSize: 12, fontWeight: on ? 600 : 500,
                        fontFamily: 'inherit', cursor: 'pointer', whiteSpace: 'nowrap', minHeight: 40,
                      }}
                    >{d.label}</button>
                  )
                })}
              </div>
              <div style={{ fontSize: 11.5, color: T.muted, lineHeight: 1.5, marginBottom: 16 }}>
                Stops working automatically after {durationLabel}. Minimum 1 hour, maximum 7 days.
              </div>

              {/* The acknowledgment is a checkbox, and it is recorded with the
                  link row (who, when, which duration) — not a button caption. */}
              <button
                type="button"
                role="checkbox"
                aria-checked={ack}
                onClick={() => setAck(v => !v)}
                style={{
                  display: 'flex', gap: 11, alignItems: 'flex-start', width: '100%', textAlign: 'left',
                  background: ack ? '#F0FAF4' : T.hover,
                  border: `1px solid ${ack ? '#CFEBDC' : T.border}`,
                  borderRadius: 12, padding: '13px 15px', cursor: 'pointer', fontFamily: 'inherit',
                }}
              >
                <CheckBox on={ack} tone={T.green} />
                <span style={{ fontSize: 12.5, lineHeight: 1.55, color: T.ink3 }}>{ACK_TEXT}</span>
              </button>

              {error && <ErrorLine>{error}</ErrorLine>}
            </>
          )}

          {/* ── 3 · Link live ──────────────────────────────────────────── */}
          {step === 'live' && live && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 14, flexWrap: 'wrap' }}>
                <span style={{
                  width: 7, height: 7, borderRadius: '50%',
                  background: liveExpired ? T.faint : T.green,
                  animation: liveExpired ? 'none' : 'bbLivePulse 2.4s infinite',
                }} />
                <span style={{ fontSize: 13.5, fontWeight: 700 }}>
                  {liveExpired ? 'Link has expired' : 'Link is live'}
                </span>
                <span style={{ marginLeft: 'auto', fontSize: 11.5, color: T.muted }}>
                  {createdLabel(live.created_at)}
                </span>
              </div>

              <div className="pf-linkrow" style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
                <div style={{
                  flex: 1, minWidth: 200, border: `1px solid ${T.field}`, borderRadius: 10,
                  padding: '10px 13px', fontSize: 12.5, fontFamily: 'ui-monospace,SFMono-Regular,monospace',
                  color: T.ink3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>{shareUrl}</div>
                <button
                  type="button"
                  onClick={() => copy('url', shareUrl)}
                  style={{
                    flex: 'none', background: copiedKey === 'url' ? T.green : T.red, color: '#fff',
                    border: 0, borderRadius: 10, padding: '10px 18px', fontSize: 12.5, fontWeight: 600,
                    fontFamily: 'inherit', cursor: 'pointer', whiteSpace: 'nowrap', minHeight: 40,
                  }}
                >{copiedKey === 'url' ? 'Copied' : 'Copy link'}</button>
              </div>

              <div style={{
                display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 1,
                background: T.line, border: `1px solid ${T.line}`, borderRadius: 12,
                overflow: 'hidden', marginBottom: 14,
              }}>
                <Stat label="Expires in" value={remainingLabel(live.expires_at)} />
                <Stat label="Views" value={live.view_count ?? 0} />
                <Stat label="Access" value="Anyone" />
              </div>

              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {!liveExpired && (
                  <>
                    <a
                      href={emailHref()}
                      className="pf-btn"
                      style={{
                        background: '#fff', border: `1px solid ${T.border}`, color: T.ink,
                        borderRadius: 99, padding: '8px 15px', fontSize: 12, fontWeight: 600,
                        textDecoration: 'none', minHeight: 40, display: 'inline-flex', alignItems: 'center',
                      }}
                    >Email link</a>
                    <Pill onClick={() => copy('disclaimer', disclaimerBlock())}>
                      {copiedKey === 'disclaimer' ? 'Copied with disclaimer' : 'Copy with disclaimer'}
                    </Pill>
                  </>
                )}
                <Pill
                  danger
                  style={{ marginLeft: 'auto' }}
                  onClick={() => handleDeactivate(live.id)}
                >{deactivating === live.id ? 'Deactivating…' : 'Deactivate now'}</Pill>
              </div>

              {error && <ErrorLine>{error}</ErrorLine>}

              <div style={{
                fontSize: 11.5, color: T.muted, lineHeight: 1.55,
                marginTop: 14, paddingTop: 13, borderTop: `1px solid ${T.divider}`,
              }}>
                Deactivating stops access immediately for anyone who already has the link.
                All shared links are listed under Settings → Sharing.
              </div>
            </>
          )}

          {/* ── 4 · PDF ────────────────────────────────────────────────── */}
          {step === 'pdf' && (
            <>
              <BackLink onClick={backToChoice} />
              <div style={{ fontSize: 13, lineHeight: 1.6, color: T.ink3, marginBottom: 14 }}>
                A printable copy downloads to your device. Nothing is published and no link is created —
                but the file carries the same unverified AI research, so the verification duty travels with it.
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 9, marginBottom: 16 }}>
                <PdfOption
                  on={pdfOpts.checklist}
                  label="Include the verification checklist"
                  note={openClaimCount > 0
                    ? `Section 14 — the ${plural(openClaimCount, 'claim')} still needing a source`
                    : 'Section 14 — nothing on this profile is still waiting on a source'}
                  onToggle={() => setPdfOpts(o => ({ ...o, checklist: !o.checklist }))}
                />
                <PdfOption
                  on={pdfOpts.disclaimer}
                  label="Include the AI-generated disclaimer"
                  note="Printed in the document footer"
                  onToggle={() => setPdfOpts(o => ({ ...o, disclaimer: !o.disclaimer }))}
                />
                <PdfOption
                  on={pdfOpts.notes && !notesLocked}
                  disabled={notesLocked || noteCount === 0}
                  label="Include your team notes"
                  note={notesLocked
                    ? 'Locked — AI access to this candidate’s notes is turned off, so notes cannot leave Badger Board in an export.'
                    : noteCount === 0
                      ? 'No section notes have been written on this profile yet'
                      : `Notes are internal — off by default (${plural(noteCount, 'section note')})`}
                  onToggle={() => setPdfOpts(o => ({ ...o, notes: !o.notes }))}
                />
              </div>
            </>
          )}
        </div>

        {/* ── Footer ───────────────────────────────────────────────────── */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10, padding: '15px 24px',
          borderTop: `1px solid ${T.divider}`, background: '#FCFCFB', flexWrap: 'wrap',
        }}>
          <span style={{ fontSize: 11.5, color: T.muted, lineHeight: 1.5, flex: 1, minWidth: 200, maxWidth: '34ch' }}>
            {footNote}
          </span>
          <Btn onClick={onClose}>
            {step === 'live' ? 'Done' : step === 'choose' ? 'Close' : 'Cancel'}
          </Btn>
          {showPrimary && (
            <Btn
              kind="primary"
              disabled={primaryDisabled}
              onClick={runPrimary}
              title={step === 'link' && !ack ? 'Accept the acknowledgment first' : undefined}
            >{primaryLabel}</Btn>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Step pieces ─────────────────────────────────────────────────────────────
function PathCard({ title, body, tag, tone, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={e => { e.currentTarget.style.borderColor = '#D6D6D2' }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = T.border }}
      style={{
        border: `1.5px solid ${T.border}`, background: '#fff', borderRadius: 14,
        padding: '15px 16px', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit',
        boxShadow: '0 1px 3px rgba(0,0,0,.03)', color: T.ink,
      }}
    >
      <div style={{ fontSize: 13.5, fontWeight: 700 }}>{title}</div>
      <div style={{ fontSize: 11.5, color: T.ink4, lineHeight: 1.55, marginTop: 5 }}>{body}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 11 }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: tone }} />
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.5px', color: tone }}>{tag}</span>
      </div>
    </button>
  )
}

function PdfOption({ on, label, note, onToggle, disabled }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={!!on}
      aria-disabled={!!disabled}
      disabled={!!disabled}
      onClick={() => !disabled && onToggle()}
      style={{
        display: 'flex', gap: 11, alignItems: 'flex-start', width: '100%', textAlign: 'left',
        background: 'none', border: 0, padding: 0, fontFamily: 'inherit',
        cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.6 : 1,
      }}
    >
      <CheckBox on={!!on} />
      <span>
        <span style={{ display: 'block', fontSize: 12.5, fontWeight: 600, color: T.ink }}>{label}</span>
        <span style={{ display: 'block', fontSize: 11.5, color: T.muted, marginTop: 1, lineHeight: 1.5 }}>{note}</span>
      </span>
    </button>
  )
}

function ErrorLine({ children }) {
  return (
    <div style={{
      marginTop: 12, background: '#FEF2F2', border: '1px solid #FBD5D5', borderRadius: 10,
      padding: '9px 13px', fontSize: 11.5, lineHeight: 1.5, color: '#B91C1C',
    }}>{children}</div>
  )
}
