// candidate/shared.jsx — primitives and parsers shared by the candidate profile
// views (SPEC-candidate-profile.md).
//
// Design tokens, Card/Pill/EmptyState/CtaButton and the date helpers are
// imported from ../dashboard/shared so the profile page and the dashboards
// cannot drift. Digest category colors come from lib/campaignEnums'
// DIGEST_CATEGORY_META, which mirrors CATEGORY_META in
// netlify/functions/monitoring-digest.js (the producer). Nothing here defines a
// second copy of a category, status, party or plan value.

import React, { useCallback, useEffect, useState } from 'react'
import { sanitizeHtml } from '../../lib/sanitize'
import { getDossier } from '../../lib/supabase'
import { digestCategory } from '../../lib/campaignEnums'

export {
  T, cardStyle, Card, CardHead, Pill, PartyPill, StatusPill,
  EmptyState, CtaButton, TextLink, LivePulseDot,
  safeISO, fmtInt, fmtDate, daysUntil, isUpcoming, initialsOf,
  officeLine, nextMonday, isMonitored, monitoringSlots, relativeTime,
} from '../dashboard/shared'

import { T, fmtDate, safeISO } from '../dashboard/shared'

// ── Page-level styles: keyframes + the SPEC §8 breakpoints ───────────────────
// The sidebar / top bar collapse is owned by Layout.jsx. Everything here is
// scoped to this page's own content: grids to one column at 900px, header
// stacks, the two nav rows scroll horizontally instead of wrapping, and the
// three-up fact grids go single column at 560px.
export function ProfileStyles() {
  return (
    <style>{`
      @keyframes cpPulse { 0%,100% { opacity: 1 } 50% { opacity: .35 } }
      .cp-row { border-radius: 10px; transition: background .12s ease }
      .cp-row:hover { background: ${T.hover} }
      .cp-nav { scrollbar-width: none }
      .cp-nav::-webkit-scrollbar { display: none }
      .cp-btn { transition: background .15s ease, border-color .15s ease }
      .cp-a { color: ${T.red}; text-decoration: none; font-weight: 600 }
      .cp-a:hover { text-decoration: underline }
      .bb-link { color: ${T.muted}; text-decoration: none }
      .bb-link:hover { color: ${T.ink2} }
      .bb-cta { transition: background .15s ease }
      @media (max-width: 900px) {
        .cp-cols, .cp-cols2 { grid-template-columns: 1fr !important }
        .cp-head { flex-direction: column !important; align-items: flex-start !important }
        .cp-headright { margin-left: 0 !important; align-items: flex-start !important;
                        text-align: left !important; width: 100% !important }
        .cp-nav { width: 100% !important; overflow-x: auto }
      }
      @media (max-width: 560px) {
        .cp-cols3 { grid-template-columns: 1fr !important }
      }
    `}</style>
  )
}

// Every interactive control on this page routes through these two so the 44px
// minimum tap target from SPEC §8 is enforced in one place.
export const TAP = { minHeight: 44, display: 'inline-flex', alignItems: 'center' }

export function Btn({ children, onClick, kind = 'ghost', disabled, style, title, type = 'button' }) {
  const base = {
    borderRadius: 99, fontSize: 12, fontWeight: 600, fontFamily: 'inherit',
    padding: '7px 14px', cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1, minHeight: 34,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
  }
  const kinds = {
    primary: { background: T.red, color: '#fff', border: 0 },
    ghost:   { background: '#fff', color: T.ink, border: `1px solid ${T.border}` },
    warm:    { background: '#fff', color: T.ink3, border: '1px solid #E8D5C0' },
  }
  return (
    <button
      type={type}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className="cp-btn"
      onMouseEnter={e => { if (!disabled) e.currentTarget.style.background = kind === 'primary' ? T.redDark : T.hover }}
      onMouseLeave={e => { e.currentTarget.style.background = kind === 'primary' ? T.red : '#fff' }}
      style={{ ...base, ...kinds[kind], ...style }}
    >{children}</button>
  )
}

