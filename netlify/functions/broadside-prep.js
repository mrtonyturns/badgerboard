/**
 * broadside-prep.js
 * BROADSIDE "just describe them" intake. Turns the user's own notes — plus any
 * news-article links pasted into them — into a small sparring file the module
 * can load straight away, without generating a full Profiler dossier first.
 *
 * PLAN-GATED: requireBroadside (same gate as broadside-brain).
 *
 * POST body: { name?: string, text: string }
 * Returns:   { name, office, items:[{topic,detail}], fetched:[{url, ok, title?, error?}] }
 *
 * Flow: (1) pull up to MAX_URLS http(s) links out of the text and fetch each
 * server-side (8s timeout, 300 KB cap, tags stripped, ~6,000 chars kept) —
 * unreachable links are reported, never fatal; (2) hand the notes + article
 * text to the fast model with a JSON-only system prompt; (3) parse robustly
 * (first "{" to last "}") and validate before answering.
 *
 * The pure helpers are exported for unit tests (tests/broadside-prep.test.mjs).
 */

const { json, requireBroadside } = require('./_shared')
const { logAiUsage } = require('./_ai-usage')
const { CLAUDE, claudeText, claudeFetch } = require('./_models')
const { enforceRateLimit } = require('./_rate-limit')
const { MODELS } = require('./broadside-brain')

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
const MODEL = MODELS.speed                    // Haiku — same constant the brain's 'speed' mode uses

const MAX_URLS         = 6
const FETCH_TIMEOUT_MS = 8000
const FETCH_CAP_BYTES  = 300 * 1024
const ARTICLE_CHARS    = 6000
const MODEL_TIMEOUT_MS = 12000
const MAX_TEXT_CHARS   = 20000
const MIN_ITEMS        = 3
const MAX_ITEMS        = 12
const USER_AGENT       = 'Mozilla/5.0 (compatible; BadgerBoardBot/1.0; +https://badgerboardwi.com)'

const HEADERS = {
  'Access-Control-Allow-Origin':  process.env.ALLOWED_ORIGIN || 'https://badgerboardwi.com',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
}

// ─── Pure helpers ────────────────────────────────────────────────────────────

