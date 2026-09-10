// shared.jsx — primitives common to the Candidate and Action plan dashboards.
//
// The dashboards are styled with inline styles rather than Tailwind because the
// approved mockups specify exact pixel/hex values that don't map cleanly onto
// the existing utility scale. Tokens live in `T` so the two files can't drift.
//
// Everything that reads campaign vocabulary (phases, statuses, parties,
// election types, digest categories) imports it from lib/campaignEnums.js.
// Everything that reads plan limits imports from lib/tiers.js. Nothing here
// invents a number.

import React, { useEffect, useMemo, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { format, startOfWeek } from 'date-fns'
import { safeISO } from '../../lib/date'
// Date arithmetic lives in ./dueMath (a JSX-free module the tests can import).
import {
  daysUntil, isUpcoming, autoStatus, countdownLabel, fmtDueDate, dueChipLabel,
} from './dueMath'
import { officeLine } from '../../lib/office'
import { pointInGeometry } from '../../lib/geo'
import { supabase } from '../../lib/supabase'
import {
  PHASE_MAP, digestCategory, partyHex, partyInitial,
  ELECTION_TYPE_LABELS, ELECTION_TYPE_SHORT, ELECTION_TYPE_HEX,
  CANDIDATE_STATUS_HEX, candidateStatusLabel,
} from '../../lib/campaignEnums'
import { getMonitoringSlotMax } from '../../lib/tiers'

// ── Design tokens ─────────────────────────────────────────────────────────────

export const T = {
  page:    '#FBFBFA',
  card:    '#FFFFFF',
  border:  '#ECECEA',
  divider: '#F2F2F0',
  ink:     '#18181B',
  ink2:    '#3F3F46',
  ink3:    '#52525B',
  muted:   '#71717A',
  faint:   '#A1A19A',
  red:     '#8B0000',
  redDark: '#7E141B',
  redHot:  '#B91C1C',
  navy:    '#0A1628',
  hover:   '#FAFAF9',
  chip:    '#F1F1EF',
  warmBg:  '#FDF6F0',
  warmBr:  '#F4E4D4',
  warmInk: '#B45309',
  font:    "'Geist','Inter',system-ui,-apple-system,sans-serif",
}

export const cardStyle = {
  background: T.card,
  border: `1px solid ${T.border}`,
  borderRadius: 16,
  boxShadow: '0 1px 3px rgba(0,0,0,.03)',
}

// Keyframes + scrollbar rules the inline styles can't express. Rendered once
// per dashboard; duplicate <style> tags with identical content are harmless.
export function DashboardStyles() {
  return (
    <style>{`
      @keyframes bbLivePulse { 0%,100% { opacity: 1 } 50% { opacity: .3 } }
      /* Carousel: the permanent grey scrollbar plus a card sliced off flush at
         the container edge read as a clipping bug rather than as "scroll me".
         Scrollbar hidden (scrolling itself untouched), last card faded out at
         the right edge, cards snapped to the left edge. .bb-carousel--end drops
         the fade when there is nothing further to scroll to. */
      .bb-carousel {
        scrollbar-width: none;
        -ms-overflow-style: none;
        scroll-snap-type: x proximity;
        -webkit-mask-image: linear-gradient(to right, #000 0, #000 calc(100% - 48px), transparent 100%);
        mask-image: linear-gradient(to right, #000 0, #000 calc(100% - 48px), transparent 100%);
      }
      .bb-carousel::-webkit-scrollbar { display: none }
      .bb-carousel > * { scroll-snap-align: start }
      .bb-carousel--end { -webkit-mask-image: none; mask-image: none }
      .bb-row:hover { background: ${T.hover} }
      .bb-link { color: ${T.muted}; text-decoration: none }
      .bb-link:hover { color: ${T.ink2} }
      .bb-cta { transition: background .15s ease }
    `}</style>
  )
}

// ── Small helpers ─────────────────────────────────────────────────────────────

// Crash-proof parseISO. Lives in lib/date.js now; re-exported here because the
// candidate views import it (and everything else in this module) from ./shared.
// NOTE the contract: null on a missing/unparseable date, NOT an epoch Date —
// fmtDate/isUpcoming below branch on that null. Elections.jsx and GamePlan.jsx
// need the opposite and import safeISOOrEpoch instead.
export { safeISO }

export const fmtInt = (n) =>
  Number.isFinite(n) ? n.toLocaleString() : '—'

export const fmtDate = (d, pattern = 'MMM d') => {
  const t = safeISO(d)
  return t ? format(t, pattern) : '—'
}

// daysUntil / isUpcoming / autoStatus / countdownLabel / fmtDueDate /
// dueChipLabel all live in ./dueMath now — see the countdown-parity note there.
// Re-exported because the candidate views import them (and everything else in
// this module) from ./shared.
export { daysUntil, isUpcoming, autoStatus, countdownLabel, fmtDueDate, dueChipLabel }

export const relativeTime = (d) => {
  const t = safeISO(d)
  if (!t) return ''
  const mins = Math.round((Date.now() - t.getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.round(hrs / 24)
  if (days < 7) return `${days}d ago`
  return format(t, 'MMM d')
}

export const initialsOf = (name) =>
  String(name || '')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map(w => w.charAt(0).toUpperCase())
    .join('') || '?'

// ─── R3B PURE HELPERS BEGIN ───────────────────────────────────────────────────
// (no imports in this block — tests/r3b.test.mjs slices it out and imports it)

/**
 * Audit-log action → the phrase the Recent activity feed reads out loud.
 * The feed renders "You " + this, so the phrases are past-tense and lowercase.
 * Unmapped actions used to fall through raw ("You ai unlock — Brady Penfield");
 * they now at least get their underscores stripped and a capital.
 */
export const ACTIVITY_VERBS = {
  ai_unlock: 'unlocked AI access',
  ai_lock: 'locked AI access',
  profile_updated: 'updated profile',
  login: 'signed in',
}

export function humanizeActivityVerb(action) {
  const key = String(action || '').trim()
  if (!key) return 'Activity'
  if (ACTIVITY_VERBS[key]) return ACTIVITY_VERBS[key]
  const words = key.replace(/[_-]+/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}
// ─── R3B PURE HELPERS END ─────────────────────────────────────────────────────

// First name for the greeting: signup captures first_name/display_name into
// user_metadata (see AuthContext.signUp). Falls back to the email local part.
export const firstNameOf = (user) => {
  const m = user?.user_metadata || {}
  if (m.first_name) return String(m.first_name).trim().split(/\s+/)[0]
  if (m.display_name) return String(m.display_name).trim().split(/\s+/)[0]
  const local = (user?.email || '').split('@')[0]
  if (!local) return 'there'
  return local.charAt(0).toUpperCase() + local.slice(1).replace(/[._-].*$/, '')
}

// Office line: "State Representative — Assembly District 1" style. Lives in
// lib/office.js now (ActionDashboard.jsx and the profiler's ReportReader.jsx
// each had their own copy); re-exported here because the candidate views import
// it from ./shared. Defaults are this page's contract: ' — ', null when unset.
export { officeLine }

export const electionTypeLabel = (t) => ELECTION_TYPE_LABELS[t] || 'Election'
export const electionTypeShort = (t) => ELECTION_TYPE_SHORT[t] || 'Election'
export const electionTypeHex   = (t) => ELECTION_TYPE_HEX[t] || { c: T.ink3, bg: T.chip }

// Active-monitoring slot accounting — identical rule to Candidates.jsx so the
// dashboard never disagrees with the page that sets the flag.
export const monitoringSlots = (user, candidates = []) => {
  const max = getMonitoringSlotMax(user)
  const used = candidates.filter(c => c.section_timestamps?.monitoring === true).length
  return { used, max, left: max === Infinity ? Infinity : Math.max(0, max - used) }
}

export const isMonitored = (c) => c?.section_timestamps?.monitoring === true

// ── Weekly digests ───────────────────────────────────────────────────────────
// A digest is "this week's" when its dossier was generated inside the current
// Monday-anchored week — the same cadence monitoring-digest.js writes on.
// Panels titled "This week's digest" must use weekDigestOf; latestDigestOf is
// for panels that say "latest". (Both dashboards previously titled the panel
// "This week's digest" while rendering the newest digest of any age.)
const MONDAY = { weekStartsOn: 1 }

export const isThisWeek = (d) => {
  const t = safeISO(d)
  return !!t && +startOfWeek(t, MONDAY) === +startOfWeek(new Date(), MONDAY)
}

export const latestDigestOf = (dossiers = []) =>
  dossiers.find(d => d.weekly_digest?.summary) || null

export const weekDigestOf = (dossiers = []) =>
  dossiers.find(d => d.weekly_digest?.summary && isThisWeek(d.generated_at)) || null

// Next Monday — monitored profiles auto-refresh Monday mornings.
export const nextMonday = (from = new Date()) => {
  const d = new Date(from)
  d.setHours(0, 0, 0, 0)
  const delta = (8 - d.getDay()) % 7 || 7
  d.setDate(d.getDate() + delta)
  return d
}

// ── Layout primitives ─────────────────────────────────────────────────────────

// Bleeds the warm page background out under Layout's p-4/md:p-6/lg:p-8 padding
// without touching Layout.jsx.
export function DashboardShell({ children }) {
  return (
    <div
      className="-m-4 md:-m-6 lg:-m-8 p-4 md:p-6 lg:p-8"
      style={{ background: T.page, minHeight: '100%', fontFamily: T.font, color: T.ink }}
    >
      <DashboardStyles />
      {children}
    </div>
  )
}

export function Card({ children, style, className, ...rest }) {
  return (
    <div className={className} style={{ ...cardStyle, ...style }} {...rest}>
      {children}
    </div>
  )
}

export function CardHead({ title, right, sub }) {
  return (
    <div style={{ marginBottom: sub ? 4 : 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ fontSize: 13.5, fontWeight: 700, flex: 1, minWidth: 0 }}>{title}</div>
        {right}
      </div>
      {sub && <div style={{ fontSize: 11, color: T.faint, marginTop: 3 }}>{sub}</div>}
    </div>
  )
}

export function Pill({ c, bg, children, style }) {
  return (
    <span style={{
      fontSize: 9.5, fontWeight: 700, color: c, background: bg,
      borderRadius: 99, padding: '3px 8px', whiteSpace: 'nowrap',
      display: 'inline-block', lineHeight: 1.3, ...style,
    }}>{children}</span>
  )
}

export function PartyPill({ party, style }) {
  if (!party) return null
  const p = partyHex(party)
  return <Pill c={p.c} bg={p.bg} style={style}>{party}</Pill>
}

export function StatusPill({ status, style }) {
  if (!status) return null
  const s = CANDIDATE_STATUS_HEX[status] || { c: T.ink3, bg: T.chip }
  return <Pill c={s.c} bg={s.bg} style={style}>{candidateStatusLabel(status)}</Pill>
}

export function WeeklyChip({ label = 'weekly' }) {
  return (
    <span style={{
      fontSize: 10.5, fontWeight: 700, color: '#15803D', background: '#E6F5EC',
      borderRadius: 99, padding: '3px 9px', whiteSpace: 'nowrap',
    }}>● {label}</span>
  )
}

export function OverdueChip({ n }) {
  if (!n) return null
  return (
    <span style={{
      fontSize: 10.5, fontWeight: 700, color: '#DC2626', background: '#FDECEC',
      borderRadius: 99, padding: '3px 9px', whiteSpace: 'nowrap',
    }}>{n} overdue</span>
  )
}

// Due-date chip states from the spec: red overdue / orange soon / grey normal.
const DUE_STYLES = {
  done:    { c: T.faint,   bg: '#F5F5F3', br: '#F5F5F3' },
  overdue: { c: '#B91C1C', bg: '#FEF2F2', br: '#FECACA' },
  soon:    { c: '#C2410C', bg: '#FFF7ED', br: '#FED7AA' },
  normal:  { c: T.ink3,    bg: '#FAFAF9', br: T.border },
}

export function dueState(m) {
  const st = autoStatus(m)
  if (st === 'complete' || st === 'skipped') return 'done'
  if (st === 'overdue') return 'overdue'
  const d = daysUntil(m.due_date)
  if (d != null && d <= 7) return 'soon'
  return 'normal'
}

export function DueChip({ milestone }) {
  if (!milestone?.due_date) return null
  const s = DUE_STYLES[dueState(milestone)]
  return (
    <span style={{
      fontSize: 10.5, fontWeight: 600, color: s.c, background: s.bg,
      border: `1px solid ${s.br}`, borderRadius: 99, padding: '3px 10px', whiteSpace: 'nowrap',
    }}>{fmtDate(milestone.due_date)}</span>
  )
}

export function PhaseDot({ phase, size = 8 }) {
  const p = PHASE_MAP[phase]
  return (
    <span style={{
      width: size, height: size, borderRadius: '50%',
      background: p?.hex || T.faint, flexShrink: 0, display: 'inline-block',
    }} />
  )
}

export function DateTile({ date, hot = false, width = 42 }) {
  const t = safeISO(date)
  if (!t) return null
  return (
    <div style={{
      width, textAlign: 'center', borderRadius: 9, padding: '5px 0 6px',
      background: hot ? '#FBEAEA' : T.chip, flexShrink: 0,
    }}>
      <div style={{
        fontSize: 8.5, fontWeight: 700, letterSpacing: 1,
        color: hot ? T.red : T.muted,
      }}>{format(t, 'MMM').toUpperCase()}</div>
      <div style={{
        fontSize: 16, fontWeight: 800, lineHeight: 1.05,
        color: hot ? T.red : T.ink,
      }}>{format(t, 'd')}</div>
    </div>
  )
}

// Navy tile used in the header's next-race block.
export function NavyDateTile({ date }) {
  const t = safeISO(date)
  if (!t) return null
  return (
    <div style={{
      width: 42, textAlign: 'center', background: T.navy, color: '#fff',
      borderRadius: 9, padding: '5px 0 6px', flexShrink: 0,
    }}>
      <div style={{ fontSize: 8.5, fontWeight: 700, letterSpacing: 1, color: '#8A93A6' }}>
        {format(t, 'MMM').toUpperCase()}
      </div>
      <div style={{ fontSize: 16, fontWeight: 800, lineHeight: 1.05 }}>{format(t, 'd')}</div>
    </div>
  )
}

export function EmptyState({ title, body, action }) {
  return (
    <div style={{ padding: '14px 0 4px' }}>
      <div style={{ fontSize: 12.5, fontWeight: 600, color: T.ink2, marginBottom: 4 }}>{title}</div>
      {body && <div style={{ fontSize: 11.5, color: T.faint, lineHeight: 1.55 }}>{body}</div>}
      {action && <div style={{ marginTop: 10 }}>{action}</div>}
    </div>
  )
}

export function TextLink({ to, onClick, children, style }) {
  return (
    <button
      type="button"
      className="bb-link"
      onClick={onClick}
      style={{
        background: 'none', border: 0, padding: 0, cursor: 'pointer',
        fontSize: 11.5, fontFamily: 'inherit', ...style,
      }}
    >{children}</button>
  )
}

export function CtaButton({ children, onClick, style }) {
  return (
    <button
      type="button"
      className="bb-cta"
      onClick={onClick}
      onMouseEnter={e => { e.currentTarget.style.background = T.redDark }}
      onMouseLeave={e => { e.currentTarget.style.background = T.red }}
      style={{
        background: T.red, color: '#fff', border: 0, borderRadius: 99,
        padding: '8px 16px', fontSize: 12, fontWeight: 600,
        fontFamily: 'inherit', cursor: 'pointer', ...style,
      }}
    >{children}</button>
  )
}

// ── Header ────────────────────────────────────────────────────────────────────

export function DashboardHeader({ user, subLine, nextRace }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 22, flexWrap: 'wrap' }}>
      <div style={{ flex: 1, minWidth: 220 }}>
        <div style={{ fontSize: 24, fontWeight: 700, letterSpacing: '-.4px' }}>
          Hi {firstNameOf(user)}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 5, flexWrap: 'wrap' }}>
          {subLine}
        </div>
      </div>
      {nextRace}
    </div>
  )
}

