// src/pages/profiler/ReportReader.jsx — the report reader (SPEC-profiler §3).
//
// One quiet document. Used by BOTH the Profiler page and the public shared
// link, so it has no auth dependency: everything that needs a session (the
// research-note action, share links, regenerate) is passed in as a node.
//
// What changed from the old viewer, in one place:
//   · 15 per-section colour themes → one neutral page
//   · a confidence badge on nearly every paragraph → a label ONLY on claims
//     the report itself tagged unverified or low-confidence
//   · undifferentiated prose → typed blocks from reportModel.js
//   · a flat pill rail → 14 sections grouped into four, with working scroll-spy

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { filterSections } from '../../lib/profileContent'
import {
  parseSections, buildReport, filterToUnverified, sourcingStats, riskStats,
  sourceStats, inlineHtml, plainText, GROUP_ORDER, SEV_COLOR,
} from './reportModel'
import { T, cardStyle, Rich, StatStrip, StatCell, RatioBar, plural } from './shared'

// ─── Model hook ──────────────────────────────────────────────────────────────

export function useReport(content, showEmpty = false) {
  return useMemo(() => {
    const parsed = parseSections(content || '')
    const { sections, hiddenCount } = filterSections(parsed, showEmpty)
    const report = buildReport(content || '', sections)
    return {
      report,
      hiddenCount,
      sourcing: sourcingStats(content || ''),
      risk:     riskStats(content || ''),
      sources:  sourceStats(content || ''),
    }
  }, [content, showEmpty])
}

// ─── Scroll-spy (ported from the old Dossiers.jsx, generalized) ─────────────
// The old viewer owned its own 80vh scroll box. The redesign gives the document
// the full canvas, so the scroller is whichever ancestor actually scrolls —
// Layout's <main> in the app, the window on the public share page.

function scrollParentOf(node) {
  let p = node?.parentElement
  while (p && p !== document.body) {
    const s = window.getComputedStyle(p)
    if (/(auto|scroll|overlay)/.test(s.overflowY) && p.scrollHeight > p.clientHeight + 4) return p
    p = p.parentElement
  }
  return null
}

function useScrollSpy(ids, docRef, enabled) {
  const [active, setActive] = useState(ids[0] || '')
  const key = ids.join('|')

  useEffect(() => {
    if (!enabled || !ids.length) return
    // Viewport-relative spy, attached to window in the CAPTURE phase so it
    // hears scrolls from ANY ancestor scroller (Layout's <main> in-app, the
    // window on the share page) without having to know which one it is —
    // resolving the scroller once at mount raced content load and captured
    // null, which left the rail highlighting but never scrolling.
    const onScroll = () => {
      let current = ids[0]
      for (const id of ids) {
        const el = document.getElementById(`pf-${id}`)
        if (el && el.getBoundingClientRect().top <= 180) current = id
      }
      setActive(prev => (prev === current ? prev : current))
    }
    window.addEventListener('scroll', onScroll, { capture: true, passive: true })
    onScroll()
    return () => window.removeEventListener('scroll', onScroll, { capture: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled])

  const scrollToSection = useCallback((id) => {
    const el = document.getElementById(`pf-${id}`)
    if (!el) return
    setActive(id)
    // Resolve the real scroll ancestor AT CLICK TIME, from the section itself.
    const scroller = scrollParentOf(el)
    if (scroller) {
      const delta = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top
      scroller.scrollTo({ top: scroller.scrollTop + delta - 20, behavior: 'smooth' })
    } else {
      window.scrollTo({ top: window.scrollY + el.getBoundingClientRect().top - 20, behavior: 'smooth' })
    }
  }, [])

  return { active, scrollToSection }
}

// ─── Blocks ──────────────────────────────────────────────────────────────────

const MEASURE = 78   // ch — the paragraph measure cap from the spec

function VerifyLink({ text, subject }) {
  const q = `${subject ? subject + ' ' : ''}${plainText(text).slice(0, 90)}`.trim()
  return (
    <a
      href={`https://www.google.com/search?q=${encodeURIComponent(q)}`}
      target="_blank" rel="noopener noreferrer"
      style={{ fontSize: 11, color: T.faint, textDecoration: 'underline' }}
    >Verify</a>
  )
}

function Marker({ marker, text, subject }) {
  if (!marker) return null
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginTop: 6 }}>
      <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.9px', color: T.amber }}>{marker}</span>
      <VerifyLink text={text} subject={subject} />
    </div>
  )
}

