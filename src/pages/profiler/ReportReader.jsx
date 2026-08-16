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
//
// Two owner-requested additions live here too:
//   · "View source →" on any block whose own markdown carries a URL
//   · the Verify link opens the lookup AND asks the team for a verdict; a claim
//     ruled valid stops asking to be verified, one ruled false stays on the page
//     marked. Verdicts persist on dossiers.claim_verdicts via `onVerdict`; with
//     no `onVerdict` (the public share view) they render read-only.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { filterSections } from '../../lib/profileContent'
import {
  parseSections, buildReport, filterToUnverified, sourcingStats, riskStats,
  sourceStats, inlineHtml, plainText, claimState, verdictDate, urlHost,
  GROUP_ORDER, SEV_COLOR,
} from './reportModel'
import { officeLine } from '../../lib/office'
import { T, cardStyle, Rich, ProfilerStatStrip, StatCell, RatioBar, plural } from './shared'

// ─── Model hook ──────────────────────────────────────────────────────────────

export function useReport(content, showEmpty = false, verdicts = null) {
  return useMemo(() => {
    const parsed = parseSections(content || '')
    const { sections, hiddenCount } = filterSections(parsed, showEmpty)
    const report = buildReport(content || '', sections, verdicts)
    return {
      report,
      hiddenCount,
      sourcing: sourcingStats(content || ''),
      risk:     riskStats(content || ''),
      sources:  sourceStats(content || ''),
    }
  }, [content, showEmpty, verdicts])
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
    // Instant (behavior:'auto') on purpose: smooth programmatic scrolling
    // silently no-ops on this container in Chrome (verified live — both
    // scrollTo and scrollIntoView with behavior:'smooth' leave scrollTop
    // untouched while instant scrolling works). Working beats pretty.
    const scroller = scrollParentOf(el)
    if (scroller) {
      const delta = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top
      scroller.scrollTo({ top: scroller.scrollTop + delta - 20, behavior: 'auto' })
    } else {
      window.scrollTo({ top: window.scrollY + el.getBoundingClientRect().top - 20, behavior: 'auto' })
    }
  }, [])

  return { active, scrollToSection }
}

// ─── Blocks ──────────────────────────────────────────────────────────────────

const MEASURE = 78   // ch — the paragraph measure cap from the spec

const quietLink = { fontSize: 11, color: T.faint, textDecoration: 'underline', textUnderlineOffset: 2 }
const quietBtn  = {
  ...quietLink, background: 'none', border: 0, padding: 0, cursor: 'pointer',
  fontFamily: 'inherit', lineHeight: 1.45,
}

/** Opens the lookup in a new tab AND, in-app, asks for the team's verdict. */
function VerifyLink({ text, subject, onAsk }) {
  const q = `${subject ? subject + ' ' : ''}${plainText(text).slice(0, 90)}`.trim()
  return (
    <a
      href={`https://www.google.com/search?q=${encodeURIComponent(q)}`}
      target="_blank" rel="noopener noreferrer"
      onClick={onAsk || undefined}
      style={quietLink}
    >Verify</a>
  )
}

/**
 * "View source →" for the URLs a block's own markdown carries. Never invented:
 * `urls` comes from the document text, so a block without one shows nothing.
 */
function SourceLinks({ urls }) {
  const [open, setOpen] = useState(false)
  if (!urls || !urls.length) return null
  const rest = urls.slice(1)
  return (
    <>
      <a href={urls[0]} target="_blank" rel="noopener noreferrer" title={urls[0]} style={quietLink}>
        View source →
      </a>
      {rest.length > 0 && !open && (
        <button type="button" onClick={() => setOpen(true)} style={quietBtn}>
          +{rest.length} more
        </button>
      )}
      {open && rest.map((u, i) => (
        <a key={i} href={u} target="_blank" rel="noopener noreferrer" title={u} style={quietLink}>
          {urlHost(u) || 'View source'} →
        </a>
      ))}
    </>
  )
}

/**
 * The one row under a block: the report's own confidence label, what the team
 * decided about it, and the sources the block cites. A block with none of those
 * renders nothing at all.
 */
function Foot({ el, text, subject, onAsk }) {
  const st = claimState(el)
  const urls = el?.urls || []
  if (!st && !urls.length) return null
  const ask = onAsk && el?.key ? () => onAsk(el, text) : null
  const on = st?.at ? verdictDate(st.at) : ''

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginTop: 6, flexWrap: 'wrap' }}>
      {st?.kind === 'valid' && (
        <span style={{ fontSize: 11, fontWeight: 600, color: T.green }}>
          Verified by {onAsk ? 'your team' : 'the profile owner'}{on ? ` · ${on}` : ''}
        </span>
      )}
      {st && st.kind !== 'valid' && (
        <span style={{
          fontSize: 11, fontWeight: 700, letterSpacing: '.9px',
          color: st.kind === 'false' ? T.redHot : T.amber,
        }}>{st.label}</span>
      )}
      {st?.verify && <VerifyLink text={text} subject={subject} onAsk={ask} />}
      {st && !st.verify && ask && (
        <button type="button" onClick={ask} style={quietBtn}>Change</button>
      )}
      <SourceLinks urls={urls} />
    </div>
  )
}

