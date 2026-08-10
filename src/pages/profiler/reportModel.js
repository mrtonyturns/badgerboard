// src/pages/profiler/reportModel.js — the Profiler report, as data.
//
// SPEC-profiler.md §3: the report becomes ONE quiet document. That means the
// markdown a dossier stores has to be turned into *typed content blocks*
// (paragraph / label-value list / key-value grid / risk entry / attack-defense
// pair) instead of a wall of undifferentiated prose with a colour theme and a
// confidence badge on every line.
//
// Everything in this file is extraction, never invention:
//   · takeaways are the section's own first bolded line or first sentence
//   · the sourcing ratio counts the report's own confidence badges
//   · risk severity comes from the report's own **[HIGH|MEDIUM|LOW]** tags
//   · "sources cited" counts the distinct URLs actually present in the text
// Anything that cannot be derived is rendered as an honest dash by the callers.
//
// No React in here on purpose: it is unit-testable in plain node.

import { escapeHtml, sanitizeHtml } from '../../lib/sanitize'

// ─── Section metadata: Overview + the 14 master-prompt sections ──────────────
// Moved here from Dossiers.jsx (single definition — Dossiers.jsx, SharedDossier
// and the print builder all import it from this module).
export const SECTION_META = [
  { id: 'overview',   label: 'Overview'           },
  { id: 'section-1',  label: 'News & Media'       },
  { id: 'section-2',  label: 'Biography'          },
  { id: 'section-3',  label: 'Timeline'           },
  { id: 'section-4',  label: 'Political Record'   },
  { id: 'section-5',  label: 'Campaign Finance'   },
  { id: 'section-6',  label: 'Controversies'      },
  { id: 'section-7',  label: 'Policy Positions'   },
  { id: 'section-8',  label: 'Affiliations'       },
  { id: 'section-9',  label: 'Network'            },
  { id: 'section-10', label: 'Social Posts'       },
  { id: 'section-11', label: 'Digital Footprint'  },
  { id: 'section-12', label: 'Narrative & Message'},
  { id: 'section-13', label: 'Attack & Defense'   },
  { id: 'section-14', label: 'Verification'       },
]

// ─── Contents rail groups (SPEC §3) ──────────────────────────────────────────
export const GROUP_ORDER = ['IDENTITY', 'RECORD & POSITIONS', 'RISK', 'COVERAGE & NETWORK', 'ADDITIONAL']

// Document order inside each group, by section number.
const GROUP_SECTIONS = {
  'IDENTITY':           [2, 3, 11],
  'RECORD & POSITIONS': [4, 7, 5],
  'RISK':               [6, 13, 12],
  'COVERAGE & NETWORK': [1, 9, 8, 10, 14],
}

const SECTION_GROUP = {}
const SECTION_RANK  = {}
GROUP_ORDER.forEach((g, gi) => {
  ;(GROUP_SECTIONS[g] || []).forEach((n, ni) => {
    SECTION_GROUP[`section-${n}`] = g
    SECTION_RANK[`section-${n}`]  = gi * 100 + ni
  })
})

export function groupOf(sectionId) { return SECTION_GROUP[sectionId] || 'ADDITIONAL' }

// ─── Confidence + severity vocabulary (the report's own tags) ────────────────
// The master prompt emits these in mixed case — "**[KNOWN]**" but also
// "**[Verify]**" and "**[Likely]**" — so the match is case-insensitive and the
// captured tag is normalized. The counting RULE is unchanged from the old
// verifiedPct: KNOWN/CONFIRMED are sourced, everything else needs work.
const BADGE_G = /\*\*\[(KNOWN|CONFIRMED|LIKELY|VERIFY|RESEARCH[ _]REQUIRED|UNCONFIRMED|HIGH|MEDIUM|MED|LOW)\]\*\*/gi
const STRONG   = new Set(['KNOWN', 'CONFIRMED'])
const WEAK     = new Set(['LIKELY', 'VERIFY', 'RESEARCH REQUIRED', 'UNCONFIRMED'])
const SEVERITY = new Set(['HIGH', 'MEDIUM', 'LOW'])

const normalizeTag = (t) => {
  const u = String(t || '').trim().toUpperCase().replace(/_/g, ' ')
  return u === 'MED' ? 'MEDIUM' : u
}

// Only unverified / low-confidence claims get a label. KNOWN and CONFIRMED get
// nothing at all — that is the whole point of dropping the per-paragraph badge.
export const SEV_COLOR = { HIGH: '#B91C1C', MEDIUM: '#C2410C', LOW: '#71717A' }

function badgesIn(text) {
  const out = []
  for (const m of String(text || '').matchAll(BADGE_G)) out.push(normalizeTag(m[1]))
  return out
}

/** 'UNVERIFIED' | 'LOW CONFIDENCE' | '' — never a label for a confirmed claim. */
export function markerFor(text) {
  const found = badgesIn(text).filter(b => WEAK.has(b))
  if (!found.length) return ''
  // RESEARCH REQUIRED / VERIFY / UNCONFIRMED outrank LIKELY on a line with both.
  return found.some(b => b !== 'LIKELY') ? 'UNVERIFIED' : 'LOW CONFIDENCE'
}

export function hasWeakClaim(text) { return badgesIn(text).some(b => WEAK.has(b)) }

function severityIn(text) {
  const found = badgesIn(text).find(b => SEVERITY.has(b))
  return found || null
}