function Block({ b, subject }) {
  switch (b.kind) {
    case 'head':
      return (
        <div style={{
          fontSize: 12.5, fontWeight: 700, letterSpacing: '.4px', color: T.ink,
          margin: '18px 0 8px',
        }}>{b.text}</div>
      )

    case 'paragraph':
      return (
        <div style={{ marginBottom: 14, maxWidth: `${MEASURE}ch` }}>
          <Rich as="div" html={inlineHtml(b.text)}
            style={{ fontSize: 14.5, lineHeight: 1.68, color: T.ink3 }} />
          <Marker marker={b.marker} text={b.text} subject={subject} />
        </div>
      )

    case 'bullets':
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, margin: '2px 0 16px', maxWidth: `${MEASURE}ch` }}>
          {b.items.map((it, i) => (
            <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
              <span style={{ flex: 'none', width: 4, height: 4, borderRadius: '50%', background: '#C9C9C2', marginTop: 8 }} />
              <div style={{ minWidth: 0 }}>
                <Rich as="div" html={inlineHtml(it.text)}
                  style={{ fontSize: 14, lineHeight: 1.62, color: T.ink3 }} />
                <Marker marker={it.marker} text={it.text} subject={subject} />
              </div>
            </div>
          ))}
        </div>
      )

    case 'list':
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, margin: '2px 0 16px', maxWidth: `${MEASURE}ch` }}>
          {b.items.map((it, i) => (
            <div key={i} style={{ display: 'flex', gap: 12, alignItems: 'baseline' }}>
              <span style={{
                flex: 'none', width: 92, fontSize: 11.5, fontWeight: 700, color: T.ink4,
                fontVariantNumeric: 'tabular-nums', lineHeight: 1.55,
              }}>{it.k}</span>
              <div style={{ minWidth: 0, flex: 1 }}>
                {it.href
                  ? <a href={it.href} target="_blank" rel="noopener noreferrer"
                      style={{ fontSize: 14, lineHeight: 1.6, color: T.ink, textDecoration: 'underline', textUnderlineOffset: 2 }}>
                      {plainText(it.v)}
                    </a>
                  : <Rich as="div" html={inlineHtml(it.v || it.raw || '')}
                      style={{ fontSize: 14, lineHeight: 1.6, color: T.ink3 }} />}
                {it.sub && (
                  <div style={{ fontSize: 11.5, color: T.muted, lineHeight: 1.5, marginTop: 2 }}>{it.sub}</div>
                )}
                {it.children?.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: 5 }}>
                    {it.children.map((c, ci) => (
                      <Rich key={ci} as="div" html={inlineHtml(c)}
                        style={{ fontSize: 13.5, lineHeight: 1.55, color: T.ink3 }} />
                    ))}
                  </div>
                )}
                <Marker marker={it.marker} text={it.v || it.raw || ''} subject={subject} />
              </div>
            </div>
          ))}
        </div>
      )

    case 'kv':
      return (
        <div className="pf-kv" style={{
          display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0,1fr))', gap: 1,
          background: T.line, border: `1px solid ${T.line}`, borderRadius: 10,
          overflow: 'hidden', margin: '2px 0 16px', maxWidth: `${MEASURE}ch`,
        }}>
          {b.rows.map((r, i) => (
            <div key={i} style={{ background: '#fff', padding: '10px 14px', minWidth: 0 }}>
              <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.3px', color: T.muted }}>{r.k}</div>
              <Rich as="div" html={inlineHtml(r.v)}
                style={{ fontSize: 13, fontWeight: 600, marginTop: 2, color: T.ink, lineHeight: 1.5 }} />
              {r.src && <div style={{ fontSize: 11, color: T.muted, marginTop: 3 }}>{r.src}</div>}
            </div>
          ))}
        </div>
      )

    case 'risk':
      return (
        <div style={{
          borderLeft: `2px solid ${SEV_COLOR[b.sev] || T.faint}`, paddingLeft: 16,
          marginBottom: 16, maxWidth: `${MEASURE}ch`,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 5, flexWrap: 'wrap' }}>
            <span style={{
              fontSize: 11, fontWeight: 700, letterSpacing: '.9px',
              color: SEV_COLOR[b.sev] || T.faint,
            }}>{b.sev}</span>
            <span style={{ fontSize: 13.5, fontWeight: 700 }}>{b.title}</span>
          </div>
          {b.text && (
            <Rich as="div" html={inlineHtml(b.text)}
              style={{ fontSize: 14.5, lineHeight: 1.68, color: T.ink3 }} />
          )}
          {b.source && <div style={{ fontSize: 11, color: T.muted, marginTop: 7 }}>{b.source}</div>}
          <Marker marker={b.marker} text={b.text || b.title} subject={subject} />
        </div>
      )

    case 'pair':
      return (
        <div style={{ display: 'flex', flexDirection: 'column', margin: '2px 0 14px', maxWidth: `${MEASURE}ch` }}>
          {b.pairs.map((p, i) => (
            <div key={i} style={{ padding: '13px 0', borderTop: `1px solid #F5F4F1` }}>
              <div style={{ display: 'flex', gap: 11, marginBottom: p.defense ? 7 : 0 }}>
                <span style={{
                  flex: 'none', width: 66, paddingTop: 2, fontSize: 11, fontWeight: 700,
                  letterSpacing: '.9px', color: T.redHot,
                }}>ATTACK</span>
                <Rich as="span" html={inlineHtml(p.attack)}
                  style={{ fontSize: 14.5, lineHeight: 1.6, color: T.ink4 }} />
              </div>
              {p.defense && (
                <div style={{ display: 'flex', gap: 11 }}>
                  <span style={{
                    flex: 'none', width: 66, paddingTop: 2, fontSize: 11, fontWeight: 700,
                    letterSpacing: '.9px', color: T.green,
                  }}>RESPOND</span>
                  <Rich as="span" html={inlineHtml(p.defense)}
                    style={{ fontSize: 14.5, lineHeight: 1.6, color: T.ink3 }} />
                </div>
              )}
            </div>
          ))}
        </div>
      )

    default:
      return null
  }
}

