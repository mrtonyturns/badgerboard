// Netlify Background Function: generate-dossier-background
// Runs asynchronously (no HTTP timeout). Saves result directly to Supabase.
// Combined prompt: v4.1 structure (14 sections, tables) + legal compliance additions.
// ANTHROPIC_API_KEY + SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY must be set.

const { enforceRateLimit } = require('./_rate-limit')
const { logAiUsage } = require('./_ai-usage')
const { perplexityFetch } = require('./_perplexity')
const { MODELS, CLAUDE, claudeMaxTokens, claudeText, claudeFetch } = require('./_models')
const { resolveIdentityPrompt, WRITER_SYSTEM, WRITER_TOOLS, WRITER_TOOLS_SEARCH_ONLY, buildWriterUserPrompt, QA_SYSTEM, qaPrompt } = require('./_profile-prompt')
const ANTHROPIC_API_KEY  = process.env.ANTHROPIC_API_KEY
const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY // must be set in Netlify env vars
const XAI_API_KEY        = process.env.XAI_API_KEY        // xAI Grok — x.ai console
const SUPABASE_URL       = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const CLAUDE_MODEL       = MODELS.CLAUDE_QUALITY  // profile writer
const HAIKU_MODEL        = MODELS.CLAUDE_FAST     // verification pass + weekly digest
const GROK_MODEL         = MODELS.GROK  // Responses API w/ server-side x_search + web_search

// Admin emails — always treated as Agency tier
const { ADMIN_EMAILS } = require('./_config')
const { sendEmail, getNotificationPrefs } = require('./_email')
const { fetchOfficialRecords } = require('./_official-records')

// ─── Plans that may access full Section 6 ────────────────────────────────────
const SECTION6_TIERS = ['campaign', 'agency']

// ─── Sanitization ─────────────────────────────────────────────────────────────
function sanitize(val, maxLen = 200) {
  if (val === null || val === undefined) return ''
  return String(val)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .slice(0, maxLen)
    .trim()
}

// ─── Internal trigger support (audit fix #11) ────────────────────────────────
// The weekly auto-regenerate cron cannot present a user JWT (GoTrue rejects a
// raw service-role key), so it authenticates with the shared trigger secret.
const nodeCrypto = require('crypto')
function safeEqual(a, b) {
  const A = nodeCrypto.createHash('sha256').update(String(a ?? '')).digest()
  const B = nodeCrypto.createHash('sha256').update(String(b ?? '')).digest()
  return nodeCrypto.timingSafeEqual(A, B)
}

// Resolve the OWNING user of a candidate (candidates.created_by → auth user)
// so internally-triggered regenerations gate Sections 6/13 by the owner's real
// plan instead of falling back to the Scout teaser.
async function getCandidateOwner(candidateId) {
  try {
    if (!candidateId) return null
    const cRes = await fetch(
      `${SUPABASE_URL}/rest/v1/candidates?id=eq.${encodeURIComponent(candidateId)}&select=created_by`,
      { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } }
    )
    if (!cRes.ok) return null
    const rows = await cRes.json()
    const ownerId = rows?.[0]?.created_by
    if (!ownerId) return null
    const uRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${ownerId}`, {
      headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
    })
    if (!uRes.ok) return null
    return await uRes.json()
  } catch (e) {
    console.warn('[dossier-bg] getCandidateOwner failed:', e.message)
    return null
  }
}

// ─── Verify Supabase JWT and return user ──────────────────────────────────────
async function verifyUser(authHeader) {
  if (!authHeader?.startsWith('Bearer ')) return null
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null
  const token = authHeader.slice(7)
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${token}`,
    },
  })
  if (!res.ok) return null
  return await res.json()
}

// ─── Determine user plan from metadata ───────────────────────────────────────
// v1.18: resolves through the shared entitlement layer first (admin > beta >
// trial > paid), then normalizes to this function's legacy internal buckets.
const { resolveEntitlement } = require('./_entitlements')

// Resolves the user's canonical entitlement (plan + bracket). Admins short-
// circuit to the top action plan; everyone else goes through the shared
// resolver (admin > beta > trial > paid > free).
async function getUserEntitlement(user) {
  if (!user) return { plan: 'scout', bracket: 'b1' }
  if (ADMIN_EMAILS.includes(user.email?.toLowerCase())) return { plan: 'a_campaign', bracket: 'ent' }
  return resolveEntitlement(user)
}

// Legacy internal buckets — still used for Section 6 gating (SECTION6_TIERS).
function toLegacyBucket(plan) {
  const PLAN_MAP = {
    c_monitor: 'monitor',  a_monitor: 'monitor',
    c_active:  'campaign', a_active:  'campaign',
    c_campaign:'campaign', a_campaign:'agency',
  }
  return PLAN_MAP[plan] || (['scout', 'monitor', 'campaign', 'agency'].includes(plan) ? plan : 'scout')
}

// ─── v1.18 monthly profile allotments (server-side source of truth) ──────────
// getMonthlyProfileBase (from _entitlements) mirrors tiers.js getProfileLimit:
// Candidate plans fixed (c_campaign = 6); Action plans profiles-per-candidate ×
// bracket (a_monitor 1×, a_active 2×, a_campaign 4×). Purchased credits bank on
// top. Enforced HERE, before any LLM spend — the client-side check in
// Profiler.jsx is advisory only and trivially bypassed with a direct POST.
const { getMonthlyProfileBase } = require('./_entitlements')
const getMonthlyBase = getMonthlyProfileBase

