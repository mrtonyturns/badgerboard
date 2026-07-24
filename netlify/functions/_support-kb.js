// _support-kb.js — Badger Board support knowledge base (v1.23)
// Complete feature documentation injected into the support agent's system
// prompt. Written deliberately in a terse, disciplined, drill-instructor
// field-manual voice. Underscore prefix = never deployed as an endpoint.

const SUPPORT_KB = `
BADGER BOARD FIELD MANUAL
This is the mission briefing. Every feature. How to run it. No excuses.

── THE PLATFORM ──
Badger Board is Wisconsin political intelligence. One platform. Your whole operation: research, planning, outreach, monitoring. You bring the discipline. It brings the intel. Get after it.

── DASHBOARD ──
Mission: situational awareness at a glance.
Execution: it is the first screen after login. Review it every morning. Check your numbers, check your calendar, move out.

── OFFICES ──
Mission: know every battlefield in Wisconsin.
Execution: open Offices in the sidebar. Four district layers: State Assembly (99), State Senate (33), U.S. House (8), U.S. Senate. Click any district on the map. The popup gives you real demographics — population, age, income, education — from current Census data on the 2024 maps. Study the ground before you fight on it.
Availability: Action plans. Candidate plans do not include Offices.

── GAME PLAN ──
Mission: the campaign task system. If it is not on the board, it does not get done.
Execution:
1. Create tasks. Assign a phase, a category, a status, a due date. Optional: tie a task to a candidate or an election.
2. Use projects and sections to organize. Use the search in every picker — type, filter, select.
3. Milestones: pick an election and Game Plan generates a full WI race timeline — filing windows, finance deadlines, election day work-back. Verify dates with the WEC. Estimates are estimates.
4. Campaign Connect users: a Candidates section shows your linked candidates' boards. You can add tasks to their board. They see them. That is coordination.
Availability: all paid plans. Locked on Scout.

── CANDIDATES ──
Mission: your roster. Everyone you track, in one place.
Execution:
1. Add candidates manually, or use Discover (AI finds candidates by county and level) and Autofill (AI completes the record from a name).
2. Filter by party, status, county. Every big dropdown is searchable — type to filter.
3. The candidate page holds records (votes, endorsements, controversies), notes, and files.
4. Notes and files each have an AI toggle. Default is OFF. AI touches nothing unless you flip the toggle. Your call. Your data.
Availability: Discover and Autofill require Active tier or above.

── PROFILER (CANDIDATE PROFILES) ──
Mission: deep-dive intelligence dossiers on any candidate.
Execution:
1. Pick a candidate. Hit generate. Grok, Perplexity, and Claude scour the web, news, and social media. A full profile comes back: background, positions, votes, funding, controversies, news, social activity — with sources.
2. The snapshot at the top gives you the person in one paragraph. Read it first.
3. Share button: export PDF, or generate a timed share link (1 hour to 7 days). The link dies on schedule. Send it to whoever needs it.
4. What's New card: on refresh, the profile diffs against last week and lists what changed.
Limits: monthly profile generation is capped by plan (Scout and Monitor: 1. Candidate Active: 2. Candidate Campaign: 6. Action plans scale with your candidate bracket). Credit packs top you up when you need more.

── ACTIVE MONITORING ──
Mission: never get surprised by your own race.
Execution: profiles on monitored candidates refresh automatically every Monday. New articles, podcasts, posts, controversies get captured and summarized. Monday afternoon the Weekly Active Monitoring digest email goes out — one summary per monitored candidate, with buttons deep-linking into the full update in the app. Read it. Every week. Consistency wins.
Availability: weekly auto-refresh requires Candidate Campaign or Agency Active and above. Digest email can be toggled in Settings.

── COMPARE (BETA) ──
Mission: two candidates. Side by side. No spin.
Execution: open Compare, pick a candidate for each side from the searchable pickers. Their profiles line up section against section. Use it for debate prep and contrast messaging.
Availability: Active tier and above. Beta — expect rough edges, report them.

── POLLING (BETA) ──
Mission: a directional read on district opinion when no fresh poll exists.
Execution:
1. Pick any district — statewide, congressional, state senate, assembly. Search the dropdown.
2. First generation takes about a minute. Then it is cached for the week. Refresh button forces a new read.
3. You get: Top 4 issues ranked with why. Approval estimate. Vote-share projection. A confidence indicator with a margin on every figure.
3a. Vote-share is an ensemble: Grok, Perplexity, and Gemini each project it independently from the same research, and the app averages them — one model's bad read gets outvoted.
3b. Vote-share respects the calendar. Before a contested primary: each party's field is shown separately — candidates only compete inside their own primary — with the November general outlook below. Once nominees are set: a straight general head-to-head.
3c. Local Intel: add your own signal — canvass tallies, internal numbers, mailers, photos, PDFs, notes — and hit Regenerate. The AI weighs it alongside public research and adjusts the projection. Private to your account; your intel never touches the shared district baseline other users see.
4. Read the label: AI-Estimated. Not a scientific poll. It is modeled from news, past results, public polling, and social signal — sources listed at the bottom. Use it to aim your attention. Do not use it to bet the campaign. When it matters, field a real poll.
Availability: beta testers only.

── BROADSIDE (BETA) ──
Mission: debate sparring. Train like you fight.
Execution:
1. Load a profile in the Intel Intake panel (pick from your Profiler dossiers, paste text, or drop a file), set intensity, press Start.
2. Two roles. Defend: the AI grills you on the loaded profile's vulnerabilities. Attack: load your OPPONENT's profile and cross-examine — the AI defends in character, dodging and spinning like a real politician. Press when they dodge.
3. It talks fast now: replies stream sentence-by-sentence, the silence detector adapts to short answers, or hit Done Talking to hand over instantly. Start talking mid-sentence and barge-in cuts them off.
4. Topics get drilled, not skimmed: the opponent escalates on one topic until you land 2 strong answers or flub 3. Set the pace with Drill Depth; force depth with the Drill Topic button.
5. End every session with the report card — message discipline on defense, attack sharpness and follow-through on offense. OPPO LAG in the console tracks reply latency.
Availability: all paid plans. Beta — report rough edges.

── PROSPECTING ──
Mission: build target lists of potential candidates and contacts.
Execution: set filters (level, party, election, status) and let the AI build the list, or assemble one manually, or upload a CSV and the AI classifies each row's lean. Review the list. Then work the list.
Availability: Action plans.

── VOTER LISTS ──
Mission: manage voter file data.
Execution:
1. Upload a CSV. Standard Wisconsin voter file columns are auto-mapped. Rows load in batches with a progress bar.
2. Filter by party, county, district. Build saved lists. View voters on the map when addresses geocode.
3. Load voters on demand — big lists stay fast because nothing loads until you ask.
Privacy: voter data is yours alone. Row-level security walls it off from every other account, and the support AI cannot see it at all. Period.
Availability: CSV import on Monitor and above.

── ELECTIONS ──
Mission: every date that matters, plus results.
Execution: the calendar holds WI elections — add your own, tie candidates and tasks to them. Results appear on the results board when entered. Filter results by county.

── EVENTS ──
Mission: show up where the voters already are.
Execution:
1. Pick any district, county, or city. The AI researches upcoming community events — fairs, markets, festivals, parades, civic meetings — and classifies the likely crowd lean.
2. Add an event to your own calendar (Google, Apple, Outlook) with one click.
3. Action plans with Campaign Connect: select multiple events with the checkboxes and push them to any connected candidates' calendars in bulk. Fill their schedule with opportunities.

── CAMPAIGN CONNECT ──
Mission: the bridge between an action org and its candidates.
Execution:
1. Send a connect invite to a candidate account. They accept. You are linked.
2. Permissions control what flows: send profiles (with an expiry you pick), push events, add Game Plan tasks.
3. Sent profiles are viewable for the window you set — 1 hour to 7 days — then hidden. Your copy is never deleted.
Availability: Action plans on the org side.

── VOLUNTEER PORTAL ──
Mission: get volunteers working without friction.
Execution: volunteers get a magic link — no password. The portal at /v runs on any phone. Invite them, they tap the link, they are in.

── NOTIFICATIONS & ANNOUNCEMENTS ──
Mission: keep you informed without noise.
Execution: the bell, top right. All announcements land there. Success notices also pop for ten seconds while you work. Unread state is tracked. Check the bell when you log in.

── SETTINGS ──
Mission: configure once, then execute.
Execution: display name, connected calendars, default calendars, event reminders, weekly digest email toggle, notification preferences. Set it up on day one.

── PLANS & BILLING ──
Two tracks. Pick your lane:
CANDIDATE PLANS (one campaign, flat monthly):
- Scout — Free. Dashboard, elections, one lite profile a month. The recon tier.
- Monitor — $79/mo. Game Plan, full profiles (1/mo), CSV import, Broadside.
- Active — $119/mo. Adds Compare, Campaign Intel, Discover, 2 profiles/mo.
- Campaign — $189/mo. Adds weekly auto-refresh monitoring, 6 profiles/mo. The full kit.
ACTION PLANS (orgs running multiple candidates, priced by roster bracket: 1 / 2–5 / 6–10 / 11–25 / 26–50 / 51–100 / 100+ enterprise):
- Monitor — from $89/mo. Multi-candidate Game Plan, Prospecting, Offices, Campaign Intel.
- Active — from $149/mo. Adds Compare, weekly monitoring, more profiles per candidate.
- Campaign — from $219/mo. Everything, maximum profile volume.
Billing periods: monthly, quarterly (5% off), semiannual (10% off), annual (2 months free). Trials available — the app warns you 3 days before a trial ends. Credit packs cover extra profile generations. Upgrades are instant; downgrades prorate.
Manage all of it in Plans & Pricing. Billing questions the app cannot answer: support@badgerboardwi.com.

── DATA & PRIVACY — NON-NEGOTIABLE ──
1. Your data is walled off at the database layer. Row-level security. No other account can read it.
2. The support AI cannot see your voter lists. Cannot see your uploaded files. Cannot see your notes. It sees your plan tier and a few counts. That is all. By design.
3. Profile AI only touches notes or files where you flipped the AI toggle ON. Default is OFF.
4. Every AI-generated estimate is labeled. Sources are cited. Verify anything you act on.

── STANDARD OPERATING PROCEDURE FOR PROBLEMS ──
1. Refresh the page. Thirty percent of problems die right there.
2. Check your plan tier — most "missing" features are tier-gated. Plans & Pricing shows the matrix.
3. Still broken? Report it: support@badgerboardwi.com. State what you did, what you expected, what happened. Precise reports get fast fixes.
No complaints without action. Report it, we fix it, everybody gets better.
`.trim()

module.exports = { SUPPORT_KB }
