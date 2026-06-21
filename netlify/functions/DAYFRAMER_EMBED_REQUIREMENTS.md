# Marketing Tab — Embedding Requirements (action items for DayFramer/GHL)

To embed the marketing tools (Email Campaigns, Social Planner, QR Codes)
*inside* Badger Board with a persistent session and without the tool's own
navigation chrome, the **DayFramer white-label side** must change a few things.
These cannot be done from Badger Board's code — they are server/response-header
and account settings controlled by the DayFramer agency + GoHighLevel.

## Background — the blocker

`account.dayframer.com` currently returns:

```
X-Frame-Options: SAMEORIGIN
```

This header tells every browser: "only my own domain may iframe me." Because
Badger Board (`badgerboardwi.com`) is a different origin, the browser **refuses
to render the embed** — a blank frame, regardless of anything we do on our side.
There is no Badger Board–side workaround for a response header set by their
server.

## What DayFramer / GHL must change

### 1. Allow Badger Board to frame the white-label app  *(required for embedding)*
Replace the blanket `X-Frame-Options: SAMEORIGIN` with a CSP `frame-ancestors`
directive that allowlists our domains:

```
Content-Security-Policy: frame-ancestors 'self' https://www.badgerboardwi.com https://*.badgerboardwi.com https://*.netlify.app
```

(`*.netlify.app` is only needed for testing on draft deploys — can be dropped
for production.) `frame-ancestors` supersedes `X-Frame-Options`, so the old
header should be removed (browsers honor the more restrictive of the two if
both are present).

This is typically configured by GHL support for a white-label agency, or via a
Cloudflare/edge rule on `account.dayframer.com` (it's served through Cloudflare).

### 2. Persistent session inside the iframe  *(required for "stay logged in")*
The login cookie on `account.dayframer.com` must be sent in a third-party
(framed) context. That requires:

```
Set-Cookie: ...; SameSite=None; Secure
```

(The `__cf_bm` cookie already uses `SameSite=None; Secure`; the **auth/session**
cookie must do the same.) Without this, the browser drops the session cookie
when the app is framed cross-site, forcing a fresh login every visit — which is
exactly the "login isn't persistent" symptom.

### 3. (Optional) A chrome-less / embed view  *(for "main area only")*
To hide the tool's own left sidebar + top bar and show only the working area,
the white-label app needs an embed mode — usually one of:
- a URL parameter the app respects (e.g. `?embed=true` / `?chromeless=1`), or
- a dedicated embed route, or
- agency CSS that hides nav when framed.

GHL does not expose this by default. If it's not available, the fallback is to
accept the tool's own nav inside the frame. (We cannot hide it with CSS from our
side — cross-origin iframes block parent CSS/JS access.)

## What Badger Board already does (ready on our side)
- Points the embed at `DAYFRAMER_APP_URL` (set to `https://account.dayframer.com`)
- Adds the white-label + leadconnector domains to our CSP `frame-src` so *we*
  permit the frame (the remaining block is their XFO, item 1 above)
- Sends a short-lived signed `bb_sso` token on the embed URL (harmless if unused;
  ready if DayFramer ever validates it)
- "Open in new tab" fallback so the tools are usable even while framing is blocked

## Summary for the DayFramer owner
> On `account.dayframer.com`: (1) allow `badgerboardwi.com` in `frame-ancestors`
> and drop `X-Frame-Options: SAMEORIGIN`; (2) make the session cookie
> `SameSite=None; Secure`; (3) optionally provide a chrome-less embed view.
> Items 1–2 unblock the embed + persistent login; item 3 gives the clean
> main-area-only look.
