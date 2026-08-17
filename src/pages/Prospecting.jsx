// src/pages/Prospecting.jsx
// ─── Prospecting v2 — discover → enrich → score → export ─────────────────────
//
// Replaces the old three-mode list builder (manual / AI / CSV) with the pipeline
// from PROSPECTING-redesign-gameplan.md §6. The list builder is no longer the
// product; it is the LAST step of one.
//
//   DISCOVER  filter your candidates DB (+ upcoming-election filters, + CSV
//             import) and queue prospects
//   ENRICH    run enrich-prospects-background on up to 10 at a time, with live
//             server-side progress (a background function's status codes are
//             discarded by Netlify, so progress lives in a table we poll)
//   RESULTS   sortable table: win odds with a "why this score" breakdown,
//             affiliation, verified website, socials, agency-detected badge with
//             evidence links, contact info with per-field source + confidence
//   EXPORT    full CSV of every enriched field, or save as a prospecting list
//
// COMPLIANCE (owner directive): nothing here reads WEC/CFIS campaign-finance
// data. Contact info comes from candidate-published pages and cited coverage;
// agency detection comes from web-visible signals. See the compliance note in
// netlify/functions/enrich-prospects-background.js and Wis. Stat. §11.1304(12).
//
// Design language: the redesign shell tokens (Geist) shared with the Profiler
// and the dashboards — src/pages/profiler/shared.jsx.

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { format } from 'date-fns'
import {
  Search, Plus, Download, X, AlertCircle, Upload, Globe,
  RefreshCw, ExternalLink, ShieldAlert, ShieldCheck, ListChecks, Trash2,
  Sparkles, Mail, Phone, UserPlus, ArrowUp, ArrowDown, Info, Facebook,
  Instagram, Linkedin, Twitter, Music2, Copy, ChevronDown,
} from 'lucide-react'
import {
  getCandidates, getElections, createCandidate, createProspectingList, supabase,
} from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { getUserTier, hasFeature } from '../lib/tiers'
import UpgradePrompt from '../components/UpgradePrompt'
import { parseCsvRows } from '../lib/csv'
import { buildProspectCsv, confidenceBand, csvFilename, factorSummary } from '../lib/prospectCsv'
import { DB_PARTIES } from '../lib/party'
import { T, cardStyle, Btn, Pill, Spinner, EmptyNote } from './profiler/shared.jsx'

// Must match MAX_PROSPECTS_PER_RUN in enrich-prospects-background.js. The server
// enforces it; this is the number the UI promises.
const MAX_BATCH = 10

// Stage labels mirror STAGE_* in the background function.
const PHASE_LABELS = [
  'Scoring from your own election data…',
  'Researching public sources (cited only)…',
  'Verifying websites, socials and agency signals…',
  'Saving enriched prospects…',
]
const POLL_MS            = 3000
const MAX_WAIT_MS        = 12 * 60 * 1000
const HEARTBEAT_STALE_MS = 3 * 60 * 1000

// ─── R2B PURE HELPERS BEGIN ──────────────────────────────────────────────────
// ONE derivation of a prospect's pipeline state. The header subtitle, the tab
// counts and the per-row badges each used to ask a different question:
//   header/results  p.enriched_at
//   enrich queue    p.enrichment_status !== 'enriched'
//   discover badge  "a prospect row exists at all"  → always rendered "queued"
// so a single fully enriched prospect read "1 enriched · 0 queued" in the
// header while its own Discover row was badged "queued", and a 'partial' row
// was counted in the Enrich tab AND the Results tab at once.
//
// The truthful reading, from the writer (enrich-prospects-background.js) and
// the schema CHECK (pending|running|enriched|partial|error):
//   • enriched_at is stamped only when a run actually saved enrichment data,
//     and a 'partial' run saves data too — so enriched_at, not the status
//     string, is what "this prospect has been enriched" means;
//   • a failed run rewrites enrichment_status to 'error' and leaves
//     enriched_at untouched, so a row that already carries data stays
//     enriched (its failure is surfaced on the row, not by hiding it).
// Every prospect therefore lands in exactly one bucket and the counts add up.
export function prospectStatus(p) {
  if (!p) return 'queued'
  if (p.enriched_at) return 'enriched'
  if (p.enrichment_status === 'error') return 'failed'
  return 'queued'
}

/** Rows the Enrich tab works on: anything not enriched yet (failed included). */
export function isQueuedProspect(p) { return prospectStatus(p) !== 'enriched' }

/** Rows the Results tab shows. */
export function isEnrichedProspect(p) { return prospectStatus(p) === 'enriched' }

/** The numbers the header and the tabs both print. */
export function prospectCounts(rows) {
  const list = Array.isArray(rows) ? rows : []
  let enriched = 0, queued = 0, failed = 0
  for (const p of list) {
    const s = prospectStatus(p)
    if (s === 'enriched') enriched += 1
    else { queued += 1; if (s === 'failed') failed += 1 }
  }
  return { total: list.length, enriched, queued, failed }
}
// ─── R2B PURE HELPERS END ────────────────────────────────────────────────────

// The party filter offers what the DB can actually hold (lib/party.js
// DB_PARTIES = the `candidates.party` CHECK). The hand-kept list this replaces
// was two values short, so prospects saved as 'Constitution' or 'Working
// Families' could never be filtered to. The "All parties" blank option is
// rendered separately below, as before.
const PARTY_OPTIONS  = DB_PARTIES
const STATUS_OPTIONS = ['exploring', 'declared', 'primary_winner', 'general', 'elected']
const LEVEL_OPTIONS  = [
  { v: '', l: 'All levels' }, { v: 'federal', l: 'Federal' }, { v: 'state', l: 'State' },
  { v: 'county', l: 'County' }, { v: 'municipal', l: 'Municipal' },
]

const BAND_TINT = {
  strong:      { c: '#15803D', bg: '#E6F5EC' },
  competitive: { c: '#B45309', bg: '#FDF3E3' },
  longshot:    { c: '#6B6B73', bg: '#F1F1EF' },
  unknown:     { c: '#6B6B73', bg: '#F1F1EF' },
}

const freshMs = (iso) => {
  const t = Date.parse(iso || '')
  return Number.isFinite(t) ? Date.now() - t : Infinity
}
const fmtDay = (d) => {
  const t = Date.parse(d || '')
  return Number.isFinite(t) ? format(new Date(t), 'MMM d, yyyy') : '—'
}
const lower = (s) => String(s ?? '').toLowerCase()

// ── Small primitives ──────────────────────────────────────────────────────────

function Field({ label, children, style }) {
  return (
    <div style={{ minWidth: 0, ...style }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: T.ink4, marginBottom: 5, letterSpacing: '.2px' }}>{label}</div>
      {children}
    </div>
  )
}

const inputStyle = {
  width: '100%', border: `1px solid ${T.field}`, borderRadius: 10, padding: '8px 10px',
  fontSize: 12.5, fontFamily: 'inherit', color: T.ink, background: '#fff', outline: 'none',
}

function Chip({ active, children, onClick, title }) {
  return (
    <button
      type="button" onClick={onClick} title={title}
      style={{
        border: `1px solid ${active ? T.ink : T.border}`, background: active ? T.ink : '#fff',
        color: active ? '#fff' : T.ink3, borderRadius: 99, padding: '5px 11px', fontSize: 11.5,
        fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
      }}
    >{children}</button>
  )
}

/**
 * Click-away popover anchored under its trigger.
 *
 * Two modes:
 *   default        — absolutely positioned inside the trigger's own stacking
 *                    context (what ScoreCell / AgencyCell have always used)
 *   `anchorRef`    — PORTALLED to <body> and positioned from the trigger's
 *                    getBoundingClientRect(), flipping above the trigger when
 *                    there is more room up than down.
 *
 * The portal exists because the results table lives inside `.pp-scroll`, which
 * sets `overflow-x: auto`. Per CSS, a non-`visible` overflow on one axis
 * computes the other axis to `auto` too — so the container clips VERTICALLY as
 * well, and an absolutely positioned panel opened on a bottom row was cut off
 * (or scrolled out of reach) with no way to read the rest of it. A fixed-
 * position portal is outside that clip entirely.
 */
