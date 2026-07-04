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

async function getAICosts() {
  // Pricing per million tokens (Anthropic published rates as of 2025)
  const pricingMap = {
    'claude-sonnet-5':          { input: 3.00,  output: 15.00 },
    'claude-opus-4-8':          { input: 5.00,  output: 25.00 },
    'claude-sonnet-4-6':        { input: 3.00,  output: 15.00 },
    'claude-sonnet-4':          { input: 3.00,  output: 15.00 },
    'claude-sonnet':            { input: 3.00,  output: 15.00 },
    'claude-haiku-4-5-20251001':{ input: 0.80,  output: 4.00  },
    'claude-haiku-4-5':         { input: 0.80,  output: 4.00  },
    'claude-haiku':             { input: 0.25,  output: 1.25  },
  };

  // Fixed monthly baseline estimates (Perplexity + background jobs)
  const fixedEstimates = [
    { label: 'Perplexity — News Research',   estimated_cost: 3.20, count: null, model: 'perplexity/sonar', note: 'Per-dossier web search calls' },
    { label: 'Perplexity — Social Media',    estimated_cost: 1.80, count: null, model: 'perplexity/sonar', note: 'Per-dossier social media search' },
    { label: 'Weekly Auto-Refresh',          estimated_cost: 2.50, count: null, model: 'claude-opus-4-8', note: 'Monday auto-regeneration job' },
    { label: 'Election Night Sync',          estimated_cost: 0.40, count: null, model: 'claude-opus-4-8', note: 'Real-time result ingestion' },
  ];

  const categoryMap = {};

  try {
    const res = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/generation_logs?select=model,content_length,created_at,action_type&limit=5000`,
      {
        headers: {
          apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    if (res.ok) {
      const logs = await res.json();
      if (Array.isArray(logs)) {
        for (const log of logs) {
          const model = log.model || 'unknown';
          const actionType = log.action_type || 'other';
          const contentLength = log.content_length || 0;
          // Rough estimate: input tokens ≈ contentLength/4, output ≈ 30% of that
          const inputTokens  = Math.ceil(contentLength / 4);
          const outputTokens = Math.ceil(inputTokens * 0.3);

          const pricing = pricingMap[model] || { input: 3.00, output: 15.00 };
          const estimatedCost =
            ((inputTokens  * pricing.input)  / 1_000_000) +
            ((outputTokens * pricing.output) / 1_000_000);

          const key = `${actionType}::${model}`;
          if (!categoryMap[key]) {
            categoryMap[key] = {
              label: actionType.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
              model,
              estimated_cost: 0,
              count: 0,
              note: `Model: ${model}`,
            };
          }
          categoryMap[key].estimated_cost += estimatedCost;
          categoryMap[key].count += 1;
        }
      }
    }
  } catch (e) {
    console.warn('[admin] generation_logs unavailable:', e.message);
  }

  const dynamicCategories = Object.values(categoryMap);
  const allCategories = [...dynamicCategories, ...fixedEstimates];
  const total = allCategories.reduce((sum, cat) => sum + cat.estimated_cost, 0);

  return { total, categories: allCategories };
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

  const updatedMetadata = {
    ...user.user_metadata,
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
      body: JSON.stringify({ user_metadata: updatedMetadata }),
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

async function createAnnouncement(message, type, createdBy) {
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
    `${process.env.SUPABASE_URL}/rest/v1/announcements?id=eq.${id}`,
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
    `${process.env.SUPABASE_URL}/rest/v1/announcements?id=eq.${id}`,
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
    `${process.env.SUPABASE_URL}/rest/v1/error_logs?id=eq.${id}`,
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
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
