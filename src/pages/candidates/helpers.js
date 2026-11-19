// src/pages/candidates/helpers.js — pure logic for the Candidate-plan tiles
// page and its add-candidate sheet. No React, no Supabase: tests/
// candidate-tiles.test.mjs imports this file directly under Node.
//
// Candidate plans track a handful of people (you + the people you're running
// against), so the page is a grid of big tiles instead of the Action plans'
// table. Everything that decides WHAT a tile or the add form shows lives here.

import { normalizePartyForDb } from '../../lib/party.js'

// ── Ordering ─────────────────────────────────────────────────────────────────

/** The user's own record first, then everyone else by name. */
export function orderForTiles(candidates, selfId) {
  const list = [...(candidates || [])]
  const byName = (a, b) => String(a?.name || '').localeCompare(String(b?.name || ''), undefined, { sensitivity: 'base' })
  const self = selfId ? list.find(c => c.id === selfId) : null
  const rest = list.filter(c => c !== self).sort(byName)
  return self ? [self, ...rest] : rest
}

// ── "New this week" ──────────────────────────────────────────────────────────
// Weekly digests are written Monday mornings (monitoring-digest.js), so "this
// week" is the Monday-anchored local week — the same rule dashboard/shared.jsx
// isThisWeek uses, restated without date-fns so Node can import this file.

export function weekStartOf(d) {
  const x = new Date(d)
  if (Number.isNaN(+x)) return null
  x.setHours(0, 0, 0, 0)
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7))
  return x
}

export function isInWeekOf(iso, now = new Date()) {
  if (!iso) return false
  const a = weekStartOf(iso), b = weekStartOf(now)
  return !!a && !!b && +a === +b
}

/**
 * How many items the candidate's LATEST weekly digest holds, counted only when
 * that digest is from this week. 0 means no red dot.
 */
export function newThisWeekCount(dossiers, candidateId, now = new Date()) {
  const latest = (dossiers || [])
    .filter(d => d && d.candidate_id === candidateId && d.weekly_digest)
    .sort((a, b) => String(b.generated_at || '').localeCompare(String(a.generated_at || '')))[0]
  if (!latest || !isInWeekOf(latest.generated_at, now)) return 0
  const items = latest.weekly_digest.items
  return Array.isArray(items) ? items.length : 0
}

// ── Office text ──────────────────────────────────────────────────────────────
// candidates.office_id points at the offices table (7k+ Wisconsin seats). The
// add form takes free text and offers matching offices as suggestions; text
// that matches no office is kept in research_context as "Running for: …",
// which the profile research already reads to find the right person.

export const RUNNING_FOR_PREFIX = 'Running for: '

/** "Running for: Wausau City Council" → "Wausau City Council" (or null). */
export function runningForFrom(researchContext) {
  const m = String(researchContext || '').match(/^Running for: (.+)$/m)
  return m ? m[1].trim() : null
}

/** One readable line for an office row, without repeating "District N". */
export function officeOptionLabel(o) {
  if (!o) return ''
  const name = String(o.name || '').trim()
  const parts = [name]
  if (o.district_name && !name.toLowerCase().includes(String(o.district_name).toLowerCase())) parts.push(o.district_name)
  else if (o.district_number && !/district/i.test(name) && !o.district_name) parts.push(`District ${o.district_number}`)
  let label = parts.filter(Boolean).join(' — ')
  if (o.county && !label.toLowerCase().includes(String(o.county).toLowerCase())) label += ` · ${o.county} County`
  return label
}

/** What a tile prints under the name: the linked office, else the typed text. */
export function tileOfficeLine(c) {
  if (c?.office) return officeOptionLabel(c.office) || null
  return runningForFrom(c?.research_context)
}

const norm = (s) => String(s || '').toLowerCase().replace(/[—–-]/g, ' ').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()

/**
 * Up to `limit` offices whose label holds every word typed, best first.
 * Numbers match whole numbers only, so "district 1" doesn't offer District 12.
 */
export function searchOffices(query, offices, limit = 6) {
  const q = norm(query)
  if (q.length < 2) return []
  const tests = q.split(' ').map(w => (/^\d+$/.test(w)
    ? (l) => new RegExp(`(^|\\D)${w}(\\D|$)`).test(l)
    : (l) => l.includes(w)))
  const hits = []
  for (const o of offices || []) {
    const label = officeOptionLabel(o)
    const l = norm(label)
    if (tests.every(fn => fn(l))) hits.push({ o, label, rank: (l.startsWith(q) ? 0 : 1), len: label.length })
  }
  hits.sort((a, b) => a.rank - b.rank || a.len - b.len)
  return hits.slice(0, limit).map(h => ({ office: h.o, label: h.label }))
}

/** The office whose label (or bare name) is exactly this text, if any. */
export function matchOffice(text, offices) {
  const t = norm(text)
  if (!t) return null
  return (offices || []).find(o => norm(officeOptionLabel(o)) === t) ||
    (offices || []).find(o => norm(o.name) === t) || null
}

// ── Links and handles ────────────────────────────────────────────────────────

