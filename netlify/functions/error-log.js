export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const {
      error_message,
      error_stack,
      component,
      url,
      user_id,
      user_agent,
      metadata,
    } = body;

    // Silently ignore if no error_message
    if (!error_message) {
      return { statusCode: 200, body: JSON.stringify({ logged: true }) };
    }

    const payload = {
      error_message,
      error_stack: error_stack || null,
      component: component || null,
      url: url || null,
      user_id: user_id || null,
      user_agent: user_agent || null,
      metadata: metadata || null,
      created_at: new Date().toISOString(),
      resolved: false,
    };

    const insertRes = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/error_logs`,
      {
        method: 'POST',
        headers: {
          apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
        },
        body: JSON.stringify(payload),
      }
    );

    if (!insertRes.ok) {
      console.error('Failed to log error:', await insertRes.text());
    }
  } catch (err) {
    console.error('Error logging error:', err);
  }

  // Always return 200 so this doesn't break the app
  return { statusCode: 200, body: JSON.stringify({ logged: true }) };
};