// Right-hand "next race" block. `contextLine` is supplied by the caller so each
// dashboard can say something true about its own data.
export function NextRaceBlock({ election, contextLine }) {
  if (!election) {
    return (
      <div style={{ textAlign: 'right' }}>
        <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: 1, color: T.faint }}>
          YOUR NEXT RACE
        </div>
        <div style={{ fontSize: 12.5, fontWeight: 600, marginTop: 3 }}>No election linked</div>
        <div style={{ fontSize: 11, color: T.muted, marginTop: 2 }}>
          Link a candidate to an election to see the countdown
        </div>
      </div>
    )
  }
  // Same count the Elections/Game Plan calendars publish; today and tomorrow
  // are named from the calendar day so neither can read as "0 days".
  const away = countdownLabel(election.election_date)
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <div style={{ textAlign: 'right' }}>
        <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: 1, color: T.faint }}>
          YOUR NEXT RACE
        </div>
        <div style={{ fontSize: 12.5, fontWeight: 600, marginTop: 3 }}>
          {election.name}{away ? ` — ${away}` : ''}
        </div>
        {contextLine && (
          <div style={{ fontSize: 11, color: T.muted, marginTop: 2 }}>{contextLine}</div>
        )}
      </div>
      <NavyDateTile date={election.election_date} />
    </div>
  )
}