async function countMonthToDateDossiers(userId) {
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0)
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/dossiers?generated_by=eq.${userId}&generated_at=gte.${monthStart.toISOString()}&select=id`,
    { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } }
  )
  if (!res.ok) throw new Error(`dossier count failed (${res.status})`)
  const rows = await res.json()
  return Array.isArray(rows) ? rows.length : 0
}

// After a successful generation, consume one banked profile credit if this
// generation went beyond the user's free monthly allotment. Audit fix (#1):
// re-reads the user's metadata fresh before decrementing — the request-start
// snapshot could be minutes old (research takes 3-6 min), and decrementing a
// stale bank both double-spent and un-spent credits under concurrency.
async function consumeProfileCreditIfOverage(userId, plan, bracket) {
  try {
    if (!userId) return
    const base = getMonthlyBase(plan, bracket)
    if (!Number.isFinite(base)) return  // unlimited plans never consume credits
    const monthCount = await countMonthToDateDossiers(userId)  // includes the one just saved
    if (monthCount <= base) return  // still within the free monthly allotment

    // Fresh read of the bank at decrement time (not the request-start snapshot)
    const freshRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
      headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
    })
    if (!freshRes.ok) return
    const fresh = await freshRes.json()
    const bank = Number(fresh?.app_metadata?.profile_credits) || 0
    if (bank <= 0) return
    const newBank = Math.max(0, bank - 1)
    const meta = { ...(fresh.app_metadata || {}), profile_credits: newBank }
    await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
      body: JSON.stringify({ app_metadata: meta }),
    })
    console.log(`[dossier-bg] Consumed 1 profile credit (bank ${bank} -> ${newBank}) for user ${userId}`)
  } catch (e) {
    console.warn('[dossier-bg] credit consumption skipped:', e.message)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RESEARCH MODES
//
// The dossier system handles four distinct subject types, each requiring a
// completely different research approach:
//
//   prospect       — Private citizen considering a run; no political history.
//                    Focus: professional background, civic boards, community
//                    standing, LinkedIn, business records, financial position.
//
//   newly_declared — Just announced their first run. Has a WEC filing but no
//                    electoral track record. Focus: announcement coverage,
//                    initial fundraising, what drove them to run, early
//                    endorsements, professional background that qualifies them.
//
//   challenger     — Has run before or is actively mid-race against an
//                    opponent. Focus: electoral history, campaign fundraising,
//                    messaging, head-to-head dynamics, polling.
//
//   incumbent      — Currently holds office, seeking another term. Focus:
//                    voting record, bills sponsored, committee work,
//                    performance vs. campaign promises, current race dynamics.
// ─────────────────────────────────────────────────────────────────────────────

function getResearchMode(status, isIncumbent, hasOffice) {
  if (isIncumbent) return 'incumbent'
  if (!hasOffice) return 'prospect'
  if (!status || status === 'exploring') return 'prospect'
  if (status === 'declared') return 'newly_declared'
  if (status === 'lost' || status === 'withdrawn') return 'prospect'
  // primary_winner, general, elected (running again) → full challenger mode
  return 'challenger'
}

// ─── Generic Perplexity query helper ─────────────────────────────────────────
// Every saved profile since August recorded perplexity_sources_used = 1: six
// of the seven packets were dying on the 45s abort (seven sonar-pro searches
// run at once and each takes 30–90s) and only the news pass, which had its own
// sonar fallback, survived. The budget is now 90s and every sonar-pro call
// falls back to a quicker sonar pass instead of returning nothing.
const PPLX_TIMEOUT_MS = 90000
const PPLX_FALLBACK_TIMEOUT_MS = 40000
async function queryPerplexity(systemMsg, userMsg, maxTokens = 1500, model = 'sonar', label = model) {
  if (!PERPLEXITY_API_KEY) return null
  const once = async (m, ms, tokens) => {
    const ctrl = new AbortController()
    const to = setTimeout(() => ctrl.abort(), ms)
    const t0 = Date.now()
    try {
      const res = await perplexityFetch({ apiKey: PERPLEXITY_API_KEY, signal: ctrl.signal, body: { model: m, messages: [{ role: 'system', content: systemMsg }, { role: 'user', content: userMsg }], max_tokens: tokens } })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const d = await res.json()
      const text = d.choices?.[0]?.message?.content || null
      console.log(`[perplexity] ${label} (${m}) ok in ${Date.now() - t0}ms, ${text ? text.length : 0} chars`)
      return text
    } finally { clearTimeout(to) }
  }
  try {
    return await once(model, PPLX_TIMEOUT_MS, maxTokens)
  } catch (e) {
    console.error(`[perplexity] ${label} (${model}) failed: ${e.message}`)
    if (model !== 'sonar-pro') return null
    try {
      return await once('sonar', PPLX_FALLBACK_TIMEOUT_MS, Math.min(maxTokens, 2000))
    } catch (e2) { console.error(`[perplexity] ${label} sonar fallback failed: ${e2.message}`); return null }
  }
}

// ─── Identity lock — mode-aware ───────────────────────────────────────────────
async function fetchPerplexityIdentity(name, office, district, ctx, mode) {
  const ctxNote = ctx ? ` Additional context to find the right person: ${ctx}.` : ''
  const locNote = district ? ` in the ${district} area` : ' in Wisconsin'

  const queries = {
    prospect: `Find verified identity information for ${name}${locNote} who may be considering running for political office.${ctxNote} Search: LinkedIn profile, local business directories, Wisconsin voter registration (myvote.wi.gov), WDFI business filings, local news archives, professional licensing (DSPS), and any professional association directories. Return: full legal name, date of birth (if public), home address (if public), current employer and title, business ownership, spouse (if public), LinkedIn URL, social media handles. Only include confirmed facts with sources.`,
    newly_declared: `Find verified identity information for ${name} who recently announced a run for ${office}${district ? ` in ${district}` : ''} in Wisconsin.${ctxNote} Search: their WEC campaign committee filing (wec.vote), campaign website, announcement news coverage, LinkedIn, and Wisconsin voter registration. Return: full legal name, WEC committee name and registration date, home address (if public), current employer, campaign website URL, social media handles (Facebook, X/Twitter, Instagram, LinkedIn). Only confirmed facts with sources.`,
    challenger: `Find verified identity information for ${name} running for ${office}${district ? ` in ${district}` : ''} in Wisconsin.${ctxNote} Search: WEC filing, campaign website, Ballotpedia, news coverage, LinkedIn, and Wisconsin voter registration. Return: full legal name, date of birth (if public), home address (if public), current employer, campaign committee name, campaign website, social media handles. Only confirmed facts with sources.`,
    incumbent: `Find verified identity information for ${name} who holds or recently held ${office}${district ? ` in ${district}` : ''} in Wisconsin.${ctxNote} Search: official government website staff page, WEC filing, state legislature website, Wisconsin Ethics Commission filing, news coverage. Return: full legal name, date of birth (if public), official office address, district number, years in office, committee assignments, campaign committee name, social media handles. Only confirmed facts with sources.`,
  }

  return queryPerplexity(
    'You are a Wisconsin political researcher. Return ONLY verified identity facts. Format each fact as: FIELD: value (Source). If you cannot confirm a fact with a source, omit it entirely. Never speculate.',
    queries[mode] || queries.challenger,
    1200,
    'sonar-pro'
  )
}

// ─── News coverage — mode-aware ───────────────────────────────────────────────
async function fetchPerplexityNews(name, office, district, ctx, mode, localSources = '') {
  if (!PERPLEXITY_API_KEY) return null
  const ctxNote = ctx ? ` Context: ${ctx}.` : ''
  const locNote = district ? ` in ${district}` : ' in Wisconsin'

  const queries = {
    prospect: `Find all news articles, local coverage, business press, and public activity for ${name}${locNote}.${ctxNote} Search Wisconsin local media for: business news, community involvement, civic award coverage, op-eds or letters to the editor, chamber of commerce activities, school board or local government meeting minutes where their name appears, any public statements on local issues, neighborhood association involvement, and any political discussions or endorsements. Include article title, publication, date, and URL where known. Return at least 10 items.`,
    newly_declared: `Find all news articles and coverage about ${name} who recently announced a run for ${office}${locNote}.${ctxNote} Search for: the announcement article (what outlet broke the story), editorial board reactions, opponent responses, early endorsement coverage, any coverage of their professional background that prompted the run, social media coverage of the announcement, and any prior local news coverage of this person. Include title, publication, date, URL. Return at least 10 items.`,
    challenger: `Find all recent news articles, press coverage, endorsements, and campaign activity for ${name} running for ${office}${locNote}.${ctxNote} Include: campaign announcements, debate coverage, endorsements, fundraising stories, opponent attacks and responses, polling coverage, and local editorial coverage. Focus on the past 12 months. Include title, publication, date, URL. Return 15+ items.`,
    incumbent: `Find all recent news articles, coverage of official actions, and re-election campaign activity for ${name} who holds ${office}${locNote}.${ctxNote} Include: coverage of their official votes and decisions, legislation they sponsored or opposed, constituent controversies, endorsements for re-election, fundraising stories, any challenger coverage that references them, ethics or legal coverage, and any press about their record in office. Return 15+ items.`,
  }

  const NEWS_SYSTEM = 'You are a Wisconsin political news researcher. For each news item, use this exact format:\n### [Exact Article Title](https://full-url.com)\n**Publication Name** · Month D, YYYY\nOne sentence summary.\n\nIf URL unknown: ### Exact Article Title\nReturn at least 12-20 items. Focus on Wisconsin local outlets. Do not fabricate articles.'

  const runNewsSearch = async (model, maxTokens, timeoutMs) => {
    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(), timeoutMs)
    const res = await perplexityFetch({ apiKey: PERPLEXITY_API_KEY, signal: ctrl.signal, body: {
        model,
        messages: [
          { role: 'system', content: NEWS_SYSTEM },
          { role: 'user', content: (queries[mode] || queries.challenger) + ' ALSO search for podcast episodes, radio interviews, and YouTube/TV appearances featuring them (list each as an item with the show name as the publication).' + localSources },
        ],
        max_tokens: maxTokens,
      } })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    return data.choices?.[0]?.message?.content || null
  }

  // v1.20.1: 45s budget + a fast sonar retry when the deep search fails —
  // previously a 20s abort silently produced a dossier with NO news at all.
  try {
    return await runNewsSearch('sonar-pro', 3000, PPLX_TIMEOUT_MS)
  } catch (e) {
    console.error(`[perplexity/news] deep search failed (${e.message}) — retrying with sonar`)
    try {
      return await runNewsSearch('sonar', 2000, PPLX_FALLBACK_TIMEOUT_MS)
    } catch (e2) { console.error(`[perplexity/news] fallback failed: ${e2.message}`); return null }
  }
}

// v1.20.1: dedicated hyper-local pass — the general news search covers state
// and major outlets; this one exclusively works the county-local source list
// (weeklies, city pages, chambers, local broadcast), which the single-pass
// search consistently under-covered.
async function fetchPerplexityLocalNews(name, office, district, ctx, mode, localSources = '') {
  if (!PERPLEXITY_API_KEY || !localSources) return null
  const ctxNote = ctx ? ` Context: ${ctx}.` : ''
  const locNote = district ? ` in ${district}` : ' in Wisconsin'
  return queryPerplexity(
    'You are a hyper-local Wisconsin news researcher. Search ONLY small local outlets: county weeklies, city newspapers, local TV/radio stations, chamber-of-commerce pages, city/village hall announcements, school district pages, and community Facebook pages surfaced by news search. For each item:\n### [Exact Title](https://full-url.com)\n**Outlet Name** · Month D, YYYY\nOne sentence summary.\nSmall items count — meeting minutes mentions, letters to the editor, event coverage, local award notices. Return every item you find. Do not fabricate.',
    `Search these specific local outlets and any other hyper-local sources for ANY mention of ${name}${locNote} — as a candidate, official, business owner, or community member.${ctxNote}${localSources}\nInclude older items (up to 3 years back) if relevant to their public record.`,
    2500,
    'sonar-pro'
  )
}

// ─── Political / civic record — mode-aware ────────────────────────────────────
async function fetchPerplexityPoliticalRecord(name, office, district, ctx, mode) {
  const ctxNote = ctx ? ` Context: ${ctx}.` : ''
  const locNote = district ? ` in ${district}` : ' in Wisconsin'

  const queries = {
    prospect: `Find the civic and community leadership record for ${name}${locNote}.${ctxNote} Search for: any city, county, or school board appointments or elections; nonprofit board memberships (search ProPublica 990s); HOA leadership; chamber of commerce roles; professional association board seats; any advisory committee appointments by local government; public testimony at government hearings; any prior political campaign donations (FEC/WEC). Return structured list with organization, role, years, and source for each item.`,
    newly_declared: `Find the background record for ${name} who recently announced a run for ${office}${locNote}.${ctxNote} Search for: (1) their WEC campaign committee registration date and details; (2) any prior civic board service — city, county, school board, nonprofit board (ProPublica 990s); (3) any public statements that explain why they're running; (4) prior political activity — donations, volunteering, endorsements given; (5) any prior campaign runs. Return structured list with sources.`,
    challenger: `Find the political record for ${name} running for ${office}${locNote}.${ctxNote} Include: all prior races run (year, office, win/loss, vote totals, opponent); prior offices held; committee assignments; bills sponsored; key votes; endorsements received and given; party activity. Sources: Ballotpedia, Wisconsin Legislature (legis.wisconsin.gov), WEC (wec.vote), VoteSmart, local news.`,
    incumbent: `Find the voting record and official actions of ${name} who holds ${office}${locNote}.${ctxNote} Include: all votes cast in their current term with bill numbers, dates, and outcomes; legislation they sponsored or co-sponsored; committee chairmanships and key decisions; any bills they killed or advanced; ethics filings (ethics.wi.gov); constituent case outcomes; any floor speeches or public positions taken. Sources: Wisconsin Legislature (legis.wisconsin.gov), WisEye, WEC, WisconsinEye, local news.`,
  }

  return queryPerplexity(
    'You are a Wisconsin political record researcher. Return structured, sourced data. For each item include: title/description, date, outcome, and source. Do not fabricate records.',
    queries[mode] || queries.challenger,
    1500,
    'sonar-pro'
  )
}

// ─── Campaign finance — mode-aware ───────────────────────────────────────────
async function fetchPerplexityCampaignFinance(name, office, district, ctx, mode) {
  const ctxNote = ctx ? ` Context: ${ctx}.` : ''
  const locNote = district ? ` in ${district}` : ' in Wisconsin'

  const queries = {
    prospect: `Search for any financial public record for ${name}${locNote}.${ctxNote} Find: (1) WDFI business registrations and ownership (apps.dfi.wi.gov); (2) property ownership and value (county land records, RETR); (3) UCC liens (wims.dfi.wi.gov); (4) any DOR tax delinquency (>$5K); (5) any prior campaign donations they made to other candidates (FEC/WEC); (6) OpenBook state contracts to any business they own; (7) PACER bankruptcy records. Return each item with source and date.`,
    newly_declared: `Find campaign finance information for ${name} who recently filed to run for ${office}${locNote}.${ctxNote} Search: (1) WEC committee registration and initial filings (wec.vote); (2) any ActBlue or Anedot fundraising pages; (3) first campaign finance report if filed; (4) personal financial public records — WDFI business, property (county land/RETR), UCC liens; (5) any prior donations they made to campaigns (FEC/WEC). Sources: WEC, FEC, FollowTheMoney, county records.`,
    challenger: `Find campaign finance information for ${name} running for ${office}${locNote}.${ctxNote} Include: total raised this cycle, total spent, cash on hand, top donors by category, PAC contributions, personal loans to campaign, any WEC/FEC violations or complaints. Compare to opponent if data available. Sources: WEC (wec.vote), FEC (fec.gov), FollowTheMoney, OpenSecrets, WI Democracy Campaign (wisdc.org).`,
    incumbent: `Find campaign finance for ${name} seeking re-election to ${office}${locNote}.${ctxNote} Include: current cycle fundraising vs. prior cycle, top donors, PAC support, cash on hand vs. challenger, any fundraising controversies. Also find: any conflicts between donors and official votes or decisions, WI Democracy Campaign donor analysis. Sources: WEC, FEC, FollowTheMoney, OpenSecrets, WI Democracy Campaign.`,
  }

  return queryPerplexity(
    'You are a Wisconsin campaign finance researcher. Return ONLY verified financial data with sources. Include dollar amounts, donor names/categories, dates, and source links.',
    queries[mode] || queries.challenger,
    1500,
    'sonar-pro'
  )
}

