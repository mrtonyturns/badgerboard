import React, { useState, useRef, useEffect, useLayoutEffect, useCallback, Suspense } from 'react'
import { Outlet, NavLink, useNavigate, useLocation, Link } from 'react-router-dom'
import {
  LayoutDashboard, Building2, CalendarDays, Target, Users, ListChecks,
  FileText, Settings, LogOut, Menu, X, ChevronRight,
  User, CreditCard, Shield, ChevronDown, Tag, UserCheck,
  ShieldCheck, Sparkles, Check, Scale, MessageCircle, Send, ExternalLink, Users2, Swords, BarChart2, FlaskConical,
  UserPlus,
} from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'
import BluejackLogo from './BluejackLogo'
import BadgerBoardLogo from './BadgerBoardLogo'
import { getUserTier, getTierConfig, isBetaActive, getUserPlanType } from '../lib/tiers'
import { isNativeApp } from '../lib/native'

// ── Offline banner ─────────────────────────────────────────────────────────────
// Shown while the device has no connection. Reads (recently viewed data) are
// served from the on-device cache; door-knock logging queues via offlineQueue.
function OfflineBanner() {
  const [offline, setOffline] = React.useState(
    typeof navigator !== 'undefined' && navigator.onLine === false
  )
  React.useEffect(() => {
    const on  = () => setOffline(false)
    const off = () => setOffline(true)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [])
  if (!offline) return null
  return (
    <div className="bg-amber-500 text-white text-xs font-semibold text-center px-4 py-2">
      You&apos;re offline — showing recently viewed data where available. Changes to door-knock logs will sync when you reconnect.
    </div>
  )
}
import NotificationCenter from './NotificationCenter'
import LoadingBar from './LoadingBar'
import PaymentLockOverlay from './PaymentLockOverlay'
import { useDossierStatus } from '../contexts/DossierStatusContext'

const APP_VERSION = 'v1.40.1'

// ─── z-index scale (v1.34.1 — audit fix B1) ──────────────────────────────────
// One ladder for everything that floats, lowest to highest:
//
//   CHROME  10   in-page chrome: overlays that belong to the page itself
//   STICKY  20   sticky bars, sticky table headers, section rails
//   POPOVER 25   popovers/dropdowns anchored to chrome (the changelog panel)
//   CHAT    30   the floating support chat — FAB *and* panel
//   DRAWER  35   the mobile nav drawer (must beat the chat it covers)
//   MODAL   40   FLOOR of the modal band — blocking dialogs live at 40 and up
//   TOAST 9999   transient toasts + the global route LoadingBar
//
// Why the chat moved from 9998/9999 down to 30: it painted over every modal in
// the app and over the mobile nav drawer. It is a passive helper, so it now
// sits below the whole modal band and below the drawer. Audited modal band as
// of this change: 40 / 41 (Dossiers + Prospecting menu backdrops), 50 (most
// dialogs), 60 (Prospecting confirm, ClaimReviewer), 70 (ShareModal,
// BulkModal, Dossiers viewer), 80 (ReportReader). The lowest is 40, so
// CHAT=30 and DRAWER=35 clear everything without renumbering a single modal —
// renumbering the app's dialogs is explicitly out of scope here.
//
// Deliberately left alone (they are not part of this ladder):
//   • Prospecting's portal contact popover (9998/9999) — it escapes an
//     overflow-clipped table and competes with no modal.
//   • Offices' map modal (z-[10000]) and the map overlays at 1000–3000 — they
//     have to clear Leaflet's own panes.
// Map panes are the one thing that used to out-paint this scale from below;
// src/index.css now gives map containers their own stacking context so 400–700
// pane values stay inside the map instead of leaking into the page.
export const Z = {
  CHROME:  10,
  STICKY:  20,
  POPOVER: 25,
  CHAT:    30,
  DRAWER:  35,
  MODAL:   40,
  TOAST:   9999,
}

// ─── Changelog (newest first) ────────────────────────────────────────────────
const CHANGELOG = [
  {
    version: 'v1.40.1',
    date: 'September 21, 2026',
    changes: [
      'Polling snapshots no longer hang forever on “Building the snapshot…” — the job is started reliably, dead jobs surface as an error with Try again, and the page stops waiting after 3 minutes',
      'Events hides dates that have already passed, warns when results are over a week old, and refreshes stale results automatically',
      'Admin “Active This Week” counts real session activity instead of only fresh sign-ins',
    ],
  },
  {
    version: 'v1.40.0',
    date: 'September 19, 2026',
    changes: [
      'Fixed: expired trials and revoked beta access now actually clear — a metadata-merge bug meant they never persisted, and one lapsed account was getting a “your trial has ended” email every morning',
      'Accounts that own candidates, lists, or profiles can now be deleted (14 database constraints blocked it before)',
      'Admin: mute every email to any user with one click, and reset an account to the free plan in one press',
      'Admin repair: subscription cancel now finds the real Stripe customer, cancels immediately or at period end (your choice), and works on manual plans; beta/trial/lock toggles reflect their new state instantly; notes, error-log search, and every failure message now show what actually happened',
    ],
  },
  {
    version: 'v1.39.3',
    date: 'September 10, 2026',
    changes: [
      'Opening the Campaign calendar or results no longer highlights Todo in the sidebar at the same time — one page, one pill',
      'The selected candidate card’s red outline no longer gets clipped by the carousel edges — at any scroll position',
    ],
  },
  {
    version: 'v1.39.0',
    date: 'September 10, 2026',
    changes: [
      'New: a guided setup checklist on your dashboard walks you from first candidate to first AI profile to monitoring — dismissible, and it disappears on its own once you’re rolling',
      'November ready: the full Nov 3 general ballot is loaded — 130 races with every nominee from the August primaries plus verified statewide matchups — and the results engine is load-tested for election night',
      'Under the hood: county clerk result sources wired into election-night collection, and a round of dead code removed',
    ],
  },
  {
    version: 'v1.38.0',
    date: 'September 10, 2026',
    changes: [
      'Visual sweep fixes: profiler flag rows no longer overlap their sources, report footers render headings instead of raw markdown, and flag badges get clean separators',
      'Dashboard shows a proper loading skeleton and a tighter activity feed with a show-all toggle',
      'Admin: the signup trends chart shows real daily buckets with dates, and accounts without Stripe subscriptions display honest fallbacks instead of blanks',
    ],
  },
  {
    version: 'v1.37.0',
    date: 'September 9, 2026',
    changes: [
      'UI repair round 3: one brand red and navy everywhere, Geist typography app-wide, consistent focus rings, and your profile photo in the top bar',
      'Maps open framed on Wisconsin with working layer chips, results bars use party colors with a clear winner treatment, and the elections calendar matches on both pages',
      'Admin polish: test accounts hidden by default, coupons can be reactivated, consistent dates, and dozens of small copy and alignment fixes across the app',
    ],
  },
  {
    version: 'v1.36.0',
    date: 'August 16, 2026',
    changes: [
      'UI repair round 2: every dialog now closes on Escape and locks the page behind it, dashboard countdowns match the calendar, and quota copy tells one consistent story',
      'Events search runs when you ask (not on page load), Campaign Connect tabs are stable and linkable, unknown pages get a real 404, and admin shows real plan names and last sign-ins',
      'Dozens of smaller fixes: masked calendar tokens, keyboard-accessible uploads and sorts, search debouncing, honest error states, and tables that scroll instead of squashing',
    ],
  },
  {
    version: 'v1.35.0',
    date: 'August 16, 2026',
    changes: [
      'UI repair round 1: the chat bubble no longer covers dialogs, every mobile nav item is tappable, and this changelog panel is finally readable',
      'Offices search now shows the matching offices, Broadside scrolls to the bottom, and candidate Intel renders clean bullet lists instead of raw AI text',
      'Results stats reconciled (called / reporting / avg precincts in), the plans page fits phone screens, and a dozen smaller broken states fixed across the app',
    ],
  },
  {
    version: 'v1.34.0',
    date: 'August 16, 2026',
    changes: [
      'Signing in is sturdier: a slow connection no longer drops your session, and monitoring slot counts come straight from the database',
      'Party pickers everywhere now offer the full list (including Working Families and Constitution), and the voter-list filter can reach every party',
      'Under the hood: shared date/password/formatting helpers replace scattered copies, dead code removed, and stale copy corrected across the app',
    ],
  },
  {
    version: 'v1.33.0',
    date: 'August 16, 2026',
    changes: [
      'Recruit now matches against your entire voter list (not just the first 5,000 rows), retries prospects that were skipped for quota, and cache hits no longer count against your monthly research allowance',
      'Contact popovers in Prospecting stay fully visible on every row, credit packs are reachable on Action plans, and Recruit has a pricing row',
      'Fixes across the board: GOP voters get the right VAN code on export, party filters match every spelling, password reset only accepts real reset links, volunteer sign-out syncs offline door-knocks first, and public pages load instantly',
    ],
  },
  {
    version: 'v1.32.0',
    date: 'August 12, 2026',
    changes: [
      'Plan-limit fixes: beta and trial accounts are no longer wrongly capped, Active Monitoring appears on every plan that includes slots, and limit messages actually show instead of toggles silently snapping back',
      'Every map layer shows its office markers again, voter-list exports include the whole list, and party spellings are normalized on every import path',
    ],
  },
  {
    version: 'v1.31.1',
    date: 'August 12, 2026',
    changes: [
      'Monitoring slots are now enforced server-side, and election results move to Certified automatically once the county canvass completes \u2014 with a one-click admin certify for each election',
    ],
  },
  {
    version: 'v1.31.0',
    date: 'August 12, 2026',
    changes: [
      'District data accuracy: a party-vocabulary mismatch was silently zeroing Democratic votes in the voter-lean math (Assembly District 77 showed R+ \u2014 it is strongly Democratic); one shared normalizer now backs every party color, badge and calculation, primaries no longer distort lean, and all 250 primary results were reconciled against final county numbers',
      'Scout candidate limits are now enforced server-side; unopposed primaries can be advanced in one click; research data older than 12 months purges automatically',
    ],
  },
  {
    version: 'v1.30.0',
    date: 'August 12, 2026',
    changes: [
      'The full-app repair release: every finding from the complete audit is fixed \u2014 email opt-outs actually opt out, saves never fail silently, the AI privacy lock fails closed, manager-delegated tasks reach the candidate, Add Office works again, credit packs are honestly gated, pricing matches Stripe to the cent, and dozens of hardening, mobile and polish fixes',
    ],
  },
  {
    version: 'v1.29.1',
    date: 'August 12, 2026',
    changes: [
      'Prospecting contacts became one-tap actions: Call and Email buttons with Verified / Likely / Unconfirmed confidence labels, a multiple-numbers popover with per-number provenance, tap-to-dial on mobile and copy-to-clipboard on desktop',
    ],
  },
  {
    version: 'v1.29.0',
    date: 'August 12, 2026',
    changes: [
      'Prospecting rebuilt for agencies: discover candidates, enrich them with win-odds scoring you can inspect factor by factor, website and social detection, agency-relationship signals with evidence, and sourced contact info \u2014 exportable to CSV',
      'New for Action plans \u2014 Recruit: pick a voter list, an office and a district to find residents who could run, research their affiliation and public reputation (Unknown when the record is thin), and export the shortlist',
    ],
  },
  {
    version: 'v1.28.0',
    date: 'August 12, 2026',
    changes: [
      'Sidebar rebuilt: Candidates and Campaign Connect now stand on their own, the AI Tools tab is gone, and the Profiler lives inside Intelligence alongside Offices',
      'Action tab now holds exactly what only Action plans get',
      'Candidates: clicking a candidate always opens their record — a separate Profile button opens the AI-generated report',
      'District Events now generates in the background with live progress you can navigate away from, real error messages instead of an endless spinner, and a search that sweeps every town, village, city, school and county board meeting in a local district while large districts get only the major or newsworthy ones',
      'Profiler: freshly generated profiles appear in the library on their own — no refresh, even if you left the page or the run took longer than expected',
    ],
  },
  {
    version: 'v1.27.4',
    date: 'August 11, 2026',
    changes: [
      'Results flow restored: extraction calls pace themselves under the data provider\u2019s rate limit, the 10:30 PM call embargo now covers every data path, and admins can push a current-numbers email to all race subscribers on demand',
    ],
  },
  {
    version: 'v1.27.3',
    date: 'August 11, 2026',
    changes: [
      'Election-night guardrails: no race is called or winner announced before 10:30 PM CT, junk precinct figures from early county feeds are rejected, updates keep flowing until every vote is counted, and the statewide sweep now truly refreshes every five minutes',
    ],
  },
  {
    version: 'v1.27.2',
    date: 'August 11, 2026',
    changes: [
      'Mobile fix: a phone that kept the app open across an update no longer hits an error screen \u2014 the app now recovers by refreshing itself once, automatically',
    ],
  },
  {
    version: 'v1.27.1',
    date: 'August 11, 2026',
    changes: [
      'Election-night hardening across the board, poller, notifications and admin console: filter pills always show their races, a failed refresh keeps the last good numbers on screen, the admin console opens on tonight\u2019s election with search and filters, and no more all-zero first emails',
    ],
  },
  {
    version: 'v1.27.0',
    date: 'August 11, 2026',
    changes: [
      'Race notifications: hit the bell on any race card to get emailed when its numbers change or only when the winner is in \u2014 including a winner announcement and a recount-alert email when a race lands inside Wisconsin\u2019s recount threshold',
    ],
  },
  {
    version: 'v1.26.0',
    date: 'August 11, 2026',
    changes: [
      'Full-ballot election coverage: every U.S. House, State Senate and State Assembly primary in Wisconsin is on the board \u2014 grouped by level, searchable by district, county or candidate, with county sheriff and courthouse races discovered as they post',
    ],
  },
  {
    version: 'v1.25.1',
    date: 'August 10, 2026',
    changes: [
      'Election results now update themselves: every 5 minutes from 8\u201310 PM on election night, hourly through 4 AM, and a final pass at 10 AM \u2014 published numbers only, validated before every write, with the admin always able to override',
    ],
  },
  {
    version: 'v1.25.0',
    date: 'August 10, 2026',
    changes: [
      'Election results gained a real status engine: contests now progress through Reporting, Victory Likely, Winner Called, Too Close to Call, Recount Possible and Certified \u2014 computed from the math, with admin override always in charge',
      'Results tab recovers from load failures with a Retry, and lands on the most recent election that actually has results',
      'Offices is now map-first \u2014 the list view is retired',
    ],
  },
  {
    version: 'v1.24.2',
    date: 'August 10, 2026',
    changes: [
      'Signed-in devices is real: every session with device, IP and last-active, a THIS DEVICE badge, per-device sign-out, and one link to sign out everywhere else',
      'Settings hero centered to spec; account fields prefill with your saved name and organization',
    ],
  },
  {
    version: 'v1.24.1',
    date: 'August 10, 2026',
    changes: [
      'Settings now matches its design spec exactly \u2014 tighter type scale and control heights throughout',
      'Your account gained a profile photo: upload from Settings and it appears in the account hero',
    ],
  },
  {
    version: 'v1.24.0',
    date: 'July 21, 2026',
    changes: [
      'Sharing rebuilt as four clear steps: choose link or PDF, an explicit responsibility acknowledgment recorded with every link, a live-link view with countdown, views, email and instant deactivation',
      'PDF export gained real options — and team notes can never leave Badger Board when a candidate\u2019s AI lock is on',
      'Settings redesigned: a grouped rail with six focused, linkable panes (Account, Security, Plan & billing, Notifications, Calendars, Data & privacy), a real unsaved-changes bar, and usage meters that always match the Profiler\u2019s',
      'New org-wide AI-access default in Data & privacy — each candidate\u2019s own lock always overrides it, enforced server-side',
    ],
  },
  {
    version: 'v1.23.0',
    date: 'July 21, 2026',
    changes: [
      'Todo (the task board, formerly Tasks) now stands alone in the sidebar; Calendar and Results moved into the Campaign top bar',
      'New Action tab for Action-plan accounts: Prospecting and Campaign Connect live there',
      'Pages start right under the top bar — the big empty gap is gone',
      'Fixed: the Add Office window now opens above the map instead of underneath it',
    ],
  },
  {
    version: 'v1.22.0',
    date: 'July 21, 2026',
    changes: [
      'Cleaner sidebar: five main tabs — Dashboard, Intelligence, AI Tools, Campaign, and a Beta tab for testers — with each section\u2019s pages as tabs across the top of the page',
      'Main tabs remember the page you last used in each section',
      'Beta tab (Polling, Broadside, Compare) appears only for accounts with beta access',
    ],
  },
  {
    version: 'v1.21.1',
    date: 'July 21, 2026',
    changes: [
      'Profiler reports: every claim backed by an article or post now carries a View source link',
      'Verify now asks for your verdict — Valid, False, or Unsure — and remembers it: verified claims stop being flagged, false ones are marked and muted, and your team\u2019s calls show on shared views',
    ],
  },
  {
    version: 'v1.21.0',
    date: 'July 21, 2026',
    changes: [
      'Profiler redesigned: the library and the report each get the full canvas — generate row, live four-stage progress driven by real backend stages, honest plan meter, and a full-width searchable table',
      'Reports are now one quiet readable document: grouped contents rail, per-section takeaways, typed content blocks, and markers only on unverified claims',
      'Bulk generate works from a CSV upload with real parsing, row preview, context flags, and honest error states — template included',
      'Model reasoning can no longer leak into reports: discrepancy findings are structured data, shown as a Research note with a one-click fix',
    ],
  },
  {
    version: 'v1.20.2',
    date: 'July 21, 2026',
    changes: [
      'Candidates list: the Status column and filter are replaced by Active Monitoring — see and filter by who is being refreshed weekly at a glance',
    ],
  },
  {
    version: 'v1.20.1',
    date: 'July 21, 2026',
    changes: [
      'Weekly digest items now carry their source and date; unread dots are per-item',
      'Allies flag genuinely new names since the prior refresh; Opposition cards get real headlines',
      'Profile History: Compare any profile against its predecessor in a section-by-section diff',
      'Profile header shows the district\u2019s counties',
    ],
  },
  {
    version: 'v1.20.0',
    date: 'July 21, 2026',
    changes: [
      'Candidate profiles redesigned: four navigation groups replace eight tabs, and a new Overview answers "what did this week\u2019s refresh produce" — digest, section-by-section change list, snapshot, and next actions',
      'Notes & Documents gained an AI access lock: lock instantly, unlock free for 5 minutes, password required after — and locked material is stripped from every AI request server-side, not just hidden',
      'Weekly refreshes now store a section-level diff so "what changed" is computed once, not guessed',
      'Unread tracking: profiles show how many new items arrived since you last opened them',
    ],
  },
  {
    version: 'v1.19.2',
    date: 'July 21, 2026',
    changes: [
      'District office history redesigned: real election results with color-coded candidates — vote totals, percentages, and one segmented bar per general and per party primary',
      'Officeholder bios removed from the history view — name, party, and the numbers that matter',
    ],
  },
  {
    version: 'v1.19.1',
    date: 'July 21, 2026',
    changes: [
      'Map remembers where you were: coming back from a city page restores your exact layer, zoom, and selected district or county',
      'Hover any city (1,500+) for about a second and a quick demographics card pops up — Learn more jumps straight to the full city page',
    ],
  },
  {
    version: 'v1.19.0',
    date: 'July 21, 2026',
    changes: [
      'City demographics: click any Wisconsin city, village, or town (1,500+ residents) on the map for an instant Census profile — 598 municipalities covered',
      'Full city pages at /places with People, Income & Housing, and Education & Work stats plus city-vs-county-vs-state comparisons',
      'District Dashboard city dots are now clickable through to full demographics',
      'Broadside: searchable dossier picker in Intel Intake and a cleaner Start/Next/Repeat/End layout',
    ],
  },
  {
    version: 'v1.18.2',
    date: 'July 21, 2026',
    changes: [
      'Broadside is out of beta: now included with every paid plan (Monitor and up, both plan families)',
      'Events: smarter political-lean identification — known Wisconsin organizations are classified deterministically and uncertain hosts are checked against public campaign-finance, lobbying, and fundraising registries',
    ],
  },
  {
    version: 'v1.18.0',
    date: 'July 21, 2026',
    changes: [
      'New pricing: Candidate plans now $79 / $119 / $189 and Action brackets updated — existing subscribers keep their founder rate',
      'Campaign plan now includes 6 AI profiles per month (up from 4)',
      'Free 30/60/90-day trial giveaways: admins can grant full plan access with no card; accounts return to Scout automatically when the trial ends',
      'Beta mode: per-user and platform-wide switches that unlock every feature (including Broadside) while enabled',
      'Game Plan now unlocks at Monitor — Scout shows it locked with an upgrade path',
      'Action plans: active-candidate monitoring is now hard-capped at your bracket size with a one-click bracket upgrade prompt',
    ],
  },
  {
    version: 'v1.17.0',
    date: 'July 16, 2026',
    changes: [
      'Broadside now fills the entire page and ends every session with an AI-written report card (message discipline, pivots, trap avoidance) quoting your actual answers',
      'Sharper coaching: filler-heavy answers get pressed, flat denials trigger the deny follow-ups, and a worn-down opponent visibly concedes ground',
      'Snappier feel: instant reaction sounds, no overlapping audio on Next/Repeat, attacks capped at soundbite length',
      'Spar button on every Profiler dossier jumps straight into a session; mic setup is now visible and skippable (typed mode)',
    ],
  },
  {
    version: 'v1.16.0',
    date: 'July 16, 2026',
    changes: [
      'BROADSIDE (admin beta): AI opposition sparring — a voice-based opponent attacks with your dossier\u2019s vulnerabilities so you can take the hit before it\u2019s real',
      'Broadside AI + voice calls run through server-side proxies — no API keys in the browser',
      'Load any Profiler dossier straight into a sparring session',
    ],
  },
  {
    version: 'v1.15.2',
    date: 'May 18, 2026',
    changes: [
      'Fix: Stripe checkout now correctly authenticates — plans and billing portal now work for all users',
      'Fix: Downgrade-to-Scout and Delete Account flows now properly authenticated',
      'Stripe: Checkout pages now show custom Badger Board billing message',
      'Admin: One-time Stripe product setup endpoint added for provisioning all plan prices',
    ],
  },
  {
    version: 'v1.15.1',
    date: 'May 18, 2026',
    changes: [
      'Rename: all remaining "dossier" references renamed to "profile" throughout the app, emails, and PDF output',
    ],
  },
  {
    version: 'v1.15.0',
    date: 'May 16, 2026',
    changes: [
      'Stripe checkout: full support for new plan keys (c_monitor, c_active, c_campaign, a_monitor, a_active, a_campaign) and quarterly billing',
      'Fix: Settings, Profiler, and Layout pages no longer crash for users with unknown or unrecognized plan keys',
      'Fix: Weekly profile badge now correctly shows for Campaign and Action plan users',
      'Backend: Stripe webhook writes plan_type to user metadata on every plan change',
      'Bug fix: Admin lock/unlock button now correctly reflects payment status',
      'Bug fix: Comparison page loads correctly when opened directly from a URL with candidates pre-selected',
      'Bug fix: Profile status accept button no longer stalls if an error occurs',
      'Bug fix: Offices search now debounced — no more rapid-fire database calls while typing',
      'Security: AI prospect classification now enforces Campaign/Agency plan gate server-side',
      'Stability: null-guard fixes across Dashboard, Admin, VoterLists, GamePlan, DoorKnocking, and backend functions',
    ],
  },
  {
    version: 'v1.14.0',
    date: 'May 16, 2026',
    changes: [
      'Profile status recommendations: generated profiles now suggest status updates you can accept or dismiss',
      'Allies section simplified: empty sub-sections are hidden entirely — only known information is shown',
      'Profile history: all remaining "dossier" references renamed to "profile" throughout the UI',
      'News feed rebuilt: news articles on left, X feed + social posts on right; every item opens in new tab',
    ],
  },
  {
    version: 'v1.13.0',
    date: 'May 16, 2026',
    changes: [
      'Notes panel: quick-add timestamped notes on any candidate without entering edit mode',
      'Files & Attachments: upload PDFs, docs, images, and more directly to a candidate profile',
      'Per-file AI toggle: mark files as "AI On" to include them when generating profiles',
      'File download via signed URLs, with note delete and file delete in one panel',
    ],
  },
  {
    version: 'v1.12.0',
    date: 'May 16, 2026',
    changes: [
      'CSV Upload prospecting: import any CSV and AI classifies each person as Conservative, Liberal, or Unknown (70% confidence threshold)',
      'Email button on every prospect with an email address — one click to compose',
      'Add to Candidates button on CSV lists — push selected prospects directly to your Candidates section',
      'Lean filter on CSV prospecting lists: view all / conservative / liberal / unknown',
    ],
  },
  {
    version: 'v1.11.0',
    date: 'May 16, 2026',
    changes: [
      'Scout plan: lite profile with blur/gate overlay on locked sections',
      'Fixed plan gating — Section 6 & 13 now correctly require Campaign tier',
      'Candidates without a linked office now appear on the map (WI centroid fallback)',
      'Feature gating updated for new plan key structure (c_campaign, a_campaign, etc.)',
    ],
  },
  {
    version: 'v1.10.28',
    date: 'May 15, 2025',
    changes: [
      'Support chat plan names updated for new plan structure',
      'Game Plan: redesigned milestones with column layout and urgency chips',
      'Offices DB: deduplication + all 72 WI county board supervisor seats seeded',
      'Lincoln County board supervisor seats now visible on the map',
    ],
  },
  {
    version: 'v1.10.20',
    date: 'May 14, 2025',
    changes: [
      'New two-product pricing — Candidate Plan & Action Plan families',
      'Pricing page rebuilt with billing period toggle and bracket table',
      'Tiers rewritten: scout, c_monitor, c_active, c_campaign, a_monitor, a_active, a_campaign',
      'Map sidebar z-index fix (no longer overlaps mobile nav)',
    ],
  },
  {
    version: 'v1.10.15',
    date: 'May 12, 2025',
    changes: [
      'Profile-ready email notification added to generate pipeline',
      'Notifications section added to Settings',
      'Profiles renamed to Profiler throughout the app',
      'Research context field replaces party in new-candidate form',
    ],
  },
]

// ─── Consolidated navigation (v1.23, restructured v1.28) ─────────────────────
// Sidebar main tabs; a section's pages are a horizontal tab strip at the top.
//
// v1.28 restructure (owner-approved):
//   a. Candidates is its own top-level sidebar item (direct link, like Todo).
//   b. The AI Tools section is gone.
//   c. Profiler moved into Intelligence's tab strip.
//   d. Campaign Connect is its own top-level sidebar item — out of both the
//      Campaign and Action strips — keeping its original gate (any paid plan;
//      Action plans are always paid, so they keep it too, Scout does not).
//   e. Action holds exactly the routes that are exclusive to Action plans.
//      Audit of PLAN_CONFIG in lib/tiers.js: the only feature flags true on an
//      Action plan and false on EVERY candidate plan are `prospecting`,
//      `offices`, `multiGamePlan`, `bulkProfiler` and `bulkCredits`. Of those,
//      `prospecting` is the only one that owns a route (/prospecting, gated by
//      hasFeature(tier,'prospecting') in Prospecting.jsx). `offices` is a scope
//      modifier — /offices ships to every plan and is not gated by it;
//      `multiGamePlan` lives inside Todo, `bulkProfiler` is a button inside
//      Profiler, `bulkCredits` is a billing option in Settings. Voter Lists has
//      no plan flag at all (available on every plan) and Polling is beta-gated,
//      not plan-gated — so neither belongs here.
const NAV_SECTIONS = [
  { key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, direct: { to: '/', end: true } },
  { key: 'todo',      label: 'Todo',      icon: Target, direct: { to: '/game-plan' } },
  { key: 'candidates', label: 'Candidates', icon: Users, direct: { to: '/candidates' } },
  // v1.30: /elections was orphaned (reachable only by typing the URL) — it now
  // owns a tab in this strip, so it comes OUT of `extra`. `extra` is only for
  // routes with no tab of their own; listing it in both double-claims the tab.
  //
  // Compare and Broadside are PAID-PLAN features (tiers.js features.compare /
  // features.broadside), not beta experiments, so they belong in a plan section
  // behind their feature gate rather than under Beta. navItemVisible passes on
  // `isAdmin || isBeta || tierConfig.features[feature]`, so a beta-flag user who
  // lacks the plan feature still sees the link here — exactly one link either
  // way, which is why they are NOT also listed under Beta.
  { key: 'intelligence', label: 'Intelligence', icon: Building2, extra: ['/places', '/dossiers'], items: [
    { to: '/offices',   icon: Building2,    label: 'Offices' },
    { to: '/elections', icon: CalendarDays, label: 'Elections' },
    { to: '/profiler',  icon: FileText,     label: 'Profiler' },
    { to: '/compare',   icon: Scale,        label: 'Compare',   feature: 'compare' },
    { to: '/broadside', icon: Swords,       label: 'Broadside', feature: 'broadside', webOnly: true },
  ] },
  { key: 'campaign', label: 'Campaign', icon: CalendarDays, items: [
    { to: '/game-plan?tab=calendar', icon: CalendarDays, label: 'Calendar', q: { path: '/game-plan', tab: 'calendar' } },
    { to: '/game-plan?tab=results',  icon: BarChart2,    label: 'Results',  q: { path: '/game-plan', tab: 'results' } },
    { to: '/events',      icon: CalendarDays, label: 'Events', badge: 'New' },
    { to: '/voter-lists', icon: UserCheck,    label: 'Voter Lists' },
  ] },
  { key: 'connect', label: 'Campaign Connect', icon: Users2, paidOnly: true, direct: { to: '/campaign-connect' } },
  // v1.29: Action is a real tab strip now — Recruit joins Prospecting. Both are
  // Action-plan exclusive (tiers.js features.prospecting / features.recruit),
  // and each owns a route gated by hasFeature() inside its own page.
  { key: 'action', label: 'Action', icon: ListChecks, actionOnly: true, items: [
    { to: '/prospecting', icon: ListChecks, label: 'Prospecting' },
    { to: '/recruit',     icon: UserPlus,   label: 'Recruit', feature: 'recruit' },
  ] },
  // Beta holds only what is genuinely beta-gated and sold by no plan.
  // Compare/Broadside moved to Intelligence — see the note there.
  { key: 'beta', label: 'Beta', icon: FlaskConical, betaOnly: true, items: [
    { to: '/polling',   icon: BarChart2, label: 'Polling', betaOnly: true },
  ] },
]

function navItemVisible(item, { isAdmin, isBeta, isPaid, isActionPlan, tierConfig }) {
  if (!item) return false
  if (item.adminOnly && !isAdmin) return false
  if (item.paidOnly && !(isPaid || isAdmin)) return false
  if (item.hideForActionPlan && isActionPlan && !isAdmin) return false
  if (item.feature && !(isAdmin || isBeta || tierConfig?.features?.[item.feature])) return false
  if (item.betaOnly && !(isAdmin || isBeta)) return false
  if (item.webOnly && isNativeApp) return false
  return true
}

function sectionVisible(sec, gates) {
  if (sec.betaOnly && !(gates.isAdmin || gates.isBeta)) return false
  if (sec.actionOnly && !(gates.isAdmin || gates.isActionPlan)) return false
  // Standalone (direct) sections carry their own plan gate — items inside a
  // strip are filtered by navItemVisible instead.
  if (sec.paidOnly && !(gates.isPaid || gates.isAdmin)) return false
  return true
}

function sectionItems(section, gates) {
  return (section.items || []).filter(i => navItemVisible(i, gates))
}

function itemBasePath(item) {
  return item.q ? item.q.path : item.to.split('?')[0]
}

// Which section owns the current location. /game-plan splits on ?tab —
// calendar/results belong to Campaign, the task board is Todo. Everything else
// falls out of the section table: /candidates and /campaign-connect are their
// own standalone sections, /dossiers and /profiler both belong to Intelligence.
function sectionForLocation(pathname, tab) {
  if (pathname === '/') return NAV_SECTIONS[0]
  if (pathname === '/game-plan' || pathname.startsWith('/game-plan/')) {
    return (tab === 'calendar' || tab === 'results')
      ? NAV_SECTIONS.find(x => x.key === 'campaign')
      : NAV_SECTIONS.find(x => x.key === 'todo')
  }
  for (const sec of NAV_SECTIONS) {
    const bases = [
      ...(sec.items || []).map(itemBasePath),
      ...(sec.extra || []),
      ...(sec.direct ? [sec.direct.to] : []),
    ]
    if (bases.some(p => p !== '/' && (pathname === p || pathname.startsWith(p + '/')))) return sec
  }
  return null
}

// ─── NavItem ─────────────────────────────────────────────────────────────────
// Defined at module level so React never sees a new component type on re-render.
//
// activeOverride (v1.39.3): NavLink's own isActive matches by PATHNAME only —
// it cannot see ?tab=, so a NavLink to /game-plan lit up on
// /game-plan?tab=calendar while the Campaign section header (driven by the
// query-aware sectionForLocation) lit up too: two red pills at once. Sidebar
// call sites now pass the sectionForLocation verdict in, making it the single
// authority; NavLink's isActive is only the fallback for callers that don't.
const NavItem = React.memo(function NavItem({ item, onNavigate, activeOverride = null }) {
  const Icon = item.icon
  return (
    <NavLink
      to={item.to}
      end={item.end}
      onClick={onNavigate}
      className={({ isActive }) =>
        `flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm font-medium transition-all duration-150 ${
          (activeOverride ?? isActive)
            ? 'bg-brand-red text-white'
            : 'text-white/70 hover:text-white hover:bg-white/10'
        }`
      }
    >
      <Icon className="w-4 h-4 flex-shrink-0" />
      <span>{item.label}</span>
      {item.badge && (
        <span className="ml-auto text-xs bg-white/20 text-white px-1.5 py-0.5 rounded-full">
          {item.badge}
        </span>
      )}
    </NavLink>
  )
})

// ─── Changelog Popover ────────────────────────────────────────────────────────
// B16: this used to be an `absolute inset` panel inside the sidebar rail, so it
// rendered ~165px wide, clipped by the rail, sliced its last line off, covered
// the nav items underneath it and could only be closed with its own X.
//
// It is now a FIXED panel measured against the version button: readable width
// (360px, or the viewport minus gutters on a phone), clamped on both axes so it
// can never render off-screen, a max-height computed from the room actually
// available above the button, and an internal scroller that ends on a whole
// line. Dismissal: X, outside click, or Escape — the outside-click listener
// follows the NotificationCenter.jsx:99-104 pattern.
const CHANGELOG_WIDTH   = 360  // px — readable line length for the entry text
const CHANGELOG_GAP     = 10   // px — breathing room between button and panel
const CHANGELOG_MARGIN  = 12   // px — minimum distance from any viewport edge
const CHANGELOG_MAX_H   = 520  // px — tallest the panel gets; the list scrolls

function ChangelogPopover({ anchorRef, onClose }) {
  const panelRef = useRef(null)
  const [pos, setPos] = useState(null)

  // Position against the anchor, clamped into the viewport. Runs before paint
  // (and on resize) so the panel never flashes in the wrong place.
  useLayoutEffect(() => {
    const place = () => {
      const vw = window.innerWidth
      const vh = window.innerHeight
      const width = Math.min(CHANGELOG_WIDTH, vw - CHANGELOG_MARGIN * 2)
      const r = anchorRef?.current?.getBoundingClientRect()
      const left = r
        ? Math.min(
            Math.max(CHANGELOG_MARGIN, r.left - 8),
            Math.max(CHANGELOG_MARGIN, vw - width - CHANGELOG_MARGIN)
          )
        : CHANGELOG_MARGIN
      // `bottom` is measured from the viewport bottom up to just above the
      // button; clamped so the panel always keeps ≥160px of usable height.
      const rawBottom = r ? vh - r.top + CHANGELOG_GAP : CHANGELOG_MARGIN
      const bottom = Math.min(
        Math.max(CHANGELOG_MARGIN, rawBottom),
        Math.max(CHANGELOG_MARGIN, vh - 180)
      )
      // Never taller than the room above the button, and never a full-height
      // wall of text on a tall monitor — the list scrolls inside either way.
      const maxHeight = Math.max(160, Math.min(CHANGELOG_MAX_H, vh - bottom - CHANGELOG_MARGIN))
      setPos({ left, bottom, width, maxHeight })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [anchorRef])

  // Dismiss on outside click / Escape
  useEffect(() => {
    const onDown = (e) => {
      if (panelRef.current?.contains(e.target)) return
      if (anchorRef?.current?.contains(e.target)) return // the button toggles itself
      onClose()
    }
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [anchorRef, onClose])

  if (!pos) return null
  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="What's new"
      className="fixed z-popover flex flex-col bg-gray-900 border border-white/10 rounded-xl shadow-2xl overflow-hidden"
      style={{ left: pos.left, bottom: pos.bottom, width: pos.width, maxHeight: pos.maxHeight }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/10 flex-shrink-0">
        <span className="text-xs font-bold text-white/80 uppercase tracking-wider">What&apos;s New</span>
        <button
          onClick={onClose}
          aria-label="Close"
          className="text-white/40 hover:text-white/80 transition-colors"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      {/* Entries — the only scroller; `min-h-0` lets it shrink inside the
          flex column so the panel's max-height can't slice the last line. */}
      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain divide-y divide-white/5 pb-1">
        {CHANGELOG.map((entry) => (
          <div key={entry.version} className="px-4 py-3">
            <div className="flex items-center gap-2 mb-1.5">
              <span className="text-xs font-bold text-brand-red">{entry.version}</span>
              <span className="text-white/30 text-xs">·</span>
              <span className="text-white/40 text-xs">{entry.date}</span>
            </div>
            <ul className="space-y-1">
              {entry.changes.map((c, i) => (
                <li key={i} className="text-xs leading-relaxed text-white/60 flex items-start gap-1.5">
                  <span className="text-white/25 mt-0.5 flex-shrink-0">·</span>
                  <span>{c}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Sidebar ─────────────────────────────────────────────────────────────────
// Also module-level. Receives everything it needs via props.
//
// `singleColumn` (B2): the mobile drawer renders the sidebar as ONE normal-flow
// scrollable column — the root is the only scroller and every group is a plain
// block sibling. The desktop rail keeps its inner-scrolling nav (it always has
// the full viewport height, so nothing is ever clipped there).
const Sidebar = React.memo(function Sidebar({ isAdmin, isBeta, isActionPlan, isPaid, onNavigate, onSignOut, tierConfig, currentSectionKey, onGoSection, singleColumn = false }) {
  const [showChangelog, setShowChangelog] = useState(false)
  const versionBtnRef = useRef(null)
  return (
    <div className={`flex flex-col h-full bg-brand-navy ${singleColumn ? 'overflow-y-auto overscroll-contain' : ''}`}>
      {/* Badger Board logo */}
      <div className="px-4 pt-4 pb-3 border-b border-white/10 flex-shrink-0">
        <div className="flex justify-center">
          <BadgerBoardLogo width={180} />
        </div>
        <p className="text-white/30 text-center mt-1" style={{ fontSize: '9px', letterSpacing: '0.22em', textTransform: 'uppercase' }}>
          CAMPAIGNS MADE SIMPLE.
        </p>
      </div>

      {/* Navigation — main tabs; pages live in the top tab strip (v1.23) */}
      {/* B2: in `singleColumn` mode the nav is NOT its own scroller — it is a
          plain block that grows with its items, so an item can never be
          clipped out of the nav's viewport while its box still overlaps the
          admin group below it. */}
      <nav className={`px-3 py-4 space-y-1 ${singleColumn ? 'flex-none' : 'flex-1 overflow-y-auto'}`}>
        {NAV_SECTIONS.map(sec => {
          const gates = { isAdmin, isBeta, isActionPlan, isPaid, tierConfig }
          if (!sectionVisible(sec, gates)) return null
          if (sec.direct) {
            const item = { to: sec.direct.to, icon: sec.icon, label: sec.label, end: sec.direct.end }
            return <NavItem key={sec.key} item={item} onNavigate={onNavigate}
              activeOverride={currentSectionKey === sec.key} />
          }
          const items = sectionItems(sec, gates)
          if (!items.length) return null
          if (items.length === 1 && !items[0].q) {
            // one visible page — no strip needed, link straight to it
            const solo = { ...items[0], icon: sec.icon, label: sec.label }
            return <NavItem key={sec.key} item={solo} onNavigate={onNavigate}
              activeOverride={currentSectionKey === sec.key} />
          }
          const active = currentSectionKey === sec.key
          const hasNews = items.some(i => i.badge && i.badge !== 'Beta')
          const Icon = sec.icon
          return (
            <button
              key={sec.key}
              type="button"
              onClick={() => onGoSection(sec, items)}
              className={`w-full flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm font-medium transition-all duration-150 ${
                active ? 'bg-brand-red text-white' : 'text-white/70 hover:text-white hover:bg-white/10'
              }`}
            >
              <Icon className="w-4 h-4 flex-shrink-0" />
              <span>{sec.label}</span>
              {sec.key === 'beta' ? (
                <span className="ml-auto text-xs bg-white/20 text-white px-1.5 py-0.5 rounded-full">Beta</span>
              ) : hasNews ? (
                <span className="ml-auto w-1.5 h-1.5 rounded-full bg-white/70" aria-hidden="true" />
              ) : null}
            </button>
          )
        })}
      </nav>

      {/* Bottom section — admin / plans / settings / sign-out.
          `mt-auto` in singleColumn mode keeps it pinned to the bottom when the
          nav is short and collapses to 0 when the column overflows, so it is
          always BELOW the nav in normal flow, never on top of it. */}
      <div className={`p-3 border-t border-white/10 space-y-1 flex-none ${singleColumn ? 'mt-auto' : ''}`}>
        {isAdmin && (
          <NavLink
            to="/admin"
            onClick={onNavigate}
            className={({ isActive }) =>
              `flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm font-medium transition-all duration-150 ${
                isActive ? 'bg-brand-red text-white' : 'text-white/70 hover:text-white hover:bg-white/10'
              }`
            }
          >
            <ShieldCheck className="w-4 h-4" />
            <span>Admin Panel</span>
          </NavLink>
        )}
        {/* Store rules: no purchase/pricing UI in the native app */}
        {!isNativeApp && (
          <NavLink
            to="/plans"
            onClick={onNavigate}
            className={({ isActive }) =>
              `flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm font-medium transition-all duration-150 ${
                isActive ? 'bg-brand-red text-white' : 'text-white/70 hover:text-white hover:bg-white/10'
              }`
            }
          >
            <Tag className="w-4 h-4" />
            <span>Plans &amp; Pricing</span>
          </NavLink>
        )}
        <NavLink
          to="/settings"
          onClick={onNavigate}
          className={({ isActive }) =>
            `flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm font-medium transition-all duration-150 ${
              isActive ? 'bg-brand-red text-white' : 'text-white/70 hover:text-white hover:bg-white/10'
            }`
          }
        >
          <Settings className="w-4 h-4" />
          <span>Settings</span>
        </NavLink>
        <button
          type="button"
          onClick={onSignOut}
          className="w-full flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm font-medium text-white/70 hover:text-white hover:bg-white/10 transition-all duration-150"
        >
          <LogOut className="w-4 h-4" />
          <span>Sign Out</span>
        </button>

        {/* Powered by Bluejack Group + version changelog */}
        <div className="px-4 py-3 mt-1 flex flex-col items-center gap-1.5 relative">
          {showChangelog && (
            <ChangelogPopover
              anchorRef={versionBtnRef}
              onClose={() => setShowChangelog(false)}
            />
          )}
          <div className="flex items-center gap-2">
            <span className="text-white/30 text-xs">Powered by</span>
            <a href="https://www.thebluejackgroup.com" target="_blank" rel="noopener noreferrer">
              <BluejackLogo width={80} className="opacity-90 hover:opacity-100 transition-opacity" />
            </a>
          </div>
          <div className="flex items-center gap-2">
            {/* react-router <Link>: a raw <a href> forced a full page reload
                (and a cold app boot) just to read the Terms page. */}
            <Link to="/terms" className="text-white/25 hover:text-white/50 text-xs transition-colors" style={{ letterSpacing: '0.05em' }}>
              Terms of Service
            </Link>
            <span className="text-white/15 text-xs">·</span>
            <button
              ref={versionBtnRef}
              onClick={() => setShowChangelog(v => !v)}
              aria-expanded={showChangelog}
              className="text-white/25 hover:text-white/60 text-xs transition-colors underline decoration-dotted underline-offset-2 cursor-pointer"
              title="What's new in this version"
            >
              {APP_VERSION}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
})

// ─── Account avatar ───────────────────────────────────────────────────────────
// Settings → Your account stores the uploaded photo as a small inline data URL
// in user_metadata.avatar_url (src/pages/settings/AccountPane.jsx:271-282). The
// top bar and the account menu used to ignore it and always draw initials, so a
// user who had uploaded a photo saw it in Settings and nowhere else.
// Initials stay as the fallback: no photo, or a data URL the browser can't
// decode (onError flips back to them).
function AccountAvatar({ user, size = 32, className = '' }) {
  const src = user?.user_metadata?.avatar_url || ''
  const [broken, setBroken] = useState(false)
  useEffect(() => { setBroken(false) }, [src])

  const initial = user?.user_metadata?.display_name?.[0]?.toUpperCase()
    ?? user?.email?.[0]?.toUpperCase()
    ?? 'U'
  const box = `bg-brand-red rounded-full flex items-center justify-center text-white font-bold flex-shrink-0 overflow-hidden ${className}`

  if (src && !broken) {
    return (
      <img
        src={src}
        alt=""
        onError={() => setBroken(true)}
        className={`${box} object-cover`}
        style={{ width: size, height: size }}
      />
    )
  }
  return (
    <div className={box} style={{ width: size, height: size, fontSize: Math.round(size * 0.44) }}>
      {initial}
    </div>
  )
}

// ─── Dossier Status Indicator ─────────────────────────────────────────────────
function DossierStatusIndicator() {
  const { phase, candidateName, readyDossier, clearStatus } = useDossierStatus()
  const navigate    = useNavigate()
  const [hover, setHover] = useState(false)

  if (phase === 'idle') return null

  if (phase === 'generating') {
    return (
      <div
        className="relative flex items-center gap-2 px-3 py-1.5 rounded-lg bg-brand-navy/8 border border-brand-navy/15"
        title={`Generating profile${candidateName ? ` for ${candidateName}` : ''}…`}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
      >
        <Sparkles className="w-4 h-4 text-brand-navy animate-pulse flex-shrink-0" />
        <span className="text-xs font-medium text-brand-navy hidden sm:block max-w-28 truncate">
          {candidateName ? `Generating…` : 'Generating…'}
        </span>
        {/* Pulsing dot */}
        <span className="w-2 h-2 rounded-full bg-amber-400 flex-shrink-0">
          <span className="absolute w-2 h-2 rounded-full bg-amber-400 animate-ping" />
        </span>
        {hover && candidateName && (
          <div className="absolute top-full left-1/2 -translate-x-1/2 mt-2 z-50 bg-gray-900 text-white text-xs rounded-lg px-3 py-1.5 whitespace-nowrap shadow-lg">
            Generating profile for <span className="font-semibold">{candidateName}</span>
          </div>
        )}
      </div>
    )
  }

  if (phase === 'ready' && readyDossier) {
    return (
      <div className="relative flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => {
            navigate(`/dossiers?view=${readyDossier.id}`)
            clearStatus()
          }}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-green-50 border border-green-200 hover:bg-green-100 hover:border-green-300 transition-colors group"
          title={`Profile ready — ${readyDossier.candidateName}`}
        >
          <div className="relative flex-shrink-0">
            <FileText className="w-4 h-4 text-green-700" />
            <div className="absolute -top-1 -right-1 w-3 h-3 bg-green-500 rounded-full flex items-center justify-center">
              <Check className="w-2 h-2 text-white" strokeWidth={3} />
            </div>
          </div>
          <span className="text-xs font-semibold text-green-800 hidden sm:block max-w-36 truncate">
            {readyDossier.candidateName} — Ready
          </span>
          <ChevronRight className="w-3 h-3 text-green-600 flex-shrink-0 hidden sm:block opacity-0 group-hover:opacity-100 transition-opacity" />
        </button>
        <button
          type="button"
          onClick={clearStatus}
          className="p-1 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors"
          title="Dismiss"
        >
          <X className="w-3 h-3" />
        </button>
      </div>
    )
  }

  return null
}

// ─── Support Chat Widget ──────────────────────────────────────────────────────
const CHAT_API = '/.netlify/functions/support-chat'

// The widget is styled with inline styles (it deliberately owns its own look),
// so it needs the brand tokens as literals. These are the SAME two values as
// tailwind.config.js `brand.red` / `brand.navy` — the widget used to run on
// #dc2626 and #1e3a5f, which is two of the four reds and three navies the UI
// audit found. Keep these in step with the Tailwind tokens.
const BRAND_RED  = '#8B0000'
const BRAND_NAVY = '#0A1628'

function SupportChatWidget() {
  const { session }             = useAuth()
  const [open, setOpen]         = useState(false)
  const [messages, setMessages] = useState([
    { role: 'assistant', content: 'Hi! I\'m the Badger Board support assistant. How can I help you today?' }
  ])
  const [input, setInput]       = useState('')
  const [loading, setLoading]   = useState(false)
  const bottomRef               = useRef(null)

  useEffect(() => {
    if (open) bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, open])

  const sendMessage = async (e) => {
    e?.preventDefault()
    const text = input.trim()
    if (!text || loading) return

    const userMsg = { role: 'user', content: text }
    setMessages(prev => [...prev, userMsg])
    setInput('')
    setLoading(true)

    try {
      // Build history excluding the initial greeting (which is UI-only)
      const history = [...messages.slice(1), userMsg]
        .map(m => ({ role: m.role, content: m.content }))

      const res = await fetch(CHAT_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: history,
          // JWT is verified server-side; user_id is derived from the token there,
          // never from the request body, preventing identity spoofing.
          token: session?.access_token ?? null,
        }),
      })
      const data = await res.json()
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: data.reply || 'Sorry, I couldn\'t get a response. Try support@badgerboardwi.com.'
      }])
    } catch {
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: 'Something went wrong. Please try again or email support@badgerboardwi.com.'
      }])
    }
    setLoading(false)
  }

  return (
    <>
      {/* Chat panel */}
      {open && (
        <div
          style={{
            position: 'fixed', bottom: '80px', right: '16px',
            width: 'min(340px, calc(100vw - 32px))',
            maxHeight: 'min(480px, calc(100dvh - 120px))',
            background: '#fff', borderRadius: '16px',
            // B1: chat sits BELOW the modal band (lowest modal is 40) and
            // below the mobile drawer — see the Z scale at the top of the file.
            boxShadow: '0 20px 60px rgba(0,0,0,0.18)', zIndex: Z.CHAT,
            display: 'flex', flexDirection: 'column', overflow: 'hidden',
            border: '1px solid #e5e7eb',
          }}
        >
          {/* Header */}
          <div style={{ background: BRAND_NAVY, padding: '14px 16px', display: 'flex', alignItems: 'center', gap: '10px', flexShrink: 0 }}>
            <div style={{ width: 32, height: 32, background: BRAND_RED, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <MessageCircle style={{ width: 16, height: 16, color: '#fff' }} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ color: '#fff', fontWeight: 600, fontSize: 14, lineHeight: 1.3 }}>Badger Board Support</div>
              <div style={{ color: 'rgba(255,255,255,0.55)', fontSize: 11 }}>AI assistant · Usually instant</div>
            </div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <a
                href="https://support.badgerboardwi.com"
                target="_blank"
                rel="noopener noreferrer"
                title="Full support site"
                style={{ color: 'rgba(255,255,255,0.5)', display: 'flex', alignItems: 'center' }}
              >
                <ExternalLink style={{ width: 14, height: 14 }} />
              </a>
              <button
                onClick={() => setOpen(false)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(255,255,255,0.5)', padding: 2, display: 'flex', alignItems: 'center' }}
              >
                <X style={{ width: 16, height: 16 }} />
              </button>
            </div>
          </div>

          {/* Messages */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '14px 14px 8px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            {messages.map((msg, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start' }}>
                <div style={{
                  maxWidth: '82%',
                  padding: '8px 12px',
                  borderRadius: msg.role === 'user' ? '12px 12px 3px 12px' : '12px 12px 12px 3px',
                  background: msg.role === 'user' ? BRAND_RED : '#f3f4f6',
                  color: msg.role === 'user' ? '#fff' : '#111827',
                  fontSize: 13,
                  lineHeight: 1.5,
                }}>
                  {msg.content}
                </div>
              </div>
            ))}
            {loading && (
              <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
                <div style={{ background: '#f3f4f6', borderRadius: '12px 12px 12px 3px', padding: '8px 14px', display: 'flex', gap: 4, alignItems: 'center' }}>
                  {[0,1,2].map(i => (
                    <div key={i} style={{ width: 6, height: 6, borderRadius: '50%', background: '#9ca3af', animation: `bounce 1s ease-in-out ${i * 0.15}s infinite` }} />
                  ))}
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          {/* Input */}
          <form
            onSubmit={sendMessage}
            style={{ borderTop: '1px solid #e5e7eb', padding: '10px 12px', display: 'flex', gap: 8, flexShrink: 0 }}
          >
            <input
              value={input}
              onChange={e => setInput(e.target.value)}
              placeholder="Ask a question…"
              disabled={loading}
              style={{
                flex: 1, border: '1px solid #e5e7eb', borderRadius: 8, padding: '8px 12px',
                // No inline `outline: none`: it would beat the app-wide focus
                // ring in src/index.css and leave this field unfocusable-looking.
                fontSize: 13, background: loading ? '#f9fafb' : '#fff',
                color: '#111827',
              }}
            />
            <button
              type="submit"
              disabled={!input.trim() || loading}
              style={{
                background: input.trim() && !loading ? BRAND_RED : '#e5e7eb',
                border: 'none', borderRadius: 8, padding: '8px 12px', cursor: input.trim() && !loading ? 'pointer' : 'not-allowed',
                display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'background .15s', flexShrink: 0,
              }}
            >
              <Send style={{ width: 15, height: 15, color: input.trim() && !loading ? '#fff' : '#9ca3af' }} />
            </button>
          </form>
        </div>
      )}

      {/* FAB */}
      <button
        onClick={() => setOpen(o => !o)}
        title="Support chat"
        style={{
          position: 'fixed', bottom: 20, right: 20, width: 52, height: 52,
          borderRadius: '50%', background: BRAND_NAVY,
          boxShadow: '0 4px 20px rgba(10,22,40,0.4)', border: '2px solid rgba(255,255,255,0.15)',
          cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: Z.CHAT, transition: 'transform .15s, box-shadow .15s',
        }}
        onMouseEnter={e => { e.currentTarget.style.transform = 'scale(1.08)'; e.currentTarget.style.boxShadow = '0 6px 24px rgba(10,22,40,0.5)' }}
        onMouseLeave={e => { e.currentTarget.style.transform = 'scale(1)'; e.currentTarget.style.boxShadow = '0 4px 20px rgba(10,22,40,0.4)' }}
      >
        {open
          ? <X style={{ width: 20, height: 20, color: '#fff' }} />
          : <MessageCircle style={{ width: 22, height: 22, color: '#fff' }} />
        }
      </button>

      <style>{`
        @keyframes bounce {
          0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; }
          40%            { transform: scale(1);   opacity: 1;   }
        }
      `}</style>
    </>
  )
}

// ─── Section tab strip (v1.22) ────────────────────────────────────────────────
// The pages of the active sidebar section, as horizontal tabs under the header.
function SectionTabs({ items, pathname, tab }) {
  if (!items || !items.length) return null
  const isItemActive = (item) => {
    if (item.q) return (pathname === item.q.path || pathname.startsWith(item.q.path + '/')) && tab === item.q.tab
    const base = item.to.split('?')[0]
    if (base === '/game-plan') return pathname.startsWith('/game-plan') && tab !== 'calendar' && tab !== 'results'
    // /dossiers and /profiler are the same page on two routes (see App.jsx).
    if (base === '/profiler') return pathname.startsWith('/profiler') || pathname.startsWith('/dossiers')
    return pathname === base || pathname.startsWith(base + '/')
  }
  return (
    <div
      className="bg-white border-b border-gray-200 px-4 md:px-6 lg:px-8 flex items-center gap-1 overflow-x-auto flex-shrink-0"
      role="tablist"
      aria-label="Section pages"
    >
      {items.map(item => {
        const Icon = item.icon
        const active = isItemActive(item)
        return (
          <Link
            key={item.to}
            to={item.to}
            className={`flex items-center gap-1.5 px-3 text-sm font-medium whitespace-nowrap border-b-2 -mb-px transition-colors ${
              active ? 'border-brand-red text-gray-900' : 'border-transparent text-gray-500 hover:text-gray-800'
            }`}
            style={{ minHeight: 44 }}
          >
            <Icon className="w-4 h-4" />
            {item.label}
            {item.badge && item.badge !== 'Beta' && (
              <span className="text-xs bg-red-50 text-brand-red px-1.5 py-0.5 rounded-full font-semibold" style={{ fontSize: 11 }}>
                {item.badge}
              </span>
            )}
          </Link>
        )
      })}
    </div>
  )
}

// ─── Layout ───────────────────────────────────────────────────────────────────
export default function Layout() {
  const { user, signOut, isAdmin } = useAuth()
  // Full-bleed routes own the whole content area (no padding, no outer scroll)
  const { pathname } = useLocation()
  const fullBleed = pathname.startsWith('/broadside')

  // ── Consolidated nav (v1.23): active section + remembered sub-tab ──────────
  const { search } = useLocation()
  const gpTab = new URLSearchParams(search).get('tab')
  const isActionPlan = getUserPlanType(user) === 'action'
  const isPaid = getUserTier(user) !== 'scout'
  const activeSection = sectionForLocation(pathname, gpTab)
  const currentSectionKey = activeSection?.key || null
  useEffect(() => {
    if (!activeSection || activeSection.direct) return
    const owner = (activeSection.items || []).find(i => {
      if (i.q) return (pathname === i.q.path || pathname.startsWith(i.q.path + '/')) && gpTab === i.q.tab
      const base = i.to.split('?')[0]
      return pathname === base || pathname.startsWith(base + '/')
    })
    if (owner) { try { sessionStorage.setItem('bb_nav_' + activeSection.key, owner.to) } catch { /* private mode */ } }
  }, [pathname, gpTab, activeSection])

  // v1.24.1: page titles live in the top bar (the formerly blank strip),
  // so pages start their content immediately — no duplicated headers.
  const PAGE_HEADERS = [
    { match: /^\/offices/,          title: 'Offices & Districts',    sub: 'All political offices tracked across Wisconsin' },
    { match: /^\/elections/,        title: 'Elections',              sub: 'Wisconsin election calendar & live results' },
    { match: /^\/places/,           title: 'City demographics',      sub: 'Census profile & comparisons' },
    { match: /^\/game-plan\?.*tab=calendar/, title: 'Calendar',       sub: 'Election calendar & key dates', useSearch: true },
    { match: /^\/game-plan\?.*tab=results/,  title: 'Results',        sub: 'Election night results', useSearch: true },
    { match: /^\/game-plan/,        title: 'Todo',                   sub: 'Campaign tasks & priorities' },
    { match: /^\/candidates\/.+/,  title: 'Candidates',             sub: 'Candidate profile' },
    { match: /^\/candidates/,       title: 'Candidates',             sub: 'All tracked candidates across Wisconsin' },
    { match: /^\/prospecting/,      title: 'Prospecting Lists',      sub: 'AI-powered candidate prospecting for political marketing outreach' },
    { match: /^\/recruit/,          title: 'Recruit',                sub: 'Find and vet candidate prospects for local seats from your voter list' },
    { match: /^\/voter-lists/,      title: 'Voter Lists',            sub: 'Upload voter CSV files, map addresses, and build targeted prospect lists' },
    { match: /^\/(dossiers|profiler)/, title: 'Profiler',            sub: 'AI-generated 14-section political intelligence reports' },
    { match: /^\/compare/,          title: 'Candidate Comparison',   sub: 'Side-by-side intelligence on two candidates', badge: 'Beta' },
    { match: /^\/events/,           title: 'District Events',        sub: 'Community events where your campaign should show up' },
    { match: /^\/campaign-connect/, title: 'Campaign Connect',       sub: 'Two accounts, one campaign' },
    // No sub for Broadside: the embedded module renders its own
    // "Take the hit before it's real" heading \u2014 printing it twice read
    // as a bug in the Aug-16 audit (R3 item).
    { match: /^\/broadside/,        title: 'Broadside',              badge: 'Beta' },
    { match: /^\/polling/,          title: 'Polling',                sub: 'AI-estimated district opinion snapshots', badge: 'Beta' },
    { match: /^\/settings/,         title: 'Settings',               sub: 'Manage your profile, billing, and account security' },
    // No /plans entry: Pricing renders standalone (outside Layout), so this
    // header could never match.
    { match: /^\/admin/,            title: 'Admin Panel',            sub: 'Platform health, accounts, billing & controls' },
    { match: /^\/$/,                title: 'Intelligence Dashboard', sub: 'Wisconsin statewide political tracking' },
  ]
  const pageHeader = PAGE_HEADERS.find(h => h.match.test(pathname + search)) || null
  const navigate           = useNavigate()
  const [sidebarOpen, setSidebarOpen]   = useState(false)
  const [profileOpen, setProfileOpen]   = useState(false)
  const profileRef                       = useRef(null)

  const userTier   = getUserTier(user)
  const tierConfig = getTierConfig(userTier) || getTierConfig('scout')

  // Close profile dropdown when clicking outside
  useEffect(() => {
    const handler = (e) => {
      if (profileRef.current && !profileRef.current.contains(e.target)) {
        setProfileOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const handleSignOut = useCallback(async () => {
    setProfileOpen(false)
    await signOut()
    navigate('/login')
  }, [signOut, navigate])

  // Stable callback — passed to Sidebar/NavItem so they never re-render due to
  // a new function reference being created on each Layout render.
  const onNavigate = useCallback(() => setSidebarOpen(false), [])

  // Main-tab click: open the section's remembered page, else its first page.
  const onGoSection = useCallback((sec, items) => {
    let target = items[0]?.to
    try {
      const remembered = sessionStorage.getItem('bb_nav_' + sec.key)
      if (remembered && items.some(i => i.to === remembered)) target = remembered
    } catch { /* private mode */ }
    if (target) navigate(target)
    setSidebarOpen(false)
  }, [navigate])

  return (
    <div className="flex h-screen overflow-hidden bg-brand-gray">
      {/* Sidebar — visible on md+ (iPad portrait and up) */}
      <aside className="hidden md:flex md:flex-col w-64 flex-shrink-0">
        <Sidebar
          currentSectionKey={currentSectionKey}
          onGoSection={onGoSection}
          isActionPlan={isActionPlan}
          isPaid={isPaid}
          isAdmin={isAdmin}
          isBeta={isBetaActive(user)}
          onNavigate={onNavigate}
          onSignOut={handleSignOut}
          tierConfig={tierConfig}
        />
      </aside>

      {/* Mobile sidebar overlay — phones only (< md).
          B1: z-drawer (35) — above the support chat (30), below every modal
          (40+), instead of the old z-[9990] which beat the whole app.
          B2: the panel is a single normal-flow column that owns the only
          scroller (max-height + overflow-y on the Sidebar root), so the nav
          group and the admin group are plain block siblings — they cannot
          overlap however many items either one has. */}
      {sidebarOpen && (
        <div className="md:hidden fixed inset-0 z-drawer flex">
          <div className="fixed inset-0 bg-black/60" onClick={() => setSidebarOpen(false)} />
          <div className="relative flex flex-col w-72 max-w-xs h-full max-h-[100dvh]">
            <Sidebar
              singleColumn
              currentSectionKey={currentSectionKey}
              onGoSection={onGoSection}
              isActionPlan={isActionPlan}
              isPaid={isPaid}
              isAdmin={isAdmin}
              isBeta={isBetaActive(user)}
              onNavigate={onNavigate}
              onSignOut={handleSignOut}
              tierConfig={tierConfig}
            />
            <button
              type="button"
              onClick={() => setSidebarOpen(false)}
              className="absolute top-4 right-4 text-white/70 hover:text-white"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>
      )}

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Top bar */}
        <header className="bg-white border-b border-gray-200 px-4 md:px-6 lg:px-8 py-3 flex items-center gap-4 flex-shrink-0">
          <button
            type="button"
            className="md:hidden p-2 rounded-lg hover:bg-gray-100 transition-colors"
            onClick={() => setSidebarOpen(true)}
          >
            <Menu className="w-5 h-5 text-gray-600" />
          </button>

          {pageHeader && (
            <div className="min-w-0 flex items-baseline gap-3">
              <h1 className="text-lg md:text-xl font-bold text-gray-900 whitespace-nowrap flex items-center gap-2">
                {pageHeader.title}
                {/* Neutral chip, not a purple pill: purple appears nowhere else
                    in a red/navy app, and a solid saturated badge shouted louder
                    than the page title it labels. */}
                {pageHeader.badge && (
                  <span className="text-[9px] font-extrabold uppercase tracking-wider bg-brand-navy/10 text-brand-navy border border-brand-navy/15 px-1.5 py-0.5 rounded-full">{pageHeader.badge}</span>
                )}
              </h1>
              <p className="hidden lg:block text-xs text-gray-400 truncate">{pageHeader.sub}</p>
            </div>
          )}

          <div className="ml-auto flex items-center gap-3">
            {/* Dossier generation status indicator */}
            <DossierStatusIndicator />

            {/* v1.19.2: all announcements land here; success ones also pop up 10s */}
            <NotificationCenter />

            {/* Profile dropdown */}
            <div className="relative" ref={profileRef}>
              <button
                type="button"
                onClick={() => setProfileOpen(o => !o)}
                className="flex items-center gap-1.5 rounded-xl hover:bg-gray-100 pl-1 pr-2 py-1 transition-colors"
              >
                <AccountAvatar user={user} size={32} />
                <ChevronDown className={`w-3.5 h-3.5 text-gray-400 transition-transform duration-150 ${profileOpen ? 'rotate-180' : ''}`} />
              </button>

              {profileOpen && (
                <div className="absolute right-0 top-full mt-2 w-64 bg-white rounded-xl shadow-xl border border-gray-200 py-2 z-50">
                  {/* User info header */}
                  <div className="px-4 py-3 border-b border-gray-100">
                    <div className="flex items-center gap-3">
                      <AccountAvatar user={user} size={40} />
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-gray-900 truncate">
                          {user?.user_metadata?.display_name || user?.email?.split('@')[0] || 'User'}
                        </p>
                        <p className="text-xs text-gray-400 truncate">{user?.email}</p>
                      </div>
                    </div>
                    {/* Plan badge */}
                    <div className="mt-2.5 flex items-center justify-between">
                      <span className="text-xs text-gray-400">Current plan</span>
                      <span className="text-xs font-semibold text-brand-red bg-brand-red/10 px-2 py-0.5 rounded-full">
                        {tierConfig?.name || 'Scout'}
                      </span>
                    </div>
                  </div>

                  {/* Menu items — these are the Settings rail's own pane names
                      (Settings.jsx NAV_GROUPS), not three different ones. The
                      menu used to say "My Profile" / "Billing & Plan" for panes
                      labelled "Your account" / "Plan & billing", so the screen
                      you landed on never matched the item you clicked. Links go
                      straight to the pane routes; the legacy #billing/#security
                      hashes still work, they just cost an extra redirect. */}
                  <div className="py-1">
                    <Link
                      to="/settings"
                      onClick={() => setProfileOpen(false)}
                      className="flex items-center gap-3 px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
                    >
                      <User className="w-4 h-4 text-gray-400" />
                      Your account
                    </Link>
                    <Link
                      to="/settings/plan"
                      onClick={() => setProfileOpen(false)}
                      className="flex items-center gap-3 px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
                    >
                      <CreditCard className="w-4 h-4 text-gray-400" />
                      Plan &amp; billing
                    </Link>
                    <Link
                      to="/settings/security"
                      onClick={() => setProfileOpen(false)}
                      className="flex items-center gap-3 px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
                    >
                      <Shield className="w-4 h-4 text-gray-400" />
                      Security
                    </Link>
                  </div>

                  <div className="border-t border-gray-100 py-1">
                    <button
                      type="button"
                      onClick={handleSignOut}
                      className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-red-600 hover:bg-red-50 transition-colors"
                    >
                      <LogOut className="w-4 h-4" />
                      Sign Out
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </header>

        {/* Section pages (consolidated nav v1.23) */}
        {activeSection && !activeSection.direct && (() => {
          const items = sectionItems(activeSection, { isAdmin, isBeta: isBetaActive(user), isPaid, isActionPlan, tierConfig })
          if (items.length < 2) return null
          return <SectionTabs items={items} pathname={pathname} tab={gpTab} />
        })()}

        {/* Offline indicator */}
        <OfflineBanner />

        {/* Page content.
            Route transitions used to fall through to App.jsx's outer Suspense
            fallback, which swapped the whole content area for a bordered
            spinner box — a partial red outline where the page had been. Inside
            the app chrome the wait is announced the same way every in-page
            fetch announces one: the thin brand-red LoadingBar across the very
            top (LoadingBar.jsx, z-9999 = Z.TOAST). Nothing else moves. */}
        <main className={`flex-1 relative ${fullBleed ? 'overflow-hidden' : 'overflow-y-auto'}`}>
          <PaymentLockOverlay>
            <div className={fullBleed ? 'h-full' : 'px-4 pt-2 pb-4 md:px-6 md:pb-6 lg:px-8 lg:pb-8 lg:pt-2'}>
              <Suspense fallback={<LoadingBar loading />}>
                <Outlet />
              </Suspense>
            </div>
          </PaymentLockOverlay>
        </main>
      </div>

      {/* Floating support chat widget */}
      <SupportChatWidget />
    </div>
  )
}
