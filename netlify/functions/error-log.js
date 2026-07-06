// error-log.js — records client-side errors.
// Contract (see tests/full.test.js Suite 15):
//   - POST is accepted WITHOUT authentication (pre-auth / login-page errors
//     must be reportable) and always returns 200 {logged:true}.
//   - A POST missing error_message is silently ignored (200, no DB write).
//   - GET → 405.
// Hardening kept from the earlier pass:
//   - user_id comes ONLY from a verified JWT when one is supplied — never from
//     the request body — so attribution cannot be spoofed.
//   - All stored fields are length-clipped.
//   - Best-effort per-IP flood guard: anonymous bursts are silently dropped
//     (still 200 — this is a fire-and-forget log endpoint).

const FLOOD_BUCKET = new Map()
function floodGuard(ip, max = 10, windowMs = 60000) {
  const now = Date.now()
  const recent = (FLOOD_BUCKET.get(ip) || []).filter(t => now - t < windowMs)
  recent.push(now)
  if (FLOOD_BUCKET.size > 5000) FLOOD_BUCKET.clear() // cap memory
  FLOOD_BUCKET.set(ip, recent)
  return recent.length > max
}

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

  // ── Optional auth: attribute the log to a user only if the token verifies ──
  // (Unauthenticated posts are accepted — pre-auth errors must be loggable.)
  let userId = null;
  const authHeader = event.headers?.authorization || event.headers?.Authorization;
  if (authHeader?.startsWith('Bearer ')) {
    try {
      const authRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${authHeader.slice(7)}` },
      });
      if (authRes.ok) userId = (await authRes.json())?.id || null;
    } catch { /* unattributed */ }
  }

  // Best-effort flood guard — silently drop (still 200) on anonymous bursts.
  const ip = event.headers?.['x-nf-client-connection-ip']
    || (event.headers?.['x-forwarded-for'] || '').split(',')[0].trim()
    || 'unknown';
  if (!userId && floodGuard(ip)) {
    return { statusCode: 200, body: JSON.stringify({ logged: true }) };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const { error_message, error_stack, component, url, user_agent, metadata } = body;

    if (!error_message) {
      return { statusCode: 200, body: JSON.stringify({ logged: true }) };
    }

    // Trim to guard against oversized stored payloads (and stored-XSS surface
    // in the admin viewer). user_id comes from the token, not the body.
    const clip = (v, n) => (typeof v === 'string' ? v.slice(0, n) : null);
    const payload = {
      error_message: clip(error_message, 2000),
      error_stack:   clip(error_stack, 8000),
      component:     clip(component, 200),
      url:           clip(url, 500),
      user_id:       userId,
      user_agent:    clip(user_agent, 500),
      metadata:      metadata && typeof metadata === 'object' ? metadata : null,
      created_at:    new Date().toISOString(),
      resolved:      false,
    };

    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/error_logs`, {
      method: 'POST',
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(payload),
    });
    if (!insertRes.ok) console.error('Failed to log error:', await insertRes.text());
  } catch (err) {
    console.error('Error logging error:', err);
  }

  return { statusCode: 200, body: JSON.stringify({ logged: true }) };
};
