# Marketing Tab — Embedding Setup (DayFramer owner guide)

We **own** the DayFramer (GoHighLevel white-label) agency, so we can make the
changes needed to embed the marketing tools (Email Campaigns, Social Planner,
QR Codes) inside Badger Board with a persistent session and minimal chrome.

This file is the owner-side checklist. Everything on the Badger Board side is
already done (see "Badger Board side" at the bottom).

---

## The blocker

`account.dayframer.com` currently returns:

```
X-Frame-Options: SAMEORIGIN
```

This tells every browser "only my own domain may iframe me," so Badger Board
(`badgerboardwi.com`) gets a blank frame. This header is emitted by
GoHighLevel's app servers (the domain is fronted by Cloudflare). It must be
removed/overridden and replaced with a `frame-ancestors` allowlist.

---

## Owner action items

### 1. Allow Badger Board to frame the app  *(unblocks the embed)*
Override the response headers on `account.dayframer.com` so they become:

```
Content-Security-Policy: frame-ancestors 'self' https://www.badgerboardwi.com https://*.netlify.app
```
…and **remove** `X-Frame-Options: SAMEORIGIN` (it has no allowlist form, so it
must go — `frame-ancestors` supersedes it). Drop `*.netlify.app` for production;
it's only for testing on draft deploys.

**Where to do it (in order of preference):**
- **GoHighLevel agency white-label / SaaS settings** — open a GHL support ticket
  as the agency owner asking them to allow `badgerboardwi.com` in the app's
  `frame-ancestors` for your white-label domain. GHL controls the app origin
  headers; this is the cleanest path.
- **Cloudflare (the domain is on Cloudflare — `CF-RAY` confirmed)** — a
  *Response Header Transform Rule* can remove `X-Frame-Options` and set the CSP
  `frame-ancestors`. This works only if the CNAME/proxy for
  `account.dayframer.com` runs through *our* Cloudflare zone (not GHL's). Verify
  who controls the orange-cloud proxy for that hostname before relying on this.

### 2. Persistent session inside the iframe  *(unblocks "stay logged in")*
The auth/session cookie on `account.dayframer.com` must be allowed in a framed
(third-party) context:

```
Set-Cookie: <session>; SameSite=None; Secure
```

If GHL sets the session cookie `SameSite=Lax/Strict`, the browser drops it when
the app is framed cross-site → fresh login every visit (the "login isn't
persistent" symptom). Ask GHL support to set the white-label session cookie
`SameSite=None; Secure`, or confirm it already is.

### 3. Chrome-less view — main area only  *(the clean look)*
We already append `?embed=true` to the tool URL. GHL's app must honor an embed
view that hides its sidebar + top bar. Options as the agency owner:
- Check GHL **white-label / custom CSS** settings — inject CSS that hides the
  nav chrome when the app is framed (`@media` / a body class on embed).
- Or confirm GHL honors an embed/chromeless URL param for your tier.
If neither exists, the tool's own nav shows inside the frame (functional, just
not as clean).

---

## What we CANNOT change (accept it)

A user who opens browser DevTools → Network **will** see calls to
`leadconnectorhq.com` (and `static.leadconnectorhq.com`, Firebase, websockets)
when the tools load. This is **GoHighLevel's own product infrastructure** — its
app talks to its own backend/CDN. **GHL white-labeling renames the login domain
and branding, but NOT the API/CDN/websocket infra**; this is true for every GHL
agency and is not configurable, even as the owner. There is no supported way to
make those runtime calls appear as `dayframer.com`.

Decision: accept it. The *visible* layer is fully controlled — address bar,
iframe src, branding, and all of Badger Board's own backend say DayFramer /
nothing. Effectively no end-user opens DevTools; the leak is inspect-only.

(A reverse proxy through our own domain could mask it but is fragile — GHL
hardcodes domains, websockets, and auth origins — and would break frequently.
Not pursued.)

---

## Badger Board side — already done

- Embed points at `DAYFRAMER_APP_URL` = `https://account.dayframer.com`
  (env var + code default). No `gohighlevel.com` in any user-facing path.
- `?embed=true` appended to request the chrome-less view.
- Our CSP `frame-src` allows `*.dayframer.com` + `*.leadconnectorhq.com` so the
  browser permits the frame once item 1 is done.
- No provider name (GoHighLevel/DayFramer) renders in any UI string — verified.
  "DayFramer" appears only in code identifiers/comments.
- Short-lived signed `bb_sso` token on the URL (harmless if unused; ready if the
  white-label ever validates it).
- "Open in new tab" fallback while framing is still blocked.

Once items 1–2 are done on the DayFramer side, the embed loads and the session
persists with **no further Badger Board code changes**.
