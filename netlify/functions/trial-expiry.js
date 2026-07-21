// netlify/functions/trial-expiry.js
// ─── Scheduled daily: expire lapsed trials + send ending-soon warnings ───────
// Schedule is set in netlify.toml (daily at 14:00 UTC ≈ 8-9am Central).
//
// For every user with trial fields in app_metadata:
//   • trial_ends_at in the past  → clear trial_* fields and email "trial ended".
//     The entitlement resolver then falls back to their paid plan or free
//     Scout automatically — this is the auto-demotion. (Clients also treat past
//     trial_ends_at as inactive, so access ends on time even between runs.)
//   • trial_ends_at within 3 days and no warning sent yet → email
//     "trial ending soon" and set trial_warning_sent so it's sent once.

const { sendEmail } = require('./_email')

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY

const WARNING_WINDOW_MS = 3 * 86400000  // warn at T-3 days

const PLAN_LABEL = {
  c_monitor: 'Monitor', c_active: 'Active', c_campaign: 'Campaign',
  a_monitor: 'Action Monitor', a_active: 'Action Active', a_campaign: 'Action Campaign',
}

async function listAllUsers() {
  const users = []
  for (let page = 1; page <= 50; page++) {
    const res = await fetch(
      `${SUPABASE_URL}/auth/v1/admin/users?page=${page}&per_page=200`,
      { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } }
    )
    if (!res.ok) throw new Error(`User list failed (${res.status})`)
    const json = await res.json()
    const batch = json.users || []
    users.push(...batch)
    if (batch.length < 200) break
  }
  return users
}

async function putAppMetadata(userId, meta) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
    },
    body: JSON.stringify({ app_metadata: meta }),
  })
  if (!res.ok) throw new Error(`Metadata update failed (${res.status}): ${await res.text()}`)
}

exports.handler = async () => {
  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error('[trial-expiry] Supabase env vars not set — skipping run')
    return { statusCode: 500, body: 'env not set' }
  }

  const now = Date.now()
  let expired = 0, warned = 0, errors = 0

  let users
  try { users = await listAllUsers() } catch (err) {
    console.error('[trial-expiry] failed to list users:', err.message)
    return { statusCode: 500, body: 'list failed' }
  }

  for (const user of users) {
    const meta = user.app_metadata || {}
    if (!meta.trial_plan || !meta.trial_ends_at) continue

    const endsAt = Date.parse(meta.trial_ends_at)
    if (!Number.isFinite(endsAt)) continue

    const planLabel = PLAN_LABEL[meta.trial_plan] || meta.trial_plan
    const paidPlan  = meta.plan && meta.plan !== 'scout' ? meta.plan : null

    try {
      if (endsAt <= now) {
        // ── Expired: clear trial fields → resolver demotes to paid plan or Scout
        const newMeta = { ...meta }
        delete newMeta.trial_plan
        delete newMeta.trial_bracket
        delete newMeta.trial_started_at
        delete newMeta.trial_ends_at
        delete newMeta.trial_granted_by
        delete newMeta.trial_warning_sent
        await putAppMetadata(user.id, newMeta)
        expired++
        console.log(`[trial-expiry] expired ${planLabel} trial for ${user.email}`)

        sendEmail({
          to: user.email,
          subject: 'Your Badger Board trial has ended',
          title: 'Your trial has ended',
          preheader: 'Your data is safe — pick a plan to keep the full toolkit.',
          body: `<p>Your free trial of the <strong>${planLabel}</strong> plan has ended. Your account is now on ${paidPlan ? 'your regular plan' : 'the free Scout plan'}, and every candidate, profile, and list you built is safe.</p>
                 <p>Keep the momentum going — pick up right where you left off.</p>`,
          ctaText: 'Choose your plan',
          ctaUrl: 'https://badgerboardwi.com/plans',
        }).catch(() => {})

      } else if (endsAt - now <= WARNING_WINDOW_MS && !meta.trial_warning_sent) {
        // ── Ending soon: one-time warning email
        const daysLeft = Math.max(1, Math.ceil((endsAt - now) / 86400000))
        await putAppMetadata(user.id, { ...meta, trial_warning_sent: true })
        warned++
        console.log(`[trial-expiry] warned ${user.email} — ${daysLeft}d left on ${planLabel} trial`)

        sendEmail({
          to: user.email,
          subject: `Your Badger Board trial ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`,
          title: `${daysLeft} day${daysLeft === 1 ? '' : 's'} left on your trial`,
          preheader: 'Lock in your plan before your access changes.',
          body: `<p>Your free <strong>${planLabel}</strong> trial ends on <strong>${new Date(endsAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}</strong>.</p>
                 <p>After that your account moves to ${paidPlan ? 'your regular plan' : 'the free Scout plan'}. Your data stays safe either way — but if you want to keep the full toolkit, now's the time to pick a plan.</p>`,
          ctaText: 'Keep my access',
          ctaUrl: 'https://badgerboardwi.com/plans',
        }).catch(() => {})
      }
    } catch (err) {
      errors++
      console.error(`[trial-expiry] failed for ${user.email}:`, err.message)
    }
  }

  console.log(`[trial-expiry] done — expired: ${expired}, warned: ${warned}, errors: ${errors}, scanned: ${users.length}`)
  return { statusCode: 200, body: JSON.stringify({ expired, warned, errors, scanned: users.length }) }
}
