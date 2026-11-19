// candidate/intelModel.js — the candidate profile page's reading of a dossier,
// as data. No React and no imports, so tests/candidate-profile.test.mjs can
// load it straight into node.
//
// Everything here is extraction, never invention. The Profiler (v5 prompt in
// netlify/functions/_profile-prompt.js) writes a markdown report with fixed
// "## SECTION n: TITLE" headers; this module lifts the parts the profile page
// shows as cards:
//
//   PROFILE SNAPSHOT  → profileSnapshot()        (Overview "Who they are")
//   Section 1 / 10    → parseFeedItems()         (news + X posts from the profile)
//   Section 4         → parseRaceHistory(), parseOfficeRecord()
//   Section 6         → parseControversies()     (Attack & defense → controversies)
//   Section 11        → findXHandle()            (the X account the profile found)
//   Section 12        → parseProfileSwot()       (the SWOT bullets the profile wrote)
//   Section 13        → parseAttackDefense()     (attack line + evidence + defense)
//
// Why this exists: the old Opposition view read `candidates.weaknesses`, a
// column NOTHING in the pipeline writes (it was added in supabase/
// migration_v2.sql:10 and never populated), so "Key weaknesses (0)" showed on
// every candidate while the SWOT on the same page listed several. The page
// now reads the fields the v5 pipeline really produces.

// ─── Small text helpers ──────────────────────────────────────────────────────

const BADGE_RE = /\*{0,2}\[(KNOWN|CONFIRMED|LIKELY|VERIFY|RESEARCH[ _]REQUIRED|UNCONFIRMED|X\/LIVE|WEB\/LIVE|HIGH|MEDIUM|MED|LOW)\]\*{0,2}/gi

/** The confidence badges carried by a string, normalized ('KNOWN', 'VERIFY', …). */
export function badgesOf(text) {
  const out = []
  for (const m of String(text ?? '').matchAll(BADGE_RE)) {
    const b = m[1].toUpperCase().replace('_', ' ')
    if (!out.includes(b)) out.push(b)
  }
  return out
}

/** Markdown + badge tokens stripped to plain readable text. */
export function plain(text) {
  return String(text ?? '')
    .replace(BADGE_RE, ' ')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '$1')
    .replace(/\*\*|__|`/g, '')
    .replace(/(^|\s)\*(\S[^*]*?)\*(?=\s|$|[.,;:])/g, '$1$2')
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,;:])/g, '$1')
    .trim()
}

/** True for cells/lines that carry nothing: blanks, dashes, NOT FOUND, N/A, unfilled [tokens]. */
export function isEmptyCell(text) {
  const s = plain(String(text ?? '').replace(/\[[^\]]*\]/g, ' '))
  if (!s) return true
  return /^(?:[-–—•·|]+|n\/?a|none|not found|unknown|tbd|null|—)$/i.test(s)
}

const firstUrl = (text) => (String(text ?? '').match(/https?:\/\/[^\s)<>\]"'`|]+/) || [null])[0]

// ─── Sections ────────────────────────────────────────────────────────────────

/** "## SECTION n" bodies (header line removed), keyed by section number. */
export function splitSections(content) {
  const map = {}
  const s = String(content || '')
  const re = /^##\s*SECTION\s*(\d+)[^\n]*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/gim
  let m
  while ((m = re.exec(s)) !== null) {
    const n = Number(m[1])
    if (!(n in map)) map[n] = m[2]
  }
  return map
}

/** One section's body without its "**[HIGH]**" confidence line, or '' when absent. */
export function sectionBody(content, n) {
  const body = splitSections(content)[n]
  if (!body) return ''
  return body.replace(/^\s*\*\*\[[A-Za-z _/]+\]\*\*[ \t]*\n/, '').trim()
}

/**
 * A section the writer was told to leave as an upsell template (Sections 6 and
 * 13 on plans without opposition research) — it has no findings to show.
 */
export function isUpsellTemplate(body) {
  return /available to Campaign (?:&|and) Agency plan subscribers|RESEARCH FRAMEWORK/i.test(String(body || ''))
}

// ─── Snapshot ────────────────────────────────────────────────────────────────

