// Netlify Function: autofill-candidate
// Given a candidate's name, party, office, and election, uses Claude to
// look up and return any publicly available information to auto-populate
// the Add Candidate form fields.
// ANTHROPIC_API_KEY must be set in Netlify environment variables
//
// Callers: the Action plans' Add Candidate modal (Candidates.jsx, "AI Autofill")
// and, since Nov 19 2026, the Candidate plans' add sheet
// (src/pages/candidates/AddCandidateSheet.jsx, "Look them up").
//
// Response (200): { fields, name } — `fields` holds only the keys that had a
// value: any of email, phone, website, campaign_address, campaign_city,
// campaign_zip, campaign_committee, campaign_manager, treasurer, occupation,
// employer, bio_summary, twitter_handle, facebook_url, instagram_handle, party,
// notes — plus photo_url when the candidate's own website publishes a share
// image (og:image / twitter:image). The model never writes photo_url itself.

const { enforceRateLimit } = require('./_rate-limit')
const { logAiUsage } = require('./_ai-usage')
const { MODELS, CLAUDE, claudeMaxTokens, claudeText, claudeFetch } = require('./_models')
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
const SUPABASE_URL      = process.env.SUPABASE_URL  || process.env.VITE_SUPABASE_URL
const SUPABASE_ANON     = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY
const MODEL = MODELS.CLAUDE_QUALITY

const { ADMIN_EMAILS } = require('./_config')
// Include all new-format plan keys that have campaignIntel access (tiers.js: c_active+)

// ── Photo: the share image on the candidate's own website ────────────────────
// Best effort and bounded: https only, public hostnames only, 3.5s, first
// 400 KB of HTML. Any failure just means "no photo" — the user can paste one.
const PHOTO_FETCH_MS = 3500
const PHOTO_MAX_BYTES = 400 * 1024