function Popover({ open, onClose, children, width = 340, anchorRef }) {
  const [pos, setPos] = useState(null)

  useLayoutEffect(() => {
    if (!open || !anchorRef) return undefined
    const place = () => {
      const el = anchorRef.current
      if (!el) return
      const r  = el.getBoundingClientRect()
      const vw = window.innerWidth
      const vh = window.innerHeight
      const GAP = 6, EDGE = 8
      const below = vh - r.bottom - GAP - EDGE
      const above = r.top - GAP - EDGE
      // Flip up only when the panel genuinely fits better there — a bottom-row
      // trigger on a phone otherwise opens into 20px of viewport.
      const flip  = below < 200 && above > below
      setPos({
        left: Math.max(EDGE, Math.min(r.left, vw - width - EDGE)),
        ...(flip ? { bottom: vh - r.top + GAP } : { top: r.bottom + GAP }),
        maxHeight: Math.max(140, flip ? above : below),
      })
    }
    place()
    window.addEventListener('resize', place)
    // capture: catches the .pp-scroll container scrolling, not just the window
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open, anchorRef, width])

  if (!open) return null

  const panel = (extra) => (
    <div
      onClick={(e) => e.stopPropagation()}
      style={{
        width, ...cardStyle, borderRadius: 12, padding: 14,
        boxShadow: '0 10px 30px rgba(0,0,0,.12)',
        textAlign: 'left', whiteSpace: 'normal', cursor: 'default',
        ...extra,
      }}
    >{children}</div>
  )

  if (anchorRef) {
    if (typeof document === 'undefined' || !pos) return null
    return createPortal(
      <>
        <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 9998 }} />
        {panel({ position: 'fixed', zIndex: 9999, overflowY: 'auto', ...pos })}
      </>,
      document.body,
    )
  }

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
      {panel({ position: 'absolute', zIndex: 41, top: 'calc(100% + 6px)', left: 0 })}
    </>
  )
}

function Banner({ kind = 'error', children, onClose }) {
  const tint = kind === 'error'
    ? { bg: '#FDF1F1', br: '#F3D6D6', c: '#9F1239' }
    : kind === 'warn'
      ? { bg: T.warmBg, br: T.warmBr, c: T.amber }
      : { bg: '#F1F6F2', br: '#DCEBE0', c: T.green }
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 8, background: tint.bg,
      border: `1px solid ${tint.br}`, color: tint.c, borderRadius: 12, padding: '10px 12px',
      fontSize: 12.5, lineHeight: 1.55, marginBottom: 14,
    }}>
      <AlertCircle style={{ width: 15, height: 15, flex: 'none', marginTop: 1 }} />
      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
      {onClose && (
        <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', padding: 0 }}>
          <X style={{ width: 14, height: 14 }} />
        </button>
      )}
    </div>
  )
}

// ── Result-table cells ────────────────────────────────────────────────────────

function ScoreCell({ row }) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef(null)
  const score = row.win_odds_score
  const band = row.win_odds_band || 'unknown'
  const tint = BAND_TINT[band] || BAND_TINT.unknown
  const meta = row.win_odds_factors || {}
  const factors = Array.isArray(meta.factors) ? meta.factors : []

  return (
    <div style={{ position: 'relative' }}>
      <button
        ref={btnRef}
        type="button" onClick={() => setOpen(o => !o)}
        title="Why this score"
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6, background: 'none',
          border: 'none', padding: 0, cursor: factors.length ? 'pointer' : 'default', fontFamily: 'inherit',
        }}
      >
        <span style={{ fontSize: 17, fontWeight: 800, color: score == null ? T.faint : T.ink }}>
          {score == null ? '—' : Math.round(score)}
        </span>
        <Pill c={tint.c} bg={tint.bg}>{band}</Pill>
        {factors.length > 0 && <Info style={{ width: 12, height: 12, color: T.faint }} />}
      </button>

      <Popover open={open} onClose={() => setOpen(false)} width={380} anchorRef={btnRef}>
        <div style={{ fontSize: 12.5, fontWeight: 800, color: T.ink, marginBottom: 2 }}>Why this score</div>
        <div style={{ fontSize: 11, color: T.muted, marginBottom: 10 }}>
          {meta.confidence != null
            ? `Computed from ${Math.round(Number(meta.confidence) * 100)}% of the model — factors we could not measure are dropped, not guessed.`
            : 'Transparent weighted model.'}
        </div>
        {factors.length === 0 && <EmptyNote>Not scored yet.</EmptyNote>}
        {factors.map(f => (
          <div key={f.key} style={{
            display: 'flex', gap: 10, alignItems: 'baseline', padding: '6px 0',
            borderTop: `1px solid ${T.divider}`, opacity: f.available ? 1 : 0.6,
          }}>
            <div style={{ width: 108, flex: 'none' }}>
              <div style={{ fontSize: 11.5, fontWeight: 700, color: T.ink2 }}>{f.label}</div>
              <div style={{ fontSize: 10.5, color: T.faint }}>weight {Math.round(f.weight * 100)}%</div>
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 11.5, color: T.ink3, lineHeight: 1.5 }}>{f.basis}</div>
              {!f.enabled && (
                <div style={{ fontSize: 10.5, color: T.amber, marginTop: 2 }}>{f.source}</div>
              )}
            </div>
            <div style={{ fontSize: 12, fontWeight: 800, color: f.available ? T.ink : T.faint, flex: 'none' }}>
              {f.available ? `+${f.points}` : '—'}
            </div>
          </div>
        ))}
        {meta.model_version && (
          <div style={{ fontSize: 10.5, color: T.faint, marginTop: 10, lineHeight: 1.5 }}>{meta.model_version}</div>
        )}
      </Popover>
    </div>
  )
}

const SOCIAL_ICONS = {
  facebook:  Facebook,
  instagram: Instagram,
  x:         Twitter,
  linkedin:  Linkedin,
  tiktok:    Music2,
}

function SocialLinks({ socials }) {
  const entries = Object.entries(socials || {}).filter(([, v]) => v)
  if (!entries.length) return <span style={{ color: T.faint, fontSize: 12 }}>—</span>
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {entries.map(([k, url]) => {
        const Icon = SOCIAL_ICONS[k] || Globe
        return (
          <a
            key={k} href={url} target="_blank" rel="noopener noreferrer" title={`${k}: ${url}`}
            style={{
              width: 24, height: 24, borderRadius: 7, background: T.chip, display: 'inline-flex',
              alignItems: 'center', justifyContent: 'center', color: T.ink3,
            }}
          >
            <Icon style={{ width: 13, height: 13 }} />
          </a>
        )
      })}
    </div>
  )
}

function AgencyCell({ row }) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef(null)
  const sig = row.agency_signals || {}
  const evidence = Array.isArray(sig.evidence) ? sig.evidence : []
  const detected = sig.detected === true
  if (!row.enriched_at) return <span style={{ color: T.faint, fontSize: 12 }}>—</span>
  return (
    <div style={{ position: 'relative' }}>
      <button
        ref={btnRef}
        type="button" onClick={() => setOpen(o => !o)}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 5, border: 'none', padding: '3px 8px',
          borderRadius: 99, cursor: evidence.length ? 'pointer' : 'default', fontFamily: 'inherit',
          fontSize: 11, fontWeight: 700,
          background: detected ? '#FDF1F1' : '#F1F6F2',
          color: detected ? '#9F1239' : T.green,
        }}
        title={detected ? 'Evidence of an existing agency/consultant' : 'No agency evidence found — open lane'}
      >
        {detected ? <ShieldAlert style={{ width: 12, height: 12 }} /> : <ShieldCheck style={{ width: 12, height: 12 }} />}
        {detected ? `Has help (${sig.confidence ?? 0}%)` : 'No agency found'}
      </button>

      <Popover open={open} onClose={() => setOpen(false)} width={380} anchorRef={btnRef}>
        <div style={{ fontSize: 12.5, fontWeight: 800, color: T.ink, marginBottom: 8 }}>Agency signals</div>
        {evidence.length === 0 ? (
          <EmptyNote>
            No web-visible signal of a paid consultant was found. Campaign-finance
            (CFIS) vendor records are deliberately not checked — see the compliance note below the table.
          </EmptyNote>
        ) : evidence.map((e, i) => (
          <div key={i} style={{ padding: '6px 0', borderTop: i ? `1px solid ${T.divider}` : 'none' }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: T.ink2, textTransform: 'uppercase', letterSpacing: '.3px' }}>
              {String(e.type || '').replace(/_/g, ' ')}
            </div>
            <div style={{ fontSize: 11.5, color: T.ink3, lineHeight: 1.5, marginTop: 2 }}>{e.detail}</div>
            {e.url && (
              <a href={e.url} target="_blank" rel="noopener noreferrer"
                 style={{ fontSize: 11, color: T.red, display: 'inline-flex', alignItems: 'center', gap: 4, marginTop: 3 }}>
                evidence <ExternalLink style={{ width: 10, height: 10 }} />
              </a>
            )}
          </div>
        ))}
      </Popover>
    </div>
  )
}

