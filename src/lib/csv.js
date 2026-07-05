// src/lib/csv.js
// ─── Robust CSV tokenizer ─────────────────────────────────────────────────────
// Handles: quoted fields, escaped quotes (""), commas and newlines inside
// quotes, CRLF/CR line endings, and a leading BOM. Returns an array of rows,
// each an array of raw field strings (callers trim/normalize as needed).
export function parseCsvRows(text) {
  const s = String(text ?? '').replace(/^﻿/, '')
  const rows = []
  let row = [], cur = '', inQ = false
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (inQ) {
      if (ch === '"') {
        if (s[i + 1] === '"') { cur += '"'; i++ }
        else inQ = false
      } else cur += ch
    } else if (ch === '"') {
      inQ = true
    } else if (ch === ',') {
      row.push(cur); cur = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++
      row.push(cur); cur = ''
      if (row.length > 1 || row[0] !== '') rows.push(row)
      row = []
    } else {
      cur += ch
    }
  }
  row.push(cur)
  if (row.length > 1 || row[0] !== '') rows.push(row)
  return rows
}
