import { passwordResetTemplate } from './_email-templates.js';
import { ADMIN_EMAILS } from './_config.js';

// Returns: user object if admin, 'forbidden' if valid token but not admin, null if no/invalid token
async function verifyAdmin(authHeader) {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  const res = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${token}`,
    },
  });
  if (!res.ok) return null;
  const user = await res.json();
  return ADMIN_EMAILS.includes(user?.email?.toLowerCase()) ? user : 'forbidden';
}

async function getAllUsers() {
  // Paginate through all users (Supabase max per_page is 1000)
  const allRaw = [];
  let page = 1;
  while (true) {
    const res = await fetch(
      `${process.env.SUPABASE_URL}/auth/v1/admin/users?per_page=1000&page=${page}`,
      {
        headers: {
          apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );
    if (!res.ok) throw new Error('Failed to fetch users');
    const data = await res.json();
    const batch = data.users || [];
    allRaw.push(...batch);
    // Stop when we get fewer than a full page (no more pages)
    if (batch.length < 1000) break;
    page++;
  }
  return allRaw
    .map((u) => ({
      id: u.id,
      email: u.email,
      created_at: u.created_at,
      last_sign_in_at: u.last_sign_in_at,
      plan: u.app_metadata?.plan || null,
      bracket: u.app_metadata?.bracket || null,
      payment_status: u.app_metadata?.payment_status || null,
      email_confirmed: !!u.email_confirmed_at,
      // v1.18 access layers (trials + beta)
      trial_plan: u.app_metadata?.trial_plan || null,
      trial_bracket: u.app_metadata?.trial_bracket || null,
      trial_ends_at: u.app_metadata?.trial_ends_at || null,
      beta_mode: u.app_metadata?.beta_mode === true,
    }))
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

async function getUserActivity(userId) {
  const res = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/activity_log?user_id=eq.${userId}&order=created_at.desc&limit=50`,
    {
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
    }
  );
  if (!res.ok) return [];
  return await res.json();
}

// ─── AI costs (v1.20 rebuild) ────────────────────────────────────────────────
// Real metering from the ai_usage table (every AI call logs actual token
// counts + computed USD cost via _ai-usage.js). Replaces the old version,
// which read a generation_logs table nothing ever wrote to and padded it
// with hardcoded guesses.
// Self-provision the ai_usage table (admin-gated path only). Uses the
// Supabase management API so the first visit to the AI-costs tab creates the
// table without a manual SQL-editor run.
async function ensureAiUsageTable() {
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  const ref = (process.env.SUPABASE_URL || '').match(/https:\/\/([a-z0-9]+)\.supabase\.co/)?.[1];
  if (!token || !ref) return false;
  const sql = `
    CREATE TABLE IF NOT EXISTS ai_usage (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid,
      endpoint text NOT NULL,
      provider text NOT NULL,
      model text,
      input_tokens integer NOT NULL DEFAULT 0,
      output_tokens integer NOT NULL DEFAULT 0,
      cost_usd numeric(12,6) NOT NULL DEFAULT 0,
      estimated boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_ai_usage_created ON ai_usage (created_at);
    CREATE INDEX IF NOT EXISTS idx_ai_usage_user ON ai_usage (user_id);
    CREATE INDEX IF NOT EXISTS idx_ai_usage_endpoint ON ai_usage (endpoint);
    ALTER TABLE ai_usage ENABLE ROW LEVEL SECURITY;
    NOTIFY pgrst, 'reload schema';`;
  try {
    const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: sql }),
    });
    if (!res.ok) { console.error('[admin] ensureAiUsageTable:', res.status, (await res.text()).slice(0, 200)); return false; }
    return true;
  } catch (e) { console.error('[admin] ensureAiUsageTable:', e.message); return false; }
}

