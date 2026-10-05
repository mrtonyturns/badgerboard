// src/lib/safeUrl.js
// ─── href guard for user/AI-supplied website fields ──────────────────────────
// React 18 renders href="javascript:…" as-is (it only warns), so a candidate
// row whose `website` came from a CSV, an AI discovery or a bulk import could
// run script on click. Every rendered website link goes through this: only
// http(s) survives, and a bare domain ("example.com") is given https:// the
// way people type it into the field. Anything else → null (render no link).
export function safeHttpUrl(raw) {
  const s = String(raw ?? '').trim()
  if (!s || /\s/.test(s)) return null
  let candidate
  let bare = false
  if (/^https?:\/\//i.test(s)) candidate = s
  // Any other scheme (javascript:, data:, vbscript:, mailto:) is refused. The
  // (?!\d) lets "example.com:8080" through as a host:port, not a scheme.
  else if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(s)) return null
  else { candidate = `https://${s.replace(/^\/\//, '')}`; bare = true }
  try {
    const u = new URL(candidate)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    if (!u.hostname || (bare && !u.hostname.includes('.'))) return null
    return u.href
  } catch {
    return null
  }
}