// ── Contact cell — Call / Email action pills (owner-approved spec) ───────────
// Decisions applied: desktop Call is PLAIN COPY ONLY (no tel: attempt — owner
// decision #2); confidence uses Apollo-style bands over the raw % (decision
// #3): >=85 Verified, >=60 Likely, else Unconfirmed (thresholds live in
// lib/prospectCsv.js so the CSV round-trips the same vocabulary).
const IS_TOUCH_DEVICE = typeof navigator !== 'undefined' &&
  /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '')

// E.164 at RENDER time only — the stored raw value keeps its provenance.
function telHref(raw) {
  const d = String(raw || '').replace(/[^0-9+]/g, '')
  if (d.startsWith('+')) return `tel:${d}`
  const digits = d.replace(/\D/g, '')
  if (digits.length === 10) return `tel:+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `tel:+${digits}`
  return null
}
const bestOf = (items) => [...items].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0]

function BandPill({ confidence }) {
  const band = confidenceBand(confidence)
  if (!band) return null
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, color: T.ink4, background: T.chip,
      borderRadius: 99, padding: '1px 7px', whiteSpace: 'nowrap',
    }}>{band}{confidence != null ? ` · ${confidence}%` : ''}</span>
  )
}

function useCopied() {
  const [copied, setCopied] = useState(null)
  const copy = async (value) => {
    try { await navigator.clipboard.writeText(String(value)) } catch { /* best effort */ }
    setCopied(String(value))
    setTimeout(() => setCopied(null), 1500)
  }
  return [copied, copy]
}

const actionPillStyle = {
  display: 'inline-flex', alignItems: 'center', gap: 5, border: `1px solid ${T.border}`,
  background: '#fff', borderRadius: 99, padding: '4px 10px', fontSize: 11.5,
  fontWeight: 600, color: T.ink2, textDecoration: 'none', cursor: 'pointer',
  whiteSpace: 'nowrap', fontFamily: 'inherit',
}

function ContactCell({ row }) {
  const c = row.contact || {}
  const emails = (Array.isArray(c.emails) ? c.emails : []).filter(e => e && e.value)
  const phones = (Array.isArray(c.phones) ? c.phones : []).filter(p => p && p.value)
  const [open, setOpen] = useState(null)      // 'phones' | 'emails' | null
  const [copied, copy] = useCopied()
  // Anchors for the portalled panels — the cell sits inside `.pp-scroll`, which
  // clips an absolutely positioned popover on the lower rows of the table.
  const phoneBtnRef = useRef(null)
  const emailBtnRef = useRef(null)
  if (!emails.length && !phones.length) return <span style={{ color: T.faint, fontSize: 12 }}>—</span>

  const bestPhone = phones.length ? bestOf(phones) : null
  const bestEmail = emails.length ? bestOf(emails) : null

  const popRow = (item, kind) => {
    const href = kind === 'phone' ? telHref(item.value) : `mailto:${item.value}`
    const actAsLink = kind === 'email' || (IS_TOUCH_DEVICE && href)
    return (
      <div key={item.value} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '6px 0', borderBottom: `1px solid ${T.border}` }}>
        {actAsLink ? (
          <a href={href} aria-label={`${kind === 'phone' ? 'Call' : 'Email'} ${row.name} at ${item.value}, ${confidenceBand(item.confidence)} ${item.confidence ?? 0}% confidence, source ${item.source || 'unknown'}`}
            style={{ fontSize: 12, color: T.ink, textDecoration: 'none', fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.value}</a>
        ) : (
          <button onClick={() => copy(item.value)} aria-label={`Copy ${item.value}`}
            style={{ background: 'none', border: 'none', padding: 0, fontSize: 12, color: T.ink, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.value}</button>
        )}
        <BandPill confidence={item.confidence} />
        <span style={{ fontSize: 10, color: T.faint }}>{(item.source || '').replace(/_/g, ' ')}</span>
        {item.source_url && (
          <a href={item.source_url} target="_blank" rel="noreferrer" aria-label="Evidence source" style={{ color: T.faint, display: 'inline-flex' }}>
            <ExternalLink style={{ width: 11, height: 11 }} />
          </a>
        )}
        <button onClick={() => copy(item.value)} aria-label={`Copy ${item.value}`}
          style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: copied === String(item.value) ? T.green : T.faint, display: 'inline-flex', marginLeft: 'auto' }}>
          <Copy style={{ width: 12, height: 12 }} />
        </button>
      </div>
    )
  }

  const callLabel = phones.length > 1 ? 'Call' : 'Call'
  const callAria = bestPhone
    ? `Call ${row.name} at ${bestPhone.value}, ${confidenceBand(bestPhone.confidence)} ${bestPhone.confidence ?? 0}% confidence, source ${bestPhone.source || 'unknown'}`
    : ''

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', position: 'relative' }}>
      {bestPhone && (
        phones.length > 1 ? (
          <button
            ref={phoneBtnRef}
            onClick={() => setOpen(open === 'phones' ? null : 'phones')}
            aria-haspopup="true" aria-expanded={open === 'phones'} aria-label={`${callAria}; multiple numbers`}
            style={actionPillStyle}
          >
            <Phone style={{ width: 12, height: 12, color: T.ink4 }} />
            {callLabel}
            <ChevronDown style={{ width: 11, height: 11, color: T.faint }} />
            <span style={{ fontSize: 10, fontWeight: 700, color: T.amber }}>multiple numbers</span>
          </button>
        ) : IS_TOUCH_DEVICE && telHref(bestPhone.value) ? (
          <a href={telHref(bestPhone.value)} aria-label={callAria} style={actionPillStyle}>
            <Phone style={{ width: 12, height: 12, color: T.ink4 }} />
            Call
            <BandPill confidence={bestPhone.confidence} />
          </a>
        ) : (
          // Desktop: PLAIN COPY ONLY (owner decision #2) — no tel: attempt.
          <button onClick={() => copy(bestPhone.value)} aria-label={`Copy ${row.name}'s number ${bestPhone.value}`} style={actionPillStyle}>
            <Phone style={{ width: 12, height: 12, color: T.ink4 }} />
            {copied === String(bestPhone.value) ? `Copied ${bestPhone.value}` : 'Call'}
            <BandPill confidence={bestPhone.confidence} />
          </button>
        )
      )}
      {bestEmail && (
        emails.length > 1 ? (
          <button
            ref={emailBtnRef}
            onClick={() => setOpen(open === 'emails' ? null : 'emails')}
            aria-haspopup="true" aria-expanded={open === 'emails'} aria-label={`Email ${row.name}; multiple addresses`}
            style={actionPillStyle}
          >
            <Mail style={{ width: 12, height: 12, color: T.ink4 }} />
            Email
            <ChevronDown style={{ width: 11, height: 11, color: T.faint }} />
            <span style={{ fontSize: 10, fontWeight: 700, color: T.amber }}>multiple</span>
          </button>
        ) : (
          <a href={`mailto:${bestEmail.value}`}
            aria-label={`Email ${row.name} at ${bestEmail.value}, ${confidenceBand(bestEmail.confidence)} ${bestEmail.confidence ?? 0}% confidence, source ${bestEmail.source || 'unknown'}`}
            style={actionPillStyle}>
            <Mail style={{ width: 12, height: 12, color: T.ink4 }} />
            Email
            <BandPill confidence={bestEmail.confidence} />
          </a>
        )
      )}
      <Popover open={open === 'phones'} onClose={() => setOpen(null)} width={320} anchorRef={phoneBtnRef}>
        <div style={{ fontSize: 11, fontWeight: 700, color: T.ink4, letterSpacing: .4, marginBottom: 6 }}>PHONE NUMBERS</div>
        {phones.map(p => popRow(p, 'phone'))}
      </Popover>
      <Popover open={open === 'emails'} onClose={() => setOpen(null)} width={320} anchorRef={emailBtnRef}>
        <div style={{ fontSize: 11, fontWeight: 700, color: T.ink4, letterSpacing: .4, marginBottom: 6 }}>EMAIL ADDRESSES</div>
        {emails.map(e => popRow(e, 'email'))}
      </Popover>
    </div>
  )
}

