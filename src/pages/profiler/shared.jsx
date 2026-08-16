// src/pages/profiler/shared.jsx — design primitives for the Profiler redesign.
//
// Tokens MIRROR `T` in src/pages/dashboard/shared.jsx exactly. They are copied
// rather than imported because that module pulls in Leaflet (and its CSS) at
// import time, and the report reader is also used by SharedDossier.jsx — a
// PUBLIC, non-lazy route that must not ship a map library. Keep the two in sync.
//
// Two hard rules from the review rounds are enforced here rather than left to
// each call site: nothing renders below 11px, and no grey lighter than #71717A
// is used for text on white.

import React from 'react'
import { partyGroup } from '../../lib/party'
import { plural } from '../../lib/text'

export const T = {
  page:    '#FBFBFA',
  card:    '#FFFFFF',
  border:  '#ECECEA',
  divider: '#F2F2F0',
  line:    '#F0EFEC',
  ink:     '#18181B',
  ink2:    '#27272A',
  ink3:    '#3F3F46',
  ink4:    '#52525B',
  muted:   '#6B6B73',   // darker than #71717A — safe on white
  faint:   '#71717A',   // the lightest grey allowed on white
  red:     '#A51C24',
  redDark: '#7E141B',
  redHot:  '#B91C1C',
  navy:    '#0D1526',
  green:   '#15803D',
  amber:   '#B45309',
  amberBar:'#D9A036',
  warmBg:  '#FDF6F0',
  warmBr:  '#F4E4D4',
  hover:   '#FAFAF9',
  chip:    '#F1F1EF',
  field:   '#DEDEDA',
  track:   '#EDECE8',
  font:    "'Geist','Inter',system-ui,-apple-system,sans-serif",
}

export const cardStyle = {
  background: T.card,
  border: `1px solid ${T.border}`,
  borderRadius: 16,
  boxShadow: '0 1px 3px rgba(0,0,0,.03)',
}

// Minimum interactive target (SPEC §4). Applied to every button/row control.
export const TAP = 44

/** Page keyframes + the SPEC §4 breakpoints, scoped to this page's own markup. */
export function ProfilerStyles() {
  return (
    <style>{`
      @keyframes pfPulse   { 0%,100% { opacity: 1 } 50% { opacity: .35 } }
      @keyframes pfBreathe { 0%,100% { opacity: 1 } 50% { opacity: .62 } }
      @keyframes pfSlide   { 0% { transform: translateX(-100%) } 100% { transform: translateX(200%) } }
      @keyframes pfSpin    { 0% { transform: rotate(0) } 100% { transform: rotate(360deg) } }
      .pf-row  { transition: background .12s ease; cursor: pointer }
      .pf-row:hover { background: ${T.hover} }
      .pf-btn  { transition: background .15s ease, border-color .15s ease }
      .pf-doc a { color: ${T.ink}; text-decoration: underline; text-underline-offset: 2px }
      .pf-doc a:hover { color: ${T.red} }
      .pf-input:focus { border-color: #D6D6D2; outline: none }
      @media (max-width: 1100px) {
        .pf-rail    { display: none !important }
        .pf-doccols { grid-template-columns: 1fr !important }
        .pf-genrow  { grid-template-columns: 1fr !important }
        .pf-rowmeta { display: none !important }
      }
      @media (max-width: 900px) {
        .pf-strip     { grid-template-columns: 1fr 1fr !important }
        .pf-strip > div { border-right: none !important; border-bottom: 1px solid ${T.divider} }
        /* …but not on the last cell, or the collapsed strip draws a stray
           hairline right above the card's own rounded bottom edge. */
        .pf-strip > div:last-child { border-bottom: none }
        .pf-head      { flex-direction: column !important; align-items: flex-start !important }
        .pf-headright { margin-left: 0 !important; width: 100% }
        .pf-doc       { padding-left: 20px !important; padding-right: 20px !important }
        .pf-kv        { grid-template-columns: 1fr !important }
        .pf-stages    { flex-wrap: wrap !important }
        .pf-stages > div { min-width: 44% }
      }
      @media (max-width: 560px) {
        .pf-strip { grid-template-columns: 1fr !important }
      }
    `}</style>
  )
}