// ─── Social media — mode-aware ────────────────────────────────────────────────
async function fetchPerplexitySocialMedia(name, office, district, ctx, mode) {
  const ctxNote = ctx ? ` Context: ${ctx}.` : ''
  const locNote = district ? ` in ${district}` : ' in Wisconsin'

  const queries = {
    prospect: `Find the social media and online presence for ${name}${locNote}.${ctxNote} Search: LinkedIn profile (most important for this person), personal Facebook page, X/Twitter, Instagram, any local Facebook community groups they're active in, Nextdoor, Reddit (r/wisconsin and local subreddits), any professional blog or newsletter, YouTube. Look for: political opinions, community commentary, professional activity, civic involvement posts, any signals of political interest or ambition. Return structured items with platform, date, and excerpt.`,
    newly_declared: `Find social media activity for ${name} who just announced a run for ${office}${locNote}.${ctxNote} Search: their campaign Facebook page (new or converted from personal), campaign X/Twitter account, Instagram, LinkedIn announcement, local Facebook community group reactions to their announcement, Reddit discussions, news article comment sections. Focus on the last 60 days. Include their campaign announcement posts and community reaction posts.`,
    challenger: `Find recent social media activity for ${name} running for ${office}${locNote}.${ctxNote} Search: Facebook campaign page, X/Twitter, Instagram, LinkedIn, Reddit (local subreddits), local Facebook community groups. Include posts by the candidate and posts about them. Focus on campaign content, endorsements, attacks, controversies.`,
    incumbent: `Find social media activity for ${name} who holds ${office}${locNote}.${ctxNote} Search: official government social media accounts, campaign social media, constituent interactions, posts about their votes/decisions by community members, Reddit discussions, local Facebook groups discussing their record. Include both their posts and community commentary on their performance.`,
  }

  // v1.20.1: upgraded from sonar → sonar-pro with a platform-by-platform sweep —
  // the cheap single-pass search was the main reason Section 10 came up thin.
  return queryPerplexity(
    'You are a Wisconsin social media researcher. Work platform by platform — for EACH of Facebook, X/Twitter, Instagram, LinkedIn, TikTok, YouTube, Reddit, and Nextdoor, search for the subject and report what you find (or skip silently if nothing). Return a structured list of posts and mentions. For each item use this format:\n### [Post description or excerpt](URL-if-known)\n**Platform / Author** · Date\nSentiment: +/-/~. One-sentence context.\n\nReturn 12-20+ items including both posts BY the subject and posts ABOUT them (community reactions, local group discussions). Do not fabricate posts.',
    queries[mode] || queries.challenger,
    3000,
    'sonar-pro'
  )
}

// ─── Affiliations — mode-aware ────────────────────────────────────────────────
async function fetchPerplexityAffiliations(name, office, district, ctx, mode) {
  const ctxNote = ctx ? ` Context: ${ctx}.` : ''
  const locNote = district ? ` in ${district}` : ' in Wisconsin'

  const queries = {
    prospect: `Find all organizational affiliations and community ties for ${name}${locNote}.${ctxNote} Search: (1) nonprofit board memberships — search ProPublica 990s for their name as officer/director; (2) professional association memberships; (3) chamber of commerce membership or leadership; (4) civic org leadership — Rotary, Lions, VFW, local civic leagues; (5) any local government advisory board or commission appointments; (6) religious organization public leadership roles; (7) professional licensing boards (DSPS). Return each with org name, role, years, and source.`,
    newly_declared: `Find all organizational affiliations and initial endorsements for ${name} who just announced for ${office}${locNote}.${ctxNote} Search for: (1) who endorsed them at their announcement; (2) what organizations they've publicly led or been affiliated with; (3) union or professional association ties; (4) nonprofit board memberships (ProPublica 990s); (5) party committee involvement; (6) any PACs that have already indicated support. Return with source and date.`,
    challenger: `Find all organizational affiliations, endorsements, and political network for ${name} running for ${office}${locNote}.${ctxNote} Include: organizations they belong to, boards they sit on, endorsements received and given, PACs supporting them, union ties, professional associations, party committee roles, dark money connections (InfluenceWatch, WI Democracy Campaign). Sources: candidate website, news, OpenSecrets, InfluenceWatch.`,
    incumbent: `Find all organizational affiliations, endorsements, and funding networks for ${name} who holds ${office}${locNote}.${ctxNote} Include: organizations they've affiliated with during their term, boards they sit on (potential conflicts of interest), re-election endorsements, PAC and dark money support, union/industry backing, any new affiliations since taking office. Sources: ethics.wi.gov disclosure, InfluenceWatch, WI Democracy Campaign, news.`,
  }

  return queryPerplexity(
    'You are a Wisconsin political researcher focused on organizational ties. Return structured data with org name, role, type, date, and source for each item.',
    queries[mode] || queries.challenger,
    1000
  )
}

// ─── Grok: real-time X + web intelligence — mode-aware ───────────────────────
async function fetchGrokXIntelligence(name, office, district, twitterHandle, ctx, mode) {
  if (!XAI_API_KEY) return null
  // v1.20.1: no stored handle is no longer a dead end — Grok is told to FIND
  // the account first, then search it.
  const handleLine = twitterHandle
    ? ` Their X handle is @${twitterHandle}.`
    : ` Their X handle is not known — first search X to identify their account (match name + Wisconsin + role), state which handle you found, then proceed.`
  const ctxLine = ctx ? ` Additional context: ${ctx}.` : ''
  const locNote = district ? ` in ${district}` : ' in Wisconsin'

  const modeIntro = {
    prospect:       `${name} is a private citizen${locNote} who may be considering a run for political office.`,
    newly_declared: `${name} recently announced a run for ${office}${locNote}.`,
    challenger:     `${name} is running for ${office}${locNote}.`,
    incumbent:      `${name} currently holds ${office}${locNote} and is seeking re-election.`,
  }

  const modeInstructions = {
    prospect: `Since this person has no declared candidacy, focus on: (1) Any mentions of their name in political contexts — endorsements of others, commentary on local issues, political Facebook group activity; (2) Any public business or professional reputation signals; (3) Any community discussion of this person as a potential candidate; (4) Their professional social media presence.`,
    newly_declared: `Since this person just announced, focus on: (1) Reaction to their announcement on X, Facebook, and local news comment sections; (2) Initial endorsement or opposition signals; (3) Their own campaign social media launch posts; (4) Any opposition research already surfacing about them; (5) How opponents and incumbent are responding.`,
    challenger: `Focus on: (1) Current X/social campaign activity and messaging; (2) Grassroots mobilization for or against; (3) Attacks from opponents and their responses; (4) Any viral moments, gaffes, or endorsements making news; (5) Comparison to incumbent's social presence.`,
    incumbent: `Focus on: (1) Constituent commentary on their recent votes and decisions; (2) Opposition and challenger messaging targeting them; (3) Any controversy or criticism trending on X; (4) Re-election campaign social activity; (5) Grassroots support or opposition signals.`,
  }

  const query = `Provide a real-time intelligence report on ${modeIntro[mode] || modeIntro.challenger}${handleLine}${ctxLine}

${modeInstructions[mode] || modeInstructions.challenger}

Search X (Twitter) and the web RIGHT NOW and report:

1. X POST ACTIVITY (past 90 days — local candidates post infrequently, go back further): Format each as: [@handle · Date] "excerpt" — context note.
2. REAL-TIME SENTIMENT: Overall X/web sentiment (positive/negative/mixed) and what's driving it.
3. BREAKING COVERAGE: Any news in the last 2 weeks — emerging stories, recent statements, new endorsements or withdrawals.
4. GRASSROOTS SIGNALS: What are local activists, organizers, and community members saying?

Return structured findings with source attribution. Mark recency: [Today] [This week] [This month]. If no data found for a category, say NOT FOUND.`

  try {
    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(), 60000)  // Responses API with tool use takes longer (v1.20.1: 60s)
    const res = await fetch('https://api.x.ai/v1/responses', {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${XAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: GROK_MODEL,
        input: [
          {
            role: 'user',
            content: `[SYSTEM: You are a real-time political intelligence researcher. Search X and the web for the most current information. Return structured findings with source attribution. Be specific — include actual quotes, handles, dates, and URLs where available.]\n\n${query}`,
          },
        ],
        tools: [{ type: 'x_search' }, { type: 'web_search' }],
      }),
    })

    if (!res.ok) {
      console.error(`[dossier-bg] Grok error: ${res.status} ${await res.text().catch(() => '')}`)
      return null
    }
    const data = await res.json()
    // Responses API: output[] → find type=message → content[] → find type=output_text → text
    for (const out of (data.output || [])) {
      if (out.type === 'message') {
        for (const c of (out.content || [])) {
          if (c.type === 'output_text' && c.text) return c.text
        }
      }
    }
    return null
  } catch (e) {
    console.error(`[dossier-bg] Grok failed: ${e.message}`)
    return null
  }
}

// ─── #18: Claude API call with retry on 529 overload ─────────────────────────
async function callClaudeWithRetry(payload, maxRetries = 2, signal = undefined) {
  let lastErr = null
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const delay = attempt * 35000 // 35s, 70s
      console.log(`[dossier-bg] Claude overloaded — retry ${attempt}/${maxRetries} in ${delay/1000}s`)
      await new Promise(r => setTimeout(r, delay))
    }
    try {
      const response = await claudeFetch({ apiKey: ANTHROPIC_API_KEY, body: payload, signal })
      if (response.status === 529 && attempt < maxRetries) { lastErr = new Error('API overloaded (529)'); continue }
      return response
    } catch (e) { lastErr = e; if (attempt < maxRetries) continue; throw e }
  }
  throw lastErr || new Error('Max retries exceeded')
}