/** "janeforwi.com" → "https://janeforwi.com"; junk → ''. */
export function cleanUrl(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return ''
  const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s.replace(/^\/+/, '')}`
  try {
    const u = new URL(withScheme)
    if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.')) return ''
    return u.href
  } catch { return '' }
}

/** "@JaneForWI", "JaneForWI", "x.com/JaneForWI", "https://twitter.com/JaneForWI" → "@JaneForWI". */
export function cleanXHandle(raw) {
  let s = String(raw ?? '').trim()
  if (!s) return ''
  s = s.replace(/^https?:\/\//i, '').replace(/^(www\.)?(x|twitter)\.com\//i, '').replace(/^@/, '')
  s = s.split(/[/?#]/)[0]
  return /^[A-Za-z0-9_]{1,15}$/.test(s) ? `@${s}` : ''
}

/** Only https photo links (http would be blocked as mixed content). */
export function cleanPhotoUrl(raw) {
  const s = String(raw ?? '').trim()
  if (!/^https:\/\//i.test(s)) return ''
  try { return new URL(s).href } catch { return '' }
}

// ── Lookup response → form ───────────────────────────────────────────────────
// netlify/functions/autofill-candidate.js answers
//   200 { fields: { website, twitter_handle, facebook_url, party, photo_url,
//                   email, phone, …, notes }, name }
// with null fields already stripped. Anything may be missing.

/** Fields the short form shows. */
export const FORM_FIELDS = ['party', 'website', 'twitter_handle', 'facebook_url', 'photo_url']

/** Other things the lookup can find — shown as "Also found", saved if kept. */
export const EXTRA_FIELDS = {
  email:              'Email',
  phone:              'Phone',
  instagram_handle:   'Instagram',
  occupation:         'Job',
  employer:           'Employer',
  campaign_committee: 'Committee',
  campaign_manager:   'Campaign manager',
  treasurer:          'Treasurer',
  campaign_address:   'Campaign address',
  campaign_city:      'City',
  campaign_zip:       'ZIP',
  bio_summary:        'Bio',
}

/**
 * Turn a lookup's `fields` into { patch, extras, found, note }:
 *   patch  — values for the short form (cleaned; unusable values dropped)
 *   extras — other found values, by column
 *   found  — which form fields the lookup filled (for the "Found" tags)
 *   note   — the lookup's own caveat about what it does and doesn't know
 */
export function lookupToForm(fields) {
  const f = (fields && typeof fields === 'object') ? fields : {}
  const str = (v) => (typeof v === 'string' ? v.trim() : '')
  const patch = {}
  const party = normalizePartyForDb(str(f.party))
  if (party) patch.party = party
  const website = cleanUrl(str(f.website))
  if (website) patch.website = website
  const x = cleanXHandle(str(f.twitter_handle))
  if (x) patch.twitter_handle = x
  const fb = cleanUrl(str(f.facebook_url))
  if (fb) patch.facebook_url = fb
  const photo = cleanPhotoUrl(str(f.photo_url))
  if (photo) patch.photo_url = photo
  const extras = {}
  for (const k of Object.keys(EXTRA_FIELDS)) {
    const v = str(f[k])
    if (v) extras[k] = v.slice(0, 2000)
  }
  return { patch, extras, found: Object.keys(patch), note: str(f.notes) }
}

// ── Form → insert payload ────────────────────────────────────────────────────

export const EMPTY_ADD_FORM = {
  name: '', office_text: '', office_id: '', party: '', election_id: '',
  website: '', twitter_handle: '', facebook_url: '', photo_url: '',
}

/**
 * The row to insert. Blank values are left out entirely (not sent as null) so
 * a column the database doesn't have yet — photo_url before its migration —
 * is only named when there's actually a photo.
 */
export function buildCandidatePayload(form, { offices = [], extras = {} } = {}) {
  const f = { ...EMPTY_ADD_FORM, ...(form || {}) }
  const out = { name: String(f.name || '').trim(), status: 'exploring' }
  const party = normalizePartyForDb(f.party)
  if (party) out.party = party
  const officeText = String(f.office_text || '').trim()
  const officeId = f.office_id || matchOffice(officeText, offices)?.id || ''
  if (officeId) out.office_id = officeId
  else if (officeText) out.research_context = `${RUNNING_FOR_PREFIX}${officeText.slice(0, 200)}`
  if (f.election_id) out.election_id = f.election_id
  const website = cleanUrl(f.website)
  if (website) out.website = website
  const x = cleanXHandle(f.twitter_handle)
  if (x) out.twitter_handle = x
  const fb = cleanUrl(f.facebook_url)
  if (fb) out.facebook_url = fb
  const photo = cleanPhotoUrl(f.photo_url)
  if (photo) out.photo_url = photo
  for (const [k, v] of Object.entries(extras || {})) {
    if (k in EXTRA_FIELDS && typeof v === 'string' && v.trim()) out[k] = v.trim()
  }
  return out
}

/** PostgREST's answer when a column isn't in the table (yet). */
export function isMissingColumnError(error, column) {
  const text = [error?.message, error?.details, error?.hint].filter(Boolean).join(' ')
  return !!column && text.includes(column) && /column|schema cache/i.test(text)
}

export function withoutColumn(payload, column) {
  const { [column]: _drop, ...rest } = payload || {}
  return rest
}

/** First add on an empty page is probably the user themself. */
export function defaultRole(candidates) {
  return (candidates || []).length === 0 ? 'self' : 'opponent'
}

/** Friendly words for a lookup that didn't answer 200. */
export function lookupFailureMessage(status, serverError) {
  if (status === 401) return 'Your sign-in expired, so we couldn’t look them up. Fill in what you know — or sign in again and retry.'
  if (status === 403) return serverError || 'Lookups aren’t included with your plan. Fill in what you know below.'
  if (status === 429) return 'You’ve done a lot of lookups in a row. Fill in what you know, or try again in a few minutes.'
  return 'We couldn’t reach the lookup just now. Fill in what you know below.'
}
