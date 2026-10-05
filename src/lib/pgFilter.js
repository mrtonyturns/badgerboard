// src/lib/pgFilter.js — make user text safe inside PostgREST filters.
// Pure (no Supabase import) so the node test suites can load it directly.
//
// LIKE/ILIKE treat `%` and `_` as wildcards and `\` as the escape character,
// so a search for "50%" or "first_name" matched far more than the user typed.
// (PostgREST additionally turns `*` into `%` in like patterns; there is no
// escape for that, so a literal `*` still acts as a wildcard.)

/** Escape LIKE metacharacters so `s` matches literally inside a pattern. */
export const escapeLike = (s) => String(s ?? '').replace(/[\\%_]/g, (c) => `\\${c}`)

/** `%s%` substring pattern with `s` matched literally — for .ilike(col, …). */
export const likeContains = (s) => `%${escapeLike(s)}%`

/**
 * Quote one value for a PostgREST logic-tree string (.or('col.ilike.<value>,…')).
 * Commas, parentheses, dots and colons are syntax there unless the value is
 * double-quoted; inside quotes `"` and `\` are backslash-escaped.
 */
export const quoteFilterValue = (s) => `"${String(s ?? '').replace(/[\\"]/g, (c) => `\\${c}`)}"`