// ─── #16: Validate all 14 sections are present in the generated content ───────
function countSections(content) {
  return (content.match(/^## SECTION \d+/gim) || []).length
}

// ─── Audit fix (#10): Scout lite-profile gate (storage-time) ──────────────────
// Mirrors LITE_PROFILE_FREE_SECTIONS in src/lib/tiers.js: Section 2 (Biography)
// and 4 (Political Record) stay full; Section 8 (Affiliations) keeps its first
// 2 items; every other section's body is replaced with an upgrade template
// BEFORE saving, so the paid content never exists in a Scout user's row.
const LITE_FREE_FULL_SECTIONS = new Set([2, 4])
const LITE_PARTIAL_SECTIONS   = { 8: 2 }  // section → number of leading items kept

function applyScoutLiteGate(content) {
  return content.replace(/^## SECTION (\d+)[^\n]*\n[\s\S]*?(?=^## SECTION \d+|$(?![\s\S]))/gim, (block, numStr) => {
    const num = parseInt(numStr, 10)
    if (LITE_FREE_FULL_SECTIONS.has(num)) return block
    const headerMatch = block.match(/^## SECTION \d+[^\n]*\n/)
    const header = headerMatch ? headerMatch[0] : `## SECTION ${num}\n`

    if (num in LITE_PARTIAL_SECTIONS) {
      const maxItems = LITE_PARTIAL_SECTIONS[num]
      const bodyLines = block.slice(header.length).split('\n')
      const kept = []
      let items = 0
      for (const line of bodyLines) {
        if (/^###\s/.test(line)) {
          items++
          if (items > maxItems) break
        }
        kept.push(line)
        if (kept.length >= 30) break  // hard cap if the section isn't ###-delimited
      }
      return `${header}${kept.join('\n').trim()}\n\n*The rest of this section is available on paid Badger Board plans.*\n\n`
    }

    return `${header}**[LOCKED — PAID PLANS]**\n\n*This section is available on paid Badger Board plans. Upgrade to unlock the full 14-section profile with controversies, financial background, social media analysis, attack & defense strategy, and more.*\n\n`
  })
}

// ─── v5 stages: identity resolver · writer loop · QA pass ────────────────────
// Writer tool budget (also stated to the model in the prompt).
const WRITER_BUDGET = { searches: 10, fetches: 8 }
// How hard the writer thinks. Opus 5.5 defaults to medium. The first live
// runs at high took 7 min (prospect) and 14 min (incumbent) end to end —
// against a 15-minute function ceiling — so medium is the default; set
// PROFILE_EFFORT=high to trade time for depth.
const WRITER_EFFORT = ['low', 'medium', 'high', 'xhigh', 'max'].includes(process.env.PROFILE_EFFORT) ? process.env.PROFILE_EFFORT : 'medium'
const WRITER_MAX_TOKENS = claudeMaxTokens(24000)   // 48k: the report plus thinking
const WRITER_CONTINUATIONS = 4                      // pause_turn resumes per call
const WRITER_CALL_TIMEOUT_MS = 10 * 60 * 1000       // one API call; the function has 15 min
const FUNCTION_BUDGET_MS = 14 * 60 * 1000           // leave a minute under Netlify's 15-min ceiling
const QA_MIN_REMAINING_MS = 100 * 1000               // skip QA rather than die mid-pass
// Time left in this invocation, given when the handler started.
function remainingMs(startedAt) { return Math.max(0, startedAt + FUNCTION_BUDGET_MS - Date.now()) }

// Real cost metering for a Claude response, including the per-search fee for
// server-side web_search ($10 / 1,000 searches). web_fetch has no fee beyond
// the tokens it returns, which are already in input_tokens.
function meterClaude({ userId, endpoint, model, data }) {
  const u = data?.usage || {}
  const searches = Number(u.server_tool_use?.web_search_requests) || 0
  logAiUsage({ userId, endpoint, provider: 'anthropic', model,
    inputTokens: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
    outputTokens: u.output_tokens || 0,
    flatUsd: searches * 0.01 })
}

function parseJsonObject(text) {
  if (!text) return null
  const raw = String(text).replace(/^```json?\s*/i, '').replace(/```\s*$/, '').trim()
  try { return JSON.parse(raw) } catch { /* fall through */ }
  const m = raw.match(/\{[\s\S]*\}/)
  if (m) { try { return JSON.parse(m[0]) } catch { /* fall through */ } }
  return null
}

// Stage 1 — who is this? Sonnet 5.5 with web_search; returns the identity
// card (or null — the writer copes). Never throws.
async function resolveIdentity({ safe, officeLine, mode, userId }) {
  if (!ANTHROPIC_API_KEY) return null
  const ctrl = new AbortController()
  const to = setTimeout(() => ctrl.abort(), 90000)
  try {
    const res = await claudeFetch({ apiKey: ANTHROPIC_API_KEY, signal: ctrl.signal, body: {
      model: MODELS.CLAUDE_BALANCED,
      max_tokens: 6000,
      output_config: { effort: 'medium' },
      system: 'You resolve the identity of Wisconsin political figures from public web sources and answer only in JSON.',
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
      messages: [{ role: 'user', content: resolveIdentityPrompt({ safe, officeLine, mode }) }],
    } })
    if (!res.ok) { console.warn(`[dossier-bg] identity stage HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`); return null }
    let data = await res.json()
    // A paused server-tool loop: continue once with the content as-is.
    if (data.stop_reason === 'pause_turn') {
      const res2 = await claudeFetch({ apiKey: ANTHROPIC_API_KEY, signal: ctrl.signal, body: {
        model: MODELS.CLAUDE_BALANCED, max_tokens: 6000, output_config: { effort: 'medium' },
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
        messages: [{ role: 'user', content: resolveIdentityPrompt({ safe, officeLine, mode }) }, { role: 'assistant', content: data.content }],
      } })
      if (res2.ok) { meterClaude({ userId, endpoint: 'profiler', model: MODELS.CLAUDE_BALANCED, data }); data = await res2.json() }
    }
    meterClaude({ userId, endpoint: 'profiler', model: MODELS.CLAUDE_BALANCED, data })
    const card = parseJsonObject(claudeText(data))
    if (!card || typeof card !== 'object') { console.warn('[dossier-bg] identity stage returned no JSON'); return null }
    // Only keep http(s) URLs — the writer's fetch list is built from these.
    const okUrl = (u) => typeof u === 'string' && /^https?:\/\/\S+$/i.test(u) && u.length < 250 ? u : null
    const cu = card.canonical_urls && typeof card.canonical_urls === 'object' ? card.canonical_urls : {}
    for (const k of Object.keys(cu)) cu[k] = Array.isArray(cu[k]) ? cu[k].map(okUrl).filter(Boolean).slice(0, 6) : okUrl(cu[k])
    card.canonical_urls = cu
    card.key_news_urls = (Array.isArray(card.key_news_urls) ? card.key_news_urls : []).map(okUrl).filter(Boolean).slice(0, 8)
    console.log(`[dossier-bg] identity: resolved=${card.resolved} confidence=${card.confidence} name=${card.legal_name} urls=${Object.values(cu).flat().filter(Boolean).length + card.key_news_urls.length}`)
    return card
  } catch (e) {
    console.warn('[dossier-bg] identity stage failed:', e.message)
    return null
  } finally { clearTimeout(to) }
}

const MODES = new Set(['prospect', 'newly_declared', 'challenger', 'incumbent'])
// Trust the identity stage's suggested mode only where the record is thin:
// no linked office (which forces PROSPECT), or an unknown status. A record
// flagged is_incumbent, or with an office and a real status, keeps its mode.
function refineModeFromIdentity({ mode, officeLine, safe, card }) {
  if (!card || card.resolved === false || !MODES.has(card.suggested_mode)) return { mode, officeLine }
  const thin = !safe.officeName || !safe.status || safe.status === 'exploring'
  const out = { mode, officeLine }
  if (thin && card.suggested_mode !== mode && card.confidence !== 'low') out.mode = card.suggested_mode
  if ((!safe.officeName || officeLine === 'Unknown Office') && typeof card.office_or_role === 'string' && card.office_or_role.trim() && out.mode !== 'prospect') {
    out.officeLine = card.office_or_role.trim().slice(0, 150)
  }
  return out
}

// Stage 2 — the writer. One Opus 5.5 turn with web_search + web_fetch,
// continued through pause_turn, retried on 529, and downgraded to
// search-only if the org has web fetch turned off (400 naming web_fetch).
// Resolves { data, text, usedTools }; throws on a hard failure.
async function runWriter({ userPrompt, userId, maxContinuations = WRITER_CONTINUATIONS, deadlineMs = Infinity }) {
  let tools = WRITER_TOOLS
  const messages = [{ role: 'user', content: userPrompt }]
  const body = () => ({
    model: CLAUDE_MODEL,
    max_tokens: WRITER_MAX_TOKENS,
    output_config: { effort: WRITER_EFFORT },
    // Static system prompt → prompt-cached across every profile run.
    system: [{ type: 'text', text: WRITER_SYSTEM, cache_control: { type: 'ephemeral' } }],
    tools,
    messages,
  })
  let data = null
  const textParts = []   // a paused turn may already hold part of the report
  for (let hop = 0; hop <= maxContinuations; hop++) {
    const ctrl = new AbortController()
    // Never let one call run past the function's own deadline (minus ~70s for
    // save + QA); a request that would start with under a minute is pointless.
    const budget = Math.min(WRITER_CALL_TIMEOUT_MS, deadlineMs - Date.now() - 70000)
    if (budget < 60000) throw new Error('out of time before the writer call')
    const to = setTimeout(() => ctrl.abort(), budget)
    let response
    try {
      response = await callClaudeWithRetry(body(), 2, ctrl.signal)
      if (response.status === 400 && tools === WRITER_TOOLS) {
        const detail = await response.text().catch(() => '')
        if (/web_fetch/i.test(detail)) {
          console.warn('[dossier-bg] web_fetch rejected by the API — continuing with web_search only')
          tools = WRITER_TOOLS_SEARCH_ONLY
          response = await callClaudeWithRetry(body(), 2, ctrl.signal)
        } else {
          throw new Error(`Anthropic API error: 400 ${detail.slice(0, 300)}`)
        }
      }
      if (!response.ok) {
        const errText = await response.text().catch(() => '')
        console.error(`[dossier-bg] Claude error: ${errText.slice(0, 500)}`)
        throw new Error(`Anthropic API error: ${response.status}`)
      }
      data = await response.json()
    } finally { clearTimeout(to) }
    meterClaude({ userId, endpoint: 'profiler', model: CLAUDE_MODEL, data })
    const u = data.usage || {}
    console.log(`[dossier-bg] writer hop ${hop}: stop=${data.stop_reason} in=${u.input_tokens} cached=${u.cache_read_input_tokens || 0} out=${u.output_tokens} searches=${u.server_tool_use?.web_search_requests || 0} fetches=${u.server_tool_use?.web_fetch_requests || 0}`)
    textParts.push(claudeText(data))
    if (data.stop_reason !== 'pause_turn') break
    messages.push({ role: 'assistant', content: data.content })
  }
  if (data?.stop_reason === 'pause_turn') console.warn('[dossier-bg] writer still paused after max continuations — using what we have')
  if (data?.stop_reason === 'max_tokens') console.warn('[dossier-bg] writer hit max_tokens — report may be truncated')
  return { data, text: textParts.join(''), usedTools: tools }
}

// Stage 3 — QA. Sonnet 5.5 reads the finished report and returns structured
// flags; rendered as the "VERIFICATION FLAGS" block the app already shows.
// Returns { count, markdown, identityRisk } or null. Never throws.
async function runQaPass({ content, candidateName, officeLine, identity, userId }) {
  if (!ANTHROPIC_API_KEY || !content) return null
  const ctrl = new AbortController()
  const to = setTimeout(() => ctrl.abort(), 120000)
  try {
    const res = await claudeFetch({ apiKey: ANTHROPIC_API_KEY, signal: ctrl.signal, body: {
      model: MODELS.CLAUDE_BALANCED,
      max_tokens: 6000,
      output_config: { effort: 'medium' },
      system: QA_SYSTEM,
      messages: [{ role: 'user', content: qaPrompt({ content: content.slice(0, 120000), candidateName, officeLine, identity }) }],
    } })
    if (!res.ok) { console.warn(`[dossier-bg] QA pass HTTP ${res.status}`); return null }
    const d = await res.json()
    meterClaude({ userId, endpoint: 'profiler', model: MODELS.CLAUDE_BALANCED, data: d })
    const out = parseJsonObject(claudeText(d))
    const flags = Array.isArray(out?.flags) ? out.flags.filter(f => f && typeof f === 'object' && f.issue).slice(0, 15) : []
    if (!flags.length) return null
    const sev = { high: 0, medium: 1, low: 2 }
    flags.sort((a, b) => (sev[a.severity] ?? 3) - (sev[b.severity] ?? 3))
    const label = (f) => `**${String(f.severity || 'medium').toUpperCase()}** · ${f.section ? `Section ${f.section}` : 'Snapshot'} · ${String(f.type || 'issue').replace(/_/g, ' ')}`
    const lines = flags.map(f => `- ${label(f)}: ${String(f.issue).slice(0, 300)}${f.claim ? ` — “${String(f.claim).slice(0, 160)}”` : ''}`)
    if (out.identity_risk && out.identity_risk !== 'none') lines.unshift(`- **IDENTITY RISK: ${String(out.identity_risk).toUpperCase()}** — some records may belong to a different person with this name. Confirm identity before use.`)
    return { count: flags.length, markdown: lines.join('\n'), identityRisk: out.identity_risk || 'none' }
  } catch (e) {
    console.error('[dossier-bg] QA pass failed:', e.message)
    return null
  } finally { clearTimeout(to) }
}


// ─── #10: Change detection — extract new items vs previous dossier ────────────
function extractSection1Headlines(content) {
  const s1 = content.match(/## SECTION 1[\s\S]*?(?=## SECTION 2|$)/i)?.[0] || ''
  const headlines = []
  for (const m of s1.matchAll(/^### (.+)$/gm)) {
    const title = m[1].replace(/\[([^\]]+)\]\([^)]+\)/, '$1').replace(/\*\*/g, '').trim()
    if (title && !title.startsWith('NOT FOUND')) headlines.push(title)
  }
  return headlines
}

function extractSection6Items(content) {
  const s6 = content.match(/## SECTION 6[\s\S]*?(?=## SECTION 7|$)/i)?.[0] || ''
  const items = []
  for (const m of s6.matchAll(/^\|\s*([^|]{5,}?)\s*\|/gm)) {
    const cell = m[1].replace(/\*\*/g, '').trim()
    if (cell && cell !== 'Issue' && cell.length > 5) items.push(cell)
  }
  return [...new Set(items)].slice(0, 20)
}

async function detectChanges(candidateId, newContent) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !candidateId) return null
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/dossiers?candidate_id=eq.${candidateId}&order=generated_at.desc&limit=2`,
      { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } }
    )
    const dossiers = await res.json()
    if (!Array.isArray(dossiers) || dossiers.length < 2) return null
    const prevContent = dossiers[1].content || ''
    if (!prevContent) return null

    const prevHeadlines = new Set(extractSection1Headlines(prevContent))
    const newHeadlines = extractSection1Headlines(newContent)
    const newNewsItems = newHeadlines.filter(h => !prevHeadlines.has(h))

    const prevControversies = new Set(extractSection6Items(prevContent))
    const newControversies = extractSection6Items(newContent)
    const newControversyItems = newControversies.filter(c => !prevControversies.has(c))

    if (newNewsItems.length === 0 && newControversyItems.length === 0) return null
    const parts = []
    if (newNewsItems.length > 0) parts.push(`${newNewsItems.length} new news item(s): ${newNewsItems.slice(0, 3).join('; ')}${newNewsItems.length > 3 ? '...' : ''}`)
    if (newControversyItems.length > 0) parts.push(`${newControversyItems.length} new controversy item(s): ${newControversyItems.slice(0, 2).join('; ')}${newControversyItems.length > 2 ? '...' : ''}`)
    return parts.join(' | ')
  } catch (e) { console.error('[dossier-bg] Change detection failed:', e.message); return null }
}

// ─── Parse CANDIDATE_UPDATES JSON block from dossier content ─────────────────
function parseCandidateUpdates(content) {
  if (!content) return { content, updates: null }
  const match = content.match(/CANDIDATE_UPDATES:\s*\n?\s*```json\s*([\s\S]*?)```/i)
    || content.match(/CANDIDATE_UPDATES:\s*\n?\s*(\{[\s\S]*?\})\s*(?=\n---|\n##|$)/i)
  if (!match) return { content, updates: null }
  // Strip the block from stored content regardless of whether we can parse it
  // Strip from the block's start — the model may or may not emit the
  // "## CANDIDATE UPDATES" header or the json fence before "CANDIDATE_UPDATES:".
  const cutAt = (() => {
    const h = content.search(/\n*---\s*\n## CANDIDATE UPDATES/i)
    const k = content.search(/\n*CANDIDATE_UPDATES:/i)
    const cands = [h, k].filter(i => i >= 0)
    return cands.length ? Math.min(...cands) : -1
  })()
  const cleaned = (cutAt >= 0 ? content.slice(0, cutAt) : content).trim()
  try {
    const raw = match[1].trim()
    const updates = JSON.parse(raw)
    return { content: cleaned, updates }
  } catch (e) {
    console.warn('[dossier-bg] Could not parse CANDIDATE_UPDATES JSON:', e.message)
    return { content: cleaned, updates: null }
  }
}

// ─── Apply verified party/status corrections to candidates table ──────────────
async function applyCandidateUpdates(candidateId, currentCandidate, updates) {
  if (!candidateId || !updates || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) return
  const VALID_STATUSES = ['exploring', 'declared', 'primary_winner', 'general', 'elected', 'lost', 'withdrawn']
  const HIGH_CONFIDENCE = ['KNOWN', 'Confirmed']
  const patch = {}

  // Party — only update if high confidence AND actually different from current
  if (
    updates.verified_party &&
    updates.verified_party !== 'null' &&
    updates.verified_party !== null &&
    HIGH_CONFIDENCE.includes(updates.party_confidence) &&
    updates.verified_party !== currentCandidate?.party
  ) {
    patch.party = updates.verified_party
    console.log(`[dossier-bg] Party correction: "${currentCandidate?.party}" → "${updates.verified_party}" (${updates.party_confidence})`)
  }

  // Status — only update if valid enum, different, AND has supporting evidence note
  if (
    updates.verified_status &&
    updates.verified_status !== 'null' &&
    updates.verified_status !== null &&
    VALID_STATUSES.includes(updates.verified_status) &&
    updates.verified_status !== currentCandidate?.status &&
    updates.status_notes &&
    updates.status_notes !== 'null'
  ) {
    patch.status = updates.verified_status
    console.log(`[dossier-bg] Status correction: "${currentCandidate?.status}" → "${updates.verified_status}" (${updates.status_notes})`)
  }

  if (Object.keys(patch).length === 0) {
    console.log('[dossier-bg] No candidate updates warranted')
    return
  }

  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/candidates?id=eq.${candidateId}`,
      {
        method: 'PATCH',
        headers: {
          apikey: SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify(patch),
      }
    )
    if (res.ok) {
      console.log(`[dossier-bg] Candidate ${candidateId} auto-updated:`, patch)
    } else {
      const err = await res.text()
      console.error(`[dossier-bg] Candidate update failed: ${res.status} ${err.slice(0, 200)}`)
    }
  } catch (e) {
    console.error(`[dossier-bg] Candidate update error: ${e.message}`)
  }
}


