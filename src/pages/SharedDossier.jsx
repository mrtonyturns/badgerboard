import React, { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { format, formatDistanceToNow } from 'date-fns'
import {
  Sparkles, AlertTriangle, Clock, Eye, FileText, Newspaper,
  User, Vote, DollarSign, Target, Building2, Network, Share2,
  Globe, Radio, Swords, ClipboardCheck, CheckCircle, XCircle,
} from 'lucide-react'

// ─── Reuse the same section rendering logic as Dossiers.jsx ───────────────────
// (duplicated here so SharedDossier has no auth dependency)

const SECTION_META = [
  { id: 'overview',    label: 'Overview',             icon: FileText      },
  { id: 'section-1',   label: '1 News & Media',      icon: Newspaper     },
  { id: 'section-2',   label: '2 Biography',         icon: User          },
  { id: 'section-3',   label: '3 Timeline',          icon: Clock         },
  { id: 'section-4',   label: '4 Political Record',  icon: Vote          },
  { id: 'section-5',   label: '5 Financial',         icon: DollarSign    },
  { id: 'section-6',   label: '6 Controversies',     icon: AlertTriangle },
  { id: 'section-7',   label: '7 Policy',            icon: Target        },
  { id: 'section-8',   label: '8 Affiliations',      icon: Building2     },
  { id: 'section-9',   label: '9 Network',           icon: Network       },
  { id: 'section-10',  label: '10 Social Posts',     icon: Share2        },
  { id: 'section-11',  label: '11 Digital',          icon: Globe         },
  { id: 'section-12',  label: '12 Narrative',        icon: Radio         },
  { id: 'section-13',  label: '13 Attack & Defense', icon: Swords        },
  { id: 'section-14',  label: '14 Verification',     icon: ClipboardCheck},
]

const SECTION_THEMES = {
  'overview':    { accent: '#475569', light: '#f8fafc', border: '#e2e8f0' },
  'section-1':   { accent: '#2563eb', light: '#eff6ff', border: '#bfdbfe' },
  'section-2':   { accent: '#4f46e5', light: '#eef2ff', border: '#c7d2fe' },
  'section-3':   { accent: '#7c3aed', light: '#f5f3ff', border: '#ddd6fe' },
  'section-4':   { accent: '#6d28d9', light: '#faf5ff', border: '#e9d5ff' },
  'section-5':   { accent: '#059669', light: '#ecfdf5', border: '#a7f3d0' },
  'section-6':   { accent: '#dc2626', light: '#fef2f2', border: '#fecaca' },
  'section-7':   { accent: '#0d9488', light: '#f0fdfa', border: '#99f6e4' },
  'section-8':   { accent: '#d97706', light: '#fffbeb', border: '#fde68a' },
  'section-9':   { accent: '#ea580c', light: '#fff7ed', border: '#fed7aa' },
  'section-10':  { accent: '#0284c7', light: '#f0f9ff', border: '#bae6fd' },
  'section-11':  { accent: '#0891b2', light: '#ecfeff', border: '#a5f3fc' },
  'section-12':  { accent: '#db2777', light: '#fdf2f8', border: '#fbcfe8' },
  'section-13':  { accent: '#b91c1c', light: '#fff1f2', border: '#fecdd3' },
  'section-14':  { accent: '#16a34a', light: '#f0fdf4', border: '#bbf7d0' },
}

const BADGE_STYLES = {
  'KNOWN':             'background:#dcfce7;color:#166534;border:1px solid #bbf7d0;',
  'RESEARCH REQUIRED': 'background:#fef3c7;color:#92400e;border:1px solid #fde68a;',
  'CONFIRMED':         'background:#dbeafe;color:#1e40af;border:1px solid #bfdbfe;',
  'LIKELY':            'background:#f3e8ff;color:#6b21a8;border:1px solid #e9d5ff;',
  'VERIFY':            'background:#fefce8;color:#854d0e;border:1px solid #fef08a;',
  'HIGH':              'background:#fee2e2;color:#991b1b;border:1px solid #fecaca;',
  'MEDIUM':            'background:#ffedd5;color:#9a3412;border:1px solid #fed7aa;',
  'LOW':               'background:#f0fdf4;color:#166534;border:1px solid #bbf7d0;',
}
const BADGE_RE = /\*\*\[([A-Z ]+)\]\*\*/g

function applyInline(text) {
  return text
    .replace(BADGE_RE, (_, badge) => {
      const style = BADGE_STYLES[badge.toUpperCase()] || 'background:#f3f4f6;color:#374151;border:1px solid #d1d5db;'
      return `<span style="display:inline-block;font-size:0.7rem;font-weight:700;padding:1px 6px;border-radius:4px;${style}">${badge}</span>`
    })
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code style="background:#f3f4f6;padding:1px 4px;border-radius:3px;font-size:0.85em;">$1</code>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" style="color:#1d4ed8;text-decoration:underline;" target="_blank" rel="noopener noreferrer">$1</a>')
}

function mdToHtml(text, accentColor = '#2563eb') {
  text = (text || '').replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
  text = text.replace(/<ant[Tt]hinking>[\s\S]*?<\/ant[Tt]hinking>/gi, '')
  const lines = text.split('\n')
  const out = []
  let inCode = false, inUl = false, inOl = false, inTable = false, tableHeaderDone = false, tableRowIndex = 0

  const closeList  = () => { if (inUl) { out.push('</ul>'); inUl = false } if (inOl) { out.push('</ol>'); inOl = false } }
  const closeTable = () => { if (inTable) { out.push('</tbody></table></div>'); inTable = false; tableHeaderDone = false; tableRowIndex = 0 } }
  const closeAll   = () => { closeList(); closeTable() }
  const parseRow   = (line) => line.split('|').map(c => c.trim()).filter((_, i, a) => i > 0 && i < a.length - 1)
  const isSep      = (line) => /^\|[\s\-:|]+\|$/.test(line.trim())

  lines.forEach(line => {
    const trimmed = line.trim()
    if (line.startsWith('```')) { closeAll(); inCode = !inCode; if (inCode) out.push('<pre style="background:#1e293b;color:#e2e8f0;padding:12px;border-radius:6px;overflow-x:auto;font-size:0.85em;margin:12px 0;">'); else out.push('</pre>'); return }
    if (inCode) { out.push(line.replace(/</g,'&lt;').replace(/>/g,'&gt;') + '\n'); return }

    if (trimmed.startsWith('|')) {
      closeList()
      if (isSep(trimmed)) return
      if (!inTable) {
        inTable = true
        out.push('<div style="overflow-x:auto;-webkit-overflow-scrolling:touch;margin:12px 0;border-radius:8px;border:1px solid #e5e7eb;">')
        out.push('<table style="width:100%;border-collapse:collapse;font-size:0.85rem;min-width:400px;">')
        out.push('<thead><tr>')
        for (const cell of parseRow(trimmed)) {
          out.push(`<th style="text-align:left;padding:9px 14px;background:#f1f5f9;font-weight:700;color:#1e293b;border-bottom:2px solid #e2e8f0;white-space:nowrap;font-size:0.8rem;text-transform:uppercase;letter-spacing:0.04em;">${applyInline(cell)}</th>`)
        }
        out.push('</tr></thead><tbody>')
        tableHeaderDone = true
      } else {
        const cells = parseRow(trimmed)
        const rowBg = tableRowIndex % 2 === 0 ? '#ffffff' : '#f9fafb'
        tableRowIndex++
        out.push(`<tr style="border-bottom:1px solid #f3f4f6;background:${rowBg};">`)
        cells.forEach((cell, ci) => {
          const isFirst = ci === 0
          out.push(`<td style="padding:9px 14px;vertical-align:top;color:${isFirst?'#111827':'#374151'};font-weight:${isFirst?'600':'400'};font-size:0.85rem;">${applyInline(cell)}</td>`)
        })
        out.push('</tr>')
      }
      return
    }
    if (inTable) closeTable()

    if (/^---+$/.test(trimmed)) { closeAll(); out.push('<hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0;">'); return }
    if (/^## SECTION \d+/i.test(trimmed)) { closeAll(); return }
    if (line.startsWith('#### ')) { closeList(); out.push(`<h4 style="font-size:0.875rem;font-weight:700;color:#374151;margin:14px 0 4px;text-transform:uppercase;letter-spacing:0.04em;">${applyInline(line.slice(5))}</h4>`); return }
    if (line.startsWith('### '))  { closeList(); out.push(`<h3 style="font-size:0.95rem;font-weight:700;color:#1e293b;margin:22px 0 8px;padding:6px 10px 6px 14px;background:#f8fafc;border-left:3px solid ${accentColor};border-radius:0 6px 6px 0;">${applyInline(line.slice(4))}</h3>`); return }
    if (line.startsWith('## '))   { closeList(); out.push(`<h2 style="font-size:1.05rem;font-weight:800;color:#111827;margin:24px 0 10px;padding-bottom:6px;border-bottom:2px solid #e5e7eb;">${applyInline(line.slice(3))}</h2>`); return }
    if (line.startsWith('# '))    { closeList(); out.push(`<h1 style="font-size:1.2rem;font-weight:900;color:#111827;margin:24px 0 10px;">${applyInline(line.slice(2))}</h1>`); return }

    if (/^[-*] \[[ xX]\]/.test(line)) {
      if (inOl) { out.push('</ol>'); inOl = false }
      if (!inUl) { out.push('<ul style="margin:8px 0 8px 20px;padding:0;list-style:none;">'); inUl = true }
      const checked = /\[[xX]\]/.test(line)
      const text = line.replace(/^[-*] \[[ xX]\]\s*/, '')
      out.push(`<li style="margin:3px 0;color:#374151;font-size:0.95rem;display:flex;align-items:flex-start;gap:6px;list-style:none;"><span style="margin-top:2px;color:${checked?'#16a34a':'#9ca3af'};">${checked?'✓':'○'}</span>${applyInline(text)}</li>`)
      return
    }
    if (/^[*\-] /.test(line)) {
      if (inOl) { out.push('</ol>'); inOl = false }
      if (!inUl) { out.push('<ul style="margin:8px 0 8px 20px;padding:0;list-style:disc;">'); inUl = true }
      out.push(`<li style="margin:3px 0;color:#374151;font-size:0.95rem;">${applyInline(line.slice(2))}</li>`)
      return
    }
    const olMatch = line.match(/^(\d+)\. (.+)/)
    if (olMatch) {
      if (inUl) { out.push('</ul>'); inUl = false }
      if (!inOl) { out.push('<ol style="margin:8px 0 8px 20px;padding:0;list-style:decimal;">'); inOl = true }
      out.push(`<li style="margin:3px 0;color:#374151;font-size:0.95rem;">${applyInline(olMatch[2])}</li>`)
      return
    }
    if (trimmed === '') { closeList(); out.push('<div style="height:6px;"></div>'); return }
    closeList()
    out.push(`<p style="margin:5px 0;color:#374151;font-size:0.9rem;line-height:1.75;">${applyInline(line)}</p>`)
  })
  closeAll()
  return out.join('')
}

function parseSections(content = '') {
  if (!content) return [{ id: 'overview', label: 'Overview', content, index: 0 }]
  const primaryRe = /\n(?=## SECTION \d)/i
  if (primaryRe.test('\n' + content)) {
    const parts = ('\n' + content).split(primaryRe)
    const result = []
    parts.forEach((part, i) => {
      const trimmed = part.trim()
      if (!trimmed) return
      if (i === 0) { result.push({ id: 'overview', label: 'Overview', content: trimmed, index: 0 }) }
      else {
        const m = trimmed.match(/^## SECTION (\d+)[:\s]*(.*)/i)
        const num = m ? parseInt(m[1]) : i
        const meta = SECTION_META[num] || { id: `section-${num}`, label: `Section ${num}` }
        result.push({ id: meta.id, label: meta.label, content: trimmed, index: num })
      }
    })
    if (result.length > 1) return result
  }
  const parts = content.split(/\n(?=## )/)
  if (parts.length > 1) {
    return parts.map((part, i) => {
      const meta = SECTION_META[i] || { id: `section-${i}`, label: `Section ${i}` }
      return { id: meta.id, label: meta.label, content: part.trim(), index: i }
    })
  }
  return [{ id: 'overview', label: 'Full Report', content: content.trim(), index: 0 }]
}

// ─── Expiry countdown ─────────────────────────────────────────────────────────
function ExpiryBadge({ expiresAt }) {
  const expired = new Date(expiresAt) < new Date()
  const distance = expired ? null : formatDistanceToNow(new Date(expiresAt), { addSuffix: true })
  if (expired) {
    return (
      <div className="flex items-center gap-1.5 px-3 py-1.5 bg-red-50 border border-red-200 rounded-full text-xs font-semibold text-red-700">
        <XCircle className="w-3.5 h-3.5" /> Expired
      </div>
    )
  }
  return (
    <div className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-50 border border-amber-200 rounded-full text-xs font-semibold text-amber-700">
      <Clock className="w-3.5 h-3.5" /> Expires {distance}
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function SharedDossier() {
  const { token } = useParams()
  const [state, setState]   = useState('loading') // loading | ready | expired | notfound | error
  const [dossier, setDossier] = useState(null)
  const [share, setShare]   = useState(null)

  useEffect(() => {
    if (!token) { setState('notfound'); return }
    fetch(`/.netlify/functions/get-shared-dossier?token=${encodeURIComponent(token)}`)
      .then(res => res.json().then(data => ({ ok: res.ok, status: res.status, data })))
      .then(({ ok, status, data }) => {
        if (status === 410) { setState('expired'); return }
        if (status === 404) { setState('notfound'); return }
        if (!ok) { setState('error'); return }
        setDossier(data.dossier)
        setShare(data.share)
        setState('ready')
      })
      .catch(() => setState('error'))
  }, [token])

  // ── Loading ────────────────────────────────────────────────────────────────
  if (state === 'loading') {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="text-center">
          <div className="w-10 h-10 border-4 border-brand-red border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          <p className="text-gray-500 text-sm">Loading temporary profile…</p>
        </div>
      </div>
    )
  }

  // ── Error states ───────────────────────────────────────────────────────────
  if (state !== 'ready') {
    const messages = {
      expired:  { icon: <Clock className="w-10 h-10 text-amber-500" />, title: 'Link Expired', body: 'This temporary profile link has expired. Contact the person who shared it with you to request a new one.' },
      notfound: { icon: <XCircle className="w-10 h-10 text-red-500" />, title: 'Link Not Found', body: 'This link is invalid or has been deactivated. Contact the person who shared it with you.' },
      error:    { icon: <AlertTriangle className="w-10 h-10 text-orange-500" />, title: 'Something Went Wrong', body: 'We could not load this profile. Please try again in a moment.' },
    }
    const { icon, title, body } = messages[state] || messages.error
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col">
        <SharedHeader />
        <div className="flex-1 flex items-center justify-center p-6">
          <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-8 max-w-md w-full text-center">
            <div className="flex justify-center mb-4">{icon}</div>
            <h2 className="text-lg font-bold text-gray-900 mb-2">{title}</h2>
            <p className="text-sm text-gray-500 leading-relaxed">{body}</p>
          </div>
        </div>
        <SharedFooter />
      </div>
    )
  }

  const sections = parseSections(dossier.content)
  const candidate = dossier.candidate
  const generatedAt = dossier.generated_at ? format(new Date(dossier.generated_at), 'MMMM d, yyyy') : ''

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      <SharedHeader />

      {/* ── Document header ──────────────────────────────────────────────── */}
      <div className="max-w-4xl mx-auto w-full px-4 pt-6 pb-2">
        {/* Temporary link banner */}
        <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 mb-4">
          <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0 text-xs text-amber-800 leading-relaxed">
            <span className="font-semibold">Temporary Profile Link</span> — This is a time-limited share. The content is AI-generated from publicly available sources and requires independent verification before use. Do not use for FCRA-regulated purposes or formal legal proceedings. The Bluejack Group assumes no liability for the use of shared profile links.
          </div>
          {share && <ExpiryBadge expiresAt={share.expires_at} />}
        </div>

        {/* Dossier title bar */}
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm px-5 py-4 mb-4">
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1.5">
                <Sparkles className="w-4 h-4 text-brand-red flex-shrink-0" />
                <span className="text-xs font-semibold text-brand-red uppercase tracking-wider">AI-Generated Intelligence Report</span>
              </div>
              <h1 className="text-xl font-bold text-gray-900 leading-snug">{dossier.title}</h1>
              <div className="flex flex-wrap items-center gap-3 mt-2 text-xs text-gray-500">
                {candidate?.offices?.name && <span>{candidate.offices.name}{candidate.offices.district_name ? ` · ${candidate.offices.district_name}` : ''}</span>}
                {candidate?.party && <span className="px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 font-medium">{candidate.party}</span>}
                {generatedAt && <span>Generated {generatedAt}</span>}
              </div>
            </div>
            {share && (
              <div className="flex items-center gap-1.5 text-xs text-gray-400 flex-shrink-0">
                <Eye className="w-3.5 h-3.5" />
                <span>{(share.view_count + 1).toLocaleString()} view{share.view_count + 1 !== 1 ? 's' : ''}</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Dossier sections ─────────────────────────────────────────────── */}
      <div className="max-w-4xl mx-auto w-full px-4 pb-10 space-y-4">
        {sections.map((s) => {
          const theme = SECTION_THEMES[s.id] || SECTION_THEMES['overview']
          const meta = SECTION_META.find(m => m.id === s.id) || SECTION_META[0]
          const SectionIcon = meta.icon || FileText

          return (
            <div
              key={s.id}
              className="rounded-2xl border overflow-hidden shadow-sm"
              style={{ borderColor: theme.border, borderLeftWidth: '4px', borderLeftColor: theme.accent }}
            >
              <div
                className="flex items-center gap-2.5 px-4 py-2.5"
                style={{ background: theme.light, borderBottom: `1px solid ${theme.border}` }}
              >
                <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: 'white', border: `1px solid ${theme.border}` }}>
                  <SectionIcon className="w-3.5 h-3.5" style={{ color: theme.accent }} />
                </div>
                <span className="text-xs font-bold uppercase tracking-wider" style={{ color: theme.accent }}>{s.label}</span>
              </div>
              <div className="px-5 py-4 bg-white prose-dossier">
                <div dangerouslySetInnerHTML={{ __html: mdToHtml(s.content, theme.accent) }} />
              </div>
            </div>
          )
        })}
      </div>

      <SharedFooter />
    </div>
  )
}

// ─── Shared header ────────────────────────────────────────────────────────────
function SharedHeader() {
  return (
    <header className="bg-brand-navy border-b border-white/10 flex-shrink-0">
      <div className="max-w-4xl mx-auto px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-brand-red rounded-lg flex items-center justify-center flex-shrink-0">
            <Sparkles className="w-4 h-4 text-white" />
          </div>
          <div>
            <span className="text-white font-bold text-sm tracking-wide">Badger Board</span>
            <span className="text-white/40 text-xs ml-2">· Temporary Intelligence Profile</span>
          </div>
        </div>
        <Link
          to="/login"
          className="text-xs font-semibold text-white/70 hover:text-white px-3 py-1.5 rounded-lg border border-white/20 hover:border-white/40 transition-colors"
        >
          Sign in →
        </Link>
      </div>
    </header>
  )
}

// ─── Shared footer ────────────────────────────────────────────────────────────
function SharedFooter() {
  return (
    <footer className="bg-brand-navy border-t border-white/10 mt-auto">
      <div className="max-w-4xl mx-auto px-4 py-6">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-7 h-7 bg-brand-red rounded-lg flex items-center justify-center flex-shrink-0">
              <Sparkles className="w-3.5 h-3.5 text-white" />
            </div>
            <div>
              <p className="text-white font-bold text-sm">Badger Board</p>
              <p className="text-white/40 text-xs">by The Bluejack Group</p>
            </div>
          </div>
          <div className="text-xs text-white/40 leading-relaxed max-w-sm">
            AI-Generated Political Intelligence · This report was shared via a temporary link. All information requires independent verification. Not for FCRA-regulated use.
          </div>
          <Link
            to="/plans"
            className="flex-shrink-0 bg-brand-red text-white text-xs font-bold px-4 py-2 rounded-xl hover:bg-red-700 transition-colors"
          >
            Run Your Own Profiles →
          </Link>
        </div>
        <div className="mt-4 pt-4 border-t border-white/10 text-xs text-white/30 text-center">
          © {new Date().getFullYear()} The Bluejack Group · <a href="/dossier-disclaimer" className="hover:text-white/60">Disclaimer</a> · <a href="/terms" className="hover:text-white/60">Terms</a>
        </div>
      </div>
    </footer>
  )
}