// Section header used by every non-overview view.
export function ViewHead({ title, sub, right }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
      <span style={{ fontSize: 14, fontWeight: 700 }}>{title}</span>
      {sub && <span style={{ fontSize: 11.5, color: T.faint }}>{sub}</span>}
      {right && <span style={{ marginLeft: 'auto' }}>{right}</span>}
    </div>
  )
}

export function NewBadge({ label = 'NEW' }) {
  return (
    <span style={{
      fontSize: 9, fontWeight: 700, background: '#FBEAEA', color: T.red,
      borderRadius: 99, padding: '3px 8px', letterSpacing: '.3px', whiteSpace: 'nowrap',
    }}>{label}</span>
  )
}

// Plan-gated views keep the existing Lock behavior from the old tab bar.
export function LockedView({ title, onSeePlans }) {
  return (
    <div style={{
      background: '#fff', border: `1px solid ${T.border}`, borderRadius: 16,
      boxShadow: '0 1px 3px rgba(0,0,0,.03)', padding: '48px 24px', textAlign: 'center',
    }}>
      <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 6 }}>{title} is locked</div>
      <div style={{ fontSize: 12.5, color: T.muted, lineHeight: 1.6, maxWidth: 420, margin: '0 auto 16px' }}>
        Campaign intelligence — news, SWOT, opposition research and allies — unlocks on the
        Campaign and Agency plans.
      </div>
      <Btn kind="primary" onClick={onSeePlans}>View plans</Btn>
    </div>
  )
}

export function Spinner({ pad = 40 }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', padding: pad }}>
      <span style={{
        width: 22, height: 22, borderRadius: '50%',
        border: `2px solid ${T.border}`, borderTopColor: T.red,
        animation: 'spin 1s linear infinite', display: 'inline-block',
      }} />
      <style>{'@keyframes spin{to{transform:rotate(360deg)}}'}</style>
    </div>
  )
}

// ── Digest categories ─────────────────────────────────────────────────────────
// Re-exported so views never reach for a color literal.
export const catMeta = digestCategory

export function CategoryPill({ category, width = 86 }) {
  const c = digestCategory(category)
  return (
    <span style={{
      width, flexShrink: 0, textAlign: 'center', fontSize: 9, fontWeight: 700,
      letterSpacing: '.4px', borderRadius: 99, padding: '3px 0',
      color: c.c, background: c.bg, height: 'fit-content', marginTop: 1,
    }}>{c.label.toUpperCase()}</span>
  )
}

// ── Which view owns which profile section ────────────────────────────────────
// Section numbering comes from the dossier prompt in
// netlify/functions/generate-dossier-background.js (14 sections).
export function sectionTarget(sectionName) {
  const s = String(sectionName || '').toUpperCase()
  if (s.includes('SWOT')) return ['intel', 'swot']
  const m = s.match(/SECTION\s+(\d+)/)
  const n = m ? Number(m[1]) : null
  if (n === 1 || n === 10 || n === 11) return ['intel', 'news']
  if (n === 6 || n === 13)             return ['intel', 'opposition']
  if (n === 8 || n === 9)              return ['intel', 'allies']
  if (n === 4)                         return ['record', 'results']
  if (n === 5)                         return ['data', null]
  return ['record', 'history']
}

// Digest item category → the view that shows that item in full.
export function categoryTarget(category) {
  switch (category) {
    case 'controversy': return ['intel', 'opposition']
    case 'endorsement': return ['intel', 'allies']
    case 'polling':
    case 'podcast':
    case 'social':
    case 'news':
    default:            return ['intel', 'news']
  }
}

// ── Weekly digest item provenance ────────────────────────────────────────────
// The monitoring digest may stamp each item with its own `source` (string) and
// `date` (YYYY-MM-DD). Older digests carry neither, so the per-refresh line is
// kept as the honest fallback. Nothing is guessed: a missing source is simply
// not printed.
export function digestItemMeta(item, dossier) {
  const src = typeof item?.source === 'string' ? item.source.trim() : ''
  const raw = typeof item?.date === 'string' ? item.date.trim() : ''
  const when = raw ? fmtDate(raw, 'MMM d, yyyy') : ''
  const parts = [src, when && when !== '—' ? when : ''].filter(Boolean)
  if (parts.length) return parts.join(' · ')
  return dossier?.generated_at
    ? `From the ${fmtDate(dossier.generated_at)} refresh`
    : 'Refresh date not recorded'
}

