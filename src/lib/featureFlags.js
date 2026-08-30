// ─── App-wide feature flags ──────────────────────────────────────────────────
// Central kill-switches for whole surfaces. Flip a flag and every entry point
// (nav item, tab, button, banner, deep link) honors it — no per-page hunting.

// Election Results (live boards on /elections?tab=results and /game-plan?tab=results).
// Hidden from EVERY account (including admins) per request 2026-08-29.
// Flip to true to restore the Results tabs, nav links, banners, and buttons.
export const RESULTS_ENABLED = false
