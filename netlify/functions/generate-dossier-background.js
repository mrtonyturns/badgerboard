// Netlify Background Function: generate-dossier-background
// Runs asynchronously (no HTTP timeout). Saves result directly to Supabase.
// Combined prompt: v4.1 structure (14 sections, tables) + legal compliance additions.
// ANTHROPIC_API_KEY + SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY must be set.

const { enforceRateLimit } = require('./_rate-limit')
const { logAiUsage } = require('./_ai-usage')
const ANTHROPIC_API_KEY  = process.env.ANTHROPIC_API_KEY
const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY // must be set in Netlify env vars
const XAI_API_KEY        = process.env.XAI_API_KEY        // xAI Grok — x.ai console
const SUPABASE_URL       = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const CLAUDE_MODEL       = 'claude-opus-4-8' // Opus 4.8 — profile writer (per request)
const GROK_MODEL         = 'grok-4.3'  // latest Grok — Responses API w/ server-side x_search + web_search (verified 2026-07)

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
async function queryPerplexity(systemMsg, userMsg, maxTokens = 1500, model = 'sonar') {
  if (!PERPLEXITY_API_KEY) return null
  try {
    const ctrl = new AbortController()
    // v1.20.1: 45s (was 22s) — deep sonar-pro searches were being aborted and
    // silently returned null, which is why news/social sections came up thin.
    setTimeout(() => ctrl.abort(), 45000)
    const res = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Authorization': `Bearer ${PERPLEXITY_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'system', content: systemMsg }, { role: 'user', content: userMsg }], max_tokens: maxTokens }),
    })
    if (!res.ok) { console.error(`[perplexity] ${res.status}`); return null }
    const d = await res.json()
    return d.choices?.[0]?.message?.content || null
  } catch (e) { console.error(`[perplexity] ${e.message}`); return null }
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
    const res = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Authorization': `Bearer ${PERPLEXITY_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: NEWS_SYSTEM },
          { role: 'user', content: (queries[mode] || queries.challenger) + localSources },
        ],
        max_tokens: maxTokens,
      }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    return data.choices?.[0]?.message?.content || null
  }

  // v1.20.1: 45s budget + a fast sonar retry when the deep search fails —
  // previously a 20s abort silently produced a dossier with NO news at all.
  try {
    return await runNewsSearch('sonar-pro', 3000, 45000)
  } catch (e) {
    console.error(`[perplexity/news] deep search failed (${e.message}) — retrying with sonar`)
    try {
      return await runNewsSearch('sonar', 2000, 20000)
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

// ─── Incumbent voting record (used in addition to politicalRecord for incumbents) ──
async function fetchPerplexityIncumbent(candidateName, office) {
  if (!PERPLEXITY_API_KEY) return null
  const query = `Find all bills, acts, regulations, laws, votes, legal proceedings, ethics complaints, and notable political actions for ${candidateName} who holds or has held the office of ${office} in Wisconsin. Check https://docs.legis.wisconsin.gov for past bills, votes, and their summaries — this is the official Wisconsin legislative document repository and should be the primary source for bill text and voting records. Include specific bill numbers, vote outcomes, dates, and sources.`
  try {
    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(), 20000)
    const res = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Authorization': `Bearer ${PERPLEXITY_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'sonar',
        messages: [
          { role: 'system', content: 'You are a Wisconsin legislative records researcher. Return a structured list of incumbent actions. For each item:\n**[TYPE: Bill/Vote/Legal/Other]** Title (Number if applicable)\nDate · Vote: yes/no/abstain/absent\nOutcome: Brief description. Source: Name.\n\nFor each bill, include: bill number, title, one-sentence summary of what the bill does, the candidate\'s vote (yes/no/abstain/absent), and the outcome.' },
          { role: 'user', content: query },
        ],
        max_tokens: 2000,
      }),
    })
    if (!res.ok) { console.error(`[perplexity/incumbent] ${res.status}`); return null }
    const data = await res.json()
    return data.choices?.[0]?.message?.content || null
  } catch (e) { console.error(`[perplexity/incumbent] ${e.message}`); return null }
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
async function callClaudeWithRetry(payload, maxRetries = 2) {
  let lastErr = null
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const delay = attempt * 35000 // 35s, 70s
      console.log(`[dossier-bg] Claude overloaded — retry ${attempt}/${maxRetries} in ${delay/1000}s`)
      await new Promise(r => setTimeout(r, delay))
    }
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
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

