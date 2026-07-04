// Netlify Scheduled Function: auto-regenerate-dossiers
// Runs weekly (Monday 9am CT) via netlify.toml schedule configuration.
// Only regenerates candidates where active monitoring has been explicitly enabled
// via the toggle on the candidate profile (section_timestamps.monitoring = true).
// These dossiers are generated with generated_by = null, so they do NOT consume
// the user's monthly dossier quota.

const SUPABASE_URL         = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const NETLIFY_SITE_URL     = process.env.URL || process.env.DEPLOY_URL || 'https://www.badgerboardwi.com'

// Minimum age (days) before a monitored dossier is eligible for auto-regen.
// Weekly schedule means 6 days is the practical minimum (cron fires Monday, dossier is ~6-7 days old).
const STALE_DAYS = 6

// Safety cap per run — prevents runaway API costs if many candidates are toggled on at once
const MAX_REGEN_PER_RUN = 20

export const handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  }

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' }

  // Netlify's scheduler invokes this without an HTTP method. Any real HTTP
  // request (external POST) MUST carry the shared trigger secret — otherwise
  // anyone could hit the URL and burn AI spend (up to MAX_REGEN_PER_RUN Opus
  // regenerations per call).
  const isHttp = Boolean(event.httpMethod)
  if (isHttp) {
    const secret = process.env.ADMIN_TRIGGER_SECRET
    const provided = event.headers?.['x-admin-trigger'] || event.headers?.['X-Admin-Trigger']
    if (!secret || provided !== secret) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Not authorized' }) }
    }
  }

  console.log('[auto-regen] Starting active-monitoring dossier regeneration run')

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('[auto-regen] Missing Supabase env vars')
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Missing Supabase configuration' }) }
  }

  // ── 1. Fetch candidates with active monitoring enabled ──────────────────────
  // Monitoring is stored as section_timestamps->>monitoring = 'true' (JSONB field, text comparison)
  let candidates = []
  try {
    // Fetch full candidate fields + office join so we can pass a complete candidate object
    // to generate-dossier-background (which requires body.candidate with name/party/office etc.)
    const candRes = await fetch(
      `${SUPABASE_URL}/rest/v1/candidates?select=id,name,party,status,occupation,employer,website,email,phone,campaign_committee,campaign_manager,bio_summary,twitter_handle,facebook_url,instagram_handle,is_incumbent,section_timestamps,office:offices(id,name,level,district_name,district_number)&section_timestamps->>monitoring=eq.true&order=name`,
      { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } }
    )
    if (!candRes.ok) throw new Error(`Candidates fetch failed: ${candRes.status}`)
    candidates = await candRes.json()
    console.log(`[auto-regen] Found ${candidates.length} candidate(s) with active monitoring enabled`)
  } catch (e) {
    console.error('[auto-regen] Could not fetch candidates:', e.message)
    return { statusCode: 502, headers, body: JSON.stringify({ error: e.message }) }
  }

  if (!candidates.length) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ message: 'No candidates have active monitoring enabled', regenerated: 0 }),
    }
  }

  // ── 2. For each candidate, check dossier age ─────────────────────────────────
  const staleThresholdMs = STALE_DAYS * 24 * 60 * 60 * 1000
  const toRegenerate = []

  await Promise.all(candidates.map(async (c) => {
    try {
      const dosRes = await fetch(
        `${SUPABASE_URL}/rest/v1/dossiers?candidate_id=eq.${c.id}&order=generated_at.desc&limit=1&select=id,generated_at`,
        { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } }
      )
      if (!dosRes.ok) return
      const dossiers = await dosRes.json()

      if (!Array.isArray(dossiers) || dossiers.length === 0) {
        // No dossier at all — include (but don't auto-generate fresh ones, just flag)
        console.log(`[auto-regen] ${c.name}: no existing dossier — skipping (generate manually first)`)
        return
      }

      const latestDossier = dossiers[0]
      const ageMs = Date.now() - new Date(latestDossier.generated_at).getTime()
      const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24))

      if (ageMs >= staleThresholdMs) {
        console.log(`[auto-regen] ${c.name}: dossier is ${ageDays} days old — queuing regeneration`)
        toRegenerate.push({ ...c, ageDays, existingDossierId: latestDossier.id })
      } else {
        console.log(`[auto-regen] ${c.name}: dossier is ${ageDays} days old — still fresh, skipping`)
      }
    } catch (e) {
      console.error(`[auto-regen] Error checking dossier for ${c.name}:`, e.message)
    }
  }))

  if (!toRegenerate.length) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ message: 'All active candidate profiles are fresh', regenerated: 0, candidates_checked: candidates.length }),
    }
  }

  // ── 3. Sort by stalest first, cap at MAX_REGEN_PER_RUN ──────────────────────
  toRegenerate.sort((a, b) => b.ageDays - a.ageDays)
  const batch = toRegenerate.slice(0, MAX_REGEN_PER_RUN)
  console.log(`[auto-regen] Queuing ${batch.length} of ${toRegenerate.length} stale candidates for regeneration`)

  // ── 4. Trigger background dossier generation for each ───────────────────────
  // Calling generate-dossier-background with the service key as auth means verifyUser()
  // returns null → generated_by is saved as null → dossier is excluded from monthly quota
  // counts (which filter generated_by IS NOT NULL). No quota tokens consumed.
  //
  // we use the service key directly (it is accepted as a valid JWT by the auth check in that function).
  const results = []

  for (const candidate of batch) {
    try {
      console.log(`[auto-regen] Triggering regeneration for ${candidate.name} (${candidate.id})`)
      const triggerRes = await fetch(
        `${NETLIFY_SITE_URL}/.netlify/functions/generate-dossier-background`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
          },
          body: JSON.stringify({
            candidate_id: candidate.id,
            candidate: candidate,
            auto_regenerated: true,
          }),
        }
      )

      // Background functions return 202 immediately
      const success = triggerRes.status === 202 || triggerRes.status === 200
      results.push({ candidate: candidate.name, id: candidate.id, status: success ? 'queued' : `error_${triggerRes.status}`, ageDays: candidate.ageDays })
      console.log(`[auto-regen] ${candidate.name}: ${success ? 'queued ✓' : `failed (HTTP ${triggerRes.status})`}`)

      // Brief pause between triggers to avoid hammering the API
      if (batch.indexOf(candidate) < batch.length - 1) {
        await new Promise(r => setTimeout(r, 3000))
      }
    } catch (e) {
      console.error(`[auto-regen] Failed to trigger regen for ${candidate.name}:`, e.message)
      results.push({ candidate: candidate.name, id: candidate.id, status: 'error', error: e.message })
    }
  }

  const queued   = results.filter(r => r.status === 'queued').length
  const errored  = results.filter(r => r.status !== 'queued').length
  const skipped  = toRegenerate.length - batch.length

  console.log(`[auto-regen] Run complete: ${queued} queued, ${errored} errors, ${skipped} skipped (cap), ${candidates.length - toRegenerate.length} already fresh`)

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      message: `Auto-regeneration complete`,
      queued,
      errored,
      skipped,
      already_fresh: candidates.length - toRegenerate.length,
      results,
      ran_at: new Date().toISOString(),
    }),
  }
}