function isFetchablePublicHttps(raw) {
  let u
  try { u = new URL(raw) } catch { return false }
  if (u.protocol !== 'https:') return false
  const h = u.hostname.toLowerCase()
  if (!h.includes('.') || h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return false
  if (/^[\d.]+$/.test(h) || h.includes(':') || h.startsWith('[')) return false   // IP literals
  return true
}

/** og:image / twitter:image / image_src from a page's HTML, made absolute (https only). */
function photoFromHtml(html, pageUrl) {
  const src = String(html || '')
  const pats = [
    /<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image(?::secure_url)?["']/i,
    /<meta[^>]+name=["']twitter:image(?::src)?["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image(?::src)?["']/i,
    /<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/i,
  ]
  for (const re of pats) {
    const m = src.match(re)
    if (!m) continue
    try {
      const abs = new URL(m[1].replace(/&amp;/g, '&').trim(), pageUrl)
      if (abs.protocol === 'https:') return abs.href
    } catch { /* malformed — try the next pattern */ }
  }
  return null
}

async function findSitePhoto(siteUrl, fetchImpl = fetch) {
  if (!isFetchablePublicHttps(siteUrl)) return null
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), PHOTO_FETCH_MS)
  try {
    const res = await fetchImpl(siteUrl, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BadgerBoard candidate lookup)', Accept: 'text/html' },
    })
    if (!res || !res.ok) return null
    if (res.url && !isFetchablePublicHttps(res.url)) return null
    const type = res.headers?.get?.('content-type') || ''
    if (type && !/html/i.test(type)) return null
    const html = (await res.text()).slice(0, PHOTO_MAX_BYTES)
    return photoFromHtml(html, res.url || siteUrl)
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

function sanitize(val, maxLen = 200) {
  if (val === null || val === undefined) return ''
  return String(val)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .slice(0, maxLen)
    .trim()
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  }

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) }
  }

  if (!ANTHROPIC_API_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured' }) }
  }

  // ── Auth guard ────────────────────────────────────────────────────────────────
  const authHeader = event.headers?.authorization || event.headers?.Authorization
  if (!authHeader?.startsWith('Bearer ')) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Not authenticated' }) }
  }
  const authRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON, Authorization: authHeader },
  })
  if (!authRes.ok) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid or expired token' }) }
  }
  // ── Tier check ────────────────────────────────────────────────────────────────
  const caller = await authRes.json()
  // Plan lineup (tiers.js): every Action plan, and — since Nov 19 2026 — every
  // Candidate plan (the add sheet's "Look them up"). Admins and beta pass.
  const { planAllowsUser, FEATURE_MESSAGES } = require('./_plan-gate')
  if (!ADMIN_EMAILS.includes(caller.email?.toLowerCase()) && !(await planAllowsUser(caller, 'autofill'))) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: FEATURE_MESSAGES.autofill }) }
  }

  // ── Durable per-user rate limit ───────────────────────────────────────────────
  const limited = await enforceRateLimit(caller.id, 'autofill-candidate', headers)
  if (limited) return limited
  // ─────────────────────────────────────────────────────────────────────────────

  let body
  try {
    body = JSON.parse(event.body)
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }
  }

  const name     = sanitize(body.name,     150)
  const party    = sanitize(body.party,    60)
  const office   = sanitize(body.office,   150)
  const election = sanitize(body.election, 150)

  if (!name) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'name is required' }) }
  }

  const prompt = `You are a political research assistant helping populate a Wisconsin candidate database. You must follow an extremely strict accuracy standard.

CANDIDATE PROVIDED:
- Name: ${name}
- Party: ${party || 'Unknown'}
- Running for: ${office || 'Unknown'}
- Election: ${election || 'Unknown'}

CRITICAL RULES — read carefully before filling anything:
1. Only fill a field if you have DIRECT, SPECIFIC knowledge of that exact person in that exact role. Not inference, not assumption, not "probably" — only verified facts you are certain about.
2. Local officials (mayors, county executives, aldermen, school board, county board, municipal judges, etc.) are frequently unknown or confused in training data. If the office is local/municipal/county level, return null for nearly everything unless you are absolutely certain.
3. Do NOT infer occupation from office title. A mayor is not automatically listed as "Mayor" for occupation — return null unless you know their actual day job.
4. Do NOT assume party affiliation from the office or context if not provided.
5. If you are even slightly uncertain about a field, return null. It is far better to return null than to return wrong data.
6. Never fabricate websites, emails, phone numbers, committee names, or social handles. These must be known facts, not guesses.
7. bio_summary: Only include if you have solid biographical knowledge of this specific person. Do not write generic bios based on their office title.

Return ONLY a valid JSON object with exactly these keys. No markdown, no explanation, no extra text:

{
  "email": null,
  "phone": null,
  "website": null,
  "campaign_address": null,
  "campaign_city": null,
  "campaign_zip": null,
  "campaign_committee": null,
  "campaign_manager": null,
  "treasurer": null,
  "occupation": null,
  "employer": null,
  "bio_summary": null,
  "twitter_handle": null,
  "facebook_url": null,
  "instagram_handle": null,
  "party": null,
  "notes": null
}

Additional rules:
- website: full URL including https:// — only if you know the actual campaign or official site
- twitter_handle: include the @ symbol — only if you know the verified handle
- party: only if you know this person's party for certain — one of Republican, Democrat, Independent, Libertarian, Green, Constitution, Nonpartisan. Do not guess it from the office or the region.
- notes: briefly describe what you do and don't know about this person, and remind the user to verify everything independently
- All values must be strings or null — never boolean or number
- When in doubt, return null. An empty form is better than wrong data.`

  try {
    const response = await claudeFetch({ apiKey: ANTHROPIC_API_KEY, body: {
        model: MODEL,
        max_tokens: claudeMaxTokens(6000),
        ...CLAUDE.QUALITY,
        messages: [{ role: 'user', content: prompt }],
      } })

    if (!response.ok) {
      const err = await response.json()
      throw new Error(err.error?.message || `Anthropic API error: ${response.status}`)
    }

    const data    = await response.json()
    logAiUsage({ userId: caller?.id, endpoint: 'candidates', provider: 'anthropic', model: MODEL, inputTokens: data?.usage?.input_tokens || 0, outputTokens: data?.usage?.output_tokens || 0 })
    const rawText = claudeText(data) || '{}'

    let fields = {}
    try {
      const cleaned = rawText.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '').trim()
      fields = JSON.parse(cleaned)
    } catch {
      return { statusCode: 200, headers, body: JSON.stringify({ fields: {}, raw: rawText }) }
    }

    // Strip any null values so frontend only merges fields that have data
    const populated = Object.fromEntries(
      Object.entries(fields).filter(([, v]) => v !== null && v !== '')
    )
    // A model never invents a photo link; the only photo comes from the site itself.
    delete populated.photo_url
    if (typeof populated.website === 'string') {
      const photo = await findSitePhoto(populated.website)
      if (photo) populated.photo_url = photo
    }

    return { statusCode: 200, headers, body: JSON.stringify({ fields: populated, name }) }
  } catch (err) {
    console.error('Autofill error:', err)
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'An internal error occurred' }) }
  }
}

// Exposed for tests/candidate-tiles.test.mjs — not part of the HTTP contract.
exports._photo = { photoFromHtml, findSitePhoto, isFetchablePublicHttps }