/**
 * The profile's own 2–3 sentence portrait ("## PROFILE SNAPSHOT"). v5 writes
 * it first; some earlier runs appended it after Section 14. When a profile has
 * none, the first real narrative paragraph of Section 2 stands in. No AI call:
 * the Overview used to fire generate-bio-summary on every open and sat on
 * "Generating…" whenever that call stalled.
 */
export function profileSnapshot(content) {
  const s = String(content || '')
  const m = s.match(/^##\s*PROFILE SNAPSHOT[^\n]*\n([\s\S]*?)(?=^##\s|^CANDIDATE_UPDATES|^---\s*$|(?![\s\S]))/im)
  if (m) {
    const text = plain(m[1].replace(/\n+/g, ' '))
    if (text && !/^\(2[–-]3 sentences/i.test(text)) return text
  }
  const bio = sectionBody(s, 2)
  for (const raw of bio.split(/\n{2,}/)) {
    const para = raw.trim()
    if (!para || para.startsWith('|') || para.startsWith('#') || /^[-*]\s/.test(para)) continue
    if (/^identity lock|^legal name/i.test(plain(para))) continue
    const text = plain(para.replace(/\n+/g, ' '))
    if (text.length >= 80) return text
  }
  return ''
}

// ─── Markdown tables ─────────────────────────────────────────────────────────

const isRow = (l) => l.trim().startsWith('|')
const isSep = (l) => /^\|[\s\-:|]+\|$/.test(l.trim())
const cellsOf = (l) => l.trim().split('|').slice(1, -1).map(c => c.trim())

/**
 * Every GitHub-style table in a block of markdown, with the nearest non-empty
 * line above it as `label` (e.g. "**Attack angles (for opponents):**").
 */
export function parseTables(text) {
  const lines = String(text || '').split('\n')
  const tables = []
  let i = 0
  let lastLabel = ''
  while (i < lines.length) {
    const line = lines[i]
    if (isRow(line) && i + 1 < lines.length && isSep(lines[i + 1])) {
      const header = cellsOf(line).map(h => plain(h).toLowerCase())
      const rows = []
      let j = i + 2
      while (j < lines.length && isRow(lines[j])) {
        if (!isSep(lines[j])) rows.push(cellsOf(lines[j]))
        j++
      }
      tables.push({ label: lastLabel, header, rows })
      i = j
      continue
    }
    if (line.trim()) lastLabel = line.trim()
    i++
  }
  return tables
}

/** Index of the first header cell matching any of the patterns, or -1. */
function col(header, ...patterns) {
  for (const p of patterns) {
    const i = header.findIndex(h => p.test(h))
    if (i >= 0) return i
  }
  return -1
}

const cell = (row, i) => (i >= 0 && i < row.length ? row[i] : '')

// ─── Section 6: controversies ────────────────────────────────────────────────

const PRIORITY_RE = /RESEARCH PRIORITY:?\s*(HIGH|MEDIUM|LOW)/i

/**
 * Section 6 rows as cards: issue, date, what the record shows, source, their
 * response, status and research priority. Bold-labelled paragraphs under the
 * table ("**INCONSISTENCIES IN PUBLIC RECORD:** …") become cards too, unless
 * they only report an absence ("No violations found").
 */
export function parseControversies(content) {
  const body = sectionBody(content, 6)
  if (!body || isUpsellTemplate(body)) return []
  const out = []
  for (const t of parseTables(body)) {
    const h = t.header
    const iIssue = col(h, /issue|matter|item|topic|controvers/)
    if (iIssue < 0) continue
    const iDate = col(h, /date|year|when/)
    const iSum = col(h, /record shows|summary|detail|descri|what/)
    const iSrc = col(h, /source|src|citation/)
    const iResp = col(h, /response/)
    const iStatus = col(h, /status/)
    const iPri = col(h, /priority/)
    const iConf = col(h, /confidence/)
    for (const r of t.rows) {
      const issue = plain(cell(r, iIssue))
      if (!issue || isEmptyCell(issue) || /^issue$/i.test(issue)) continue
      const statusRaw = cell(r, iStatus)
      const priRaw = `${cell(r, iPri)} ${statusRaw}`
      const pri = (priRaw.match(PRIORITY_RE) || priRaw.match(/^\s*(HIGH|MEDIUM|LOW)\b/i) || [])[1]
      const status = plain(statusRaw.replace(PRIORITY_RE, '')).replace(/^[\s,;·-]+|[\s,;·-]+$/g, '')
      out.push({
        issue,
        date: isEmptyCell(cell(r, iDate)) ? '' : plain(cell(r, iDate)),
        summary: isEmptyCell(cell(r, iSum)) ? '' : plain(cell(r, iSum)),
        source: isEmptyCell(cell(r, iSrc)) ? '' : plain(cell(r, iSrc)),
        url: firstUrl(cell(r, iSrc)) || firstUrl(cell(r, iSum)),
        response: isEmptyCell(cell(r, iResp)) || /^none( sought)?$/i.test(plain(cell(r, iResp))) ? '' : plain(cell(r, iResp)),
        status: isEmptyCell(status) ? '' : status,
        priority: pri ? pri.toUpperCase() : '',
        confidence: badgesOf(`${cell(r, iConf)} ${cell(r, iSum)}`)[0] || '',
      })
    }
  }
  for (const line of body.split('\n')) {
    const m = line.trim().match(/^\*\*([A-Z][A-Z0-9 &/,'-]{3,60}):\*\*\s*(.+)$/)
    if (!m) continue
    const text = m[2]
    if (/^\s*(no|none|nothing)\b/i.test(plain(text))) continue
    const pri = (text.match(PRIORITY_RE) || [])[1]
    const label = m[1].toLowerCase().replace(/(^|[\s/&-])([a-z])/g, (_, a, b) => a + b.toUpperCase())
    out.push({
      issue: label,
      date: '',
      summary: plain(text.replace(PRIORITY_RE, '')).replace(/\s*[—–-]\s*\.?\s*$/, '').trim(),
      source: '',
      url: firstUrl(text),
      response: '',
      status: '',
      priority: pri ? pri.toUpperCase() : '',
      confidence: badgesOf(text)[0] || '',
    })
  }
  const rank = { HIGH: 0, MEDIUM: 1, LOW: 2, '': 3 }
  return out.map((c, i) => ({ ...c, _i: i }))
    .sort((a, b) => (rank[a.priority] - rank[b.priority]) || (a._i - b._i))
    .map(({ _i, ...c }) => c)
}

// ─── Section 13: attack & defense ────────────────────────────────────────────

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are', 'only', 'about', 'cares', 'their', 'his', 'her', 'this', 'that'])
const words = (s) => new Set(plain(s).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 2 && !STOP.has(w)))
function overlap(a, b) {
  const A = words(a), B = words(b)
  let n = 0
  for (const w of A) if (B.has(w)) n++
  return n
}

const unquote = (s) => {
  const t = plain(s)
  const q = t.match(/^["“'‘](.*)["”'’]$/)
  return (q ? q[1] : t.replace(/^["“”]+|["“”]+$/g, '')).trim()
}

/**
 * Section 13's two tables — attack angles and defense prep — joined into one
 * card per attack: the line an opponent would use (its "framing"), the
 * evidence behind it, and the prepared defense. Tables arrive in the same
 * strongest-first order, so equal-length tables pair by position; otherwise
 * each attack takes the defense that shares the most words with it.
 * Legacy "Attack: … / Response: …" lines are read too.
 */
export function parseAttackDefense(content) {
  const body = sectionBody(content, 13)
  if (!body || isUpsellTemplate(body)) return []
  const attacks = []
  const defenses = []
  for (const t of parseTables(body)) {
    const h = t.header
    const label = t.label.toLowerCase()
    const isDefense = /defen|prep|response/.test(label) || (col(h, /response|truth|context|rebut/) >= 0 && col(h, /vulnerab|framing/) < 0)
    if (isDefense) {
      const iAtk = col(h, /attack|charge|criticism|vulnerab/)
      const iCtx = col(h, /truth|context|fact/)
      const iResp = col(h, /response|rebut|answer|counter/)
      const iSrc = col(h, /source|src/)
      for (const r of t.rows) {
        const attack = unquote(cell(r, iAtk))
        if (!attack || isEmptyCell(attack)) continue
        defenses.push({ attack, context: plain(cell(r, iCtx)), response: plain(cell(r, iResp)), source: plain(cell(r, iSrc)), url: firstUrl(cell(r, iSrc)) })
      }
    } else {
      const iVul = col(h, /vulnerab|weakness|issue|angle|attack/)
      if (iVul < 0) continue
      const iEv = col(h, /evidence|record|basis|fact/)
      const iFr = col(h, /framing|line|message|they.?ll say/)
      const iSrc = col(h, /source|src/)
      for (const r of t.rows) {
        const vulnerability = plain(cell(r, iVul))
        if (!vulnerability || isEmptyCell(vulnerability)) continue
        attacks.push({ vulnerability, evidence: plain(cell(r, iEv)), line: unquote(cell(r, iFr)), source: plain(cell(r, iSrc)), url: firstUrl(`${cell(r, iSrc)} ${cell(r, iEv)}`), confidence: badgesOf(r.join(' '))[0] || '' })
      }
    }
  }
  // Legacy prose pairs.
  if (!attacks.length && !defenses.length) {
    const lines = body.split('\n').map(l => l.trim())
    for (let i = 0; i < lines.length; i++) {
      const a = lines[i].match(/^(?:[-*]\s*)?\**\s*(?:attack|line of attack|charge|criticism)\s*\d*\s*\**\s*[:–—-]\s*(.+)$/i)
      if (!a) continue
      let resp = ''
      for (let j = i + 1; j < Math.min(lines.length, i + 5); j++) {
        const r = lines[j].match(/^(?:[-*]\s*)?\**\s*(?:respond|response|reply|defen[cs]e|rebuttal|counter)\s*\d*\s*\**\s*[:–—-]\s*(.+)$/i)
        if (r) { resp = r[1]; break }
      }
      attacks.push({ vulnerability: plain(a[1]), evidence: '', line: '', source: '', url: firstUrl(a[1]), confidence: badgesOf(a[1])[0] || '' })
      if (resp) defenses.push({ attack: plain(a[1]), context: '', response: plain(resp), source: '', url: firstUrl(resp), _for: attacks.length - 1 })
    }
  }

  const used = new Set()
  const samePositions = attacks.length === defenses.length
  const pairs = attacks.map((a, i) => {
    let d = null
    const legacy = defenses.findIndex(x => x._for === i)
    if (legacy >= 0) { d = defenses[legacy]; used.add(legacy) }
    else if (samePositions && !used.has(i)) { d = defenses[i]; used.add(i) }
    else {
      let best = -1, score = 0
      defenses.forEach((x, k) => {
        if (used.has(k)) return
        const s = overlap(`${a.vulnerability} ${a.line} ${a.evidence}`, `${x.attack} ${x.context}`)
        if (s > score) { score = s; best = k }
      })
      if (best < 0 && !used.has(i) && defenses[i]) best = i
      if (best >= 0) { d = defenses[best]; used.add(best) }
    }
    return {
      title: a.vulnerability,
      line: a.line || a.vulnerability,
      evidence: a.evidence,
      source: a.source,
      url: a.url,
      confidence: a.confidence,
      defense: d ? { attack: d.attack, context: d.context, response: d.response, source: d.source, url: d.url } : null,
    }
  })
  defenses.forEach((d, k) => {
    if (used.has(k)) return
    pairs.push({ title: d.attack, line: d.attack, evidence: '', source: '', url: null, confidence: '', defense: { attack: d.attack, context: d.context, response: d.response, source: d.source, url: d.url } })
  })
  return pairs
}

// ─── Section 12: the profile's own SWOT ──────────────────────────────────────

export const QUADRANT_KEYS = ['strengths', 'weaknesses', 'opportunities', 'threats']
const QUAD_RE = /^(?:[-*•]\s*)?(?:#{2,5}\s*)?\**\s*(strengths?|weakness(?:es)?|opportunit(?:y|ies)|threats?)\b\**\s*(?:\([^)]*\))?\s*:?\**\s*(.*)$/i
const quadKey = (w) => {
  const s = w.toLowerCase()
  if (s.startsWith('strength')) return 'strengths'
  if (s.startsWith('weakness')) return 'weaknesses'
  if (s.startsWith('opportunit')) return 'opportunities'
  return 'threats'
}

/**
 * The SWOT bullets the profile itself wrote (Section 12, "**SWOT Analysis**"),
 * as { strengths: [{ point, confidence }], … }. Unfilled "[bullet]" template
 * lines are dropped.
 */
export function parseProfileSwot(content) {
  const out = { strengths: [], weaknesses: [], opportunities: [], threats: [] }
  const s12 = sectionBody(content, 12)
  const at = s12.search(/SWOT/i)
  const text = at >= 0 ? s12.slice(at) : ''
  if (!text) return out
  let cur = null
  for (const raw of text.split('\n').slice(1)) {
    const line = raw.trim()
    if (!line) continue
    if (/^##\s/.test(line)) break
    const q = line.match(QUAD_RE)
    if (q) {
      cur = quadKey(q[1])
      const rest = plain(q[2] || '')
      if (rest && rest.length > 3 && !/^\[?bullet\]?$/i.test(rest)) out[cur].push({ point: rest, confidence: badgesOf(q[2])[0] || '' })
      continue
    }
    const b = line.match(/^[-*•]\s+(.+)$/) || line.match(/^\d+[.)]\s+(.+)$/)
    if (cur && b) {
      const point = plain(b[1])
      if (!point || /^\[?bullet\]?$/i.test(point) || isEmptyCell(point)) continue
      out[cur].push({ point, confidence: badgesOf(b[1])[0] || '' })
    }
  }
  return out
}

// ─── SWOT shapes (candidates.swot_data) ──────────────────────────────────────

/** Split a legacy SWOT quadrant (string with • / newlines, or array) into points. */
export function legacyPoints(value) {
  const entries = Array.isArray(value) ? value : [value]
  const out = []
  for (const entry of entries) {
    if (entry === null || entry === undefined) continue
    if (Array.isArray(entry)) { out.push(...legacyPoints(entry)); continue }
    if (typeof entry === 'object') { if (entry.point) out.push(String(entry.point)); continue }
    for (const part of String(entry).split(/\r?\n|•/)) {
      const point = part.replace(/^\s*[-*]\s*/, '').replace(/^[\s,;]+|[\s,;]+$/g, '').trim()
      if (point) out.push(point)
    }
  }
  return out
}

const clampImpact = (n) => {
  const v = Math.round(Number(n))
  return Number.isFinite(v) ? Math.min(5, Math.max(1, v)) : null
}

/**
 * Any stored SWOT (v2 objects from research-swot, the older bullet strings,
 * or arrays) → { v, perspective, generated_at, bottom_line, strengths: [{
 * point, evidence, source, impact, play }], … } with each quadrant ranked by
 * impact (highest first; unranked legacy points keep their order).
 */
export function normalizeSwot(data) {
  const out = { v: 1, perspective: null, generated_at: null, bottom_line: '', strengths: [], weaknesses: [], opportunities: [], threats: [] }
  if (!data || typeof data !== 'object') return out
  if (data.v === 2) {
    out.v = 2
    out.perspective = data.perspective === 'self' || data.perspective === 'opponent' ? data.perspective : null
    out.generated_at = data.generated_at || null
    out.bottom_line = typeof data.bottom_line === 'string' ? data.bottom_line : ''
  }
  for (const k of QUADRANT_KEYS) {
    const raw = data[k]
    const items = []
    if (Array.isArray(raw) && raw.some(x => x && typeof x === 'object' && !Array.isArray(x))) {
      for (const x of raw) {
        if (!x) continue
        if (typeof x === 'string') { legacyPoints(x).forEach(p => items.push({ point: p, evidence: '', source: '', impact: null, play: '' })); continue }
        const point = String(x.point || '').trim()
        if (!point) continue
        items.push({
          point,
          evidence: String(x.evidence || '').trim(),
          source: String(x.source || '').trim(),
          impact: clampImpact(x.impact),
          play: String(x.play || '').trim(),
        })
      }
    } else {
      legacyPoints(raw).forEach(p => items.push({ point: p, evidence: '', source: '', impact: null, play: '' }))
    }
    out[k] = items.map((x, i) => ({ ...x, _i: i }))
      .sort((a, b) => ((b.impact ?? 0) - (a.impact ?? 0)) || (a._i - b._i))
      .map(({ _i, ...x }) => x)
  }
  return out
}

/** True when a normalized SWOT has at least one point. */
export const swotHasPoints = (swot) => QUADRANT_KEYS.some(k => (swot?.[k] || []).length > 0)

/**
 * The SWOT the page shows: the stored one when it has points, otherwise the
 * profile's own Section 12 bullets. `from` says which.
 */
export function effectiveSwot(swotData, content) {
  const stored = normalizeSwot(swotData)
  if (swotHasPoints(stored)) return { ...stored, from: 'stored' }
  const p = parseProfileSwot(content)
  const conv = normalizeSwot(Object.fromEntries(QUADRANT_KEYS.map(k => [k, p[k].map(x => ({ point: x.point }))])))
  return { ...conv, from: swotHasPoints(conv) ? 'profile' : 'none' }
}

// ─── Feeds: Sections 1 and 10 ────────────────────────────────────────────────

/**
 * "### [Title](url)" + "**Source** · date" + summary items, as written in the
 * profile's feed sections. Coverage-gap notes and NOT FOUND rows are skipped.
 */
export function parseFeedItems(text) {
  const lines = String(text || '').split('\n')
  const items = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line.startsWith('### ')) continue
    const head = line.slice(4).trim()
    const link = head.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/)
    const title = plain(link ? link[1] : head)
    if (!title || title.length < 3 || /coverage gaps|^not found/i.test(title) || /^\[RESEARCH REQUIRED\]/i.test(head)) continue
    let source = '', date = '', j = i + 1
    while (j < lines.length && !lines[j].trim()) j++
    const meta = (lines[j] || '').trim().match(/^\*\*([^*]+)\*\*\s*[·•|–-]\s*(.+)$/)
    if (meta) { source = plain(meta[1]); date = plain(meta[2]).replace(/\(page date\)/i, '').trim(); j++ }
    const desc = []
    while (j < lines.length) {
      const d = lines[j].trim()
      if (d.startsWith('#') || d.startsWith('---')) break
      if (!d) { if (desc.length) break; j++; continue }
      desc.push(d)
      j++
    }
    const joined = desc.join(' ')
    const flag = ((joined.match(/Flag:\s*([A-Za-z ]+)/) || [])[1] || '').trim()
    const summaryRaw = joined.replace(/\s*Flag:\s*[^.*[]*\.?/gi, ' ')
    const sentiment = (summaryRaw.match(/Sentiment:\s*([+−~-])/) || [])[1] || ''
    items.push({
      title,
      url: link ? link[2] : null,
      source,
      date,
      summary: plain(summaryRaw.replace(/Sentiment:\s*[+−~-]\.?\s*/g, '')),
      confidence: badgesOf(summaryRaw)[0] || '',
      sentiment,
      flag: /^none$/i.test(flag) ? '' : flag,
    })
    i = j - 1
  }
  return items
}

/** News items from Section 1 of the profile. */
export const profileNews = (content) => parseFeedItems(sectionBody(content, 1))

const X_STATUS_RE = /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d{5,25})/i

/** Section 10 / Section 1 items that link to an X post, shaped like live feed posts. */
export function profileXPosts(content) {
  const items = [...parseFeedItems(sectionBody(content, 10)), ...parseFeedItems(sectionBody(content, 1))]
  const seen = new Set()
  const out = []
  for (const it of items) {
    const m = String(it.url || '').match(X_STATUS_RE)
    if (!m || seen.has(m[2])) continue
    seen.add(m[2])
    out.push({
      id: m[2],
      url: `https://x.com/${m[1]}/status/${m[2]}`,
      author_name: (it.source || '').replace(/^(?:x|twitter)\s*[/·|-]\s*/i, '').trim() || `@${m[1]}`,
      author_username: m[1],
      created_at: it.date || null,
      text: [it.title, it.summary].filter(Boolean).join(' — ').replace(/\.{2,}/g, '.'),
      from: 'profile',
    })
  }
  return out
}

const NOT_HANDLES = new Set(['search', 'home', 'i', 'intent', 'share', 'hashtag', 'explore', 'settings', 'login'])

/** A clean X handle (no @), or '' when the input isn't one. */
export function cleanHandle(value) {
  const s = String(value || '').trim()
  const fromUrl = s.match(/(?:x|twitter)\.com\/@?([A-Za-z0-9_]{1,15})(?:[/?#]|$)/i)
  const h = fromUrl ? fromUrl[1] : (s.replace(/^@/, '').match(/^[A-Za-z0-9_]{1,15}$/) || [''])[0]
  return h && !NOT_HANDLES.has(h.toLowerCase()) ? h : ''
}

/**
 * The candidate's X account: the handle on the record, else the one the
 * profile found (Section 11's X row, then x.com links in Section 10).
 */
export function findXHandle(candidate, content) {
  const own = cleanHandle(candidate?.twitter_handle)
  if (own) return own
  for (const t of parseTables(sectionBody(content, 11))) {
    const iP = col(t.header, /platform|site|network/)
    const iH = col(t.header, /handle|url|account/)
    if (iP < 0 || iH < 0) continue
    for (const r of t.rows) {
      if (!/^(x|twitter|x\s*\/\s*twitter)\b/i.test(plain(cell(r, iP)))) continue
      const raw = cell(r, iH)
      const at = raw.match(/@([A-Za-z0-9_]{1,15})\b/)
      const h = at ? cleanHandle(at[1]) : cleanHandle(plain(raw))
      if (h) return h
    }
  }
  for (const it of parseFeedItems(sectionBody(content, 10))) {
    const m = String(it.url || '').match(X_STATUS_RE)
    if (m && cleanHandle(m[1])) return m[1]
  }
  return ''
}

// ─── Section 4: race history + record in office ──────────────────────────────

/**
 * Past races from Section 4's race table (Year · Office · Result · Votes / % ·
 * Margin · Opponent · Source). `outcome` is 'won' | 'lost' | '' from the
 * Result cell's own words.
 */
export function parseRaceHistory(content) {
  const body = sectionBody(content, 4)
  const out = []
  for (const t of parseTables(body)) {
    const h = t.header
    const iYear = col(h, /^year|date|cycle/)
    const iRes = col(h, /result|outcome/)
    const iOff = col(h, /office|race|seat|contest/)
    if (iRes < 0 || (iYear < 0 && iOff < 0)) continue
    const iVotes = col(h, /votes|%|share/)
    const iMargin = col(h, /margin/)
    const iOpp = col(h, /opponent/)
    const iSrc = col(h, /source/)
    for (const r of t.rows) {
      const result = plain(cell(r, iRes))
      const office = plain(cell(r, iOff))
      if ((isEmptyCell(result) && isEmptyCell(office)) || /^(year|result)$/i.test(result)) continue
      const outcome = /\b(won|win|elected|re-?elected|winner|unopposed)\b/i.test(result) ? 'won'
        : /\b(lost|loss|defeated|lose)\b/i.test(result) ? 'lost' : ''
      out.push({
        year: plain(cell(r, iYear)),
        office: isEmptyCell(office) ? '' : office,
        result: isEmptyCell(result) ? '' : result,
        outcome,
        votes: isEmptyCell(cell(r, iVotes)) ? '' : plain(cell(r, iVotes)),
        margin: isEmptyCell(cell(r, iMargin)) ? '' : plain(cell(r, iMargin)),
        opponent: isEmptyCell(cell(r, iOpp)) ? '' : plain(cell(r, iOpp)),
        source: isEmptyCell(cell(r, iSrc)) ? '' : plain(cell(r, iSrc)),
        url: firstUrl(cell(r, iSrc)),
      })
    }
  }
  return out
}

/**
 * Section 4's record in office: the "**Committees:**" line and the "**Key
 * votes & actions:**" list (bullets or a table). Template placeholders are
 * dropped, so a profile that wrote none returns empty arrays.
 */
export function parseOfficeRecord(content) {
  const body = sectionBody(content, 4)
  const lines = body.split('\n')
  let committees = ''
  const actions = []
  let inActions = false
  for (const raw of lines) {
    const line = raw.trim()
    const c = line.match(/^\*\*Committees:?\*\*:?\s*(.*)$/i)
    if (c) { const v = plain(c[1]); if (v && !/current and notable past/i.test(v) && !isEmptyCell(v)) committees = v; inActions = false; continue }
    const k = line.match(/^\*\*Key votes(?: &| and)? actions:?\*\*:?\s*(.*)$/i)
    if (k) { inActions = true; continue }
    if (inActions) {
      if (/^\*\*[^*]+:\*\*/.test(line) || /^#/.test(line)) { inActions = false; continue }
      const b = line.match(/^[-*•]\s+(.+)$/) || line.match(/^\d+[.)]\s+(.+)$/)
      if (b) {
        const text = plain(b[1])
        if (text && !/^date\s*·\s*bill/i.test(text)) actions.push({ text, url: firstUrl(b[1]) })
      }
    }
  }
  for (const t of parseTables(body)) {
    const h = t.header
    const iBill = col(h, /bill|action|vote|measure/)
    if (iBill < 0 || col(h, /result|outcome/) >= 0) continue
    const iDate = col(h, /date/)
    const iVote = col(h, /their vote|vote/)
    const iWhy = col(h, /why|matters|significance|note/)
    const iSrc = col(h, /source/)
    for (const r of t.rows) {
      const bill = plain(cell(r, iBill))
      if (!bill || isEmptyCell(bill)) continue
      const parts = [cell(r, iDate), bill, iVote !== iBill ? cell(r, iVote) : '', cell(r, iWhy)].map(plain).filter(x => x && !isEmptyCell(x))
      actions.push({ text: parts.join(' · '), url: firstUrl(cell(r, iSrc)) })
    }
  }
  return { committees, actions }
}

/**
 * Civic & political roles (prospect / newly-declared profiles write Section 4
 * as "Org / Board / Body · Role · Years · Source" instead of a race table).
 */
export function parseCivicRoles(content) {
  const out = []
  for (const t of parseTables(sectionBody(content, 4))) {
    const h = t.header
    const iOrg = col(h, /org|board|body|organi[sz]ation/)
    const iRole = col(h, /role|position|title/)
    if (iOrg < 0 || iRole < 0 || col(h, /result|outcome/) >= 0) continue
    const iYears = col(h, /year|period|when/)
    const iSrc = col(h, /source/)
    for (const r of t.rows) {
      const org = plain(cell(r, iOrg))
      if (!org || isEmptyCell(org)) continue
      out.push({ org, role: plain(cell(r, iRole)), years: isEmptyCell(cell(r, iYears)) ? '' : plain(cell(r, iYears)), source: plain(cell(r, iSrc)), confidence: badgesOf(r.join(' '))[0] || '' })
    }
  }
  return out
}

// ─── Weaknesses for the Attack & defense view ────────────────────────────────

/**
 * Key weaknesses: the stored/profile SWOT's weaknesses first (they carry the
 * evidence and the play when research-swot wrote them), then any legacy
 * `candidates.weaknesses` entries not already covered.
 */
export function keyWeaknesses(swot, legacy = []) {
  const out = (swot?.weaknesses || []).map(w => ({ ...w }))
  const seen = new Set(out.map(w => w.point.toLowerCase().slice(0, 60)))
  for (const w of Array.isArray(legacy) ? legacy : []) {
    const text = typeof w === 'string' ? w : w?.text
    if (!text || isEmptyCell(text)) continue
    const k = String(text).toLowerCase().slice(0, 60)
    if (seen.has(k)) continue
    seen.add(k)
    out.push({ point: plain(text), evidence: '', source: '', impact: null, play: '' })
  }
  return out
}
/**
 * Whole weeks since the newest profile when monitoring has been on long enough
 * that at least two Monday refreshes should have landed — else null. Exported
 * for tests.
 */
export function refreshOverdue(newest, monitoringSince, now = new Date()) {
  if (!newest?.generated_at) return null
  const last = Date.parse(newest.generated_at)
  const since = monitoringSince ? Date.parse(monitoringSince) : last
  const from = Math.max(last, Number.isNaN(since) ? last : since)
  const weeks = Math.floor((now.getTime() - from) / (7 * 86400000))
  return weeks >= 2 ? Math.floor((now.getTime() - last) / (7 * 86400000)) : null
}