// ─── Text cleaning ───────────────────────────────────────────────────────────
export function stripThinking(text = '') {
  return String(text || '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .replace(/<ant[Tt]hinking>[\s\S]*?<\/ant[Tt]hinking>/gi, '')
}

const stripBadges = (t) => String(t || '').replace(BADGE_G, '').replace(/\s{2,}/g, ' ').trim()

// The master prompt puts a section-level confidence tag on its own line right
// under every "## SECTION n" heading (`**[HIGH]**`, `**[RESEARCH REQUIRED]**`).
// That line is a header, not a claim — counting it would inflate every metric
// on the page, so it is removed everywhere a tag is counted or rendered.
const BADGE_ONLY_LINE = /^[ \t]*\*\*\[[A-Za-z][A-Za-z _/]*\]\*\*[ \t]*$/gm
export const withoutSectionTags = (t) => String(t || '').replace(BADGE_ONLY_LINE, '')

/** Markdown emphasis removed — for plain-text uses (takeaways, titles, print alt). */
export function plainText(t = '') {
  return stripBadges(t)
    .replace(/\[([^\]]+)\]\((?:https?:)?[^)]*\)/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/(^|\W)\*([^*]+)\*/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s*/, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/**
 * Inline markdown → sanitized HTML. Escapes first, so nothing in the AI output
 * can inject markup; then re-adds the small set of inline elements the document
 * needs. Confidence badges are stripped — they are rendered as a typed marker
 * by the block, not inline.
 */
export function inlineHtml(text) {
  const escaped = escapeHtml(stripBadges(text))
  const html = escaped
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer" style="color:#18181B;text-decoration:underline;text-underline-offset:2px">$1</a>')
    .replace(/\*\*(.+?)\*\*/g, '<strong style="font-weight:600;color:#18181B">$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, '<code style="font-family:ui-monospace,SFMono-Regular,monospace;font-size:.92em">$1</code>')
  return sanitizeHtml(html)
}

// ─── Section splitting (behaviour preserved from the old Dossiers.jsx) ───────
export function parseSections(content = '') {
  if (!content) return [{ id: 'overview', label: 'Overview', content, index: 0 }]

  const primaryRe = /\n(?=## SECTION \d)/i
  if (primaryRe.test('\n' + content)) {
    const parts = ('\n' + content).split(primaryRe)
    const result = []
    parts.forEach((part, i) => {
      const trimmed = part.trim()
      if (!trimmed) return
      if (i === 0) {
        result.push({ id: 'overview', label: 'Overview', content: trimmed, index: 0 })
      } else {
        const m = trimmed.match(/^## SECTION (\d+)[:\s]*(.*)/i)
        const num = m ? parseInt(m[1], 10) : i
        const meta = SECTION_META[num] || { id: `section-${num}`, label: `Section ${num}` }
        result.push({ id: meta.id, label: meta.label, content: trimmed, index: num })
      }
    })
    if (result.length > 1) return result
  }

  const parts = content.split(/\n(?=## )/)
  if (parts.length > 1) {
    return parts.map((part, i) => {
      const meta = SECTION_META[i] || { id: `section-${i}`, label: `Section ${i}` }
      return { id: meta.id, label: meta.label, content: part.trim(), index: i }
    })
  }

  return [{ id: 'overview', label: 'Full Report', content: content.trim(), index: 0 }]
}

/** Pull the PROFILE SNAPSHOT block out so it can render as the SUMMARY block. */
export function extractSnapshot(content = '') {
  if (!content) return { snapshot: '', rest: content }
  const m = content.match(/##\s*PROFILE SNAPSHOT\s*\n([\s\S]*?)(?=\n##\s|$)/i)
  if (!m) return { snapshot: '', rest: content }
  const snapshot = plainText(m[1].replace(/\n+/g, ' '))
  const rest = content.replace(m[0], '').replace(/^\s*\n/, '').trim()
  return { snapshot, rest }
}

// ─── Flagged claims (existing helper, unchanged contract) ────────────────────
export function parseFlaggedClaims(content = '') {
  const flagged = []
  const lines   = String(content || '').split('\n')
  let currentSection = 'overview'

  lines.forEach(line => {
    const sectionMatch = line.match(/^## SECTION (\d+)/i)
    if (sectionMatch) { currentSection = `section-${sectionMatch[1]}`; return }
    // A line that is nothing but a tag is the section-level confidence header.
    if (/^\s*\*\*\[[A-Za-z][A-Za-z _/]*\]\*\*\s*$/.test(line)) return
    if (/\*\*\[(VERIFY|RESEARCH REQUIRED|LIKELY)\]\*\*/i.test(line)) {
      const clean = line
        .replace(/^[#*\-•\d.]+\s*/, '')
        .replace(/\*\*\[([A-Z ]+)\]\*\*/g, '[$1]')
        .replace(/\*\*/g, '')
        .trim()
      if (clean.length > 15) {
        flagged.push({
          id:        `${currentSection}::${clean.slice(0, 60)}`,
          sectionId: currentSection,
          text:      clean.slice(0, 300),
          badge:     /RESEARCH REQUIRED/i.test(line) ? 'RESEARCH REQUIRED' : /VERIFY/i.test(line) ? 'Verify' : 'Likely',
        })
      }
    }
  })

  const seen = new Set()
  return flagged.filter(f => { if (seen.has(f.id)) return false; seen.add(f.id); return true })
}

// ─── Honest metrics ──────────────────────────────────────────────────────────

/**
 * Sourcing ratio from the report's OWN confidence badges — the same counting
 * rule the old header pill used (KNOWN/CONFIRMED vs LIKELY/VERIFY/RESEARCH
 * REQUIRED). Below 5 tagged claims the ratio is null and callers show "—".
 */
export function sourcingStats(content = '') {
  let strong = 0, likely = 0, verify = 0, research = 0
  for (const m of withoutSectionTags(content).matchAll(BADGE_G)) {
    const b = normalizeTag(m[1])
    if (STRONG.has(b)) strong++
    else if (b === 'LIKELY') likely++
    else if (b === 'VERIFY') verify++
    else if (b === 'RESEARCH REQUIRED' || b === 'UNCONFIRMED') research++
  }
  const weak  = likely + verify + research
  const total = strong + weak
  return {
    strong, weak, total,
    // "material" = RESEARCH REQUIRED (the report says it could not be sourced);
    // "minor" = VERIFY / LIKELY (sourced, but not to a primary source).
    material: research,
    minor:    likely + verify,
    ratio:    total >= 5 ? strong / total : null,
  }
}

const SOCIAL_HOSTS = ['facebook.', 'twitter.', 'x.com', 'instagram.', 'youtube.', 'youtu.be',
  'linkedin.', 'tiktok.', 'threads.', 'reddit.', 'nextdoor.', 'bsky.']

/** Distinct URLs actually present in the document, split by host type. */
export function sourceStats(content = '') {
  const seen = new Set()
  let press = 0, filings = 0, social = 0
  for (const m of String(content || '').matchAll(/https?:\/\/[^\s)<>\]"']+/g)) {
    const raw = m[0].replace(/[.,;:]+$/, '')
    let host
    try { host = new URL(raw).hostname.replace(/^www\./, '').toLowerCase() } catch { continue }
    if (seen.has(raw)) continue
    seen.add(raw)
    if (SOCIAL_HOSTS.some(h => host.includes(h))) social++
    else if (/\.gov$/.test(host) || host.includes('.gov.')) filings++
    else press++
  }
  return { total: seen.size, press, filings, social }
}

/** Risk severities tagged inside sections 6 and 13 (the opposition sections). */
export function riskStats(content = '') {
  const text = withoutSectionTags(content)
  let slice = ''
  for (const n of [6, 13]) {
    const re = new RegExp(`##\\s*SECTION\\s*${n}\\b[\\s\\S]*?(?=\\n##\\s*SECTION\\s*\\d|$)`, 'i')
    const m = text.match(re)
    if (m) slice += '\n' + m[0]
  }
  const counts = { HIGH: 0, MEDIUM: 0, LOW: 0 }
  for (const line of slice.split('\n')) {
    const t = line.trim()
    if (!t || isTableSep(t)) continue
    // A tagged severity — **[HIGH]** — counts wherever it appears.
    const tagged = badgesIn(t).filter(b => SEVERITY.has(b))
    if (tagged.length) { tagged.forEach(b => counts[b]++); continue }
    // Section 6's table carries the research priority as a bare cell instead.
    if (t.startsWith('|')) {
      const cells = tableCells(t).map(c => plainText(c).toUpperCase())
      if (cells.some(c => /^(NAME|ISSUE|VULNERABILITY|FINDING|DATE|SUMMARY|SOURCE|SRC|STATUS|CONFIDENCE|PRIORITY|RESPONSE)$/.test(c))) continue
      const sev = cells.find(c => /^(HIGH|MEDIUM|MED|LOW)$/.test(c))
      if (sev) counts[sev === 'MED' ? 'MEDIUM' : sev]++
    }
  }
  const total = counts.HIGH + counts.MEDIUM + counts.LOW
  const top = counts.HIGH ? 'HIGH' : counts.MEDIUM ? 'MEDIUM' : counts.LOW ? 'LOW' : null
  return { ...counts, total, top, topCount: top ? counts[top] : 0 }
}

/** One-line FLAGS cell for the library table. */
export function flagSummary(content = '') {
  const risk   = riskStats(content)
  const verify = parseFlaggedClaims(content).length
  return {
    riskLabel:   risk.top ? `${risk.topCount} ${risk.top === 'MEDIUM' ? 'MED' : risk.top}` : '',
    riskColor:   risk.top ? SEV_COLOR[risk.top] : '#71717A',
    verifyLabel: verify ? `${verify} to verify` : '',
    clean:       !risk.top && !verify,
  }
}

// ─── Block parsing ───────────────────────────────────────────────────────────

const BULLET_RE   = /^([-*•]|\d+[.)])\s+(.*)$/
const CHECKBOX_RE = /^[-*]\s*\[([ xX])\]\s*(.*)$/
const ATTACK_RE   = /^(?:[-*]\s*)?\**\s*(?:attack|line of attack|charge|criticism|hit|they'?ll say|opponent says)\s*\d*\s*\**\s*[:\-–—]\s*(.+)$/i
const RESPOND_RE  = /^(?:[-*]\s*)?\**\s*(?:respond|response|reply|defense|defence|rebuttal|counter|answer|our answer)\s*\d*\s*\**\s*[:\-–—]\s*(.+)$/i
const SOURCE_RE   = /^\**\s*(?:source|sources|citation|documented|evidence|per)\b\s*\**\s*[:\-–—]?\s*(.+)$/i
const GENERIC_TH  = /^(field|item|category|detail|value|description|name|key|attribute|metric)s?$/i

const isTableRow = (l) => l.trim().startsWith('|')
const isTableSep = (l) => /^\|[\s\-:|]+\|$/.test(l.trim())
const tableCells = (l) => l.split('|').map(c => c.trim()).filter((_, i, a) => i > 0 && i < a.length - 1)

/** Split a bullet/table cell into a key and a value when it honestly has one. */
function splitKeyValue(text) {
  const t = String(text || '').trim()
  let m
  if ((m = t.match(/^\*\*(.{1,44}?)\*\*\s*[:\-–—]\s*(.+)$/))) return { k: plainText(m[1]), v: m[2].trim() }
  if ((m = t.match(/^\*\*(.{1,44}?)\*\*\s+(.{4,}$)/)))         return { k: plainText(m[1]), v: m[2].trim() }
  if ((m = t.match(/^((?:19|20)\d{2}(?:\s*[-–]\s*(?:19|20)\d{2}|s)?)\s*[:\-–—]\s*(.+)$/)))
    return { k: m[1].trim(), v: m[2].trim() }
  if ((m = t.match(/^([A-Z][a-z]{2}\.?\s+\d{1,2}(?:,\s*(?:19|20)\d{2})?|[A-Z][a-z]{2}\.?\s+(?:19|20)\d{2})\s*[:\-–—]\s*(.+)$/)))
    return { k: m[1].trim(), v: m[2].trim() }
  if ((m = t.match(/^([^:*]{2,32}):\s+(.{4,}$)/)) && !/[.!?]/.test(m[1])) return { k: plainText(m[1]), v: m[2].trim() }
  return { k: '', v: t }
}

/** Extraction, never invention: the section's own first bolded line or sentence. */
export function deriveTakeaway(md = '') {
  const lines = withoutSectionTags(stripThinking(md)).split('\n').map(l => l.trim()).filter(Boolean)
  for (const line of lines) {
    if (/^#{1,6}\s/.test(line) || isTableRow(line)) continue
    // "**Source** · Date" bylines and "**Heading:**" labels are not takeaways.
    if (/^\*\*[^*]+\*\*\s*[·•|]/.test(line)) continue
    const bold = line.match(/^\*\*(.+?)\*\*\s*[.:]?$/)
    if (bold) {
      if (/:$/.test(line.replace(/\*/g, '').trim())) continue
      const t = plainText(bold[1])
      if (t.length >= 20) return firstSentence(t, 240)
      continue
    }
    const body = plainText(line.replace(CHECKBOX_RE, '$2').replace(BULLET_RE, '$2'))
    if (body.length >= 40) return firstSentence(body, 240)
  }
  return ''
}

function firstSentence(text, max = 240) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim()
  if (!clean) return ''
  let out = clean
  const re = /[.!?](?=\s|$)/g
  let m
  while ((m = re.exec(clean)) !== null) {
    const end = m.index + 1
    if (end >= 45) { out = clean.slice(0, end); break }
  }
  if (out.length <= max) return out
  const slice = out.slice(0, max + 1)
  const sp = slice.lastIndexOf(' ')
  return (sp > 60 ? slice.slice(0, sp) : out.slice(0, max)).replace(/[,;:–—-]+$/, '') + '…'
}

/**
 * Markdown for one section → typed content blocks.
 * Block kinds: head | paragraph | bullets | list | kv | risk | pair
 */
export function parseBlocks(md = '', sectionNum = null) {
  const src = withoutSectionTags(stripThinking(md))
    .replace(/^##\s*SECTION[^\n]*\n?/i, '')
    .replace(/^#{1,2}\s+[^\n]*\n?/, (m) => (/^#{1,2}\s*(profile snapshot|section)/i.test(m) ? '' : m))
  const lines = src.split('\n')
  const blocks = []
  const isRiskSection = sectionNum === 6
  const isPairSection = sectionNum === 13
  const isFeedSection = sectionNum === 1 || sectionNum === 10

  const pushPair = (attack, defense) => {
    const last = blocks[blocks.length - 1]
    if (last && last.kind === 'pair') last.pairs.push({ attack, defense })
    else blocks.push({ kind: 'pair', pairs: [{ attack, defense }] })
  }
  const pushFeedItem = (item) => {
    const last = blocks[blocks.length - 1]
    if (last && last.kind === 'list' && last.variant === 'feed') last.items.push(item)
    else blocks.push({ kind: 'list', variant: 'feed', items: [item] })
  }

  let i = 0
  while (i < lines.length) {
    const raw  = lines[i]
    const line = raw.trim()
    if (!line) { i++; continue }
    if (/^[-*_]{3,}$/.test(line)) { i++; continue }        // horizontal rule
    if (/^```/.test(line)) {                                // fenced block → prose
      i++
      const buf = []
      while (i < lines.length && !/^```/.test(lines[i].trim())) { buf.push(lines[i]); i++ }
      i++
      const text = buf.join(' ').trim()
      if (text) blocks.push({ kind: 'paragraph', text, marker: '' })
      continue
    }

    // ── Tables ───────────────────────────────────────────────────────────────
    if (isTableRow(line)) {
      const rows = []
      while (i < lines.length && isTableRow(lines[i])) {
        if (!isTableSep(lines[i])) rows.push(tableCells(lines[i]))
        i++
      }
      if (!rows.length) continue
      const header   = rows[0].map(c => plainText(c))
      const body     = rows.slice(1).filter(r => r.some(c => plainText(c)))
      const headText = header.join(' ').toLowerCase()
      const srcIdx   = header.findIndex(h => /^(source|src|sources|citation|cite)s?$/i.test(h))

      // Attack / response table → ATTACK / RESPOND rows
      if (/attack|charge|criticism/.test(headText) && /respon|defen|rebut|counter|answer/.test(headText) && header.length >= 2) {
        const ai = header.findIndex(h => /attack|charge|criticism/i.test(h))
        const ri = header.findIndex(h => /respon|defen|rebut|counter|answer/i.test(h))
        body.forEach(r => { if (r[ai] || r[ri]) pushPair(r[ai] || '', r[ri] || '') })
        continue
      }

      // Section 6's per-item table → risk entries, severity from its own column
      if (isRiskSection && header.length >= 3 && /issue|vulnerab|finding|item|matter|controvers|allegation/i.test(header[0]) && body.length) {
        const sumIdx  = header.findIndex(h => /summar|descrip|detail|what|context/i.test(h))
        const dateIdx = header.findIndex(h => /^(date|when|year)s?$/i.test(h))
        body.forEach(r => {
          const cells = r.map(c => (c || '').trim())
          const sevCell = cells.map(c => plainText(c).toUpperCase()).find(c => /^(HIGH|MEDIUM|MED|LOW)$/.test(c))
          const sev = severityIn(cells.join(' ')) || (sevCell ? (sevCell === 'MED' ? 'MEDIUM' : sevCell) : null)
          const rest = cells.filter((c, idx) => idx !== 0 && idx !== srcIdx && idx !== dateIdx && plainText(c).length > 24)
          const text = sumIdx > 0 && cells[sumIdx] ? cells[sumIdx] : rest.join(' ')
          const src  = [srcIdx >= 0 ? plainText(cells[srcIdx]) : '', dateIdx >= 0 ? plainText(cells[dateIdx]) : '']
            .filter(Boolean).join(' · ')
          if (!plainText(cells[0]) && !plainText(text)) return
          blocks.push({
            kind: 'risk',
            sev: sev || 'LOW',
            title: plainText(cells[0]),
            text: text || '',
            source: src,
            marker: markerFor(cells.join(' ')),
          })
        })
        continue
      }

      const useRows = body.length ? body : [header]
      const dateKeyed = /^(year|date|when|period|time)s?$/i.test(header[0] || '')

      // Two columns, or "label | value | source" — a key-value grid.
      if (!dateKeyed && (header.length === 2 || (header.length === 3 && srcIdx === 2))) {
        const rowsOut = useRows
          .map(r => ({ k: plainText(r[0]), v: (r[1] || '').trim(), src: srcIdx === 2 ? plainText(r[2]) : '' }))
          .filter(r => r.k && plainText(r.v))
        if (rowsOut.length) blocks.push({ kind: 'kv', rows: rowsOut })
        continue
      }

      // Everything else → label / value list, header labels kept with the values
      const items = useRows.map(r => {
        const parts = r.slice(1)
          .map((c, idx) => ({ label: header[idx + 1] || '', text: (c || '').trim(), idx: idx + 1 }))
          .filter(p => plainText(p.text) && p.idx !== srcIdx)
        const sub = srcIdx >= 1 ? plainText(r[srcIdx] || '') : ''
        // A single value column needs no label; two or more do, or the values
        // run together into something the reader can't tell apart.
        const v = parts.length === 1
          ? parts[0].text
          : parts.map(p => (p.label && !GENERIC_TH.test(p.label) ? `${p.label}: ${p.text}` : p.text)).join(' · ')
        return { k: plainText(r[0]), v, sub, marker: markerFor(r.join(' ')) }
      }).filter(r => r.k || r.v)
      if (items.length) blocks.push({ kind: 'list', items })
      continue
    }

    // ── Attack / respond pairs (section 13 and anywhere the labels appear) ────
    const atk = line.match(ATTACK_RE)
    if (atk && (isPairSection || RESPOND_RE.test((lines[i + 1] || '').trim()) || RESPOND_RE.test((lines[i + 2] || '').trim()))) {
      let j = i + 1, defense = ''
      let guard = 0
      while (j < lines.length && guard < 6) {
        const nxt = lines[j].trim()
        if (nxt) {
          guard++
          const r = nxt.match(RESPOND_RE)
          if (r) { defense = r[1].trim(); j++; break }
          if (ATTACK_RE.test(nxt) || /^#{1,6}\s/.test(nxt)) break
        }
        j++
      }
      pushPair(atk[1].trim(), defense)
      i = defense ? j : i + 1
      continue
    }

    // ── Headings ─────────────────────────────────────────────────────────────
    const head = line.match(/^(#{3,6})\s+(.*)$/)
    if (head) {
      const title = head[2].trim()

      // Sections 1 and 10 are feeds: "### [Title](url)" then "**Source** · Date"
      // then a one-line summary. They render as a dated label/value list.
      if (isFeedSection) {
        const link = title.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)\s*$/)
        let j = i + 1
        const body = []
        while (j < lines.length && !/^#{1,6}\s/.test(lines[j].trim()) && !isTableRow(lines[j])) {
          if (lines[j].trim()) body.push(lines[j].trim())
          j++
        }
        const srcLine = body[0] && body[0].match(/^\*\*([^*]+)\*\*\s*[·•|]\s*(.+)$/)
        if (srcLine) {
          const source  = plainText(srcLine[1])
          const date    = plainText(srcLine[2])
          const summary = body.slice(1).join(' ')
          pushFeedItem({
            k: date || source,
            v: link ? link[1] : plainText(title),
            href: link ? link[2] : '',
            sub: [date ? source : '', plainText(summary)].filter(Boolean).join(' — '),
            marker: markerFor(`${title} ${body.join(' ')}`),
          })
          i = j
          continue
        }
      }
      // Look ahead for the body of this heading (until the next heading).
      let j = i + 1
      const body = []
      while (j < lines.length && !/^#{1,6}\s/.test(lines[j].trim()) && !isTableRow(lines[j])) {
        if (lines[j].trim()) body.push(lines[j].trim())
        j++
      }
      const bodyText = body.join('\n')
      const sev = severityIn(title) || severityIn(bodyText)

      if (sev && (isRiskSection || severityIn(title))) {
        const srcLine = body.find(l => SOURCE_RE.test(l))
        const text = body.filter(l => l !== srcLine).join(' ')
        blocks.push({
          kind: 'risk', sev,
          title: plainText(title),
          text,
          source: srcLine ? plainText(srcLine.replace(/^\**\s*/, '')) : '',
          marker: markerFor(`${title} ${bodyText}`),
        })
        i = j
        continue
      }

      if (isPairSection && body.length) {
        const rl = body.find(l => RESPOND_RE.test(l))
        if (rl) {
          pushPair(plainText(title), rl.match(RESPOND_RE)[1].trim())
          const rest = body.filter(l => l !== rl && !RESPOND_RE.test(l))
          rest.forEach(l => blocks.push({ kind: 'paragraph', text: l, marker: markerFor(l) }))
          i = j
          continue
        }
      }

      blocks.push({ kind: 'head', text: plainText(title) })
      i++
      continue
    }

    // ── Bullet / numbered runs ───────────────────────────────────────────────
    if (BULLET_RE.test(line) || CHECKBOX_RE.test(line)) {
      const items = []
      const baseIndent = raw.match(/^\s*/)[0].length
      while (i < lines.length) {
        const l = lines[i].trim()
        if (!l) {
          // a single blank line inside a list is allowed; two end it
          if (!(lines[i + 1] || '').trim()) break
          i++
          continue
        }
        const cb = l.match(CHECKBOX_RE)
        const bl = l.match(BULLET_RE)
        if (!cb && !bl) break
        const text = (cb ? cb[2] : bl[2]).trim()
        // Nested bullet — belongs to the item above it, not beside it.
        const indent = lines[i].match(/^\s*/)[0].length
        if (indent > baseIndent + 1 && items.length) {
          const parent = items[items.length - 1]
          parent.children = parent.children || []
          parent.children.push(text)
          parent.marker = parent.marker || markerFor(text)
          i++
          continue
        }
        const sev  = severityIn(text)
        if (sev && isRiskSection) {
          const boldLead = text.match(/^\*\*(.+?)\*\*\s*[:\-–—]?\s*(.*)$/)
          blocks.push({
            kind: 'risk', sev,
            title: plainText(boldLead ? boldLead[1] : firstSentence(plainText(text), 70)),
            text: boldLead && boldLead[2] ? boldLead[2] : text,
            source: '',
            marker: markerFor(text),
          })
          i++
          continue
        }
        const kvp = cb
          ? { k: cb[1].toLowerCase() === 'x' ? 'Done' : 'Open', v: text }
          : splitKeyValue(text)
        // "**Strengths** (advantages this candidate has right now):" — the gloss
        // is prompt scaffolding, not content, when the bullet has children.
        if (kvp.k) kvp.v = kvp.v.replace(/^\((?:[^()]|\([^()]*\))*\)\s*:?\s*$/, '').trim()
        items.push({ ...kvp, raw: text, marker: markerFor(text) })
        i++
      }
      if (items.length) {
        const keyed = items.filter(it => it.k).length
        const nested = items.some(it => it.children?.length)
        if ((keyed && keyed >= Math.ceil(items.length / 2)) || nested) blocks.push({ kind: 'list', items })
        else blocks.push({ kind: 'bullets', items: items.map(it => ({ text: it.raw, marker: it.marker })) })
      }
      continue
    }

    // ── Severity-tagged prose line inside a risk section → risk entry ────────
    const sev = severityIn(line)
    if (sev && isRiskSection) {
      const boldLead = line.match(/^\*\*(.+?)\*\*\s*[:\-–—]?\s*(.*)$/)
      const srcNext  = (lines[i + 1] || '').trim()
      const hasSrc   = SOURCE_RE.test(srcNext)
      blocks.push({
        kind: 'risk', sev,
        title: plainText(boldLead ? boldLead[1] : firstSentence(plainText(line), 70)),
        text: boldLead && boldLead[2] ? boldLead[2] : line,
        source: hasSrc ? plainText(srcNext.replace(/^\**\s*/, '')) : '',
        marker: markerFor(line),
      })
      i += hasSrc ? 2 : 1
      continue
    }

    // ── A line that is entirely bold and ends in a colon is a sub-heading ────
    const boldHead = line.match(/^\*\*(.{2,80}?):?\*\*:?\s*$/)
    if (boldHead && !/[.!?]$/.test(line.replace(/\*/g, '').trim())) {
      blocks.push({ kind: 'head', text: plainText(boldHead[1]) })
      i++
      continue
    }

    // ── Paragraph ────────────────────────────────────────────────────────────
    blocks.push({ kind: 'paragraph', text: line, marker: markerFor(line) })
    i++
  }

  return blocks
}

function blockText(b) {
  switch (b.kind) {
    case 'paragraph': return b.text
    case 'head':      return b.text
    case 'bullets':   return b.items.map(it => it.text).join(' ')
    case 'list':      return b.items.map(it => `${it.k} ${it.v}`).join(' ')
    case 'kv':        return b.rows.map(r => `${r.k} ${r.v} ${r.src || ''}`).join(' ')
    case 'risk':      return `${b.title} ${b.text} ${b.source}`
    case 'pair':      return b.pairs.map(p => `${p.attack} ${p.defense}`).join(' ')
    default:          return ''
  }
}

function countItems(blocks) {
  let n = 0
  for (const b of blocks) {
    if (b.kind === 'list' || b.kind === 'bullets') n += b.items.length
    else if (b.kind === 'kv') n += b.rows.length
    else if (b.kind === 'risk') n += 1
    else if (b.kind === 'pair') n += b.pairs.length
  }
  return n
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + 's'}`

/**
 * Build the whole document model.
 *   sections: the filtered sections (from lib/profileContent.filterSections)
 * Returns { summary, sections[], flaggedTotal }
 */
export function buildReport(content = '', sections = []) {
  const { snapshot } = extractSnapshot(content)
  let summary = snapshot

  const out = []
  for (const s of sections) {
    const md  = s.displayContent || s.content || ''
    const num = /^section-(\d+)$/.test(s.id) ? Number(s.id.split('-')[1]) : null

    if (s.id === 'overview') {
      // Anything before SECTION 1 that survived the generator's leak guard is
      // the report's own summary — never a separate numbered section.
      if (!summary) {
        const text = plainText(md.replace(/^#{1,6}[^\n]*\n/, '')).trim()
        if (text.length > 40) summary = text
      }
      continue
    }

    let blocks = parseBlocks(md, num)
    const takeaway = deriveTakeaway(md)
    // Drop a leading block that is nothing more than the takeaway itself.
    if (takeaway && (blocks[0]?.kind === 'paragraph' || blocks[0]?.kind === 'head')) {
      const p = plainText(blocks[0].text)
      if (p === takeaway || (p.length <= takeaway.length + 2 && takeaway.startsWith(p))) blocks = blocks.slice(1)
    }

    const stats  = sourcingStats(md)
    const items  = countItems(blocks)
    const meta   = stats.total
      ? `${plural(stats.total, 'claim')}${stats.weak ? ` · ${stats.weak} to verify` : ''}`
      : items ? plural(items, 'item') : ''

    out.push({
      id:       s.id,
      num:      num != null ? String(num).padStart(2, '0') : '',
      index:    num,
      label:    (SECTION_META[num]?.label) || String(s.label || '').replace(/^\d+\s*/, ''),
      group:    groupOf(s.id),
      rank:     SECTION_RANK[s.id] ?? 400,
      meta,
      takeaway,
      blocks,
      unverified: stats.weak > 0,
      content:  s.content,
      displayContent: s.displayContent,
      isEmptySection: !!s.isEmptySection,
    })
  }

  out.sort((a, b) => a.rank - b.rank)
  return { summary, sections: out }
}

/** Reduce a built section list to only the blocks carrying unverified claims. */
export function filterToUnverified(sections) {
  const kept = []
  for (const s of sections) {
    if (!s.unverified) continue
    const blocks = []
    for (const b of s.blocks) {
      if (b.kind === 'list' || b.kind === 'bullets') {
        const items = b.items.filter(it => it.marker || hasWeakClaim(it.raw || it.text || `${it.k} ${it.v}`))
        if (items.length) blocks.push({ ...b, items })
      } else if (b.kind === 'kv') {
        const rows = b.rows.filter(r => hasWeakClaim(`${r.k} ${r.v} ${r.src || ''}`))
        if (rows.length) blocks.push({ ...b, rows })
      } else if (b.marker || hasWeakClaim(blockText(b))) {
        blocks.push(b)
      }
    }
    kept.push({ ...s, blocks })
  }
  return kept
}

// ─── Print document ──────────────────────────────────────────────────────────
// Rebuilt against the new markup: one neutral document, the same takeaways and
// typed blocks the reader shows. No per-section colour themes.
export function buildPrintHtml(dossier, report) {
  const candidate  = dossier?.candidate || {}
  const title      = dossier?.title || `Candidate Intelligence Profile — ${candidate.name || 'Profile'}`
  const officeName = candidate.office?.name || candidate.offices?.name || ''
  const district   = candidate.office?.district_name || candidate.offices?.district_name || ''
  const generated  = dossier?.generated_at ? new Date(dossier.generated_at) : null
  const generatedAt = generated && !Number.isNaN(+generated)
    ? generated.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
    : ''

  const P = (b) => `<p class="p">${inlineHtml(b.text)}${b.marker
    ? `<span class="mark">${escapeHtml(b.marker)}</span>` : ''}</p>`

  const blockHtml = (b) => {
    switch (b.kind) {
      case 'head':      return `<h3 class="h3">${escapeHtml(b.text)}</h3>`
      case 'paragraph': return P(b)
      case 'bullets':
        return `<ul class="ul">${b.items.map(it =>
          `<li>${inlineHtml(it.text)}${it.marker ? `<span class="mark">${escapeHtml(it.marker)}</span>` : ''}</li>`).join('')}</ul>`
      case 'list':
        return `<table class="lv">${b.items.map(it => {
          const value = it.href
            ? `<a href="${escapeHtml(it.href)}">${inlineHtml(it.v || it.raw || '')}</a>`
            : inlineHtml(it.v || it.raw || '')
          const sub = it.sub ? `<div class="src">${inlineHtml(it.sub)}</div>` : ''
          const kids = it.children?.length
            ? `<ul class="ul">${it.children.map(c => `<li>${inlineHtml(c)}</li>`).join('')}</ul>` : ''
          return `<tr><th>${escapeHtml(it.k)}</th><td>${value}${it.marker
            ? `<span class="mark">${escapeHtml(it.marker)}</span>` : ''}${sub}${kids}</td></tr>`
        }).join('')}</table>`
      case 'kv':
        return `<table class="kv">${b.rows.map(r =>
          `<tr><th>${escapeHtml(r.k)}</th><td>${inlineHtml(r.v)}${r.src
            ? `<div class="src">${escapeHtml(r.src)}</div>` : ''}</td></tr>`).join('')}</table>`
      case 'risk':
        return `<div class="risk sev-${escapeHtml(String(b.sev || '').toLowerCase())}">
            <div class="risk-h"><span class="sev">${escapeHtml(b.sev || '')}</span> ${escapeHtml(b.title)}</div>
            <div class="p">${inlineHtml(b.text)}</div>
            ${b.source ? `<div class="src">${escapeHtml(b.source)}</div>` : ''}
          </div>`
      case 'pair':
        return b.pairs.map(p => `<div class="pair">
            <div><span class="lbl atk">ATTACK</span>${inlineHtml(p.attack)}</div>
            ${p.defense ? `<div><span class="lbl def">RESPOND</span>${inlineHtml(p.defense)}</div>` : ''}
          </div>`).join('')
      default: return ''
    }
  }

  const sectionsHtml = (report?.sections || []).map(s => `
    <section class="sec">
      <div class="sec-h">
        <span class="num">${escapeHtml(s.num)}</span>
        <span class="title">${escapeHtml(s.label)}</span>
        <span class="grp">${escapeHtml(s.group)}</span>
        ${s.meta ? `<span class="meta">${escapeHtml(s.meta)}</span>` : ''}
      </div>
      ${s.takeaway ? `<div class="take"><div class="take-l">TAKEAWAY</div><div class="take-t">${escapeHtml(s.takeaway)}</div></div>` : ''}
      ${s.blocks.map(blockHtml).join('')}
    </section>`).join('')

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)}</title>
  <style>
    @page { margin: 0.9in; }
    * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; box-sizing: border-box; }
    body { font-family: Georgia, 'Times New Roman', serif; font-size: 10.5pt; line-height: 1.55; color: #18181B; margin: 0; }
    .doc-h { border-bottom: 2px solid #18181B; padding-bottom: 14px; margin-bottom: 22px; }
    .eyebrow { font-family: Arial, sans-serif; font-size: 7.5pt; font-weight: 700; letter-spacing: .14em; color: #52525B; }
    h1 { font-size: 20pt; margin: 6px 0 6px; letter-spacing: -.01em; }
    .doc-m { font-family: Arial, sans-serif; font-size: 8.5pt; color: #52525B; }
    .summary { margin-bottom: 24px; }
    .summary .lbl { font-family: Arial, sans-serif; font-size: 7.5pt; font-weight: 700; letter-spacing: .12em; color: #52525B; margin-bottom: 6px; }
    .summary .t { font-size: 12pt; line-height: 1.55; }
    .sec { page-break-inside: avoid; margin-bottom: 22px; padding-bottom: 16px; border-bottom: 1px solid #E4E4E1; }
    .sec-h { font-family: Arial, sans-serif; margin-bottom: 10px; }
    .sec-h .num { font-size: 9pt; font-weight: 700; color: #52525B; margin-right: 8px; }
    .sec-h .title { font-size: 13pt; font-weight: 700; }
    .sec-h .grp { font-size: 7.5pt; font-weight: 700; letter-spacing: .08em; color: #52525B; margin-left: 8px; }
    .sec-h .meta { font-size: 8pt; color: #52525B; margin-left: 8px; }
    .take { border-left: 2px solid #18181B; padding-left: 12px; margin: 0 0 12px; }
    .take-l { font-family: Arial, sans-serif; font-size: 7.5pt; font-weight: 700; letter-spacing: .11em; color: #52525B; }
    .take-t { font-size: 10.5pt; font-weight: 700; margin-top: 3px; }
    .p { margin: 0 0 9px; color: #27272A; }
    .h3 { font-family: Arial, sans-serif; font-size: 9.5pt; font-weight: 700; margin: 12px 0 5px; }
    .ul { margin: 0 0 10px 16px; padding: 0; }
    .ul li { margin: 0 0 4px; }
    .lv, .kv { width: 100%; border-collapse: collapse; margin: 0 0 12px; }
    .lv th, .kv th { text-align: left; vertical-align: top; font-family: Arial, sans-serif; font-size: 8.5pt; color: #3F3F46; width: 26%; padding: 4px 10px 4px 0; }
    .lv td, .kv td { vertical-align: top; padding: 4px 0; }
    .kv tr { border-bottom: 1px solid #F0EFEC; }
    .mark { font-family: Arial, sans-serif; font-size: 7pt; font-weight: 700; letter-spacing: .08em; color: #B45309; margin-left: 7px; white-space: nowrap; }
    .risk { border-left: 2px solid #71717A; padding-left: 12px; margin: 0 0 12px; }
    .risk.sev-high { border-left-color: #B91C1C; }
    .risk.sev-medium { border-left-color: #C2410C; }
    .risk-h { font-family: Arial, sans-serif; font-size: 10pt; font-weight: 700; margin-bottom: 3px; }
    .risk .sev { font-size: 7.5pt; letter-spacing: .08em; color: #B91C1C; margin-right: 6px; }
    .risk.sev-medium .sev { color: #C2410C; }
    .risk.sev-low .sev { color: #71717A; }
    .src { font-family: Arial, sans-serif; font-size: 8pt; color: #52525B; margin-top: 4px; }
    .pair { padding: 8px 0; border-top: 1px solid #F0EFEC; }
    .pair .lbl { font-family: Arial, sans-serif; font-size: 7.5pt; font-weight: 700; letter-spacing: .08em; display: inline-block; width: 62px; }
    .pair .atk { color: #B91C1C; }
    .pair .def { color: #15803D; }
    .footer { border-top: 1px solid #D6D6D2; margin-top: 26px; padding-top: 10px; font-family: Arial, sans-serif; font-size: 8pt; color: #52525B; }
  </style>
</head>
<body>
  <div class="doc-h">
    <div class="eyebrow">CANDIDATE INTELLIGENCE PROFILE</div>
    <h1>${escapeHtml(candidate.name || dossier?.title || 'Profile')}</h1>
    <div class="doc-m">${[
      officeName && district ? `${escapeHtml(officeName)} — ${escapeHtml(district)}` : escapeHtml(officeName),
      escapeHtml(candidate.party || ''),
      generatedAt ? `Generated ${escapeHtml(generatedAt)}` : '',
      `${(report?.sections || []).length} sections`,
    ].filter(Boolean).join(' · ')}</div>
  </div>
  ${report?.summary ? `<div class="summary"><div class="lbl">SUMMARY</div><div class="t">${escapeHtml(report.summary)}</div></div>` : ''}
  ${sectionsHtml}
  <div class="footer">
    Badger Board · AI-generated political intelligence · The Bluejack Group.
    Verify all information through official sources before use.
  </div>
</body>
</html>`
}
