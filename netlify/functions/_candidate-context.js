// netlify/functions/_candidate-context.js
// ─── THE single gate for candidate notes & documents entering ANY AI path ────
// Prefixed with _ so Netlify never exposes it as an endpoint.
//
// SECURITY REQUIREMENT (Candidate Profile Redesign spec §7): when a candidate's
// AI access is locked (candidates.ai_access_notes = false), that candidate's
// team notes and uploaded documents MUST NOT be included in the payload of any
// AI feature — profile generation, Compare, Broadside, or the weekly
// monitoring/digest functions. UI-side hiding is not enforcement; this helper
// is. Every backend function that wants notes/docs in an LLM prompt must go
// through getCandidateAiContext() and must never read candidates.notes
// directly for prompt assembly.
//
// (As of v1.20.0 the only ingestion point is profile generation in
// generate-dossier-background.js — Compare, Broadside and monitoring all
// consume dossier text downstream, so gating ingestion gates them all.
// If a future feature wants notes directly, it must call this helper.)

const { serviceClient } = require('./_shared')

/**
 * Returns AI-eligible notes/documents for a candidate, or empty arrays when
 * the candidate-level lock is on. Per-item ai_access flags are honored too.
 * Never throws.
 *
 * @returns {Promise<{allowed:boolean, notes:Array<{text:string,ts:string}>, files:Array<{name:string}>}>}
 */
async function getCandidateAiContext(candidateId) {
  const empty = { allowed: false, notes: [], files: [] }
  try {
    const { data, error } = await serviceClient()
      .from('candidates')
      .select('notes, ai_access_notes, created_by')
      .eq('id', candidateId)
      .single()
    if (error || !data) return empty

    // Candidate-level lock: hard stop, nothing leaves. This ALWAYS overrides
    // the org-level default below.
    if (data.ai_access_notes === false) return empty

    // Tri-state: null inherits the owner's org-level default
    // (Settings -> Data & privacy). Explicit true bypasses the default.
    if (data.ai_access_notes == null && data.created_by) {
      try {
        const { data: pref } = await serviceClient()
          .from('notification_preferences')
          .select('ai_access_default')
          .eq('user_id', data.created_by)
          .maybeSingle()
        if (pref && pref.ai_access_default === false) return empty
      } catch { /* missing table/column -> permissive default, matching prior behavior */ }
    }

    // candidates.notes holds the v2 JSON {v:2, notes:[], files:[]} store
    let parsed = null
    try { parsed = typeof data.notes === 'string' ? JSON.parse(data.notes) : data.notes } catch { /* legacy plain text */ }
    if (!parsed || parsed.v !== 2) {
      // Legacy plain-text notes field: treat as one AI-eligible note.
      const legacy = typeof data.notes === 'string' ? data.notes.trim() : ''
      return { allowed: true, notes: legacy ? [{ text: legacy.slice(0, 2000), ts: null }] : [], files: [] }
    }

    const notes = (parsed.notes || [])
      .filter(n => n && n.ai_access !== false && typeof n.text === 'string' && n.text.trim())
      .map(n => ({ text: n.text.slice(0, 2000), ts: n.ts || null }))
      .slice(0, 20)

    const files = (parsed.files || [])
      .filter(f => f && f.ai_access !== false && f.name)
      .map(f => ({ name: String(f.name).slice(0, 200) }))
      .slice(0, 30)

    return { allowed: true, notes, files }
  } catch (e) {
    console.warn('[candidate-context] failed, excluding notes:', e.message)
    return empty // fail CLOSED: on any error, nothing is sent to AI
  }
}

/** Render the context as a prompt block, or '' when locked/empty. */
function formatAiContextBlock(ctx, candidateName) {
  if (!ctx?.allowed || (!ctx.notes.length && !ctx.files.length)) return ''
  const noteLines = ctx.notes.map(n => `- ${n.text}${n.ts ? ` (noted ${String(n.ts).slice(0, 10)})` : ''}`).join('\n')
  const fileLines = ctx.files.map(f => `- ${f.name}`).join('\n')
  return `\nTEAM NOTES ON ${candidateName} (user-provided, private; use as leads to verify, never as sole sourcing):\n${noteLines || '(none)'}\n${fileLines ? `\nTEAM-UPLOADED DOCUMENTS ON FILE (titles only):\n${fileLines}\n` : ''}`
}

module.exports = { getCandidateAiContext, formatAiContextBlock }