/** Up to `max` distinct http(s) URLs in the order they appear. Trailing punctuation is trimmed. */
function extractUrls(text, max = MAX_URLS) {
  const out = []
  const seen = new Set()
  for (const m of String(text || '').matchAll(/https?:\/\/[^\s<>"'`)\]]+/gi)) {
    let u = m[0].replace(/[.,;:!?'")\]]+$/, '')
    if (!u || seen.has(u)) continue
    seen.add(u)
    out.push(u)
    if (out.length >= max) break
  }
  return out
}

/**
 * Only public http(s) hosts may be fetched server-side — never loopback,
 * link-local, RFC1918 ranges, or bare metadata hosts (SSRF guard).
 */
function isSafeUrl(u) {
  let url
  try { url = new URL(u) } catch { return false }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  if (url.username || url.password) return false
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false
  if (host === '0.0.0.0' || host === '::' || host === '::1' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return false
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    if (a === 10 || a === 127 || a === 0) return false
    if (a === 169 && b === 254) return false
    if (a === 172 && b >= 16 && b <= 31) return false
    if (a === 192 && b === 168) return false
    if (a === 100 && b >= 64 && b <= 127) return false
  }
  if (host.startsWith('::ffff:')) return false
  return true
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', mdash: '—', ndash: '–', hellip: '…' }
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    const k = e.toLowerCase()
    if (k[0] === '#') {
      const code = k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, k) ? ENTITIES[k] : m
  })
}

/** The page <title>, decoded and trimmed, or null. */
function extractTitle(html) {
  const m = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  if (!m) return null
  const t = decodeEntities(m[1]).replace(/\s+/g, ' ').trim()
  return t ? t.slice(0, 200) : null
}

/**
 * HTML → readable text. Drops scripts, styles, nav/header/footer/aside chrome
 * and comments, keeps paragraph breaks, decodes entities, caps the length.
 */
function htmlToText(html, cap = ARTICLE_CHARS) {
  let s = String(html || '')
  s = s.replace(/<!--[\s\S]*?-->/g, ' ')
  s = s.replace(/<(script|style|noscript|svg|template|iframe)[\s\S]*?<\/\1>/gi, ' ')
  s = s.replace(/<(nav|header|footer|aside|form)\b[\s\S]*?<\/\1>/gi, ' ')
  s = s.replace(/<\/(p|div|section|article|li|h[1-6]|tr|blockquote|pre)>/gi, '\n')
  s = s.replace(/<br\s*\/?>/gi, '\n')
  s = s.replace(/<[^>]+>/g, ' ')
  s = decodeEntities(s)
  s = s.replace(/[ \t\f\v\xa0]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  return s.length > cap ? s.slice(0, cap) : s
}

/** Pull the first {...} JSON object out of a model reply, tolerating prose and code fences. */
function parseModelJson(raw) {
  const s = String(raw || '')
  const a = s.indexOf('{'), b = s.lastIndexOf('}')
  if (a === -1 || b === -1 || b <= a) return null
  const slice = s.slice(a, b + 1)
  try { return JSON.parse(slice) } catch { /* try once more after trimming trailing commas */ }
  try { return JSON.parse(slice.replace(/,\s*([}\]])/g, '$1')) } catch { return null }
}

const clean = (v, max) => (typeof v === 'string' ? v.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').replace(/\s+/g, ' ').trim().slice(0, max) : '')

/**
 * Normalise the model's object into the shape the module loads. Returns null
 * when there are not enough usable items.
 */
function validatePrep(obj, fallbackName = '') {
  if (!obj || typeof obj !== 'object') return null
  const list = Array.isArray(obj.items) ? obj.items : Array.isArray(obj.controversies) ? obj.controversies : []
  const items = []
  const seen = new Set()
  for (const it of list) {
    if (!it || typeof it !== 'object') continue
    const topic  = clean(it.topic || it.title, 80)
    const detail = clean(it.detail || it.description, 600)
    if (!detail || detail.length < 12) continue
    const key = (topic || detail).toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    items.push({ topic: topic || detail.split(/[.;:]/)[0].slice(0, 60), detail })
    if (items.length >= MAX_ITEMS) break
  }
  if (!items.length) return null
  const name   = clean(obj.name, 120) || clean(fallbackName, 120) || 'the candidate'
  const office = clean(obj.office, 120) || null
  return { name, office, items }
}

// ─── Network ─────────────────────────────────────────────────────────────────

/** Read a response body up to `cap` bytes, then stop — a 40 MB page never lands in memory. */
async function readCapped(res, cap) {
  if (!res.body || typeof res.body.getReader !== 'function') {
    const t = await res.text()
    return t.length > cap ? t.slice(0, cap) : t
  }
  const reader = res.body.getReader()
  const chunks = []
  let total = 0
  try {
    while (total < cap) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      total += value.byteLength
    }
  } finally { try { reader.cancel() } catch { /* already closed */ } }
  const buf = Buffer.concat(chunks.map(c => Buffer.from(c)))
  return buf.subarray(0, cap).toString('utf8')
}

async function fetchArticle(url) {
  if (!isSafeUrl(url)) return { url, ok: false, error: 'blocked' }
  const ctrl = new AbortController()
  const to = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5' },
    })
    if (!r.ok) return { url, ok: false, error: `HTTP ${r.status}` }
    const ctype = (r.headers.get('content-type') || '').toLowerCase()
    if (ctype && !/html|xml|text\/plain/.test(ctype)) return { url, ok: false, error: 'not a web page' }
    const html = await readCapped(r, FETCH_CAP_BYTES)
    const text = /html|xml/.test(ctype) || /<[a-z!][^>]*>/i.test(html) ? htmlToText(html) : html.slice(0, ARTICLE_CHARS)
    if (!text || text.length < 80) return { url, ok: false, error: 'no readable text' }
    return { url, ok: true, title: extractTitle(html), text }
  } catch (e) {
    return { url, ok: false, error: e && e.name === 'AbortError' ? 'timed out' : 'unreachable' }
  } finally { clearTimeout(to) }
}

// ─── Prompt ──────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You prepare a debate-practice "sparring file" about a political candidate from the material a user supplies (their own notes plus the text of any news articles they linked).

Return ONLY a JSON object — no prose, no markdown fences — with exactly this shape:
{"name": string, "office": string|null, "items": [ {"topic": string, "detail": string} ]}

Rules:
- "name": the candidate's name as given or as the material makes clear. "office": the office they hold or seek if stated, else null.
- "items": 3 to 12 entries. "topic" is at most 10 words. "detail" is 1-2 sentences phrasing a REAL fact from the material as a line of attack an opponent or reporter would use.
- Use only facts that are actually in the material. Never invent scandals, numbers, dates, quotes, or events. Do not embellish beyond what is stated.
- If the material contains no controversies, build the items from the candidate's stated positions, votes, record, or background, framed as challenges ("Explain why you backed…", "Critics say…", "How do you answer…") — not as fabricated wrongdoing.
- Merge duplicates. Prefer specific over vague. Keep each detail self-contained; the reader will not see the source.`

function buildUserPrompt({ name, text, articles }) {
  const parts = []
  if (name) parts.push(`CANDIDATE NAME (from the user): ${name}`)
  parts.push(`USER'S NOTES:\n${text}`)
  articles.forEach((a, i) => {
    parts.push(`ARTICLE ${i + 1}${a.title ? ` — ${a.title}` : ''} (${a.url}):\n${a.text}`)
  })
  parts.push('Return the JSON object now.')
  return parts.join('\n\n')
}