// Per-item unread rule. When the item carries its own date the dot is driven by
// that date against profile_views.viewed_at; otherwise it falls back to the
// per-refresh rule (was the whole dossier generated after the last view).
export function isDigestItemUnread(item, dossier, lastViewed, dossierIsUnseen) {
  const raw = typeof item?.date === 'string' ? item.date.trim() : ''
  if (raw && lastViewed) {
    const t = safeISO(raw)
    const cutoff = Date.parse(lastViewed)
    if (t && !Number.isNaN(cutoff)) return +t > cutoff
  }
  return !!dossierIsUnseen
}

// ── Weakness headlines ───────────────────────────────────────────────────────
// Extraction, never invention: the bold headline on an opposition card is the
// first sentence (or first clause) of the weakness itself, trimmed at a word
// boundary to `max` characters with an ellipsis when it had to be cut.
export function headlineFrom(text, max = 60) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim()
  if (!clean) return ''
  const cut = clean.search(/[.!?](?:\s|$)|[;:–—]\s/)
  let head = cut > 0 ? clean.slice(0, cut).trim() : clean
  if (head.length <= max) return head.replace(/[,\-–—:;]+$/, '').trim()
  const slice = head.slice(0, max + 1)
  const sp = slice.lastIndexOf(' ')
  head = (sp > 20 ? slice.slice(0, sp) : head.slice(0, max))
  return head.replace(/[,\-–—:;]+$/, '').trim() + '…'
}

// ── District → counties (public/geodata/wi-district-places.json) ─────────────
// Keys are assembly-N / senate-N / congress-N, built the same way
// components/DistrictDashboard.jsx's districtKeyFor builds them — only here the
// input is an offices row (level / office_type / name / district_number) rather
// than a map click. Anything that doesn't resolve returns null and the caller
// renders nothing.
export function districtKeyForOffice(office) {
  if (!office) return null
  const name = String(office.name || '')
  const hay = `${name} ${office.office_type || ''} ${office.district_name || ''}`.toLowerCase()
  const num = Number.parseInt(
    office.district_number != null && office.district_number !== ''
      ? office.district_number
      : (name.match(/district\s+(\d+)/i) || [])[1],
    10,
  )
  if (!Number.isFinite(num) || num <= 0) return null
  const level = String(office.level || '').toLowerCase()
  const isUsSenate = /u\.?s\.?\s*senat|united states senat/.test(hay)
  if (isUsSenate) return null // statewide, not a district in this dataset
  if (level === 'federal' || /congress|u\.?s\.?\s*house|u\.?s\.?\s*representative/.test(hay)) {
    return `congress-${num}`
  }
  if (/assembly/.test(hay)) return `assembly-${num}`
  if (/senate/.test(hay) && (level === 'state' || /state/.test(hay))) return `senate-${num}`
  return null
}

let _placesPromise = null
function loadDistrictPlaces() {
  if (!_placesPromise) {
    _placesPromise = fetch('/geodata/wi-district-places.json')
      .then(r => (r.ok ? r.json() : null))
      .catch(() => null)
  }
  return _placesPromise
}

// Lazy-fetches the places map and returns the county list for this office, or
// null when the office doesn't resolve to a district key / the file is absent.
export function useDistrictCounties(office) {
  const key = districtKeyForOffice(office)
  const [counties, setCounties] = useState(null)
  useEffect(() => {
    if (!key) { setCounties(null); return }
    let cancelled = false
    loadDistrictPlaces().then(map => {
      if (cancelled) return
      const list = map?.[key]?.counties
      setCounties(Array.isArray(list) && list.length ? list : null)
    })
    return () => { cancelled = true }
  }, [key])
  return counties
}

// ── Dossier content parsing (carried over from the previous page) ─────────────