// ── Add-to-Candidates modal (CSV import path) ────────────────────────────────
// Rewritten from the original: it used to count an "added" for every attempt
// because createCandidate() resolves with { data, error } instead of throwing —
// a failed insert was reported as a success. It now counts REAL successes and
// surfaces the first failure.
function AddToCandidatesModal({ rows, onClose, onDone }) {
  const [selected, setSelected] = useState(() => new Set(rows.map((_, i) => i)))
  const [saving, setSaving] = useState(false)
  const [result, setResult] = useState(null)   // { added, failed, firstError }

  const toggle = (i) => setSelected(prev => {
    const next = new Set(prev)
    if (next.has(i)) next.delete(i); else next.add(i)
    return next
  })

  const handleAdd = async () => {
    setSaving(true)
    let added = 0, failed = 0, firstError = null
    for (const i of selected) {
      const p = rows[i]
      try {
        const { data, error } = await createCandidate({
          name:   p.name || 'Unknown',
          email:  p.email || null,
          phone:  p.phone || null,
          status: 'exploring',
          notes:  p.note || null,
        })
        if (error || !data) {
          failed++
          if (!firstError) firstError = error?.message || 'The database rejected the row.'
        } else {
          added++
        }
      } catch (e) {
        failed++
        if (!firstError) firstError = e.message
      }
    }
    setResult({ added, failed, firstError })
    setSaving(false)
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)' }} />
      <div style={{ ...cardStyle, position: 'relative', width: '100%', maxWidth: 520, maxHeight: '82vh', display: 'flex', flexDirection: 'column', fontFamily: T.font }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 16, borderBottom: `1px solid ${T.divider}` }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <UserPlus style={{ width: 16, height: 16, color: T.red }} />
            <span style={{ fontSize: 14, fontWeight: 800, color: T.ink }}>Add imported rows to Candidates</span>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer' }}>
            <X style={{ width: 16, height: 16, color: T.faint }} />
          </button>
        </div>

        {result ? (
          <div style={{ padding: 28, textAlign: 'center' }}>
            <div style={{ fontSize: 16, fontWeight: 800, color: T.ink, marginBottom: 6 }}>
              {result.added} candidate{result.added === 1 ? '' : 's'} added
            </div>
            {result.failed > 0 && (
              <div style={{ fontSize: 12.5, color: T.amber, lineHeight: 1.6, marginBottom: 10 }}>
                {result.failed} row{result.failed === 1 ? '' : 's'} could not be saved.
                {result.firstError ? ` First error: ${result.firstError}` : ''}
              </div>
            )}
            <div style={{ fontSize: 12.5, color: T.muted, marginBottom: 16 }}>
              They now appear in Discover with “Exploring” status, ready to queue for enrichment.
            </div>
            <Btn kind="primary" onClick={onDone}>Back to Discover</Btn>
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 16px', background: T.hover, borderBottom: `1px solid ${T.divider}` }}>
              <span style={{ fontSize: 11.5, color: T.muted }}>{selected.size} of {rows.length} selected</span>
              <div style={{ display: 'flex', gap: 12 }}>
                <button onClick={() => setSelected(new Set(rows.map((_, i) => i)))} style={{ background: 'none', border: 'none', color: T.red, fontSize: 11.5, fontWeight: 700, cursor: 'pointer' }}>All</button>
                <button onClick={() => setSelected(new Set())} style={{ background: 'none', border: 'none', color: T.red, fontSize: 11.5, fontWeight: 700, cursor: 'pointer' }}>None</button>
              </div>
            </div>
            <div style={{ flex: 1, overflowY: 'auto' }}>
              {rows.map((p, i) => (
                <label key={i} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '10px 16px', borderBottom: `1px solid ${T.divider}`, cursor: 'pointer' }}>
                  <input type="checkbox" checked={selected.has(i)} onChange={() => toggle(i)} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 700, color: T.ink }}>{p.name}</div>
                    {(p.email || p.phone) && <div style={{ fontSize: 11, color: T.faint }}>{[p.email, p.phone].filter(Boolean).join(' · ')}</div>}
                  </div>
                </label>
              ))}
            </div>
            <div style={{ padding: 14, borderTop: `1px solid ${T.divider}` }}>
              <Btn kind="primary" onClick={handleAdd} disabled={saving || selected.size === 0} style={{ width: '100%' }}>
                {saving ? <><Spinner size={14} color="#fff" /> Adding…</> : <>Add {selected.size} to Candidates</>}
              </Btn>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ── Main page ────────────────────────────────────────────────────────────────

