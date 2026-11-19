// ─── ui.jsx — the v2.0 tile kit ──────────────────────────────────────────────
// The look of mycandidatepage.com's dashboard, shared by every redesigned
// BadgerBoard screen: a light wash ground, white tiles with soft elevation
// (shadow-e2, rounded-tile), one deep-navy hero tile per screen at most, a
// colored icon square on each tile head, big tight DM Sans numbers, and an
// "Open" affordance in the tile's bottom corner.
//
// Rules of thumb for new screens:
//   • PageHead first: one heavy title, an optional one-line sub, actions right.
//   • Tiles, not tables, when a person has a handful of things (≤ ~24).
//   • Color carries meaning: ICON_COLORS name what kind of thing a tile is.
//   • Numbers that matter are big; the words around them are small.

import { Link } from 'react-router-dom'
import { ArrowRight } from 'lucide-react'

export const ICON_COLORS = {
  red:    '#E0362C',
  blue:   '#2F6BFF',
  green:  '#16803C',
  purple: '#7C3AED',
  orange: '#C2410C',
  teal:   '#0E7490',
  ink:    '#11161C',
  navy:   '#0E1A3A',
  gray:   '#5B636C',
}

const cx = (...a) => a.filter(Boolean).join(' ')

/** Page title row: heavy display title, optional eyebrow, sub line and actions. */
export function PageHead({ eyebrow, title, sub, right, className = '' }) {
  return (
    <div className={cx('flex flex-wrap items-end gap-x-6 gap-y-3 pt-4 pb-5', className)}>
      <div className="min-w-0 flex-1">
        {eyebrow && <div className="eyebrow mb-3">{eyebrow}</div>}
        <h1 className="display text-[28px] leading-[1.08] md:text-[34px]">{title}</h1>
        {sub && <p className="mt-1.5 max-w-2xl text-[15px] leading-relaxed text-brand-mute">{sub}</p>}
      </div>
      {right && <div className="flex flex-wrap items-center gap-2">{right}</div>}
    </div>
  )
}

/** A colored rounded square holding a white icon — names what kind of thing a tile is. */
export function IconChip({ icon: Icon, color = 'ink', size = 32, className = '' }) {
  const bg = ICON_COLORS[color] || color
  return (
    <span
      className={cx('inline-flex flex-shrink-0 items-center justify-center rounded-[10px] text-white', className)}
      style={{ width: size, height: size, background: bg }}
      aria-hidden="true"
    >
      {Icon && <Icon style={{ width: size * 0.5, height: size * 0.5 }} strokeWidth={2.2} />}
    </span>
  )
}

/**
 * A tile. `to` makes it a router link, `onClick` a button, otherwise a div.
 * `dark` is the deep-navy hero treatment (white text) — one per screen.
 */
export function Tile({ to, onClick, dark = false, className = '', children, style, ariaLabel, ...rest }) {
  const base = cx(
    'relative block min-w-0 overflow-hidden rounded-tile text-left',
    dark ? 'text-white shadow-e3' : 'bg-white shadow-e2',
    (to || onClick) && 'tile-link cursor-pointer',
    className,
  )
  const darkStyle = dark
    ? { background: 'radial-gradient(120% 90% at 20% 0%, #1D2F63 0%, #0E1A3A 55%, #0A1330 100%)', ...style }
    : style
  if (to) return <Link to={to} className={base} style={darkStyle} aria-label={ariaLabel} {...rest}>{children}</Link>
  if (onClick) return <button type="button" onClick={onClick} className={base} style={darkStyle} aria-label={ariaLabel} {...rest}>{children}</button>
  return <div className={base} style={darkStyle} {...rest}>{children}</div>
}

/** Tile head: icon chip + title, optional right slot (a count badge, a menu). */
export function TileHead({ icon, color, title, right, dark = false }) {
  return (
    <div className="flex items-center gap-2.5">
      {icon && (dark
        ? <span className="inline-flex h-8 w-8 items-center justify-center rounded-[10px] border border-white/15 bg-white/10">{(() => { const I = icon; return <I className="h-4 w-4" /> })()}</span>
        : <IconChip icon={icon} color={color} />)}
      <span className={cx('text-[16px] font-bold', dark ? 'text-white' : 'text-brand-ink')}>{title}</span>
      {right && <span className="ml-auto">{right}</span>}
    </div>
  )
}