// ── Stat strip ────────────────────────────────────────────────────────────────

export function StatStrip({ children }) {
  const cells = React.Children.toArray(children)
  return (
    <>
      {/* Responsive collapse — same inline <style> trick the dashboards already
          use for .bb-main. Below 760px an N-across strip crushed 26px numerals
          into ~60px columns and wrapped every label onto three lines; it now
          reflows to a 2-up grid. Cell borders moved out of the inline style so
          the media query can re-draw them (which cell is "last in a row"
          changes with the column count) without needing !important. */}
      <style>{`
        .bb-statstrip > .bb-statcell { border-right: 1px solid ${T.divider} }
        .bb-statstrip > .bb-statcell:last-child { border-right: none }
        @media (max-width: 760px) {
          .bb-statstrip { grid-template-columns: repeat(2, minmax(0, 1fr)) !important }
          .bb-statstrip > .bb-statcell { border-right: 1px solid ${T.divider} }
          .bb-statstrip > .bb-statcell:nth-child(2n) { border-right: none }
          .bb-statstrip > .bb-statcell:nth-child(n + 3) { border-top: 1px solid ${T.divider} }
        }
      `}</style>
      <div className="bb-statstrip" style={{
        ...cardStyle,
        display: 'grid',
        gridTemplateColumns: `repeat(${cells.length}, minmax(0, 1fr))`,
        marginBottom: 18,
      }}>
        {cells.map((cell, i) => (
          <div key={i} className="bb-statcell" style={{
            padding: '18px 22px',
            minWidth: 0,
          }}>{cell}</div>
        ))}
      </div>
    </>
  )
}

