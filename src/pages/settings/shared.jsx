// src/pages/settings/shared.jsx — design primitives for the Settings redesign.
//
// Tokens MIRROR `T` in src/pages/profiler/shared.jsx (which itself mirrors
// src/pages/dashboard/shared.jsx). They are copied rather than imported for the
// same reason the Profiler copies them: those modules pull in page-level trees
// (and Leaflet, via the dashboard) at import time. Keep the three in sync.
//
// SIZING IS THE MOCKUP, LITERALLY.
// settings-handoff/mockups/settings.dc.html is the spec. Where an earlier review
// rule disagreed with the mockup, the mockup wins:
//   • Type may go below 11px — badge pills are 9.5px, rail group labels 10px,
//     hero stat labels 9.5px, exactly as the mockup renders them.
//   • Controls are sized by their own padding. There is NO 44px minimum: it made
//     every button, input, rail item and toggle row ~20% taller than the mockup.
// Still enforced: no grey lighter than #71717A for text on white.
//
// FONT: every control sets fontFamily:'inherit' (belt-and-suspenders on top of
// the `.st-shell` rule in SettingsStyles) so button/input/select/textarea — which
// do not inherit font-family by default — stay on Geist.

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
      /* button/input/select/textarea do NOT inherit font-family by default.
         Tailwind's preflight normally handles it; this makes the settings tree
         independent of that, so Geist can never fall back to Inter here. */
      .st-shell, .st-shell button, .st-shell input, .st-shell select,
      .st-shell textarea, .st-shell optgroup { font-family: ${T.font} }
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
      className="st-shell -mx-4 -mt-2 -mb-4 md:-mx-6 md:-mb-6 lg:-mx-8 lg:-mb-8 px-4 pt-4 pb-4 md:px-6 md:pb-6 lg:px-8 lg:pb-8"
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
          padding: '18px 24px 14px',          // mockup
          borderBottom: `1px solid ${danger ? '#FDEAEA' : T.divider}`,
          fontFamily: 'inherit',
        }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            {title && <h2 style={{ fontSize: 15, fontWeight: 700, margin: 0, fontFamily: 'inherit', color: danger ? T.redHot : T.ink }}>{title}</h2>}
            {desc && <p style={{ fontSize: 12.5, color: T.ink4, margin: '3px 0 0', lineHeight: 1.55, fontFamily: 'inherit' }}>{desc}</p>}
          </div>
          {right}
        </header>
      )}
      {children}
    </section>
  )
}

export function CardBody({ children, style }) {
  // mockup: 16px 24px 18px
  return <div style={{ padding: '16px 24px 18px', fontFamily: 'inherit', ...style }}>{children}</div>
}

/**
 * Label / description on the left, one control on the right. Stacks below 900px
 * (see `.st-row` above). Mockup: 14px 24px, gap 14, title 13/600, desc 12.
 */
export function Row({ title, desc, badge, control, last, children }) {
  return (
    <div className="st-row" style={{
      display: 'flex', alignItems: 'center', gap: 14,
      padding: '14px 24px',
      borderBottom: last ? 'none' : `1px solid ${T.line}`,
      fontFamily: 'inherit',
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
        // mockup: padding 8px 15px, 12px/600, pill radius. No minimum height —
        // the mockup's buttons are ~33px tall, not 44.
        background: k.background, color: k.color, border: k.border,
        borderRadius: 99, padding: '8px 15px', fontSize: 12, fontWeight: 600,
        fontFamily: 'inherit', lineHeight: 1.35,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.55 : 1,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
        whiteSpace: 'nowrap',           // "Manage billing" never breaks mid-phrase
        flex: 'none',
        ...style,
      }}
    >{children}</button>
  )
}

/** Text-only action (Discard, Rotate URL, Cancel plan). Mockup: 12px/600. */
export function LinkBtn({ children, onClick, color = T.faint, disabled, style }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        background: 'none', border: 0, padding: '6px 2px',
        fontSize: 12, fontWeight: 600, fontFamily: 'inherit', color,
        cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.55 : 1,
        whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: 6,
        ...style,
      }}
    >{children}</button>
  )
}

/** Badge. Mockup: 9.5px/700, padding 2px 8px, pill radius. */
export function Pill({ children, c = T.ink4, bg = T.chip, style }) {
  return (
    <span style={{
      fontSize: 9.5, fontWeight: 700, color: c, background: bg, letterSpacing: '.2px',
      borderRadius: 99, padding: '2px 8px', whiteSpace: 'nowrap', lineHeight: 1.6,
      fontFamily: 'inherit', display: 'inline-block', flex: 'none', ...style,
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
        // mockup: a 40×23 track, nothing around it. The old 44px minimum was
        // what made every toggle row taller than the mockup's.
        marginLeft: 'auto', flex: 'none', background: 'none', border: 0,
        padding: '0 0 0 10px', fontFamily: 'inherit',
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
        // mockup: radius 9, padding 8px 15px, 12px
        borderRadius: 9, padding: '8px 15px', lineHeight: 1.35,
        fontSize: 12, fontWeight: on ? 600 : 500, fontFamily: 'inherit',
        cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.55 : 1,
        whiteSpace: 'nowrap',
      }}
    >{label}</button>
  )
}

export function Field({ label, hint, style, inputStyle, ...props }) {
  return (
    <label style={{ display: 'block', minWidth: 0, fontFamily: 'inherit', ...style }}>
      <span style={{ display: 'block', fontSize: 11.5, fontWeight: 600, color: T.ink3, marginBottom: 6, fontFamily: 'inherit' }}>{label}</span>
      <input
        className="st-input"
        {...props}
        style={{
          // mockup: border #DEDEDA, radius 10, padding 10px 13px, 13px — a
          // ~38px field, not the 44px one the old tap minimum forced.
          width: '100%', boxSizing: 'border-box', lineHeight: 1.35,
          border: `1px solid ${T.field}`, borderRadius: 10, padding: '10px 13px',
          fontSize: 13, fontFamily: 'inherit', color: T.ink, background: '#fff',
          outline: 'none',
          ...inputStyle,
        }}
      />
      {hint && <span style={{ display: 'block', fontSize: 11, color: T.muted, marginTop: 5, fontFamily: 'inherit' }}>{hint}</span>}
    </label>
  )
}

export function Note({ children, style }) {
  return <p style={{ fontSize: 12, color: T.ink4, lineHeight: 1.55, margin: 0, fontFamily: 'inherit', ...style }}>{children}</p>
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
      fontFamily: 'inherit',
    }}>
      <span style={{ minWidth: 0, flex: 1 }}>{children}</span>
      {onDismiss && (
        <button type="button" onClick={onDismiss} aria-label="Dismiss"
          style={{ background: 'none', border: 0, color: tone.c, cursor: 'pointer', fontSize: 12, fontWeight: 700, padding: 0, lineHeight: 1.4, fontFamily: 'inherit' }}>
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