async function getAICosts() {
  const SB = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };
  const since90 = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString();

  // Page through up to 50k rows of the last 90 days
  const rows = [];
  let provisioned = false;
  for (let page = 0; page < 50; page++) {
    let res = await fetch(
      `${SB}/rest/v1/ai_usage?created_at=gte.${since90}&select=user_id,endpoint,provider,model,input_tokens,output_tokens,cost_usd,estimated,created_at&order=created_at.desc&limit=1000&offset=${page * 1000}`,
      { headers: H }
    );
    if (!res.ok && page === 0 && !provisioned) {
      // First run: create the table via the management API, then retry once
      provisioned = await ensureAiUsageTable();
      if (provisioned) {
        await new Promise(r => setTimeout(r, 1500));  // let PostgREST reload its schema
        res = await fetch(
          `${SB}/rest/v1/ai_usage?created_at=gte.${since90}&select=user_id,endpoint,provider,model,input_tokens,output_tokens,cost_usd,estimated,created_at&order=created_at.desc&limit=1000`,
          { headers: H }
        );
      }
    }
    if (!res.ok) {
      if (page === 0) return { tracking: false, error: 'ai_usage table not found — run migration 20260724000001_ai_usage.sql in the Supabase SQL editor' };
      break;
    }
    const batch = await res.json();
    if (!Array.isArray(batch) || !batch.length) break;
    rows.push(...batch);
    if (batch.length < 1000) break;
  }

  const now = Date.now();
  const d30 = now - 30 * 24 * 3600 * 1000;
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);

  const cost = (r) => Number(r.cost_usd) || 0;
  const inWindow = rows.filter(r => new Date(r.created_at).getTime() >= d30);

  const agg = (list, keyFn) => {
    const m = {};
    for (const r of list) {
      const k = keyFn(r) || 'unknown';
      if (!m[k]) m[k] = { key: k, cost: 0, calls: 0, input_tokens: 0, output_tokens: 0, estimated_calls: 0 };
      m[k].cost += cost(r); m[k].calls += 1;
      m[k].input_tokens += r.input_tokens || 0; m[k].output_tokens += r.output_tokens || 0;
      if (r.estimated) m[k].estimated_calls += 1;
    }
    return Object.values(m).sort((a, b) => b.cost - a.cost);
  };

  // Per-user (30d) with emails
  const byUserRaw = agg(inWindow.filter(r => r.user_id), r => r.user_id);
  let emailMap = {};
  try {
    const users = await getAllUsers();
    emailMap = Object.fromEntries(users.map(u => [u.id, u.email]));
  } catch (_) {}
  const by_user = byUserRaw.map(u => ({ ...u, email: emailMap[u.key] || u.key }));
  const systemCost = inWindow.filter(r => !r.user_id).reduce((s, r) => s + cost(r), 0);

  // Daily series (last 30 days)
  const daily = {};
  for (const r of inWindow) {
    const day = String(r.created_at).slice(0, 10);
    daily[day] = (daily[day] || 0) + cost(r);
  }

  const round = (x) => Math.round(x * 10000) / 10000;
  return {
    tracking: true,
    tracked_rows: rows.length,
    totals: {
      last_90d: round(rows.reduce((s, r) => s + cost(r), 0)),
      last_30d: round(inWindow.reduce((s, r) => s + cost(r), 0)),
      month_to_date: round(rows.filter(r => new Date(r.created_at) >= monthStart).reduce((s, r) => s + cost(r), 0)),
      calls_30d: inWindow.length,
      tokens_30d: inWindow.reduce((s, r) => s + (r.input_tokens || 0) + (r.output_tokens || 0), 0),
      system_cost_30d: round(systemCost),
    },
    by_endpoint: agg(inWindow, r => r.endpoint).map(x => ({ ...x, cost: round(x.cost) })),
    by_provider: agg(inWindow, r => r.provider).map(x => ({ ...x, cost: round(x.cost) })),
    by_model:    agg(inWindow, r => r.model).map(x => ({ ...x, cost: round(x.cost) })),
    by_user:     by_user.map(x => ({ ...x, cost: round(x.cost) })),
    daily: Object.entries(daily).sort((a, b) => a[0].localeCompare(b[0])).map(([date, c]) => ({ date, cost: round(c) })),
  };
}

async function updateUser(userId, email, password) {
  const body = {};
  if (email) body.email = email;
  if (password) body.password = password;

  const res = await fetch(
    `${process.env.SUPABASE_URL}/auth/v1/admin/users/${userId}`,
    {
      method: 'PUT',
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }
  );
  if (!res.ok) throw new Error('Failed to update user');
  return { updated: true };
}

async function sendReset(email) {
  // Generate recovery link via Supabase
  const linkRes = await fetch(
    `${process.env.SUPABASE_URL}/auth/v1/admin/generate_link`,
    {
      method: 'POST',
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ type: 'recovery', email }),
    }
  );

  if (!linkRes.ok) {
    throw new Error('Failed to generate recovery link');
  }

  const linkData = await linkRes.json();
  const resetUrl = linkData.properties?.action_link || linkData.action_link;

  // Send email via Resend if configured
  if (process.env.RESEND_API_KEY) {
    const emailTemplate = passwordResetTemplate(resetUrl, email);
    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Badger Board <noreply@badgerboardwi.com>',
        to: email,
        subject: emailTemplate.subject,
        html: emailTemplate.html,
        text: emailTemplate.text,
      }),
    });

    if (!emailRes.ok) {
      console.error('Failed to send email:', await emailRes.text());
    }
  } else {
    // Fallback to Supabase recovery endpoint
    const recoverRes = await fetch(`${process.env.SUPABASE_URL}/auth/v1/recover`, {
      method: 'POST',
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email }),
    });

    if (!recoverRes.ok) {
      throw new Error('Failed to send recovery email');
    }
  }

  return { sent: true };
}

