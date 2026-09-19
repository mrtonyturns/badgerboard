import { paymentIssueTemplate } from './_email-templates.js';
import { ADMIN_EMAILS } from './_config.js';
import crypto from 'crypto';

// Audit fix (#5): fail CLOSED and compare in constant time. The old check
// (`webhookSecret !== process.env.PAYMENT_WEBHOOK_SECRET`) authorized any
// request with no header whenever the env var was unset (undefined !==
// undefined → false), letting anyone lock/unlock arbitrary accounts.
function secretMatches(provided) {
  const expected = process.env.PAYMENT_WEBHOOK_SECRET;
  if (!expected || !provided) return false;
  const A = crypto.createHash('sha256').update(String(provided)).digest();
  const B = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(A, B);
}

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  if (!secretMatches(event.headers['x-webhook-secret'])) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  try {
    const { user_id, status } = JSON.parse(event.body || '{}');

    if (!user_id || !['past_due', 'active'].includes(status)) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid payload' }) };
    }

    // Get user from Supabase to check if admin and get email
    const userRes = await fetch(
      `${process.env.SUPABASE_URL}/auth/v1/admin/users/${user_id}`,
      {
        headers: {
          apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    if (!userRes.ok) {
      return { statusCode: 404, body: JSON.stringify({ error: 'User not found' }) };
    }

    const user = await userRes.json();
    const userEmail = user.email?.toLowerCase();

    // Skip updating if user is admin
    if (ADMIN_EMAILS.includes(userEmail)) {
      return { statusCode: 200, body: JSON.stringify({ received: true, skipped: true }) };
    }

    // Merge payment_status into APP metadata — app_metadata is service-role
    // only, so users cannot self-set payment_status (user_metadata is
    // user-writable via supabase.auth.updateUser). All readers (AuthContext,
    // tiers.js, admin-dashboard) already read app_metadata.payment_status.
    const updatedMetadata = {
      ...user.app_metadata,
      payment_status: status,
    };

    // Update user metadata in Supabase
    const updateRes = await fetch(
      `${process.env.SUPABASE_URL}/auth/v1/admin/users/${user_id}`,
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

    if (!updateRes.ok) {
      console.error('Failed to update user metadata:', await updateRes.text());
    }

    // Send payment issue email if locking and Resend is configured
    if (status === 'past_due' && process.env.RESEND_API_KEY && !(await require('./_email').isEmailSuppressed(userEmail))) {  // v1.40.0 admin mute
      const settingsUrl = `${process.env.SITE_URL || 'https://www.badgerboardwi.com'}/settings`;
      const emailTemplate = paymentIssueTemplate(settingsUrl);

      try {
        const emailRes = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: 'Badger Board <noreply@noreply.badgerboardwi.com>',   // must match _email.js FROM (verified Resend domain)
            to: userEmail,
            subject: emailTemplate.subject,
            html: emailTemplate.html,
            text: emailTemplate.text,
          }),
        });

        if (!emailRes.ok) {
          console.error('Failed to send payment issue email:', await emailRes.text());
        }
      } catch (emailErr) {
        console.error('Error sending email via Resend:', emailErr);
      }
    }

    return { statusCode: 200, body: JSON.stringify({ received: true }) };
  } catch (err) {
    console.error('Webhook error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};