export function StatCell({ label, value, of, sub, chip, valueSize = 26, truncate = false }) {
  return (
    <>
      <div style={{ fontSize: 12.5, fontWeight: 600, color: T.ink2 }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, marginTop: 8, minWidth: 0 }}>
        <span
          title={truncate && typeof value === 'string' ? value : undefined}
          style={{
            fontSize: valueSize, fontWeight: 800, lineHeight: 1, minWidth: 0,
            ...(truncate ? {
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'block',
            } : {}),
          }}
        >{value}</span>
        {of != null && (
          <span style={{ fontSize: 15, fontWeight: 600, color: T.faint, whiteSpace: 'nowrap' }}>
            of {of}
          </span>
        )}
        {chip}
      </div>
      {sub && <div style={{ fontSize: 11, color: T.faint, marginTop: 6 }}>{sub}</div>}
    </>
  )
}

// ── Weekly digest ─────────────────────────────────────────────────────────────

export function DigestItems({ items }) {
  if (!items?.length) return null
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
      {items.map((it, i) => {
        const cat = digestCategory(it.category)
        return (
          <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <span style={{
              width: 86, flexShrink: 0, textAlign: 'center', fontSize: 9.5, fontWeight: 700,
              letterSpacing: '.4px', borderRadius: 99, padding: '3px 0',
              color: cat.c, background: cat.bg, marginTop: 1,
            }}>{cat.label.toUpperCase()}</span>
            <div style={{ fontSize: 12.5, lineHeight: 1.5, color: T.ink2, minWidth: 0 }}>
              <strong style={{ color: T.ink }}>{it.title}</strong>
              {it.note ? ` — ${it.note}` : ''}
            </div>
          </div>
        )
      })}
    </div>
  )
}

