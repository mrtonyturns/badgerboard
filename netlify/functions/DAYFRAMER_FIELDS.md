# DayFramer (GoHighLevel) Sub-Account — Field Mapping & Gaps

Reference for the Marketing tab integration. Documents every field GHL's
`POST /locations/` (Create Sub-Account) endpoint accepts, what Badger Board
currently captures, and what we'd need to add to fill the gaps.

Schema below was verified empirically against the **live** GHL v2 API
(throwaway sub-account created, fields read back, then deleted). GHL uses a
strict whitelist — unknown top-level properties return
`422 property <x> should not exist`.

---

## What we send today

| GHL field | Source (Badger Board) | Notes |
|---|---|---|
| `name` *(required)* | `business` → `"{First Last}'s Campaign"` → `"My Campaign"` | Company name preferred; never a raw email |
| `companyId` *(required)* | `GHL_COMPANY_ID` env / auto-discovered | Agency company, not user data |
| `phone` | `user_metadata.phone` | Optional at signup |
| `website` | derived from email domain | Skips free providers (gmail, outlook, …) |
| `timezone` | hard-coded `America/Chicago` | WI-focused default; user can change in DayFramer |
| `prospectInfo.firstName` | `user_metadata.first_name` | Required at signup |
| `prospectInfo.lastName` | `user_metadata.last_name` | Required at signup |
| `prospectInfo.email` | account `email` | |
| `settings.allowDuplicateContact` | hard-coded `false` | |

---

## Fields GHL accepts that we DON'T send (gap list)

These are valid sub-account fields we leave empty. **Badger Board does not
capture the data for them today** — listed here for the post-integration
discussion about whether to add them to signup/settings.

### Business address — NOT captured by Badger Board
| GHL field | Could come from | Worth adding? |
|---|---|---|
| `address` | new signup/settings field | Maybe — useful for local-business marketing, mailers |
| `city` | new field | Maybe |
| `state` | new field | Maybe — would also let us set a real `timezone` instead of defaulting |
| `country` | new field (default `US`) | Low — default US |
| `postalCode` | new field | Maybe — useful for geo-targeting |

### Branding — NOT captured
| GHL field | Could come from | Worth adding? |
|---|---|---|
| `logoUrl` | new upload, or Badger Board brand asset | Maybe — makes the workspace look polished out of the box |

### Social profiles — NOT applicable
`social{}` accepts: `facebookUrl`, `instagram`, `twitter`, `linkedIn`,
`youtube`, `pinterest`, `googlePlus`, `foursquare`, `yelp`, `blogRss`,
`googlePlacesId`.
| Decision | Reasoning |
|---|---|
| **Do NOT send** | The only social links Badger Board stores live on **candidate** records (the politicians being researched) — that is research data about other people, not the account holder's own social presence. It would be wrong to push it into the user's DayFramer workspace. We do not capture the account holder's own socials, so there's nothing correct to send. |

### Other accepted fields
| GHL field | Status |
|---|---|
| `snapshotId` | **IMPLEMENTED** — set via `DAYFRAMER_SNAPSHOT_ID` env var (an agency asset, not user data). Every new sub-account gets the snapshot's pre-built funnels/email/social templates. Unset → field is simply omitted, no effect. |
| `settings.allowDuplicateOpportunity`, `allowFacebookNameMerge`, `disableContactTimezone`, `contactUniqueIdentifiers` | Behavior toggles; defaults are fine |

---

## Captured by Badger Board but NOT sent to GHL

| Badger Board field | Why not sent | Option |
|---|---|---|
| `position` (e.g. "Campaign Manager") — *required at signup* | No matching field on the GHL **location** schema | Could attach to the connected GHL **user**, or as a sub-account custom field / tag after creation |
| `display_name` | Redundant with first/last name | Used only as a name fallback |

---

## Full input whitelist (top level)

`name`, `companyId`, `phone`, `email`, `website`, `timezone`, `address`,
`city`, `state`, `country`, `postalCode`, `logoUrl`, `snapshotId`,
`prospectInfo{ firstName, lastName, email }`, `social{ … }`, `settings{ … }`

(`business{}` is **read-only output** — GHL mirrors the address fields into it
and rejects it on input.)