/** Body colour for a claim: muted once the team has marked it false. */
const bodyColor = (el, base = T.ink3) => (claimState(el)?.muted ? T.faint : base)

function Block({ b, subject, onAsk }) {
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
            style={{ fontSize: 14.5, lineHeight: 1.68, color: bodyColor(b) }} />
          <Foot el={b} text={b.text} subject={subject} onAsk={onAsk} />
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
                  style={{ fontSize: 14, lineHeight: 1.62, color: bodyColor(it) }} />
                <Foot el={it} text={it.text} subject={subject} onAsk={onAsk} />
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
                      style={{ fontSize: 14, lineHeight: 1.6, color: bodyColor(it) }} />}
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
                <Foot el={it} text={it.v || it.raw || ''} subject={subject} onAsk={onAsk} />
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
                style={{ fontSize: 13, fontWeight: 600, marginTop: 2, color: bodyColor(r, T.ink), lineHeight: 1.5 }} />
              {r.src && <div style={{ fontSize: 11, color: T.muted, marginTop: 3 }}>{r.src}</div>}
              <Foot el={r} text={r.v} subject={subject} onAsk={onAsk} />
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
              style={{ fontSize: 14.5, lineHeight: 1.68, color: bodyColor(b) }} />
          )}
          {b.source && <div style={{ fontSize: 11, color: T.muted, marginTop: 7 }}>{b.source}</div>}
          <Foot el={b} text={b.text || b.title} subject={subject} onAsk={onAsk} />
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
                  style={{ fontSize: 14.5, lineHeight: 1.6, color: bodyColor(p, T.ink4) }} />
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
              <div style={{ paddingLeft: 77 }}>
                <Foot el={p} text={p.attack} subject={subject} onAsk={onAsk} />
              </div>
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

// ─── Verdict lightbox ────────────────────────────────────────────────────────
// Opens the moment the Verify link is clicked — the lookup is already loading in
// the other tab, so the question is waiting when the reader comes back. Escape
// or the backdrop closes it WITHOUT recording anything: no answer is not an
// answer, and a claim nobody ruled on stays flagged.

const VERDICT_BUTTONS = [
  { id: 'valid',  label: 'Valid',  bg: T.green,  fg: '#fff',  hint: 'The source confirms it' },
  { id: 'false',  label: 'False',  bg: T.redHot, fg: '#fff',  hint: 'The source contradicts it' },
  { id: 'unsure', label: 'Unsure', bg: T.chip,   fg: T.ink3,  hint: 'Still not settled' },
]

