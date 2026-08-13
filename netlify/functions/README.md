# Badger Board — Netlify Functions

All server-side logic lives here as individual Netlify Functions (bundled with esbuild,
Node 22). Files prefixed with `_` are **shared modules, not endpoints** — a redirect in
`netlify.toml` blocks them from being invoked, and Netlify skips them at deploy.

## Shared modules

| File | Purpose |
|------|---------|
| `_shared.js` | CORS headers, JSON response helper, `requireUser` / `requireAdmin` JWT verification, service-role Supabase client factory. Use these in every new function. |
| `_config.js` | `ADMIN_EMAILS` — the single source of truth for admin access. |
| `_email.js`, `_email-templates.js` | Resend email sending + HTML templates. |

## Function inventory (by domain)

**Billing / Stripe** — `create-checkout-session`, `create-portal-session`, `update-subscription`,
`cancel-at-period-end`, `downgrade-to-free`, `payment-webhook`,
`stripe-webhook`, `manage-coupons`, `admin-stripe-setup`, `admin-billing`

**AI research / dossiers** — `generate-dossier`, `generate-dossier-background`,
`auto-regenerate-dossiers` (scheduled Mon 15:00 UTC), `dossier-review`, `create-dossier-share`,
`get-shared-dossier` (public), `generate-bio-summary`, `generate-campaign-intel`,
`research-incumbent`, `research-swot`, `autofill-candidate`, `discover-candidates`,
`classify-csv-prospects`, `generate-prospecting`, `fetch-candidate-x-feed`

**Offices** — `admin-offices` (all office writes, admin-gated service-role with a column
whitelist). Migration 20260704000004 dropped the offices insert/update/delete RLS policies,
so the browser client can no longer write them; `createOffice`/`updateOffice`/`deleteOffice`
in `src/lib/supabase.js` route here.

**Elections** — `admin-elections` (all election/contest/result writes, admin-gated service-role;
runs the determination engine in `_determination.js` after every vote or precinct change and
logs each mutation to `election_poller_log`), `election-results-poller` (scheduled; see below).
Results flow realtime to the board. `election-night-update` was deleted in Phase 1 of the
live-results build — it was never scheduled, never called, wrote to a JSON blob nothing read,
and carried two crash bugs.

### `election-results-poller` (scheduled, Phases 2–3)

The cron in `netlify.toml` is `*/5 * * * *` — every five minutes, every day. The function
itself decides whether the invocation is inside an election-night window and returns
immediately when it is not: no Supabase query, no Perplexity call, no log row. Netlify cron
is UTC and Central time moves with DST, so the window is computed from a real
`Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago' })` conversion, never a hardcoded
offset.

| Central time | Behaviour |
|---|---|
| Election day 20:00–21:59 | runs every 5 minutes |
| Election day 22:00–23:59 | runs hourly (only when minute < 5) |
| Next day 00:00–03:59 | runs hourly (only when minute < 5) — 04:00 is the exclusive end of the overnight window, so 4 AM does **not** run |
| Next day 10:00–10:04 | one final sweep |
| everything else | exits immediately, logs nothing |

"Election day" means an `elections` row whose `election_date` is today in CT (or yesterday in
CT for the after-midnight and 10 AM runs).

Each active run: loads the election's contests and results → if the election has **zero**
contests and it is past 20:30 CT, one Perplexity (`sonar`) discovery call creates tonight's
statewide contests and zeroed candidate rows (unparseable JSON is logged and skipped, never
guessed) → one batched Perplexity call pulls current unofficial totals and precincts for every
contest at once → **every number is validated before any write** → results are upserted on
`(contest_id, candidate_name)`, `vote_pct` is recomputed, precincts are updated, and
`determineStatus()` from `_determination.js` writes status **only where
`status_source = 'auto'`** (an admin-pinned contest still gets fresh numbers, never a new
status). Winner flags mirror the math on `called` / `recount_possible`; `declared` is never
touched by the poller.

Perplexity is used strictly as an **extractor** of numbers somebody else has already
published. Both prompts forbid estimating, projecting, modelling or rounding, and the results
prompt requires a cited source per contest — a contest returned without one is quarantined.

