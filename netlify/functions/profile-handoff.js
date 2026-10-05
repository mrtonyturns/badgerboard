// Campaign Connect — 48h profile handoff (Action pushes a completed profile to a candidate).
// Expiry adjustable 30 minutes → 7 days. Expiry hides the profile from the candidate;
// the underlying dossier is NEVER deleted.
const H = require('./_campaign-connect')
const enc = encodeURIComponent

const MIN_MS = 30 * 60 * 1000
const MAX_MS = 7 * 24 * 3600 * 1000
const DEFAULT_MS = 48 * 3600 * 1000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// A handoff is only viewable while it is active, unexpired AND its Campaign
// Connect link is still active: revoking the link (either party) must cut off
// every profile shared over it. link_id goes NULL when the link row is
// deleted, which counts as revoked too.
const isLive = (h, now) => h.status === 'active' && Number.isFinite(Date.parse(h.expires_at)) && Date.parse(h.expires_at) > now
async function activeLinkIds(ids) {
  const list = [...new Set(ids.filter(id => UUID.test(id || '')))]
  if (!list.length) return new Set()
  const { data } = await H.sb(`account_links?id=in.(${list.join(',')})&status=eq.active&select=id`)
  return new Set((Array.isArray(data) ? data : []).map(l => l.id))
}

exports.handler = async (event) => {
  // Per-request CORS — _campaign-connect exports cors(), not a CORS constant;
  // the old H.CORS was undefined, so every response went out with no headers.
  const CORS = H.cors(event)
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' }
  if (event.httpMethod !== 'POST')  return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'POST only' }) }

  const user = await H.verifyUser(event.headers?.authorization || event.headers?.Authorization)
  if (!user) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Not authenticated' }) }

  let body; try { body = JSON.parse(event.body || '{}') } catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) } }
  const { action } = body
  const reply = (obj, code = 200) => ({ statusCode: code, headers: CORS, body: JSON.stringify(obj) })
  const now = Date.now()

  try {
    switch (action) {
      // ── Action sends a profile to a linked candidate ────────────────────────
      case 'send': {
        const { candidate_user_id, dossier_id, expires_ms } = body
        if (!UUID.test(candidate_user_id || '') || !UUID.test(dossier_id || '')) return reply({ error: 'valid candidate_user_id and dossier_id required' }, 400)
        const link = await H.activeLinkFor(user.id, candidate_user_id)
        if (!link) return reply({ error: 'No active link with this candidate.' }, 403)
        const perms = { ...H.DEFAULT_PERMS, ...(link.permissions || {}) }
        if (!perms.receive_profiles) return reply({ error: 'This link does not allow sending profiles.' }, 403)

        // verify the dossier belongs to the sender
        const { data: dr } = await H.sb(`dossiers?id=eq.${enc(dossier_id)}&created_by=eq.${user.id}&select=id,title`)
        const doss = dr?.[0]
        if (!doss) return reply({ error: 'Profile not found or not yours.' }, 404)

        let ms = Number(expires_ms) || DEFAULT_MS
        ms = Math.max(MIN_MS, Math.min(MAX_MS, ms))
        const expires_at = new Date(now + ms).toISOString()

        const ins = await H.sb('profile_handoffs', 'POST', {
          link_id: link.id, from_action_user: user.id, to_candidate_user: candidate_user_id,
          dossier_id, title: doss.title, expires_at, status: 'active',
        })
        if (!ins.ok) return reply({ error: 'Could not send profile.' }, 500)
        await H.logActivity(link.id, user.id, candidate_user_id, 'profile_sent', { dossier_id, expires_at })
        return reply({ ok: true, handoff: ins.data[0] })
      }

      // ── Candidate inbox (active, non-expired) ───────────────────────────────
      case 'inbox': {
        const { data } = await H.sb(`profile_handoffs?to_candidate_user=eq.${user.id}&status=eq.active&select=*&order=created_at.desc`)
        const live = (Array.isArray(data) ? data : []).filter(h => isLive(h, now))
        const links = await activeLinkIds(live.map(h => h.link_id))
        return reply({ ok: true, handoffs: live.filter(h => links.has(h.link_id)) })
      }

      // ── Candidate opens a shared profile (returns dossier content if not expired) ──
      case 'open': {
        const { handoff_id } = body
        if (!UUID.test(handoff_id || '')) return reply({ error: 'Not found.' }, 404)
        const { data } = await H.sb(`profile_handoffs?id=eq.${enc(handoff_id)}&to_candidate_user=eq.${user.id}&select=*`)
        const h = data?.[0]
        if (!h) return reply({ error: 'Not found.' }, 404)
        if (h.status === 'revoked') return reply({ error: 'This shared profile was revoked.' }, 410)
        if (!isLive(h, now)) return reply({ error: 'This shared profile has expired.' }, 410)
        if (!(await activeLinkIds([h.link_id])).has(h.link_id)) return reply({ error: 'This shared profile was revoked.' }, 410)
        const { data: dr } = await H.sb(`dossiers?id=eq.${h.dossier_id}&select=id,title,content,created_at`)
        if (!h.viewed_at) await H.sb(`profile_handoffs?id=eq.${enc(handoff_id)}`, 'PATCH', { viewed_at: new Date().toISOString() })
        return reply({ ok: true, handoff: h, dossier: dr?.[0] || null })
      }

      // ── Action lists what they've sent ──────────────────────────────────────
      case 'sent': {
        const { data } = await H.sb(`profile_handoffs?from_action_user=eq.${user.id}&select=*&order=created_at.desc&limit=100`)
        const rows = (Array.isArray(data) ? data : []).map(h => ({ ...h, expired: new Date(h.expires_at).getTime() <= now }))
        return reply({ ok: true, handoffs: rows })
      }

      // ── Revoke a handoff (sender) ───────────────────────────────────────────
      case 'revoke': {
        const { handoff_id } = body
        if (!UUID.test(handoff_id || '')) return reply({ error: 'Not found.' }, 404)
        const { data } = await H.sb(`profile_handoffs?id=eq.${enc(handoff_id)}&from_action_user=eq.${user.id}&select=id,link_id,to_candidate_user`)
        const h = data?.[0]
        if (!h) return reply({ error: 'Not found.' }, 404)
        const upd = await H.sb(`profile_handoffs?id=eq.${enc(handoff_id)}`, 'PATCH', { status: 'revoked' })
        if (!upd.ok) return reply({ error: 'Could not revoke.' }, 500)
        await H.logActivity(h.link_id, user.id, h.to_candidate_user, 'profile_revoked', { handoff_id })
        return reply({ ok: true })
      }

      default:
        return reply({ error: 'Unknown action.' }, 400)
    }
  } catch (e) {
    console.error('[profile-handoff]', e)
    return reply({ error: 'Server error: ' + e.message }, 500)
  }
}
