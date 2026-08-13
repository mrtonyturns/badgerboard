// netlify/functions/_party.js — CJS mirror of src/lib/party.js.
//
// Netlify functions are CommonJS and cannot import the ESM app helper, so the
// vocabulary lives here too. Keep the two files IN SYNC — tests/remediation
// asserts they agree on every spelling ('Democrat' / 'Democratic' / 'DEM' / …).
//
// Root cause it guards: election_results carries both 'Democrat' and
// 'Democratic'; anything that string-compares one spelling silently counts the
// other as zero (the AD77 "+R" bug, Aug 12 2026).

/** 'R' | 'D' | 'I' | 'L' | 'G' | 'N' | 'O' (other/unknown) */
function partyGroup(p) {
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

const isRep = (p) => partyGroup(p) === 'R'
const isDem = (p) => partyGroup(p) === 'D'

/** Single-letter abbreviation for chips ("R", "D", "I", …). */
const partyAbbrev = (p) => {
  const g = partyGroup(p)
  return g === 'O' ? (String(p || '?')[0] || '?').toUpperCase() : g
}

/** Hex colors (match the existing dashboard palette). */
const HEX = { R: '#B91C1C', D: '#1D4ED8', I: '#7C3AED', L: '#B45309', G: '#15803D', N: '#64748B', O: '#64748B' }
const partyColorHex = (p) => HEX[partyGroup(p)]

module.exports = { partyGroup, isRep, isDem, partyAbbrev, partyColorHex }