Validation (all of it in `validateContestUpdate`, pure and unit-tested): candidate names match
case-insensitively with a unique-last-name fallback; an unmatched name may be inserted only in
a contest this run just bootstrapped, otherwise it is quarantined; votes must be whole numbers
at or above the stored value (a decrease is skipped — a real revision confirms itself next
pass); precincts reporting is clamped to precincts total and never moves backwards; a contest
whose merged total reaches 4,000,000 votes is quarantined whole. Everything quarantined is
explained in the log row's `error` field and never written.

Every active run writes one `election_poller_log` row: `source` is `poller:auto`
(`poller:manual` when an admin forced it, with a `:dry` suffix for a dry run), plus
`election_date`, `contests_synced`, `results_upserted`, `error` (the joined quarantine notes,
`null` when clean) and `duration_ms`. Any thrown error is caught, logged and answered with
**200** — a scheduled function that 500s gets retried, and a retry storm on election night is
worse than one missed cycle.

**Testing it by hand.** POST `{"force": true, "dry_run": true}` with an admin JWT: `force`
overrides the time window, `dry_run` runs the whole pipeline including validation and skips
every write except the audit row (`source` becomes `poller:manual:dry`). Optional
`{"election_date": "YYYY-MM-DD"}` targets a specific election on a forced run. Any request
without `next_run` in the body — i.e. not from Netlify's scheduler — requires an admin JWT.

⚠️ **Netlify does not allow a scheduled function to be invoked over its public URL.** While the
`schedule` key is set in `netlify.toml`, `POST https://badgerboardwi.com/.netlify/functions/
election-results-poller` will not reach this code in production. Use one of:

- `netlify dev` + `netlify functions:invoke election-results-poller --payload '{"force":true,"dry_run":true}'`
  (local, with production env vars pulled down) — the normal testing path;
- the **Run now** button on the Netlify Functions page, which fires it with the scheduler's own
  payload, so it runs as `poller:auto` and obeys the time window (no force, no dry run);
- temporarily commenting the `schedule` line out of `netlify.toml` on a branch deploy, which
  turns it back into an ordinary HTTP function.

Other Netlify limits worth knowing: scheduled functions have a hard **30-second** execution
limit (hence `POLLER_BUDGET_MS`, default 24000, which stops new network calls in time for the
audit row to be written), they only fire on **published production deploys** (never on Deploy
Previews or branch deploys), and the cron is evaluated in **UTC** — which is exactly why the
Central-time window is computed inside the function.

**Volunteers / field** — `volunteer-auth`, `invite-volunteer`

**Admin / ops** — `admin-dashboard`, `admin-set-tier`, `admin-setup-candidate-storage` (one-shot),
`seed-wi-offices` (one-shot, `x-admin-secret`), `run-security-audit`, `error-log`, `support-chat`

**Integrations** — `ghl-contact`, `ghl-webhook` (GoHighLevel/Dayframer)

## Environment variables (set in Netlify UI)

`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`,
`PERPLEXITY_API_KEY`, `XAI_API_KEY`, `X_BEARER_TOKEN`, `STRIPE_SECRET_KEY`, `RESEND_API_KEY`
(send-only scope), `GHL_AGENCY_API_KEY`, `GHL_COMPANY_ID`, `DAYFRAMER_APP_URL`,
`DAYFRAMER_SNAPSHOT_ID`, `ADMIN_SETUP_TOKEN`, `MARKETING_GATING_ENABLED`,
plus `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` for the frontend build.

## Conventions

- New functions: import helpers from `_shared.js`; return `json(status, body, cors())`.
- Admin endpoints must call `requireAdmin(event)` (JWT + `ADMIN_EMAILS`), not ad-hoc checks.
- Public endpoints (webhooks, embeds, shared links) use `cors(true)` and must validate
  their own tokens/signatures.
- One-shot setup scripts get archived to `../functions-archive/` once run.

## Archive

`netlify/functions-archive/` holds retired functions kept for reference
(`apply-dk-migration` — superseded by localStorage turf storage; `election-results-poller` —
the old WEC-API poller, replaced by the Perplexity-extraction poller described above; the WEC
"live results" API it targeted does not exist). Nothing in that folder is deployed.