export function parseSection(content, sectionNum) {
  if (!content) return null
  const parts = ('\n' + content).split(/\n(?=## SECTION \d)/i)
  for (const part of parts) {
    if (new RegExp(`^## SECTION ${sectionNum}[:\\s]`, 'i').test(part.trim())) return part.trim()
  }
  return null
}

// Bracket-token chips. ONE source of truth for how [KNOWN] / [RESEARCH REQUIRED]
// / [X/Live] are coloured: mdToHtml() uses it for the section markdown (the
// "Affiliations & endorsements" table) and <Chip> uses it for the React lists
// (the Allies rows), so a token looks identical wherever it surfaces.
const BADGE_THEMES = {
  'KNOWN':             { bg: '#dcfce7', fg: '#166534', br: '#bbf7d0' },
  'RESEARCH REQUIRED': { bg: '#fef3c7', fg: '#92400e', br: '#fde68a' },
  'CONFIRMED':         { bg: '#dbeafe', fg: '#1e40af', br: '#bfdbfe' },
  'LIKELY':            { bg: '#f3e8ff', fg: '#6b21a8', br: '#e9d5ff' },
  'VERIFY':            { bg: '#fefce8', fg: '#854d0e', br: '#fef08a' },
  'HIGH':              { bg: '#fee2e2', fg: '#991b1b', br: '#fecaca' },
  'MEDIUM':            { bg: '#ffedd5', fg: '#9a3412', br: '#fed7aa' },
  'LOW':               { bg: '#f0fdf4', fg: '#166534', br: '#bbf7d0' },
}
const DEFAULT_BADGE_THEME = { bg: '#f3f4f6', fg: '#374151', br: '#d1d5db' }

export function badgeTheme(label) {
  return BADGE_THEMES[String(label || '').trim().toUpperCase()] || DEFAULT_BADGE_THEME
}

const badgeCss = (label) => {
  const th = badgeTheme(label)
  return `background:${th.bg};color:${th.fg};border:1px solid ${th.br};`
}

/** React twin of the markdown badge — same palette, same shape. */
export function Chip({ label }) {
  const th = badgeTheme(label)
  return (
    <span style={{
      display: 'inline-block', fontSize: '0.7rem', fontWeight: 700,
      padding: '1px 6px', borderRadius: 4, whiteSpace: 'nowrap',
      background: th.bg, color: th.fg, border: `1px solid ${th.br}`,
    }}>{label}</span>
  )
}

function applyInline(text) {
  return text
    .replace(/\*\*\[([A-Z ]+)\]\*\*/g, (_, b) =>
      `<span style="display:inline-block;font-size:0.7rem;font-weight:700;padding:1px 6px;border-radius:4px;${badgeCss(b)}">${b}</span>`)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer" style="color:#1d4ed8;text-decoration:underline;">$1</a>')
}

export function mdToHtml(text) {
  if (!text) return ''
  text = text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
  text = text.replace(/<ant[Tt]hinking>[\s\S]*?<\/ant[Tt]hinking>/gi, '')
  const lines = text.split('\n')
  const out = []
  let inTable = false, inUl = false
  lines.forEach(line => {
    const trimmed = line.trim()
    if (trimmed.startsWith('|')) {
      if (!inTable) {
        inTable = true
        out.push('<div style="overflow-x:auto;margin:8px 0"><table style="width:100%;border-collapse:collapse;font-size:0.78rem">')
        out.push('<thead><tr>' + trimmed.split('|').filter((_, i, a) => i > 0 && i < a.length - 1).map(c => `<th style="padding:6px 10px;text-align:left;border-bottom:2px solid #ECECEA;background:#FAFAF9;white-space:nowrap">${applyInline(c.trim())}</th>`).join('') + '</tr></thead><tbody>')
        return
      }
      if (/^\|[\s\-|]+\|$/.test(trimmed)) return
      out.push('<tr>' + trimmed.split('|').filter((_, i, a) => i > 0 && i < a.length - 1).map(c => `<td style="padding:5px 10px;border-bottom:1px solid #F2F2F0;vertical-align:top">${applyInline(c.trim())}</td>`).join('') + '</tr>')
      return
    }
    if (inTable) { out.push('</tbody></table></div>'); inTable = false }
    if (inUl && !trimmed.startsWith('-') && !trimmed.startsWith('*')) { out.push('</ul>'); inUl = false }
    if (!trimmed) { out.push('<br/>'); return }
    if (trimmed.startsWith('#### ')) { out.push(`<h4 style="font-size:0.8rem;font-weight:700;color:#3F3F46;margin:10px 0 4px">${applyInline(trimmed.slice(5))}</h4>`); return }
    if (trimmed.startsWith('### '))  { out.push(`<h3 style="font-size:0.875rem;font-weight:700;color:#18181B;margin:12px 0 4px">${applyInline(trimmed.slice(4))}</h3>`); return }
    if (trimmed.startsWith('## '))   { out.push(`<h2 style="font-size:1rem;font-weight:800;color:#18181B;margin:14px 0 6px;padding-bottom:4px;border-bottom:1px solid #ECECEA">${applyInline(trimmed.slice(3))}</h2>`); return }
    if (trimmed.startsWith('- ') || trimmed.startsWith('* ') || trimmed.startsWith('[ ]') || trimmed.startsWith('[x]')) {
      if (!inUl) { out.push('<ul style="margin:4px 0;padding-left:20px;list-style:disc">'); inUl = true }
      out.push(`<li style="margin:2px 0;font-size:0.82rem;color:#3F3F46">${applyInline(trimmed.replace(/^[-*]\s/, '').replace(/^\[[x ]\]\s/, ''))}</li>`)
      return
    }
    out.push(`<p style="margin:4px 0;font-size:0.82rem;color:#3F3F46;line-height:1.6">${applyInline(trimmed)}</p>`)
  })
  if (inTable) out.push('</tbody></table></div>')
  if (inUl) out.push('</ul>')
  return sanitizeHtml(out.join(''))
}

export function SectionContent({ sectionText, emptyMessage }) {
  if (!sectionText) return <div style={{ fontSize: 12.5, color: T.faint }}>{emptyMessage || 'No content available.'}</div>
  const lines = sectionText.split('\n')
  const body = lines.slice(lines[1]?.match(/^\*\*\[/) ? 2 : 1).join('\n').trim()
  if (!body) return <div style={{ fontSize: 12.5, color: T.faint }}>{emptyMessage || 'No content available.'}</div>
  return <div dangerouslySetInnerHTML={{ __html: mdToHtml(body) }} />
}

// ── News / social item parsing (Section 1 + Section 10) ──────────────────────

const SOURCE_DOMAIN_MAP = {
  'WSAU': 'wsau.com', 'WKOW': 'wkow.com', 'WEAU': 'weau.com', 'WBAY': 'wbay.com',
  'WSAW': 'wsaw.com', 'WXOW': 'wxow.com', 'WITI': 'fox6now.com', 'FOX6': 'fox6now.com',
  'WTMJ': 'wtmj.com', 'WISN': 'wisn.com', 'TMJ4': 'tmj4.com', 'WFRV': 'wfrv.com',
  'WLUK': 'fox11online.com', 'NBC15': 'nbc15.com', 'CBS58': 'cbs58.com',
  'WPR': 'wpr.org', 'Wisconsin Public Radio': 'wpr.org',
  'Milwaukee Journal Sentinel': 'jsonline.com', 'Journal Sentinel': 'jsonline.com',
  'Wisconsin State Journal': 'madison.com', 'Cap Times': 'captimes.com',
  'Capital Times': 'captimes.com', 'Wausau Daily Herald': 'wausaudailyherald.com',
  'Green Bay Press-Gazette': 'greenbaypressgazette.com',
  'Appleton Post-Crescent': 'postcrescent.com', 'La Crosse Tribune': 'lacrossetribune.com',
  'Wisconsin Watch': 'wisconsinwatch.org', 'Urban Milwaukee': 'urbanmilwaukee.com',
  'WisPolitics': 'wispolitics.com', 'Wisconsin Examiner': 'wisconsinexaminer.com',
  'AP': 'apnews.com', 'Associated Press': 'apnews.com', 'Reuters': 'reuters.com',
  'Politico': 'politico.com', 'The Hill': 'thehill.com', 'NPR': 'npr.org',
  'Facebook': 'facebook.com', 'Twitter': 'twitter.com', 'X': 'x.com',
  'Instagram': 'instagram.com', 'YouTube': 'youtube.com',
  'LinkedIn': 'linkedin.com', 'TikTok': 'tiktok.com',
}

const SOCIAL_PLATFORMS = new Set(['facebook', 'twitter', 'x', 'instagram', 'youtube', 'linkedin', 'tiktok', 'reddit', 'threads', 'nextdoor'])

export function isSocialSrc(source = '') {
  const lower = source.toLowerCase()
  return SOCIAL_PLATFORMS.has(lower) ||
    lower.includes('facebook') || lower.includes('twitter') ||
    lower.includes('instagram') || lower.includes('youtube') ||
    lower.includes('linkedin') || lower.includes('tiktok')
}

export function detectPlatform(source = '') {
  const lower = source.toLowerCase()
  for (const p of SOCIAL_PLATFORMS) if (lower.includes(p)) return p
  return null
}

function getDomain(source = '', url = null) {
  try { if (url) return new URL(url).hostname.replace(/^www\./, '') } catch { /* not a URL */ }
  if (!source) return null
  if (SOURCE_DOMAIN_MAP[source]) return SOURCE_DOMAIN_MAP[source]
  for (const [key, domain] of Object.entries(SOURCE_DOMAIN_MAP)) {
    if (source.toLowerCase().includes(key.toLowerCase()) || key.toLowerCase().includes(source.toLowerCase())) return domain
  }
  return null
}

export function parseNewsItems(content = '') {
  const items = []
  const lines = content.split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.startsWith('### ')) {
      const headingText = line.slice(4).trim()
      const linkMatch = headingText.match(/^\[([^\]]+)\]\((https?:\/\/[^)]+)\)\s*$/)
      const title = linkMatch ? linkMatch[1] : headingText.replace(/\*\*/g, '').replace(/`/g, '')
      const url = linkMatch ? linkMatch[2] : null
      if (!title || title.length < 3) { i++; continue }
      let source = '', date = '', flag = null, j = i + 1
      while (j < lines.length && !lines[j].trim()) j++
      if (j < lines.length) {
        const srcLine = lines[j].trim()
        const srcMatch = srcLine.match(/^\*\*([^*]+)\*\*\s*[·•\-–]\s*(.+)/)
        if (srcMatch) {
          source = srcMatch[1].trim()
          const dateRaw = srcMatch[2]
          const badgeMatch = dateRaw.match(/\*\*\[([A-Za-z ]+)\]\*\*/)
          if (badgeMatch) flag = badgeMatch[1].toUpperCase()
          date = dateRaw.replace(/\*\*\[[A-Za-z ]+\]\*\*/g, '').replace(/\*\*/g, '').trim()
          j++
        }
      }
      const descParts = []
      while (j < lines.length) {
        const dl = lines[j].trim()
        if (!dl || dl.startsWith('##') || dl.startsWith('---')) break
        if (!flag) {
          const bm = dl.match(/\*\*\[([A-Za-z ]+)\]\*\*/)
          if (bm) flag = bm[1].toUpperCase()
        }
        const cleaned = dl.replace(/\*\*\[[A-Za-z ]+\]\*\*/g, '').replace(/\*\*/g, '').trim()
        if (cleaned) descParts.push(cleaned)
        j++
      }
      const domain = getDomain(source, url)
      const isSocial = isSocialSrc(source)
      const searchUrl = url || `https://www.google.com/search?q=${encodeURIComponent((title + ' ' + source).trim())}`
      items.push({ title, url, searchUrl, source, date, description: descParts.join(' ').slice(0, 250), flag, domain, isSocial })
      i = j
    } else { i++ }
  }
  return items
}

