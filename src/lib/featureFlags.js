// ─── App-wide feature flags ──────────────────────────────────────────────────
// Kill-switches for whole surfaces. Flip a flag to true and every entry point
// (sidebar item, section tab, route, header title, in-page buttons and links,
// pricing copy, support-chat knowledge) comes back — nothing was deleted.
//
// Oct 25 2026 (Tony): Compare, Elections, Results and the Campaign → Calendar
// are removed from the app "entirely for now". Hidden from EVERY account,
// admins included. The admin Elections console (results entry / certify) and
// the dashboard's next-race countdown + election card are deliberately kept.
//
// When flipping one back on, also restore its section in
// netlify/functions/_support-kb.js so the support chat knows it exists again.

export const COMPARE_ENABLED           = false  // /compare + every "Compare" button
export const ELECTIONS_ENABLED         = false  // /elections (Intelligence → Elections)
export const RESULTS_ENABLED           = false  // results boards (/elections?tab=results, /game-plan?tab=results)
export const ELECTION_CALENDAR_ENABLED = false  // Campaign → Calendar (/game-plan?tab=calendar)
