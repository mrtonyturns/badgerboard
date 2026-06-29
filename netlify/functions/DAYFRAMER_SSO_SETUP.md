# DayFramer One-Click SSO — Setup Guide

Goal: a Badger Board user clicks a Marketing tool → it opens in a new tab →
they're **already logged into DayFramer** (no second login), and the session
**persists** across refreshes/navigation.

This works by making **Supabase** (Badger Board's auth) the **OIDC identity
provider** that DayFramer (GoHighLevel, $497 white-label tier) authenticates
against. Verified feasible by research:
- Supabase added OIDC *provider* capability (Dec 2025) — exposes the discovery,
  authorization, token, JWKS, and UserInfo endpoints GHL's SSO needs.
- GHL OIDC SSO **coexists** with normal login — enabling it does NOT break
  email/password or Google login for your other DayFramer users, as long as you
  leave the **"Hide other login options"** toggle OFF.

> Why a new tab and not an iframe: cross-origin iframe embedding of GHL is
> impossible — browsers block the third-party session cookie, logging the user
> out on every refresh/navigation. A first-party tab has none of that problem.

---

## Part 1 — Supabase: turn on the OAuth/OIDC server

1. Supabase Dashboard → your project (`cwsaskvanrzucufualbs`) → **Authentication**
   → **OAuth Server** (a.k.a. OAuth2.1 / OIDC provider). Enable it.
2. Ensure an **asymmetric signing key** is active (required for OIDC ID tokens —
   Supabase will prompt / it's the RS256/ES256 JWT signing key).
3. **Register a client** for DayFramer:
   - Client name: `DayFramer SSO`
   - Redirect URI / callback: `https://account.dayframer.com/login/sso`
     (GHL's fixed SSO callback — exact, no trailing slash)
   - Grant type: Authorization Code + PKCE
   - Scopes: `openid profile email`
4. Copy the generated **Client ID** and **Client Secret** — you'll paste them
   into GHL.
5. Note your **discovery URL** (Supabase exposes it):
   `https://cwsaskvanrzucufualbs.supabase.co/auth/v1/.well-known/openid-configuration`
   (If GHL asks for individual endpoints instead of a discovery URL, open that
   URL in a browser — it lists `authorization_endpoint`, `token_endpoint`,
   `userinfo_endpoint`, and `jwks_uri` to copy.)

---

## Part 2 — GoHighLevel / DayFramer: add Supabase as the SSO IdP

In DayFramer as agency owner: **Settings → Company → Single Sign-On (SSO)**
(agency-level; admins only).

1. **Provider:** choose OIDC / "Custom OIDC" (GHL is OIDC-only).
2. Fill in from Part 1:
   - **OIDC Config / Discovery URL:** the `.well-known/openid-configuration` URL
     above. (Or paste Authorization URL, Token Endpoint, User Info Endpoint
     manually.)
   - **Client ID** and **Client Secret:** from Supabase.
   - **Scopes:** `openid profile email`
3. **Claim/field mappings:**
   - Remote ID Field → `sub`
   - Email Field → `email`
   - Email Verified Field → `email_verified`
4. **Additional Settings — IMPORTANT:**
   - **Enable SSO:** ON
   - **Hide other login options:** **LEAVE OFF.** This keeps email/password and
     Google login working for staff and other clients who use DayFramer
     directly. (Turning it ON forces everyone agency-wide through Supabase —
     don't, unless every DayFramer user is a Badger Board user.)
5. Save.

> Scope caveat: GHL SSO is configured agency-wide; there's no per-sub-account
> setting. Leaving "Hide other login options" OFF is what makes this safe.

---

## Part 3 — Badger Board side (already done in code)

- The Marketing tab is a **launcher**: each tool opens its deep URL
  (`/v2/location/<id>/<tool>`) in a new tab via `dayframer-sso.js`.
- For a user with no GHL session, GHL redirects that tab to `/login/sso` →
  Supabase (already has their Badger Board session) → back to the tool URL,
  signed in.
- `DAYFRAMER_APP_URL` = `https://account.dayframer.com` (set).
- Optional `DAYFRAMER_SSO_SECRET` adds a signed `bb_sso` token to the URL —
  not required for OIDC SSO; leave unset unless you build a custom validator.

---

## The one thing to verify live (deep-link)

Research confirmed GHL does **not** honor a relay-state/return-URL *through* the
`/login/sso` redirect — so the open question is whether, after SSO completes,
the user lands on the **tool** (because we opened the deep URL) or gets bounced
to the **dashboard**. Two outcomes:

- **Best case:** GHL returns to the originally-requested deep URL after SSO →
  user lands directly on QR Codes / Social Planner. ✅
- **Fallback:** GHL lands them on the dashboard after first-ever SSO login. On
  the *next* open (session now exists) the deep URL resolves directly. If the
  first-time bounce is annoying, we can add a tiny post-login redirect.

Test after Parts 1–2: click a tool in Badger Board, confirm (a) no separate
login prompt, and (b) where it lands. Report back and we'll tune if needed.

---

## Rollback / safety
- Nothing here changes how Badger Board users log into Badger Board.
- "Hide other login options" OFF means DayFramer's normal logins are untouched.
- To undo: toggle **Enable SSO** OFF in GHL, and delete the `DayFramer SSO`
  client in Supabase.