export function parseSocialItems(content = '') {
  const section10 = parseSection(content, 10)
  if (!section10) return []
  return parseNewsItems(section10).map(it => ({ ...it, isSocial: true }))
}

// ── Dossier content, fetched once per id ─────────────────────────────────────
// The list query already returns `content` on most rows; when it doesn't (or a
// row was trimmed) the single-row query fills it in. Cached at module level so
// opening the same comparison twice costs one request.
const _contentCache = new Map()

export async function fetchDossierContent(dossierOrId) {
  if (!dossierOrId) return null
  const id = typeof dossierOrId === 'string' ? dossierOrId : dossierOrId.id
  const inline = typeof dossierOrId === 'object' ? dossierOrId.content : null
  if (inline) { _contentCache.set(id, inline); return inline }
  if (!id) return null
  if (_contentCache.has(id)) return _contentCache.get(id)
  try {
    const { data } = await getDossier(id)
    const content = data?.content || null
    if (content) _contentCache.set(id, content)
    return content
  } catch {
    return null
  }
}

// ── Client-side refresh diff ─────────────────────────────────────────────────
// Same deterministic algorithm as buildRefreshDiff() in
// netlify/functions/generate-dossier-background.js — split on `## SECTION n`,
// normalize lines, set-difference — with the actual added lines carried through
// so the comparison modal can show them. No AI, no heuristics beyond the ones
// the backend already applies.
export const DIFF_SECTION_LABELS = {
  1: 'News Feed', 2: 'Biography', 3: 'Timeline', 4: 'Political Record',
  5: 'Financial', 6: 'Opposition', 7: 'Platform', 8: 'Affiliations',
  9: 'Allies', 10: 'Social Media', 11: 'District', 12: 'SWOT',
  13: 'Attack & Defense', 14: 'Sources',
}