// ─── #1: Secondary Haiku pass — verify high-risk sections and flag issues ─────
async function runVerificationPass(content, candidateName) {
  if (!ANTHROPIC_API_KEY || !content) return null
  // Extract sections 6 and 13 for verification (the most legally sensitive)
  const sec6 = content.match(/## SECTION 6[\s\S]*?(?=## SECTION 7|$)/i)?.[0] || ''
  const sec13 = content.match(/## SECTION 13[\s\S]*?(?=## SECTION 14|$)/i)?.[0] || ''
  if (!sec6 && !sec13) return null
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 800,
        messages: [{
          role: 'user',
          content: `Review these dossier sections for ${candidateName} and identify any claims that: (1) are stated as fact but lack a cited source, (2) could constitute defamation if wrong, (3) confuse this person with someone else, or (4) rely only on aggregator data rather than primary sources. Return ONLY a brief bullet list of specific flags, or "NO FLAGS" if all claims appear properly sourced and badged. Be concise.\n\n${sec6}\n\n${sec13}`
        }],
      }),
    })
    if (!res.ok) return null
    const d = await res.json()
    logAiUsage({ endpoint: 'profiler', provider: 'anthropic', model: 'claude-haiku-4-5-20251001',
      inputTokens: d?.usage?.input_tokens || 0, outputTokens: d?.usage?.output_tokens || 0 })
    const flags = d.content?.[0]?.text?.trim()
    return (flags && flags !== 'NO FLAGS') ? flags : null
  } catch (e) { console.error('[dossier-bg] Verification pass failed:', e.message); return null }
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
  const cleaned = content.replace(/\n*---\n## CANDIDATE UPDATES[\s\S]*$/i, '').trim()
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
        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          signal: ctrl.signal,
          headers: {
            'x-api-key': ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: CLAUDE_MODEL,
            max_tokens: 512,
            messages: [{ role: 'user', content: 'Say OK' }],
          }),
        })
        const ms = Date.now() - t0
        if (!r.ok) {
          const errText = await r.text()
          return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: `API ${r.status}: ${errText.slice(0, 300)}`, ms }) }
        }
        const d = await r.json()
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, reply: (d.content || []).filter(b => b.type === 'text').map(b => b.text).join(''), ms, model: CLAUDE_MODEL }) }
      } catch (e) {
        return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: e.message, hint: 'API call failed or timed out' }) }
      }
    }
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, key_set: true, key_prefix: ANTHROPIC_API_KEY.slice(0, 8) + '...', perplexity: !!PERPLEXITY_API_KEY }) }
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

  let user = null
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
  const identityPromise     = fetchPerplexityIdentity(safe.name, officeLine, safe.districtName, ctx, mode)
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

  // ─── System Prompt (v4.1 structure + current legal compliance) ─────────────
  const systemPrompt = `You are a WI opposition researcher for The Bluejack Group. Build a sourced dossier using public records only. Tables over prose. Concise. Use "&" not "and" in tables.

RULES:
- NOT FOUND + search method if empty. Never fabricate.
- Verify records by DOB/middle name/address before attributing.
- Cite every claim (URL or DB name). Apply confidence badges.
- No minors. No sealed/expunged/juvenile records.
- Arrests ≠ convictions. WCCA dismissed cases removed after 2yr — skip third-party aggregator data.
- Use & not "and" in table cells.

CONFIDENCE BADGES — MANDATORY ON EVERY CLAIM:
[KNOWN] – Publicly documented, verified through official records or credible reporting
[RESEARCH REQUIRED] – Requires independent verification before any use
[Confirmed] – Cross-referenced from multiple reliable sources
[Likely] – Reasonable inference from available data; not yet verified
[Verify] – Flagged for fact-checking before use

Section-level confidence: [HIGH] / [MEDIUM] / [LOW] — open each section with one.

LEGAL COMPLIANCE:
1. ACCURACY: All claims must be sourced from publicly available information. Label every claim with a confidence badge. When in doubt, use [RESEARCH REQUIRED].
2. DEFAMATION (Wis. Stat. § 895.05): Never state as confirmed fact any claim that could constitute defamation per se. No speculation on personal conduct, character, or motivations.
3. FCRA (15 U.S.C. § 1681): Do NOT generate content usable as a "consumer report." No employment screening characterizations, no personal financial info beyond public filings.
4. PRIVACY: Do not include unless already a documented public-record controversy: alleged criminal history (confirmed court records only), private religious practice, private personal conduct, minor children, medical/mental health info.
5. Use "RESEARCH PRIORITY" not "vulnerability" — HIGH/MEDIUM/LOW RESEARCH PRIORITY.
6. Clearly distinguish confirmed public record from analytical inference.

LEGAL — WI PUBLIC RECORDS:
✅ SAFE: WCCA convictions · property records · WDFI filings · DSPS licenses/discipline · DOR delinquent list (>$5K) · lobbying records · DOC registry · news · public social posts · FEC/OpenSecrets/FollowTheMoney · voter name/address/history
❌ OFF-LIMITS: medical (HIPAA/Ch.51) · sealed/expunged · juvenile (Ch.938) · adoption · SSN/DL# · private financials · confidential electors (§ 6.47) · how someone voted · tax returns
⚠️ CAUTION: dismissed cases on aggregators → skip · divorce records → political relevance only · cite original source not aggregator

PARTY VERIFICATION — MANDATORY:
The "Party" field in the candidate record may be wrong. Independently verify using:
1. WEC voter registration & filing records (most authoritative)
2. Donation platform: ActBlue.com = Democrat; Anedot.com = Republican
3. Party endorsements, committee filings, official party listings
4. Candidate's website, social media bio, public statements
5. News coverage explicitly identifying party
6. Donor network alignment
7. PAC/organization endorsements
If evidence contradicts supplied value, state the correct party & flag the discrepancy.

P1: IDENTITY LOCK — Establish from campaign site/news/social BEFORE any record search:
Legal name: ___ | DOB: ___ | Address: ___ | Spouse: ___ | Employer: ___
Unverified records → UNCONFIRMED → Sec 14.

P2: SEARCH ALL (report findings or NO RESULTS):

Google searches to perform:
"[Name]" site:wi.gov | site:wicourts.gov | site:reddit.com | site:facebook.com
"[Name]" AND (lawsuit|sued|court|"tax lien"|bankrupt|arrest|DUI|OWI)
"[Name]" AND (controversy|scandal|resign|fired|ethics|complaint)
"[Name]" AND (endorsement|endorsed|supports)
"[Name]" AND (op-ed|"letter to editor"|opinion)
"[Name]" AND (OSHA|violation|fine|penalty)
"[Name]" AND (divorce|custody|"restraining order")
"[Name]" [city] [county]

WI Databases (search each, report findings or NO RESULTS):
WCCA (wcca.wicourts.gov) – All case types, filter DOB
Eye on Lobbying (lobbying.wi.gov) – Name & employer
MyVote (myvote.wi.gov) – Registration, address, history
WDFI Corp (apps.dfi.wi.gov) – Business/LLC ownership
WDFI UCC (wims.dfi.wi.gov/uccsearch) – Liens on property/equipment
County Land (varies) – Value, tax, delinquencies, sales
Legislature (legis.wisconsin.gov) – Bills, votes, testimony
County Gov (varies) – Minutes, agendas, committees
Ethics Comm (ethics.wi.gov) – Economic interest statements
DOR Delinquent (revenue.wi.gov) – Unpaid taxes >$5K
DSPS (licenseverification.wi.gov) – Licenses & discipline
DPI (dpi.wi.gov/licensing) – Educator credentials & revocations
DOC (appsdoc.wi.gov/public) – Offender & inmate search
RETR (revenue.wi.gov/Pages/RETr) – Property transfers & prices
OpenBook (openbook.wi.gov) – State contracts to candidate biz
DNR (dnr.wisconsin.gov) – Environmental violations

National Databases:
FEC (fec.gov/data) – Federal donations
OpenSecrets (opensecrets.org) – Donor lookup
FollowTheMoney (followthemoney.org) – State finance
Ballotpedia (ballotpedia.org) – Bio, elections
Vote Smart (justfacts.votesmart.org) – Votes, ratings
ProPublica 990s (projects.propublica.org/nonprofits) – Nonprofit roles & salary
PACER (pacer.gov) – Federal bankruptcy/lawsuits
USASpending (usaspending.gov) – Gov contracts to employer
OSHA (osha.gov) – Workplace violations
OpenTheBooks (openthebooks.com) – State employee salary
InfluenceWatch (influencewatch.org) – Dark money/PAC mapping
WI Democracy Campaign (wisdc.org) – Donor/PAC networks
MuckRock (muckrock.com) – Existing FOIA requests

Social Media: Facebook (personal+campaign) · Instagram · X · LinkedIn · Threads · Reddit (r/[city], r/wisconsin) · Local FB Groups · Nextdoor · YouTube · TikTok · Venmo/CashApp (public txns)

Archives: Wayback Machine (web.archive.org) — campaign sites, old biz pages, deleted posts · archive.is — cached articles/posts · Deleted tweet tools

WI Media (check each for coverage):
Hyper-local: Wausau Pilot & Review · Urban Milwaukee · WI Examiner · Isthmus
Newsletters: The Wausonian · WisPolitics · Recombobulation Area
Conservative: MacIver · Right Wisconsin · Media Trackers
Progressive: WI Democracy Campaign · One Wisconsin Now
Wire: WisPolitics.com · WisconsinEye
Broadcast: WSAW · WAOW · local PBS
Investigative: The Badger Project · Votebeat WI

Mandatory Commentators (check for mentions):
Jessica McBride: wisconsinrightnow.com · fb/jessica.mcbride100 · x/jess_mcbride
Charlie Sykes: thebulwark.com
Vicki McKenna: newstalk1130.iheart.com
McCoshen & Ross: pbswisconsin.org`

  // ─── Section 6: full vs. template based on tier ───────────────────────────
  const section6Prompt = canViewSection6
    ? `## SECTION 6: CONTROVERSIES & OPPOSITION RESEARCH
**[HIGH/MEDIUM/LOW]**

Per item — use this table format:

| Issue | Date | Summary (2 sent.) | Source | Response | Status | Confidence |
|---|---|---|---|---|---|---|

Cover: court (WCCA, convictions only) · electoral · professional (DSPS) · financial (DOR/PACER/OSHA/UCC) · hypocrisy · voter reg · DNR

Also include:
- CAMPAIGN FINANCE & REGULATORY MATTERS from official records — [KNOWN] or [RESEARCH REQUIRED]
- INCONSISTENCIES IN PUBLIC RECORD — cite specific documented statements, flag [Verify] if source unclear
- PROFESSIONAL/ORGANIZATIONAL RECORD — publicly documented only
- Assign RESEARCH PRIORITY (HIGH/MEDIUM/LOW) to each finding

DO NOT INCLUDE: unverified arrests, private personal conduct, religious beliefs, social media posts unless in credible news, family members who aren't public figures, FCRA-usable content.
Label all items [RESEARCH REQUIRED] unless you have a credible public record source.`
    : `## SECTION 6: CONTROVERSIES & OPPOSITION RESEARCH
**[RESEARCH REQUIRED]**

*This section is available to Campaign & Agency plan subscribers.*

**RESEARCH FRAMEWORK — Items to Investigate:**
- [ ] Campaign finance filings: Review WECF & FEC records — [RESEARCH REQUIRED]
- [ ] Public record inconsistencies: Compare current platform vs past statements — [RESEARCH REQUIRED]
- [ ] Professional background review: Employment history & documented controversies — [RESEARCH REQUIRED]
- [ ] Organizational conflicts of interest: Board memberships from Section 8 — [RESEARCH REQUIRED]
- [ ] Digital public record review: Public digital footprint via credible press — [RESEARCH REQUIRED]

*Upgrade to Campaign or Agency plan to unlock AI-assisted analysis.*`

  const section13Prompt = canViewSection6
    ? `## SECTION 13: ATTACK & DEFENSE
**[HIGH/MEDIUM/LOW]**

**Attack angles (for opponents):**

| Vulnerability | Evidence | Framing | Src |
|---|---|---|---|

**Defense prep (for candidate):**

| Likely Attack | Truth/Context | Response | Src |
|---|---|---|---|`
    : `## SECTION 13: ATTACK & DEFENSE
**[RESEARCH REQUIRED]**

*This section is available to Campaign & Agency plan subscribers.*

**RESEARCH FRAMEWORK:**
- [ ] Identify top 3-5 potential attack angles from public record — [RESEARCH REQUIRED]
- [ ] Prepare defense responses for each identified vulnerability — [RESEARCH REQUIRED]
- [ ] Review opposition messaging patterns — [RESEARCH REQUIRED]

*Upgrade to Campaign or Agency plan to unlock attack & defense analysis.*`

  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })

  // ─── Wait for all Perplexity + Grok results in parallel ─────────────────
  let perplexityNews = null, perplexityIncumbent = null, localNews = null
  let identityData = null, financeData = null, politicalData = null, affiliationsData = null, socialMediaData = null
  let grokData = null, officialData = null
  try {
    ;[perplexityNews, perplexityIncumbent, identityData, financeData, politicalData, affiliationsData, socialMediaData, grokData, officialData, localNews] =
      await Promise.all([perplexityPromise, incumbentPromise, identityPromise, financePromise, politicalPromise, affiliationsPromise, socialMediaPromise, grokPromise, officialPromise, localNewsPromise])
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

  // ─── Build context blocks injected into the user prompt ───────────────────
  const officialContext = officialData
    ? `\n\nOFFICIAL GOVERNMENT RECORDS (direct API data — FEC / CourtListener / LegiScan — highest reliability tier):\n${officialData}\n\nTreat FEC & LegiScan rows as [KNOWN] ground truth (they override contradictory web-search claims). CourtListener rows are NAME MATCHES — attribute only after identity confirmation.`
    : ''

  const identityContext = identityData
    ? `\n\nVERIFIED IDENTITY DATA (from real-time web search — MANDATORY: use to populate IDENTITY LOCK in Section 2 and cross-reference ALL record attributions):\n${identityData}\n\nDo NOT attribute any record to this person unless the identity matches the above data.`
    : ''

  const newsContext = perplexityNews
    ? `\n\nREAL-TIME NEWS RESEARCH (from web search — use as the primary basis for Section 1):\n${perplexityNews}\n\nUse these real news results for Section 1. Keep ### heading format. Add confidence badges. Prioritize these verified results over training knowledge. MANDATORY: include EVERY distinct item from this research in Section 1 — do NOT summarize the list down or drop smaller items; Section 1 must contain at least 12 items whenever the research provides them.`
    : ''

  const incumbentContext = perplexityIncumbent
    ? `\n\nINCUMBENT RECORD RESEARCH (this candidate IS a current incumbent; incorporate into Section 4):\n${perplexityIncumbent}\n\nIncorporate into Section 4 (Political Record — Key Votes, Bills, official actions). Mark [KNOWN] if from official legislative record, [RESEARCH REQUIRED] if uncertain.`
    : (isIncumbent ? '\n\nNOTE: This candidate IS a current incumbent. Section 4 must include their voting record, sponsored bills, committee assignments, and any legal/ethics matters from their time in office.' : '')

  const financeContext = financeData
    ? `\n\nCAMPAIGN FINANCE DATA (from web search — use for Section 5 Financial):\n${financeData}\n\nUse these verified financial figures in Section 5. Mark each item [KNOWN] or [RESEARCH REQUIRED].`
    : ''

  const politicalContext = politicalData
    ? `\n\nPOLITICAL RECORD DATA (from web search — use for Section 4 Political Record):\n${politicalData}\n\nUse for election history table and key votes in Section 4. Do not add unsourced claims — mark any gaps [RESEARCH REQUIRED] instead of filling them from training knowledge.`
    : ''

  const affiliationsContext = affiliationsData
    ? `\n\nAFFILIATIONS & ENDORSEMENTS DATA (from web search — use for Section 8):\n${affiliationsData}\n\nUse for the affiliations table and endorsements list in Section 8.`
    : ''

  const socialMediaContext = socialMediaData
    ? `\n\nSOCIAL MEDIA RESEARCH (from web search — use as the primary basis for Section 10):\n${socialMediaData}\n\nUse these real social media findings for Section 10 (Social Posts). Keep ### heading format with platform/author info. Add sentiment flags. Include both posts BY the candidate and posts ABOUT the candidate. Prioritize these verified results over training knowledge.`
    : ''

  // Grok provides real-time X/Twitter intelligence + breaking web coverage.
  // Injected as supplemental context for Section 1 (News), Section 10 (Social),
  // and Section 6 (Controversies) — whichever sections benefit most.
  const grokContext = grokData
    ? `\n\nREAL-TIME X & BREAKING INTELLIGENCE (from Grok live search of X and web — as of TODAY):\n${grokData}\n\nThis is the most current intelligence available. Use it to:\n- Supplement Section 1 with any breaking news items not in the Perplexity results\n- Enrich Section 10 (Social Posts) with X/Twitter posts and sentiment data\n- Flag any emerging controversies or breaking developments in Section 6\n- Note current X sentiment (positive/negative/mixed) in Section 12 (Public Perception)\nMark items sourced from Grok as [X/Live] or [Web/Live].`
    : ''

  // Mode-specific directives — tells Claude exactly how to adapt each section
  const researchModeDirectives = {
    prospect: `\n⚠️ RESEARCH MODE: PROSPECT (Pre-Candidate)
This person has NOT officially announced a run for office (status: ${safe.status || 'exploring'}).
Adapt all 14 sections for a private citizen being researched before any announcement:
- Section 1 (News): Professional/business coverage, community news, op-eds, civic activity — NOT campaign news
- Section 2 (Bio): Lead with employment, business ownership, professional background — electoral history may be empty
- Section 3 (Timeline): Career and civic milestones, not campaign milestones
- Section 4 (Political Record): Civic board service, donations made, community roles. Races table may be EMPTY — that is correct, do NOT fabricate electoral results
- Section 5 (Financial): Personal finances — property, business (WDFI), UCC liens, DOR, PACER
- Section 8 (Affiliations): Civic orgs, nonprofit boards (ProPublica 990s), professional associations — not political endorsements
- Section 10 (Social): LinkedIn is primary; personal Facebook and community groups
Do NOT fabricate campaign finance filings. Do NOT assume this person has a WEC committee.\n`,

    newly_declared: `\n⚠️ RESEARCH MODE: NEWLY DECLARED CANDIDATE
This person RECENTLY announced their first candidacy for ${officeLine} (status: ${safe.status || 'declared'}).
Focus all sections on the announcement and early campaign phase:
- Section 1 (News): Announcement article (what outlet broke it), editorial reactions, opponent responses, professional background coverage that motivated the run
- Section 2 (Bio): Employment and civic background establishing their qualifications for this office
- Section 3 (Timeline): Career path leading to candidacy; announcement date is a key milestone; WEC filing date
- Section 4 (Political Record): WEC filing date and committee name; prior civic board service; prior donations to other candidates. Races table may be EMPTY or minimal — correct, do NOT fabricate wins/losses that don't exist
- Section 5 (Financial): WEC committee initial filing amount, personal finances (WDFI, property, UCC), any ActBlue/Anedot fundraising pages
- Section 8 (Affiliations): Who endorsed at announcement; organizational affiliations that signal political alignment
- Section 10 (Social): Campaign launch posts; early community reactions to announcement
This person has a WEC filing — find it. They likely have no prior race history — that is fine.\n`,

    challenger: `\n⚠️ RESEARCH MODE: CHALLENGER / ACTIVE CANDIDATE
This person is actively running for ${officeLine} (status: ${safe.status || 'general'}).
Apply full electoral research across all 14 sections:
- Section 1 (News): Campaign news, debate coverage, endorsements, fundraising, any available polls
- Section 4 (Political Record): Full electoral history — all prior races, all offices held or sought
- Section 5 (Financial): Full campaign finance — raised/spent/cash on hand, top donors by category, PAC support
- Section 6 (Controversies): Full opposition research — electoral record, professional background, financial record
- Section 9 (Network): Head-to-head donor comparison to opponent if data available
- Section 13 (Attack & Defense): Full attack/defense analysis based on documented record
Compare to incumbent or primary opponent where data is available. Note poll averages and ground game signals.\n`,

    incumbent: `\n⚠️ RESEARCH MODE: INCUMBENT SEEKING RE-ELECTION
This person CURRENTLY HOLDS ${officeLine} (status: ${safe.status || 'elected'}) and is seeking re-election.
Voting record and official performance in office are the HIGHEST PRIORITY:
- Section 1 (News): Official votes and decisions that made news, re-election campaign activity, challenger coverage that references them
- Section 4 (Political Record): COMPREHENSIVE voting record this term — every significant vote with bill number, date, and outcome; bills sponsored/co-sponsored; committee chair decisions; floor speeches; ethics filings (ethics.wi.gov); constituent case outcomes
- Section 5 (Financial): Re-election fundraising vs. challenger; PAC and dark money support; flag any donor-to-vote conflicts
- Section 6 (Controversies): Votes contradicting campaign promises; constituent complaints; performance gaps; ethics issues; any investigations
- Section 7 (Platform): Compare current campaign platform to their actual voting record — flag every contradiction
- Section 13 (Attack & Defense): Record-based vulnerabilities (missed votes, controversial positions) and defenses
Voting record is the foundation — this is where the most research value lies.\n`,
  }

  const researchModeNote = researchModeDirectives[mode] || researchModeDirectives.challenger

  const userPrompt = `Generate a complete 14-section political intelligence dossier for the following Wisconsin candidate. Adhere strictly to all legal compliance standards. Use table format wherever specified. Structure output EXACTLY with ## SECTION headers.

IMPORTANT: If research returned NO USABLE DATA for a section (all entries are NOT FOUND or UNCONFIRMED), OMIT that entire section entirely from your output rather than writing a section that says information could not be found. Only include sections where you have at least some verified information to present.

TODAY'S DATE: ${today}
Include news, events, & developments up to today. Focus on the past 12 months.
${safe.research_context ? `\n⭐ IDENTITY CONTEXT (user-provided — prioritize this to find the correct person before anything else):\n${safe.research_context}\nThis context must frame ALL searches and record attribution. Use it to distinguish this person from anyone sharing their name.\n` : ''}${researchModeNote}
---
⚠️ LEGAL DISCLAIMER:
This dossier is AI-generated from publicly available sources for lawful political research purposes only. All information requires independent verification before use. Do NOT use for FCRA-regulated purposes. Do NOT publish without independent corroboration. The Bluejack Group assumes no liability for accuracy of AI-generated content.
---

CANDIDATE RECORD:
Name: ${safe.name}
Party (MUST be independently verified): ${safe.party || 'Unknown/Not listed'}
Office: ${officeLine}
Status: ${safe.status || 'Unknown'}
Occupation: ${safe.occupation || 'Not listed'}
Employer: ${safe.employer || 'Not listed'}
Website: ${safe.website || 'Not listed'}
Email: ${safe.email || 'Not listed'}
Phone: ${safe.phone || 'Not listed'}
Campaign Committee: ${safe.campaign_committee || 'Not listed'}
Campaign Manager: ${safe.campaign_manager || 'Not listed'}
Bio: ${safe.bio_summary || 'None provided'}
Twitter/X: ${safe.twitter_handle || 'Not listed'}
Facebook: ${safe.facebook_url || 'Not listed'}
Instagram: ${safe.instagram_handle || 'Not listed'}
Election: ${safe.electionName || 'Unknown'}
PARTY VERIFICATION REMINDER: Check campaign website donation links (ActBlue = Democrat, Anedot = Republican), WEC filing, & endorsements before writing anything about party. Correct if wrong & flag discrepancy.
${identityContext}${officialContext}${newsContext}${incumbentContext}${politicalContext}${financeContext}${affiliationsContext}${socialMediaContext}${grokContext}
---

BEGIN DOSSIER. Start with the PROFILE SNAPSHOT, then output EXACTLY the 14 sections.

## PROFILE SNAPSHOT
Two to three sentences (max 60 words) describing who this person is — written the way a sharp, neutral observer would describe them to a friend: intriguing, plain-spoken, easy to understand, and strictly unbiased. Lead with what makes them distinctive (their background, their path into politics, what they're known for locally). No confidence badges, no headers, no bullet points, no partisan framing — just a compelling, factual portrait.

## SECTION 1: NEWS & MEDIA COVERAGE
**[HIGH/MEDIUM/LOW]**

IMPORTANT FORMAT — each news item MUST use this exact format:

### [Exact Article or Post Title](https://full-url-if-known.com)
**Publication or Source Name** · Month D, YYYY
One to two sentence summary. **[KNOWN]** or **[Verify]**

If URL unknown, omit link: ### Exact Article Title
For social media: ### [Post description](https://url)
**Facebook / PageName** · Month D, YYYY

Target 15-20+ items, chronological (most recent first). All articles from WI media list. Check mandatory commentators. End with [RESEARCH REQUIRED] items for gaps.

## SECTION 2: BIOGRAPHY & BACKGROUND
**[HIGH/MEDIUM/LOW]**

First: complete the IDENTITY LOCK:
Legal name: ___ | DOB: ___ | Address: ___ | Spouse: ___ | Employer: ___

Then provide the Bio table:

| Field | Value | Source |
|---|---|---|
| Name | | |
| DOB/Age | | |
| Address | | |
| Property Value | | County |
| Property Tax | | County |
| Tax Delinquent? | Y/N | DOR |
| Spouse | | |
| Education | | |
| Edu Verified? | Y/N | |
| Employer | | |
| Title | | |
| License | | DSPS |
| Discipline? | Y/N | DSPS |
| Prior Jobs | | |
| Military | | |
| Businesses | | WDFI |
| UCC Liens | | WDFI |

## SECTION 3: TIMELINE
**[HIGH/MEDIUM/LOW]**

| Year | Event | Source |
|---|---|---|

Flag unexplained gaps. Include career, political, legal, & financial events.

${(mode === 'prospect' || mode === 'newly_declared') ? `## SECTION 4: CIVIC & POLITICAL BACKGROUND
**[HIGH/MEDIUM/LOW]**

| Org / Board / Body | Role | Years Active | Source |
|---|---|---|---|

**Prior Campaign Donations Made:** (recipient, year, amount, source — FEC/WEC)
**WEC Committee Filing:** (committee name, filing date — or NOT FOUND)
**Public Testimony / Statements:** (date, body, topic, source)
**Voter Reg Match?** MyVote address vs actual: Y/N

For newly declared candidates: include WEC registration details and any initial filings. For prospects: focus on civic board service, nonprofit board roles (ProPublica 990s), and community leadership. Do NOT fabricate electoral race history — if no races exist, say so explicitly.` : `## SECTION 4: POLITICAL RECORD
**[HIGH/MEDIUM/LOW]**

Races:

| Year | Office | W/L | Votes | Margin | Opponent |
|---|---|---|---|---|---|

**Committees:** (list)
**Key Votes:** (date, issue, vote, source)
**Voter Reg Match?** MyVote address vs actual: Y/N`}

## SECTION 5: FINANCIAL
**[HIGH/MEDIUM/LOW]**

| Item | Value | Source |
|---|---|---|
| Businesses | | WDFI |
| UCC Liens | | WDFI |
| Property | | County |
| Tax Challenges | | Board of Review |
| RETR Transfers | | DOR |
| Fed Donations | | FEC |
| State Donations | | FTM/WDC |
| Nonprofit Roles | | ProPublica |
| State Contracts | | OpenBook |
| OSHA Violations | | OSHA |
| Delinquent Tax | | DOR |
| Bankruptcy | | PACER |
| Conflicts | | |

${section6Prompt}

## SECTION 7: POLICY POSITIONS & PLATFORM
**[HIGH/MEDIUM/LOW]**

| Issue | Position | Quote | Source | Date |
|---|---|---|---|---|

Flag contradictions & shifts. Include known stated positions [KNOWN]/[Confirmed], inferred positions [Likely], key district issues, positions differing from party mainstream.

## SECTION 8: AFFILIATIONS & ENDORSEMENTS
**[HIGH/MEDIUM/LOW]**

| Org | Role | Type | Years | Source |
|---|---|---|---|---|

**Endorsements In:** (endorser, date, src)
**Endorsements Out:** (list)
**PAC/Dark Money:** (InfluenceWatch/WDC)

## SECTION 9: POLITICAL NETWORK & DONORS
**[HIGH/MEDIUM/LOW]**

Allies:

| Name | Position | Link | Evidence | Src |
|---|---|---|---|---|

Opponents:

| Name | Position | Conflict | Evidence | Src |
|---|---|---|---|---|

Key donors, donor categories from official filings [KNOWN]. PAC support. Consulting/vendor relationships from FEC/WECF filings.

## SECTION 10: SOCIAL POSTS
**[HIGH/MEDIUM/LOW]**

IMPORTANT FORMAT — each social media item MUST use this exact format (same as Section 1):

### [Post description or excerpt](https://url-if-known.com)
**Platform / Author or Handle** · Month D, YYYY
One to two sentence summary. Sentiment: +/-/~. **[KNOWN]** or **[Verify]**

If URL unknown, omit link: ### Post description or excerpt
**Platform / Author** · Month D, YYYY

**By candidate:** (posts made by the candidate on their own accounts)
List 8-15+ items using ### heading format above. MANDATORY: include EVERY distinct post from the social media research and the real-time X intelligence — do not drop items.

**About candidate:** (posts by others mentioning or discussing the candidate)
List 5-10+ items using ### heading format above.

Flags per item: Controversial / Policy / Contradiction / Deleted / Endorsement / Accusation / Rumor / Praise
Target 10-15+ total social media items across both sections.

## SECTION 11: DIGITAL FOOTPRINT
**[HIGH/MEDIUM/LOW]**

| Platform | Handle | Est. Activity | Notes |
|---|---|---|---|
| Site | | | |
| FB personal | | | |
| FB campaign | | | |
| IG | | | |
| X | | | |
| LinkedIn | | | |
| Threads | | | |
| YT | | | |
| TikTok | | | |

Est. Activity values: Active / Inactive / Unknown. Do NOT estimate follower counts — they require manual verification and change constantly.

**Deleted content?** Y/N (detail if Y)

## SECTION 12: NARRATIVE & PUBLIC PERCEPTION
**[HIGH/MEDIUM/LOW]**

**How the press frames this person:** What adjectives, narratives, and characterizations appear repeatedly in coverage? Is framing favorable, unfavorable, or neutral? Cite specific examples.

**Dominant public narrative:** What is the single strongest story the public has about this candidate (positive or negative)? What drives it?

**Key defining quotes:** 2-3 quotes from news or public record that best capture how this person is perceived — include speaker, source, and date.

**Opposition/critic narrative:** How are opponents, critics, or opposition media characterizing this person? What attacks have gained traction?

**Candidate's own messaging:** Primary themes from campaign website, social, and public appearances. Note any contradictions between messaging and public record.

**Press relations:** Receptive or guarded with media? Any patterns of media avoidance, selective access, or off-the-record activity?

**Advertising (documented only):** Digital, mail, TV/radio — cite source. Do not speculate.

**SWOT Analysis**
A simple four-quadrant assessment of this candidate's political position based on verified public record. Use bullet points for each quadrant — no prose paragraphs. Keep each bullet to 1-2 plain sentences, no jargon.

- **Strengths** (advantages this candidate has right now — e.g. name recognition, fundraising, strong voting record, popular positions):
  - [bullet]
  - [bullet]

- **Weaknesses** (documented vulnerabilities — e.g. thin record, controversy, low fundraising, positions out of step with district):
  - [bullet]
  - [bullet]

- **Opportunities** (external factors that could help this candidate win — e.g. favorable district trends, opponent weaknesses, open seat):
  - [bullet]
  - [bullet]

- **Threats** (external factors that could hurt this candidate — e.g. strong opponent, negative press cycle, unfavorable district trends, legal/ethics exposure):
  - [bullet]
  - [bullet]

Base every bullet on verified information from this dossier. Do not speculate. If a quadrant has no verified data, omit it rather than filling it with guesses.

${section13Prompt}

## SECTION 14: VERIFICATION & RESEARCH GAPS
**[HIGH/MEDIUM/LOW]**

| Finding | Conf | Sources |
|---|---|---|

Confidence: HIGH=official/3+ · MED=1 credible · LOW=social/1 unverified · UNCONFIRMED=wrong person possible

**Research gaps and open questions:**

| Gap | Why It Matters | Recommended Next Step |
|---|---|---|

**Sources used in this dossier (AI research):**
List each source that returned actual data above — e.g. "WEC filing → committee name and date" or "Perplexity news search → 12 articles." Do not fabricate sources.

**Manual research checklist (requires human follow-up — not completed by AI):**

| Database | Priority | What to Look For |
|---|---|---|
| WEC (wec.vote) | HIGH | Committee registration, all finance reports, any violations |
| WCCA (wcca.wicourts.gov) | HIGH | All case types — filter by DOB to confirm identity |
| Ethics Comm (ethics.wi.gov) | HIGH | Economic interest statements |
| MyVote (myvote.wi.gov) | HIGH | Voter reg address vs. claimed address |
| WDFI Corp (apps.dfi.wi.gov) | HIGH | Business ownership, registered agent, dissolution history |
| Lobbying (lobbying.wi.gov) | HIGH | Self or employer lobbying activity |
| County Land Records | MEDIUM | Property value, tax delinquency, ownership history |
| DOR Delinquent List | MEDIUM | Unpaid taxes >$5K |
| DSPS (licenseverification.wi.gov) | MEDIUM | Professional license status and any discipline |
| FEC (fec.gov/data) | MEDIUM | Federal donations made and received |
| WDFI UCC (wims.dfi.wi.gov) | MEDIUM | Liens on business equipment or property |
| Ballotpedia | MEDIUM | Bio cross-check, prior race history |
| Wayback Machine | MEDIUM | Deleted campaign content, old business pages, past positions |
| InfluenceWatch | MEDIUM | Dark money and PAC connections |
| PACER (pacer.gov) | MEDIUM | Federal bankruptcy or civil lawsuits |
| OSHA (osha.gov) | LOW | Workplace violations at employer or owned business |
| DPI (dpi.wi.gov/licensing) | LOW | Educator credentials — only if applicable |
| DOC (appsdoc.wi.gov/public) | LOW | Offender registry |
| OpenBook (openbook.wi.gov) | LOW | State contracts to candidate's business |
| DNR (dnr.wisconsin.gov) | LOW | Environmental violations |
| RETR (revenue.wi.gov) | LOW | Property transfer history and prices |
| MuckRock (muckrock.com) | LOW | Existing FOIA requests about this subject |
| McBride / Sykes / McKenna | LOW | Conservative and progressive political commentary |

---
⚠️ DOSSIER FOOTER:
*AI-Generated Political Intelligence Report · Badger Board · The Bluejack Group · badgerboardwi.com*
*This report is AI-generated from publicly available sources. It has NOT been independently verified. All information must be independently verified before use in any campaign, publication, or professional context. Do not use for FCRA-regulated purposes. The Bluejack Group assumes no liability for accuracy of AI-generated content. Use constitutes acceptance of the Badger Board Research Use Disclaimer.*

---
## CANDIDATE UPDATES (output AFTER Section 14 — do not number this as a section)

After completing all 14 sections, output EXACTLY this block. Use JSON null (not the string "null") for any field you cannot verify with a source:

CANDIDATE_UPDATES:
\`\`\`json
{
  "verified_party": "<Democrat|Republican|Independent|Nonpartisan|Green|Libertarian|Working Families|null>",
  "party_confidence": "<KNOWN|Confirmed|Likely|RESEARCH_REQUIRED>",
  "verified_status": "<exploring|declared|primary_winner|general|elected|lost|withdrawn|null>",
  "status_notes": "<one sentence of evidence for status change, or null>"
}
\`\`\`

Rules:
- verified_party: ONLY include if you found independent verification (WEC filing, ActBlue/Anedot page, official party listing, news). Otherwise null.
- party_confidence: KNOWN = official primary source confirmed; Confirmed = 2+ independent sources agree; Likely = one credible indirect source; RESEARCH_REQUIRED = ambiguous or contradictory evidence.
- verified_status: ONLY update from current status (${safe.status || 'unknown'}) if your research clearly shows a change — WEC committee filed = "declared", certified election result = "elected" or "lost", public withdrawal statement = "withdrawn". Otherwise null.
- status_notes: required if verified_status is not null. One sentence citing the specific evidence (source + date).`

  const { candidate_id } = body
  // Verified user ID, never from the body. Internal (cron) runs save with
  // null so auto-regenerated dossiers stay excluded from the monthly quota
  // count and never consume purchased credits.
  const user_id = isInternalTrigger ? null : (user?.id || null)

  try {
    const perplexityCount = [perplexityNews, identityData, financeData, politicalData, affiliationsData, perplexityIncumbent, socialMediaData].filter(Boolean).length
    console.log(`[dossier-bg] Starting: model=${CLAUDE_MODEL}, candidate=${safe.name}, perplexity_sources=${perplexityCount}/7`)
    const startTime = Date.now()

    // ─── #18: Call Claude with automatic retry on 529 overload ─────────────
    // Live web search: the writer fills research gaps & verifies claims itself.
    const webSearchDirective = `

LIVE WEB SEARCH — you have a web_search tool. Use it surgically (max ~8 searches):
1. GAPS FIRST: When the research context above is missing or thin for a section (especially Sections 4 Political Record, 5 Financial, 6 Controversies), run one targeted search before writing that section.
2. OFFICIAL SOURCES FIRST: WI campaign finance -> site:campaignfinance.wi.gov (Wisconsin Ethics Commission CFIS); WI legislation & votes -> site:docs.legis.wisconsin.gov; election results -> site:elections.wi.gov; federal finance -> site:fec.gov.
3. VERIFY BEFORE [KNOWN]: A high-impact claim (legal, financial, controversy) gets [KNOWN] only if backed by official records above or a verifying search.
4. Never search for facts already provided in the research context. Never let searching prevent completing every section — if the budget runs out, write with what you have.`

    const webSearchTools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 8 }]
    const claudePayload = {
      model: CLAUDE_MODEL,
      max_tokens: 16000,
      system: systemPrompt + webSearchDirective,
      tools: webSearchTools,
      messages: [{ role: 'user', content: userPrompt }],
    }
    const response = await callClaudeWithRetry(claudePayload)
    console.log(`[dossier-bg] Claude responded in ${Date.now() - startTime}ms, status=${response.status}`)

    if (!response.ok) {
      const errText = await response.text()
      console.error(`[dossier-bg] Claude error: ${errText.slice(0, 500)}`)
      throw new Error(`Anthropic API error: ${response.status}`)
    }

    const data = await response.json()
    // v1.20: real cost metering — main writer call with actual token counts
    logAiUsage({ userId: user_id, endpoint: 'profiler', provider: 'anthropic', model: CLAUDE_MODEL,
      inputTokens: data?.usage?.input_tokens || 0, outputTokens: data?.usage?.output_tokens || 0 })
    const extractClaudeText = (d) => (d?.content || []).filter(b => b.type === 'text' && b.text).map(b => b.text).join('')
    let content = extractClaudeText(data)
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
      const retryPrompt = `The dossier you just generated for ${safe.name} was cut short — only ${sectionCount} of 14 sections were included. Continue from where it was cut off and complete ALL missing sections. Start with the next missing ## SECTION header and continue through ## SECTION 14. Do not repeat sections already written.\n\nPrevious output (partial):\n${content.slice(-3000)}`
      const retryResp = await callClaudeWithRetry({ model: CLAUDE_MODEL, max_tokens: 16000, system: systemPrompt + webSearchDirective, tools: webSearchTools, messages: [{ role: 'user', content: retryPrompt }] })
      if (retryResp.ok) {
        const retryData = await retryResp.json()
        logAiUsage({ userId: user_id, endpoint: 'profiler', provider: 'anthropic', model: CLAUDE_MODEL,
          inputTokens: retryData?.usage?.input_tokens || 0, outputTokens: retryData?.usage?.output_tokens || 0 })
        const continuation = extractClaudeText(retryData)
        if (continuation) {
          content = content + '\n\n' + continuation
          console.log(`[dossier-bg] After continuation: ${countSections(content)} sections, ${content.length} chars`)
        }
      }
    }

    // ─── #1: Secondary Haiku verification pass on high-risk sections ────────
    const verificationFlags = await runVerificationPass(content, safe.name)
    if (verificationFlags) {
      console.log(`[dossier-bg] Verification flags found: ${verificationFlags.length} chars`)
      content = content + `\n\n---\n## ⚠️ VERIFICATION FLAGS (AI Quality Check)\n*The following potential issues were flagged by a secondary review pass. Verify before use.*\n\n${verificationFlags}`
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
      console.log(`[dossier-bg] Extended save failed (${saveRes.status}), retrying with base fields`)
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
      console.log(`[dossier-bg] Saved (base) id=${baseSaved?.[0]?.id}, total=${Date.now() - startTime}ms`)
    } else {
      const saved = await saveRes.json()
      console.log(`[dossier-bg] Saved id=${saved?.[0]?.id}, sections=${countSections(content)}, changes=${!!changeSummary}, flags=${!!verificationFlags}, total=${Date.now() - startTime}ms`)
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
    return { statusCode: 500, body: '' }
  }
}
