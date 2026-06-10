// netlify/functions/manage-coupons.js
// Admin-only function for creating and listing Stripe coupons + promo codes.
//
// POST /manage-coupons  { action: 'create', ...params }  → create promo code
// POST /manage-coupons  { action: 'list' }               → list promo codes
// POST /manage-coupons  { action: 'deactivate', id }     → deactivate promo code
//
// Requires admin JWT.

import Stripe from 'stripe'
import { ADMIN_EMAILS } from './_config.js'

const SUPABASE_URL  = process.env.SUPABASE_URL  || process.env.VITE_SUPABASE_URL
const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY

function sanitize(str, maxLen = 200) {
  if (str == null) return ''
  return String(str).replace(/[<>"'`]/g, '').trim().slice(0, maxLen)
}

async function verifyAdmin(authHeader) {
  if (!authHeader?.startsWith('Bearer ')) return null
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON, Authorization: authHeader },
  })
  if (!res.ok) return null
  const user = await res.json()
  if (!ADMIN_EMAILS.includes(user?.email?.toLowerCase())) return null
  return user
}

// Generates a clean random promo code like "BB-X7K9-FREE"
function randomCode(prefix = 'BB') {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const seg = (n) => Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
  return `${prefix}-${seg(4)}-${seg(4)}`
}

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) }
  }

  const authHeader = event.headers?.authorization || event.headers?.Authorization
  const admin = await verifyAdmin(authHeader)
  if (!admin) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Admin access required' }) }
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)

  let body
  try { body = JSON.parse(event.body || '{}') } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }
  }

  const action = sanitize(body.action)

  // ── LIST ─────────────────────────────────────────────────────────────────────
  if (action === 'list') {
    try {
      const promoCodes = await stripe.promotionCodes.list({
        limit: 100,
        expand: ['data.promotion.coupon'],
      })

      const result = promoCodes.data.map(pc => {
        // Stripe v20 API: coupon data lives under pc.promotion.coupon (expanded object)
        const c = pc.promotion?.coupon
        return {
        id:           pc.id,
        code:         pc.code,
        active:       pc.active,
        couponId:     c?.id,
        couponName:   c?.name || c?.id,
        discountType: c?.percent_off != null ? 'percent' : 'amount',
        percentOff:   c?.percent_off,
        amountOff:    c?.amount_off != null ? c.amount_off / 100 : null,
        currency:     c?.currency,
        duration:     c?.duration,
        maxRedemptions: pc.max_redemptions,
        timesRedeemed:  pc.times_redeemed,
        expiresAt:    pc.expires_at ? new Date(pc.expires_at * 1000).toISOString() : null,
        createdAt:    new Date(pc.created * 1000).toISOString(),
        }
      })

      return { statusCode: 200, body: JSON.stringify({ success: true, promoCodes: result }) }
    } catch (err) {
      console.error('manage-coupons list error:', err.message)
      return { statusCode: 500, body: JSON.stringify({ error: err.message }) }
    }
  }

  // ── CREATE ───────────────────────────────────────────────────────────────────
  if (action === 'create') {
    const discountType    = sanitize(body.discountType) // 'free' | 'percent' | 'amount'
    const percentOff      = Number(body.percentOff) || 0
    const amountOff       = Number(body.amountOff) || 0     // in dollars
    const customCode      = sanitize(body.code, 50).toUpperCase().replace(/\s/g, '-')
    const maxRedemptions  = Number(body.maxRedemptions) || null
    const expiresAt       = body.expiresAt ? Math.floor(new Date(body.expiresAt).getTime() / 1000) : undefined
    const duration        = sanitize(body.duration) || 'once'  // once | repeating | forever
    const durationMonths  = duration === 'repeating' ? (Number(body.durationMonths) || 3) : undefined
    const couponName      = sanitize(body.name || '', 100)

    try {
      // Build coupon params
      const couponParams = {
        duration,
        ...(durationMonths ? { duration_in_months: durationMonths } : {}),
        ...(couponName ? { name: couponName } : {}),
      }

      if (discountType === 'free') {
        couponParams.percent_off = 100
        couponParams.name = couponName || 'Free Access'
      } else if (discountType === 'percent') {
        if (percentOff <= 0 || percentOff > 100) {
          return { statusCode: 400, body: JSON.stringify({ error: 'percent_off must be between 1 and 100' }) }
        }
        couponParams.percent_off = percentOff
      } else if (discountType === 'amount') {
        if (amountOff <= 0) {
          return { statusCode: 400, body: JSON.stringify({ error: 'amount_off must be greater than 0' }) }
        }
        couponParams.amount_off = Math.round(amountOff * 100)  // convert to cents
        couponParams.currency = 'usd'
      } else {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid discountType. Use free, percent, or amount.' }) }
      }

      const coupon = await stripe.coupons.create(couponParams)

      // Build promo code params — Stripe v20 API uses promotion object
      const promoParams = {
        promotion: { type: 'coupon', coupon: coupon.id },
        code:      customCode || randomCode(),
      }
      if (maxRedemptions) promoParams.max_redemptions = maxRedemptions
      if (expiresAt) promoParams.expires_at = expiresAt

      const promoCode = await stripe.promotionCodes.create(promoParams)

      const discountLabel = discountType === 'free'
        ? '100% off (free)'
        : discountType === 'percent'
          ? `${percentOff}% off`
          : `$${amountOff.toFixed(2)} off`

      console.log(`Admin ${admin.email} created promo code ${promoCode.code} — ${discountLabel}`)

      return {
        statusCode: 200,
        body: JSON.stringify({
          success: true,
          code: promoCode.code,
          couponId: coupon.id,
          promoCodeId: promoCode.id,
          discountLabel,
          duration: coupon.duration,
          maxRedemptions: promoCode.max_redemptions,
          expiresAt: promoCode.expires_at
            ? new Date(promoCode.expires_at * 1000).toISOString()
            : null,
        }),
      }
    } catch (err) {
      console.error('manage-coupons create error:', err.message)
      return { statusCode: 500, body: JSON.stringify({ error: err.message }) }
    }
  }

  // ── DEACTIVATE ───────────────────────────────────────────────────────────────
  if (action === 'deactivate') {
    const promoCodeId = sanitize(body.id, 100)
    if (!promoCodeId) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Promo code ID required' }) }
    }
    try {
      await stripe.promotionCodes.update(promoCodeId, { active: false })
      console.log(`Admin ${admin.email} deactivated promo code ${promoCodeId}`)
      return { statusCode: 200, body: JSON.stringify({ success: true }) }
    } catch (err) {
      console.error('manage-coupons deactivate error:', err.message)
      return { statusCode: 500, body: JSON.stringify({ error: err.message }) }
    }
  }

  return { statusCode: 400, body: JSON.stringify({ error: `Unknown action: ${action}` }) }
}