async function askModel(userPrompt) {
  const ctrl = new AbortController()
  const to = setTimeout(() => ctrl.abort(), MODEL_TIMEOUT_MS)
  try {
    const r = await claudeFetch({ apiKey: ANTHROPIC_API_KEY, signal: ctrl.signal, body: {
        model: MODEL,
        max_tokens: 1800,
        ...CLAUDE.FAST,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
      } })
    if (!r.ok) {
      const detail = await r.text().catch(() => '')
      console.error(`[broadside-prep] Anthropic ${r.status}: ${detail.slice(0, 300)}`)
      return { error: 'prep-upstream-error' }
    }
    const j = await r.json()
    const text = claudeText(j).trim()
    return { text, usage: j.usage || {} }
  } catch (e) {
    return { error: e && e.name === 'AbortError' ? 'prep-timeout' : 'prep-upstream-error' }
  } finally { clearTimeout(to) }
}

// ─── Handler ─────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: HEADERS, body: '' }
  if (event.httpMethod !== 'POST')    return json(405, { error: 'Method not allowed' }, HEADERS)

  const auth = await requireBroadside(event)
  if (auth.errorResponse) return { ...auth.errorResponse, headers: { ...HEADERS, ...auth.errorResponse.headers } }
  const { user } = auth

  const limited = await enforceRateLimit(user.id, 'broadside-prep', HEADERS)
  if (limited) return limited

  if (!ANTHROPIC_API_KEY) return json(503, { error: 'prep-not-configured' }, HEADERS)

  let body
  try { body = JSON.parse(event.body || '{}') } catch { return json(400, { error: 'Invalid JSON body' }, HEADERS) }

  const name = clean(body.name, 120)
  const text = typeof body.text === 'string' ? body.text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim().slice(0, MAX_TEXT_CHARS) : ''
  if (!text) return json(400, { error: 'Paste a link or write a few lines about them first.' }, HEADERS)

  const urls = extractUrls(text)
  const results = await Promise.all(urls.map(fetchArticle))
  const articles = results.filter(r => r.ok)
  const fetched = results.map(r => (r.ok ? { url: r.url, ok: true, title: r.title || undefined } : { url: r.url, ok: false, error: r.error }))

  // Links only, none of them readable, and nothing else written — nothing to work from.
  const bare = text.replace(/https?:\/\/[^\s<>"'`)\]]+/gi, '').replace(/\s+/g, ' ').trim()
  if (!articles.length && bare.length < 20) {
    return json(422, { error: urls.length ? 'None of those links could be read. Add a few lines in your own words and try again.' : 'Write a few lines about them first.', fetched }, HEADERS)
  }

  const reply = await askModel(buildUserPrompt({ name, text, articles }))
  if (reply.error) return json(reply.error === 'prep-timeout' ? 504 : 502, { error: reply.error, fetched }, HEADERS)

  logAiUsage({ userId: user.id, endpoint: 'broadside', provider: 'anthropic', model: MODEL, inputTokens: reply.usage.input_tokens || 0, outputTokens: reply.usage.output_tokens || 0 })

  const parsed = validatePrep(parseModelJson(reply.text), name)
  if (!parsed) return json(502, { error: 'prep-unparseable', fetched }, HEADERS)
  if (parsed.items.length < MIN_ITEMS) {
    // Still usable — the module will spar on what it has — but tell the caller.
    return json(200, { ...parsed, fetched, thin: true }, HEADERS)
  }
  return json(200, { ...parsed, fetched }, HEADERS)
}

module.exports.extractUrls    = extractUrls
module.exports.isSafeUrl      = isSafeUrl
module.exports.htmlToText     = htmlToText
module.exports.extractTitle   = extractTitle
module.exports.decodeEntities = decodeEntities
module.exports.parseModelJson = parseModelJson
module.exports.validatePrep   = validatePrep
module.exports.buildUserPrompt = buildUserPrompt
module.exports.LIMITS = { MAX_URLS, FETCH_TIMEOUT_MS, FETCH_CAP_BYTES, ARTICLE_CHARS, MODEL_TIMEOUT_MS, MIN_ITEMS, MAX_ITEMS }
