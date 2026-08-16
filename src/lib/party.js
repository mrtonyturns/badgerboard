// src/lib/party.js — ONE party vocabulary for the whole app.
//
// Root cause of the AD77 "+R" bug (Aug 12 2026): election_results carried two
// spellings — 'Democrat' (the candidates-table canon) and 'Democratic' (from
// the Aug-11 ballot seed) — and nine call sites compared strictly against
// 'Democrat'. Democratic votes silently counted as zero in the district lean
// math, painting deep-blue districts red. Every consumer now normalizes
// through partyGroup(); never string-compare party names directly again.

/** 'R' | 'D' | 'I' | 'L' | 'G' | 'N' | 'O' (other/unknown) */
export function partyGroup(p) {
  const s = String(p || '').trim().toLowerCase()
  if (!s) return 'O'
  if (s.startsWith('rep') || s === 'gop' || s === 'r') return 'R'
  if (s.startsWith('dem') || s === 'd') return 'D'
  if (s.startsWith('ind') || s === 'i') return 'I'
  if (s.startsWith('lib')) return 'L'
  if (s.startsWith('gre')) return 'G'
  if (s.startsWith('non') || s === 'n') return 'N'
  return 'O'
}

export const isRep = (p) => partyGroup(p) === 'R'
export const isDem = (p) => partyGroup(p) === 'D'

/**
 * The exact strings the `candidates.party` CHECK constraint accepts. Anything
 * else — including '' — is rejected by the DB, so every write path has to land
 * on one of these or on null. campaignEnums.PARTIES re-exports this list; it
 * lives here so the normalizer below and the vocabulary share one array.
 */
export const DB_PARTIES = [
  'Republican', 'Democrat', 'Independent', 'Libertarian',
  'Green', 'Constitution', 'Working Families', 'Nonpartisan', 'Other',
]

/**
 * Free text → a value `candidates.party` will accept, or null.
 *
 * Exact (case-insensitive) match first, so 'Constitution' and 'Other' — which
 * have no party family — survive. Then the partyGroup() family, so 'Democratic',
 * 'DEM', 'GOP', 'R' and friends land on the canonical spelling instead of a 400.
 * Unknown text ('Pirate') and blanks return null rather than '' — the CHECK
 * constraint rejects the empty string.
 *
 * Every write path that puts user-supplied party text into `candidates` uses
 * this: the Candidates CSV import, the AI-discover "add" button, and the bulk
 * profiler CSV. They each had their own idea of the rules before (or none).
 */
export function normalizePartyForDb(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return null
  const exact = DB_PARTIES.find(p => p.toLowerCase() === s.toLowerCase())
  if (exact) return exact
  const g = partyGroup(s)
  if (g === 'O') return null
  return DB_PARTIES.find(p => partyGroup(p) === g) ?? null
}

/** Single-letter abbreviation for chips ("R", "D", "I", …). */
export const partyAbbrev = (p) => {
  const g = partyGroup(p)
  return g === 'O' ? (String(p || '?')[0] || '?').toUpperCase() : g
}

/**
 * VAN / VoteBuilder PartyCode — the single letter that vendor file expects.
 *
 * NOT the same thing as partyAbbrev(): the VAN export used to write
 * `party.toUpperCase().charAt(0)`, so a 'GOP' voter went out as **G**, which is
 * Green's code in a VAN file. That is an externally visible corruption of a
 * vendor file — the Republicans in the export silently become Greens once
 * VoteBuilder ingests it. Route the family through partyGroup() instead.
 *
 * Codes: R Republican · D Democrat · G Green · L Libertarian · I Independent ·
 * N Nonpartisan · O other/unrecognised · U blank (unknown, what the export
 * already emitted for a voter with no party on file).
 */
const VAN_CODE = { R: 'R', D: 'D', G: 'G', L: 'L', I: 'I', N: 'N', O: 'O' }
export function partyVanCode(p) {
  const s = String(p ?? '').trim()
  if (!s) return 'U'                       // unchanged behaviour for no-party rows
  return VAN_CODE[partyGroup(s)] || 'O'    // 'Constitution', 'Pirate', … → O, never their initial
}

/** Hex colors (match the existing dashboard palette). */
const HEX = { R: '#B91C1C', D: '#1D4ED8', I: '#7C3AED', L: '#B45309', G: '#15803D', N: '#64748B', O: '#64748B' }
export const partyColorHex = (p) => HEX[partyGroup(p)]

/** Map-dot palette (matches LeafletMapView's original colors). */
const MAP_HEX = { R: '#dc2626', D: '#2563eb', I: '#7c3aed', L: '#b45309', G: '#15803d', N: '#6b7280', O: '#6b7280' }
export const partyMapHex = (p) => MAP_HEX[partyGroup(p)]

/** Tailwind badge classes (matches the existing badge styling). */
const BADGE = {
  R: 'bg-red-100 text-red-700',
  D: 'bg-blue-100 text-blue-700',
  I: 'bg-purple-100 text-purple-700',
  L: 'bg-amber-100 text-amber-700',
  G: 'bg-green-100 text-green-700',
  N: 'bg-gray-100 text-gray-600',
  O: 'bg-gray-100 text-gray-600',
}
export const partyBadgeClasses = (p) => BADGE[partyGroup(p)]