// ─── Refresh diff (candidate profile redesign) ───────────────────────────────
// Deterministic section-level diff of the new dossier vs the previous one,
// computed ONCE here and persisted on the dossier row (never per render).
const DIFF_SECTION_LABELS = {
  1: 'News Feed', 2: 'Biography', 3: 'Timeline', 4: 'Political Record',
  5: 'Financial', 6: 'Opposition', 7: 'Platform', 8: 'Affiliations',
  9: 'Allies', 10: 'Social Media', 11: 'District', 12: 'SWOT',
  13: 'Attack & Defense', 14: 'Sources',
}
function diffSplitSections(content) {
  const map = {}
  for (const m of String(content || '').matchAll(/##\s*SECTION\s*(\d+)[^\n]*\n([\s\S]*?)(?=##\s*SECTION\s*\d+|$)/gi)) {
    map[+m[1]] = m[2]
  }
  return map
}
function diffNormLines(t) {
  return new Set(String(t || '').split('\n').map(l => l.trim().toLowerCase().replace(/\s+/g, ' ')).filter(l => l.length > 20))
}
async function buildRefreshDiff(dossierId, candidateId, newContent) {
  try {
    const prevRes = await fetch(
      `${SUPABASE_URL}/rest/v1/dossiers?candidate_id=eq.${candidateId}&order=generated_at.desc&limit=2&select=id,content`,
      { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } }
    )
    const rows = await prevRes.json()
    const prev = Array.isArray(rows) ? rows.find(r => r.id !== dossierId) : null
    if (!prev?.content) { console.log('[dossier-bg] refresh_diff skipped — no previous dossier'); return }
    const A = diffSplitSections(prev.content), B = diffSplitSections(newContent)
    const nums = [...new Set([...Object.keys(A), ...Object.keys(B)].map(Number))].sort((a, b) => a - b)
    const sections = []
    for (const n of nums) {
      const label = DIFF_SECTION_LABELS[n] || `Section ${n}`
      const pa = diffNormLines(A[n]), pb = diffNormLines(B[n])
      const added = [...pb].filter(l => !pa.has(l)).length
      const removed = [...pa].filter(l => !pb.has(l)).length
      let status = 'unchanged', note = 'No change'
      if (!(n in A) && (n in B))      { status = 'new';     note = 'Section added in this refresh' }
      else if ((n in A) && !(n in B)) { status = 'updated'; note = 'Section no longer present' }
      else if (added >= 3)            { status = 'new';     note = `${added} new lines of intelligence` }
      else if (added > 0)             { status = 'updated'; note = `${added} new line${added === 1 ? '' : 's'}` }
      else if (removed > 0)           { status = 'updated'; note = 'Content revised' }
      sections.push({ section: `SECTION ${n}`, label, status, new_items: status === 'unchanged' ? 0 : added, note })
    }
    const diff = { computed_at: new Date().toISOString(), prev_dossier_id: prev.id, sections }
    await fetch(`${SUPABASE_URL}/rest/v1/dossiers?id=eq.${dossierId}`, {
      method: 'PATCH',
      headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ refresh_diff: diff }),
    })
    console.log(`[dossier-bg] refresh_diff stored (${sections.length} sections)`)
  } catch (e) { console.error('[dossier-bg] buildRefreshDiff error:', e.message) }
}