async function togglePayment(userId, lock) {
  const res = await fetch(
    `${process.env.SUPABASE_URL}/auth/v1/admin/users/${userId}`,
    {
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    }
  );
  if (!res.ok) throw new Error('Failed to fetch user');
  const user = await res.json();

  // Audit fix (#19): payment_status must live in APP metadata — every reader
  // (AuthContext, tiers.js, payment-webhook, stripe-webhook) checks
  // app_metadata.payment_status. The old user_metadata write made admin
  // lock/unlock a silent no-op, and user_metadata is end-user writable anyway.
  const updatedMetadata = {
    ...user.app_metadata,
    payment_status: lock ? 'past_due' : 'active',
  };

  const updateRes = await fetch(
    `${process.env.SUPABASE_URL}/auth/v1/admin/users/${userId}`,
    {
      method: 'PUT',
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ app_metadata: updatedMetadata }),
    }
  );
  if (!updateRes.ok) throw new Error('Failed to update payment status');
  return { updated: true };
}

async function addNote(userId, note, createdBy) {
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/account_notes`, {
    method: 'POST',
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify({
      user_id: userId,
      note,
      created_by: createdBy,
      created_at: new Date().toISOString(),
    }),
  });
  if (!res.ok) throw new Error('Failed to add note');
  return { created: true };
}

async function getNotes(userId) {
  const res = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/account_notes?user_id=eq.${userId}&order=created_at.desc`,
    {
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
    }
  );
  if (!res.ok) return [];
  return await res.json();
}

async function getAnnouncements() {
  const res = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/announcements?order=created_at.desc`,
    {
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
    }
  );
  if (!res.ok) return [];
  return await res.json();
}

// v1.20: announcements may carry limited formatting HTML. Server-side
// whitelist (defense in depth alongside DOMPurify on the client): only
// b/strong/i/em/u/br/div/p tags survive, all attributes stripped.
function sanitizeAnnouncementMessage(html) {
  return String(html || '')
    .replace(/<(?!\/?(?:b|strong|i|em|u|br|div|p)\b)[^>]*>/gi, '')  // drop non-whitelisted tags
    .replace(/<(\/?)(b|strong|i|em|u|br|div|p)\b[^>]*>/gi, '<$1$2>') // strip attributes
    .slice(0, 4000);
}

async function createAnnouncement(message, type, createdBy) {
  message = sanitizeAnnouncementMessage(message);
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/announcements`, {
    method: 'POST',
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify({
      message,
      type,
      created_by: createdBy,
      is_active: true,
      created_at: new Date().toISOString(),
    }),
  });
  if (!res.ok) throw new Error('Failed to create announcement');
  const results = await res.json();
  return results[0] || {};
}

async function updateAnnouncement(id, updates) {
  const res = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/announcements?id=eq.${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(updates),
    }
  );
  if (!res.ok) throw new Error('Failed to update announcement');
  return { updated: true };
}

