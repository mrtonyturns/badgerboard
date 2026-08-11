// netlify/functions/_email.js
// Shared Resend email helper — imported by all Netlify functions that send email.

const RESEND_API_KEY = process.env.RESEND_API_KEY
const FROM = 'Badger Board <noreply@noreply.badgerboardwi.com>'

function emailTemplate({ title, preheader = '', body, ctaText, ctaUrl, footerNote = '', flagBar = true, titleCenter = false }) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <span style="display:none;max-height:0;overflow:hidden;mso-hide:all">${preheader}</span>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:32px 16px">
    <tr><td align="center">
      <table width="580" cellpadding="0" cellspacing="0" style="max-width:580px;width:100%">
        ${flagBar ? `<!-- WI flag accent bar -->
        <tr>
          <td style="background:#8B0000;height:4px;border-radius:4px 4px 0 0;width:33%"></td>
          <td style="background:#ffffff;height:4px;width:34%"></td>
          <td style="background:#1e40af;height:4px;border-radius:4px 4px 0 0;width:33%"></td>
        </tr>` : ''}
        <!-- Logo header -->
        <tr>
          <td colspan="3" style="background:#000000;padding:20px 40px;text-align:center;${flagBar ? '' : 'border-radius:12px 12px 0 0'}">
            <img src="https://www.badgerboardwi.com/badger-board-logo.png"
                 alt="Badger Board"
                 width="200"
                 style="display:block;margin:0 auto;max-width:200px;height:auto;border:0" />
          </td>
        </tr>
        <!-- Body card -->
        <tr>
          <td colspan="3" style="background:#ffffff;padding:40px 40px 36px;border-radius:0 0 12px 12px">
            <h1 style="margin:0 0 20px;font-size:21px;font-weight:700;color:#111827;line-height:1.3${titleCenter ? ';text-align:center' : ''}">${title}</h1>
            <div style="color:#4b5563;font-size:15px;line-height:1.65">${body}</div>
            ${ctaText && ctaUrl ? `
            <div style="text-align:center;margin:32px 0 4px">
              <a href="${ctaUrl}" style="display:inline-block;background:#8B0000;color:#ffffff;font-weight:700;font-size:14px;padding:13px 32px;border-radius:8px;text-decoration:none;letter-spacing:0.01em">${ctaText} &rarr;</a>
            </div>` : ''}
            ${footerNote ? `<p style="color:#9ca3af;font-size:12px;margin:28px 0 0;border-top:1px solid #f3f4f6;padding-top:16px">${footerNote}</p>` : ''}
          </td>
        </tr>
        <!-- Footer -->
        <tr>
          <td colspan="3" style="padding:20px 0;text-align:center">
            <p style="color:#9ca3af;font-size:11px;margin:0">&copy; ${new Date().getFullYear()} The Bluejack Group &nbsp;&middot;&nbsp; <a href="https://www.badgerboardwi.com" style="color:#9ca3af;text-decoration:none">badgerboardwi.com</a></p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`
}

async function sendEmail({ to, subject, title, preheader, body, ctaText, ctaUrl, footerNote, flagBar, titleCenter }) {
  if (!RESEND_API_KEY) {
    console.warn('[email] RESEND_API_KEY not set — skipping email to', to)
    return { skipped: true }
  }
  if (!to) {
    console.warn('[email] No recipient — skipping')
    return { skipped: true }
  }
  const html = emailTemplate({ title: title || subject, preheader, body, ctaText, ctaUrl, footerNote, flagBar: flagBar !== false, titleCenter: titleCenter === true })
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: FROM, to, subject, html }),
    })
    if (!res.ok) {
      const err = await res.text()
      console.error('[email] Resend error:', err)
      return { error: err }
    }
    const result = await res.json()
    console.log('[email] Sent to', to, '— id:', result.id)
    return result
  } catch (err) {
    console.error('[email] sendEmail threw:', err.message)
    return { error: err.message }
  }
}

// Fetch notification preferences for a user.
// Returns an object with boolean flags; defaults everything to true if no row exists.
async function getNotificationPrefs(userId) {
  const defaults = {
    payment_failed:  true,
    payment_receipt: true,
    plan_changed:    true,
    account_locked:  true,
    dossier_ready:   true,
  }
  if (!userId || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return defaults
  try {
    const res = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/notification_preferences?user_id=eq.${encodeURIComponent(userId)}&select=*&limit=1`,
      {
        headers: {
          apikey:        process.env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        },
      }
    )
    if (!res.ok) return defaults
    const rows = await res.json()
    if (!Array.isArray(rows) || !rows.length) return defaults
    return { ...defaults, ...rows[0] }
  } catch {
    return defaults
  }
}

module.exports = { sendEmail, emailTemplate, getNotificationPrefs }
