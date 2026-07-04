// error-log.js — records client-side errors.
// Hardened: requires a valid Supabase JWT and derives user_id from the verified
// token (never from the request body), preventing anonymous log-flooding and
// spoofed attribution through this service-role-key writer.

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

  // ── Require a verified caller ───────────────────────────────────────────────
  const authHeader = event.headers?.authorization || event.headers?.Authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Not authenticated' }) };
  }
  let userId = null;
  try {
    const authRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${authHeader.slice(7)}` },
    });
    if (!authRes.ok) return { statusCode: 401, body: JSON.stringify({ error: 'Invalid token' }) };
    userId = (await authRes.json())?.id || null;
  } catch {
    return { statusCode: 401, body: JSON.stringify({ error: 'Auth check failed' }) };
  }
  if (!userId) return { statusCode: 401, body: JSON.stringify({ error: 'Invalid token' }) };

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