export function splitSections(content) {
  const map = {}
  const re = /##\s*SECTION\s*(\d+)[^\n]*\n([\s\S]*?)(?=##\s*SECTION\s*\d+|$)/gi
  let m
  while ((m = re.exec(String(content || ''))) !== null) map[Number(m[1])] = m[2]
  return map
}

// normalized line → original line, keeping the backend's >20 character filter
// so boilerplate and blank lines never register as changes.
function diffLineMap(text) {
  const out = new Map()
  for (const raw of String(text || '').split('\n')) {
    const norm = raw.trim().toLowerCase().replace(/\s+/g, ' ')
    if (norm.length > 20 && !out.has(norm)) out.set(norm, raw.trim())
  }
  return out
}

export function computeSectionDiff(prevContent, newContent, { maxLines = 10 } = {}) {
  const A = splitSections(prevContent)
  const B = splitSections(newContent)
  const nums = [...new Set([...Object.keys(A), ...Object.keys(B)].map(Number))]
    .filter(Number.isFinite).sort((a, b) => a - b)
  const sections = []
  for (const n of nums) {
    const label = DIFF_SECTION_LABELS[n] || `Section ${n}`
    const pa = diffLineMap(A[n]), pb = diffLineMap(B[n])
    const addedLines = [...pb.keys()].filter(k => !pa.has(k)).map(k => pb.get(k))
    const added = addedLines.length
    const removed = [...pa.keys()].filter(k => !pb.has(k)).length
    let status = 'unchanged', note = 'No change'
    if (!(n in A) && (n in B))      { status = 'new';     note = 'Section added in this refresh' }
    else if ((n in A) && !(n in B)) { status = 'updated'; note = 'Section no longer present' }
    else if (added >= 3)            { status = 'new';     note = `${added} new lines of intelligence` }
    else if (added > 0)             { status = 'updated'; note = `${added} new line${added === 1 ? '' : 's'}` }
    else if (removed > 0)           { status = 'updated'; note = 'Content revised' }
    sections.push({
      section: `SECTION ${n}`, label, status,
      new_items: status === 'unchanged' ? 0 : added,
      note, removed,
      added: addedLines.slice(0, maxLines),
      added_total: added,
    })
  }
  return { sections }
}

