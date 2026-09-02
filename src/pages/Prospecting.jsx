// src/pages/Prospecting.jsx
// ─── Prospecting v3 — find the field → brief → export ────────────────────────
//
// v3 (Sept 2026) turns Prospecting into what an agency / PAC / NGO actually
// needs: open it cold, pick a county, an office level, or a specific race, and
// get back EVERY candidate AI can find — each with party, an AI-estimated
// chance of winning, and whatever contact info is publicly posted. Candidates
// stay SILOED in Prospecting (prospect_profiles.candidate_id = null) until the
// user presses "Add to My Candidates" on that row.
//
//   DISCOVER  search form → discover-prospects-background (Perplexity live web
//             search, cited rows only) → the discovered field, with a per-row
//             Add to My Candidates button. CSV import stays as a secondary path.
//   ENRICH    enrich-prospects-background in mode 'brief' — one call per
//             candidate, up to 50 per run, live server-side progress
//   RESULTS   party · AI win-odds estimate (labelled) · email · phone · website ·
//             agency flag · Add to My Candidates
//   EXPORT    full CSV, or save as a prospecting list
//
// The v2 "filter your own candidates" Discover is gone — it was the wrong
// product for the audience (0 candidates on a cold open = a dead end).
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

import { format } from 'date-fns'
import {
  Search, Download, X, AlertCircle, Upload, Globe,
  RefreshCw, ExternalLink, ShieldAlert, ShieldCheck, ListChecks, Trash2,
  Sparkles, Mail, Phone, UserPlus, ArrowUp, ArrowDown, Info, Facebook,
  Instagram, Linkedin, Twitter, Music2, Copy, ChevronDown, Check,
} from 'lucide-react'
import {
  getCandidates, createCandidate, createProspectingList, supabase,
} from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { getUserTier, hasFeature } from '../lib/tiers'
import UpgradePrompt from '../components/UpgradePrompt'
import SearchableSelect from '../components/SearchableSelect'
import { parseCsvRows } from '../lib/csv'
import { buildProspectCsv, confidenceBand, csvFilename, factorSummary, displayParty, displayDistrict } from '../lib/prospectCsv'
import { DB_PARTIES } from '../lib/party'
import { WI_COUNTY_CENTROIDS } from '../lib/wiDistricts'
import { T, cardStyle, Btn, Pill, Spinner, EmptyNote } from './profiler/shared.jsx'
import { useDialog } from '../lib/useDialog'

// Must match MAX_BRIEF_PER_RUN in enrich-prospects-background.js (mode 'brief').
// The server enforces it; this is the number the UI promises.
const MAX_BATCH = 50

// Stage labels mirror STAGE_* in the background functions. Brief enrichment
// reports stages 1 (search) and 4 (save); discovery reports the same two.
const PHASE_LABELS = [
  'Researching public sources…',
  'Researching public sources…',
  'Verifying websites and contact info…',
  'Saving results…',
]
const DISCOVER_LABELS = [
  'Searching the web for candidates…',
  'Searching the web for candidates…',
  'Searching the web for candidates…',
  'Saving discovered candidates…',
]

const WI_COUNTIES = Object.keys(WI_COUNTY_CENTROIDS).sort()
const DISCOVER_MODES = [
  { v: 'county', l: 'Whole county' },
  { v: 'level',  l: 'Office level' },
  { v: 'race',   l: 'Specific race' },
]
const THIS_YEAR = new Date().getFullYear()
const YEAR_OPTIONS = [THIS_YEAR, THIS_YEAR + 1, THIS_YEAR + 2]
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

