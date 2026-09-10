// src/pages/profiler/bulkCsv.js — bulk-generate CSV parsing (SPEC-profiler §2).
//
// Tokenizing is delegated to lib/csv.js `parseCsvRows`, which already handles
// quoted fields, escaped quotes (""), commas and newlines inside quotes, CRLF
// and a leading BOM. This module only does the Profiler-specific part: header
// normalization, the `name` requirement, and the exact failure states.
//
// The error state is gated on "a file was parsed", never on row count — a CSV
// with no `name` column yields zero usable rows and MUST reach the red state.

import { parseCsvRows } from '../../lib/csv'
import { normalizePartyForDb } from '../../lib/party'

export const BULK_COLUMNS = [
  // "Required" is a validation marker, so it uses the app's danger red
  // (T.redHot) — not the brand accent, which is #8B0000 everywhere now.
  { key: 'name',             req: 'Required',    reqColor: '#B91C1C', note: 'Full name as it appears publicly' },
  { key: 'research_context', req: 'Recommended', reqColor: '#B45309', note: 'City, employer, profession — anything that identifies the right person' },
  { key: 'office',           req: 'Optional',    reqColor: '#52525B', note: 'Office sought, e.g. State Assembly' },
  { key: 'district',         req: 'Optional',    reqColor: '#52525B', note: 'District number, blank for at-large or nonpartisan seats' },
  { key: 'party',            req: 'Optional',    reqColor: '#52525B', note: 'Republican, Democrat, Nonpartisan, or leave blank' },
  { key: 'city, county',     req: 'Optional',    reqColor: '#52525B', note: 'Used to disambiguate and to match a district' },
  { key: 'status',           req: 'Optional',    reqColor: '#52525B', note: 'Not Known, Declared, General, Elected — defaults to Not Known' },
]

// CSV `status` values → the candidate status enum in lib/campaignEnums.js.
const STATUS_ALIASES = {
  'not known': 'exploring', 'unknown': 'exploring', 'exploring': 'exploring', 'prospect': 'exploring',
  'declared': 'declared',
  'primary winner': 'primary_winner', 'primary_winner': 'primary_winner',
  'general': 'general',
  'elected': 'elected', 'incumbent': 'elected',
  'lost': 'lost',
  'withdrawn': 'withdrawn',
}

export function normalizeStatus(raw) {
  const k = String(raw || '').trim().toLowerCase()
  return STATUS_ALIASES[k] || null
}

const normHeader = (h) => String(h || '').trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '')

/**
 * @returns {{
 *   headers: string[],           // normalized headers, in file order
 *   rawHeaders: string[],        // exactly what the file said (for the error card)
 *   rows: object[],              // rows with a non-empty name
 *   totalRows: number,           // data rows found, before the name filter
 *   missingName: boolean,        // no `name` column in the header
 *   ok: boolean,
 * }}
 */
export function parseBulkCsv(text) {
  const table = parseCsvRows(text).filter(r => r.some(c => String(c || '').trim()))
  if (!table.length) {
    return { headers: [], rawHeaders: [], rows: [], totalRows: 0, missingName: true, ok: false }
  }

  const rawHeaders = table[0].map(h => String(h || '').trim())
  const headers    = rawHeaders.map(normHeader)
  const missingName = !headers.includes('name')

  const rows = []
  for (const cells of table.slice(1)) {
    const o = {}
    headers.forEach((h, i) => { if (h) o[h] = String(cells[i] ?? '').trim() })
    rows.push(o)
  }
  const named = rows.filter(r => (r.name || '').trim())

  return {
    headers,
    rawHeaders,
    rows: named,
    totalRows: rows.length,
    missingName,
    ok: !missingName && named.length > 0,
  }
}

/** The exact failure copy from SPEC §2 — two distinct reasons. */
export function bulkFailure(parsed) {
  if (!parsed || parsed.ok) return null
  if (parsed.missingName) {
    return {
      title: 'No "name" column found',
      body: 'Profiler needs a column headed "name" holding each candidate’s full name. ' +
            'Rename your name column to "name" and upload again — every other column is optional.',
    }
  }
  return {
    title: 'No candidates found in this file',
    body: 'The file parsed, but every row had an empty name. Check that the first row is a header ' +
          'and that each following row has a name filled in.',
  }
}

/** "State Assembly, District 1" — blank district and blank office both tolerated. */
export function rowOfficeLabel(row) {
  const office   = (row.office || '').trim()
  const district = (row.district || '').trim()
  if (office && district) return `${office}, District ${district}`
  return office || (district ? `District ${district}` : '')
}

/** The research context a row carries, including the geography it can spare. */
export function rowContext(row) {
  const ctx = (row.research_context || '').trim()
  if (ctx) return ctx
  return ''
}

/** Everything a row can tell createCandidate, minus anything it doesn't say. */
export function rowToCandidatePatch(row) {
  const patch = { name: (row.name || '').trim() }
  const ctxBits = []
  const given = (row.research_context || '').trim()
  if (given) ctxBits.push(/[.!?;]$/.test(given) ? given : `${given}.`)
  const place = [row.city, row.county && `${row.county} County`].map(s => (s || '').trim()).filter(Boolean).join(', ')
  const office = rowOfficeLabel(row)
  if (office) ctxBits.push(`Running for ${office}.`)
  if (place)  ctxBits.push(`Based in ${place}, Wisconsin.`)
  const ctx = ctxBits.join(' ').trim()
  if (ctx) patch.research_context = ctx.slice(0, 1000)
  // The party column is free text in a spreadsheet — 'Democratic', 'DEM',
  // 'GOP', 'R'. candidates.party has a CHECK constraint, so anything that
  // isn't one of its exact values (or a recognizable family) has to be dropped
  // rather than passed through: an unrecognized string 400s the whole insert
  // and the row never becomes a candidate at all.
  const party = normalizePartyForDb(row.party)
  if (party) patch.party = party
  patch.status = normalizeStatus(row.status) || 'exploring'
  return patch
}
