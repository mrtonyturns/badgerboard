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

/** Single-letter abbreviation for chips ("R", "D", "I", …). */
export const partyAbbrev = (p) => {
  const g = partyGroup(p)
  return g === 'O' ? (String(p || '?')[0] || '?').toUpperCase() : g
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