// Office levels the discovery search understands (mirrors ALLOWED_LEVELS in
// discover-prospects-background.js). DB_PARTIES (lib/party.js) is the
// `candidates.party` CHECK — Add to My Candidates only writes a party the
// column will accept.
const LEVEL_OPTIONS  = [
  { v: 'county', l: 'County offices' }, { v: 'municipal', l: 'Municipal (city / village / town)' },
  { v: 'school', l: 'School board' }, { v: 'state', l: 'State legislature & statewide' },
  { v: 'federal', l: 'Federal' },
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

// v1.36.2: a REAL v4 UUID in every environment. The old fallback
// (`${Date.now()}`.padEnd(36,'0')) was not a UUID; the server 400-rejected it
// AFTER Netlify had already answered 202, so the client cleared the queue and
// polled a progress row that would never exist for the full 12-minute window.
// crypto.randomUUID is missing in insecure contexts (plain-HTTP LAN testing)
// and some older WebViews; crypto.getRandomValues is universal.
function makeRunId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  const bytes = new Uint8Array(16)
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(bytes)
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256)
  bytes[6] = (bytes[6] & 0x0f) | 0x40   // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80   // variant 10xx
  const h = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

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
  // v3 brief mode stores an explicitly-labelled AI ESTIMATE with a one-line
  // rationale (model_version 'ai_estimate_*'). Legacy deep-mode rows carry the
  // weighted-model factor breakdown instead.
  const isEstimate = Boolean(meta.estimate) || /^ai_estimate/.test(String(meta.model_version || ''))
  const hasDetail = isEstimate ? Boolean(meta.rationale) : factors.length > 0

  return (
    <div style={{ position: 'relative' }}>
      <button
        ref={btnRef}
        type="button" onClick={() => setOpen(o => !o)}
        title={isEstimate ? 'AI estimate — click for the rationale' : 'Why this score'}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6, background: 'none',
          border: 'none', padding: 0, cursor: hasDetail ? 'pointer' : 'default', fontFamily: 'inherit',
        }}
      >
        <span style={{ fontSize: 17, fontWeight: 800, color: score == null ? T.faint : T.ink }}>
          {score == null ? '—' : Math.round(score)}
        </span>
        <Pill c={tint.c} bg={tint.bg}>{band}</Pill>
        {isEstimate && score != null && <span style={{ fontSize: 10, color: T.faint, fontWeight: 600, whiteSpace: 'nowrap' }}>AI est.</span>}
        {hasDetail && <Info style={{ width: 12, height: 12, color: T.faint }} />}
      </button>

      <Popover open={open} onClose={() => setOpen(false)} width={380} anchorRef={btnRef}>
        <div style={{ fontSize: 12.5, fontWeight: 800, color: T.ink, marginBottom: 2 }}>
          {isEstimate ? 'AI estimate — why this number' : 'Why this score'}
        </div>
        {isEstimate ? (
          <>
            <div style={{ fontSize: 11, color: T.muted, marginBottom: 10 }}>
              An AI estimate from public reporting (incumbency, district lean, primary context, coverage) — not a
              measured probability. Treat it as a first-pass sort, not a forecast.
            </div>
            {meta.rationale
              ? <div style={{ fontSize: 12, color: T.ink2, lineHeight: 1.55 }}>{meta.rationale}</div>
              : <EmptyNote>No rationale was returned.</EmptyNote>}
          </>
        ) : (
          <div style={{ fontSize: 11, color: T.muted, marginBottom: 10 }}>
            {meta.confidence != null
              ? `Computed from ${Math.round(Number(meta.confidence) * 100)}% of the model — factors we could not measure are dropped, not guessed.`
              : 'Transparent weighted model.'}
          </div>
        )}
        {!isEstimate && factors.length === 0 && <EmptyNote>Not scored yet.</EmptyNote>}
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
      // The address is the point of the row: it wraps rather than clipping to
      // "info@yeefor…" — the pills and icons after it never shrink.
      <div key={item.value} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '6px 0', borderBottom: `1px solid ${T.border}`, flexWrap: 'wrap' }}>
        {actAsLink ? (
          <a href={href} aria-label={`${kind === 'phone' ? 'Call' : 'Email'} ${row.name} at ${item.value}, ${confidenceBand(item.confidence)} ${item.confidence ?? 0}% confidence, source ${item.source || 'unknown'}`}
            style={{ fontSize: 12, color: T.ink, textDecoration: 'none', fontWeight: 600, minWidth: 0, overflowWrap: 'anywhere', wordBreak: 'break-word', textAlign: 'left' }}>{item.value}</a>
        ) : (
          <button onClick={() => copy(item.value)} aria-label={`Copy ${item.value}`}
            style={{ background: 'none', border: 'none', padding: 0, fontSize: 12, color: T.ink, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', minWidth: 0, overflowWrap: 'anywhere', wordBreak: 'break-word', textAlign: 'left' }}>{item.value}</button>
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
      <Popover open={open === 'emails'} onClose={() => setOpen(null)} width={360} anchorRef={emailBtnRef}>
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
function AddToCandidatesModal({ rows, userId, onClose, onDone }) {
  const [selected, setSelected] = useState(() => new Set(rows.map((_, i) => i)))
  const [saving, setSaving] = useState(false)
  const [result, setResult] = useState(null)   // { added, failed, firstError }

  const toggle = (i) => setSelected(prev => {
    const next = new Set(prev)
    if (next.has(i)) next.delete(i); else next.add(i)
    return next
  })

  // v3: CSV rows become SILOED prospects (candidate_id null), same as AI
  // discovery — they only reach My Candidates via the per-row button.
  const handleAdd = async () => {
    setSaving(true)
    const payload = [...selected].map(i => {
      const p = rows[i]
      // Same shape buildContact() writes server-side, so ContactCell renders it.
      const contact = {
        emails: p.email ? [{ value: p.email, source: 'csv_import', source_url: null, confidence: 90 }] : [],
        phones: p.phone ? [{ value: p.phone, source: 'csv_import', source_url: null, confidence: 90 }] : [],
        source: (p.email || p.phone) ? 'csv_import' : null,
        confidence: (p.email || p.phone) ? 90 : 0,
      }
      return {
        created_by: userId,
        candidate_id: null,
        name: p.name || 'Unknown',
        contact,
        discovery_source: 'csv_import',
        win_odds_factors: { discovery: { note: p.note || null } },
        enrichment_status: 'pending',
      }
    })
    let added = 0, failed = 0, firstError = null
    try {
      const { data, error } = await supabase.from('prospect_profiles').insert(payload).select('id')
      added = Array.isArray(data) ? data.length : 0
      failed = payload.length - added
      if (error) firstError = error.message
    } catch (e) {
      failed = payload.length
      firstError = e.message
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
            <span style={{ fontSize: 14, fontWeight: 800, color: T.ink }}>Add imported rows to Prospecting</span>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer' }}>
            <X style={{ width: 16, height: 16, color: T.faint }} />
          </button>
        </div>

        {result ? (
          <div style={{ padding: 28, textAlign: 'center' }}>
            <div style={{ fontSize: 16, fontWeight: 800, color: T.ink, marginBottom: 6 }}>
              {result.added} prospect{result.added === 1 ? '' : 's'} added
            </div>
            {result.failed > 0 && (
              <div style={{ fontSize: 12.5, color: T.amber, lineHeight: 1.6, marginBottom: 10 }}>
                {result.failed} row{result.failed === 1 ? '' : 's'} could not be saved.
                {result.firstError ? ` First error: ${result.firstError}` : ''}
              </div>
            )}
            <div style={{ fontSize: 12.5, color: T.muted, marginBottom: 16 }}>
              They now appear in Discover, ready to research. Use “Add to My Candidates” on any row you want in your Candidates list.
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
                {saving ? <><Spinner size={14} color="#fff" /> Adding…</> : <>Add {selected.size} to Prospecting</>}
              </Btn>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ── Save-as-list modal ───────────────────────────────────────────────────────
// Replaces the browser-native window.prompt() that used to name the list.
// Same overlay + card pattern as AddToCandidatesModal; Escape/scroll-lock/
// autofocus come from the shared useDialog contract. The parent's onSave
// runs the unchanged createProspectingList flow with the entered name.
function SaveListModal({ count, defaultName, onClose, onSave }) {
  const [name, setName] = useState(defaultName)
  const [saving, setSaving] = useState(false)
  const inputRef = useRef(null)
  useDialog(onClose, { initialFocusRef: inputRef })

  const trimmed = name.trim()
  const canSave = trimmed.length > 0 && !saving

  const submit = async (e) => {
    e?.preventDefault?.()
    if (!canSave) return
    setSaving(true)
    try {
      await onSave(trimmed)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div onClick={saving ? undefined : onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)' }} />
      <form onSubmit={submit} style={{ ...cardStyle, position: 'relative', width: '100%', maxWidth: 440, display: 'flex', flexDirection: 'column', fontFamily: T.font }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 16, borderBottom: `1px solid ${T.divider}` }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <ListChecks style={{ width: 16, height: 16, color: T.red }} />
            <span style={{ fontSize: 14, fontWeight: 800, color: T.ink }}>Save as prospecting list</span>
          </div>
          <button type="button" onClick={onClose} disabled={saving} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer' }}>
            <X style={{ width: 16, height: 16, color: T.faint }} />
          </button>
        </div>

        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <label htmlFor="save-list-name" style={{ fontSize: 11.5, fontWeight: 700, color: T.ink4 }}>List name</label>
          <input
            id="save-list-name"
            ref={inputRef}
            style={inputStyle}
            value={name}
            onChange={e => setName(e.target.value)}
            onFocus={e => e.target.select()}
            placeholder="Name this prospecting list"
            disabled={saving}
            autoComplete="off"
          />
          <div style={{ fontSize: 12.5, color: T.muted }}>
            {count} prospect{count === 1 ? '' : 's'} will be saved.
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: 14, borderTop: `1px solid ${T.divider}` }}>
          <Btn onClick={onClose} disabled={saving}>Cancel</Btn>
          <Btn kind="primary" type="submit" disabled={!canSave}>
            {saving ? <><Spinner size={14} color="#fff" /> Saving…</> : 'Save'}
          </Btn>
        </div>
      </form>
    </div>
  )
}

// ── Main page ────────────────────────────────────────────────────────────────

export default function Prospecting() {
  const { user } = useAuth()
  const userTier = getUserTier(user)

  const [tab, setTab] = useState('discover')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [schemaMissing, setSchemaMissing] = useState(false)

  // My Candidates — kept only for the name-match guard on "Add to My Candidates".
  const [candidates, setCandidates] = useState([])
  const [prospects, setProspects] = useState([])

  // Discover — AI search form (v3)
  const [dMode, setDMode] = useState('county')
  const [dCounty, setDCounty] = useState('')
  const [dLevel, setDLevel] = useState('county')
  const [dOffice, setDOffice] = useState('')
  const [dDistrict, setDDistrict] = useState('')
  const [dYear, setDYear] = useState(THIS_YEAR)
  const [dq, setDq] = useState('')                    // filter the discovered field
  const [picked, setPicked] = useState(() => new Set())
  const [adding, setAdding] = useState(() => new Set())  // prospect ids mid-"Add to My Candidates"

  // Enrich queue
  const [queued, setQueued] = useState(() => new Set())
  const [run, setRun] = useState(null)   // { runId, kind, stage, status, total, completed, failed, message }
  const runAlive = useRef(false)
  const runKindRef = useRef('brief')     // 'discover' | 'brief' — where pollRun lands on done

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
  const [showSaveListModal, setShowSaveListModal] = useState(false)

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
      // Supabase query builders resolve with { data, error } and never throw —
      // discarding `error` here used to render an empty Discover tab with no
      // message when the candidates or elections query failed (v1.36.1 fix).
      const candRes = await getCandidates({})
      if (candRes.error) throw new Error(`Couldn't load candidates: ${candRes.error.message}`)
      setCandidates(candRes.data || [])
      await loadProspects()
    } catch (e) {
      setError(e.message || 'Could not load your prospecting data.')
    }
    setLoading(false)
  }, [loadProspects])

  useEffect(() => { loadAll() }, [loadAll])
  useEffect(() => () => { runAlive.current = false }, [])

  // ── Resume an in-flight enrichment run after navigation/refresh ────────────
  // v1.36.2: the page says "you can leave and come back" — now it's true.
  // Polling used to die on unmount and nothing on mount looked for a running
  // run, so returning users saw no progress bar and stale statuses. On mount,
  // find the newest RLS-scoped progress row still marked running with a fresh
  // heartbeat and re-attach the poller to it.
  const resumedRef = useRef(false)
  useEffect(() => {
    if (resumedRef.current) return
    resumedRef.current = true
    ;(async () => {
      try {
        const { data } = await supabase
          .from('prospecting_enrichment_progress')
          .select('run_id,stage,status,message,total,completed,failed,current_name,started_at,updated_at')
          .eq('status', 'running')
          .order('updated_at', { ascending: false })
          .limit(1)
          .maybeSingle()
        if (!data?.run_id) return
        // Only resume a run that's still heartbeating — a long-dead "running"
        // row is a crashed run, not something to re-attach a spinner to.
        if (freshMs(data.updated_at) > HEARTBEAT_STALE_MS) return
        setRun({ runId: data.run_id, ...data })
        runAlive.current = true
        await pollRun(data.run_id, Date.now())
      } catch { /* resume is best-effort — a failure just means no progress bar */ }
      finally { runAlive.current = false }
    })()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Discover (v3: AI search → the field) ───────────────────────────────────
  // The discovered field = every prospect not yet researched. Discovery,
  // CSV import and (legacy) candidate queueing all land here.
  const discoverRows = useMemo(() => {
    const needle = lower(dq).trim()
    return prospects.filter(p => {
      if (!isQueuedProspect(p)) return false
      if (!needle) return true
      const hay = `${p.name || ''} ${p.office_name || ''} ${p.district_name || ''} ${p.county || ''} ${p.party || ''}`
      return lower(hay).includes(needle)
    })
  }, [prospects, dq])

  const discoverReady = dMode === 'county' ? !!dCounty : dMode === 'level' ? !!dLevel : !!dOffice.trim()

  const runDiscovery = async () => {
    setError(''); setNotice('')
    if (schemaMissing) { setError('The prospecting tables have not been migrated yet.'); return }
    if (!discoverReady) return
    const runId = makeRunId()
    const startedAt = Date.now()
    runKindRef.current = 'discover'
    setRun({ runId, kind: 'discover', stage: 1, status: 'running', total: 0, completed: 0, failed: 0 })
    runAlive.current = true
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const body = { run_id: runId, mode: dMode, electionYear: dYear }
      if (dMode === 'county') body.county = dCounty
      if (dMode === 'level') { body.level = dLevel; if (dCounty) body.county = dCounty }
      if (dMode === 'race') { body.officeName = dOffice.trim(); body.districtName = dDistrict.trim() || undefined; if (dCounty) body.county = dCounty }
      const res = await fetch('/.netlify/functions/discover-prospects-background', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify(body),
      })
      if (res.status !== 202 && !res.ok) {
        let detail = ''
        try { detail = (await res.json())?.error || '' } catch { /* non-JSON */ }
        throw new Error(detail || 'Could not start the candidate search — try again.')
      }
      await pollRun(runId, startedAt)
    } catch (e) {
      setError(e.message)
      setRun(null)
    } finally {
      runAlive.current = false
    }
  }

  // ── Add to My Candidates (per row) ─────────────────────────────────────────
  // The ONLY path from Prospecting into the Candidates table. Name-match guard
  // links to an existing candidate instead of creating a duplicate.
  const candidateByName = useMemo(() => {
    const m = new Map()
    for (const c of candidates) m.set(lower(c.name).replace(/\s+/g, ' ').trim(), c)
    return m
  }, [candidates])

  const addToMyCandidates = async (p) => {
    if (adding.has(p.id) || p.candidate_id) return
    setAdding(prev => new Set(prev).add(p.id))
    setError('')
    try {
      const key = lower(p.name).replace(/\s+/g, ' ').trim()
      let cand = candidateByName.get(key) || null
      if (!cand) {
        const disc = p.win_odds_factors?.discovery || {}
        const email = (p.contact?.emails || []).length ? bestOf(p.contact.emails).value : null
        const phone = (p.contact?.phones || []).length ? bestOf(p.contact.phones).value : null
        const partyOk = DB_PARTIES.includes(p.affiliation) ? p.affiliation : DB_PARTIES.includes(p.party) ? p.party : null
        const status = /declared|filed|on_ballot|incumbent/i.test(String(disc.status || '')) ? 'declared' : 'exploring'
        const noteBits = [
          'Added from Prospecting',
          p.office_name ? `Office: ${p.office_name}${p.district_name ? ` (${p.district_name})` : ''}` : null,
          p.county ? `County: ${p.county}` : null,
          disc.source_url ? `Source: ${disc.source_url}` : null,
        ].filter(Boolean)
        const { data, error: cErr } = await createCandidate({
          name: p.name,
          party: partyOk,
          status,
          website: p.website_url || null,
          email, phone,
          notes: noteBits.join(' · '),
        })
        if (cErr || !data) throw new Error(cErr?.message || 'Could not create the candidate.')
        cand = data
        setCandidates(prev => [cand, ...prev])
      }
      const { error: lErr } = await supabase
        .from('prospect_profiles')
        .update({ candidate_id: cand.id })
        .eq('id', p.id)
      if (lErr) {
        // Unique (created_by, candidate_id): this candidate is already linked to
        // another prospect row — still counts as "in My Candidates".
        if (!/duplicate|unique/i.test(lErr.message || '')) throw new Error(lErr.message)
      }
      setProspects(prev => prev.map(x => (x.id === p.id ? { ...x, candidate_id: cand.id } : x)))
      setNotice(`${p.name} is now in My Candidates.`)
    } catch (e) {
      setError(`Couldn't add ${p.name}: ${e.message}`)
    } finally {
      setAdding(prev => { const next = new Set(prev); next.delete(p.id); return next })
    }
  }

  // Research the whole discovered field (or the picked subset) — brief mode.
  // Defined after startEnrichment below; hoisted via function declaration.
  function researchDiscovered(ids) {
    const chosen = (ids && ids.length ? ids : discoverRows.map(p => p.id)).slice(0, MAX_BATCH)
    if (!chosen.length) { setNotice('Nothing to research yet — run a search first.'); return }
    setQueued(new Set(chosen))
    setPicked(new Set())
    setTab('enrich')
    startEnrichment(chosen)
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
        // v1.36.3: exact header match wins before substring fallback — pure
        // `includes` used to grab "county name" or "office name" as the name
        // column whenever it appeared first, importing garbage names.
        const find = (...names) => {
          const exact = headers.findIndex(h => names.includes(h))
          if (exact >= 0) return exact
          return headers.findIndex(h => names.some(n => h.includes(n)))
        }
        const iName = find('name', 'full name', 'full_name', 'candidate name', 'candidate')
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
          const isDiscover = runKindRef.current === 'discover'
          setNotice(data.message || (isDiscover
            ? `Found ${data.completed} candidate${data.completed === 1 ? '' : 's'}.`
            : `Researched ${data.completed} of ${data.total} candidates.`))
          setRun(null)
          await loadProspects()
          // Discovery lands back on the field; research lands on Results.
          setTab(isDiscover ? 'discover' : 'results')
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

  const startEnrichment = async (idsOverride) => {
    setError(''); setNotice('')
    const ids = (Array.isArray(idsOverride) ? idsOverride : [...queued]).slice(0, MAX_BATCH)
    if (!ids.length) { setNotice('Select at least one candidate to research.'); return }
    const runId = makeRunId()
    const startedAt = Date.now()
    runKindRef.current = 'brief'
    setRun({ runId, kind: 'brief', stage: 1, status: 'running', total: ids.length, completed: 0, failed: 0 })
    runAlive.current = true
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch('/.netlify/functions/enrich-prospects-background', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        // v3: one-shot brief per candidate (party, AI win-odds estimate,
        // contact, agency flag). Server cap 50 — see MAX_BRIEF_PER_RUN.
        body: JSON.stringify({ run_id: runId, prospect_ids: ids, mode: 'brief' }),
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
        // Sort on the DISPLAYED spelling — 'Democrat' and 'Democratic' are one group.
        case 'affiliation':    return lower(displayParty(row.affiliation || row.party))
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

  // "Save as list" opens an in-app modal (SaveListModal) instead of the old
  // window.prompt(); the modal hands the entered name to confirmSaveAsList,
  // which runs the original createProspectingList flow unchanged.
  const saveAsList = () => {
    setError(''); setNotice('')
    if (!visibleResults.length) { setNotice('Nothing to save — adjust your filters.'); return }
    setShowSaveListModal(true)
  }

  const confirmSaveAsList = async (name) => {
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
    if (err || !data) { setError(`Could not save the list: ${err?.message || 'the database rejected it'}`); setShowSaveListModal(false); return }
    setNotice(`Saved “${data.name}” with ${entries.length} prospects.`)
    setShowSaveListModal(false)
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
            Find the field → research → export. {counts.enriched} researched · {counts.queued} to research
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
          ['discover', `Discover (${counts.queued})`],
          ['enrich', `Research (${counts.queued})`],
          ['results', `Results (${counts.enriched})`],
        ].map(([key, label]) => (
          <Chip key={key} active={tab === key} onClick={() => setTab(key)}>{label}</Chip>
        ))}
      </div>

      {error && (
        <Banner kind="error" onClose={() => setError('')}>
          {error}{' '}
          <button
            onClick={() => { setError(''); loadAll() }}
            style={{ textDecoration: 'underline', fontWeight: 600, background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', padding: 0 }}
          >
            Retry
          </button>
        </Banner>
      )}
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

      {/* ── DISCOVER (v3: AI search) ─────────────────────────────────────── */}
      {!loading && tab === 'discover' && (
        <>
          {/* Search form */}
          <div style={{ ...cardStyle, padding: 16, marginBottom: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <Sparkles style={{ width: 15, height: 15, color: T.red }} />
              <div style={{ fontSize: 13.5, fontWeight: 800 }}>Find every candidate in a race</div>
              <span style={{ fontSize: 11.5, color: T.muted }}>— live web search, cited sources only</span>
            </div>

            <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', marginBottom: 12 }}>
              {DISCOVER_MODES.map(m => (
                <Chip key={m.v} active={dMode === m.v} onClick={() => setDMode(m.v)}>{m.l}</Chip>
              ))}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
              {dMode === 'race' && (
                <>
                  <Field label="Office" style={{ gridColumn: 'span 2' }}>
                    <input style={inputStyle} value={dOffice} onChange={e => setDOffice(e.target.value)}
                           placeholder="e.g. Marathon County Board Supervisor, Wausau Mayor, Assembly District 85" />
                  </Field>
                  <Field label="District (optional)">
                    <input style={inputStyle} value={dDistrict} onChange={e => setDDistrict(e.target.value)} placeholder="e.g. District 12" />
                  </Field>
                </>
              )}
              {dMode === 'level' && (
                <Field label="Office level">
                  <SearchableSelect
                    value={dLevel}
                    onChange={setDLevel}
                    options={LEVEL_OPTIONS.map(o => ({ value: o.v, label: o.l }))}
                    placeholder="Pick a level…"
                  />
                </Field>
              )}
              <Field label={dMode === 'county' ? 'County' : 'County (optional)'}>
                <SearchableSelect
                  value={dCounty}
                  onChange={setDCounty}
                  options={[
                    { value: '', label: dMode === 'county' ? 'Pick a county…' : 'All of Wisconsin' },
                    ...WI_COUNTIES.map(c => ({ value: c, label: `${c} County` })),
                  ]}
                  placeholder={dMode === 'county' ? 'Pick a county…' : 'All of Wisconsin'}
                  searchPlaceholder="Type a county…"
                />
              </Field>
              <Field label="Election year">
                <SearchableSelect
                  value={dYear}
                  onChange={v => setDYear(Number(v))}
                  options={YEAR_OPTIONS.map(y => ({ value: y, label: String(y) }))}
                />
              </Field>
            </div>

            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 14, paddingTop: 12, borderTop: `1px solid ${T.divider}` }}>
              <Btn kind="primary" onClick={runDiscovery} disabled={!discoverReady || !!run || schemaMissing}>
                {run?.kind === 'discover'
                  ? <><Spinner size={13} color="#fff" /> Searching…</>
                  : <><Search style={{ width: 13, height: 13 }} /> Find candidates</>}
              </Btn>
              <EmptyNote style={{ fontSize: 11.5 }}>
                Up to {MAX_BATCH} per search · ~1 credit. Anyone already in your pipeline is skipped.
              </EmptyNote>
              <span style={{ flex: 1 }} />
              <Btn kind="quiet" onClick={() => fileRef.current?.click()} title="Import a CSV of names as prospects">
                <Upload style={{ width: 13, height: 13 }} /> Import a list
              </Btn>
              <input ref={fileRef} type="file" accept=".csv,text/csv" onChange={handleCsvFile} style={{ display: 'none' }} />
            </div>
            {csvName && !showAddModal && (
              <div style={{ fontSize: 11.5, color: T.muted, marginTop: 8 }}>Last import: {csvName} ({csvRows.length} rows)</div>
            )}
          </div>

          {/* Discovery progress */}
          {run?.kind === 'discover' && (
            <div style={{ ...cardStyle, padding: 16, marginBottom: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <Spinner />
                <div style={{ fontSize: 12.5, fontWeight: 700 }}>{DISCOVER_LABELS[stage - 1]}</div>
                {run.current_name && <span style={{ fontSize: 11.5, color: T.muted }}>· {run.current_name}</span>}
              </div>
              <div style={{ fontSize: 11, color: T.faint, marginTop: 8, lineHeight: 1.55 }}>
                Usually 20–60 seconds. Runs on the server — you can leave this page and come back.
              </div>
            </div>
          )}

          {/* The discovered field */}
          <div style={{ ...cardStyle, padding: 16, marginBottom: 14, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <Btn kind="primary" onClick={() => researchDiscovered(picked.size ? [...picked] : null)} disabled={!discoverRows.length || !!run || schemaMissing}>
              <Sparkles style={{ width: 13, height: 13 }} />
              {picked.size ? `Research ${Math.min(picked.size, MAX_BATCH)} selected` : `Research all ${Math.min(discoverRows.length, MAX_BATCH)}`}
            </Btn>
            <Btn onClick={() => setPicked(new Set(discoverRows.slice(0, MAX_BATCH).map(p => p.id)))} disabled={!discoverRows.length}>
              Select all
            </Btn>
            <Btn kind="quiet" onClick={() => setPicked(new Set())} disabled={!picked.size}>Clear</Btn>
            <span style={{ flex: 1 }} />
            <div style={{ position: 'relative', minWidth: 220 }}>
              <Search style={{ width: 13, height: 13, color: T.faint, position: 'absolute', left: 9, top: 10 }} />
              <input style={{ ...inputStyle, paddingLeft: 27 }} value={dq} onChange={e => setDq(e.target.value)} placeholder="Filter the field…" />
            </div>
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
                    <th style={thStyle}>County</th>
                    <th style={thStyle}>Source</th>
                    <th style={{ ...thStyle, width: 170 }}>My Candidates</th>
                    <th style={{ ...thStyle, width: 40 }} />
                  </tr>
                </thead>
                <tbody>
                  {discoverRows.length === 0 && (
                    <tr><td colSpan={8} style={{ padding: 28, textAlign: 'center' }}>
                      <EmptyNote>
                        {prospects.some(isQueuedProspect)
                          ? 'No one in the field matches that filter.'
                          : 'Nothing here yet. Pick a county, level, or race above and press Find candidates.'}
                      </EmptyNote>
                    </td></tr>
                  )}
                  {discoverRows.map(p => {
                    const disc = p.win_odds_factors?.discovery || {}
                    const src = disc.source_url || p.research_citations?.[0]?.url || null
                    const partyLabel = displayParty(p.affiliation || p.party)
                    const inMine = !!p.candidate_id
                    const busy = adding.has(p.id)
                    return (
                      <tr key={p.id} className="pp-row" style={trStyle}>
                        <td style={tdStyle}>
                          <input
                            type="checkbox"
                            checked={picked.has(p.id)}
                            disabled={!!run}
                            onChange={() => setPicked(prev => {
                              const next = new Set(prev)
                              if (next.has(p.id)) next.delete(p.id); else next.add(p.id)
                              return next
                            })}
                          />
                        </td>
                        <td style={{ ...tdStyle, fontWeight: 700 }}>
                          {p.name}
                          {prospectStatus(p) === 'failed' && (
                            <span title={p.enrichment_error || ''} style={{ marginLeft: 6 }}><Pill c="#9F1239" bg="#FDF1F1">failed</Pill></span>
                          )}
                          {disc.confidence === 'low' && (
                            <span title="The discovering page was not conclusive — verify before outreach" style={{ marginLeft: 6 }}><Pill>low confidence</Pill></span>
                          )}
                        </td>
                        <td style={tdStyle}>
                          {p.office_name || '—'}
                          {p.district_name && <span style={{ color: T.muted }}> · {displayDistrict(p.district_name)}</span>}
                        </td>
                        <td style={tdStyle}>{partyLabel || <span style={{ color: T.faint }}>—</span>}</td>
                        <td style={tdStyle}>{p.county || <span style={{ color: T.faint }}>—</span>}</td>
                        <td style={tdStyle}>
                          {src
                            ? <a href={src} target="_blank" rel="noopener noreferrer" style={{ color: T.red, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                {p.discovery_source === 'csv_import' ? 'CSV' : 'source'} <ExternalLink style={{ width: 11, height: 11 }} />
                              </a>
                            : <span style={{ color: T.faint }}>{p.discovery_source === 'csv_import' ? 'CSV import' : '—'}</span>}
                        </td>
                        <td style={tdStyle}>
                          {inMine
                            ? <Pill c="#1F6F43" bg="#E6F5EC"><Check style={{ width: 11, height: 11, marginRight: 3 }} /> In My Candidates</Pill>
                            : <Btn onClick={() => addToMyCandidates(p)} disabled={busy} style={{ fontSize: 11.5, padding: '5px 10px' }}>
                                {busy ? <Spinner size={12} /> : <UserPlus style={{ width: 12, height: 12 }} />} Add to My Candidates
                              </Btn>}
                        </td>
                        <td style={tdStyle}>
                          <button onClick={() => removeProspect(p.id)} title="Remove from Prospecting"
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

      {/* ── ENRICH ───────────────────────────────────────────────────────── */}
      {!loading && tab === 'enrich' && (
        <>
          {run && (
            <div style={{ ...cardStyle, padding: 16, marginBottom: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                <Spinner />
                <div style={{ fontSize: 12.5, fontWeight: 700 }}>{(run.kind === 'discover' ? DISCOVER_LABELS : PHASE_LABELS)[stage - 1]}</div>
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
                Research runs on the server — you can leave this page and come back.
              </div>
            </div>
          )}

          <div style={{ ...cardStyle, padding: 16, marginBottom: 14, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <Btn kind="primary" onClick={() => startEnrichment()} disabled={!!run || !queued.size}>
              <Sparkles style={{ width: 13, height: 13 }} /> Research {Math.min(queued.size, MAX_BATCH) || ''} candidate{queued.size === 1 ? '' : 's'}
            </Btn>
            <Btn onClick={() => setQueued(new Set(queueRows.slice(0, MAX_BATCH).map(p => p.id)))} disabled={!queueRows.length || !!run}>
              Select all {Math.min(MAX_BATCH, queueRows.length)}
            </Btn>
            <Btn kind="quiet" onClick={() => setQueued(new Set())} disabled={!queued.size}>Clear</Btn>
            <span style={{ flex: 1 }} />
            <EmptyNote style={{ fontSize: 11.5 }}>
              One brief pass per candidate · up to {MAX_BATCH} per run · ~1 credit each.
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
                      <EmptyNote>Nothing to research. Find candidates on the Discover tab first.</EmptyNote>
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
                        <td style={tdStyle}>{p.office_name || '—'}{p.district_name ? ` · ${displayDistrict(p.district_name)}` : ''}</td>
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
                <SearchableSelect
                  value={websiteFilter}
                  onChange={setWebsiteFilter}
                  options={[
                    { value: 'all', label: 'Any' },
                    { value: 'yes', label: 'Has a live site' },
                    { value: 'facebook_only', label: 'Facebook only' },
                    { value: 'no', label: 'No web presence' },
                  ]}
                />
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
                    {sortBtn('name', 'Candidate', 170)}
                    {sortBtn('office_name', 'Office')}
                    {sortBtn('affiliation', 'Party', 120)}
                    {sortBtn('win_odds_score', 'Win odds', 190)}
                    {sortBtn('contact', 'Contact', 230)}
                    {sortBtn('website_state', 'Website', 120)}
                    {sortBtn('agency', 'Agency', 140)}
                    <th style={{ ...thStyle, width: 170 }}>My Candidates</th>
                    <th style={{ ...thStyle, width: 40 }} />
                  </tr>
                </thead>
                <tbody>
                  {visibleResults.length === 0 && (
                    <tr><td colSpan={9} style={{ padding: 28, textAlign: 'center' }}>
                      <EmptyNote>
                        No researched candidates match these filters
                        {enrichedRows.length ? '.' : ' — find candidates on Discover and press Research first.'}
                      </EmptyNote>
                    </td></tr>
                  )}
                  {visibleResults.map(p => {
                    const inMine = !!p.candidate_id
                    const busy = adding.has(p.id)
                    return (
                      <tr key={p.id} className="pp-row" style={trStyle}>
                        <td style={{ ...tdStyle, fontWeight: 700 }}>
                          {p.name}
                          {p.enrichment_status === 'partial' && (
                            <div title={p.enrichment_error || ''} style={{ marginTop: 3 }}>
                              <Pill c={T.amber} bg={T.warmBg}>partial</Pill>
                            </div>
                          )}
                          {p.county && <div style={{ color: T.faint, fontSize: 11, fontWeight: 400 }}>{p.county} County</div>}
                        </td>
                        <td style={tdStyle}>
                          {p.office_name || '—'}
                          {p.district_name && <div style={{ color: T.muted, fontSize: 11 }}>{displayDistrict(p.district_name)}</div>}
                        </td>
                        <td style={tdStyle}>
                          {displayParty(p.affiliation || p.party) || <span style={{ color: T.faint }}>unknown</span>}
                          {p.affiliation_detail?.inferred && (
                            <div title={p.affiliation_detail?.basis || ''} style={{ marginTop: 3 }}>
                              <Pill c={T.amber} bg={T.warmBg}>inferred {p.affiliation_detail?.confidence ?? 0}%</Pill>
                            </div>
                          )}
                        </td>
                        <td style={{ ...tdStyle, overflow: 'visible' }}><ScoreCell row={p} /></td>
                        <td style={tdStyle}><ContactCell row={p} /></td>
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
                          <div style={{ marginTop: 4 }}><SocialLinks socials={p.socials} /></div>
                        </td>
                        <td style={{ ...tdStyle, overflow: 'visible' }}><AgencyCell row={p} /></td>
                        <td style={tdStyle}>
                          {inMine
                            ? <Pill c="#1F6F43" bg="#E6F5EC"><Check style={{ width: 11, height: 11, marginRight: 3 }} /> In My Candidates</Pill>
                            : <Btn onClick={() => addToMyCandidates(p)} disabled={busy} style={{ fontSize: 11.5, padding: '5px 10px' }}>
                                {busy ? <Spinner size={12} /> : <UserPlus style={{ width: 12, height: 12 }} />} Add to My Candidates
                              </Btn>}
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

          <div style={{ fontSize: 11, color: T.muted, lineHeight: 1.6, marginTop: 12, maxWidth: 820 }}>
            <strong style={{ color: T.ink3 }}>Where this data comes from.</strong> Candidates are found by live web
            search and every row cites the page that names them. <strong style={{ color: T.ink3 }}>Win odds are an
            AI estimate</strong> from public reporting (incumbency, district lean, primary context, coverage) — open
            any score for the one-line rationale; treat it as a first-pass sort, not a forecast. Party is taken from a
            cited page where one exists. Websites are confirmed by fetching them. Contact details and agency signals
            come only from candidate-published pages, their public social profiles, and cited news coverage.
            Wisconsin campaign-finance (CFIS/WEC) records are deliberately not used for contact or vendor data
            pending a legal review of Wis. Stat. §11.1304(12). Outreach you send from this list is a commercial
            message — include a physical address and a working opt-out.
          </div>
        </>
      )}

      {showAddModal && (
        <AddToCandidatesModal
          rows={csvRows}
          userId={user?.id}
          onClose={() => setShowAddModal(false)}
          onDone={async () => { setShowAddModal(false); await loadAll(); setTab('discover') }}
        />
      )}

      {showSaveListModal && (
        <SaveListModal
          count={visibleResults.length}
          defaultName={`Enriched prospects — ${format(new Date(), 'MMM d, yyyy')}`}
          onClose={() => setShowSaveListModal(false)}
          onSave={confirmSaveAsList}
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
