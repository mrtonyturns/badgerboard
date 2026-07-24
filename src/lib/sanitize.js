// src/lib/sanitize.js
// ─── HTML sanitization for AI-generated / user-influenced content ────────────
// Every dangerouslySetInnerHTML sink in the app MUST pass its HTML through
// sanitizeHtml() first. The markdown converters emit inline-styled HTML, so
// style attributes are allowed; scripts, event handlers, and javascript: URIs
// are stripped by DOMPurify's defaults.

import DOMPurify from 'dompurify'

// Force safe link behavior on every anchor that survives sanitization.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('rel', 'noopener noreferrer')
    if (node.getAttribute('target') === '_blank') node.setAttribute('rel', 'noopener noreferrer')
  }
})

/** Sanitize converter/AI output before it reaches dangerouslySetInnerHTML. */
export function sanitizeHtml(html) {
  return DOMPurify.sanitize(html || '', {
    USE_PROFILES: { html: true },
    ADD_ATTR: ['target'],
    FORBID_TAGS: ['form', 'input', 'textarea', 'select', 'button', 'iframe', 'object', 'embed'],
  })
}

/** Announcement messages: formatting only — bold/italic/underline/breaks.
 *  No sizes, colors, links, or anything else survives (per product spec). */
export function sanitizeAnnouncementHtml(html) {
  return DOMPurify.sanitize(html || '', {
    ALLOWED_TAGS: ['b', 'strong', 'i', 'em', 'u', 'br', 'div', 'p'],
    ALLOWED_ATTR: [],
  })
}

/** Escape a plain-text value for interpolation into an HTML template string. */
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch])
}
