export const BRAND = {
  navy: '#1a2744',
  red: '#cc0000',
  url: 'https://www.badgerboardwi.com',
  supportEmail: 'support@badgerboardwi.com',
};

export function wrap(bodyContent) {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 0; }
    .header { background-color: ${BRAND.navy}; padding: 24px; text-align: center; }
    .header h1 { margin: 0; font-family: 'Pacifico', cursive; font-size: 28px; color: white; }
    .bar { height: 6px; background: linear-gradient(to right, ${BRAND.red} 33%, white 33%, white 66%, #0052cc 66%); }
    .content { background: white; padding: 32px; max-width: 600px; margin: 0 auto; }
    .footer { background-color: #f9fafb; padding: 16px; text-align: center; font-size: 12px; color: #666; max-width: 600px; margin: 0 auto; border-top: 1px solid #e5e7eb; }
    a { color: ${BRAND.red}; text-decoration: none; }
  </style>
</head>
<body>
  <div class="header">
    <h1>Badger Board</h1>
  </div>
  <div class="bar"></div>
  <div class="content">
    ${bodyContent}
  </div>
  <div class="footer">
    <p>&copy; ${new Date().getFullYear()} Badger Board. All rights reserved.</p>
    <p><a href="${BRAND.url}/unsubscribe">Unsubscribe from emails</a></p>
  </div>
</body>
</html>
  `.trim();
}

export function ctaButton(href, label) {
  return `
<table cellpadding="0" cellspacing="0" border="0" style="margin: 24px auto;">
  <tr>
    <td style="background-color: ${BRAND.red}; padding: 12px 32px; border-radius: 4px;">
      <a href="${href}" style="color: white; text-decoration: none; font-weight: bold; display: block;">
        ${label}
      </a>
    </td>
  </tr>
</table>
  `.trim();
}

export function passwordResetTemplate(resetUrl, recipientEmail) {
  const bodyContent = `
<div style="text-align: center; margin-bottom: 24px;">
  <div style="font-size: 48px; margin-bottom: 12px;">🔐</div>
  <h2 style="margin: 0; color: ${BRAND.navy};">Reset Your Password</h2>
</div>

<p style="color: #374151; font-size: 15px; line-height: 1.6;">
  Someone requested a password reset for your Badger Board account (${recipientEmail}). If that was you, click the button below to reset your password.
</p>

${ctaButton(resetUrl, 'Reset My Password')}

<p style="color: #6b7280; font-size: 13px; line-height: 1.6; margin-top: 24px;">
  <strong>This link expires in 1 hour.</strong>
</p>

<p style="color: #6b7280; font-size: 13px; line-height: 1.6;">
  If you didn't request this email, you can safely ignore it or contact us at ${BRAND.supportEmail} for assistance.
</p>
  `.trim();

  return {
    subject: 'Reset your Badger Board password',
    html: wrap(bodyContent),
    text: `Reset Your Password\n\nSomeone requested a password reset for your Badger Board account (${recipientEmail}). Visit the link below to reset your password.\n\n${resetUrl}\n\nThis link expires in 1 hour.\n\nIf you didn't request this email, you can safely ignore it or contact support at ${BRAND.supportEmail}.`,
  };
}

export function paymentIssueTemplate(settingsUrl) {
  const bodyContent = `
<div style="text-align: center; margin-bottom: 24px;">
  <div style="font-size: 48px; margin-bottom: 12px;">⚠️</div>
  <h2 style="margin: 0; color: ${BRAND.red};">Action Required: Update Your Payment Method</h2>
</div>

<div style="background-color: #fef2f2; border-left: 4px solid ${BRAND.red}; padding: 16px; margin: 20px 0; border-radius: 4px;">
  <p style="margin: 0; color: #991b1b; font-weight: bold;">Your account has been suspended due to a failed payment.</p>
</div>

<p style="color: #374151; font-size: 15px; line-height: 1.6;">
  We weren't able to process your recent payment. To restore access to your Badger Board account, please update your payment method as soon as possible.
</p>

${ctaButton(settingsUrl, 'Update Payment Method')}

<p style="color: #6b7280; font-size: 13px; line-height: 1.6; margin-top: 24px;">
  If you're experiencing issues or have questions, please reach out to our support team at ${BRAND.supportEmail}.
</p>
  `.trim();

  return {
    subject: 'Action required: Update your payment method',
    html: wrap(bodyContent),
    text: `Action Required: Update Your Payment Method\n\nYour account has been suspended due to a failed payment. Please update your payment method to restore access:\n\n${settingsUrl}\n\nIf you have questions, contact support at ${BRAND.supportEmail}.`,
  };
}