/** Bleeds Layout's page padding so the Profiler owns the full warm canvas. */
export function ProfilerShell({ children }) {
  return (
    <div
      className="-m-4 md:-m-6 lg:-m-8 p-4 md:p-6 lg:p-8"
      style={{ background: T.page, minHeight: '100%', fontFamily: T.font, color: T.ink }}
    >
      <ProfilerStyles />
      {children}
    </div>
  )
}

// ── Buttons ───────────────────────────────────────────────────────────────────

const BTN_KINDS = {
  primary: { background: T.red, color: '#fff', border: '1px solid transparent', hover: T.redDark },
  ghost:   { background: '#fff', color: T.ink, border: `1px solid ${T.border}`, hover: T.hover },
  warm:    { background: '#fff', color: T.ink4, border: '1px solid #E8D5C0', hover: T.warmBr },
  quiet:   { background: 'transparent', color: T.faint, border: '1px solid transparent', hover: T.hover },
}

export function Btn({ children, onClick, kind = 'ghost', disabled, style, title, type = 'button', tap = true }) {
  const k = BTN_KINDS[kind] || BTN_KINDS.ghost
  return (
    <button
      type={type}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className="pf-btn"
      onMouseEnter={e => { if (!disabled) e.currentTarget.style.background = k.hover }}
      onMouseLeave={e => { e.currentTarget.style.background = k.background }}
      style={{
        background: k.background, color: k.color, border: k.border,
        borderRadius: 99, padding: '8px 15px', fontSize: 12, fontWeight: 600,
        fontFamily: 'inherit', lineHeight: 1.2,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.55 : 1,
        minHeight: tap ? TAP : 32,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
        whiteSpace: 'nowrap',
        ...style,
      }}
    >{children}</button>
  )
}

export function Pill({ children, c = T.ink4, bg = T.chip, style }) {
  return (
    <span style={{
      fontSize: 11, fontWeight: 700, color: c, background: bg, letterSpacing: '.2px',
      borderRadius: 99, padding: '2px 8px', whiteSpace: 'nowrap', lineHeight: 1.45,
      display: 'inline-block', ...style,
    }}>{children}</span>
  )
}

