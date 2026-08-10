// src/pages/settings/shared.jsx — design primitives for the Settings redesign.
//
// Tokens MIRROR `T` in src/pages/profiler/shared.jsx (which itself mirrors
// src/pages/dashboard/shared.jsx). They are copied rather than imported for the
// same reason the Profiler copies them: those modules pull in page-level trees
// (and Leaflet, via the dashboard) at import time. Keep the three in sync.
//
// Two hard rules from the review rounds are enforced here rather than left to
// each call site: nothing renders below 11px, and no grey lighter than #71717A
// is used for text on white.

import React from 'react'

export const T = {
  page:    '#FBFBFA',
  card:    '#FFFFFF',
  border:  '#ECECEA',
  divider: '#F2F2F0',
  line:    '#F5F4F1',
  ink:     '#18181B',
  ink2:    '#27272A',
  ink3:    '#3F3F46',
  ink4:    '#52525B',
  muted:   '#6B6B73',   // darker than #71717A — safe on white
  faint:   '#71717A',   // the lightest grey allowed on white
  red:     '#A51C24',
  redDark: '#7E141B',
  redHot:  '#B91C1C',
  redBr:   '#FBD5D5',
  redBg:   '#FEF2F2',
  navy:    '#0D1526',
  green:   '#15803D',
  greenBg: '#E6F5EC',
  amber:   '#B45309',
  warmBg:  '#FDF6F0',
  warmBr:  '#F4E4D4',
  hover:   '#FAFAF9',
  chip:    '#F1F1EF',
  field:   '#DEDEDA',
  track:   '#EDECE8',
  off:     '#D6D6D2',
  font:    "'Geist','Inter',system-ui,-apple-system,sans-serif",
}

export const cardStyle = {
  background: T.card,
  border: `1px solid ${T.border}`,
  borderRadius: 16,
  boxShadow: '0 1px 3px rgba(0,0,0,.03)',
  overflow: 'hidden',
}

// Minimum interactive target. Applied to every button/row control.
export const TAP = 44

