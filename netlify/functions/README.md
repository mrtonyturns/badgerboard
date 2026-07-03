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
`cancel-at-period-end`, `downgrade-to-free`, `buy-dossier-credits`, `payment-webhook`,
`stripe-webhook`, `manage-coupons`, `admin-stripe-setup`, `admin-billing`

**AI research / dossiers** — `generate-dossier`, `generate-dossier-background`,
`auto-regenerate-dossiers` (scheduled Mon 15:00 UTC), `dossier-review`, `create-dossier-share`,
`get-shared-dossier` (public), `generate-bio-summary`, `generate-campaign-intel`,
`research-incumbent`, `research-swot`, `autofill-candidate`, `discover-candidates`,
`classify-csv-prospects`, `generate-prospecting`, `fetch-candidate-x-feed`

**Elections** — `election-night-update` (manual admin entry; results flow realtime to the board)

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
WEC polling replaced by manual admin entry). Nothing in that folder is deployed.
