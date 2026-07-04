// Campaign Connect — link management: invite / accept / decline / revoke / list / permissions.
const H = require('./_campaign-connect')
const enc = encodeURIComponent
const crypto = require('crypto')

// Human-friendly connect code — 8 chars, no ambiguous 0/O/1/I/L
function genCode() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
  let c = ''
  const bytes = crypto.randomBytes(8)
  for (let i = 0; i < 8; i++) c += alphabet[bytes[i] % alphabet.length]
  return c.slice(0, 4) + '-' + c.slice(4)
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: H.CORS, body: '' }
  if (event.httpMethod !== 'POST')  return { statusCode: 405, headers: H.CORS, body: JSON.stringify({ error: 'POST only' }) }

  const user = await H.verifyUser(event.headers?.authorization || event.headers?.Authorization)
  if (!user) return { statusCode: 401, headers: H.CORS, body: JSON.stringify({ error: 'Not authenticated' }) }

  let body; try { body = JSON.parse(event.body || '{}') } catch { return { statusCode: 400, headers: H.CORS, body: JSON.stringify({ error: 'Invalid JSON' }) } }
  const { action } = body
  const reply = (obj, code = 200) => ({ statusCode: code, headers: H.CORS, body: JSON.stringify(obj) })

  try {
    switch (action) {
      // ── Action account invites a candidate (by email) ──────────────────────
      case 'invite': {
        if (!H.isActionUser(user)) return reply({ error: 'Only Action-plan accounts can invite candidates.' }, 403)
        const email = String(body.email || '').trim().toLowerCase()
        const relationship_type = body.relationship_type === 'outside' ? 'outside' : 'team'
        if (!email || !/^[^@]+@[^@]+\.[^@]+$/.test(email)) return reply({ error: 'Valid candidate email required.' }, 400)
        if (email === user.email?.toLowerCase()) return reply({ error: "You can't invite yourself." }, 400)

        // de-dupe against an existing open link
        const { data: existing } = await H.sb(`account_links?action_user_id=eq.${user.id}&candidate_email=eq.${encodeURIComponent(email)}&status=in.(invited,active)&select=id,status`)
        if (Array.isArray(existing) && existing[0]) return reply({ error: `You already have a pending or active link with ${email}.` }, 409)

        const invitee = await H.findUserByEmail(email)
        // unique connect code (retry a few times on the rare collision)
        let code = genCode()
        for (let i = 0; i < 5; i++) {
          const { data: clash } = await H.sb(`account_links?invite_code=eq.${enc(code)}&select=id`)
          if (!Array.isArray(clash) || !clash.length) break
          code = genCode()
        }
        const ins = await H.sb('account_links', 'POST', {
          action_user_id: user.id,
          candidate_email: email,
          candidate_user_id: invitee?.id || null,
          relationship_type,
          status: 'invited',
          permissions: H.DEFAULT_PERMS,
          invite_code: code,
        })
        if (!ins.ok) return reply({ error: 'Could not create invite.' }, 500)
        const link = ins.data[0]
        await H.logActivity(link.id, user.id, invitee?.id || null, 'invite_sent', { email, relationship_type })
        return reply({ ok: true, link, invitee_has_account: !!invitee })
      }

      // ── Candidate lists their pending invites (matched by email) ────────────
      case 'my_invites': {
        const email = user.email?.toLowerCase()
        const { data } = await H.sb(`account_links?candidate_email=eq.${encodeURIComponent(email)}&status=eq.invited&select=*`)
        // attach inviter email for display
        const links = Array.isArray(data) ? data : []
        for (const l of links) {
          const inv = await H.sb(`account_links?id=eq.${l.id}&select=action_user_id`)
          l.inviter_email = null
        }
        return reply({ ok: true, invites: links })
      }

      // ── Candidate accepts an invite ─────────────────────────────────────────
      case 'accept': {
        if (!H.isPaidCandidate(user)) return reply({ error: 'Campaign Connect for candidates requires a paid plan. Upgrade from Scout to accept a manager.' , upgrade: true }, 402)
        const { link_id } = body
        const { data: rows } = await H.sb(`account_links?id=eq.${enc(link_id)}&select=*`)
        const link = rows?.[0]
        if (!link) return reply({ error: 'Invite not found.' }, 404)
        if (link.candidate_email?.toLowerCase() !== user.email?.toLowerCase()) return reply({ error: 'This invite is for a different email.' }, 403)
        if (link.status !== 'invited') return reply({ error: `Invite is already ${link.status}.` }, 409)
        const upd = await H.sb(`account_links?id=eq.${enc(link_id)}`, 'PATCH', { status: 'active', candidate_user_id: user.id, accepted_at: new Date().toISOString() })
        if (!upd.ok) return reply({ error: 'Could not accept.' }, 500)
        await H.logActivity(link_id, user.id, user.id, 'invite_accepted', null)
        return reply({ ok: true, link: upd.data[0] })
      }

      // ── Candidate redeems a connect code → instant link ─────────────────────
      case 'redeem': {
        if (!H.isPaidCandidate(user)) return reply({ error: 'Campaign Connect for candidates requires a paid plan. Upgrade from Scout to connect.', upgrade: true }, 402)
        const raw = String(body.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
        if (raw.length !== 8) return reply({ error: 'Enter a valid 8-character connect code.' }, 400)
        const code = raw.slice(0, 4) + '-' + raw.slice(4)
        const { data: rows } = await H.sb(`account_links?invite_code=eq.${enc(code)}&select=*`)
        const link = rows?.[0]
        if (!link) return reply({ error: 'That connect code was not found.' }, 404)
        if (link.status === 'active') return reply({ error: 'That code has already been used.' }, 409)
        if (link.status !== 'invited') return reply({ error: `This invite is ${link.status}.` }, 409)
        if (link.action_user_id === user.id) return reply({ error: "You can't redeem your own invite." }, 400)
        const upd = await H.sb(`account_links?id=eq.${link.id}`, 'PATCH', {
          status: 'active', candidate_user_id: user.id, candidate_email: user.email?.toLowerCase(), accepted_at: new Date().toISOString(),
        })
        if (!upd.ok) return reply({ error: 'Could not connect.' }, 500)
        await H.logActivity(link.id, user.id, user.id, 'code_redeemed', { code })
        return reply({ ok: true, link: upd.data[0] })
      }

      // ── Candidate declines ──────────────────────────────────────────────────
      case 'decline': {
        const { link_id } = body
        const { data: rows } = await H.sb(`account_links?id=eq.${enc(link_id)}&select=*`)
        const link = rows?.[0]
        if (!link || link.candidate_email?.toLowerCase() !== user.email?.toLowerCase()) return reply({ error: 'Invite not found.' }, 404)
        await H.sb(`account_links?id=eq.${enc(link_id)}`, 'PATCH', { status: 'declined' })
        await H.logActivity(link_id, user.id, user.id, 'invite_declined', null)
        return reply({ ok: true })
      }

      // ── Revoke (either party) ───────────────────────────────────────────────
      case 'revoke': {
        const { link_id } = body
        const { data: rows } = await H.sb(`account_links?id=eq.${enc(link_id)}&select=*`)
        const link = rows?.[0]
        if (!link) return reply({ error: 'Link not found.' }, 404)
        const isParty = [link.action_user_id, link.candidate_user_id].includes(user.id)
        if (!isParty) return reply({ error: 'Not authorized.' }, 403)
        await H.sb(`account_links?id=eq.${enc(link_id)}`, 'PATCH', { status: 'revoked', revoked_at: new Date().toISOString() })
        await H.logActivity(link_id, user.id, link.candidate_user_id, 'link_revoked', { by: user.id === link.candidate_user_id ? 'candidate' : 'action' })
        return reply({ ok: true })
      }

      // ── Action lists their linked candidates ────────────────────────────────
      case 'my_links': {
        const { data } = await H.sb(`account_links?action_user_id=eq.${user.id}&status=in.(invited,active)&select=*&order=created_at.desc`)
        return reply({ ok: true, links: Array.isArray(data) ? data : [] })
      }

      // ── Candidate lists managers connected to them ──────────────────────────
      case 'my_managers': {
        const { data } = await H.sb(`account_links?candidate_user_id=eq.${user.id}&status=eq.active&select=*&order=created_at.desc`)
        return reply({ ok: true, managers: Array.isArray(data) ? data : [] })
      }

      // ── Update per-link permissions (Action owner only) ─────────────────────
      case 'set_permissions': {
        const { link_id, permissions } = body
        const { data: rows } = await H.sb(`account_links?id=eq.${enc(link_id)}&select=*`)
        const link = rows?.[0]
        if (!link || link.action_user_id !== user.id) return reply({ error: 'Not authorized.' }, 403)
        const merged = { ...H.DEFAULT_PERMS, ...(link.permissions || {}), ...(permissions || {}) }
        await H.sb(`account_links?id=eq.${enc(link_id)}`, 'PATCH', { permissions: merged })
        await H.logActivity(link_id, user.id, link.candidate_user_id, 'permissions_updated', merged)
        return reply({ ok: true, permissions: merged })
      }

      default:
        return reply({ error: 'Unknown action.' }, 400)
    }
  } catch (e) {
    console.error('[campaign-connect]', e)
    return reply({ error: 'Server error: ' + e.message }, 500)
  }
}