export default function Prospecting() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const userTier = getUserTier(user)

  const [tab, setTab] = useState('discover')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [schemaMissing, setSchemaMissing] = useState(false)

  const [candidates, setCandidates] = useState([])
  const [elections, setElections] = useState([])
  const [prospects, setProspects] = useState([])

  // Discover filters
  const [q, setQ] = useState('')
  const [level, setLevel] = useState('')
  const [party, setParty] = useState('')
  const [statuses, setStatuses] = useState(['exploring', 'declared'])
  const [electionId, setElectionId] = useState('')
  const [upcomingOnly, setUpcomingOnly] = useState(true)
  const [picked, setPicked] = useState(() => new Set())

  // Enrich queue
  const [queued, setQueued] = useState(() => new Set())
  const [run, setRun] = useState(null)   // { runId, stage, status, total, completed, failed, message }
  const runAlive = useRef(false)

  // Results filters
  const [rq, setRq] = useState('')
  const [minScore, setMinScore] = useState(0)
  const [hideAgency, setHideAgency] = useState(false)
  const [onlyContact, setOnlyContact] = useState(false)
  const [websiteFilter, setWebsiteFilter] = useState('all')  // all | yes | facebook_only | no
  const [sort, setSort] = useState({ key: 'win_odds_score', dir: 'desc' })

  // CSV import
  const fileRef = useRef(null)
  const [csvRows, setCsvRows] = useState([])
  const [csvName, setCsvName] = useState('')
  const [showAddModal, setShowAddModal] = useState(false)

  // ── Data loading ───────────────────────────────────────────────────────────
  const loadProspects = useCallback(async () => {
    const { data, error: err } = await supabase
      .from('prospect_profiles')
      .select('*')
      .order('created_at', { ascending: false })
    if (err) {
      // The migration ships with this release but is applied by the owner —
      // until then the page must degrade, not explode.
      if (/does not exist|schema cache|relation/i.test(err.message || '')) setSchemaMissing(true)
      else setError(err.message)
      return
    }
    setSchemaMissing(false)
    setProspects(data || [])
  }, [])

  const loadAll = useCallback(async () => {
    setLoading(true)
    try {
      const [{ data: c }, { data: e }] = await Promise.all([getCandidates({}), getElections()])
      setCandidates(c || [])
      setElections(e || [])
      await loadProspects()
    } catch (e) {
      setError(e.message || 'Could not load your prospecting data.')
    }
    setLoading(false)
  }, [loadProspects])

  useEffect(() => { loadAll() }, [loadAll])
  useEffect(() => () => { runAlive.current = false }, [])

  // ── Discover ───────────────────────────────────────────────────────────────
  const today = useMemo(() => new Date().toISOString().slice(0, 10), [])
  const upcomingElections = useMemo(
    () => (elections || []).filter(e => !e.election_date || e.election_date >= today),
    [elections, today]
  )

  const queuedCandidateIds = useMemo(
    () => new Set(prospects.map(p => p.candidate_id).filter(Boolean)),
    [prospects]
  )

  // The Discover badge reports the prospect's REAL state (prospectStatus), not
  // the mere existence of a prospect row — which is why an already-enriched
  // candidate used to sit under a "queued" pill while the header said 0 queued.
  const prospectByCandidateId = useMemo(() => {
    const m = new Map()
    for (const p of prospects) if (p.candidate_id) m.set(p.candidate_id, p)
    return m
  }, [prospects])

  const discoverRows = useMemo(() => {
    const needle = lower(q).trim()
    return (candidates || []).filter(c => {
      if (level && c.office?.level !== level) return false
      if (party && c.party !== party) return false
      if (statuses.length && !statuses.includes(c.status)) return false
      if (electionId && c.election_id !== electionId) return false
      if (upcomingOnly) {
        const d = c.election?.election_date
        if (!d || d < today) return false
      }
      if (needle) {
        const hay = `${c.name || ''} ${c.office?.name || ''} ${c.office?.district_name || ''} ${c.office?.county || ''}`
        if (!lower(hay).includes(needle)) return false
      }
      return true
    })
  }, [candidates, q, level, party, statuses, electionId, upcomingOnly, today])

  const addToQueue = async () => {
    setError(''); setNotice('')
    if (schemaMissing) { setError('The prospecting tables have not been migrated yet.'); return }
    const chosen = discoverRows.filter(c => picked.has(c.id))
    const fresh = chosen.filter(c => !queuedCandidateIds.has(c.id))
    const skipped = chosen.length - fresh.length
    if (!fresh.length) {
      setNotice(skipped ? `All ${skipped} selected prospect${skipped === 1 ? ' is' : 's are'} already in the queue.` : 'Select at least one candidate first.')
      return
    }
    const rows = fresh.map(c => ({
      created_by: user?.id,
      candidate_id: c.id,
      name: c.name,
      office_name: c.office?.name || null,
      district_name: c.office?.district_name || null,
      county: c.office?.county || null,
      level: c.office?.level || null,
      election_id: c.election_id || null,
      election_date: c.election?.election_date || null,
      party: c.party || null,
      discovery_source: 'candidates_db',
      enrichment_status: 'pending',
    }))
    const { data, error: err } = await supabase.from('prospect_profiles').insert(rows).select()
    // Count REAL inserts. A partial failure must not report a clean success.
    const added = Array.isArray(data) ? data.length : 0
    if (err && added === 0) { setError(`Could not queue prospects: ${err.message}`); return }
    setProspects(prev => [...(data || []), ...prev])
    setPicked(new Set())
    setNotice(
      `${added} prospect${added === 1 ? '' : 's'} queued for enrichment` +
      `${skipped ? ` · ${skipped} already queued` : ''}` +
      `${err ? ` · some rows failed: ${err.message}` : ''}`
    )
    setTab('enrich')
  }

  // ── CSV import (uses the shared, quoted-field-safe parser) ─────────────────
  const handleCsvFile = (ev) => {
    const file = ev.target.files?.[0]
    ev.target.value = ''
    if (!file) return
    setCsvName(file.name)
    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        const rows = parseCsvRows(e.target.result)
        if (rows.length < 2) { setError('That CSV has no data rows.'); return }
        const headers = rows[0].map(h => lower(h).trim())
        const find = (...names) => headers.findIndex(h => names.some(n => h.includes(n)))
        const iName = find('name', 'full name', 'candidate')
        const iEmail = find('email', 'e-mail')
        const iPhone = find('phone', 'mobile', 'cell')
        if (iName < 0) { setError('That CSV has no recognisable name column.'); return }
        const parsed = rows.slice(1)
          .map(r => ({
            name: String(r[iName] ?? '').trim(),
            email: iEmail >= 0 ? String(r[iEmail] ?? '').trim() : '',
            phone: iPhone >= 0 ? String(r[iPhone] ?? '').trim() : '',
            note: `Imported from ${file.name}`,
          }))
          .filter(r => r.name)
        if (!parsed.length) { setError('No named rows were found in that CSV.'); return }
        setError('')
        setCsvRows(parsed)
        setShowAddModal(true)
      } catch (e) {
        setError(`Could not read that CSV: ${e.message}`)
      }
    }
    reader.readAsText(file)
  }

  // ── Enrichment run ─────────────────────────────────────────────────────────
  // Both lists and the header counts come from prospectStatus() — see the pure
  // block at the top of this file for why enriched_at is the deciding field.
  const queueRows    = useMemo(() => prospects.filter(isQueuedProspect),   [prospects])
  const enrichedRows = useMemo(() => prospects.filter(isEnrichedProspect), [prospects])
  const counts       = useMemo(() => prospectCounts(prospects),            [prospects])

  const pollRun = useCallback(async (runId, startedAt) => {
    const deadline = startedAt + MAX_WAIT_MS
    for (;;) {
      await new Promise(r => setTimeout(r, POLL_MS))
      if (!runAlive.current) return
      const { data } = await supabase
        .from('prospecting_enrichment_progress')
        .select('stage,status,message,total,completed,failed,current_name,started_at,updated_at')
        .eq('run_id', runId).maybeSingle()

      if (data) {
        setRun(r => ({ ...(r || {}), runId, ...data }))
        if (data.status === 'error') {
          setError(data.message || 'Enrichment failed. Anything it finished before the failure was saved.')
          setRun(null)
          await loadProspects()
          return
        }
        if (data.status === 'done') {
          setNotice(data.message || `Enriched ${data.completed} of ${data.total} prospects.`)
          setRun(null)
          await loadProspects()
          setTab('results')
          return
        }
        if (freshMs(data.updated_at) > HEARTBEAT_STALE_MS) {
          setError('That enrichment run stopped reporting. Any prospects it finished were saved — try the rest again.')
          setRun(null)
          await loadProspects()
          return
        }
      }
      if (Date.now() > deadline) {
        setError('The enrichment run took too long. Any prospects it finished were saved.')
        setRun(null)
        await loadProspects()
        return
      }
    }
  }, [loadProspects])

  const startEnrichment = async () => {
    setError(''); setNotice('')
    const ids = [...queued].slice(0, MAX_BATCH)
    if (!ids.length) { setNotice('Select at least one queued prospect.'); return }
    const runId = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : `${Date.now()}`.padEnd(36, '0')
    const startedAt = Date.now()
    setRun({ runId, stage: 1, status: 'running', total: ids.length, completed: 0, failed: 0 })
    runAlive.current = true
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch('/.netlify/functions/enrich-prospects-background', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({ run_id: runId, prospect_ids: ids }),
      })
      // Netlify answers a background invocation with 202 before the handler runs —
      // anything else here is a genuine dispatch failure.
      if (res.status !== 202 && !res.ok) {
        let detail = ''
        try { detail = (await res.json())?.error || '' } catch { /* non-JSON */ }
        throw new Error(detail || 'Could not start enrichment — try again.')
      }
      setQueued(new Set())
      await pollRun(runId, startedAt)
    } catch (e) {
      setError(e.message)
      setRun(null)
    } finally {
      runAlive.current = false
    }
  }

  // ── Results ────────────────────────────────────────────────────────────────
  const visibleResults = useMemo(() => {
    const needle = lower(rq).trim()
    let rows = enrichedRows.filter(p => {
      if (needle) {
        const hay = `${p.name || ''} ${p.office_name || ''} ${p.district_name || ''} ${p.county || ''} ${p.affiliation || ''}`
        if (!lower(hay).includes(needle)) return false
      }
      if (minScore > 0 && !(Number(p.win_odds_score) >= minScore)) return false
      if (hideAgency && p.agency_signals?.detected === true) return false
      if (websiteFilter !== 'all' && p.website_state !== websiteFilter) return false
      if (onlyContact) {
        const c = p.contact || {}
        if (!(c.emails?.length || c.phones?.length)) return false
      }
      return true
    })
    const dir = sort.dir === 'asc' ? 1 : -1
    const val = (row) => {
      switch (sort.key) {
        case 'win_odds_score': return row.win_odds_score == null ? null : Number(row.win_odds_score)
        case 'name':           return lower(row.name)
        case 'office_name':    return lower(row.office_name)
        case 'affiliation':    return lower(row.affiliation)
        case 'website_state':  return lower(row.website_state)
        case 'agency':         return row.agency_signals?.detected ? 1 : 0
        case 'contact':        return (row.contact?.emails?.length || 0) + (row.contact?.phones?.length || 0)
        case 'enriched_at':    return Date.parse(row.enriched_at || '') || 0
        default:               return 0
      }
    }
    rows = [...rows].sort((a, b) => {
      const av = val(a), bv = val(b)
      // Nulls always sink, whichever way the column is sorted.
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      if (av < bv) return -1 * dir
      if (av > bv) return 1 * dir
      return 0
    })
    return rows
  }, [enrichedRows, rq, minScore, hideAgency, onlyContact, websiteFilter, sort])

  const exportCsv = () => {
    try {
      const csv = buildProspectCsv(visibleResults)
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = csvFilename('badgerboard_prospects')
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      setNotice(`Exported ${visibleResults.length} prospect${visibleResults.length === 1 ? '' : 's'}.`)
    } catch (e) {
      setError(`Export failed: ${e.message}`)
    }
  }

  const saveAsList = async () => {
    setError(''); setNotice('')
    if (!visibleResults.length) { setNotice('Nothing to save — adjust your filters.'); return }
    const name = window.prompt('Name this prospecting list', `Enriched prospects — ${format(new Date(), 'MMM d, yyyy')}`)
    if (!name) return
    const entries = visibleResults.map(p => ({
      name: p.name, office: p.office_name, district: p.district_name,
      party: p.affiliation, win_odds: p.win_odds_score, win_odds_why: factorSummary(p),
      website: p.website_url, website_state: p.website_state, socials: p.socials,
      agency_detected: p.agency_signals?.detected === true,
      email: p.contact?.emails?.[0]?.value || null,
      email_source: p.contact?.emails?.[0]?.source || null,
      phone: p.contact?.phones?.[0]?.value || null,
    }))
    const { data, error: err } = await createProspectingList({
      name,
      description: `Enriched prospect list (${entries.length} prospects)`,
      filters: { type: 'enriched_v2', minScore, hideAgency, onlyContact, websiteFilter },
      candidates: entries,
      total_count: entries.length,
      notes: 'Built from the Prospecting v2 enrichment pipeline. Contact data from candidate-published sources only; no CFIS campaign-finance data.',
      created_by: user?.id,
    })
    // createProspectingList resolves with { data, error } — it does NOT throw.
    // The old page treated any resolution as success and showed a saved list
    // that never existed.
    if (err || !data) { setError(`Could not save the list: ${err?.message || 'the database rejected it'}`); return }
    setNotice(`Saved “${data.name}” with ${entries.length} prospects.`)
  }

  const removeProspect = async (id) => {
    if (!window.confirm('Remove this prospect from your pipeline?')) return
    const { error: err } = await supabase.from('prospect_profiles').delete().eq('id', id)
    if (err) { setError(`Could not remove: ${err.message}`); return }
    setProspects(prev => prev.filter(p => p.id !== id))
  }

  // ── Feature gate ───────────────────────────────────────────────────────────
  // (All hooks above run unconditionally — the gate is the last thing.)
  if (!hasFeature(userTier, 'prospecting')) return (
    <div style={{ maxWidth: 620, margin: '0 auto', paddingTop: 40, fontFamily: T.font }}>
      <UpgradePrompt
        feature="Prospecting"
        hook="Find the candidates who are winnable, reachable, and don't have an agency yet — before your competitors do."
        plan="Action — Monitor"
        price="from $89/mo"
        benefits={[
          'Win-odds scoring with a transparent factor breakdown',
          'Verified campaign websites, socials and public contact info',
          '“Already has an agency” detection with evidence links',
          'Filter to the open lane: no agency, no website, real odds',
          'Full CSV export of every enriched field',
        ]}
      />
    </div>
  )

  const sortBtn = (key, label, width) => {
    const active = sort.key === key
    const Arrow = sort.dir === 'asc' ? ArrowUp : ArrowDown
    return (
      <th style={{ ...thStyle, width }}>
        <button
          type="button"
          onClick={() => setSort(s => ({ key, dir: s.key === key && s.dir === 'desc' ? 'asc' : 'desc' }))}
          style={{
            background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit',
            fontSize: 11, fontWeight: 700, color: active ? T.ink : T.ink4, letterSpacing: '.3px',
            display: 'inline-flex', alignItems: 'center', gap: 4, textTransform: 'uppercase',
          }}
        >
          {label}{active && <Arrow style={{ width: 11, height: 11 }} />}
        </button>
      </th>
    )
  }

  const stage = Math.min(Math.max(Number(run?.stage) || 1, 1), 4)

  return (
    <div style={{ fontFamily: T.font, color: T.ink }}>
      <style>{`
        @keyframes pfSpin { 0% { transform: rotate(0) } 100% { transform: rotate(360deg) } }
        .pp-row:hover { background: ${T.hover} }
        .pp-scroll { overflow-x: auto }
      `}</style>

      {/* Header + pipeline tabs */}
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 20, fontWeight: 800, letterSpacing: '-.2px' }}>Prospecting</div>
          <div style={{ fontSize: 12.5, color: T.muted, marginTop: 3 }}>
            Discover → enrich → score → export. {counts.enriched} enriched · {counts.queued} queued
            {counts.failed ? ` (${counts.failed} failed)` : ''}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Btn onClick={loadAll} title="Reload"><RefreshCw style={{ width: 13, height: 13 }} /> Refresh</Btn>
          {tab === 'results' && (
            <>
              <Btn onClick={saveAsList}><ListChecks style={{ width: 13, height: 13 }} /> Save as list</Btn>
              <Btn kind="primary" onClick={exportCsv} disabled={!visibleResults.length}>
                <Download style={{ width: 13, height: 13 }} /> Export CSV
              </Btn>
            </>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
        {[
          ['discover', `Discover (${discoverRows.length})`],
          ['enrich', `Enrich (${counts.queued})`],
          ['results', `Results (${counts.enriched})`],
        ].map(([key, label]) => (
          <Chip key={key} active={tab === key} onClick={() => setTab(key)}>{label}</Chip>
        ))}
      </div>

      {error && <Banner kind="error" onClose={() => setError('')}>{error}</Banner>}
      {notice && <Banner kind="ok" onClose={() => setNotice('')}>{notice}</Banner>}
      {schemaMissing && (
        <Banner kind="warn">
          The Prospecting v2 tables aren’t in the database yet. Apply
          <code style={{ margin: '0 4px' }}>supabase/migrations/20260812000010_prospecting_v2.sql</code>
          to enable queueing, enrichment and the results table.
        </Banner>
      )}

      {loading && (
        <div style={{ ...cardStyle, padding: 28, display: 'flex', alignItems: 'center', gap: 10 }}>
          <Spinner /> <span style={{ fontSize: 12.5, color: T.muted }}>Loading your pipeline…</span>
        </div>
      )}

      {/* ── DISCOVER ─────────────────────────────────────────────────────── */}
      {!loading && tab === 'discover' && (
        <>
          <div style={{ ...cardStyle, padding: 16, marginBottom: 14 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
              <Field label="Search">
                <div style={{ position: 'relative' }}>
                  <Search style={{ width: 13, height: 13, color: T.faint, position: 'absolute', left: 9, top: 10 }} />
                  <input style={{ ...inputStyle, paddingLeft: 27 }} value={q} onChange={e => setQ(e.target.value)} placeholder="Name, office, county…" />
                </div>
              </Field>
              <Field label="Office level">
                <select style={inputStyle} value={level} onChange={e => setLevel(e.target.value)}>
                  {LEVEL_OPTIONS.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
                </select>
              </Field>
              <Field label="Party">
                <select style={inputStyle} value={party} onChange={e => setParty(e.target.value)}>
                  <option value="">All parties</option>
                  {PARTY_OPTIONS.map(p => <option key={p} value={p}>{p}</option>)}
                </select>
              </Field>
              <Field label="Election">
                <select style={inputStyle} value={electionId} onChange={e => setElectionId(e.target.value)}>
                  <option value="">{upcomingOnly ? 'All upcoming elections' : 'All elections'}</option>
                  {(upcomingOnly ? upcomingElections : elections).map(e => (
                    <option key={e.id} value={e.id}>{e.name}{e.election_date ? ` — ${fmtDay(e.election_date)}` : ''}</option>
                  ))}
                </select>
              </Field>
            </div>

            <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', marginTop: 12, alignItems: 'center' }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: T.ink4, marginRight: 2 }}>STATUS</span>
              {STATUS_OPTIONS.map(s => (
                <Chip
                  key={s} active={statuses.includes(s)}
                  onClick={() => setStatuses(prev => prev.includes(s) ? prev.filter(x => x !== s) : [...prev, s])}
                >{s.replace(/_/g, ' ')}</Chip>
              ))}
              <span style={{ width: 10 }} />
              <Chip active={upcomingOnly} onClick={() => setUpcomingOnly(v => !v)} title="Only candidates in an election that hasn't happened yet">
                Upcoming elections only
              </Chip>
            </div>

            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 14, paddingTop: 12, borderTop: `1px solid ${T.divider}` }}>
              <Btn kind="primary" onClick={addToQueue} disabled={!picked.size || schemaMissing}>
                <Plus style={{ width: 13, height: 13 }} /> Queue {picked.size || ''} for enrichment
              </Btn>
              <Btn onClick={() => setPicked(new Set(discoverRows.map(c => c.id)))} disabled={!discoverRows.length}>Select all {discoverRows.length}</Btn>
              <Btn kind="quiet" onClick={() => setPicked(new Set())} disabled={!picked.size}>Clear</Btn>
              <span style={{ flex: 1 }} />
              <Btn onClick={() => fileRef.current?.click()} title="Import a CSV of names into your candidates">
                <Upload style={{ width: 13, height: 13 }} /> Import CSV
              </Btn>
              <input ref={fileRef} type="file" accept=".csv,text/csv" onChange={handleCsvFile} style={{ display: 'none' }} />
            </div>
            {csvName && !showAddModal && (
              <div style={{ fontSize: 11.5, color: T.muted, marginTop: 8 }}>Last import: {csvName} ({csvRows.length} rows)</div>
            )}
          </div>

          <div style={{ ...cardStyle, overflow: 'hidden' }}>
            <div className="pp-scroll">
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={{ ...thStyle, width: 34 }} />
                    <th style={thStyle}>Candidate</th>
                    <th style={thStyle}>Office</th>
                    <th style={thStyle}>Party</th>
                    <th style={thStyle}>Status</th>
                    <th style={thStyle}>Election</th>
                    <th style={{ ...thStyle, width: 110 }}>Pipeline</th>
                  </tr>
                </thead>
                <tbody>
                  {discoverRows.length === 0 && (
                    <tr><td colSpan={7} style={{ padding: 28, textAlign: 'center' }}>
                      <EmptyNote>
                        No candidates match these filters. Widen the status chips, turn off
                        “upcoming elections only”, or import a CSV.
                      </EmptyNote>
                    </td></tr>
                  )}
                  {discoverRows.map(c => {
                    const already = queuedCandidateIds.has(c.id)
                    const state   = already ? prospectStatus(prospectByCandidateId.get(c.id)) : null
                    return (
                      <tr key={c.id} className="pp-row" style={trStyle}>
                        <td style={tdStyle}>
                          <input
                            type="checkbox"
                            checked={picked.has(c.id)}
                            disabled={already}
                            onChange={() => setPicked(prev => {
                              const next = new Set(prev)
                              if (next.has(c.id)) next.delete(c.id); else next.add(c.id)
                              return next
                            })}
                          />
                        </td>
                        <td style={{ ...tdStyle, fontWeight: 700 }}>{c.name}</td>
                        <td style={tdStyle}>
                          {c.office?.name || '—'}
                          {c.office?.district_name && <span style={{ color: T.muted }}> · {c.office.district_name}</span>}
                        </td>
                        <td style={tdStyle}>{c.party || <span style={{ color: T.faint }}>—</span>}</td>
                        <td style={{ ...tdStyle, textTransform: 'capitalize' }}>{String(c.status || '').replace(/_/g, ' ')}</td>
                        <td style={tdStyle}>{c.election?.name || '—'}</td>
                        <td style={tdStyle}>
                          {state === 'enriched' ? <Pill c="#1F6F43" bg="#E6F5EC">enriched</Pill>
                            : state === 'failed' ? <Pill c="#9F1239" bg="#FDF1F1">failed</Pill>
                            : state === 'queued' ? <Pill>queued</Pill>
                            : <span style={{ color: T.faint }}>—</span>}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* ── ENRICH ───────────────────────────────────────────────────────── */}
      {!loading && tab === 'enrich' && (
        <>
          {run && (
            <div style={{ ...cardStyle, padding: 16, marginBottom: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                <Spinner />
                <div style={{ fontSize: 12.5, fontWeight: 700 }}>{PHASE_LABELS[stage - 1]}</div>
                <span style={{ flex: 1 }} />
                <div style={{ fontSize: 12, color: T.muted }}>
                  {run.completed || 0} / {run.total || 0} done{run.failed ? ` · ${run.failed} failed` : ''}
                </div>
              </div>
              {run.current_name && (
                <div style={{ fontSize: 11.5, color: T.muted, marginBottom: 8 }}>Working on {run.current_name}</div>
              )}
              <div style={{ height: 6, background: T.track, borderRadius: 99, overflow: 'hidden' }}>
                <div style={{
                  height: '100%', background: T.red, borderRadius: 99, transition: 'width .4s ease',
                  width: `${Math.max(6, ((run.completed || 0) / Math.max(1, run.total || 1)) * 100)}%`,
                }} />
              </div>
              <div style={{ fontSize: 11, color: T.faint, marginTop: 8, lineHeight: 1.55 }}>
                Enrichment runs on the server — you can leave this page and come back.
              </div>
            </div>
          )}

          <div style={{ ...cardStyle, padding: 16, marginBottom: 14, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <Btn kind="primary" onClick={startEnrichment} disabled={!!run || !queued.size}>
              <Sparkles style={{ width: 13, height: 13 }} /> Enrich {Math.min(queued.size, MAX_BATCH) || ''} prospect{queued.size === 1 ? '' : 's'}
            </Btn>
            <Btn onClick={() => setQueued(new Set(queueRows.slice(0, MAX_BATCH).map(p => p.id)))} disabled={!queueRows.length || !!run}>
              Select first {Math.min(MAX_BATCH, queueRows.length)}
            </Btn>
            <Btn kind="quiet" onClick={() => setQueued(new Set())} disabled={!queued.size}>Clear</Btn>
            <span style={{ flex: 1 }} />
            <EmptyNote style={{ fontSize: 11.5 }}>
              Up to {MAX_BATCH} prospects per run (the server enforces the same cap).
            </EmptyNote>
          </div>

          <div style={{ ...cardStyle, overflow: 'hidden' }}>
            <div className="pp-scroll">
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={{ ...thStyle, width: 34 }} />
                    <th style={thStyle}>Prospect</th>
                    <th style={thStyle}>Office</th>
                    <th style={thStyle}>Queued</th>
                    <th style={thStyle}>Status</th>
                    <th style={{ ...thStyle, width: 40 }} />
                  </tr>
                </thead>
                <tbody>
                  {queueRows.length === 0 && (
                    <tr><td colSpan={6} style={{ padding: 28, textAlign: 'center' }}>
                      <EmptyNote>Nothing queued. Pick candidates on the Discover tab first.</EmptyNote>
                    </td></tr>
                  )}
                  {queueRows.map(p => {
                    const atCap = !queued.has(p.id) && queued.size >= MAX_BATCH
                    return (
                      <tr key={p.id} className="pp-row" style={trStyle}>
                        <td style={tdStyle}>
                          <input
                            type="checkbox" checked={queued.has(p.id)} disabled={!!run || atCap}
                            onChange={() => setQueued(prev => {
                              const next = new Set(prev)
                              if (next.has(p.id)) next.delete(p.id); else next.add(p.id)
                              return next
                            })}
                          />
                        </td>
                        <td style={{ ...tdStyle, fontWeight: 700 }}>{p.name}</td>
                        <td style={tdStyle}>{p.office_name || '—'}{p.district_name ? ` · ${p.district_name}` : ''}</td>
                        <td style={tdStyle}>{fmtDay(p.discovered_at || p.created_at)}</td>
                        <td style={tdStyle}>
                          {prospectStatus(p) === 'failed'
                            ? <span title={p.enrichment_error || ''}><Pill c="#9F1239" bg="#FDF1F1">failed</Pill></span>
                            : <Pill>{p.enrichment_status || 'pending'}</Pill>}
                        </td>
                        <td style={tdStyle}>
                          <button onClick={() => removeProspect(p.id)} title="Remove"
                                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: T.faint }}>
                            <Trash2 style={{ width: 13, height: 13 }} />
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* ── RESULTS ──────────────────────────────────────────────────────── */}
      {!loading && tab === 'results' && (
        <>
          <div style={{ ...cardStyle, padding: 16, marginBottom: 14 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12 }}>
              <Field label="Search">
                <div style={{ position: 'relative' }}>
                  <Search style={{ width: 13, height: 13, color: T.faint, position: 'absolute', left: 9, top: 10 }} />
                  <input style={{ ...inputStyle, paddingLeft: 27 }} value={rq} onChange={e => setRq(e.target.value)} placeholder="Name, office, affiliation…" />
                </div>
              </Field>
              <Field label={`Minimum win odds — ${minScore}`}>
                <input type="range" min={0} max={90} step={5} value={minScore}
                       onChange={e => setMinScore(Number(e.target.value))} style={{ width: '100%', accentColor: T.red }} />
              </Field>
              <Field label="Website">
                <select style={inputStyle} value={websiteFilter} onChange={e => setWebsiteFilter(e.target.value)}>
                  <option value="all">Any</option>
                  <option value="yes">Has a live site</option>
                  <option value="facebook_only">Facebook only</option>
                  <option value="no">No web presence</option>
                </select>
              </Field>
              <Field label="Focus">
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <Chip active={hideAgency} onClick={() => setHideAgency(v => !v)} title="Hide prospects that already show agency/consultant evidence">
                    Hide already-with-agency
                  </Chip>
                  <Chip active={onlyContact} onClick={() => setOnlyContact(v => !v)}>Has contact info</Chip>
                </div>
              </Field>
            </div>
            <div style={{ fontSize: 11.5, color: T.muted, marginTop: 12 }}>
              Showing {visibleResults.length} of {enrichedRows.length} enriched prospects.
            </div>
          </div>

          <div style={{ ...cardStyle, overflow: 'visible' }}>
            <div className="pp-scroll">
              <table style={tableStyle}>
                <thead>
                  <tr>
                    {sortBtn('name', 'Prospect', 170)}
                    {sortBtn('office_name', 'Office')}
                    {sortBtn('win_odds_score', 'Win odds', 150)}
                    {sortBtn('affiliation', 'Affiliation', 130)}
                    {sortBtn('website_state', 'Website', 130)}
                    <th style={thStyle}>Socials</th>
                    {sortBtn('agency', 'Agency', 140)}
                    {sortBtn('contact', 'Contact', 230)}
                    {sortBtn('enriched_at', 'Enriched', 100)}
                    <th style={{ ...thStyle, width: 40 }} />
                  </tr>
                </thead>
                <tbody>
                  {visibleResults.length === 0 && (
                    <tr><td colSpan={10} style={{ padding: 28, textAlign: 'center' }}>
                      <EmptyNote>
                        No enriched prospects match these filters
                        {enrichedRows.length ? '.' : ' — run an enrichment from the Enrich tab first.'}
                      </EmptyNote>
                    </td></tr>
                  )}
                  {visibleResults.map(p => (
                    <tr key={p.id} className="pp-row" style={trStyle}>
                      <td style={{ ...tdStyle, fontWeight: 700 }}>
                        {p.name}
                        {p.enrichment_status === 'partial' && (
                          <div title={p.enrichment_error || ''} style={{ marginTop: 3 }}>
                            <Pill c={T.amber} bg={T.warmBg}>partial</Pill>
                          </div>
                        )}
                      </td>
                      <td style={tdStyle}>
                        {p.office_name || '—'}
                        {p.district_name && <div style={{ color: T.muted, fontSize: 11 }}>{p.district_name}</div>}
                      </td>
                      <td style={{ ...tdStyle, overflow: 'visible' }}><ScoreCell row={p} /></td>
                      <td style={tdStyle}>
                        {p.affiliation || <span style={{ color: T.faint }}>unknown</span>}
                        {p.affiliation_detail?.inferred && (
                          <div title={p.affiliation_detail?.basis || ''} style={{ marginTop: 3 }}>
                            <Pill c={T.amber} bg={T.warmBg}>inferred {p.affiliation_detail?.confidence ?? 0}%</Pill>
                          </div>
                        )}
                      </td>
                      <td style={tdStyle}>
                        {p.website_state === 'yes' && p.website_url ? (
                          <a href={p.website_url} target="_blank" rel="noopener noreferrer"
                             style={{ fontSize: 11.5, color: T.red, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                            live site <ExternalLink style={{ width: 10, height: 10 }} />
                          </a>
                        ) : p.website_state === 'facebook_only' ? (
                          <Pill c="#2563EB" bg="#E7F0FD">Facebook only</Pill>
                        ) : p.website_state === 'no' ? (
                          <Pill c={T.green} bg="#E6F5EC">no site</Pill>
                        ) : <span style={{ color: T.faint }}>—</span>}
                      </td>
                      <td style={tdStyle}><SocialLinks socials={p.socials} /></td>
                      <td style={{ ...tdStyle, overflow: 'visible' }}><AgencyCell row={p} /></td>
                      <td style={tdStyle}><ContactCell row={p} /></td>
                      <td style={{ ...tdStyle, color: T.muted, fontSize: 11.5 }}>{fmtDay(p.enriched_at)}</td>
                      <td style={tdStyle}>
                        <button onClick={() => removeProspect(p.id)} title="Remove"
                                style={{ background: 'none', border: 'none', cursor: 'pointer', color: T.faint }}>
                          <Trash2 style={{ width: 13, height: 13 }} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div style={{ fontSize: 11, color: T.muted, lineHeight: 1.6, marginTop: 12, maxWidth: 820 }}>
            <strong style={{ color: T.ink3 }}>Where this data comes from.</strong> Win odds are computed from your
            own candidates and election-results data with a published weighted model — open any score to see the
            factors. Websites are confirmed by fetching them. Contact details and agency signals come only from
            candidate-published pages, their public social profiles, and cited news coverage. Wisconsin
            campaign-finance (CFIS/WEC) records are deliberately not used for contact or vendor data pending a
            legal review of Wis. Stat. §11.1304(12). Outreach you send from this list is a commercial message —
            include a physical address and a working opt-out.
          </div>
        </>
      )}

      {showAddModal && (
        <AddToCandidatesModal
          rows={csvRows}
          onClose={() => setShowAddModal(false)}
          onDone={async () => { setShowAddModal(false); await loadAll(); setTab('discover') }}
        />
      )}
    </div>
  )
}

// ── Table styling ─────────────────────────────────────────────────────────────
const tableStyle = { width: '100%', borderCollapse: 'collapse', fontSize: 12.5, minWidth: 900 }
const thStyle = {
  textAlign: 'left', padding: '10px 12px', fontSize: 11, fontWeight: 700, color: T.ink4,
  textTransform: 'uppercase', letterSpacing: '.3px', borderBottom: `1px solid ${T.border}`,
  background: T.hover, whiteSpace: 'nowrap',
}
const trStyle = { borderBottom: `1px solid ${T.divider}` }
const tdStyle = { padding: '11px 12px', verticalAlign: 'top', color: T.ink2 }