// ─── Generation progress (Profiler redesign) ─────────────────────────────────
// Real per-stage progress the library UI polls. Stages:
//   1 Identifying the person · 2 Searching press & filings ·
//   3 Drafting 14 sections · 4 Verifying claims. status: running|done|error
async function reportStage(candidateId, stage, status = 'running') {
  if (!candidateId || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) return
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/dossier_generation_progress`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify({ candidate_id: candidateId, stage, status, updated_at: new Date().toISOString() }),
    })
  } catch (e) { console.warn('[dossier-bg] reportStage failed:', e.message) }
}

// ─── Weekly digest (active monitoring v2) ────────────────────────────────────
// Compares the new profile against the previous one with a cheap Haiku pass
// and stores a structured week-in-review on the dossier row:
//   weekly_digest = { summary, items: [{ category, title, note }] }
// Categories: news | social | podcast | controversy | polling | endorsement | other
async function buildWeeklyDigest(dossierId, candidateId, newContent, candidateName, userId) {
  try {
    if (!ANTHROPIC_API_KEY) return
    const prevRes = await fetch(
      `${SUPABASE_URL}/rest/v1/dossiers?candidate_id=eq.${candidateId}&order=generated_at.desc&limit=2&select=id,content`,
      { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } }
    )
    const rows = await prevRes.json()
    const prev = Array.isArray(rows) ? rows.find(r => r.id !== dossierId) : null
    if (!prev?.content) { console.log('[dossier-bg] digest skipped — no previous dossier'); return }

    const clip = (s, n) => String(s || '').slice(0, n)
    const res = await claudeFetch({ apiKey: ANTHROPIC_API_KEY, body: {
        model: HAIKU_MODEL,
        max_tokens: 1500,
        ...CLAUDE.FAST,
        messages: [{
          role: 'user',
          content: `Compare the PREVIOUS and NEW intelligence profiles for ${candidateName} and produce a week-in-review of genuinely NEW developments (items in NEW that are absent from PREVIOUS). Cover: news articles, podcast/radio/TV appearances, social media activity, controversies, polling, endorsements.

Return STRICT JSON only, no prose, no markdown fences:
{"summary": "2-3 plain-English sentences a busy campaign manager can skim — what actually happened this week; if nothing meaningful changed say so plainly", "items": [{"category": "news|social|podcast|controversy|polling|endorsement|other", "title": "short headline", "note": "one sentence", "source": "publication or platform name from the profile, or null", "date": "YYYY-MM-DD if the profile states one, else null — never guess"}]}

Max 8 items, most important first. Empty items array if nothing new.

PREVIOUS PROFILE:
${clip(prev.content, 14000)}

NEW PROFILE:
${clip(newContent, 14000)}`
        }],
      } })
    if (!res.ok) { console.error('[dossier-bg] digest LLM failed:', res.status); return }
    const d = await res.json()
    logAiUsage({ userId, endpoint: 'monitoring', provider: 'anthropic', model: HAIKU_MODEL,
      inputTokens: d?.usage?.input_tokens || 0, outputTokens: d?.usage?.output_tokens || 0 })
    const raw = claudeText(d).replace(/^```json?\s*/i, '').replace(/```\s*$/, '').trim()
    let digest
    try { digest = JSON.parse(raw) } catch { console.error('[dossier-bg] digest JSON unparseable'); return }
    if (!digest || typeof digest.summary !== 'string') return
    digest.items = (Array.isArray(digest.items) ? digest.items : []).slice(0, 8).map(i => ({
      category: String(i.category || 'other').slice(0, 20),
      title: String(i.title || '').slice(0, 160),
      note: String(i.note || '').slice(0, 300),
      source: i.source ? String(i.source).slice(0, 80) : null,
      date: /^\d{4}-\d{2}-\d{2}$/.test(String(i.date || '')) ? i.date : null,
    }))
    digest.summary = digest.summary.slice(0, 600)
    digest.generated_at = new Date().toISOString()

    const patch = await fetch(`${SUPABASE_URL}/rest/v1/dossiers?id=eq.${dossierId}`, {
      method: 'PATCH',
      headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ weekly_digest: digest }),
    })
    console.log(`[dossier-bg] weekly digest stored (${digest.items.length} items): ${patch.ok}`)
  } catch (e) {
    console.error('[dossier-bg] buildWeeklyDigest error:', e.message)
  }
}

exports.handler = async (event) => {
  const handlerStartedAt = Date.now()
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

  let body
  try {
    body = JSON.parse(event.body)
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }
  }

  // Test mode — ADMIN ONLY (verifies API key / pings Claude, which costs money)
  if (body.test === true) {
    const testAuth = event.headers?.authorization || event.headers?.Authorization
      || (typeof body.auth_header === 'string' ? body.auth_header : null)
    const testUser = await verifyUser(testAuth)
    if (!testUser || !ADMIN_EMAILS.includes((testUser.email || '').toLowerCase())) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Not authorized' }) }
    }
    if (!ANTHROPIC_API_KEY) {
      return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: 'ANTHROPIC_API_KEY is not set.' }) }
    }
    if (body.deep) {
      try {
        const ctrl = new AbortController()
        setTimeout(() => ctrl.abort(), 15000)
        const t0 = Date.now()
        const r = await claudeFetch({ apiKey: ANTHROPIC_API_KEY, signal: ctrl.signal, body: {
            model: CLAUDE_MODEL,
            max_tokens: claudeMaxTokens(512),
            ...CLAUDE.QUALITY,
            messages: [{ role: 'user', content: 'Say OK' }],
          } })
        const ms = Date.now() - t0
        if (!r.ok) {
          const errText = await r.text()
          return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: `API ${r.status}: ${errText.slice(0, 300)}`, ms }) }
        }
        const d = await r.json()
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, reply: claudeText(d), ms, model: CLAUDE_MODEL }) }
      } catch (e) {
        return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: e.message, hint: 'API call failed or timed out' }) }
      }
    }
    // Effective model ids (admin-only diagnostic): shows whether a stale
    // env override is still pinning an old model somewhere.
    const models = {
      profiles: CLAUDE_MODEL, grok: GROK_MODEL, fast: HAIKU_MODEL,
      events_and_history: process.env.CLAUDE_RESEARCH_MODEL || MODELS.CLAUDE_QUALITY,
      polling_synth: process.env.POLLING_SYNTH_MODEL || MODELS.CLAUDE_QUALITY,
      polling_grok: process.env.POLLING_GROK_MODEL || MODELS.GROK,
      polling_research: process.env.POLLING_RESEARCH_MODEL || MODELS.PPLX_PRO,
      polling_gemini: process.env.POLLING_GEMINI_MODEL || MODELS.GEMINI,
      env_overrides: ['CLAUDE_RESEARCH_MODEL', 'POLLING_SYNTH_MODEL', 'POLLING_GROK_MODEL', 'POLLING_RESEARCH_MODEL', 'POLLING_SOCIAL_MODEL', 'POLLING_GEMINI_MODEL'].filter(k => process.env[k]),
    }
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, key_set: true, key_prefix: ANTHROPIC_API_KEY.slice(0, 8) + '...', perplexity: !!PERPLEXITY_API_KEY, xai: !!process.env.XAI_API_KEY, gemini: !!process.env.GEMINI_API_KEY, models }) }
  }

  if (!ANTHROPIC_API_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY is not configured.' }) }
  }

  // Verify auth and determine plan.
  // The caller's JWT arrives either as a direct Authorization header or in
  // body.auth_header (forwarded by generate-dossier.js — Netlify background
  // invocations don't carry the client's headers). Either way it MUST verify;
  // unauthenticated callers are rejected before any LLM spend.
  // ── Internal trigger path (audit fix #11) ──────────────────────────────────
  // The weekly auto-regenerate cron used to authenticate with the raw
  // service-role key, which verifyUser() rejects — every run 401'd (invisibly,
  // because Netlify answers background invocations with 202 before the handler
  // runs) and the paid weekly refresh was silently dead since July 5. Internal
  // calls now carry the shared trigger secret; section gating resolves from
  // the candidate's OWNER, and quota/rate-limit/credits are skipped (the cron
  // caps its own batch and saves with generated_by = null).
  const internalSecret = process.env.ADMIN_TRIGGER_SECRET
  const providedInternal = event.headers?.['x-internal-trigger'] || event.headers?.['X-Internal-Trigger']
    || (typeof body.internal_trigger === 'string' ? body.internal_trigger : null)
  const isInternalTrigger = Boolean(internalSecret && providedInternal && safeEqual(providedInternal, internalSecret))

  let user
  if (isInternalTrigger) {
    user = await getCandidateOwner(body.candidate_id)
    if (!user) console.warn('[dossier-bg] Internal trigger: no owner resolved — gating by top plan (monitored candidate)')
  } else {
    const authHeader = event.headers?.authorization || event.headers?.Authorization
      || (typeof body.auth_header === 'string' ? body.auth_header : null)
    user = await verifyUser(authHeader)
    if (!user) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Not authenticated' }) }
    }
  }

  // Monitoring/weekly refresh is a paid feature — if the owner can't be
  // resolved on an internal run, keep the previously-generated depth rather
  // than overwriting a paying user's dossier with the Scout upsell teaser.
  const entitlement = isInternalTrigger && !user
    ? { plan: 'a_campaign', bracket: 'ent' }
    : await getUserEntitlement(user)
  const userPlan = toLegacyBucket(entitlement.plan)
  const canViewSection6 = SECTION6_TIERS.includes(userPlan)
  const isAdminCaller = !isInternalTrigger && ADMIN_EMAILS.includes(user?.email?.toLowerCase())

  // ── Durable per-user rate limit (defense in depth if invoked directly) ─────
  if (!isInternalTrigger) {
    const limited = await enforceRateLimit(user.id, 'generate-dossier-background', headers)
    if (limited) return limited
  }

  // ── Audit fix (#1): server-side monthly profile-limit enforcement ──────────
  // Previously only the client checked the limit — a direct POST to this
  // endpoint generated unlimited profiles (each a multi-dollar LLM spend) on
  // any plan, including free Scout. Enforce base allotment + banked credits
  // here, before any research queries fire. Internal (cron) runs are exempt:
  // they save with generated_by = null and never count toward the quota.
  if (!isAdminCaller && !isInternalTrigger) {
    try {
      const base = getMonthlyBase(entitlement.plan, entitlement.bracket)
      if (Number.isFinite(base)) {
        const bank = Math.max(0, Number(user?.app_metadata?.profile_credits) || 0)
        const monthCount = await countMonthToDateDossiers(user.id)
        if (monthCount >= base + bank) {
          console.log(`[dossier-bg] Limit reached for ${user.id}: ${monthCount}/${base}+${bank} (${entitlement.plan}/${entitlement.bracket})`)
          return {
            statusCode: 403,
            headers,
            body: JSON.stringify({
              error: `You've used all ${base + bank} of your profile generations for this month. Upgrade your plan or purchase profile credits to generate more.`,
              limit: base + bank,
              used: monthCount,
            }),
          }
        }
      }
    } catch (e) {
      // Fail closed on count errors — an attacker shouldn't get free generations
      // by breaking the counter. Legit users can retry.
      console.error('[dossier-bg] Limit check failed:', e.message)
      return { statusCode: 503, headers, body: JSON.stringify({ error: 'Could not verify your profile allotment — please try again in a moment.' }) }
    }
  }

  const { candidate } = body
  if (!candidate || typeof candidate !== 'object') {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'No candidate provided' }) }
  }

  // Sanitize all candidate fields
  const safe = {
    name:               sanitize(candidate.name,               150),
    party:              sanitize(candidate.party,              60),
    status:             sanitize(candidate.status,             60),
    occupation:         sanitize(candidate.occupation,         150),
    employer:           sanitize(candidate.employer,           150),
    website:            sanitize(candidate.website,            300),
    email:              sanitize(candidate.email,              254),
    phone:              sanitize(candidate.phone,              30),
    campaign_committee: sanitize(candidate.campaign_committee, 200),
    campaign_manager:   sanitize(candidate.campaign_manager,   150),
    bio_summary:        sanitize(candidate.bio_summary,        2000),
    research_context:   sanitize(candidate.research_context,   1000),
    twitter_handle:     sanitize(candidate.twitter_handle,     80),
    facebook_url:       sanitize(candidate.facebook_url,       300),
    instagram_handle:   sanitize(candidate.instagram_handle,   80),
    officeName:         sanitize(candidate.office?.name,       150),
    districtName:       sanitize(candidate.office?.district_name, 100),
    county:             sanitize(candidate.office?.county,        60),
    electionName:       sanitize(candidate.election?.name,     150),
  }

  if (!safe.name) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Candidate name is required' }) }
  }

  const officeLine = safe.officeName
    ? `${safe.officeName}${safe.districtName ? ` (${safe.districtName})` : ''}`
    : 'Unknown Office'

  // Compute research mode from candidate status and incumbent flag
  const isIncumbent = !!candidate.is_incumbent
  const ctx         = safe.research_context || null
  const mode        = getResearchMode(safe.status?.toLowerCase(), isIncumbent, !!safe.officeName)
  console.log(`[dossier-bg] Research mode: ${mode} (status=${safe.status}, incumbent=${isIncumbent}, hasOffice=${!!safe.officeName})`)

  // County-specific local sources (same dataset the Events researcher uses)
  let localSourcesNote = ''
  try {
    const countySources = require('./_county-sources.json')
    const hay = `${safe.county} ${safe.districtName}`.toLowerCase()
    const countyKey = Object.keys(countySources).find(k => hay.includes(k.toLowerCase()))
    if (countyKey) {
      const cs = countySources[countyKey]
      const outlets = [...(cs.newspapers || []), ...(cs.broadcast || [])].slice(0, 8).map(o => o.split(' — ')[0]).join('; ')
      if (outlets) localSourcesNote = ` PRIORITY LOCAL OUTLETS for ${countyKey} County (search each by name): ${outlets}.`
    }
  } catch (e) { /* dataset optional */ }

  // ─── Fire all Perplexity + Grok queries in parallel (#2, #3) ─────────────
  const perplexityPromise   = fetchPerplexityNews(safe.name, officeLine, safe.districtName, ctx, mode, localSourcesNote)
  // v1.20.1: second, hyper-local-only news pass over the county source list
  const localNewsPromise    = fetchPerplexityLocalNews(safe.name, officeLine, safe.districtName, ctx, mode, localSourcesNote)
  // fetchPerplexityIncumbent retired — fetchPerplexityPoliticalRecord (incumbent mode) covers the same ground
  const incumbentPromise    = Promise.resolve(null)
  reportStage(body.candidate_id, 1)                       // Identifying the person
  const identityPromise     = fetchPerplexityIdentity(safe.name, officeLine, safe.districtName, ctx, mode)
  identityPromise.finally(() => reportStage(body.candidate_id, 2))  // Searching press & filings
  // v5: Sonnet 5.5 + web_search resolves WHO this is and collects canonical
  // URLs the writer may web_fetch (runs in parallel with the packets).
  const identityCardPromise = resolveIdentity({ safe, officeLine, mode, userId: isInternalTrigger ? null : (user?.id || null) })
  const financePromise      = fetchPerplexityCampaignFinance(safe.name, officeLine, safe.districtName, ctx, mode)
  const politicalPromise    = fetchPerplexityPoliticalRecord(safe.name, officeLine, safe.districtName, ctx, mode)
  const affiliationsPromise = fetchPerplexityAffiliations(safe.name, officeLine, safe.districtName, ctx, mode)
  const socialMediaPromise  = fetchPerplexitySocialMedia(safe.name, officeLine, safe.districtName, ctx, mode)
  // Grok: real-time X sentiment + breaking coverage (runs in parallel with Perplexity)
  const grokPromise         = fetchGrokXIntelligence(safe.name, officeLine, safe.districtName, safe.twitter_handle, ctx, mode)
  // Official government records (FEC / CourtListener / LegiScan) — direct API ground truth
  // Include user research-context in the federal-office check so FEC still fires
  // for congressional candidates whose office isn't linked in the DB.
  const officialPromise     = fetchOfficialRecords(safe.name, `${officeLine} ${ctx || ''} ${safe.occupation || ''}`).catch(() => null)

  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })

  // ─── Wait for all Perplexity + Grok results in parallel ─────────────────
  let perplexityNews = null, perplexityIncumbent = null, localNews
  let identityData = null, financeData = null, politicalData = null, affiliationsData = null, socialMediaData = null
  let grokData = null, officialData = null
  try {
    ;[perplexityNews, perplexityIncumbent, identityData, financeData, politicalData, affiliationsData, socialMediaData, grokData, officialData, localNews] =
      await Promise.all([perplexityPromise, incumbentPromise, identityPromise, financePromise, politicalPromise, affiliationsPromise, socialMediaPromise, grokPromise, officialPromise, localNewsPromise])
    reportStage(body.candidate_id, 3)                       // Drafting 14 sections
    // Merge the hyper-local pass into the news research block
    if (localNews) {
      perplexityNews = perplexityNews
        ? `${perplexityNews}\n\n— ADDITIONAL HYPER-LOCAL COVERAGE (county weeklies, city pages, local broadcast) —\n\n${localNews}`
        : localNews
    }

    // v1.20: cost metering — one row per successful research call. Perplexity's
    // per-request search fee dominates its token cost, so these are flat-fee
    // estimates (marked estimated=true); Grok includes server-side search tools.
    {
      const uid = user?.id || null
      const pplxSuccesses = [perplexityNews, localNews, identityData, financeData, politicalData, affiliationsData, socialMediaData].filter(Boolean).length
      for (let i = 0; i < pplxSuccesses; i++) {
        logAiUsage({ userId: uid, endpoint: 'profiler', provider: 'perplexity', model: 'sonar-pro', flatUsd: 0.004, estimated: true })
      }
      if (grokData) logAiUsage({ userId: uid, endpoint: 'profiler', provider: 'xai', model: GROK_MODEL, flatUsd: 0.03, estimated: true })
    }
    const stats = [
      perplexityNews && `news:${perplexityNews.length}`,
      perplexityIncumbent && `incumbent:${perplexityIncumbent.length}`,
      identityData && `identity:${identityData.length}`,
      financeData && `finance:${financeData.length}`,
      politicalData && `political:${politicalData.length}`,
      affiliationsData && `affiliations:${affiliationsData.length}`,
      socialMediaData && `social:${socialMediaData.length}`,
      grokData && `grok:${grokData.length}`,
      officialData && `official:${officialData.length}`,
    ].filter(Boolean)
    console.log(`[dossier-bg] Research results: ${stats.join(', ') || 'none'}`)
  } catch (e) {
    console.log(`[dossier-bg] Research fetch error: ${e.message}`)
  }


  // Identity card: the Sonnet resolver ran alongside the research fan-out.
  let identityCard = null
  try { identityCard = await identityCardPromise } catch (e) { console.warn('[dossier-bg] identity stage failed:', e.message) }
  // A candidate with no linked office defaults to PROSPECT mode from the
  // record alone; if the identity stage found them on a ballot or in office,
  // use that instead so the writer researches the right thing.
  const { mode: writerMode, officeLine: writerOfficeLine } = refineModeFromIdentity({ mode, officeLine, safe, card: identityCard })
  if (writerMode !== mode || writerOfficeLine !== officeLine) console.log(`[dossier-bg] mode refined by identity card: ${mode} → ${writerMode}; office: ${officeLine} → ${writerOfficeLine}`)

  // Team notes & documents — enters the prompt ONLY through the single
  // AI-access gate (_candidate-context.js). Locked candidate => empty block.
  let aiNotesBlock = ''
  try {
    const { getCandidateAiContext, formatAiContextBlock } = require('./_candidate-context')
    const teamCtx = await getCandidateAiContext(body.candidate_id)
    aiNotesBlock = formatAiContextBlock(teamCtx, safe.name)
  } catch (e) { console.warn('[dossier-bg] team-notes context skipped:', e.message) }

  // ─── Writer prompt (v5 — _profile-prompt.js) ────────────────────────────
  const userPrompt = buildWriterUserPrompt({
    safe, officeLine: writerOfficeLine, mode: writerMode, canViewSection6, today,
    identity: identityCard,
    packets: {
      official: officialData, identity: identityData, news: perplexityNews, incumbent: perplexityIncumbent,
      political: politicalData, finance: financeData, affiliations: affiliationsData, social: socialMediaData, grok: grokData,
    },
    teamNotes: aiNotesBlock,
    budget: WRITER_BUDGET,
  })

  const { candidate_id } = body
  // Verified user ID, never from the body. Internal (cron) runs save with
  // null so auto-regenerated dossiers stay excluded from the monthly quota
  // count and never consume purchased credits.
  const user_id = isInternalTrigger ? null : (user?.id || null)

  try {
    const perplexityCount = [perplexityNews, identityData, financeData, politicalData, affiliationsData, perplexityIncumbent, socialMediaData].filter(Boolean).length
    console.log(`[dossier-bg] Starting: model=${CLAUDE_MODEL}, candidate=${safe.name}, perplexity_sources=${perplexityCount}/7`)
    const startTime = Date.now()

    // ─── Writer: Opus 5.5 with live web_search + web_fetch ─────────────────
    // Server tools run inside the API's own loop; a long turn can come back
    // with stop_reason "pause_turn", which we continue (same tools, content
    // passed back as-is) a bounded number of times.
    const { text: writerText, usedTools } = await runWriter({ userPrompt, userId: user_id, deadlineMs: handlerStartedAt + FUNCTION_BUDGET_MS })
    console.log(`[dossier-bg] Claude responded in ${Date.now() - startTime}ms (tools=${usedTools.map(t => t.name).join('+')}, ${Math.round(remainingMs(handlerStartedAt) / 1000)}s left in the function)`)
    reportStage(body.candidate_id, 4)                       // Verifying claims
    let content = writerText
    // Strip any AI reasoning/thinking tags that should never be stored or shown to users
    if (content) {
      content = content.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
      content = content.replace(/<antThinking>[\s\S]*?<\/antThinking>/gi, '')
      content = content.replace(/<ant[Tt]hinking>[\s\S]*?<\/ant[Tt]hinking>/gi, '')
      content = content.trim()
    }
    console.log(`[dossier-bg] Got content: ${content ? content.length + ' chars' : 'EMPTY'}`)
    if (!content) throw new Error('No content returned from Claude')

    // ─── Extract CANDIDATE_UPDATES block and apply verified corrections ────
    const { content: strippedContent, updates: candidateUpdates } = parseCandidateUpdates(content)
    content = strippedContent
    if (candidateUpdates && candidate_id) {
      // Fire-and-forget — don't block dossier save on the update
      applyCandidateUpdates(candidate_id, candidate, candidateUpdates).catch(e =>
        console.error('[dossier-bg] applyCandidateUpdates error:', e.message)
      )
    }

    // ─── #16: Validate all 14 sections are present ─────────────────────────
    const sectionCount = countSections(content)
    console.log(`[dossier-bg] Sections found: ${sectionCount}/14`)
    if (sectionCount < 10) {
      console.log('[dossier-bg] Too few sections — retrying with continuation prompt')
      const retryPrompt = `The profile you just generated for ${safe.name} was cut short — only ${sectionCount} of 14 sections were included. Continue from where it was cut off and complete ALL missing sections. Start with the next missing ## SECTION header and continue through ## SECTION 14, then the CANDIDATE_UPDATES block. Do not repeat sections already written.\n\nPrevious output (partial):\n${content.slice(-3000)}`
      try {
        const { text: continuation } = await runWriter({ userPrompt: retryPrompt, userId: user_id, maxContinuations: 1, deadlineMs: handlerStartedAt + FUNCTION_BUDGET_MS })
        if (continuation) {
          const { content: contStripped, updates: contUpdates } = parseCandidateUpdates(continuation)
          content = content + '\n\n' + contStripped
          if (contUpdates && !candidateUpdates && candidate_id) applyCandidateUpdates(candidate_id, candidate, contUpdates).catch(() => {})
          console.log(`[dossier-bg] After continuation: ${countSections(content)} sections, ${content.length} chars`)
        }
      } catch (e) { console.error('[dossier-bg] continuation failed:', e.message) }
    }

    // ─── QA pass: Sonnet 5.5 reviews the whole profile ───────────────────────
    const verificationFlags = remainingMs(handlerStartedAt) > QA_MIN_REMAINING_MS
      ? await runQaPass({ content, candidateName: safe.name, officeLine: writerOfficeLine, identity: identityCard, userId: user_id })
      : (console.warn(`[dossier-bg] QA pass skipped — ${Math.round(remainingMs(handlerStartedAt) / 1000)}s left`), null)
    if (verificationFlags) {
      console.log(`[dossier-bg] QA flags: ${verificationFlags.count}`)
      content = content + `\n\n---\n## ⚠️ VERIFICATION FLAGS (AI Quality Check)\n*The following potential issues were flagged by a secondary review pass. Verify before use.*\n\n${verificationFlags.markdown}`
    }


    // ─── #10: Change detection vs previous dossier ──────────────────────────
    const changeSummary = await detectChanges(candidate_id, content)
    if (changeSummary) console.log(`[dossier-bg] Changes detected: ${changeSummary}`)

    // ─── Audit fix (#10): enforce Scout's lite profile at STORAGE time ──────
    // Previously the full 14-section paid dossier was stored and shipped to
    // Scout browsers where locked sections were merely CSS-blurred — Copy,
    // Export PDF, devtools, or a direct table select handed over the entire
    // paid report. Locked sections are now replaced server-side before the
    // row is ever written, so paid content never reaches a free client.
    if (userPlan === 'scout') {
      content = applyScoutLiteGate(content)
      console.log(`[dossier-bg] Scout lite gate applied (${countSections(content)} sections retained/templated)`)
    }

    // ─── Reasoning-leak guard (Profiler redesign) ──────────────────────────
    // Anything before the first "## SECTION" is model narration, never dossier
    // content. Strip it; if it is substantive and no structured research_note
    // was emitted, preserve it AS the research note so the finding survives
    // as data instead of leaking into the page.
    let researchNote = candidateUpdates?.research_note && typeof candidateUpdates.research_note === 'object'
      ? {
          finding: String(candidateUpdates.research_note.finding || '').slice(0, 600),
          evidence: String(candidateUpdates.research_note.evidence || '').slice(0, 400),
          suggested_status: candidateUpdates.research_note.suggested_status || null,
          source: 'structured',
        }
      : null
    if (researchNote && !researchNote.finding) researchNote = null
    {
      // The report starts at "## PROFILE SNAPSHOT" (v5) or, failing that, at the first section header.
      const snapAt = content.search(/^##\s*PROFILE SNAPSHOT/im)
      const firstSection = snapAt >= 0 ? snapAt : content.search(/^##\s*SECTION\s*\d+/im)
      if (firstSection > 0) {
        const preamble = content.slice(0, firstSection).replace(/^[-#*\s]+/, '').trim()
        content = content.slice(firstSection).trim()
        if (!researchNote && preamble.length > 80) {
          researchNote = { finding: preamble.slice(0, 600), evidence: '', suggested_status: null, source: 'captured-preamble' }
          console.log('[dossier-bg] preamble narration captured as research_note')
        } else if (preamble.length) {
          console.log('[dossier-bg] stripped pre-section narration (' + preamble.length + ' chars)')
        }
      }
    }

    let savedDossierId = null
    // ─── Save to Supabase ──────────────────────────────────────────────────
    const saveRes = await fetch(`${SUPABASE_URL}/rest/v1/dossiers`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
      },
      body: JSON.stringify({
        candidate_id: candidate_id || null,
        title: `Political Profile — ${safe.name}`,
        content,
        research_note: researchNote,
        user_id: user_id || null,
        created_by: user_id || null,
        generated_by: user_id || null,
        // Extended metadata stored as JSON in notes field (if column exists)
        change_summary: changeSummary || null,
        section_count: countSections(content),
        perplexity_sources_used: perplexityCount,
        has_verification_flags: !!verificationFlags,
      }),
    })

    if (!saveRes.ok) {
      // If extended fields don't exist in schema, save without them
      const saveErr = await saveRes.text()
      console.log(`[dossier-bg] Extended save failed (${saveRes.status}): ${saveErr.slice(0, 300)} — retrying with base fields`)
      const baseRes = await fetch(`${SUPABASE_URL}/rest/v1/dossiers`, {
        method: 'POST',
        headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
        body: JSON.stringify({ candidate_id: candidate_id || null, title: `Political Profile — ${safe.name}`, content, user_id: user_id || null, created_by: user_id || null, generated_by: user_id || null }),
      })
      if (!baseRes.ok) {
        const baseErr = await baseRes.text()
        console.error(`[dossier-bg] Supabase save failed: ${baseErr.slice(0, 300)}`)
        throw new Error(`Failed to save dossier: ${baseRes.status}`)
      }
      const baseSaved = await baseRes.json()
      savedDossierId = baseSaved?.[0]?.id || null
      console.log(`[dossier-bg] Saved (base) id=${baseSaved?.[0]?.id}, total=${Date.now() - startTime}ms`)
    } else {
      const saved = await saveRes.json()
      savedDossierId = saved?.[0]?.id || null
      console.log(`[dossier-bg] Saved id=${saved?.[0]?.id}, sections=${countSections(content)}, changes=${!!changeSummary}, flags=${!!verificationFlags}, total=${Date.now() - startTime}ms`)
    }

    // ─── Weekly digest: what changed vs the previous profile ────────────────
    // Powers the Monday monitoring email and the in-app "What's new" card.
    if (savedDossierId && candidate_id) {
      await buildWeeklyDigest(savedDossierId, candidate_id, content, safe.name, user_id)
      await buildRefreshDiff(savedDossierId, candidate_id, content)
      await reportStage(candidate_id, 4, 'done')
    }

    // ─── Consume a purchased credit if this exceeded the free monthly allotment ─
    await consumeProfileCreditIfOverage(user_id, entitlement.plan, entitlement.bracket)

    // ─── Dossier-ready notification email ─────────────────────────────────────
    try {
      const prefs = await getNotificationPrefs(user_id)
      if (user_id && prefs.dossier_ready && user?.email) {
        const officeNote = officeLine && officeLine !== 'Unknown Office' ? ` (${officeLine})` : ''
        await sendEmail({
          to: user.email,
          subject: `Your profile for ${safe.name} is ready`,
          title: 'Your profile is ready',
          preheader: `Political intelligence profile for ${safe.name} is ready to view.`,
          body: `<p>Your political intelligence profile for <strong>${safe.name}</strong>${officeNote} has been generated and is ready to view.</p><p>The profile covers all 14 research sections — news coverage, biography, political record, financial background, affiliations, social media analysis, and more.</p>`,
          ctaText: 'View Profile',
          ctaUrl: 'https://www.badgerboardwi.com/profiler',
          footerNote: 'You can manage your notification preferences in Account Settings.',
        })
        console.log(`[dossier-bg] Dossier-ready email sent to ${user.email}`)
      }
    } catch (e) { console.error('[dossier-bg] Dossier-ready email failed:', e.message) }

    return { statusCode: 200, body: '' }
  } catch (err) {
    console.error('[dossier-bg] Error:', err.message)
    reportStage(body?.candidate_id, 0, 'error')
    return { statusCode: 500, body: '' }
  }
}

// Test seam for the v5 pipeline helpers (pure functions + constants only).
exports._v5 = { parseJsonObject, remainingMs, FUNCTION_BUDGET_MS, refineModeFromIdentity, parseCandidateUpdates, WRITER_BUDGET, WRITER_EFFORT, WRITER_MAX_TOKENS, WRITER_CONTINUATIONS, runWriter, runQaPass, resolveIdentity }