export const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || `${one}s`)}`

/** Money, always grouped: $3,990 — never $3990. */
export const money = (n) => `$${Number(n).toLocaleString('en-US')}`

/**
 * Page keyframes + breakpoints, scoped to this page's own markup.
 *
 * The hero and the plan header stack at 1180px, not 900: their right-hand
 * blocks need ~1150px to sit beside the text. The rail becomes a chip row at
 * 900px.
 */
export function SettingsStyles() {
  return (
    <style>{`
      @keyframes stRise { 0% { transform: translate(-50%, 14px); opacity: 0 } 100% { transform: translate(-50%, 0); opacity: 1 } }
      @keyframes stSpin { 0% { transform: rotate(0) } 100% { transform: rotate(360deg) } }
      .st-nav      { transition: background .16s ease }
      .st-nav:hover:not([data-on="true"]) { background: #F1F0EC }
      .st-btn      { transition: background .15s ease, border-color .15s ease }
      .st-input:focus { border-color: #C9C8C3; outline: none }
      .st-link     { color: ${T.ink}; text-decoration: underline; text-underline-offset: 2px }
      .st-link:hover { color: ${T.red} }
      @media (max-width: 1180px) {
        .st-hero      { flex-wrap: wrap !important }
        .st-herostats { margin-left: 0 !important; width: 100%; flex-wrap: wrap }
        .st-planhdr   { flex-wrap: wrap !important }
        .st-planhdr .st-ctl { margin-left: 0 !important; width: 100% }
      }
      @media (max-width: 1080px) {
        .st-rail { width: 180px !important }
      }
      @media (max-width: 900px) {
        .st-rail  { display: none !important }
        .st-chips { display: flex !important }
        .st-row   { flex-direction: column !important; align-items: flex-start !important; gap: 10px !important }
        .st-row .st-ctl { margin-left: 0 !important; width: 100% }
        .st-2col  { grid-template-columns: 1fr !important }
        .st-plans { grid-template-columns: 1fr !important }
        .st-meters{ grid-template-columns: 1fr !important }
      }
    `}</style>
  )
}

/** Bleeds Layout's page padding so Settings owns the full warm canvas. */
export function SettingsShell({ children }) {
  return (
    <div
      className="-m-4 md:-m-6 lg:-m-8 p-4 md:p-6 lg:p-8"
      style={{ background: T.page, minHeight: '100%', fontFamily: T.font, color: T.ink }}
    >
      <SettingsStyles />
      <div style={{ maxWidth: 1180, margin: '0 auto' }}>{children}</div>
    </div>
  )
}

// ── Cards ─────────────────────────────────────────────────────────────────────

export function Card({ title, desc, right, children, tone, style }) {
  const danger = tone === 'danger'
  return (
    <section style={{
      ...cardStyle,
      border: `1px solid ${danger ? T.redBr : T.border}`,
      boxShadow: danger ? 'none' : cardStyle.boxShadow,
      ...style,
    }}>
      {(title || desc) && (
        <header style={{
          display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap',
          padding: '18px 24px 14px',
          borderBottom: `1px solid ${danger ? '#FDEAEA' : T.divider}`,
        }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            {title && <h2 style={{ fontSize: 15, fontWeight: 700, margin: 0, color: danger ? T.redHot : T.ink }}>{title}</h2>}
            {desc && <p style={{ fontSize: 12.5, color: T.ink4, margin: '3px 0 0', lineHeight: 1.55 }}>{desc}</p>}
          </div>
          {right}
        </header>
      )}
      {children}
    </section>
  )
}

export function CardBody({ children, style }) {
  return <div style={{ padding: '16px 24px 18px', ...style }}>{children}</div>
}

/**
 * Label / description on the left, one control on the right. Stacks below 900px
 * (see `.st-row` above) — the control keeps its 44px target either way.
 */
export function Row({ title, desc, badge, control, last, children }) {
  return (
    <div className="st-row" style={{
      display: 'flex', alignItems: 'center', gap: 14,
      padding: '13px 24px',
      borderBottom: last ? 'none' : `1px solid ${T.line}`,
    }}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>{title}</span>
          {badge}
        </div>
        {desc && <div style={{ fontSize: 12, color: T.ink4, lineHeight: 1.5, marginTop: 2 }}>{desc}</div>}
        {children}
      </div>
      {control}
    </div>
  )
}

// ── Controls ──────────────────────────────────────────────────────────────────

const BTN_KINDS = {
  primary: { background: T.red,     color: '#fff',   border: '1px solid transparent',  hover: T.redDark },
  ghost:   { background: '#fff',    color: T.ink4,   border: `1px solid ${T.field}`,   hover: T.hover },
  dark:    { background: T.navy,    color: '#fff',   border: '1px solid transparent',  hover: '#1A2440' },
  danger:  { background: '#fff',    color: T.redHot, border: `1px solid ${T.redBr}`,   hover: T.redBg },
  glass:   { background: 'rgba(255,255,255,.09)', color: '#E4E7EE', border: '1px solid rgba(255,255,255,.16)', hover: 'rgba(255,255,255,.16)' },
  quiet:   { background: 'transparent', color: T.faint, border: '1px solid transparent', hover: T.hover },
}

export function Btn({ children, onClick, kind = 'ghost', disabled, style, title, type = 'button', ctl }) {
  const k = BTN_KINDS[kind] || BTN_KINDS.ghost
  return (
    <button
      type={type}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`st-btn${ctl ? ' st-ctl' : ''}`}
      onMouseEnter={e => { if (!disabled) e.currentTarget.style.background = k.hover }}
      onMouseLeave={e => { e.currentTarget.style.background = k.background }}
      style={{
        background: k.background, color: k.color, border: k.border,
        borderRadius: 99, padding: '8px 15px', fontSize: 12, fontWeight: 600,
        fontFamily: 'inherit', lineHeight: 1.2,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.55 : 1,
        minHeight: TAP,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
        whiteSpace: 'nowrap',           // "Manage billing" never breaks mid-phrase
        flex: 'none',
        ...style,
      }}
    >{children}</button>
  )
}

/** Text-only action (Discard, Rotate URL, Cancel plan). Still a 44px target. */
export function LinkBtn({ children, onClick, color = T.faint, disabled, style }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        background: 'none', border: 0, padding: '0 2px', minHeight: TAP,
        fontSize: 12, fontWeight: 600, fontFamily: 'inherit', color,
        cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.55 : 1,
        whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: 6,
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
      display: 'inline-block', flex: 'none', ...style,
    }}>{children}</span>
  )
}

/** Clearly-labeled placeholder. Used only where nothing is wired up yet. */
export function StubPill() {
  return <Pill c={T.ink4} bg={T.chip}>NOT YET AVAILABLE</Pill>
}

export function Toggle({ on, onChange, disabled, label, title }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={!!on}
      aria-label={label}
      title={title}
      disabled={disabled}
      onClick={onChange}
      style={{
        marginLeft: 'auto', flex: 'none', background: 'none', border: 0,
        padding: '0 0 0 10px', minHeight: TAP,
        display: 'flex', alignItems: 'center',
        cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.55 : 1,
      }}
    >
      <span style={{
        display: 'block', width: 40, height: 23, borderRadius: 99,
        background: on ? T.green : T.off, position: 'relative',
        transition: 'background .2s ease',
      }}>
        <span style={{
          position: 'absolute', top: 3, left: on ? 20 : 3, width: 17, height: 17,
          borderRadius: '50%', background: '#fff', transition: 'left .2s ease',
        }} />
      </span>
    </button>
  )
}

export function ChoicePill({ label, on, onClick, disabled }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={on}
      className="st-btn"
      style={{
        border: `1px solid ${on ? T.ink : T.field}`,
        background: on ? T.ink : '#fff',
        color: on ? '#fff' : T.ink3,
        borderRadius: 9, padding: '8px 15px', minHeight: TAP,
        fontSize: 12, fontWeight: on ? 600 : 500, fontFamily: 'inherit',
        cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.55 : 1,
        whiteSpace: 'nowrap',
      }}
    >{label}</button>
  )
}

export function Field({ label, hint, style, inputStyle, ...props }) {
  return (
    <label style={{ display: 'block', minWidth: 0, ...style }}>
      <span style={{ display: 'block', fontSize: 11.5, fontWeight: 600, color: T.ink3, marginBottom: 6 }}>{label}</span>
      <input
        className="st-input"
        {...props}
        style={{
          width: '100%', boxSizing: 'border-box', minHeight: TAP,
          border: `1px solid ${T.field}`, borderRadius: 10, padding: '10px 13px',
          fontSize: 13, fontFamily: 'inherit', color: T.ink, background: '#fff',
          outline: 'none',
          ...inputStyle,
        }}
      />
      {hint && <span style={{ display: 'block', fontSize: 11, color: T.muted, marginTop: 5 }}>{hint}</span>}
    </label>
  )
}

export function Note({ children, style }) {
  return <p style={{ fontSize: 12, color: T.ink4, lineHeight: 1.55, margin: 0, ...style }}>{children}</p>
}

/** Inline success / error / info message. */
export function Msg({ type = 'info', children, onDismiss }) {
  const tone = type === 'success'
    ? { bg: T.greenBg, br: '#CDE9D8', c: T.green }
    : type === 'error'
      ? { bg: T.redBg, br: T.redBr, c: T.redHot }
      : { bg: T.warmBg, br: T.warmBr, c: T.amber }
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 10,
      background: tone.bg, border: `1px solid ${tone.br}`, borderRadius: 12,
      padding: '11px 14px', fontSize: 12.5, lineHeight: 1.55, color: tone.c, fontWeight: 500,
    }}>
      <span style={{ minWidth: 0, flex: 1 }}>{children}</span>
      {onDismiss && (
        <button type="button" onClick={onDismiss} aria-label="Dismiss"
          style={{ background: 'none', border: 0, color: tone.c, cursor: 'pointer', fontSize: 12, fontWeight: 700, padding: 0, lineHeight: 1.4 }}>
          Dismiss
        </button>
      )}
    </div>
  )
}

export function Spinner({ size = 14, color = T.red }) {
  return (
    <span style={{
      width: size, height: size, borderRadius: '50%', flex: 'none', display: 'inline-block',
      border: `2px solid ${T.chip}`, borderTopColor: color, animation: 'stSpin .8s linear infinite',
    }} />
  )
}
