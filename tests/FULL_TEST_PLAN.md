# Badger Board — Full Test Plan
**Version:** 1.0 · **Date:** 2026-04-22  
**App:** https://www.badgerboardwi.com  
**Scope:** All user-facing features + backend functions + integrations + security

---

## How to Read This Document

Each test section has two layers:

- **Frontend (FE):** What a real user in the browser would do and what they should see
- **Backend (BE):** What the server should do — Netlify function behavior, Supabase queries, API calls, error handling, env var usage

Tests marked `[CRITICAL]` are high-priority; failures here break core functionality or expose user data.  
Tests marked `[TIER]` validate plan gating logic.  
Tests marked `[INT]` involve an external integration (Stripe, Claude, Perplexity, GoHighLevel).

---

## Suite 1 — Authentication & Session Management

### 1.1 Sign Up

**FE-1.1.1** Fill in first name, last name, email, phone, password, select a position, check Terms — account is created and user lands on Dashboard.  
**FE-1.1.2** Submit with weak password (< 8 chars) — strength meter shows "Weak," button is disabled or shows validation error.  
**FE-1.1.3** Submit without checking Terms — error shown, account not created.  
**FE-1.1.4** Submit with already-registered email — Supabase returns error, user sees "Email already in use" (not a raw Supabase error message).  
**FE-1.1.5** Phone number auto-formats to (###) ###-#### as user types.  
**FE-1.1.6** All 9 position options appear in the dropdown and can be selected.  
**FE-1.1.7** Password strength meter progresses through all 6 levels (Very Weak → Very Strong) as characters are added.

**BE-1.1.1** `[CRITICAL]` Supabase `auth.signUp()` receives correct `user_metadata` payload: `{ first_name, last_name, display_name, business, phone, position }`.  
**BE-1.1.2** After signup, `user.user_metadata.plan` defaults to `"scout"`.  
**BE-1.1.3** No Netlify function is called during signup — all auth is client-side Supabase.  
**BE-1.1.4** `[CRITICAL]` Signing up with a service role key or admin email does not grant elevated privileges on the first login.

---

### 1.2 Sign In

**FE-1.2.1** Valid credentials → user is redirected to Dashboard.  
**FE-1.2.2** Invalid password → error message shown (not a raw Supabase error).  
**FE-1.2.3** Unknown email → error message shown.  
**FE-1.2.4** If already signed in, navigating to `/login` redirects to `/`.  
**FE-1.2.5** Loading spinner displays while auth is being checked on page load.

**BE-1.2.1** `[CRITICAL]` Auth JWT is stored in Supabase session (not localStorage-only).  
**BE-1.2.2** `AuthContext` calls `supabase.auth.getSession()` on mount, then subscribes to `onAuthStateChange`.

---

### 1.3 Sign Out

**FE-1.3.1** Clicking "Sign Out" in sidebar or profile dropdown clears session and redirects to `/login`.  
**FE-1.3.2** After sign out, navigating to any protected route redirects to `/login`.

**BE-1.3.1** `[CRITICAL]` `supabase.auth.signOut()` invalidates the JWT server-side (Supabase revokes the refresh token).

---

### 1.4 Protected Routes

**FE-1.4.1** Unauthenticated user hitting any `/` sub-route is redirected to `/login`.  
**FE-1.4.2** `/terms`, `/plans`, `/dossier-disclaimer` are accessible without auth.  
**FE-1.4.3** `/v` (Volunteer Portal) is accessible without main app auth.

**BE-1.4.1** `ProtectedRoute` wrapper correctly reads `loading` state and does not flash protected content before checking auth.

---

### 1.5 Payment Lock

**FE-1.5.1** A user with `payment_status === "past_due"` sees `PaymentLockOverlay` blocking the main content area.  
**FE-1.5.2** The overlay shows a link to manage billing (Settings) and to view plans.  
**FE-1.5.3** Admin emails (`tony@bluejackgroup.com`, `tony@thebluejackgroup.com`) never see the payment lock overlay.

**BE-1.5.1** `AuthContext` polls every 5 minutes to refresh session when `payment_status === "past_due"`, so the lock clears without page reload once payment is resolved.  
**BE-1.5.2** `[CRITICAL]` `isPaymentLocked` flag is computed from JWT claims, not from a client-side variable that could be manipulated.

---

## Suite 2 — Navigation & Layout

**FE-2.1** Sidebar shows all 9 navigation items: Dashboard, Offices, Elections, Candidates, Prospecting, Voter Lists, Dossiers, Compare, Door Knocking.  
**FE-2.2** "Admin Panel" link only appears for admin emails.  
**FE-2.3** Mobile hamburger menu opens/closes sidebar correctly.  
**FE-2.4** Active route is highlighted in the sidebar.  
**FE-2.5** Profile dropdown shows user's display name, plan badge, and links to Settings and Sign Out.  
**FE-2.6** Plan badge in the profile dropdown shows the correct plan (Scout / Monitor / Campaign / Agency).  
**FE-2.7** Dossier status indicator in the top bar shows "Generating…" while a dossier is being built, and "Ready" when complete (without page reload).  
**FE-2.8** Announcement banner renders if `is_active` announcements exist; can be dismissed.  
**FE-2.9** Announcement banner type (info / warning / success / error) is reflected in background color.

**BE-2.1** Announcement banners are fetched from Supabase `announcements` table filtered by `is_active = true`.  
**BE-2.2** `DossierStatusContext` polls Supabase for `dossiers` with `status = "generating"` at a reasonable interval (not more than every 10 seconds).

---

### 2.1 Support Chat Widget

**FE-2.1.1** Clicking the chat FAB (bottom-right) opens the chat panel.  
**FE-2.1.2** Typing a message and pressing Send (or Enter) displays the user's message in the thread.  
**FE-2.1.3** A typing indicator appears while awaiting a response.  
**FE-2.1.4** Claude's reply appears in the thread after a short delay.  
**FE-2.1.5** Closing and reopening the panel preserves the conversation history (until page refresh).  
**FE-2.1.6** Link to full support site is displayed in the chat header.  
**FE-2.1.7** If the user is not logged in (or session has expired), the widget handles auth failure gracefully (shows error, does not crash).

**BE-2.1.1** `[CRITICAL]` Every request to `support-chat` includes the JWT in the body; the function verifies it against Supabase `/auth/v1/user` before calling Claude.  
**BE-2.1.2** `[CRITICAL]` `user_id` in the function is derived from the verified JWT, never from request body fields.  
**BE-2.1.3** `[CRITICAL]` Claude's system prompt is built dynamically per user and includes only that user's data (plan, list count, volunteer count, error count).  
**BE-2.1.4** `support-chat` uses `SUPABASE_ANON_KEY` (not `VITE_SUPABASE_ANON_KEY`) at runtime in the Netlify environment.  
**BE-2.1.5** `[INT]` Claude is called with the `claude-haiku-4-5` model and a sensible `max_tokens` limit.  
**BE-2.1.6** Response body never contains service role keys, other users' emails, or raw UUIDs from other records.  
**BE-2.1.7** GET requests to `/.netlify/functions/support-chat` return HTTP 405.  
**BE-2.1.8** Missing `messages` field in POST body returns HTTP 400.

---

## Suite 3 — Dashboard

**FE-3.1** All four stats cards load (Offices, Candidates, Dossiers, Prospect Lists) and show accurate counts.  
**FE-3.2** Party breakdown bar reflects the current Republican/Democrat/Other split of candidates.  
**FE-3.3** Upcoming election calendar shows elections in chronological order with countdown timers.  
**FE-3.4** Past elections do not appear in the "upcoming" calendar.  
**FE-3.5** Recent candidates list shows the 6 most recent candidates with their office and party.  
**FE-3.6** Quick action buttons navigate to the correct pages.  
**FE-3.7** A new user with no data sees zeroed-out stats (no crash, no empty state error).

**BE-3.1** All stat queries target the correct Supabase tables: `offices`, `elections`, `candidates`, `dossiers`, `prospecting_lists`.  
**BE-3.2** `[CRITICAL]` All queries use the user's JWT (not service role), so RLS scopes results to the current user's records.  
**BE-3.3** Party breakdown correctly maps `Republican`, `Democrat`, `Independent`, and other values.  
**BE-3.4** The election calendar query filters by `election_date >= today` to show only upcoming elections.  
**BE-3.5** Recent candidates query `ORDER BY created_at DESC LIMIT 6` and includes nested office data.

---

## Suite 4 — Offices

### 4.1 Table View

**FE-4.1.1** Office list loads with name, level, type, district, county, and candidate count columns.  
**FE-4.1.2** Search field filters by name in real time.  
**FE-4.1.3** Level filter (Federal / State / County / Municipal) correctly filters results.  
**FE-4.1.4** Type filter (Executive / Legislative / Judicial / Administrative) correctly filters results.  
**FE-4.1.5** Clicking an office row opens a candidate panel showing all candidates assigned to that office.

### 4.2 Map View

**FE-4.2.1** Toggle to Map View renders a MapLibre GL map without errors.  
**FE-4.2.2** Map layers color-code offices by level (Federal / State / County / Municipal).  
**FE-4.2.3** Clicking a district on the map opens the candidate panel for that office.

### 4.3 Add / Edit / Delete Office

**FE-4.3.1** "Add Office" modal opens with all fields visible.  
**FE-4.3.2** All 20 fields (name, level, type, district number, county, city, website, etc.) can be filled and saved.  
**FE-4.3.3** Required fields prevent save if blank.  
**FE-4.3.4** After adding an office, it appears in the list without a page refresh.  
**FE-4.3.5** Edit icon opens the modal pre-populated with existing values.  
**FE-4.3.6** Deleting an office shows a confirmation prompt; confirms removal from the list.

**BE-4.1** `[CRITICAL]` All CRUD operations hit the `offices` table with the user's JWT — RLS enforces `created_by = auth.uid()`.  
**BE-4.2** Deleting an office that has candidates assigned to it does not orphan those candidates (FK constraint or cascade).  
**BE-4.3** No Netlify function is called for offices — all direct Supabase client calls.

---

## Suite 5 — Elections

### 5.1 Election List

**FE-5.1.1** Elections list loads showing name, type, date, and filing deadline.  
**FE-5.1.2** Year filter correctly filters by election year.  
**FE-5.1.3** Election types (Primary / General / Spring Primary / Spring General / Special) render correctly.

### 5.2 Add / Edit / Delete Election

**FE-5.2.1** "Add Election" modal opens with all required fields.  
**FE-5.2.2** Date and deadline pickers work correctly.  
**FE-5.2.3** After save, election appears in the list immediately.  
**FE-5.2.4** Edit pre-populates fields; changes save correctly.  
**FE-5.2.5** Delete removes the election (confirmation prompt shown first).

### 5.3 Election Night Live Updates

**FE-5.3.1** "Live Update" button calls the update function and shows a loading state.  
**FE-5.3.2** After update, reporting percentage and precinct count are visible.  
**FE-5.3.3** Results panel shows candidates with votes, party, and winner flag.

**BE-5.3.1** `[INT]` `election-night-update.js` calls the external election data vendor API and parses the response correctly.  
**BE-5.3.2** Parsed results are written back to `elections.notes` as valid JSON: `{ results, summary, reporting_pct, auto_updated }`.  
**BE-5.3.3** If the external API is unavailable, the function returns a graceful error (not a 500 crash) and the frontend shows an appropriate message.  
**BE-5.3.4** `[CRITICAL]` The function does not accept arbitrary note content from the request body — results come only from the external source.

### 5.4 Election Results Page

**FE-5.4.1** `/elections/results/:id` loads the correct election.  
**FE-5.4.2** Result rows (candidate name, office, party, votes, winner) can be added, edited, and deleted.  
**FE-5.4.3** Winner flag (checkmark/star) displays correctly.  
**FE-5.4.4** Results persist after page reload.

**BE-5.4.1** Results are stored in `elections.notes` JSON; updating a row re-encodes and saves the full JSON blob correctly.  
**BE-5.4.2** An invalid `id` route param returns a graceful "not found" state, not a crash.

---

## Suite 6 — Candidates

### 6.1 Table View & Filters

**FE-6.1.1** Candidate list loads with name, party, office, status, and contact columns.  
**FE-6.1.2** Search by name filters in real time.  
**FE-6.1.3** Party filter (Republican / Democrat / Independent / Other) correctly filters.  
**FE-6.1.4** Status filter (Active / Inactive / Prospective) correctly filters.  
**FE-6.1.5** Office filter dropdown shows only offices the user has created.  
**FE-6.1.6** Clicking a candidate's name navigates to their detail page.

### 6.2 Map View

**FE-6.2.1** Toggle to Map View renders map with candidate districts colored.  
**FE-6.2.2** District filter on the map (Federal / State / County / Municipal) shows the correct GeoJSON layers.  
**FE-6.2.3** Clicking a district on the map shows candidates for that district.

### 6.3 Add Candidate

**FE-6.3.1** "Add Candidate" modal opens with all 19 fields visible.  
**FE-6.3.2** Office and Election dropdowns are populated from the user's own records.  
**FE-6.3.3** All required fields show validation if blank on save.  
**FE-6.3.4** Candidate is added to the list immediately on save.

### 6.4 CSV Import `[TIER: Monitor+]`

**FE-6.4.1** CSV import is locked (upgrade prompt) for Scout plan users.  
**FE-6.4.2** Monitor+ users see the CSV import button.  
**FE-6.4.3** Uploading a valid CSV shows a preview with correct column mapping.  
**FE-6.4.4** After import, a result summary shows inserted / skipped / error counts.  
**FE-6.4.5** Importing a CSV with duplicate emails skips those rows gracefully.  
**FE-6.4.6** An empty CSV or wrongly-formatted file shows an error, not a crash.

**BE-6.4.1** CSV insert batch uses the user's JWT — RLS ensures `created_by` is set to the calling user's ID.  
**BE-6.4.2** Bulk insert is batched to avoid hitting Supabase row limits.

### 6.5 AI Candidate Discovery `[TIER: Campaign+]` `[INT]`

**FE-6.5.1** Discover Candidates button is locked for Scout / Monitor users.  
**FE-6.5.2** Campaign+ users can open the discovery panel, select county/level/office, and run the prompt.  
**FE-6.5.3** Discovered candidates appear as a list; user can add selected ones to their candidate table.  
**FE-6.5.4** If Claude returns no results, a friendly "no results found" message appears.

**BE-6.5.1** `discover-candidates.js` verifies auth before calling Claude.  
**BE-6.5.2** `[INT]` Claude prompt includes county, level, and office parameters and expects a structured JSON response.  
**BE-6.5.3** If Claude API is down, function returns 503 with a friendly error message.  
**BE-6.5.4** `[CRITICAL]` No service role key is used to call Claude — only the Anthropic API key.

### 6.6 AI Autofill `[TIER: Campaign+]` `[INT]`

**FE-6.6.1** Autofill button (magic wand) is locked for Scout / Monitor users.  
**FE-6.6.2** Clicking Autofill for a Campaign+ user populates fields (name, party, office, website, bio, social links) from web search.  
**FE-6.6.3** Autofill shows a loading state while running.  
**FE-6.6.4** Fields that were already filled are not overwritten unless empty.

**BE-6.6.1** `autofill-candidate.js` calls Perplexity for web search, then Claude to parse the results.  
**BE-6.6.2** `[INT]` Both `ANTHROPIC_API_KEY` and `PERPLEXITY_API_KEY` are present in the Netlify environment.  
**BE-6.6.3** If Perplexity returns no results, the function falls back gracefully.  
**BE-6.6.4** The function is POST-only; GET returns 405.

---

## Suite 7 — Candidate Detail Page

**FE-7.1** All candidate fields render correctly (name, party, office, status, contact, bio, notes, social links).  
**FE-7.2** Social media links open in a new tab (locked for Scout users — upgrade prompt shown).  
**FE-7.3** Edit pencil icon opens the edit modal pre-populated with all fields.  
**FE-7.4** Saving edits updates the page immediately and persists on reload.  
**FE-7.5** Delete button shows confirmation prompt; removing candidate redirects to `/candidates`.

### 7.1 Incumbent Legislative Record

**FE-7.1.1** "Add Record" button opens the incumbent record form.  
**FE-7.1.2** Record type (bill / act / regulation / law / legal / vote / other) is selectable.  
**FE-7.1.3** Vote result (yes / no / abstain / absent / not_applicable) is selectable.  
**FE-7.1.4** Significance (major / notable / minor) is selectable.  
**FE-7.1.5** After adding a record, it appears in the timeline without refresh.  
**FE-7.1.6** Edit and delete work correctly for records.

**BE-7.1.1** `incumbent_records` CRUD uses RLS: `created_by = auth.uid()`.  
**BE-7.1.2** Deleting a candidate cascades and removes all its `incumbent_records`.

### 7.2 Dossiers on Candidate Page

**FE-7.2.1** Dossier list for the candidate shows status (generating / ready) and generation date.  
**FE-7.2.2** "Generate New Dossier" checks the user's monthly quota before firing — shows error if limit reached.  
**FE-7.2.3** Dossier quota bar reflects current usage vs. monthly limit.

**BE-7.2.1** See Dossier Suite (Suite 9) for backend tests.

---

## Suite 8 — Candidate Compare

**FE-8.1** Two candidate picker dropdowns are shown (left and right).  
**FE-8.2** Picking a candidate in one slot loads their name and party badge.  
**FE-8.3** If dossiers exist for both candidates, comparison sections render: News, Policy, Controversies, Attack/Defense, Verification.  
**FE-8.4** If a candidate has no dossier, the comparison shows "No dossier available" for that side.  
**FE-8.5** If the same candidate is picked on both sides, the page still renders (no crash).  
**FE-8.6** Comparison is scoped to only the user's own candidates and dossiers.

**BE-8.1** `[CRITICAL]` Both `candidates` and `dossiers` queries use the user's JWT — RLS ensures users cannot compare other users' data.  
**BE-8.2** Dossier content parsing (extracting sections from markdown) handles missing or malformed sections without crashing.

---

## Suite 9 — Dossiers

### 9.1 Dossier List

**FE-9.1.1** Dossier list shows candidate name, status, and generation date.  
**FE-9.1.2** Status pill correctly shows "Generating…" or "Ready."  
**FE-9.1.3** Clicking a ready dossier opens the viewer.  
**FE-9.1.4** Disclaimer modal appears on first dossier view (one-time, per user).

### 9.2 Dossier Generation

**FE-9.2.1** "Generate Dossier" button checks monthly quota — shows upgrade prompt if limit is reached.  
**FE-9.2.2** `[TIER]` Scout users can generate 1 dossier/month; attempt after 1 shows upgrade prompt.  
**FE-9.2.3** `[TIER]` Monitor users can generate 5 dossiers/month.  
**FE-9.2.4** `[TIER]` Campaign users can generate 25 dossiers/month.  
**FE-9.2.5** `[TIER]` Agency users have unlimited dossiers.  
**FE-9.2.6** After clicking "Generate," the list shows a "Generating…" row and the top bar shows the status indicator.  
**FE-9.2.7** Without page reload, the status changes to "Ready" when generation completes (polls Supabase).

**BE-9.2.1** `generate-dossier.js` verifies the user's JWT before queuing the background job.  
**BE-9.2.2** `[CRITICAL]` Monthly quota is checked server-side in `generate-dossier.js` (not just client-side) — count of `dossiers` WHERE `generated_by = user.id` AND `generated_at >= first of month` AND NOT auto-refresh.  
**BE-9.2.3** `[CRITICAL]` `generate-dossier-background.js` is the async worker; it saves the completed dossier to Supabase and sets `status = "ready"`.  
**BE-9.2.4** `[INT]` Background function calls Perplexity for news/social research (§1 and §10) and Claude Sonnet for all 14 sections.  
**BE-9.2.5** If Claude returns a malformed response, the background function catches the error, sets `status = "error"` in Supabase, and does not leave the dossier in "generating" state indefinitely.  
**BE-9.2.6** `[INT]` Both `ANTHROPIC_API_KEY` and `PERPLEXITY_API_KEY` are present and valid in the Netlify environment.

### 9.3 Dossier Viewer

**FE-9.3.1** All 14 sections render (Overview, News, Bio, Timeline, Political Record, Financial, Controversies, Policy, Affiliations, Network, Social Posts, Digital, Media Strategy, Attack & Defense).  
**FE-9.3.2** Each section tab switches content correctly.  
**FE-9.3.3** Confidence badges (**[KNOWN]**, **[RESEARCH REQUIRED]**, etc.) render styled (not as raw markdown).  
**FE-9.3.4** Markdown headings, bullets, and paragraphs render properly.

### 9.4 PDF Export

**FE-9.4.1** "Export PDF" button generates and downloads a PDF.  
**FE-9.4.2** The PDF contains the candidate's name and all dossier sections.  
**FE-9.4.3** `[TIER]` White-label PDF (no Badger Board branding) is only available to Agency users.

### 9.5 Bulk Generation `[TIER: Agency+]`

**FE-9.5.1** "Bulk Generate" button is locked for Scout / Monitor / Campaign users.  
**FE-9.5.2** Agency users can select multiple candidates and queue all dossiers at once.  
**FE-9.5.3** A progress indicator shows how many are complete vs. total.

**BE-9.5.1** Bulk generation iterates candidates and calls `generate-dossier.js` for each in sequence or with controlled concurrency — does not flood the Anthropic API.

### 9.6 Weekly Auto-Refresh `[TIER: Campaign+]`

**BE-9.6.1** `auto-regenerate-dossiers.js` runs on a scheduled trigger (Friday).  
**BE-9.6.2** It queries Supabase for all users on Campaign+ plan and generates updated dossiers for their active candidates.  
**BE-9.6.3** Auto-refreshed dossiers are marked in the DB so they do not count against the monthly quota.  
**BE-9.6.4** If a user has no active candidates, the function skips silently (no crash).  
**BE-9.6.5** `[CRITICAL]` The function uses the service role key for Supabase queries but calls Claude using only the Anthropic API key — no user credentials are used in auto-refresh.

---

## Suite 10 — Prospecting

**FE-10.1** `[TIER]` Prospecting page shows an upgrade prompt for Scout and Monitor plan users.  
**FE-10.2** Campaign+ users see the prospect list manager.  
**FE-10.3** Saved prospecting lists load with name, query, and date created.  
**FE-10.4** Clicking a list shows the voter/contact records inside it.  
**FE-10.5** "Build New List" opens the AI prospecting builder — user selects offices/elections and runs the prompt.  
**FE-10.6** Results appear as a paginated list of contacts with name, party, and district.  
**FE-10.7** "Download as CSV" exports the list correctly with all columns.  
**FE-10.8** Deleting a list removes it and all associated records.

**BE-10.1** `[INT]` `generate-prospecting.js` calls Claude with office/election parameters and expects a structured JSON array response.  
**BE-10.2** `[CRITICAL]` Auth is verified before calling Claude; the user's plan is checked server-side.  
**BE-10.3** Large result sets are paginated in the Supabase query (not loaded all at once).  
**BE-10.4** `[CRITICAL]` RLS on `prospecting_lists` and `prospecting_list_voters` scopes results to `created_by = auth.uid()`.

---

## Suite 11 — Voter Lists

### 11.1 CSV Upload

**FE-11.1.1** "Upload Voter File" accepts a `.csv` file.  
**FE-11.1.2** Column auto-detection correctly maps: `firstname/first_name/first`, `lastname/last_name/last`, `address/res_address`, `city/municipality/muni`, `zip/zipcode`, `county`, `party`.  
**FE-11.1.3** A preview shows detected columns before import.  
**FE-11.1.4** Import result shows total rows inserted, skipped (duplicates), and errors.  
**FE-11.1.5** A malformed CSV (wrong encoding, truncated rows) shows a friendly error, not a crash.

### 11.2 Voter Table

**FE-11.2.1** Voter table loads with name, address, county, party, propensity score, vote history dots.  
**FE-11.2.2** Search by name or address filters in real time.  
**FE-11.2.3** County filter shows counties present in the data.  
**FE-11.2.4** Party filter (Republican / Democrat / Independent / Unknown) works correctly.  
**FE-11.2.5** Propensity score bar renders (0–100 pseudo-random per voter ID).  
**FE-11.2.6** Vote history dots (G22, P22, G20, P20, G18) render correctly for voters with history.

### 11.3 Saved Lists

**FE-11.3.1** "Save Selection" saves a named subset with color.  
**FE-11.3.2** Saved list reloads its voters on revisit.  
**FE-11.3.3** Renaming a saved list updates in real time.  
**FE-11.3.4** Deleting a saved list removes it but does not delete the underlying voter records.

**BE-11.1** `[CRITICAL]` Bulk voter insert sets `created_by` from the authenticated user's JWT — RLS on `voters` enforces this.  
**BE-11.2** CSV batch insert is chunked to avoid hitting Supabase's row-size or timeout limits.  
**BE-11.3** `voter_saved_lists.voter_ids` is a UUID array — queries using `@>` or unnest work correctly.  
**BE-11.4** Deleting a `voter_lists` record cascades to delete all `voters` for that list.

---

## Suite 12 — Door Knocking (Beta)

### 12.1 List & Map

**FE-12.1.1** Candidate selector populates from the user's candidate table.  
**FE-12.1.2** MapLibre GL map loads without errors.  
**FE-12.1.3** Address markers appear on the map from the door knock list.  
**FE-12.1.4** Clicking an address card on the map shows knock history.

### 12.2 Shift Manager

**FE-12.2.1** "Create Shift" modal opens with date, time range, and location fields.  
**FE-12.2.2** Created shift appears in the shift list.  
**FE-12.2.3** Editing a shift pre-populates all fields.  
**FE-12.2.4** Deleting a shift shows a confirmation prompt.

### 12.3 Volunteer Manager

**FE-12.3.1** "Invite Volunteer" form accepts name, email, phone, and role (canvasser / captain).  
**FE-12.3.2** Invited volunteer receives a magic-link email (Supabase OTP).  
**FE-12.3.3** Volunteer appears in the list with "invited" status.  
**FE-12.3.4** Volunteer stats (doors knocked, contacts made, shifts worked) update in real time after the volunteer uses the portal.  
**FE-12.3.5** Deleting a volunteer removes them from the list.

### 12.4 Coordinator Chat

**FE-12.4.1** Coordinator can send messages to all volunteers for a given list.  
**FE-12.4.2** Messages appear in real time (Supabase Realtime).  
**FE-12.4.3** Broadcast notifications show as a banner in the volunteer portal.

**BE-12.1** `[CRITICAL]` `volunteer-auth.js` verifies the campaign user's JWT before performing `send_invite`, `get_volunteers_for_list`, `send_notification`, and `delete_volunteer` actions.  
**BE-12.2** Magic link tokens in `volunteers.magic_token` are single-use — cleared after first `verify_token` call.  
**BE-12.3** `[CRITICAL]` RLS on `door_knock_lists`, `shifts`, `door_knocks`, `volunteers`, `volunteer_messages`, and `volunteer_notifications` is enforced by `created_by = auth.uid()`.  
**BE-12.4** Supabase Realtime subscription for `volunteer_messages` is correctly scoped to `list_id = eq.{listId}` to prevent cross-list message leakage.  
**BE-12.5** PDF export of knock records queries `door_knocks` with RLS enforced — user cannot export another user's knocks.

---

## Suite 13 — Volunteer Portal (/v)

### 13.1 Authentication

**FE-13.1.1** Landing on `/v` with no token shows a login form (email + volunteer code).  
**FE-13.1.2** Landing on `/v?token=xxx` auto-verifies the token and logs in.  
**FE-13.1.3** An expired or invalid token shows a friendly error.  
**FE-13.1.4** After login, session persists in localStorage between tabs.  
**FE-13.1.5** Sign out clears localStorage session.

**BE-13.1.1** `volunteer-auth.js` `verify_token` action validates the token against `volunteers.magic_token`.  
**BE-13.1.2** `[CRITICAL]` Token is cleared from the DB (`magic_token = null`) after first use — cannot be replayed.  
**BE-13.1.3** `verify_token` uses the service role key (not anon key) to bypass RLS for the lookup.

### 13.2 Tabs

**FE-13.2.1** Home tab shows volunteer stats (doors, contacts, shifts), notifications, and a "Contact Support" link.  
**FE-13.2.2** Doors tab shows the next address card with knock outcome buttons.  
**FE-13.2.3** Selecting an outcome (Spoke With Voter, No Answer, Not Home, Refused, Wrong Address) and submitting records the knock.  
**FE-13.2.4** Support level picker (1–5 stars) can be set before submitting.  
**FE-13.2.5** Chat tab shows the group message thread and allows sending.  
**FE-13.2.6** Profile tab shows volunteer name, stats, and a sign-out button.

### 13.3 Offline Queue

**FE-13.3.1** With network disconnected, submitted knocks go into the offline queue (visible in the UI).  
**FE-13.3.2** On reconnection, the queue is drained and knocks are synced to Supabase.  
**FE-13.3.3** Offline state is clearly indicated (Wifi icon or banner).

**BE-13.3.1** Offline queue writes to `door_knocks` via direct Supabase client call on sync.  
**BE-13.3.2** `[CRITICAL]` Synced knocks use the volunteer's session token (not service role) — prevents volunteers from inserting into other users' lists.  
**BE-13.3.3** `volunteer-auth.js` `update_stats` correctly increments `doors_knocked`, `contacts_made`, and `shifts_worked` atomically (not read-then-write).

---

## Suite 14 — Pricing Page

**FE-14.1** All four tiers (Scout, Monitor, Campaign, Agency) display with correct names and base prices.  
**FE-14.2** Bracket selector (1, 2–5, 6–10, 11–25, 26–50, 51–100, 100+) updates prices in real time.  
**FE-14.3** Billing period selector (Monthly / Semi-annual / Annual) updates prices and savings callouts correctly.  
**FE-14.4** Annual pricing reflects "10 months billing" (2 months free) for each plan/bracket combination.  
**FE-14.5** Feature matrix (47 rows) renders all features correctly across all tiers.  
**FE-14.6** "Get Started" / "Upgrade" buttons are present for paid tiers.  
**FE-14.7** Enterprise bracket shows "Contact Us" instead of a price.  
**FE-14.8** Page is accessible without auth (`/plans`).

**BE-14.1** `[INT]` "Upgrade" button calls `create-checkout-session.js` with the correct `{ plan, bracket, billing_period }` parameters.  
**BE-14.2** `create-checkout-session.js` maps `plan × bracket × billing_period` to the correct `STRIPE_PRICE_*` env var.  
**BE-14.3** `[CRITICAL]` All 54 `STRIPE_PRICE_*` environment variables are set in Netlify production.  
**BE-14.4** Checkout session is created with the user's email pre-filled in Stripe.  
**BE-14.5** If a `STRIPE_PRICE_*` var is missing for a given combination, the function returns a clear error rather than silently creating a $0 session.

---

## Suite 15 — Settings

### 15.1 Profile

**FE-15.1.1** Display name field loads with current value.  
**FE-15.1.2** Editing and saving display name updates the profile dropdown in the sidebar immediately.  
**FE-15.1.3** Password change form requires current password + new password + confirmation.  
**FE-15.1.4** Mismatched new passwords show a validation error.  
**FE-15.1.5** Successful password change shows a success toast.

**BE-15.1.1** Display name is saved to `user.user_metadata.display_name` via `supabase.auth.updateUser()`.  
**BE-15.1.2** Password change uses `supabase.auth.updateUser({ password })` — verified by Supabase, not stored plaintext.

### 15.2 Billing

**FE-15.2.1** Current plan name and price display correctly.  
**FE-15.2.2** Dossier usage bar shows `used / monthly_limit` with correct color (green / orange / red).  
**FE-15.2.3** Usage resets on the 1st of each month (UI reflects this).  
**FE-15.2.4** "Manage Billing" button opens Stripe Customer Portal in a new tab.  
**FE-15.2.5** Dossier credit packs ($49/$199/$349/$749) show correct quantities and prices.  
**FE-15.2.6** `[INT]` Purchasing a credit pack navigates to Stripe Checkout.

**BE-15.2.1** `create-portal-session.js` verifies auth before generating the Stripe portal URL.  
**BE-15.2.2** `[INT]` `create-portal-session.js` uses `STRIPE_SECRET_KEY` and finds or creates the Stripe customer ID from the user's metadata.  
**BE-15.2.3** `buy-dossier-credits.js` creates a one-time Stripe payment intent and returns the checkout URL.  
**BE-15.2.4** `[CRITICAL]` The dossier usage count query excludes auto-refreshed dossiers (`is_auto_refresh IS NULL OR is_auto_refresh = false`).

### 15.3 Account Deletion

**FE-15.3.1** "Delete Account" button requires a confirmation prompt (typed confirmation or checkbox).  
**FE-15.3.2** After deletion, user is signed out and redirected to `/login`.  
**FE-15.3.3** Deleted account cannot sign in.

**BE-15.3.1** `[CRITICAL]` `delete-account.js` cascades deletion across all user-owned tables: `candidates`, `offices`, `elections`, `dossiers`, `prospecting_lists`, `voters`, `voter_lists`, `voter_saved_lists`, `door_knock_lists`, `shifts`, `door_knocks`, `volunteers`, `incumbent_records`, `activity_logs`.  
**BE-15.3.2** `[CRITICAL]` Auth deletion (`supabase.auth.admin.deleteUser()`) happens last, after all data is cleaned up.  
**BE-15.3.3** If a cascade step fails, the function rolls back or logs the error — does not leave partial data.

---

## Suite 16 — Billing Webhooks (Stripe)

**BE-16.1** `[CRITICAL]` `stripe-webhook.js` verifies the Stripe webhook signature using `STRIPE_WEBHOOK_SECRET` — rejects unsigned/tampered events.  
**BE-16.2** `checkout.session.completed` event correctly maps the purchased `price_id` to a `plan + bracket` and updates `user.user_metadata` accordingly.  
**BE-16.3** `customer.subscription.updated` correctly updates plan and bracket when a user changes their subscription.  
**BE-16.4** `customer.subscription.deleted` sets `payment_status = "canceled"` and downgrades the user to Scout plan.  
**BE-16.5** `invoice.payment_failed` sets `payment_status = "past_due"` — triggering the payment lock in the frontend.  
**BE-16.6** `invoice.payment_succeeded` clears `payment_status` back to `"active"`.  
**BE-16.7** `[CRITICAL]` Webhook handler uses the service role key to update `user_metadata` — uses `auth.admin.updateUserById()`, not the user's JWT.  
**BE-16.8** `payment-webhook.js` does not conflict with `stripe-webhook.js` — they handle distinct event sets.  
**BE-16.9** All 54 Stripe Price IDs in `create-checkout-session.js` have corresponding products in the Stripe dashboard (no dangling references).

---

## Suite 17 — Admin Panel

### 17.1 Access Control

**FE-17.1.1** Admin panel link is hidden from non-admin users in the sidebar.  
**FE-17.1.2** A non-admin user directly navigating to `/admin` is redirected to `/`.  
**FE-17.1.3** Admin panel is fully functional for both admin emails.

**BE-17.1.1** `[CRITICAL]` `admin-dashboard.js` verifies the JWT and checks `user_metadata.isAdmin` (or email match) before executing any action.  
**BE-17.1.2** A forged JWT with `email: "tony@bluejackgroup.com"` is rejected because Supabase token verification checks the real user record.

### 17.2 Health Tab

**FE-17.2.1** User list loads with email, plan, bracket, and last-active date.  
**FE-17.2.2** Activity logs table shows recent actions.  
**FE-17.2.3** Error logs section shows unresolved errors from the past 7 days.  
**FE-17.2.4** AI costs tab shows estimated monthly spend from `generation_logs`.

**BE-17.2.1** Health check queries `auth.admin.listUsers()` — uses service role key.  
**BE-17.2.2** AI cost calculation reads `generation_logs` and applies per-model token pricing.

### 17.3 Billing Tab

**FE-17.3.1** Billing events load from Stripe for all users.  
**FE-17.3.2** "Downgrade User" action sets the user to Scout plan and cancels their Stripe subscription.  
**FE-17.3.3** "Set Tier" action (admin-set-tier) updates the user's plan without a Stripe transaction.

**BE-17.3.1** `[CRITICAL]` `admin-billing.js` and `admin-set-tier.js` require admin auth before mutating any user record.  
**BE-17.3.2** `downgrade-to-free.js` cancels the Stripe subscription and sets `user_metadata.plan = "scout"`.

### 17.4 Announcements Tab

**FE-17.4.1** Existing announcements list loads with message, type, and active status.  
**FE-17.4.2** Create new announcement form shows message + type (info / warning / success / error) + active toggle.  
**FE-17.4.3** Saving a new announcement immediately makes it visible in the site-wide banner if `is_active = true`.  
**FE-17.4.4** Deactivating an announcement hides it from the site banner.  
**FE-17.4.5** Deleting an announcement removes it from the list.

**BE-17.4.1** Announcements CRUD uses the service role key to bypass RLS (admin-only operation).

### 17.5 Security Audit Tab

**FE-17.5.1** "Run Security Audit" button is present and clickable.  
**FE-17.5.2** A loading/spinning state appears while the audit runs (~20 seconds).  
**FE-17.5.3** Results render grouped by suite with pass/fail badges per test.  
**FE-17.5.4** "Ask Claude to Fix N Issues" button appears after a run with failures.  
**FE-17.5.5** Clicking the button opens the prompt panel showing the generated Claude prompt.  
**FE-17.5.6** "Copy to Clipboard" button copies the prompt and shows a "Copied!" confirmation.  
**FE-17.5.7** "Ask Claude to Review" button (all-pass case) opens the prompt panel with a hardening review prompt.

**BE-17.5.1** `run-security-audit.js` verifies the caller is an admin before executing any test.  
**BE-17.5.2** Test users (`sectest-a/b-{STAMP}@badger-test.invalid`) are created and cleaned up (deleted) in a `finally` block regardless of test outcome.  
**BE-17.5.3** All 38 security checks pass on production (see security test suite).

---

## Suite 18 — Tier Gating (Cross-Cutting)

These tests apply across multiple pages to verify plan enforcement is consistent between client and server.

**FE-18.1** `[TIER]` Scout user: prospecting page locked, dossier limit = 1, CSV import locked, AI discovery locked, social links locked.  
**FE-18.2** `[TIER]` Monitor user: CSV import unlocked, social links unlocked, dossier limit = 5, AI discovery locked, prospecting locked.  
**FE-18.3** `[TIER]` Campaign user: AI discovery unlocked, prospecting unlocked, dossier limit = 25, bulk dossier locked, Campaign Intel unlocked.  
**FE-18.4** `[TIER]` Agency user: everything unlocked, unlimited dossiers, bulk generation available.  
**FE-18.5** `[TIER]` Upgrade prompts link to the correct plan on the Pricing page.

**BE-18.1** `[CRITICAL]` Dossier generation server-side quota check cannot be bypassed by modifying client-side state.  
**BE-18.2** `[CRITICAL]` Claude-calling functions (`discover-candidates`, `generate-prospecting`, `generate-campaign-intel`) verify the user's plan server-side before calling the Anthropic API.  
**BE-18.3** Admin emails are always treated as Agency tier — verified in `getUserPlan()` in `tiers.js`.

---

## Suite 19 — GoHighLevel Integration

**BE-19.1** `[INT]` `ghl-contact.js` correctly syncs a new user to GoHighLevel on registration (or first login).  
**BE-19.2** `[INT]` `ghl-webhook.js` verifies the webhook secret before processing any event.  
**BE-19.3** `GHL_API_KEY` and `GHL_PIPELINE_ID` are set in the Netlify environment.  
**BE-19.4** GHL contact sync failures do not block the primary user flow (fire-and-forget or background).  
**BE-19.5** A GHL webhook call with an invalid secret returns HTTP 401.

---

## Suite 20 — Error Logging

**FE-20.1** Unhandled JavaScript errors in the app trigger a call to `/.netlify/functions/error-log`.  
**FE-20.2** Error reports appear in the Admin Panel → Health → Error Logs within seconds.

**BE-20.1** `error-log.js` accepts POST with `{ error_message, error_stack, component, url, user_id, user_agent, metadata }`.  
**BE-20.2** Requests without `error_message` return HTTP 200 (silently ignored) — does not break the app.  
**BE-20.3** GET requests return HTTP 405.  
**BE-20.4** `[CRITICAL]` Error logs are written using the service role key — they work even before the user is authenticated (pre-auth errors).  
**BE-20.5** Error records have `resolved = false` by default and appear in the admin "unresolved errors" query.

---

## Suite 21 — Performance & Reliability

**BE-21.1** All Netlify functions that call Claude include an explicit timeout or rely on Netlify's 26-second function limit — they do not hang indefinitely.  
**BE-21.2** `generate-dossier-background.js` runs as a background function (no 10-second timeout) and completes reliably under 25 seconds for a typical candidate.  
**BE-21.3** Supabase queries on large tables (`voters`, `door_knocks`) use appropriate `LIMIT`/`OFFSET` or cursor pagination — no unbounded selects.  
**BE-21.4** Realtime subscriptions in the Volunteer Portal and coordinator chat correctly unsubscribe on component unmount to prevent memory leaks.  
**BE-21.5** Dashboard stats page loads in under 3 seconds on a 3G connection (all queries run in parallel, not sequentially).  
**BE-21.6** CSV bulk import of 1,000+ voter rows completes without a timeout error.  
**BE-21.7** Auto-regenerate dossiers scheduled job does not run concurrently with itself (idempotency check or scheduled lock).

---

## Suite 22 — Environment Variables & Configuration

**BE-22.1** All required Netlify environment variables are present in the production environment:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `VITE_SUPABASE_ANON_KEY` (frontend build)
- `SUPABASE_ANON_KEY` (runtime in functions)
- `ANTHROPIC_API_KEY`
- `PERPLEXITY_API_KEY`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_PRICE_*` (54 price IDs)
- `GHL_API_KEY`
- `GHL_PIPELINE_ID`
- `GHL_WEBHOOK_SECRET`
- `SITE_URL`

**BE-22.2** No secrets are present in the compiled `dist2/` frontend bundle (grep for key prefixes: `sk_live`, `eyJhbGci`, `rk_live`).  
**BE-22.3** `VITE_` prefixed variables are correctly exposed to the frontend build but NOT to Netlify Functions at runtime.  
**BE-22.4** `SUPABASE_ANON_KEY` (non-VITE) is set so Netlify Functions can use it at runtime.

---

## Suite 23 — Data Integrity & Cascade Deletes

**BE-23.1** Deleting a `candidates` record cascades to: `dossiers`, `incumbent_records`, `activity_logs`, and removes the candidate from any `door_knock_lists`.  
**BE-23.2** Deleting an `offices` record either cascades or nullifies `candidates.office_id` (no orphaned FK references).  
**BE-23.3** Deleting an `elections` record either cascades or nullifies `candidates.election_id`.  
**BE-23.4** Deleting a `door_knock_lists` record cascades to: `shifts`, `door_knocks`, `volunteers`, `volunteer_messages`, `volunteer_notifications`.  
**BE-23.5** Deleting a `voter_lists` record cascades to: all `voters` in that list, all `voter_saved_lists` referencing those voter IDs.  
**BE-23.6** `dossiers_acknowledgments` is keyed by `user_id` — deleting a user removes the acknowledgment.

---

## Suite 24 — Security (Regression)

All tests from the existing `tests/security.test.js` must continue passing. Specifically:

**BE-24.1** `[CRITICAL]` Support chat rejects tokens with no token, empty token, garbage token, tampered sub, tampered email, alg:none, stripped signature, and future iat.  
**BE-24.2** `[CRITICAL]` RLS: User B cannot read, insert, update, or delete any records owned by User A in `door_knock_lists`, `door_knocks`, or `volunteers`.  
**BE-24.3** `[CRITICAL]` Unauthenticated requests to all Netlify functions are rejected with HTTP 401.  
**BE-24.4** `[CRITICAL]` GET requests to POST-only functions return HTTP 405.  
**BE-24.5** `[CRITICAL]` Regular users cannot call `admin-dashboard`, `admin-set-tier`, or `admin-billing`.  
**BE-24.6** `[CRITICAL]` SQL injection in PostgREST query parameters does not leak data.  
**BE-24.7** `[CRITICAL]` Error responses do not expose stack traces, internal paths, or service role keys.  
**BE-24.8** `[CRITICAL]` Volunteer RLS: `volunteer_messages` and `volunteer_notifications` are not readable cross-user.

---

## Appendix A — Test Execution Approach

### Automated Tests

| Layer | Tooling | Target |
|-------|---------|--------|
| Security regression | `tests/security.test.js` (Node.js, zero-dep) | Production API |
| Netlify function unit tests | Jest + mock Supabase/Stripe clients | Individual function files |
| React component tests | Vitest + React Testing Library | `src/pages/` + `src/components/` |
| E2E browser tests | Playwright | Full user flows on staging |

### Manual / QA Checks

- Stripe webhook events: Use Stripe CLI to replay events locally
- GoHighLevel integration: Verify contact records appear in GHL after user registration
- PDF export: Visually inspect on multiple browsers
- Offline queue: Enable Chrome DevTools → Network → Offline, submit knocks, re-enable, verify sync
- Realtime chat: Open two browser windows as coordinator + volunteer, verify messages appear instantly

### Environments

| Environment | URL | Notes |
|-------------|-----|-------|
| Production | https://www.badgerboardwi.com | Live users — run security + smoke only |
| Preview | Netlify deploy preview URL | Safe for destructive tests |
| Local | http://localhost:8888 | Full test suite, use `.env.test` |

---

## Appendix B — Priority Order for First Implementation

1. **Suite 24 (Security)** — Already built and passing 38/38
2. **Suite 9.2 (Dossier Generation Backend)** — Highest revenue risk feature
3. **Suite 16 (Stripe Webhooks)** — Billing correctness is critical
4. **Suite 18 (Tier Gating)** — Enforce plan limits server-side
5. **Suite 1 (Auth)** — Foundation for all other tests
6. **Suites 3–8 (Core UI pages)** — Feature completeness
7. **Suite 12–13 (Door Knocking + Volunteer Portal)** — Beta feature, lower urgency
8. **Suite 21 (Performance)** — Optimize after correctness is confirmed