export function LivePulseDot({ size = 6, color = T.red }) {
  return (
    <span style={{
      width: size, height: size, borderRadius: '50%', background: color,
      display: 'inline-block', flexShrink: 0, animation: 'bbLivePulse 2s infinite',
    }} />
  )
}

// ── Milestones ────────────────────────────────────────────────────────────────

export function MilestoneRow({ milestone, onToggle, busy }) {
  const st    = autoStatus(milestone)
  const done  = st === 'complete' || st === 'skipped'
  const phase = PHASE_MAP[milestone.phase]
  return (
    <div className="bb-row" style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: 10, margin: '0 -10px', borderRadius: 10,
      opacity: done ? 0.45 : 1,
    }}>
      <button
        type="button"
        onClick={() => onToggle?.(milestone)}
        disabled={busy || !onToggle}
        aria-label={done ? `Mark ${milestone.title} incomplete` : `Mark ${milestone.title} complete`}
        style={{
          width: 16, height: 16, borderRadius: '50%', flexShrink: 0, padding: 0,
          border: `1.5px solid ${done ? T.ink : '#D6D6D2'}`,
          background: done ? T.ink : 'transparent',
          color: '#fff', fontSize: 9, lineHeight: 1,
          cursor: onToggle ? 'pointer' : 'default',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
      >{done ? '✓' : ''}</button>
      <PhaseDot phase={milestone.phase} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 13, fontWeight: 600, textDecoration: done ? 'line-through' : 'none',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{milestone.title}</div>
        <div style={{ fontSize: 11, color: T.faint, marginTop: 1 }}>
          {phase?.label || 'Unassigned'}
        </div>
      </div>
      <DueChip milestone={milestone} />
    </div>
  )
}