async function deleteAnnouncement(id) {
  const res = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/announcements?id=eq.${encodeURIComponent(id)}`,
    {
      method: 'DELETE',
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
    }
  );
  if (!res.ok) throw new Error('Failed to delete announcement');
  return { deleted: true };
}

async function getErrorLogs(showResolved = false) {
  let query = `${process.env.SUPABASE_URL}/rest/v1/error_logs?select=id,error_message,error_stack,component,url,user_id,user_agent,metadata,created_at,resolved`;
  if (!showResolved) {
    query += '&resolved=eq.false';
  }
  query += '&order=created_at.desc&limit=1000';

  const res = await fetch(query, {
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) return [];
  const logs = await res.json();
  if (!Array.isArray(logs)) return [];

  // Enrich with user email where possible
  const userIds = [...new Set(logs.filter(l => l.user_id).map(l => l.user_id))];
  const userEmailMap = {};
  if (userIds.length > 0) {
    try {
      const usersRes = await fetch(`${process.env.SUPABASE_URL}/auth/v1/admin/users?per_page=500`, {
        headers: {
          apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        },
      });
      if (usersRes.ok) {
        const usersData = await usersRes.json();
        for (const u of (usersData.users || [])) {
          if (userIds.includes(u.id)) userEmailMap[u.id] = u.email;
        }
      }
    } catch (_) {}
  }

  return logs.map(l => ({
    ...l,
    user_email: l.user_id ? (userEmailMap[l.user_id] || l.user_id) : null,
  }));
}

async function resolveError(id) {
  const res = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/error_logs?id=eq.${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ resolved: true }),
    }
  );
  if (!res.ok) throw new Error('Failed to resolve error');
  return { resolved: true };
}

async function getSignupTrends() {
  const users = await getAllUsers();
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const dateMap = {};
  for (const user of users) {
    const createdAt = new Date(user.created_at);
    if (createdAt >= thirtyDaysAgo) {
      const dateStr = createdAt.toISOString().split('T')[0];
      dateMap[dateStr] = (dateMap[dateStr] || 0) + 1;
    }
  }

  const trends = Object.entries(dateMap)
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return trends;
}

async function impersonate(email) {
  const linkRes = await fetch(
    `${process.env.SUPABASE_URL}/auth/v1/admin/generate_link`,
    {
      method: 'POST',
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ type: 'magiclink', email }),
    }
  );
  if (!linkRes.ok) throw new Error('Failed to generate magic link');
  const linkData = await linkRes.json();
  const link = linkData.properties?.action_link || linkData.action_link;
  return { link };
}

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const admin = await verifyAdmin(event.headers.authorization);
  if (admin === 'forbidden') {
    return { statusCode: 403, body: JSON.stringify({ error: 'Forbidden — admin only' }) };
  }
  if (!admin) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  try {
    const { action, ...params } = JSON.parse(event.body || '{}');

    switch (action) {
      case 'users': {
        const users = await getAllUsers();
        return { statusCode: 200, body: JSON.stringify({ users }) };
      }

      case 'user_activity': {
        const activity = await getUserActivity(params.user_id);
        return { statusCode: 200, body: JSON.stringify({ activity }) };
      }

      case 'ai_costs': {
        const costs = await getAICosts();
        return { statusCode: 200, body: JSON.stringify(costs) };
      }

      case 'update_user': {
        const result = await updateUser(params.user_id, params.email, params.password);
        return { statusCode: 200, body: JSON.stringify(result) };
      }

      case 'send_reset': {
        const result = await sendReset(params.email);
        return { statusCode: 200, body: JSON.stringify(result) };
      }

      case 'toggle_payment': {
        const result = await togglePayment(params.user_id, params.lock);
        return { statusCode: 200, body: JSON.stringify(result) };
      }

      case 'add_note': {
        const result = await addNote(params.user_id, params.note, params.created_by || admin.email);
        return { statusCode: 200, body: JSON.stringify(result) };
      }

      case 'get_notes': {
        const notes = await getNotes(params.user_id);
        return { statusCode: 200, body: JSON.stringify({ notes }) };
      }

      case 'announcements': {
        const announcements = await getAnnouncements();
        return { statusCode: 200, body: JSON.stringify({ announcements }) };
      }

      case 'create_announcement': {
        const announcement = await createAnnouncement(
          params.message,
          params.type,
          params.created_by || admin.email
        );
        return { statusCode: 200, body: JSON.stringify({ announcement }) };
      }

      case 'update_announcement': {
        const updates = {};
        if ('is_active' in params) updates.is_active = params.is_active;
        if ('message' in params) updates.message = params.message;
        if ('type' in params) updates.type = params.type;
        const result = await updateAnnouncement(params.id, updates);
        return { statusCode: 200, body: JSON.stringify(result) };
      }

      case 'delete_announcement': {
        const result = await deleteAnnouncement(params.id);
        return { statusCode: 200, body: JSON.stringify(result) };
      }

      case 'error_logs': {
        const logs = await getErrorLogs(params.show_resolved || false);
        return { statusCode: 200, body: JSON.stringify({ logs }) };
      }

      case 'resolve_error': {
        const errorId = params.id || params.error_id;
        if (!errorId) return { statusCode: 400, body: JSON.stringify({ error: 'id required' }) };
        const result = await resolveError(errorId);
        return { statusCode: 200, body: JSON.stringify(result) };
      }

      case 'signup_trends': {
        const trends = await getSignupTrends();
        return { statusCode: 200, body: JSON.stringify({ trends }) };
      }

      case 'impersonate': {
        const result = await impersonate(params.email);
        return { statusCode: 200, body: JSON.stringify(result) };
      }

      default:
        return { statusCode: 400, body: JSON.stringify({ error: 'Unknown action' }) };
    }
  } catch (err) {
    console.error('Admin dashboard error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'An internal error occurred' }) };
  }
};