// ─── Contents rail ───────────────────────────────────────────────────────────

function ContentsRail({ sections, active, onGo, disclaimer }) {
  const groups = GROUP_ORDER
    .map(g => ({ group: g, items: sections.filter(s => s.group === g) }))
    .filter(g => g.items.length)

  return (
    <div className="pf-rail" style={{ position: 'sticky', top: 0, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <nav style={{ ...cardStyle, borderRadius: 14, padding: '14px 6px 14px 14px' }} aria-label="Report contents">
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '1.2px', color: T.faint, padding: '0 8px 9px' }}>
          CONTENTS
        </div>
        {groups.map(g => (
          <div key={g.group} style={{ marginBottom: 11 }}>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.8px', color: T.ink4, padding: '0 8px 5px' }}>
              {g.group}
            </div>
            {g.items.map(s => {
              const on = active === s.id
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => onGo(s.id)}
                  aria-current={on ? 'true' : undefined}
                  onMouseEnter={e => { if (!on) e.currentTarget.style.background = T.hover }}
                  onMouseLeave={e => { if (!on) e.currentTarget.style.background = 'transparent' }}
                  style={{
                    width: '100%', display: 'flex', alignItems: 'center', gap: 8,
                    padding: '7px 8px', borderRadius: 7, border: 0, cursor: 'pointer',
                    background: on ? '#F5F4F1' : 'transparent', fontFamily: 'inherit',
                    textAlign: 'left', minHeight: 32,
                  }}
                >
                  <span style={{
                    flex: 'none', width: 17, fontSize: 11.5, fontWeight: 700, color: T.faint,
                    textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                  }}>{s.num}</span>
                  <span style={{
                    fontSize: 12, fontWeight: on ? 600 : 500, color: on ? T.ink : T.ink4,
                    minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>{s.label}</span>
                  {s.unverified && (
                    <span title="Contains a claim that needs verification" style={{
                      flex: 'none', marginLeft: 'auto', marginRight: 4, width: 5, height: 5, borderRadius: '50%',
                      background: s.group === 'RISK' ? T.redHot : T.amberBar,
                    }} />
                  )}
                </button>
              )
            })}
          </div>
        ))}
      </nav>
      {disclaimer !== false && (
        <div style={{ ...cardStyle, borderRadius: 14, padding: '13px 15px' }}>
          <div style={{ fontSize: 11, color: T.muted, lineHeight: 1.55 }}>
            AI-generated research. Verify every claim through primary sources before public use.
          </div>
        </div>
      )}
    </div>
  )
}