// ── Election calendar ─────────────────────────────────────────────────────────

export function ElectionRows({ elections, hotId }) {
  if (!elections?.length) {
    return (
      <EmptyState
        title="No upcoming elections"
        body="Add an election on the Elections page to start the countdown."
      />
    )
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {elections.map(e => {
        const away = countdownLabel(e.election_date, new Date(), { short: true })
        const hot = hotId ? e.id === hotId : false
        const ty  = electionTypeHex(e.type)
        return (
          <div key={e.id} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <DateTile date={e.election_date} hot={hot} width={40} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{
                fontSize: 12.5, fontWeight: 600,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>{e.name}</div>
              <div style={{ marginTop: 3 }}>
                <Pill c={ty.c} bg={ty.bg} style={{ fontSize: 9.5, fontWeight: 600 }}>
                  {electionTypeShort(e.type)}
                </Pill>
              </div>
            </div>
            <div style={{ fontSize: 10.5, color: T.faint, whiteSpace: 'nowrap' }}>
              {away}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── Registered voters inside a district ──────────────────────────────────────
//
// Both dashboards used to pull `voters` with `.limit(5000)` and count matches in
// the browser. Two problems: any account past 5,000 geocoded rows silently got a
// too-low "Registered voters" number, and 5,000 rows crossed the wire even when
// the district contained a dozen of them.
//
// The row filter now runs on the server (bounding box of the district geometry)
// and the read pages to completion, so the number is exact at any list size.
// Point-in-polygon still runs client-side: there is no PostGIS geometry column
// on `voters` and migrations are frozen, so a single COUNT(*) cannot express
// "inside this district" — the bbox is the closest server-side narrowing there
// is, and it is a superset, so the final count stays exact.

export function geometryBBox(geometry) {
  if (!geometry) return null
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity
  const visit = (coords) => {
    if (typeof coords[0] === 'number') {
      const [lng, lat] = coords
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        if (lat < minLat) minLat = lat
        if (lat > maxLat) maxLat = lat
        if (lng < minLng) minLng = lng
        if (lng > maxLng) maxLng = lng
      }
      return
    }
    for (const c of coords) visit(c)
  }
  const geom = geometry.type === 'Feature' ? geometry.geometry : geometry
  if (!geom?.coordinates) return null
  visit(geom.coordinates)
  if (!Number.isFinite(minLat) || !Number.isFinite(minLng)) return null
  return { minLat, maxLat, minLng, maxLng }
}

export async function countVotersInDistrict(boundary) {
  const box = geometryBBox(boundary)
  if (!box) return 0
  const PAGE = 1000
  let offset = 0
  let hits   = 0
  // RLS scopes `voters` to the current user (policy: auth.uid() = created_by).
  while (true) {
    const { data, error } = await supabase
      .from('voters')
      .select('latitude, longitude')
      .not('latitude', 'is', null)
      .gte('latitude',  box.minLat).lte('latitude',  box.maxLat)
      .gte('longitude', box.minLng).lte('longitude', box.maxLng)
      .range(offset, offset + PAGE - 1)
    if (error) return hits
    if (!data?.length) break
    for (const v of data) {
      if (v.longitude != null && pointInGeometry(v.longitude, v.latitude, boundary)) hits++
    }
    if (data.length < PAGE) break
    offset += PAGE
  }
  return hits
}

// ── District map ──────────────────────────────────────────────────────────────

// Same geodata files the Offices page uses, cached at module scope so the
// dashboard doesn't refetch on every mount.
let _popCache = null, _presCache = null, _demoCache = null
const _boundaryCache = {}

export async function loadPopPoints() {
  if (!_popCache) _popCache = await fetch('/geodata/wi-cousub-pop.json').then(r => r.json())
  return _popCache
}
export async function loadCountyPres() {
  if (!_presCache) _presCache = await fetch('/geodata/wi-county-pres.json').then(r => r.json())
  return _presCache
}
export async function loadDemographics() {
  if (!_demoCache) _demoCache = await fetch('/geodata/wi-district-demographics.json').then(r => r.json())
  return _demoCache
}

// Maps an `offices` row onto the district layer the Offices page renders.
// GeoJSON NAME values are documented in Offices.jsx:
//   "Congressional District 3", "State Senate District 12", "Assembly District 45",
//   "Adams County".
export function resolveDistrict(office) {
  if (!office) return null
  const num = office.district_number != null
    ? parseInt(String(office.district_number).match(/\d+/)?.[0] ?? '', 10)
    : NaN
  const name = (office.name || '').toLowerCase()

  if (office.level === 'federal') {
    if (Number.isFinite(num)) {
      return {
        layerKey: 'congress', num,
        url: '/geodata/wi-congressional-simplified.geojson',
        feature: `Congressional District ${num}`,
        label: `Congressional District ${num}`,
        demoKey: `congress-${num}`,
      }
    }
    return {
      layerKey: 'ussenate', num: null,
      url: '/geodata/wi-statewide.geojson',
      feature: null,
      label: 'Wisconsin — statewide',
      demoKey: 'state-wi',
    }
  }

  if (office.level === 'state' && Number.isFinite(num)) {
    if (name.includes('senate')) {
      return {
        layerKey: 'senate', num,
        url: '/geodata/wi-state-senate-simplified.geojson',
        feature: `State Senate District ${num}`,
        label: `State Senate District ${num}`,
        demoKey: `senate-${num}`,
      }
    }
    return {
      layerKey: 'assembly', num,
      url: '/geodata/wi-state-assembly-simplified.geojson',
      feature: `Assembly District ${num}`,
      label: `Assembly District ${num}`,
      demoKey: `assembly-${num}`,
    }
  }

  if (office.level === 'county' && office.county) {
    const county = office.county.replace(/ county$/i, '').trim()
    return {
      layerKey: 'county', num: null,
      url: '/geodata/wi-counties-simplified.geojson',
      feature: `${county} County`,
      label: `${county} County`,
      demoKey: null,
    }
  }

  // Municipal offices have no matching statewide demographic key and the
  // municipal layer is too fine-grained for the rail card — no map.
  return null
}

export async function loadBoundary(district) {
  if (!district) return null
  const cacheKey = `${district.url}::${district.feature || '*'}`
  if (_boundaryCache[cacheKey] !== undefined) return _boundaryCache[cacheKey]
  try {
    const gj = await fetch(district.url).then(r => r.json())
    const feats = gj?.features || []
    const match = district.feature
      ? feats.find(f => (f.properties?.NAME || f.properties?.name) === district.feature)
      : feats[0]
    const geom = match?.geometry ?? null
    _boundaryCache[cacheKey] = geom
    return geom
  } catch (_) {
    _boundaryCache[cacheKey] = null
    return null
  }
}

// Same heat scale as DistrictDashboard.jsx.
export const heatColor = (g) =>
  g > 0.75 ? '#DC2626' : g > 0.55 ? '#F97316' : g > 0.35 ? '#EAB308' : '#22C55E'

export function DistrictHeatMap({ geometry, popPoints, height = 168 }) {
  const ref    = useRef(null)
  const mapRef = useRef(null)

  useEffect(() => {
    if (!ref.current || mapRef.current || !geometry) return
    let map
    try {
      map = L.map(ref.current, {
        scrollWheelZoom: false, zoomControl: false,
        attributionControl: false, dragging: false, doubleClickZoom: false,
        touchZoom: false, keyboard: false, boxZoom: false,
      })
    } catch (_) { return }
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18 }).addTo(map)

    const boundary = L.geoJSON({ type: 'Feature', geometry }, {
      style: { color: '#8B0000', weight: 2, fillColor: '#8B0000', fillOpacity: 0.05 },
    }).addTo(map)
    try { map.fitBounds(boundary.getBounds(), { padding: [10, 10] }) } catch (_) {}

    const inside = (popPoints || []).filter(p => pointInGeometry(p.lng, p.lat, geometry))
    const maxPop = Math.max(1, ...inside.map(p => p.pop || 0))
    inside.forEach(p => {
      if (!p.pop) return
      const g = Math.pow(p.pop / maxPop, 0.35)
      const radius = 700 + Math.sqrt(p.pop) * 55
      L.circle([p.lat, p.lng], { radius: radius * 1.8, color: 'transparent', fillColor: heatColor(g), fillOpacity: 0.10 }).addTo(map)
      L.circle([p.lat, p.lng], { radius, color: 'transparent', fillColor: heatColor(g), fillOpacity: 0.32 })
        .addTo(map)
        .bindTooltip(`${p.n} — ${Number(p.pop).toLocaleString()} residents`, { direction: 'top' })
    })

    mapRef.current = map
    const ro = new ResizeObserver(() => { try { map.invalidateSize() } catch (_) {} })
    ro.observe(ref.current)
    return () => {
      ro.disconnect()
      try { map.remove() } catch (_) {}
      mapRef.current = null
    }
  }, [geometry, popPoints])

  return (
    <div
      ref={ref}
      style={{ height, borderRadius: 12, overflow: 'hidden', background: '#F4F3EF' }}
    />
  )
}

export function HeatLegend() {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6,
      fontSize: 10, color: T.faint, marginTop: 8,
    }}>
      <span>Less</span>
      {['#22C55E', '#EAB308', '#F97316', '#DC2626'].map(c => (
        <span key={c} style={{
          width: 9, height: 9, borderRadius: '50%', background: c, opacity: 0.55,
          display: 'inline-block',
        }} />
      ))}
      <span>More residents</span>
    </div>
  )
}

export function StatRow({ label, value }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
      fontSize: 11.5, padding: '3px 0',
    }}>
      <span style={{ color: T.muted }}>{label}</span>
      <span style={{ fontWeight: 600 }}>{value}</span>
    </div>
  )
}

// ── Avatars ───────────────────────────────────────────────────────────────────

export function PartyAvatar({ name, party, size = 34 }) {
  const p = partyHex(party)
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%', flexShrink: 0,
      background: p.bg, color: p.c,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: size * 0.37, fontWeight: 700, letterSpacing: '.2px',
    }}>{initialsOf(name)}</div>
  )
}

export { partyHex, partyInitial, candidateStatusLabel }