// ── Hooks ─────────────────────────────────────────────────────────────────────

// Loads the newest dossier's raw content once and hands back the requested
// `## SECTION n` blocks. Identical contract to the previous page's hook.
export function useDossierSection(dossiers, sectionNums) {
  const [content, setContent] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const key = JSON.stringify(sectionNums)
  useEffect(() => {
    if (!dossiers || dossiers.length === 0) return
    const latest = dossiers[0]
    const doExtract = (raw) => {
      const sections = {}
      for (const n of JSON.parse(key)) sections[n] = parseSection(raw, n)
      setContent(sections)
    }
    if (latest.content) { doExtract(latest.content); return }
    setLoading(true)
    getDossier(latest.id).then(({ data, error: err }) => {
      setLoading(false)
      if (err || !data?.content) { setError('Could not load profile content'); return }
      doExtract(data.content)
    })
  }, [dossiers, key])
  return { content, loading, error }
}

// Haiku-generated snapshot paragraph from the newest dossier. Unchanged from the
// previous page — same endpoint, same stripping, same auto-fire-once behavior.
export function useBioSummary(dossiers, candidateName, session, candidateId) {
  const [summary, setSummary] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [triggered, setTriggered] = useState(false)

  // /candidates/:id re-renders this hook in place when the user moves from one
  // candidate to the next, so the auto-fire-once flag has to be scoped to the
  // candidate. Without this reset the second candidate kept showing (or kept
  // erroring with) the first candidate's snapshot and never regenerated.
  useEffect(() => {
    setSummary(null)
    setError(null)
    setLoading(false)
    setTriggered(false)
  }, [candidateId])

  const generate = useCallback(async () => {
    if (!dossiers || dossiers.length === 0) return
    const latestId = dossiers[0].id
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/.netlify/functions/generate-bio-summary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ dossier_id: latestId, candidate_name: candidateName }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      const raw = data.summary || null
      const stripped = raw
        ? raw
            .replace(/^(#{1,6}[^\n]*\n+)+/m, '')
            .replace(/^Political Intelligence Briefing[^\n]*\n*/im, '')
            .replace(/^[A-Z][^\n]{0,80}Candidate[^\n]*\n*/m, '')
            .replace(/^[A-Z][^\n]{0,80}Briefing[^\n]*\n*/m, '')
            .trim()
        : null
      setSummary(stripped || null)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [dossiers, candidateName, session])

  useEffect(() => {
    if (!triggered && dossiers && dossiers.length > 0 && session?.access_token) {
      setTriggered(true)
      generate()
    }
  }, [dossiers, session, triggered, generate])

  return { summary, loading, error, generate }
}

// ── Notes & files (v2 JSON in candidates.notes) ──────────────────────────────

export function parseNotesData(raw) {
  if (!raw) return { v: 2, notes: [], files: [] }
  if (typeof raw === 'string' && raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw)
      if (parsed.v === 2) return parsed
    } catch { /* fall through to legacy handling */ }
  }
  if (raw && String(raw).trim()) {
    // ai_access is set explicitly so the UI switch and the server-side filter
    // (_candidate-context.js, which requires ai_access === true) agree: a
    // legacy note is private until the user turns AI on for it.
    return { v: 2, notes: [{ id: 'legacy', text: String(raw), ts: null, ai_access: false }], files: [] }
  }
  return { v: 2, notes: [], files: [] }
}

export function fileGlyph(mimeType = '') {
  if (mimeType.includes('pdf')) return 'PDF'
  if (mimeType.includes('word') || mimeType.includes('document')) return 'DOC'
  if (mimeType.includes('sheet') || mimeType.includes('excel') || mimeType.includes('csv')) return 'XLS'
  if (mimeType.startsWith('image/')) return 'IMG'
  return 'FILE'
}

export const FILE_TILE = {
  PDF:  { bg: '#FBEAEA', fg: '#A51C24' },
  DOC:  { bg: '#E7F0FD', fg: '#1D4ED8' },
  XLS:  { bg: '#E6F5EC', fg: '#15803D' },
  IMG:  { bg: '#F3EDFB', fg: '#7C3AED' },
  FILE: { bg: '#F1F1EF', fg: '#52525B' },
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0
  if (n < 1024) return `${n} B`
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1048576).toFixed(1)} MB`
}