// ─── View controls ───────────────────────────────────────────────────────────

function ViewControls({ mode, setMode, vOnly, setVOnly, hint }) {
  const MODES = [{ id: 'full', label: 'Full report' }, { id: 'brief', label: 'Takeaways only' }]
  return (
    <div className="pf-controls" style={{
      display: 'flex', alignItems: 'center', gap: 9, marginBottom: 16, flexWrap: 'wrap',
    }}>
      <div role="group" aria-label="Report detail" style={{ display: 'flex', gap: 4, background: T.chip, borderRadius: 99, padding: 4 }}>
        {MODES.map(m => {
          const on = m.id === mode
          return (
            <button
              key={m.id}
              type="button"
              aria-pressed={on}
              onClick={() => setMode(m.id)}
              style={{
                borderRadius: 99, padding: '8px 16px', fontSize: 12.5, border: 0,
                fontWeight: on ? 600 : 500, color: on ? T.ink : T.ink4,
                background: on ? '#fff' : 'transparent', fontFamily: 'inherit',
                boxShadow: on ? '0 1px 2px rgba(0,0,0,.06)' : 'none', cursor: 'pointer', minHeight: 34,
              }}
            >{m.label}</button>
          )
        })}
      </div>
      <button
        type="button"
        aria-pressed={vOnly}
        onClick={() => setVOnly(v => !v)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontFamily: 'inherit',
          background: vOnly ? T.warmBg : '#fff',
          border: `1px solid ${vOnly ? T.warmBr : T.border}`,
          borderRadius: 99, padding: '8px 14px', fontSize: 12, fontWeight: 600,
          color: vOnly ? T.amber : T.ink4, minHeight: 34,
        }}
      >
        <span style={{
          width: 26, height: 15, borderRadius: 99, position: 'relative', flex: 'none',
          background: vOnly ? T.amber : '#D6D6D2', transition: 'background .18s ease',
        }}>
          <span style={{
            position: 'absolute', top: 2, left: vOnly ? 13 : 2, width: 11, height: 11,
            borderRadius: '50%', background: '#fff', transition: 'left .18s ease',
          }} />
        </span>
        Needs verification only
      </button>
      <span style={{ marginLeft: 'auto', fontSize: 11.5, color: T.muted }}>{hint}</span>
    </div>
  )
}

// ─── Reader ──────────────────────────────────────────────────────────────────