/** The big number on a tile, with a small unit/caption beside it. */
export function BigNumber({ value, unit, dark = false, size = 44 }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2.5">
      <span className="font-extrabold tracking-display" style={{ fontSize: size, lineHeight: 1 }}>{value}</span>
      {unit && <span className={cx('text-[15px] font-medium', dark ? 'text-white/70' : 'text-brand-mute')}>{unit}</span>}
    </div>
  )
}

/** "Open →" — a white pill on dark tiles, a quiet word on light ones. */
export function OpenCue({ dark = false, label = 'Open' }) {
  return dark ? (
    <span className="inline-flex items-center gap-1.5 rounded-xl bg-white px-3.5 py-2 text-[14px] font-bold text-brand-ink shadow-e2">
      {label} <ArrowRight className="h-4 w-4" />
    </span>
  ) : (
    <span className="text-[13px] font-semibold text-brand-faint">{label}</span>
  )
}

/** Small count badge (the round number on a board column head). */
export function CountBadge({ n, color = 'ink' }) {
  return (
    <span
      className="inline-flex h-6 min-w-[24px] items-center justify-center rounded-full px-1.5 text-[12px] font-bold text-white"
      style={{ background: ICON_COLORS[color] || color }}
    >{n}</span>
  )
}

/** Segmented pill toggle ("To do · History"). */
export function Segmented({ options, value, onChange, className = '' }) {
  return (
    <div className={cx('inline-flex rounded-xl bg-white p-1 shadow-e1', className)} role="tablist">
      {options.map(o => {
        const on = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onChange(o.value)}
            className={cx('rounded-lg px-3 py-1.5 text-[13px] font-semibold transition-colors',
              on ? 'bg-brand-ink text-white' : 'text-brand-mute hover:text-brand-ink')}
          >
            {o.label}{o.count != null && <span className={cx('ml-1.5', on ? 'text-white/60' : 'text-brand-faint')}>{o.count}</span>}
          </button>
        )
      })}
    </div>
  )
}

/** Initials (or photo) avatar on a colored disc. */
export function Avatar({ name, photo, size = 40, color = '#11161C', className = '' }) {
  const initials = String(name || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() || '').join('') || '?'
  return photo ? (
    <img src={photo} alt="" className={cx('flex-shrink-0 rounded-full object-cover', className)} style={{ width: size, height: size }} />
  ) : (
    <span
      className={cx('inline-flex flex-shrink-0 items-center justify-center rounded-full font-bold text-white', className)}
      style={{ width: size, height: size, background: color, fontSize: Math.round(size * 0.36) }}
      aria-hidden="true"
    >{initials}</span>
  )
}

/** Friendly empty state inside a tile or page. */
export function EmptyState({ icon, color = 'gray', title, body, action }) {
  return (
    <div className="flex flex-col items-start gap-3 py-2">
      {icon && <IconChip icon={icon} color={color} size={40} />}
      <div>
        <div className="text-[17px] font-bold text-brand-ink">{title}</div>
        {body && <p className="mt-1 max-w-md text-[14px] leading-relaxed text-brand-mute">{body}</p>}
      </div>
      {action}
    </div>
  )
}

/** Primary / secondary / dark buttons with the tile kit's shape. */
export function Button({ variant = 'primary', icon: Icon, children, className = '', ...rest }) {
  const v = {
    primary:   'bg-brand-red text-white hover:bg-brand-red-dark shadow-e1',
    dark:      'bg-brand-ink text-white hover:bg-black',
    secondary: 'bg-white text-brand-ink border border-black/10 hover:bg-gray-50 shadow-e1',
    ghost:     'text-brand-mute hover:text-brand-ink hover:bg-black/5',
  }[variant]
  return (
    <button
      type="button"
      className={cx('inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-[14px] font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-50', v, className)}
      {...rest}
    >
      {Icon && <Icon className="h-4 w-4" />}
      {children}
    </button>
  )
}