export function Avatar({ name, party, size = 34, radius = 9 }) {
  const p = partyTint(party)
  const initials = String(name || '').trim().split(/\s+/).slice(0, 2)
    .map(w => w.charAt(0).toUpperCase()).join('') || '?'
  return (
    <span style={{
      flex: 'none', width: size, height: size, borderRadius: radius,
      background: p.bg, color: p.c, fontSize: Math.max(11, Math.round(size * 0.32)),
      fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>{initials}</span>
  )
}

// Party tints — same pairs as PARTY_HEX in lib/campaignEnums.js, kept local for
// the same no-side-effect reason as the tokens above.
export const PARTY_TINT = {
  Republican:   { c: '#B91C1C', bg: '#FBEAEA' },
  Democrat:     { c: '#2563EB', bg: '#E7F0FD' },
  Independent:  { c: '#7C3AED', bg: '#F3EDFB' },
  Libertarian:  { c: '#B45309', bg: '#FDF3E3' },
  Green:        { c: '#15803D', bg: '#E6F5EC' },
  Constitution: { c: '#0F766E', bg: '#E6F5F3' },
  Nonpartisan:  { c: '#52525B', bg: '#F1F1EF' },
  Other:        { c: '#52525B', bg: '#F1F1EF' },
}

// Same pairs reached from any spelling ('Democrat' / 'Democratic' / 'DEM').
// Constitution has no partyGroup of its own, so by-name wins first.
const PARTY_TINT_BY_GROUP = {
  R: PARTY_TINT.Republican, D: PARTY_TINT.Democrat,   I: PARTY_TINT.Independent,
  L: PARTY_TINT.Libertarian, G: PARTY_TINT.Green,     N: PARTY_TINT.Nonpartisan,
  O: PARTY_TINT.Other,
}
export const partyTint = (p) => PARTY_TINT[p] || PARTY_TINT_BY_GROUP[partyGroup(p)] || PARTY_TINT.Other

// ── Stat strip ────────────────────────────────────────────────────────────────
//
// NOT the same widget as `StatStrip` in src/pages/dashboard/shared.jsx, despite
// having shared a name until now. That one is a fixed N-across card that
// collapses to a 2-up grid below 760px, with 18px/22px cells and a 26px numeral.
// This one takes an explicit `cols` (the profiler headers are 3- and 4-up
// regardless of width), a `style` override, a 14px radius and tighter 15px/20px
// cells. Renamed rather than merged: consolidating them would change the pixels
// on one page or the other. The same caveat applies to `StatCell` below, whose
// props (`of`, `valueColor`, `bar`, `center`, `right`) are not the dashboard
// cell's props (`chip`, `valueSize`, `truncate`).

export function ProfilerStatStrip({ children, cols, style }) {
  const cells = React.Children.toArray(children)
  return (
    <div className="pf-strip" style={{
      ...cardStyle, borderRadius: 14, display: 'grid',
      gridTemplateColumns: `repeat(${cols || cells.length}, minmax(0,1fr))`,
      marginBottom: 16, ...style,
    }}>
      {cells.map((cell, i) => (
        <div key={i} style={{
          padding: '15px 20px', minWidth: 0,
          borderRight: i === cells.length - 1 ? 'none' : `1px solid ${T.divider}`,
        }}>{cell}</div>
      ))}
    </div>
  )
}

export function StatCell({ label, value, of, sub, valueColor, bar, center, right }) {
  return (
    <>
      <div style={{ fontSize: 11.5, fontWeight: 600, color: T.ink3, textAlign: center ? 'center' : 'left' }}>{label}</div>
      <div style={{
        fontSize: 22, fontWeight: 800, lineHeight: 1, marginTop: 7,
        color: valueColor || T.ink, textAlign: center ? 'center' : 'left',
      }}>
        {value}
        {of != null && <span style={{ fontSize: 13, fontWeight: 600, color: T.muted }}> {of}</span>}
      </div>
      {bar}
      {sub && (
        <div style={{
          fontSize: 11, color: T.muted, marginTop: 8, textAlign: center ? 'center' : 'left',
          display: right ? 'flex' : 'block', alignItems: 'center',
          justifyContent: center ? 'center' : 'flex-start', gap: 8, flexWrap: 'wrap',
        }}>
          {sub}{right}
        </div>
      )}
    </>
  )
}

/** Two-tone sourcing bar. Widths are the real ratio; grey is "no tagged claims". */
export function RatioBar({ good = 0, weak = 0, style }) {
  const total = good + weak
  const g = total ? (good / total) * 100 : 0
  const w = total ? (weak / total) * 100 : 0
  return (
    <div style={{
      display: 'flex', height: 5, borderRadius: 99, overflow: 'hidden',
      background: T.chip, marginTop: 9, ...style,
    }}>
      <div style={{ width: `${g}%`, background: T.green }} />
      <div style={{ width: `${w}%`, background: T.amberBar }} />
    </div>
  )
}

// ── Misc ──────────────────────────────────────────────────────────────────────

export function Rich({ html, style, as: Tag = 'span' }) {
  return <Tag style={style} dangerouslySetInnerHTML={{ __html: html }} />
}

export function Spinner({ size = 16, color = T.red }) {
  return (
    <span style={{
      width: size, height: size, borderRadius: '50%', flex: 'none', display: 'inline-block',
      border: `2px solid ${T.chip}`, borderTopColor: color, animation: 'pfSpin .8s linear infinite',
    }} />
  )
}

export function EmptyNote({ children, style }) {
  return <div style={{ fontSize: 12.5, color: T.muted, lineHeight: 1.6, ...style }}>{children}</div>
}

/** "today" · "yesterday" · "7 days ago" · "3 weeks ago" — no invented precision. */
export function relativeAge(iso) {
  const t = iso ? new Date(iso).getTime() : NaN
  if (!Number.isFinite(t)) return ''
  const days = Math.floor((Date.now() - t) / 86400000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 14) return `${days} days ago`
  if (days < 60) return `${Math.round(days / 7)} weeks ago`
  return `${Math.round(days / 30)} months ago`
}

export function elapsedLabel(startedAt) {
  const t = startedAt ? new Date(startedAt).getTime() : NaN
  if (!Number.isFinite(t)) return 'just started'
  const sec = Math.max(0, Math.round((Date.now() - t) / 1000))
  if (sec < 10) return 'just started'
  if (sec < 90) return `started ${Math.round(sec / 5) * 5} seconds ago`
  const min = Math.round(sec / 60)
  return `started ${min} minute${min === 1 ? '' : 's'} ago`
}

// One copy, in lib/text.js. Re-exported so the profiler files can keep pulling
// everything they need from ./shared.
export { plural }