export default function ReportReader({
  dossier,
  content,
  eyebrow = 'CANDIDATE INTELLIGENCE PROFILE',
  back = null,
  actions = null,
  notice = null,
  researchNote = null,
  beforeDoc = null,
  afterDoc = null,
  onExportPdf = null,
  exportLabel = 'Export PDF',
  showEmpty = false,
  onToggleEmpty = null,
  annotations = null,
  onSaveAnnotation = null,
  showAnnotations = false,
  headerExtra = null,
}) {
  const [mode, setMode]   = useState('full')
  const [vOnly, setVOnly] = useState(false)
  const docRef = useRef(null)

  const { report, hiddenCount, sourcing, risk, sources } = useReport(content, showEmpty)
  const candidate = dossier?.candidate || {}
  const subject   = candidate.name || ''

  const visible = useMemo(() => {
    if (!vOnly) return report.sections
    return filterToUnverified(report.sections)
  }, [report, vOnly])

  const railIds = useMemo(() => visible.map(s => s.id), [visible])
  const { active, scrollToSection } = useScrollSpy(railIds, docRef, true)

  const office = candidate.office || candidate.offices || null
  const officeLabel = office
    ? [office.name, office.district_name || (office.district_number ? `District ${office.district_number}` : '')]
        .filter(Boolean).join(' — ')
    : ''
  const generated = dossier?.generated_at ? new Date(dossier.generated_at) : null
  const generatedLabel = generated && !Number.isNaN(+generated)
    ? generated.toLocaleString('en-US', {
        weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
        hour: 'numeric', minute: '2-digit',
      })
    : ''
  const ageDays = generated && !Number.isNaN(+generated)
    ? Math.floor((Date.now() - generated.getTime()) / 86400000) : null

  const hint = mode === 'brief'
    ? `One takeaway per section — ${plural(visible.filter(s => s.takeaway).length, 'line')}`
    : vOnly
      ? 'Showing only claims the report has not sourced to a primary record'
      : `${plural(report.sections.length, 'section')}, grouped`

  return (
    <>
      {back}

      <div className="pf-head" style={{ display: 'flex', alignItems: 'flex-start', gap: 16, marginBottom: 16 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '1.4px', color: T.faint }}>{eyebrow}</div>
          <h1 style={{
            fontSize: 26, fontWeight: 700, letterSpacing: '-.4px', margin: '5px 0 0', lineHeight: 1.2,
          }}>{candidate.name || dossier?.title || 'Profile'}</h1>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 14, marginTop: 6,
            fontSize: 12.5, color: T.ink4, flexWrap: 'wrap',
          }}>
            {officeLabel && <span style={{ fontWeight: 600 }}>{officeLabel}</span>}
            {candidate.party && <span>{candidate.party}</span>}
            {generatedLabel && <span>Generated {generatedLabel}</span>}
            <span>{plural(report.sections.length, 'section')}</span>
            {ageDays != null && ageDays >= 30 && (
              <span style={{ color: T.amber, fontWeight: 600 }}>
                {plural(ageDays, 'day')} old — consider refreshing
              </span>
            )}
          </div>
          {headerExtra}
        </div>
        {actions && (
          <div className="pf-headright" style={{ flex: 'none', display: 'flex', gap: 7, flexWrap: 'wrap' }}>
            {actions}
          </div>
        )}
      </div>

      {notice}

      {/* ── Sourcing strip: every number is counted, never estimated ───────── */}
      <StatStrip cols={4}>
        <StatCell
          label="Sourcing"
          value={sourcing.ratio == null ? '—' : sourcing.strong}
          of={sourcing.ratio == null ? null : `of ${plural(sourcing.total, 'claim')}`}
          bar={sourcing.ratio == null ? null : <RatioBar good={sourcing.strong} weak={sourcing.weak} />}
          sub={sourcing.ratio == null
            ? (sourcing.total ? `${plural(sourcing.total, 'tagged claim')} — too few to state a ratio` : 'This profile carries no confidence tags')
            : `${Math.round(sourcing.ratio * 100)}% sourced to a primary record`}
        />
        <StatCell
          label="Needs verification"
          value={sourcing.weak}
          sub={sourcing.weak
            ? `${sourcing.material} material · ${sourcing.minor} minor`
            : 'Nothing tagged for follow-up'}
        />
        <StatCell
          label="Risk items"
          value={risk.total}
          valueColor={risk.total ? T.red : T.ink}
          sub={risk.total
            ? [risk.HIGH ? `${risk.HIGH} high` : '', risk.MEDIUM ? `${risk.MEDIUM} medium` : '', risk.LOW ? `${risk.LOW} low` : '']
                .filter(Boolean).join(' · ')
            : 'No tagged findings in sections 6 and 13'}
        />
        <StatCell
          label="Sources linked"
          value={sources.total || '—'}
          sub={sources.total
            ? [sources.press ? `${sources.press} press` : '', sources.filings ? `${sources.filings} filings` : '',
               sources.social ? `${sources.social} social` : ''].filter(Boolean).join(' · ')
            : 'No source links in this report'}
        />
      </StatStrip>

      {researchNote}
      {beforeDoc}

      <ViewControls mode={mode} setMode={setMode} vOnly={vOnly} setVOnly={setVOnly} hint={hint} />

      <div className="pf-doccols" style={{
        display: 'grid', gridTemplateColumns: '212px 1fr', gap: 22, alignItems: 'start',
      }}>
        <ContentsRail sections={visible} active={active} onGo={scrollToSection} />

        <div ref={docRef} style={{ ...cardStyle, overflow: 'hidden' }}>
          <div className="pf-doc" style={{ padding: '0 44px' }}>
            {report.summary && !vOnly && (
              <div style={{ padding: '30px 0 26px', borderBottom: `1px solid ${T.line}` }}>
                <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '1.2px', color: T.faint, marginBottom: 10 }}>
                  SUMMARY
                </div>
                <div style={{ fontSize: 16, lineHeight: 1.65, color: T.ink2, maxWidth: `${MEASURE}ch` }}>
                  {report.summary}
                </div>
              </div>
            )}

            {visible.length === 0 && (
              <div style={{ padding: '40px 0' }}>
                <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 5 }}>
                  {vOnly ? 'Nothing in this profile is tagged for verification' : 'This profile has no readable sections'}
                </div>
                <div style={{ fontSize: 12.5, color: T.muted, lineHeight: 1.6, maxWidth: '62ch' }}>
                  {vOnly
                    ? 'Every claim the report tagged is sourced to a primary record, or the profile predates confidence tagging. Switch back to the full report to read it.'
                    : 'The stored report could not be split into sections. Regenerating it will rebuild the document.'}
                </div>
              </div>
            )}

            {visible.map(s => {
              const blocks = mode === 'brief' ? [] : s.blocks
              return (
                <section
                  key={s.id}
                  id={`pf-${s.id}`}
                  style={{ padding: '26px 0', borderBottom: `1px solid ${T.line}`, scrollMarginTop: 20 }}
                >
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 11, marginBottom: 14 }}>
                    <span style={{
                      flex: 'none', fontSize: 13, fontWeight: 700, color: T.faint,
                      fontVariantNumeric: 'tabular-nums',
                    }}>{s.num}</span>
                    <div style={{ minWidth: 0 }}>
                      <h2 style={{ fontSize: 16, fontWeight: 700, letterSpacing: '-.2px', margin: 0 }}>{s.label}</h2>
                      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.8px', color: T.faint, marginTop: 3 }}>
                        {s.group}
                      </div>
                    </div>
                    {s.meta && (
                      <span style={{ marginLeft: 'auto', flex: 'none', fontSize: 11, color: T.muted }}>{s.meta}</span>
                    )}
                  </div>

                  {s.takeaway && (
                    <div style={{
                      borderLeft: `2px solid ${T.ink}`, padding: '2px 0 2px 16px',
                      marginBottom: blocks.length ? 18 : 0, maxWidth: '74ch',
                    }}>
                      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '1.1px', color: T.faint, marginBottom: 5 }}>
                        TAKEAWAY
                      </div>
                      <div style={{ fontSize: 13.5, fontWeight: 600, lineHeight: 1.55, color: T.ink }}>
                        {s.takeaway}
                      </div>
                    </div>
                  )}

                  {mode === 'brief' && !s.takeaway && (
                    <div style={{ fontSize: 12.5, color: T.muted }}>
                      No summary line could be extracted from this section.
                    </div>
                  )}

                  {blocks.map((b, i) => <Block key={i} b={b} subject={subject} />)}

                  {mode !== 'brief' && blocks.length === 0 && (
                    <div style={{ fontSize: 12.5, color: T.muted }}>
                      {vOnly
                        ? 'No claims in this section need verification.'
                        : s.isEmptySection
                          ? 'No findings in this section for this profile.'
                          : 'This section has no readable content.'}
                    </div>
                  )}

                  {showAnnotations && onSaveAnnotation && (
                    <SectionNote
                      sectionId={s.id}
                      existing={annotations?.[s.id]}
                      onSave={onSaveAnnotation}
                    />
                  )}
                </section>
              )
            })}

            {afterDoc}

            <div style={{ padding: '24px 0 34px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ fontSize: 11.5, color: T.muted, lineHeight: 1.55, maxWidth: '60ch' }}>
                Badger Board · AI-generated political intelligence · The Bluejack Group.
                Verify all information through official sources before use.
                {' '}<a href="/dossier-disclaimer" target="_blank" rel="noopener noreferrer"
                  style={{ color: T.faint, textDecoration: 'underline' }}>Full disclaimer</a>
              </div>
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                {hiddenCount > 0 && onToggleEmpty && (
                  <button
                    type="button"
                    onClick={onToggleEmpty}
                    style={{
                      background: 'none', border: 0, padding: 0, cursor: 'pointer', fontFamily: 'inherit',
                      fontSize: 11.5, color: T.faint, textDecoration: 'underline',
                    }}
                  >
                    {showEmpty
                      ? 'Hide sections with no findings'
                      : `${plural(hiddenCount, 'section')} with no findings hidden`}
                  </button>
                )}
                {onExportPdf && (
                  <button
                    type="button"
                    onClick={onExportPdf}
                    className="pf-btn"
                    onMouseEnter={e => { e.currentTarget.style.background = T.hover }}
                    onMouseLeave={e => { e.currentTarget.style.background = '#fff' }}
                    style={{
                      background: '#fff', border: `1px solid ${T.border}`, borderRadius: 99,
                      padding: '10px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer',
                      fontFamily: 'inherit', color: T.ink, minHeight: 40,
                    }}
                  >{exportLabel}</button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

// ─── Per-section research note (existing localStorage annotations) ───────────

function SectionNote({ sectionId, existing, onSave }) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState(existing?.text || '')

  return (
    <div style={{ marginTop: 14 }}>
      {existing && !open && (
        <div style={{
          background: T.warmBg, border: `1px solid ${T.warmBr}`, borderRadius: 10,
          padding: '10px 13px', marginBottom: 6,
        }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.8px', color: T.amber, marginBottom: 4 }}>
            YOUR NOTE
          </div>
          <div style={{ fontSize: 12.5, color: T.ink3, lineHeight: 1.55 }}>{existing.text}</div>
        </div>
      )}
      {!open ? (
        <button
          type="button"
          onClick={() => { setOpen(true); setText(existing?.text || '') }}
          style={{
            background: 'none', border: 0, padding: 0, cursor: 'pointer', fontFamily: 'inherit',
            fontSize: 11.5, color: T.faint, textDecoration: 'underline',
          }}
        >{existing ? 'Edit note' : 'Add a note'}</button>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: '62ch' }}>
          <textarea
            autoFocus
            rows={3}
            value={text}
            onChange={e => setText(e.target.value)}
            placeholder="Research note for this section"
            className="pf-input"
            style={{
              width: '100%', boxSizing: 'border-box', border: `1px solid ${T.field}`,
              borderRadius: 10, padding: '10px 12px', fontSize: 12.5, fontFamily: 'inherit',
              resize: 'vertical', color: T.ink,
            }}
          />
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <button type="button" onClick={() => { onSave(sectionId, text); setOpen(false) }}
              style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer', fontFamily: 'inherit', fontSize: 12, fontWeight: 600, color: T.red }}>
              Save note
            </button>
            <button type="button" onClick={() => setOpen(false)}
              style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer', fontFamily: 'inherit', fontSize: 12, color: T.muted }}>
              Cancel
            </button>
            {existing && (
              <button type="button" onClick={() => { onSave(sectionId, ''); setText(''); setOpen(false) }}
                style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer', fontFamily: 'inherit', fontSize: 12, color: T.redHot, marginLeft: 'auto' }}>
                Delete
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