function VerdictLightbox({ claim, current, onPick, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const full = plainText(claim || '')
  const quote = full.length > 200
    ? `${full.slice(0, 200).replace(/\s+\S*$/, '')}…`
    : full

  return (
    <div
      role="dialog" aria-modal="true" aria-label="Record a verdict on this claim"
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(13,21,38,.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
        fontFamily: 'inherit', color: T.ink,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: '#fff', borderRadius: 18, boxShadow: '0 24px 60px rgba(13,21,38,.28)',
          width: '100%', maxWidth: 420, padding: '20px 22px 18px',
        }}
      >
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '1.2px', color: T.faint }}>
          VERIFY THIS CLAIM
        </div>
        <div style={{ fontSize: 16, fontWeight: 700, margin: '6px 0 12px', lineHeight: 1.35 }}>
          Did the source confirm this claim?
        </div>
        <div style={{
          borderLeft: `2px solid ${T.line}`, paddingLeft: 13, marginBottom: 16,
          fontSize: 13, lineHeight: 1.6, color: T.ink3,
        }}>{quote || 'This claim has no readable text.'}</div>

        <div style={{ display: 'flex', gap: 8 }}>
          {VERDICT_BUTTONS.map(v => {
            const on = current === v.id
            return (
              <button
                key={v.id}
                type="button"
                title={v.hint}
                onClick={() => onPick(v.id)}
                style={{
                  flex: 1, minHeight: 44, borderRadius: 10, cursor: 'pointer',
                  fontFamily: 'inherit', fontSize: 13, fontWeight: 700,
                  background: v.bg, color: v.fg,
                  border: v.id === 'unsure' ? `1px solid ${T.field}` : '1px solid transparent',
                  boxShadow: on ? `0 0 0 2px #fff, 0 0 0 4px ${v.id === 'unsure' ? T.field : v.bg}` : 'none',
                }}
              >{v.label}</button>
            )
          })}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 14, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 11, color: T.muted, lineHeight: 1.55, flex: 1, minWidth: 190 }}>
            Saved to this profile for everyone on your team. A valid claim stops asking to be
            verified; a false one stays on the page, marked.
          </div>
          {current && (
            <button type="button" onClick={() => onPick(null)} style={{ ...quietBtn, flex: 'none' }}>
              Remove verdict
            </button>
          )}
          <button type="button" onClick={onClose} style={{ ...quietBtn, flex: 'none' }}>Cancel</button>
        </div>
      </div>
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
  verdicts = null,
  onVerdict = null,
  onSectionChange = null,
}) {
  const [mode, setMode]   = useState('full')
  const [vOnly, setVOnly] = useState(false)
  const [ask, setAsk]     = useState(null)   // { key, text, current } — the lightbox
  const docRef = useRef(null)

  // The share view passes no verdicts prop but its dossier row carries the
  // column: verdicts render there read-only, with no lightbox and no writes.
  const verdictMap = verdicts
    || (dossier?.claim_verdicts && typeof dossier.claim_verdicts === 'object' ? dossier.claim_verdicts : null)

  const { report, hiddenCount, sourcing, risk, sources } = useReport(content, showEmpty, verdictMap)
  const candidate = dossier?.candidate || {}
  const subject   = candidate.name || ''

  const onAsk = useCallback((el, text) => {
    if (!el?.key) return
    setAsk({ key: el.key, text: text || el.text || '', current: el.verdict?.verdict || null })
  }, [])
  const askVerdict = onVerdict ? onAsk : null

  const visible = useMemo(() => {
    if (!vOnly) return report.sections
    return filterToUnverified(report.sections)
  }, [report, vOnly])

  // Let the host remember which section is in view (refresh-proof reading spot).
  const onSectionChangeRef = useRef(onSectionChange)
  onSectionChangeRef.current = onSectionChange

  const railIds = useMemo(() => visible.map(s => s.id), [visible])
  const { active, scrollToSection } = useScrollSpy(railIds, docRef, true)

  // Report the in-view section upward: rail clicks land instantly via
  // scrollToSection's setActive; scroll changes settle through this debounce.
  useEffect(() => {
    if (!active) return
    const t = setTimeout(() => onSectionChangeRef.current?.(active), 800)
    return () => clearTimeout(t)
  }, [active])

  const office = candidate.office || candidate.offices || null
  // Shared formatter (lib/office.js). This header renders the label straight
  // into JSX, so it wants '' — not the null the dashboards branch on.
  const officeLabel = officeLine(office, { empty: '' })
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

  // Needs verification, after the team's verdicts. The SOURCING ratio below is
  // deliberately untouched: a team verdict is not a primary record, so it never
  // moves the honest ratio — it only stops the report asking again.
  const team = report.verdictTotals || { valid: 0, false: 0, unsure: 0, resolvedWeak: 0, total: 0 }
  const pendingWeak = Math.max(0, sourcing.weak - team.resolvedWeak)
  const teamNote = [
    team.valid  ? `${team.valid} verified by ${onVerdict ? 'your team' : 'the profile owner'}` : '',
    team.false  ? `${team.false} marked false` : '',
    team.unsure ? `${team.unsure} reviewed, still open` : '',
  ].filter(Boolean).join(' · ')

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
      <ProfilerStatStrip cols={4}>
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
          value={pendingWeak}
          sub={teamNote || (sourcing.weak
            ? `${sourcing.material} material · ${sourcing.minor} minor`
            : 'Nothing tagged for follow-up')}
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
      </ProfilerStatStrip>

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
                  {vOnly
                    ? team.resolvedWeak > 0
                      ? 'Nothing is left to verify in this profile'
                      : 'Nothing in this profile is tagged for verification'
                    : 'This profile has no readable sections'}
                </div>
                <div style={{ fontSize: 12.5, color: T.muted, lineHeight: 1.6, maxWidth: '62ch' }}>
                  {vOnly
                    ? team.resolvedWeak > 0
                      ? `${onVerdict ? 'Your team' : 'The profile owner'} has ruled on every claim the report flagged. Switch back to the full report to read it.`
                      : 'Every claim the report tagged is sourced to a primary record, or the profile predates confidence tagging. Switch back to the full report to read it.'
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

                  {blocks.map((b, i) => <Block key={i} b={b} subject={subject} onAsk={askVerdict} />)}

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

      {ask && onVerdict && (
        <VerdictLightbox
          claim={ask.text}
          current={ask.current}
          onClose={() => setAsk(null)}
          onPick={(verdict) => { setAsk(null); onVerdict(ask.key, verdict) }}
        />
      )}
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
