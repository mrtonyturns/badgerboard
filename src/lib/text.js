// src/lib/text.js — small pure string helpers shared across pages.
//
// `plural` had three copies: src/pages/settings/shared.jsx,
// src/pages/profiler/shared.jsx and src/pages/profiler/reportModel.js. All
// three were the same expression. This module is dependency-free so the
// settings and profiler shells can import it without pulling in each other's
// page trees (the reason those files copy tokens rather than import them).

/**
 * "1 candidate" / "3 candidates" / "2 people" — the count is always included.
 * @param {number} n
 * @param {string} one   singular noun
 * @param {string} [many] irregular plural; defaults to `one + 's'`
 */
export const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || `${one}s`)}`
