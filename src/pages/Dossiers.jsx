import React, { useEffect, useState, useRef, useCallback } from 'react'
import { useSearchParams, Link } from 'react-router-dom'
import { format } from 'date-fns'
import { sanitizeHtml, escapeHtml } from '../lib/sanitize'
import {
  FileText, Sparkles, Search, Trash2, RefreshCw, Copy, Check,
  Download, User, Newspaper, BookOpen, Target, Building2,
  Network, AlertTriangle, Radio, ShieldCheck, X, AlertCircle, CheckCircle,
  Users, ChevronDown, ChevronUp, PlayCircle, ListChecks, UserPlus,
  Scale, MessageSquare, ThumbsUp, ThumbsDown, HelpCircle, ChevronRight,
  Clock, DollarSign, Vote, Share2, Globe, Swords, ClipboardCheck,
  Link2, Eye, ExternalLink, ShieldAlert,
  Maximize2, Minimize2, EyeOff } from 'lucide-react'
import { getCandidates, getDossiers, getDossier, createDossier, deleteDossier, createCandidate, updateCandidate, getOffices } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import SearchableSelect from '../components/SearchableSelect'
import { getUserTier, getTierConfig, isLiteProfileOnly, LITE_PROFILE_FREE_SECTIONS, getUserBracket, getProfileLimit, getEffectiveProfileLimit } from '../lib/tiers'
import { filterSections } from '../lib/profileContent'
import { supabase } from '../lib/supabase'
import UpgradePrompt from '../components/UpgradePrompt'
import LoadingBar from '../components/LoadingBar'
import DossierDisclaimerModal, { useDossierAck } from '../components/DossierDisclaimerModal'
import { useDossierStatus } from '../contexts/DossierStatusContext'

// ─── Section metadata: Overview + 14 master-prompt sections ──────────────────
const SECTION_META = [
  { id: 'overview',    label: 'Overview',             icon: FileText       },
  { id: 'section-1',   label: '1 News & Media',      icon: Newspaper      },
  { id: 'section-2',   label: '2 Biography',         icon: User           },
  { id: 'section-3',   label: '3 Timeline',          icon: Clock          },
  { id: 'section-4',   label: '4 Political Record',  icon: Vote           },
  { id: 'section-5',   label: '5 Financial',         icon: DollarSign     },
  { id: 'section-6',   label: '6 Controversies',     icon: AlertTriangle  },
  { id: 'section-7',   label: '7 Policy',            icon: Target         },
  { id: 'section-8',   label: '8 Affiliations',      icon: Building2      },
  { id: 'section-9',   label: '9 Network',           icon: Network        },
  { id: 'section-10',  label: '10 Social Posts',     icon: Share2         },
  { id: 'section-11',  label: '11 Digital',          icon: Globe          },
  { id: 'section-12',  label: '12 Narrative',        icon: Radio          },
  { id: 'section-13',  label: '13 Attack & Defense', icon: Swords         },
  { id: 'section-14',  label: '14 Verification',     icon: ClipboardCheck },
]

// ─── Per-section color themes (accent / light bg / border) ───────────────────
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

// ─── Parse markdown sections ──────────────────────────────────────────────────
// Pull the PROFILE SNAPSHOT block out of the report so it renders as the
// animated intro card instead of as body text. Returns { snapshot, rest }.
function extractSnapshot(content = '') {
  if (!content) return { snapshot: '', rest: content }
  const m = content.match(/##\s*PROFILE SNAPSHOT\s*\n([\s\S]*?)(?=\n##\s|$)/i)
  if (!m) return { snapshot: '', rest: content }
  const snapshot = m[1]
    .replace(/\*\*\[[^\]]*\]\*\*/g, '')   // strip any stray badges
    .replace(/[*#>_`]/g, '')               // strip markdown emphasis
    .replace(/\s+/g, ' ')
    .trim()
  const rest = content.replace(m[0], '').replace(/^\s*\n/, '').trim()
  return { snapshot, rest }
}

// Typewriter intro card — types the snapshot out on first open, fast.
function SnapshotCard({ text }) {
  const [shown, setShown]   = useState(0)
  const [done, setDone]     = useState(false)
  const reduceMotion = typeof window !== 'undefined'
    && window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches

  useEffect(() => {
    if (!text) return
    if (reduceMotion) { setShown(text.length); setDone(true); return }
    setShown(0); setDone(false)
    let i = 0
    // ~18ms/char, but step 2 chars at a time so long snapshots finish quickly
    const id = setInterval(() => {
      i += 2
      if (i >= text.length) { setShown(text.length); setDone(true); clearInterval(id) }
      else setShown(i)
    }, 18)
    return () => clearInterval(id)
  }, [text, reduceMotion])

  if (!text) return null
  return (
    <div className="mx-4 mt-3 mb-1 rounded-2xl border border-brand-red/15 bg-gradient-to-br from-red-50/70 via-white to-white px-5 py-4 shadow-sm animate-[snapfade_.5s_ease]">
      <style>{`@keyframes snapfade{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}`}</style>
      <div className="flex items-center gap-2 mb-1.5">
        <Sparkles className="w-3.5 h-3.5 text-brand-red" />
        <span className="text-[10px] font-extrabold uppercase tracking-[0.12em] text-brand-red">Snapshot</span>
      </div>
      <p className="text-[15px] leading-relaxed text-gray-800 font-medium">
        {text.slice(0, shown)}
        {!done && <span className="inline-block w-[2px] h-[1.05em] align-[-0.15em] ml-0.5 bg-brand-red animate-pulse" />}
      </p>
    </div>
  )
}

function parseSections(content = '') {
  if (!content) return [{ id: 'overview', label: 'Overview', content, index: 0 }]

  // Primary split: ## SECTION N or ## SECTION N:
  const primaryRe = /\n(?=## SECTION \d)/i
  if (primaryRe.test('\n' + content)) {
    const parts = ('\n' + content).split(primaryRe)
    const result = []
    parts.forEach((part, i) => {
      const trimmed = part.trim()
      if (!trimmed) return
      if (i === 0) {
        result.push({ id: 'overview', label: 'Overview', content: trimmed, index: 0 })
      } else {
        const m = trimmed.match(/^## SECTION (\d+)[:\s]*(.*)/i)
        const num = m ? parseInt(m[1]) : i
        const meta = SECTION_META[num] || { id: `section-${num}`, label: `Section ${num}` }
        result.push({ id: meta.id, label: meta.label, content: trimmed, index: num })
      }
    })
    if (result.length > 1) return result
  }

  // Fallback: split on any ## heading
  const parts = content.split(/\n(?=## )/)
  if (parts.length > 1) {
    return parts.map((part, i) => {
      const meta = SECTION_META[i] || { id: `section-${i}`, label: `Section ${i}` }
      return { id: meta.id, label: meta.label, content: part.trim(), index: i }
    })
  }

  // No headings — show as a single section
  return [{ id: 'overview', label: 'Full Report', content: content.trim(), index: 0 }]
}

// ─── Badge colours (inline-styled, works inside print window too) ─────────────
const BADGE_STYLES = {
  'KNOWN':              'background:#dcfce7;color:#166534;border:1px solid #bbf7d0;',
  'RESEARCH REQUIRED':  'background:#fef3c7;color:#92400e;border:1px solid #fde68a;',
  'CONFIRMED':          'background:#dbeafe;color:#1e40af;border:1px solid #bfdbfe;',
  'LIKELY':             'background:#f3e8ff;color:#6b21a8;border:1px solid #e9d5ff;',
  'VERIFY':             'background:#fefce8;color:#854d0e;border:1px solid #fef08a;',
  'HIGH':               'background:#fee2e2;color:#991b1b;border:1px solid #fecaca;',
  'MEDIUM':             'background:#ffedd5;color:#9a3412;border:1px solid #fed7aa;',
  'LOW':                'background:#f0fdf4;color:#166534;border:1px solid #bbf7d0;',
}
const BADGE_RE = /\*\*\[([A-Z ]+)\]\*\*/g

function applyInline(text) {
  return text
    // Badges
    .replace(BADGE_RE, (_, badge) => {
      const style = BADGE_STYLES[badge.toUpperCase()] || 'background:#f3f4f6;color:#374151;border:1px solid #d1d5db;'
      return `<span style="display:inline-block;font-size:0.7rem;font-weight:700;padding:1px 6px;border-radius:4px;${style}">${badge}</span>`
    })
    // Bold
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    // Italic
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    // Inline code
    .replace(/`([^`]+)`/g, '<code style="background:#f3f4f6;padding:1px 4px;border-radius:3px;font-size:0.85em;">$1</code>')
    // Markdown links
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" style="color:#1d4ed8;text-decoration:underline;">$1</a>')
}

// ─── Markdown → inline-styled HTML (works in both app + print window) ────────
function mdToHtml(text, accentColor = '#2563eb') {
  // Strip any AI reasoning/thinking tags that should never be displayed
  text = text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
  text = text.replace(/<ant[Tt]hinking>[\s\S]*?<\/ant[Tt]hinking>/gi, '')
  const lines = text.split('\n')
  const out = []
  let inCode = false, inUl = false, inOl = false, inTable = false, tableHeaderDone = false, tableRowIndex = 0

  const closeList = () => {
    if (inUl) { out.push('</ul>'); inUl = false }
    if (inOl) { out.push('</ol>'); inOl = false }
  }
  const closeTable = () => {
    if (inTable) { out.push('</tbody></table></div>'); inTable = false; tableHeaderDone = false; tableRowIndex = 0 }
  }
  const closeAll = () => { closeList(); closeTable() }

  // Parse a table row into cells
  const parseTableRow = (line) => {
    return line.split('|').map(c => c.trim()).filter((_, i, a) => i > 0 && i < a.length - 1)
  }
  const isTableSeparator = (line) => /^\|[\s\-:|]+\|$/.test(line.trim())

  lines.forEach(line => {
    const trimmed = line.trim()

    // Code fence
    if (line.startsWith('```')) {
      closeAll()
      inCode = !inCode
      if (inCode) out.push('<pre style="background:#1e293b;color:#e2e8f0;padding:12px;border-radius:6px;overflow-x:auto;font-size:0.85em;margin:12px 0;">')
      else out.push('</pre>')
      return
    }
    if (inCode) { out.push(line.replace(/</g, '&lt;').replace(/>/g, '&gt;') + '\n'); return }

    // ── Table rows ──────────────────────────────────────────────────────────
    if (trimmed.startsWith('|')) {
      closeList()
      if (isTableSeparator(trimmed)) return  // skip separator row

      if (!inTable) {
        // First row → header
        inTable = true
        out.push('<div style="overflow-x:auto;-webkit-overflow-scrolling:touch;margin:12px 0;border-radius:8px;border:1px solid #e5e7eb;">')
        out.push('<table style="width:100%;border-collapse:collapse;font-size:0.85rem;min-width:400px;">')
        out.push('<thead>')
        out.push('<tr>')
        for (const cell of parseTableRow(trimmed)) {
          out.push(`<th style="text-align:left;padding:9px 14px;background:#f1f5f9;font-weight:700;color:#1e293b;border-bottom:2px solid #e2e8f0;white-space:nowrap;font-size:0.8rem;text-transform:uppercase;letter-spacing:0.04em;">${applyInline(cell)}</th>`)
        }
        out.push('</tr></thead><tbody>')
        tableHeaderDone = true
      } else {
        // Data row — zebra striping
        const cells = parseTableRow(trimmed)
        const rowBg = tableRowIndex % 2 === 0 ? '#ffffff' : '#f9fafb'
        tableRowIndex++
        out.push(`<tr style="border-bottom:1px solid #f3f4f6;background:${rowBg};">`)
        cells.forEach((cell, ci) => {
          const isFirst = ci === 0
          out.push(`<td style="padding:9px 14px;vertical-align:top;color:${isFirst ? '#111827' : '#374151'};font-weight:${isFirst ? '600' : '400'};font-size:0.85rem;">${applyInline(cell)}</td>`)
        })
        out.push('</tr>')
      }
      return
    }

    // Not a table row — close table if open
    if (inTable) closeTable()

    // HR
    if (/^---+$/.test(trimmed)) { closeAll(); out.push('<hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0;">'); return }

    // Headings
    // Skip ## SECTION N: lines — the SectionHeader component already shows the title
    if (/^## SECTION \d+/i.test(trimmed)) { closeAll(); return }
    if (line.startsWith('#### ')) { closeList(); out.push(`<h4 style="font-size:0.875rem;font-weight:700;color:#374151;margin:14px 0 4px;text-transform:uppercase;letter-spacing:0.04em;">${applyInline(line.slice(5))}</h4>`); return }
    if (line.startsWith('### '))  { closeList(); out.push(`<h3 style="font-size:0.95rem;font-weight:700;color:#1e293b;margin:22px 0 8px;padding:6px 10px 6px 14px;background:#f8fafc;border-left:3px solid ${accentColor};border-radius:0 6px 6px 0;">${applyInline(line.slice(4))}</h3>`); return }
    if (line.startsWith('## '))   { closeList(); out.push(`<h2 style="font-size:1.05rem;font-weight:800;color:#111827;margin:24px 0 10px;padding-bottom:6px;border-bottom:2px solid #e5e7eb;">${applyInline(line.slice(3))}</h2>`); return }
    if (line.startsWith('# '))    { closeList(); out.push(`<h1 style="font-size:1.2rem;font-weight:900;color:#111827;margin:24px 0 10px;">${applyInline(line.slice(2))}</h1>`); return }

    // Checkbox list items (- [ ] and - [x])
    if (/^[-*] \[[ xX]\]/.test(line)) {
      if (inOl) { out.push('</ol>'); inOl = false }
      if (!inUl) { out.push('<ul style="margin:8px 0 8px 20px;padding:0;list-style:none;">'); inUl = true }
      const checked = /\[[xX]\]/.test(line)
      const text = line.replace(/^[-*] \[[ xX]\]\s*/, '')
      out.push(`<li style="margin:3px 0;color:#374151;font-size:0.95rem;display:flex;align-items:flex-start;gap:6px;list-style:none;"><span style="margin-top:2px;color:${checked ? '#16a34a' : '#9ca3af'};">${checked ? '✓' : '○'}</span>${applyInline(text)}</li>`)
      return
    }

    // Unordered list
    if (/^[*\-] /.test(line)) {
      if (inOl) { out.push('</ol>'); inOl = false }
      if (!inUl) { out.push('<ul style="margin:8px 0 8px 20px;padding:0;list-style:disc;">'); inUl = true }
      out.push(`<li style="margin:3px 0;color:#374151;font-size:0.95rem;">${applyInline(line.slice(2))}</li>`)
      return
    }

    // Ordered list
    const olMatch = line.match(/^(\d+)\. (.+)/)
    if (olMatch) {
      if (inUl) { out.push('</ul>'); inUl = false }
      if (!inOl) { out.push('<ol style="margin:8px 0 8px 20px;padding:0;list-style:decimal;">'); inOl = true }
      out.push(`<li style="margin:3px 0;color:#374151;font-size:0.95rem;">${applyInline(olMatch[2])}</li>`)
      return
    }

    // Blank line → close lists or paragraph gap
    if (trimmed === '') { closeList(); out.push('<div style="height:6px;"></div>'); return }

    // Regular paragraph text — with #11 verify-link hint for claims with badges
    closeList()
    const hasBadge = /\*\*\[(KNOWN|RESEARCH REQUIRED|VERIFY|LIKELY|CONFIRMED)\]\*\*/.test(line)
    const verifyHint = hasBadge
      ? ` <a href="https://www.google.com/search?q=${encodeURIComponent(line.replace(/\*\*\[[A-Z ]+\]\*\*/g,'').replace(/\*\*/g,'').slice(0,80).trim())}" target="_blank" rel="noopener noreferrer" style="display:inline-block;font-size:0.7rem;color:#6b7280;text-decoration:none;border:1px solid #d1d5db;border-radius:4px;padding:1px 5px;margin-left:4px;vertical-align:middle;" title="Verify this claim">⌕</a>`
      : ''
    out.push(`<p style="margin:5px 0;color:#374151;font-size:0.95rem;line-height:1.65;">${applyInline(line)}${verifyHint}</p>`)
  })

  closeAll()
  // XSS guard: AI/markdown content must never reach the DOM unsanitized
  return sanitizeHtml(out.join(''))
}

// ─── Build full print-ready HTML document ────────────────────────────────────
function buildPrintHtml(dossier, sections) {
  const title = dossier.title || 'Political Profile'
  const candidate = dossier.candidate
  const generatedAt = dossier.generated_at ? format(new Date(dossier.generated_at), 'MMMM d, yyyy') : ''
  const { snapshot } = extractSnapshot(dossier.content)
  const snapshotHtml = snapshot
    ? `<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:12px;padding:16px 18px;margin-bottom:24px;">
         <div style="font-size:0.65rem;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;color:#b91c1c;margin-bottom:6px;">Snapshot</div>
         <div style="font-size:1rem;line-height:1.55;color:#1f2937;font-weight:500;">${escapeHtml(snapshot)}</div>
       </div>`
    : ''

  const sectionsHtml = sections.map(s => `
    <section style="page-break-inside:avoid;margin-bottom:32px;">
      <div style="border-top:3px solid #1e3a5f;padding-top:16px;margin-bottom:12px;">
        <h2 style="font-size:1.1rem;font-weight:800;color:#1e3a5f;margin:0;">${escapeHtml(s.label)}</h2>
      </div>
      ${mdToHtml(s.displayContent || s.content)}
    </section>
  `).join('')

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)}</title>
  <style>
    @page { margin: 1in; }
    * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; box-sizing: border-box; }
    body { font-family: Arial, sans-serif; font-size: 11pt; line-height: 1.5; color: #1a1a1a; margin: 0; }
    .header { border-bottom: 3px solid #b91c1c; padding-bottom: 16px; margin-bottom: 24px; }
    .header h1 { font-size: 1.4rem; font-weight: 900; color: #1e3a5f; margin: 0 0 4px; }
    .meta { font-size: 0.85rem; color: #6b7280; }
    .footer { border-top: 1px solid #d1d5db; margin-top: 40px; padding-top: 10px; font-size: 0.75rem; color: #9ca3af; }
  </style>
</head>
<body>
  <div class="header">
    <h1>${escapeHtml(title)}</h1>
    <div class="meta">
      ${candidate?.office?.name ? `Office: ${escapeHtml(candidate.office.name)}` : ''}
      ${candidate?.party ? ` · ${escapeHtml(candidate.party)}` : ''}
      ${generatedAt ? ` · Generated ${generatedAt}` : ''}
    </div>
  </div>
  ${snapshotHtml}
  ${sectionsHtml}
  <div class="footer">
    Badger Board · AI-Generated Political Intelligence · The Bluejack Group · Verify all information through official sources before use.
  </div>
</body>
</html>`
}

// ─── Source → domain mapping (Wisconsin news outlets + social platforms) ──────
const SOURCE_DOMAIN_MAP = {
  // Wisconsin TV / Radio
  'WSAU': 'wsau.com', 'WKOW': 'wkow.com', 'WEAU': 'weau.com', 'WBAY': 'wbay.com',
  'WSAW': 'wsaw.com', 'WXOW': 'wxow.com', 'WITI': 'fox6now.com', 'FOX6': 'fox6now.com',
  'WTMJ': 'wtmj.com', 'WISN': 'wisn.com', 'TMJ4': 'tmj4.com', 'WFRV': 'wfrv.com',
  'WLUK': 'fox11online.com', 'NBC15': 'nbc15.com', 'CBS58': 'cbs58.com',
  'WPR': 'wpr.org', 'Wisconsin Public Radio': 'wpr.org',
  // Wisconsin Print / Web
  'Milwaukee Journal Sentinel': 'jsonline.com', 'Journal Sentinel': 'jsonline.com',
  'Wisconsin State Journal': 'madison.com', 'Cap Times': 'captimes.com',
  'Capital Times': 'captimes.com', 'Wausau Daily Herald': 'wausaudailyherald.com',
  'Green Bay Press-Gazette': 'greenbaypressgazette.com',
  'Appleton Post-Crescent': 'postcrescent.com', 'La Crosse Tribune': 'lacrossetribune.com',
  'Sheboygan Press': 'sheboyganpress.com', 'Fond du Lac Reporter': 'fdlreporter.com',
  'Stevens Point Journal': 'stevenspointjournal.com', 'Oshkosh Northwestern': 'thenorthwestern.com',
  'Racine Journal Times': 'journaltimes.com', 'Kenosha News': 'kenoshanews.com',
  'Janesville Gazette': 'gazettextra.com', 'WisconsinEye': 'wiseye.org',
  'WisEye': 'wiseye.org', 'Wisconsin Watch': 'wisconsinwatch.org',
  'Urban Milwaukee': 'urbanmilwaukee.com', 'Shepherd Express': 'shepherdexpress.com',
  'Isthmus': 'isthmus.com', 'WisPolitics': 'wispolitics.com',
  'Wisconsin Examiner': 'wisconsinexaminer.com', 'WisContext': 'wiscontext.org',
  'Wisconsin Elections Commission': 'elections.wi.gov',
  // National / Wire
  'AP': 'apnews.com', 'Associated Press': 'apnews.com', 'Reuters': 'reuters.com',
  'Politico': 'politico.com', 'The Hill': 'thehill.com', 'NPR': 'npr.org',
  // Social Media
  'Facebook': 'facebook.com', 'Twitter': 'twitter.com', 'X': 'x.com',
  'Instagram': 'instagram.com', 'YouTube': 'youtube.com',
  'LinkedIn': 'linkedin.com', 'TikTok': 'tiktok.com',
}

const SOCIAL_PLATFORMS = new Set(['facebook', 'twitter', 'x', 'instagram', 'youtube', 'linkedin', 'tiktok'])

function isSocialSource(source = '') {
  const lower = source.toLowerCase()
  return SOCIAL_PLATFORMS.has(lower) ||
    lower.includes('facebook') || lower.includes('twitter') ||
    lower.includes('instagram') || lower.includes('youtube') ||
    lower.includes('linkedin') || lower.includes('tiktok')
}

function getDomainForSource(source = '', url = null) {
  try { if (url) return new URL(url).hostname.replace(/^www\./, '') } catch {}
  if (!source) return null
  if (SOURCE_DOMAIN_MAP[source]) return SOURCE_DOMAIN_MAP[source]
  for (const [key, domain] of Object.entries(SOURCE_DOMAIN_MAP)) {
    if (source.toLowerCase().includes(key.toLowerCase()) || key.toLowerCase().includes(source.toLowerCase())) {
      return domain
    }
  }
  return null
}

// ─── Section 1 News Item Parser ───────────────────────────────────────────────
// Parses AI-generated Section 1 content into structured news item objects.
// Expected format:
//   ### [Title](url)   ← with or without link
//   **Source** · Date  **[FLAG]**
//   Description text.
function parseSection1NewsItems(content = '') {
  const items = []
  const lines = content.split('\n')
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    if (line.startsWith('### ')) {
      const headingText = line.slice(4).trim()
      const linkMatch = headingText.match(/^\[([^\]]+)\]\((https?:\/\/[^)]+)\)\s*$/)
      const title = linkMatch ? linkMatch[1] : headingText.replace(/\*\*/g, '').replace(/`/g, '')
      const url   = linkMatch ? linkMatch[2] : null
      if (!title || title.length < 3) { i++; continue }

      let source = '', date = '', flag = null, j = i + 1
      while (j < lines.length && !lines[j].trim()) j++
      if (j < lines.length) {
        const srcLine = lines[j].trim()
        const srcMatch = srcLine.match(/^\*\*([^*]+)\*\*\s*[·•\-–]\s*(.+)/)
        if (srcMatch) {
          source = srcMatch[1].trim()
          const dateRaw = srcMatch[2]
          const badgeMatch = dateRaw.match(/\*\*\[([A-Za-z ]+)\]\*\*/)
          if (badgeMatch) flag = badgeMatch[1].toUpperCase()
          date = dateRaw.replace(/\*\*\[[A-Za-z ]+\]\*\*/g, '').replace(/\*\*/g, '').trim()
          j++
        }
      }

      const descParts = []
      while (j < lines.length) {
        const dl = lines[j].trim()
        if (!dl || dl.startsWith('##') || dl.startsWith('---')) break
        if (!flag) {
          const badgeMatch = dl.match(/\*\*\[([A-Za-z ]+)\]\*\*/)
          if (badgeMatch) flag = badgeMatch[1].toUpperCase()
        }
        const cleaned = dl.replace(/\*\*\[[A-Za-z ]+\]\*\*/g, '').replace(/\*\*/g, '').trim()
        if (cleaned) descParts.push(cleaned)
        j++
      }

      const domain    = getDomainForSource(source, url)
      const isSocial  = isSocialSource(source)
      const searchUrl = url || `https://www.google.com/search?q=${encodeURIComponent((title + ' ' + source).trim())}`

      items.push({ title, url, searchUrl, source, date, description: descParts.join(' ').slice(0, 250), flag, domain, isSocial })
      i = j
    } else {
      i++
    }
  }
  return items
}

// ─── News Item Card (Section 1) ───────────────────────────────────────────────
const FLAG_CHIP_COLORS = {
  'VERIFY':             'bg-yellow-100 text-yellow-700 border-yellow-200',
  'RESEARCH REQUIRED':  'bg-amber-100 text-amber-700 border-amber-200',
  'LIKELY':             'bg-purple-100 text-purple-700 border-purple-200',
  'KNOWN':              'bg-green-100 text-green-700 border-green-200',
  'HIGH':               'bg-red-100 text-red-700 border-red-200',
  'MEDIUM':             'bg-orange-100 text-orange-700 border-orange-200',
}

function NewsItemCard({ title, url, searchUrl, source, date, description, flag, domain }) {
  const [imgError, setImgError]       = React.useState(false)
  const [showTooltip, setShowTooltip] = React.useState(false)
  const faviconSrc = domain && !imgError
    ? `https://www.google.com/s2/favicons?domain=${domain}&sz=32`
    : null
  const flagColor = flag ? (FLAG_CHIP_COLORS[flag] || 'bg-gray-100 text-gray-600 border-gray-200') : null
  const href = searchUrl || url

  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="block no-underline">
      <div className="flex items-start gap-3 p-3 rounded-xl border border-gray-200 hover:border-blue-300 hover:bg-blue-50/40 cursor-pointer transition-colors group">
        <div className="w-6 h-6 flex-shrink-0 mt-0.5 rounded overflow-hidden flex items-center justify-center bg-gray-50 border border-gray-100">
          {faviconSrc ? (
            <img src={faviconSrc} alt={source || 'source'} className="w-4 h-4 object-contain" onError={() => setImgError(true)} />
          ) : (
            <FileText className="w-3.5 h-3.5 text-blue-400" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold leading-snug text-gray-900 group-hover:text-blue-700">{title}</p>
          {(source || date) && (
            <p className="text-xs text-gray-500 mt-0.5">{[source, date].filter(Boolean).join(' · ')}</p>
          )}
          {description && <p className="text-xs text-gray-600 mt-1 leading-relaxed">{description}</p>}
        </div>
        <div className="flex flex-col items-end gap-1 flex-shrink-0 ml-1">
          {flag && (
            <div className="relative" onMouseEnter={() => setShowTooltip(true)} onMouseLeave={() => setShowTooltip(false)}>
              <span className={`inline-flex items-center gap-1 text-xs font-semibold px-1.5 py-0.5 rounded border ${flagColor}`}>
                <AlertCircle className="w-3 h-3" />
                Flagged
              </span>
              {showTooltip && (
                <div className="absolute right-0 top-6 z-50 bg-gray-900 text-white text-xs rounded-lg px-2.5 py-1.5 whitespace-nowrap shadow-lg pointer-events-none">
                  {flag}
                </div>
              )}
            </div>
          )}
          <div className="opacity-0 group-hover:opacity-100 transition-opacity">
            <svg className="w-3.5 h-3.5 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
          </div>
        </div>
      </div>
    </a>
  )
}

// ─── Section 1 Renderer: two-panel layout (News | Social) or fallback ─────────
function Section1Renderer({ content }) {
  if (!content) return null

  let items = []
  try { items = parseSection1NewsItems(content) } catch (e) { /* fall through */ }

  // Only use card layout for items that have actual news source data.
  // Items with empty source + no URL are subsection headers (old format) — fall through to markdown.
  const qualifiedItems = items.filter(it => it.source || it.url)

  if (qualifiedItems.length >= 1) {
    const headerLines = []
    const lines = content.split('\n')
    for (const line of lines) {
      if (line.startsWith('### ')) break
      headerLines.push(line)
    }
    const headerHtml = headerLines.join('\n').trim()

    const newsItems   = qualifiedItems.filter(it => !it.isSocial)
    const socialItems = qualifiedItems.filter(it => it.isSocial)

    // Single-column when there are no social items
    if (socialItems.length === 0) {
      return (
        <div>
          {headerHtml && <div className="prose-dossier mb-4" dangerouslySetInnerHTML={{ __html: mdToHtml(headerHtml) }} />}
          <div className="space-y-2">
            {newsItems.map((item, idx) => <NewsItemCard key={idx} {...item} />)}
          </div>
        </div>
      )
    }

    // Two-column: News Coverage | Social Media Feed
    return (
      <div>
        {headerHtml && <div className="prose-dossier mb-4" dangerouslySetInnerHTML={{ __html: mdToHtml(headerHtml) }} />}
        <div className="flex gap-4">
          {/* News Coverage panel */}
          <div className="flex-1 bg-white rounded-xl border border-gray-200 p-4">
            <div className="flex items-center gap-2 mb-3 pb-2 border-b border-gray-100">
              <Newspaper className="w-4 h-4 text-blue-600" />
              <h4 className="text-sm font-bold text-gray-800">News Coverage</h4>
              {newsItems.length > 0 && <span className="text-xs text-gray-400 ml-auto">{newsItems.length}</span>}
            </div>
            {newsItems.length > 0 ? (
              <div className="space-y-2">
                {newsItems.map((item, idx) => <NewsItemCard key={idx} {...item} />)}
              </div>
            ) : (
              <p className="text-xs text-gray-400 italic py-2">No press items found</p>
            )}
          </div>
          {/* Social Media Feed panel */}
          <div className="flex-1 bg-white rounded-xl border border-gray-200 p-4">
            <div className="flex items-center gap-2 mb-3 pb-2 border-b border-gray-100">
              <MessageSquare className="w-4 h-4 text-purple-600" />
              <h4 className="text-sm font-bold text-gray-800">Social Media Feed</h4>
              {socialItems.length > 0 && <span className="text-xs text-gray-400 ml-auto">{socialItems.length}</span>}
            </div>
            {socialItems.length > 0 ? (
              <div className="space-y-2">
                {socialItems.map((item, idx) => <NewsItemCard key={idx} {...item} />)}
              </div>
            ) : (
              <p className="text-xs text-gray-400 italic py-2">No social posts found</p>
            )}
          </div>
        </div>
      </div>
    )
  }

  // Fallback: render as styled markdown (old-format profiles, or no structured items found)
  return (
    <div>
      <div className="prose-dossier" dangerouslySetInnerHTML={{ __html: mdToHtml(content) }} />
      <div className="mt-4 bg-blue-50 border border-blue-200 rounded-xl px-3 py-2 flex items-center gap-2">
        <Sparkles className="w-3.5 h-3.5 text-blue-500 flex-shrink-0" />
        <p className="text-xs text-blue-700">
          <span className="font-semibold">Card layout unavailable.</span> Regenerate this profile to get clickable news cards with favicons and the side-by-side News / Social feed view.
        </p>
      </div>
    </div>
  )
}

// ─── Section 6 Blur / Upsell Overlay ─────────────────────────────────────────
// Section 6 & 13 (Opposition Research) require top-tier plans only.
// Candidate Campaign (c_campaign) or Agency Campaign (a_campaign) — and legacy aliases.
const SECTION6_TIERS = new Set(['campaign', 'agency', 'c_campaign', 'a_campaign'])

function Section6Upsell({ content }) {
  return (
    <div className="relative rounded-xl overflow-hidden">
      <div
        className="pointer-events-none select-none"
        style={{ filter: 'blur(5px)', WebkitFilter: 'blur(5px)', opacity: 0.7 }}
        aria-hidden="true"
      >
        <div dangerouslySetInnerHTML={{ __html: mdToHtml(content) }} />
      </div>
      <div className="absolute inset-0 flex items-center justify-center bg-white/50">
        <div className="bg-white rounded-2xl shadow-xl border border-gray-200 p-6 text-center max-w-sm mx-4">
          <div className="w-12 h-12 bg-amber-100 rounded-2xl flex items-center justify-center mx-auto mb-3">
            <AlertTriangle className="w-6 h-6 text-amber-600" />
          </div>
          <h3 className="font-bold text-gray-900 text-base mb-2">Opposition Research Findings</h3>
          <p className="text-sm text-gray-500 mb-1 leading-relaxed">
            Section 6 is available exclusively on <span className="font-semibold text-gray-700">Campaign</span> and <span className="font-semibold text-gray-700">Agency</span> plans.
          </p>
          <p className="text-xs text-gray-400 mb-4">
            Includes campaign finance findings, public record inconsistencies, and opposition research priorities.
          </p>
          <Link
            to="/plans"
            className="inline-flex items-center gap-2 bg-brand-red text-white text-sm font-semibold px-4 py-2 rounded-xl hover:bg-red-700 transition-colors"
          >
            Upgrade to Unlock →
          </Link>
          <p className="text-xs text-gray-400 mt-3">Action plans from $89/mo</p>
        </div>
      </div>
    </div>
  )
}

// ─── Scout Lite Profile Gate ──────────────────────────────────────────────────
function LiteProfileGate({ sectionLabel, content }) {
  return (
    <div className="relative rounded-xl overflow-hidden">
      <div
        className="pointer-events-none select-none"
        style={{ filter: 'blur(5px)', WebkitFilter: 'blur(5px)', opacity: 0.6 }}
        aria-hidden="true"
      >
        <div dangerouslySetInnerHTML={{ __html: mdToHtml(content) }} />
      </div>
      <div className="absolute inset-0 flex items-center justify-center bg-white/50">
        <div className="bg-white rounded-2xl shadow-xl border border-gray-200 p-6 text-center max-w-sm mx-4">
          <div className="w-12 h-12 bg-blue-100 rounded-2xl flex items-center justify-center mx-auto mb-3">
            <ShieldCheck className="w-6 h-6 text-blue-600" />
          </div>
          <h3 className="font-bold text-gray-900 text-base mb-2">{sectionLabel}</h3>
          <p className="text-sm text-gray-500 mb-1 leading-relaxed">
            This section is available on <span className="font-semibold text-gray-700">Candidate Monitor</span> and above.
          </p>
          <p className="text-xs text-gray-400 mb-4">
            Scout plan includes Biography, Political Record, and 2 Affiliations for free.
          </p>
          <Link
            to="/plans"
            className="inline-flex items-center gap-2 bg-brand-red text-white text-sm font-semibold px-4 py-2 rounded-xl hover:bg-red-700 transition-colors"
          >
            Upgrade to Unlock →
          </Link>
          <p className="text-xs text-gray-400 mt-3">Monitor plans from $29/mo</p>
        </div>
      </div>
    </div>
  )
}

// ─── Dossier Header Disclaimer Banner ─────────────────────────────────────────
function DossierDisclaimerBanner() {
  const [open, setOpen] = useState(false)
  return (
    <div className="flex-shrink-0">
      <div className="bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 flex items-start gap-2.5">
        <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold text-amber-800">AI-Generated — Independent Verification Required</p>
          {open && (
            <p className="text-xs text-amber-700 mt-1 leading-relaxed">
              This report is generated by an AI system from publicly available sources and has NOT been independently verified.
              All information must be verified before use in any campaign, publication, or professional context. Do not use for
              FCRA-regulated purposes. Do not use in formal legal proceedings without independent corroboration.
              Publishing unverified AI-generated content may expose you to defamation liability under Wis. Stat. § 895.05.
              The Bluejack Group assumes no liability for inaccuracies in AI-generated content.{' '}
              <a href="/dossier-disclaimer" target="_blank" rel="noopener noreferrer" className="underline font-medium">View full disclaimer →</a>
            </p>
          )}
        </div>
        <button onClick={() => setOpen(o => !o)} className="text-amber-600 hover:text-amber-800 flex-shrink-0">
          <ChevronRight className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-90' : ''}`} />
        </button>
      </div>
    </div>
  )
}

// ─── Parse flagged claims from dossier content ────────────────────────────────
function parseFlaggedClaims(content = '') {
  const flagged = []
  const lines   = content.split('\n')
  let currentSection = 'overview'

  lines.forEach(line => {
    const sectionMatch = line.match(/^## SECTION (\d+)/i)
    if (sectionMatch) { currentSection = `section-${sectionMatch[1]}`; return }

    // Find lines containing [Verify], [RESEARCH REQUIRED], or [Likely] badges
    if (/\*\*\[(VERIFY|RESEARCH REQUIRED|LIKELY)\]\*\*/i.test(line)) {
      const clean = line
        .replace(/^[#*\-•\d.]+\s*/, '')
        .replace(/\*\*\[([A-Z ]+)\]\*\*/g, '[$1]')
        .replace(/\*\*/g, '')
        .trim()
      if (clean.length > 15) {
        flagged.push({
          id:         `${currentSection}::${clean.slice(0, 60)}`,
          sectionId:  currentSection,
          text:       clean.slice(0, 300),
          badge:      /RESEARCH REQUIRED/i.test(line) ? 'RESEARCH REQUIRED' : /VERIFY/i.test(line) ? 'Verify' : 'Likely',
        })
      }
    }
  })

  // Deduplicate by id
  const seen = new Set()
  return flagged.filter(f => { if (seen.has(f.id)) return false; seen.add(f.id); return true })
}

// ─── Claim Reviewer Panel ─────────────────────────────────────────────────────
function ClaimReviewer({ dossier, onClose }) {
  const { user }                = useAuth()
  const [reviews, setReviews]   = useState({}) // id → { status, note }
  const [saving, setSaving]     = useState(null)
  const [savedIds, setSavedIds] = useState(new Set())
  const [noteOpen, setNoteOpen] = useState(null)
  const [noteText, setNoteText] = useState('')
  const [loadError, setLoadError] = useState('')

  const claims = parseFlaggedClaims(dossier.content)

  const getToken = async () => {
    const { data: { session } } = await supabase.auth.getSession()
    return session?.access_token || null
  }

  useEffect(() => {
    // Load existing reviews for this dossier
    const load = async () => {
      try {
        const token = await getToken()
        if (!token) return
        const res = await fetch('/.netlify/functions/dossier-review', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ action: 'get_reviews', dossier_id: dossier.id }),
        })
        const data = await res.json()
        if (data.reviews) {
          const map = {}
          data.reviews.forEach(r => {
            const key = `${r.section_id}::${r.claim_text.slice(0, 60)}`
            map[key] = { status: r.status, note: r.note || '' }
          })
          setReviews(map)
          setSavedIds(new Set(Object.keys(map)))
        }
      } catch {}
    }
    if (dossier?.id) load()
  }, [dossier?.id])

  const saveReview = async (claim, status) => {
    setSaving(claim.id)
    try {
      const token = await getToken()
      if (!token) throw new Error('Not authenticated')
      await fetch('/.netlify/functions/dossier-review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          action:     'save_review',
          dossier_id: dossier.id,
          section_id: claim.sectionId,
          claim_text: claim.text,
          status,
          note:       reviews[claim.id]?.note || '',
        }),
      })
      setReviews(prev => ({ ...prev, [claim.id]: { status, note: prev[claim.id]?.note || '' } }))
      setSavedIds(prev => new Set([...prev, claim.id]))
    } catch (err) {
      setLoadError(err.message || 'Save failed')
    }
    setSaving(null)
  }

  const BADGE_COLOR = {
    'RESEARCH REQUIRED': 'bg-amber-100 text-amber-800 border border-amber-200',
    'Verify':            'bg-yellow-100 text-yellow-800 border border-yellow-200',
    'Likely':            'bg-purple-100 text-purple-800 border border-purple-200',
  }

  const STATUS_BUTTONS = [
    { status: 'confirmed',      icon: ThumbsUp,   label: 'Confirmed',      color: 'text-green-700 bg-green-50 border-green-200 hover:bg-green-100'   },
    { status: 'rejected',       icon: ThumbsDown, label: 'Rejected',       color: 'text-red-700 bg-red-50 border-red-200 hover:bg-red-100'           },
    { status: 'needs_research', icon: HelpCircle, label: 'Needs Research', color: 'text-amber-700 bg-amber-50 border-amber-200 hover:bg-amber-100'   },
  ]

  return (
    <div className="flex flex-col h-full bg-white border-l border-gray-200">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
        <div className="flex items-center gap-2">
          <MessageSquare className="w-4 h-4 text-brand-red" />
          <span className="text-sm font-bold text-gray-900">Claim Review</span>
          <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">{claims.length} flagged</span>
        </div>
        <button onClick={onClose} className="p-1 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-600">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
        {claims.length === 0 && (
          <p className="text-xs text-gray-400 text-center py-8 italic">No flagged claims found in this profile.</p>
        )}

        {loadError && (
          <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">{loadError}</p>
        )}

        {/* Progress summary */}
        {claims.length > 0 && (
          <div className="bg-gray-50 rounded-lg px-3 py-2">
            <div className="flex items-center justify-between text-xs text-gray-600">
              <span className="font-medium">{savedIds.size} of {claims.length} reviewed</span>
              {savedIds.size === claims.length && (
                <span className="text-green-700 font-semibold flex items-center gap-1">
                  <CheckCircle className="w-3.5 h-3.5" /> All reviewed
                </span>
              )}
            </div>
            <div className="h-1.5 bg-gray-200 rounded-full mt-1.5 overflow-hidden">
              <div
                className="h-full bg-brand-red rounded-full transition-all duration-500"
                style={{ width: `${Math.round((savedIds.size / Math.max(claims.length, 1)) * 100)}%` }}
              />
            </div>
          </div>
        )}

        {claims.map(claim => {
          const review   = reviews[claim.id]
          const isSaved  = savedIds.has(claim.id)
          const isSaving = saving === claim.id

          return (
            <div key={claim.id} className={`rounded-xl border p-3 transition-colors ${isSaved ? 'border-gray-200 bg-gray-50/60' : 'border-amber-200 bg-amber-50/40'}`}>
              <div className="flex items-start gap-2 mb-2">
                <span className={`text-xs font-bold px-1.5 py-0.5 rounded flex-shrink-0 ${BADGE_COLOR[claim.badge] || 'bg-gray-100 text-gray-700'}`}>
                  {claim.badge}
                </span>
                <span className="text-xs text-gray-500 flex-shrink-0">{claim.sectionId.replace('section-', '§')}</span>
              </div>
              <p className="text-xs text-gray-800 leading-relaxed mb-2.5 line-clamp-3" title={claim.text}>{claim.text}</p>

              {/* Action buttons */}
              <div className="flex gap-1.5 flex-wrap">
                {STATUS_BUTTONS.map(({ status, icon: Icon, label, color }) => (
                  <button
                    key={status}
                    onClick={() => saveReview(claim, status)}
                    disabled={isSaving}
                    className={`flex items-center gap-1 text-xs px-2 py-1 rounded-lg border font-medium transition-all ${color} ${review?.status === status ? 'ring-2 ring-offset-1 ring-current opacity-100' : 'opacity-80'} ${isSaving ? 'opacity-40 cursor-not-allowed' : ''}`}
                  >
                    <Icon className="w-3 h-3" />
                    {label}
                    {review?.status === status && <Check className="w-3 h-3" />}
                  </button>
                ))}
              </div>

              {/* Note toggle */}
              {isSaved && (
                <div className="mt-2">
                  {noteOpen === claim.id ? (
                    <div className="space-y-1.5">
                      <textarea
                        className="w-full text-xs border border-gray-200 rounded-lg p-2 resize-none focus:ring-1 focus:ring-brand-red focus:border-brand-red"
                        rows={2}
                        placeholder="Add a note (optional)..."
                        value={noteText}
                        onChange={e => setNoteText(e.target.value)}
                      />
                      <div className="flex gap-2">
                        <button
                          onClick={() => {
                            setReviews(prev => ({ ...prev, [claim.id]: { ...prev[claim.id], note: noteText } }))
                            setNoteOpen(null)
                          }}
                          className="text-xs text-brand-red font-medium hover:underline"
                        >Save note</button>
                        <button onClick={() => setNoteOpen(null)} className="text-xs text-gray-400 hover:text-gray-600">Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <button
                      onClick={() => { setNoteOpen(claim.id); setNoteText(reviews[claim.id]?.note || '') }}
                      className="text-xs text-gray-400 hover:text-gray-600 flex items-center gap-1 mt-1"
                    >
                      <MessageSquare className="w-3 h-3" />
                      {reviews[claim.id]?.note ? 'Edit note' : 'Add note'}
                    </button>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div className="px-3 py-2.5 border-t border-gray-100 bg-gray-50">
        <p className="text-xs text-gray-500 leading-relaxed">
          Reviewing flagged claims creates an audit trail demonstrating your independent evaluation of AI-generated content before use.
        </p>
      </div>
    </div>
  )
}

// ─── #4: Stale data indicator ─────────────────────────────────────────────────
function StaleBanner({ generatedAt, onRegenerate, regenerating }) {
  if (!generatedAt) return null
  const ageMs   = Date.now() - new Date(generatedAt).getTime()
  const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24))
  if (ageDays < 30) return null

  const level = ageDays >= 90 ? 'red' : ageDays >= 60 ? 'orange' : 'amber'
  const styles = {
    red:    { bg: 'bg-red-50',    border: 'border-red-200',    text: 'text-red-800',    icon: 'text-red-500'    },
    orange: { bg: 'bg-orange-50', border: 'border-orange-200', text: 'text-orange-800', icon: 'text-orange-500' },
    amber:  { bg: 'bg-amber-50',  border: 'border-amber-200',  text: 'text-amber-800',  icon: 'text-amber-500'  },
  }[level]

  return (
    <div className={`flex items-center gap-2 px-3 py-2 rounded-lg border ${styles.bg} ${styles.border} text-xs`}>
      <AlertTriangle className={`w-3.5 h-3.5 flex-shrink-0 ${styles.icon}`} />
      <span className={`font-medium ${styles.text} flex-1`}>
        This profile is <strong>{ageDays} days old</strong> — data may be outdated.
        {ageDays >= 60 && ' Significant changes may have occurred since generation.'}
      </span>
      <button
        onClick={onRegenerate}
        disabled={regenerating}
        className={`flex-shrink-0 flex items-center gap-1 font-semibold underline hover:no-underline ${styles.text}`}
      >
        <RefreshCw className={`w-3 h-3 ${regenerating ? 'animate-spin' : ''}`} />
        Refresh
      </button>
    </div>
  )
}

// ─── Share Modal (v1.19: consolidated sharing — PDF export + timed links) ─────
// Expiry range: minimum 1 hour, maximum 7 days.
const EXPIRY_OPTIONS = [
  { value: 1,   label: '1 Hour'   },
  { value: 3,   label: '3 Hours'  },
  { value: 12,  label: '12 Hours' },
  { value: 24,  label: '24 Hours' },
  { value: 72,  label: '3 Days'   },
  { value: 168, label: '7 Days'   },
]

function ShareModal({ dossier, onClose, onExportPdf }) {
  const { user }                    = useAuth()
  const [step, setStep]             = useState('disclosure') // disclosure | create | manage
  const [expiresIn, setExpiresIn]   = useState(24)
  const [creating, setCreating]     = useState(false)
  const [newLink, setNewLink]       = useState(null) // { share_url, expires_at, id }
  const [copied, setCopied]         = useState(false)
  const [shares, setShares]         = useState([])
  const [loadingShares, setLoading] = useState(false)
  const [deactivating, setDeact]    = useState(null)
  const [error, setError]           = useState('')

  const getToken = async () => {
    const { data: { session } } = await supabase.auth.getSession()
    return session?.access_token || null
  }

  // Load existing shares on open
  useEffect(() => {
    const load = async () => {
      setLoading(true)
      try {
        const token = await getToken()
        const res = await fetch('/.netlify/functions/get-shared-dossier', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ action: 'list', dossier_id: dossier.id }),
        })
        const data = await res.json()
        if (data.shares) setShares(data.shares)
      } catch {}
      setLoading(false)
    }
    if (dossier?.id) load()
  }, [dossier?.id])

  const handleCreate = async () => {
    setCreating(true); setError('')
    try {
      const token = await getToken()
      const res = await fetch('/.netlify/functions/create-dossier-share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ dossier_id: dossier.id, expires_hours: expiresIn }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error || 'Failed to create link'); setCreating(false); return }
      setNewLink(data)
      setShares(prev => [{ id: data.id, token: data.token, expires_at: data.expires_at, view_count: 0, is_active: true, created_at: new Date().toISOString() }, ...prev])
      setStep('manage')
    } catch (e) { setError(e.message || 'Network error') }
    setCreating(false)
  }

  const handleCopy = (url) => {
    navigator.clipboard?.writeText(url)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleDeactivate = async (shareId) => {
    setDeact(shareId)
    try {
      const token = await getToken()
      await fetch('/.netlify/functions/get-shared-dossier', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'deactivate', share_id: shareId }),
      })
      setShares(prev => prev.map(s => s.id === shareId ? { ...s, is_active: false } : s))
      if (newLink?.id === shareId) setNewLink(null)
    } catch {}
    setDeact(null)
  }

  const APP_URL = 'https://www.badgerboardwi.com'
  const activeShares = shares.filter(s => s.is_active && new Date(s.expires_at) > new Date())

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
      <div className="bg-white rounded-2xl shadow-2xl border border-gray-200 w-full max-w-lg max-h-[90vh] flex flex-col overflow-hidden">
        {/* Modal header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 flex-shrink-0">
          <div className="flex items-center gap-2">
            <Link2 className="w-4 h-4 text-brand-navy" />
            <span className="text-sm font-bold text-gray-900">Share Profile</span>
          </div>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">

          {/* ── Option 1: Export PDF ─────────────────────────────────────── */}
          {step === 'disclosure' && (
            <button
              onClick={() => { onExportPdf?.(); onClose() }}
              className="w-full flex items-center gap-3 p-4 bg-gray-50 border border-gray-200 rounded-xl hover:border-gray-300 hover:bg-gray-100 transition-all text-left"
            >
              <div className="w-9 h-9 rounded-lg bg-brand-navy/10 flex items-center justify-center flex-shrink-0">
                <Download className="w-4 h-4 text-brand-navy" />
              </div>
              <div>
                <p className="text-sm font-bold text-gray-900">Export as PDF</p>
                <p className="text-xs text-gray-500">Download a printable copy of this profile</p>
              </div>
            </button>
          )}

          {step === 'disclosure' && (
            <div className="flex items-center gap-3">
              <div className="flex-1 h-px bg-gray-200" />
              <span className="text-xs text-gray-400 font-semibold">OR SHARE A TIMED LINK</span>
              <div className="flex-1 h-px bg-gray-200" />
            </div>
          )}

          {/* ── Option 2: Generate timed link ─────────────────────────────── */}
          {step === 'disclosure' && (
            <>
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 space-y-2">
                <div className="flex items-center gap-2">
                  <ShieldAlert className="w-4 h-4 text-amber-600 flex-shrink-0" />
                  <span className="text-sm font-bold text-amber-800">Responsibility Disclosure</span>
                </div>
                <p className="text-xs text-amber-800 leading-relaxed">
                  By generating this link, you acknowledge that <strong>you are solely responsible</strong> for who accesses this profile and how they use the information. This profile is AI-generated from publicly available sources and requires independent verification before use.
                </p>
                <p className="text-xs text-amber-700 leading-relaxed">
                  Do not share with anyone who may use this content for FCRA-regulated purposes (employment screening, credit, housing), formal legal proceedings, or publishing without independent corroboration. <strong>The Bluejack Group assumes no liability for the use of shared profile links.</strong>
                </p>
              </div>

              <div className="space-y-2">
                <label className="text-xs font-semibold text-gray-700">Link active for</label>
                <div className="grid grid-cols-3 gap-2">
                  {EXPIRY_OPTIONS.map(opt => (
                    <button
                      key={opt.value}
                      onClick={() => setExpiresIn(opt.value)}
                      className={`py-2.5 px-3 rounded-xl border text-xs font-semibold transition-all ${
                        expiresIn === opt.value
                          ? 'bg-brand-navy text-white border-brand-navy shadow-sm'
                          : 'bg-gray-50 text-gray-600 border-gray-200 hover:border-gray-300'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-gray-400">After this time, the link stops working automatically. Minimum 1 hour, maximum 7 days.</p>
              </div>

              {error && <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>}

              <button
                onClick={handleCreate}
                disabled={creating}
                className="w-full bg-brand-navy text-white text-sm font-bold py-3 rounded-xl hover:bg-navy-700 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {creating ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Link2 className="w-4 h-4" />}
                {creating ? 'Generating link…' : 'I Understand — Generate Link'}
              </button>
            </>
          )}

          {/* ── Step: Link created ───────────────────────────────────────── */}
          {step === 'manage' && newLink && (
            <div className="bg-green-50 border border-green-200 rounded-xl p-4 space-y-3">
              <div className="flex items-center gap-2">
                <CheckCircle className="w-4 h-4 text-green-600" />
                <span className="text-sm font-bold text-green-800">Link Created</span>
                <span className="text-xs text-green-600 ml-auto flex items-center gap-1">
                  <Clock className="w-3 h-3" />
                  Active for {EXPIRY_OPTIONS.find(o => o.value === expiresIn)?.label}
                </span>
              </div>
              <div className="flex items-center gap-2 bg-white border border-green-200 rounded-lg px-3 py-2">
                <span className="flex-1 text-xs text-gray-700 truncate font-mono">{newLink.share_url}</span>
                <button
                  onClick={() => handleCopy(newLink.share_url)}
                  className="flex-shrink-0 flex items-center gap-1 text-xs font-semibold text-brand-navy hover:text-blue-700"
                >
                  {copied ? <Check className="w-3.5 h-3.5 text-green-600" /> : <Copy className="w-3.5 h-3.5" />}
                  {copied ? 'Copied!' : 'Copy'}
                </button>
              </div>
              <a
                href={newLink.share_url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 text-xs text-brand-navy hover:underline"
              >
                <ExternalLink className="w-3 h-3" /> Preview link
              </a>
            </div>
          )}

          {/* ── Active shares list ───────────────────────────────────────── */}
          {(step === 'manage' || activeShares.length > 0) && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-gray-700">Active Links</span>
                {step === 'manage' && (
                  <button
                    onClick={() => { setStep('disclosure'); setNewLink(null); setError('') }}
                    className="text-xs text-brand-navy hover:underline flex items-center gap-1"
                  >
                    <Link2 className="w-3 h-3" /> New link
                  </button>
                )}
              </div>

              {loadingShares && <p className="text-xs text-gray-400 text-center py-2">Loading…</p>}

              {!loadingShares && activeShares.length === 0 && (
                <p className="text-xs text-gray-400 text-center py-3 italic">No active links for this profile.</p>
              )}

              {activeShares.map(share => {
                const url = `${APP_URL}/temporary-dossier/${share.token}`
                const expired = new Date(share.expires_at) < new Date()
                const expiresLabel = expired ? 'Expired' : `Expires ${new Date(share.expires_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
                return (
                  <div key={share.id} className="flex items-center gap-3 p-3 bg-gray-50 border border-gray-200 rounded-xl">
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-mono text-gray-600 truncate">/temporary-dossier/{share.token.slice(0, 12)}…</p>
                      <div className="flex items-center gap-3 mt-1">
                        <span className={`text-xs ${expired ? 'text-red-500' : 'text-gray-400'}`}>{expiresLabel}</span>
                        <span className="text-xs text-gray-400 flex items-center gap-1">
                          <Eye className="w-3 h-3" /> {share.view_count} view{share.view_count !== 1 ? 's' : ''}
                        </span>
                      </div>
                    </div>
                    <button
                      onClick={() => handleCopy(url)}
                      className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-700"
                      title="Copy link"
                    >
                      <Copy className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => handleDeactivate(share.id)}
                      disabled={deactivating === share.id}
                      className="p-1.5 rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-600 disabled:opacity-40"
                      title="Deactivate link"
                    >
                      {deactivating === share.id
                        ? <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                        : <X className="w-3.5 h-3.5" />
                      }
                    </button>
                  </div>
                )
              })}
            </div>
          )}

          {/* Show "create first link" prompt if no active links and on disclosure step */}
          {step === 'disclosure' && !loadingShares && activeShares.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-semibold text-gray-700">Existing Active Links</p>
              {activeShares.map(share => {
                const url = `${APP_URL}/temporary-dossier/${share.token}`
                const expiresLabel = `Expires ${new Date(share.expires_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`
                return (
                  <div key={share.id} className="flex items-center gap-3 p-3 bg-gray-50 border border-gray-200 rounded-xl">
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-mono text-gray-600 truncate">/temporary-dossier/{share.token.slice(0, 12)}…</p>
                      <div className="flex items-center gap-3 mt-1">
                        <span className="text-xs text-gray-400">{expiresLabel}</span>
                        <span className="text-xs text-gray-400 flex items-center gap-1">
                          <Eye className="w-3 h-3" /> {share.view_count} view{share.view_count !== 1 ? 's' : ''}
                        </span>
                      </div>
                    </div>
                    <button onClick={() => handleCopy(url)} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-700" title="Copy link">
                      <Copy className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={() => handleDeactivate(share.id)} disabled={deactivating === share.id} className="p-1.5 rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-600 disabled:opacity-40" title="Deactivate">
                      {deactivating === share.id ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <X className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-gray-100 bg-gray-50 flex-shrink-0">
          <p className="text-xs text-gray-400 leading-relaxed">
            Links are public and don't require a Badger Board account to view. Deactivating a link immediately stops access for anyone who has it.
          </p>
        </div>
      </div>
    </div>
  )
}

// ─── #14: Annotation tool ─────────────────────────────────────────────────────
const ANNOTATION_PREFIX = 'dossier_annotation_'

function useAnnotations(dossierId) {
  const key = dossierId ? `${ANNOTATION_PREFIX}${dossierId}` : null

  const [annotations, setAnnotations] = useState(() => {
    if (!key) return {}
    try { return JSON.parse(localStorage.getItem(key) || '{}') } catch { return {} }
  })

  const save = useCallback((sectionId, text) => {
    setAnnotations(prev => {
      const next = { ...prev }
      if (text.trim()) next[sectionId] = { text: text.trim(), savedAt: new Date().toISOString() }
      else delete next[sectionId]
      if (key) localStorage.setItem(key, JSON.stringify(next))
      return next
    })
  }, [key])

  return [annotations, save]
}

function SectionAnnotation({ dossierId, sectionId, annotations, onSave }) {
  const existing = annotations[sectionId]
  const [open, setOpen] = useState(false)
  const [text, setText] = useState(existing?.text || '')

  const handleSave = () => { onSave(sectionId, text); setOpen(false) }
  const handleDelete = () => { onSave(sectionId, ''); setText(''); setOpen(false) }

  return (
    <div className="mt-3">
      {existing && !open && (
        <div className="flex items-start gap-2 px-3 py-2 bg-yellow-50 border border-yellow-200 rounded-lg text-xs">
          <MessageSquare className="w-3.5 h-3.5 text-yellow-600 flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-yellow-800 leading-relaxed">{existing.text}</p>
            <p className="text-yellow-500 mt-1">
              {existing.savedAt ? format(new Date(existing.savedAt), 'MMM d, yyyy h:mm a') : ''}
            </p>
          </div>
          <button onClick={() => { setOpen(true); setText(existing.text) }} className="text-yellow-600 hover:text-yellow-800 flex-shrink-0">
            <ChevronDown className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
      {!open && (
        <button
          onClick={() => { setOpen(true); setText(existing?.text || '') }}
          className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-600 transition-colors mt-1"
        >
          <MessageSquare className="w-3 h-3" />
          {existing ? 'Edit annotation' : 'Add annotation'}
        </button>
      )}
      {open && (
        <div className="mt-2 space-y-1.5">
          <textarea
            autoFocus
            value={text}
            onChange={e => setText(e.target.value)}
            placeholder="Add a research note or annotation for this section..."
            rows={3}
            className="w-full text-xs border border-gray-200 rounded-lg px-3 py-2 resize-none focus:outline-none focus:ring-2 focus:ring-brand-red/30"
          />
          <div className="flex gap-2">
            <button onClick={handleSave} className="text-xs font-semibold text-brand-red hover:underline">Save</button>
            <button onClick={() => setOpen(false)} className="text-xs text-gray-400 hover:text-gray-600">Cancel</button>
            {existing && <button onClick={handleDelete} className="text-xs text-red-400 hover:text-red-600 ml-auto">Delete</button>}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Section nav pill ─────────────────────────────────────────────────────────
function SectionPill({ section, active, onClick }) {
  const Icon = SECTION_META.find(m => m.id === section.id)?.icon || FileText
  return (
    <button
      onClick={() => onClick(section.id)}
      className={`flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold transition-all ${
        active ? 'bg-brand-navy text-white shadow-sm' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
      }`}
    >
      <Icon className="w-3 h-3" />
      {section.label}
    </button>
  )
}

// ─── Dossier Viewer ───────────────────────────────────────────────────────────
// ── Quiet inline generation progress (time-estimated stages) ─────────────────
function GenerationStrip({ startedAt, candidateName }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 2000)
    return () => clearInterval(iv)
  }, [])
  const t0 = startedAt ? new Date(startedAt).getTime() : now
  const sec = Math.max(0, (now - t0) / 1000)
  const pct = Math.min(96, Math.round((sec / 210) * 100))
  const stage = sec < 25 ? 'Scanning Wisconsin news & public records…'
    : sec < 55 ? 'Reading campaign finance & election data…'
    : sec < 170 ? `Writing sections · ~${Math.min(14, Math.max(1, Math.floor(sec / 13)))} of 14`
    : 'Final review & source check…'
  const left = Math.max(0, Math.round((210 - sec) / 10) * 10)
  return (
    <div className="mt-3 pt-3 border-t border-gray-100">
      <p className="text-[13px] font-bold text-gray-900">{candidateName || 'Profile'} <span className="text-gray-400 font-medium">— generating now</span></p>
      <p className="text-xs text-gray-500 font-medium mt-0.5">{stage}</p>
      <div className="h-1.5 rounded-full bg-gray-100 mt-2.5 overflow-hidden">
        <div className="h-full rounded-full bg-brand-red transition-all duration-1000" style={{ width: `${pct}%` }} />
      </div>
      <div className="flex justify-between text-[11px] text-gray-400 font-semibold mt-1.5">
        <span>estimated progress</span>
        <span>{left > 0 ? `~${left}s left` : 'finishing up…'}</span>
      </div>
    </div>
  )
}

function DossierViewer({ dossier, onRegenerate, regenerating, onDelete, userPlan, initialSection }) {
  const { isAdmin } = useAuth()
  const [showEmpty, setShowEmpty] = useState(false)
  const [expanded, setExpanded]   = useState(false)
  const { snapshot, rest: bodyContent } = extractSnapshot(dossier.content)
  const allSections = parseSections(bodyContent)
  const { sections, hiddenCount } = filterSections(allSections, showEmpty)
  const [activeSection, setActiveSection]   = useState(sections[0]?.id)

  // Escape exits the enlarged reading mode
  useEffect(() => {
    if (!expanded) return
    const onKey = (e) => { if (e.key === 'Escape') setExpanded(false) }
    window.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = '' }
  }, [expanded])
  const [copied, setCopied]                 = useState(false)
  const [showReviewer, setShowReviewer]     = useState(false)
  const [showAnnotations, setShowAnnotations] = useState(false)
  const [showShareModal, setShowShareModal] = useState(false)
  const [annotations, saveAnnotation]       = useAnnotations(dossier.id)
  const annotationCount = Object.keys(annotations).length
  // v1.19: sharing is available on all paid plans (Share button always shown;
  // link generation is plan-gated server-side, PDF export works everywhere)
  const isLite   = isLiteProfileOnly(userPlan)
  const liteFreeNums = new Set((LITE_PROFILE_FREE_SECTIONS || []).map(s => s.sectionNumber))
  const sectionRefs = useRef({})
  const scrollRef   = useRef(null)

  // Scrollspy
  const handleScroll = useCallback(() => {
    const container = scrollRef.current
    if (!container) return
    const scrollTop = container.scrollTop + 80
    let current = sections[0]?.id
    sections.forEach(s => {
      const el = sectionRefs.current[s.id]
      if (el && el.offsetTop <= scrollTop) current = s.id
    })
    setActiveSection(current)
  }, [sections])

  const scrollToSection = (id) => {
    const el = sectionRefs.current[id]
    const container = scrollRef.current
    if (el && container) {
      container.scrollTo({ top: el.offsetTop - 60, behavior: 'smooth' })
      setActiveSection(id)
    }
  }

  // Deep link: land on the requested section once content is rendered
  const initialScrolledRef = useRef(false)
  useEffect(() => {
    if (!initialSection || initialScrolledRef.current) return
    initialScrolledRef.current = true
    const t = setTimeout(() => { try { scrollToSection(initialSection) } catch {} }, 600)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSection])

  const handleCopy = () => {
    navigator.clipboard.writeText(dossier.content)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleExportPdf = () => {
    const html = buildPrintHtml(dossier, sections)
    const win = window.open('', '_blank')
    if (!win) { alert('Allow pop-ups to export PDF.'); return }
    win.document.write(html)
    win.document.close()
    setTimeout(() => { win.focus(); win.print() }, 700)
  }

  const flaggedCount = parseFlaggedClaims(dossier.content).length

  // Verified-claims metric from the report's own confidence badges
  const badgeCounts = { strong: 0, weak: 0 }
  for (const m of dossier.content.matchAll(/\*\*\[(KNOWN|CONFIRMED|LIKELY|VERIFY|RESEARCH REQUIRED)\]\*\*/g)) {
    if (m[1] === 'KNOWN' || m[1] === 'CONFIRMED') badgeCounts.strong++
    else badgeCounts.weak++
  }
  const totalClaims = badgeCounts.strong + badgeCounts.weak
  const verifiedPct = totalClaims >= 5 ? Math.round((badgeCounts.strong / totalClaims) * 100) : null

  return (
    <div
      className={expanded
        ? 'fixed inset-0 z-[200] bg-white flex flex-col overflow-hidden'
        : 'card !p-0 flex flex-col overflow-hidden rounded-2xl'}
      style={expanded ? {} : { height: '80vh' }}
    >
      {/* Document header */}
      <div className="relative flex-shrink-0 px-6 pt-5 pb-5 text-white" style={{ background: 'linear-gradient(135deg, #0A1628 0%, #12203A 65%, #1A0A0A 100%)' }}>
        <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="text-[10px] font-extrabold uppercase" style={{ letterSpacing: '0.14em', color: 'rgba(255,255,255,0.45)' }}>Political intelligence profile</div>
          <h2 className="text-2xl font-extrabold truncate mt-1" style={{ letterSpacing: '-0.02em' }}>{dossier.candidate?.name || dossier.title}</h2>
          <div className="flex items-center gap-2 mt-2.5 flex-wrap">
            {dossier.candidate?.party && <span className="text-[11px] font-extrabold px-2.5 py-0.5 rounded-full" style={{ background: dossier.candidate.party === 'Democrat' ? '#1D4ED8' : dossier.candidate.party === 'Republican' ? '#B91C1C' : 'rgba(255,255,255,0.2)' }}>{dossier.candidate.party}</span>}
            {dossier.candidate?.office?.name && <span className="text-[11px] font-bold px-2.5 py-0.5 rounded-full border" style={{ borderColor: 'rgba(255,255,255,0.25)', color: 'rgba(255,255,255,0.85)' }}>{dossier.candidate.office.name}</span>}
            <span className="text-[11px] font-bold px-2.5 py-0.5 rounded-full border" style={{ borderColor: 'rgba(255,255,255,0.25)', color: 'rgba(255,255,255,0.85)' }}>
              Generated {dossier.generated_at ? format(new Date(dossier.generated_at), 'MMM d, yyyy') : '—'} · {sections.length} sections
            </span>
            {verifiedPct !== null && (
              <span className="text-[11px] font-extrabold px-2.5 py-0.5 rounded-full" style={{ background: verifiedPct >= 70 ? '#15803D' : verifiedPct >= 40 ? '#B45309' : '#B91C1C' }} title={`${badgeCounts.strong} of ${totalClaims} tagged claims are KNOWN/CONFIRMED`}>
                {verifiedPct}% verified claims
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0 ml-3 flex-wrap justify-end" style={{ ['--tw-ring-color']: 'transparent' }}>
          {isAdmin && (
            <Link
              to={`/broadside?dossier=${dossier.id}`}
              className="text-xs flex items-center gap-1 py-1.5 px-2.5 rounded-lg font-bold bg-brand-red text-white hover:bg-red-700 transition-all"
              title="Spar on this profile in Broadside (Beta)"
            >
              <Swords className="w-3.5 h-3.5" />
              Spar
            </Link>
          )}
          <button
            onClick={() => setExpanded(v => !v)}
            className="text-xs flex items-center gap-1 py-1.5 px-2.5 rounded-lg font-bold bg-white/10 text-white hover:bg-white/20 transition-all"
            title={expanded ? 'Exit full-screen reading (Esc)' : 'Enlarge — full-screen reading'}
          >
            {expanded ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
            {expanded ? 'Minimize' : 'Enlarge'}
          </button>
          <button
            onClick={() => setShowAnnotations(v => !v)}
            className={`text-xs flex items-center gap-1 py-1.5 px-2.5 rounded-lg font-bold transition-all ${showAnnotations ? 'bg-yellow-500 text-white' : 'bg-white/10 text-white hover:bg-white/20'}`}
            title="Research annotations"
          >
            <MessageSquare className="w-3.5 h-3.5" />
            Notes {annotationCount > 0 && <span className={`ml-0.5 px-1.5 py-0.5 rounded-full text-xs font-bold ${showAnnotations ? 'bg-white/20' : 'bg-yellow-100 text-yellow-800'}`}>{annotationCount}</span>}
          </button>
          <button
            onClick={() => setShowReviewer(v => !v)}
            className={`text-xs flex items-center gap-1 py-1.5 px-2.5 rounded-lg font-bold transition-all ${showReviewer ? 'bg-white text-brand-navy' : 'bg-white/10 text-white hover:bg-white/20'}`}
            title="Review flagged claims"
          >
            <Scale className="w-3.5 h-3.5" />
            Review {flaggedCount > 0 && <span className={`ml-0.5 px-1.5 py-0.5 rounded-full text-xs font-bold ${showReviewer ? 'bg-white/20' : 'bg-amber-100 text-amber-800'}`}>{flaggedCount}</span>}
          </button>
          {/* v1.19: consolidated sharing — one button opens PDF export + timed-link options */}
          <button
            onClick={() => setShowShareModal(true)}
            className="text-xs flex items-center gap-1 py-1.5 px-2.5 rounded-lg font-bold transition-all text-white"
            style={{ background: '#B91C1C' }}
            title="Export PDF or share a timed link"
          >
            <Link2 className="w-3.5 h-3.5" />
            Share
          </button>
          <button onClick={handleCopy} className="text-xs flex items-center gap-1 py-1.5 px-2.5 rounded-lg font-bold bg-white/10 text-white hover:bg-white/20 transition-all">
            {copied ? <Check className="w-3.5 h-3.5 text-green-600" /> : <Copy className="w-3.5 h-3.5" />}
            {copied ? 'Copied' : 'Copy'}
          </button>
          {dossier.candidate_id && (
            <Link to={`/candidates/${dossier.candidate_id}`} className="text-xs py-1.5 px-2.5 rounded-lg font-bold bg-white/10 text-white hover:bg-white/20 transition-all">
              Candidate →
            </Link>
          )}
        </div>
        </div>
      </div>

      {/* Animated snapshot intro — types out on open */}
      {snapshot && <SnapshotCard text={snapshot} />}

      {/* What's new this week — from the Monday monitoring digest */}
      {dossier.weekly_digest?.summary && (
        <div className="mx-4 mt-2 mb-1 rounded-2xl border border-brand-navy/15 bg-gradient-to-br from-blue-50/60 via-white to-white px-5 py-4">
          <div className="flex items-center gap-2 mb-1.5">
            <RefreshCw className="w-3.5 h-3.5 text-brand-navy" />
            <span className="text-[10px] font-extrabold uppercase tracking-[0.12em] text-brand-navy">What&apos;s new this week</span>
            {dossier.weekly_digest.generated_at && (
              <span className="text-[10px] text-gray-400 font-semibold ml-auto">
                {new Date(dossier.weekly_digest.generated_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
              </span>
            )}
          </div>
          <p className="text-sm leading-relaxed text-gray-700 font-medium">{dossier.weekly_digest.summary}</p>
          {(dossier.weekly_digest.items || []).length > 0 && (
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {dossier.weekly_digest.items.map((it, i) => (
                <span key={i} title={it.note || ''} className="inline-flex items-center gap-1.5 text-xs font-semibold text-gray-700 bg-white border border-gray-200 rounded-full px-3 py-1">
                  <span className={`w-1.5 h-1.5 rounded-full ${
                    it.category === 'controversy' ? 'bg-red-500' : it.category === 'news' ? 'bg-blue-500'
                    : it.category === 'podcast' ? 'bg-purple-500' : it.category === 'social' ? 'bg-sky-400'
                    : it.category === 'polling' ? 'bg-teal-500' : it.category === 'endorsement' ? 'bg-green-500' : 'bg-gray-400'}`} />
                  {it.title}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Disclaimer banner */}
      <div className="py-2 px-4 flex-shrink-0">
        <DossierDisclaimerBanner />
      </div>

      {/* #4 Stale data indicator */}
      <StaleBanner
        generatedAt={dossier.generated_at}
        onRegenerate={onRegenerate}
        regenerating={regenerating}
      />

      {/* Section nav pills — mobile only (desktop gets the sticky TOC rail) */}
      {sections.length > 1 && (
        <div className="flex lg:hidden gap-2 overflow-x-auto py-2 px-4 border-b border-gray-100 flex-shrink-0 scrollbar-hide">
          {sections.map(s => (
            <SectionPill key={s.id} section={s} active={activeSection === s.id} onClick={scrollToSection} />
          ))}
        </div>
      )}

      {/* Main content + optional claim reviewer side panel */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Numbered scroll-spy table of contents */}
        {sections.length > 1 && (
          <nav className="hidden lg:block w-[188px] flex-shrink-0 overflow-y-auto border-r border-gray-100 py-4 pl-3">
            <div className="text-[10px] font-extrabold uppercase text-gray-300 pl-3 mb-2" style={{ letterSpacing: '0.1em' }}>Sections</div>
            {sections.map((sec, i) => {
              const on = activeSection === sec.id
              const label = sec.label.replace(/^\d+\s*/, '')
              return (
                <button key={sec.id} onClick={() => scrollToSection(sec.id)}
                  className={`w-full flex items-center gap-2 text-left text-xs font-bold py-1.5 pl-3 pr-2 transition-colors ${on ? 'text-brand-red' : sec.isEmptySection ? 'text-amber-500' : 'text-gray-400 hover:text-gray-600'}`}
                  style={{ borderLeft: on ? '3px solid #8B0000' : '3px solid transparent', background: on ? 'linear-gradient(to right, #FEF6F6, transparent)' : 'transparent' }}>
                  <span className={`w-[18px] h-[18px] rounded-md text-[9.5px] font-extrabold inline-flex items-center justify-center flex-shrink-0 ${on ? 'bg-brand-red text-white' : 'bg-gray-100 text-gray-400'}`}>{sec.index || i}</span>
                  <span className="truncate">{label}</span>
                </button>
              )
            })}
            {hiddenCount > 0 && (
              <button onClick={() => setShowEmpty(v => !v)}
                className="w-full flex items-center gap-1.5 text-left text-[11px] font-bold text-gray-300 hover:text-gray-500 py-2 pl-3 mt-2 border-t border-gray-50">
                {showEmpty ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                {showEmpty ? 'Hide empty sections' : `${hiddenCount} empty section${hiddenCount === 1 ? '' : 's'} hidden`}
              </button>
            )}
          </nav>
        )}
        {/* Scrollable dossier content */}
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className={`flex-1 overflow-y-auto pt-3 px-4 space-y-4 ${showReviewer ? 'pr-2' : ''}`}
        >
          {sections.map((s) => {
            const isGatedSection = s.id === 'section-6' || s.id === 'section-13'
            const section6Locked = isGatedSection && !SECTION6_TIERS.has(userPlan)
            // Scout lite profile: only sections 2, 4, 8 are free; rest are blurred
            const sectionNumMatch = s.id.match(/^section-(\d+)$/)
            const sectionNum = sectionNumMatch ? parseInt(sectionNumMatch[1], 10) : null
            const liteLocked = isLite && sectionNum !== null && !liteFreeNums.has(sectionNum)
            const isSection1or10 = s.id === 'section-1' || s.id === 'section-10'
            const theme = SECTION_THEMES[s.id] || SECTION_THEMES['overview']
            const meta = SECTION_META.find(m => m.id === s.id) || SECTION_META[0]
            const SectionIcon = meta.icon || FileText

            return (
              <div
                key={s.id}
                ref={el => { sectionRefs.current[s.id] = el }}
                className="rounded-2xl border overflow-hidden shadow-sm"
                style={{ borderColor: theme.border, borderLeftWidth: '4px', borderLeftColor: theme.accent }}
              >
                {/* Section header bar */}
                <div
                  className="flex items-center gap-2.5 px-4 py-2.5"
                  style={{ background: theme.light, borderBottom: `1px solid ${theme.border}` }}
                >
                  <div
                    className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0"
                    style={{ background: 'white', border: `1px solid ${theme.border}` }}
                  >
                    <SectionIcon className="w-3.5 h-3.5" style={{ color: theme.accent }} />
                  </div>
                  <span className="text-xs font-bold uppercase tracking-wider" style={{ color: theme.accent }}>
                    {s.label}
                  </span>
                </div>

                {/* Section content */}
                <div className="px-5 py-4 bg-white">
                  {section6Locked ? (
                    // Section 6/13 always shows the Campaign-tier gate (correct messaging)
                    <Section6Upsell content={s.content} />
                  ) : liteLocked ? (
                    // Scout lite profile: gate sections not in the free list
                    <LiteProfileGate sectionLabel={s.label} content={s.content} />
                  ) : isSection1or10 ? (
                    <Section1Renderer content={s.displayContent || s.content} />
                  ) : (
                    <div
                      className="prose-dossier"
                      dangerouslySetInnerHTML={{ __html: mdToHtml(s.displayContent || s.content, theme.accent) }}
                    />
                  )}
                  {s.isEmptySection && (
                    <p className="mt-2 text-[11px] font-bold text-amber-600">Hidden by default — no findings in this section for this profile.</p>
                  )}
                  {/* #14 Per-section annotation */}
                  {showAnnotations && (
                    <SectionAnnotation
                      dossierId={dossier.id}
                      sectionId={s.id}
                      annotations={annotations}
                      onSave={saveAnnotation}
                    />
                  )}
                </div>
              </div>
            )
          })}

          {/* Footer */}
          <div className="flex items-center gap-3 pt-4 border-t border-gray-100">
            <button
              onClick={onRegenerate}
              disabled={regenerating}
              className="btn-secondary text-xs flex items-center gap-1.5 py-1.5"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${regenerating ? 'animate-spin' : ''}`} />
              {regenerating ? 'Regenerating...' : 'Regenerate'}
            </button>
            <p className="text-xs text-gray-400">Creates a fresh AI analysis — current profile will be replaced.</p>
          </div>

          {/* Compare hook */}
          {dossier.candidate_id && (
            <div className="flex items-center justify-between gap-3 rounded-2xl px-5 py-4 mb-4" style={{ background: '#0A1628' }}>
              <span className="text-[13px] font-bold" style={{ color: 'rgba(255,255,255,0.85)' }}>
                See how {(dossier.candidate?.name || 'this candidate').split(' ')[0]} stacks up against an opponent
              </span>
              <Link to="/compare" className="text-xs font-extrabold px-4 py-2.5 rounded-lg text-white flex-shrink-0" style={{ background: '#B91C1C' }}>
                Compare candidates →
              </Link>
            </div>
          )}
        </div>

        {/* Claim Reviewer side panel — hidden on phones, visible on tablet+ */}
        {showReviewer && (
          <div className="hidden sm:flex w-80 flex-shrink-0 overflow-hidden flex-col border-l border-gray-200 -mr-6 rounded-r-xl" style={{ marginBottom: '-1.5rem' }}>
            <ClaimReviewer dossier={dossier} onClose={() => setShowReviewer(false)} />
          </div>
        )}
      </div>

      {/* Share modal */}
      {showShareModal && (
        <ShareModal dossier={dossier} onClose={() => setShowShareModal(false)} onExportPdf={handleExportPdf} />
      )}
    </div>
  )
}

// ─── Dossier Usage Bar (inline on this page) ──────────────────────────────────
function DossierUsageBar({ used, limit }) {
  if (limit === Infinity) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 bg-green-50 border border-green-200 rounded-xl text-xs font-semibold text-green-700">
        <CheckCircle className="w-4 h-4 flex-shrink-0" />
        Unlimited profiles — Agency plan
      </div>
    )
  }
  const remaining = Math.max(0, limit - used)
  const pct       = Math.min(100, Math.round((used / limit) * 100))
  const color     = pct >= 80
    ? { bar: '#ef4444', ring: 'border-red-200',    bg: 'bg-red-50',    text: 'text-red-700'    }
    : pct >= 60
    ? { bar: '#f97316', ring: 'border-orange-200', bg: 'bg-orange-50', text: 'text-orange-700' }
    : { bar: '#22c55e', ring: 'border-green-200',  bg: 'bg-green-50',  text: 'text-green-700'  }

  return (
    <div className={`flex items-center gap-4 px-4 py-3 rounded-xl border ${color.bg} ${color.ring}`}>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between mb-1.5">
          <span className={`text-xs font-semibold ${color.text}`}>
            {remaining === 0
              ? 'Monthly profile limit reached'
              : `${remaining} of ${limit} profile${limit === 1 ? '' : 's'} remaining this month`}
          </span>
          <span className="text-xs text-gray-400 ml-3 whitespace-nowrap">{used}/{limit} used</span>
        </div>
        <div className="h-2 bg-white/70 rounded-full overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{ width: `${pct}%`, backgroundColor: color.bar }}
          />
        </div>
        <p className="text-xs text-gray-400 mt-1">Resets the 1st of each month</p>
      </div>
      <CheckCircle className={`w-5 h-5 flex-shrink-0 ${color.text}`} />
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function Dossiers() {
  const { user } = useAuth()
  const [searchParams] = useSearchParams()
  const initCandidateId  = searchParams.get('candidate')
  const initViewId       = searchParams.get('view')
  const initViewOpened   = useRef(false)  // guard: only auto-open initViewId on the first fetch

  const userTier        = getUserTier(user)
  const tierConfig      = getTierConfig(userTier) || getTierConfig('scout')
  const userBracket     = getUserBracket(user)
  // Effective monthly limit: fixed for Candidate plans, bracket-scaled for Action plans
  const effectiveProfileLimit = getEffectiveProfileLimit(user)

  // ── Dossier status (drives the header indicator in Layout) ────────────────
  const { phase: dossierPhase, candidateId: pendingCandidateId, startedAt: generationStartedAt, startGeneration, setReady: setDossierReady, clearStatus: clearDossierStatus } = useDossierStatus()

  // ── Disclaimer gate ────────────────────────────────────────────────────────
  const { ackState, markAcknowledged } = useDossierAck()
  const [showDisclaimerModal, setShowDisclaimerModal] = useState(false)
  const [pendingAction, setPendingAction]             = useState(null) // fn to run after ack

  // Show modal if user hasn't acknowledged yet and tries to generate/view
  const requireAck = (fn) => {
    if (ackState === 'acknowledged') {
      fn()
    } else {
      setPendingAction(() => fn)
      setShowDisclaimerModal(true)
    }
  }

  const handleAcknowledged = (at) => {
    markAcknowledged(at)
    setShowDisclaimerModal(false)
    if (pendingAction) {
      pendingAction()
      setPendingAction(null)
    }
  }

  const [candidates, setCandidates]       = useState([])
  const [dossiers, setDossiers]           = useState([])
  const [selected, setSelected]           = useState(null)
  const [generating, setGenerating]       = useState(false)
  const [error, setError]                 = useState('')
  const [candidateId, setCandidateId]     = useState(initCandidateId || '')
  const [researchContext, setResearchContext] = useState('')
  const [searchCand, setSearchCand]       = useState('')
  const [confirmDelete, setConfirmDelete] = useState(null)
  const [deleting, setDeleting]           = useState(null)
  const [dossiersUsed, setDossiersUsed]   = useState(0)
  // ── Bulk generate state (tier3 only) ──────────────────────────────────────
  const [showBulkPanel, setShowBulkPanel]   = useState(false)
  const [bulkSelected, setBulkSelected]     = useState(new Set())
  const [bulkSearch, setBulkSearch]         = useState('')
  const [bulkRunning, setBulkRunning]       = useState(false)
  const [bulkProgress, setBulkProgress]     = useState(null)
  // ── New Candidate modal ────────────────────────────────────────────────────
  const [showNewCandModal, setShowNewCandModal] = useState(false)

  // Deep link from the District Dashboard: /profiler?newname=...&context=...
  // opens the New Candidate modal prefilled with the researched official.
  useEffect(() => {
    const newName = searchParams.get('newname')
    if (newName) {
      setNewCandForm({ name: newName, research_context: searchParams.get('context') || '' })
      setShowNewCandModal(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const [offices, setOffices]                   = useState([])
  const [newCandForm, setNewCandForm]           = useState({ name: '', research_context: '' })
  const [creatingCand, setCreatingCand]         = useState(false)
  const [createModalError, setCreateModalError] = useState(null)
  // bulkProgress shape: { current, total, currentName, results: [{name,status,error?}] }

  useEffect(() => {
    fetchData()
    getOffices().then(({ data }) => setOffices(data || []))
  }, [])

  // Deep link from the weekly monitoring digest email:
  // /profiler?candidate=<id>&section=section-1 — open that candidate's latest
  // profile and land on the requested section.
  const deepLinkedRef = useRef(false)
  const initSection = searchParams.get('section')
  useEffect(() => {
    if (deepLinkedRef.current || !initCandidateId || !dossiers.length) return
    const latest = dossiers
      .filter(d => d.candidate_id === initCandidateId)
      .sort((a, b) => new Date(b.generated_at) - new Date(a.generated_at))[0]
    if (!latest) return
    deepLinkedRef.current = true
    openDossier(latest.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dossiers, initCandidateId])

  // ── Resume polling after page refresh ─────────────────────────────────────
  // If the context shows a generation was in progress when the page refreshed,
  // re-enter the polling loop so the page updates when the dossier lands.
  const resumeRef = useRef(false)
  // Unmount guard for the long-running generate/bulk polling loops below —
  // prevents setState-after-unmount and abandons polls when the page closes.
  const aliveRef = useRef(true)
  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false } }, [])
  useEffect(() => {
    if (dossierPhase !== 'generating' || !pendingCandidateId) return
    if (resumeRef.current) return   // don't double-fire in StrictMode
    resumeRef.current = true

    const POLL_INTERVAL = 5000
    const MAX_WAIT = 6 * 60 * 1000  // respect the same 6-minute window as the context
    const pollStart = generationStartedAt ? new Date(generationStartedAt).getTime() : Date.now()
    const deadline  = pollStart + MAX_WAIT

    // Show the spinner on the Dossiers page itself
    setGenerating(true)

    // Use generationStartedAt as the boundary — any dossier with generated_at AFTER that
    // timestamp is the result of this generation, even if it was created before the refresh.
    // This avoids the snapshot-after-refresh bug where the completed dossier would land in
    // the "before" snapshot and never be detected as new.
    const startISO = generationStartedAt || new Date(pollStart - 1000).toISOString()

    let stopped = false
    ;(async () => {
      // Helper: find a dossier created after generation started
      const findNewDossier = (list) =>
        (list || []).find(d => (d.generated_at || d.created_at || '') > startISO)

      // Check immediately — dossier may have finished before the page refreshed
      const { data: immediate } = await getDossiers(pendingCandidateId)
      const alreadyDone = findNewDossier(immediate)
      if (alreadyDone && !stopped) {
        await fetchData()
        await openDossier(alreadyDone.id)
        setDossierReady({ id: alreadyDone.id, candidateName: alreadyDone.candidate?.name || '' })
        setGenerating(false)
        return
      }

      while (!stopped && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, POLL_INTERVAL))
        const { data: current } = await getDossiers(pendingCandidateId)
        const newDossier = findNewDossier(current)
        if (newDossier) {
          await fetchData()
          await openDossier(newDossier.id)
          setDossierReady({ id: newDossier.id, candidateName: newDossier.candidate?.name || '' })
          setGenerating(false)
          return
        }
      }
      // Timed out — clear the stale status
      clearDossierStatus()
      setGenerating(false)
    })()

    return () => { stopped = true; resumeRef.current = false }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dossierPhase, pendingCandidateId])

  const fetchData = async () => {
    const startOfMonth = new Date()
    startOfMonth.setDate(1)
    startOfMonth.setHours(0, 0, 0, 0)

    const [{ data: c }, { data: d }, { data: monthlyDossiers }] = await Promise.all([
      getCandidates({}),
      getDossiers(),
      // Only count this user's manually-generated dossiers (generated_by = current user).
      // Auto-regenerated dossiers have generated_by = null and don't consume quota.
      // Guard: skip query entirely when uid is not yet available (returns empty array).
      user?.id
        ? supabase.from('dossiers').select('id').gte('generated_at', startOfMonth.toISOString()).eq('generated_by', user.id).not('generated_by', 'is', null)
        : Promise.resolve({ data: [] }),
    ])
    setCandidates(c || [])
    setDossiers(d || [])
    setDossiersUsed((monthlyDossiers || []).length)
    if (initViewId && d && !initViewOpened.current) {
      const found = d.find(x => x.id === initViewId)
      if (found) { await openDossier(initViewId); initViewOpened.current = true }
    }
  }

  const openDossier = async (id) => {
    const { data } = await getDossier(id)
    if (data) setSelected(data)
  }

  // Extract key weaknesses from dossier content (looks for Controversies section)
  const extractWeaknesses = (content) => {
    if (!content) return []
    const lines = content.split('\n')
    const weaknesses = []
    let inControversies = false
    for (const line of lines) {
      if (/SECTION 6|Controversies|Weaknesses/i.test(line)) { inControversies = true; continue }
      if (inControversies && /^## SECTION [7-9]/i.test(line)) break
      if (inControversies) {
        const bullet = line.match(/^[*\-•]\s+(.+)/)
        if (bullet && bullet[1].length > 10) weaknesses.push(bullet[1].replace(/\*\*\[.*?\]\*\*/g, '').trim())
        // Also grab bold items that look like controversy headers
        const boldHeader = line.match(/^\*\*([^*]{15,})\*\*/)
        if (boldHeader && weaknesses.length < 10) weaknesses.push(boldHeader[1].trim())
      }
    }
    return weaknesses.slice(0, 8)
  }

  // runGenerate — fires background function and polls Supabase for the result
  // Accepts an optional candidateOverride for cases where React state hasn't updated yet
  // (e.g. handleCreateAndRunDossier creates a candidate then immediately calls this).
  const runGenerate = async (cid, candidateOverride = null) => {
    const candidate = candidateOverride || candidates.find(c => c.id === cid)
    if (!candidate) { setError('Candidate not found.'); return }
    setGenerating(true)
    setError('')
    startGeneration(candidate.name, cid)

    try {
      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token || ''

      // Record the pre-generation dossier count so we can detect the new one
      const { data: beforeDossiers } = await getDossiers(cid)
      const beforeIds = new Set((beforeDossiers || []).map(d => d.id))

      // Merge any research context override into the candidate object
      const candidateWithCtx = researchContext?.trim()
        ? { ...candidate, research_context: researchContext.trim() }
        : candidate

      // Audit fix (#1): go through the synchronous trigger, not the background
      // endpoint directly. Netlify answers background invocations with 202
      // before the handler runs, so limit/auth errors were invisible — the UI
      // just polled for 5 minutes and "timed out". The sync trigger validates
      // auth + the monthly profile limit and returns a real error immediately.
      const res = await fetch('/.netlify/functions/generate-dossier', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ candidate: candidateWithCtx, candidate_id: cid }),
      })
      if (!res.ok && res.status !== 202) {
        let errMsg = 'Failed to start generation'
        try { const j = await res.json(); errMsg = j.error || errMsg } catch {}
        throw new Error(errMsg)
      }

      // Poll Supabase every 5s until a new dossier appears (up to 5 minutes)
      const POLL_INTERVAL = 5000
      const MAX_WAIT = 300000
      const pollStart = Date.now()
      let newDossier = null

      while (aliveRef.current && Date.now() - pollStart < MAX_WAIT) {
        await new Promise(r => setTimeout(r, POLL_INTERVAL))
        const { data: currentDossiers } = await getDossiers(cid)
        newDossier = (currentDossiers || []).find(d => !beforeIds.has(d.id))
        if (newDossier) break
      }
      if (!aliveRef.current) return   // page unmounted — background fn still saves

      if (!newDossier) {
        throw new Error('Profile generation timed out after 5 minutes. Check back shortly — it may still be saving.')
      }

      // ── Auto-update candidate profile from dossier content ──────────────
      const content = newDossier.content || ''
      const weaknesses = extractWeaknesses(content)
      const now = new Date().toISOString()
      const updatedBy = user?.email || user?.user_metadata?.display_name || 'Profile AI'
      const existingTs = candidate.section_timestamps || {}
      const profileUpdates = {
        section_timestamps: {
          ...existingTs,
          intel:      { updated_at: now, updated_by: updatedBy },
          opposition: { updated_at: now, updated_by: updatedBy },
          weaknesses: { updated_at: now, updated_by: updatedBy },
        },
      }
      if (weaknesses.length > 0) profileUpdates.weaknesses = weaknesses
      if (!candidate.bio_summary && content) {
        const bioMatch = content.match(/SECTION 2[:\s]*([\s\S]*?)(?=## SECTION 3|$)/i)
        if (bioMatch) {
          const bioText = bioMatch[1].replace(/^#{1,4}\s.*/gm, '').replace(/\*\*\[.*?\]\*\*/g, '').trim()
          if (bioText.length > 50) profileUpdates.bio_summary = bioText.slice(0, 2000)
        }
      }
      await updateCandidate(cid, profileUpdates)

      await fetchData()
      await openDossier(newDossier.id)
      setDossierReady({ id: newDossier.id, candidateName: candidate.name })

    } catch (err) {
      setError(err.message || 'An error occurred generating the profile.')
      clearDossierStatus()
    }
    setGenerating(false)
  }

  // Create new candidate then immediately run dossier
  const handleCreateAndRunDossier = async () => {
    if (!newCandForm.name.trim()) return
    setCreatingCand(true)
    try {
      const { data: newCand, error: candErr } = await createCandidate({
        name: newCandForm.name.trim(),
        research_context: newCandForm.research_context.trim() || null,
        status: 'exploring',
      })
      if (candErr) throw new Error(candErr.message)
      // Fetch the full candidate record (with office join) so runGenerate has the
      // complete object it needs.  We can't rely on the `candidates` state array
      // because React won't have re-rendered yet after fetchData()'s setCandidates.
      const { data: fullCand } = await supabase
        .from('candidates')
        .select('*, office:offices(id, name, level, office_type, district_name, district_number, county)')
        .eq('id', newCand.id)
        .single()
      await fetchData()
      setShowNewCandModal(false)
      setNewCandForm({ name: '', research_context: '' })
      setCandidateId(newCand.id)
      await runGenerate(newCand.id, fullCand || newCand)
    } catch (err) {
      setCreateModalError(err.message || 'Failed to create candidate.')
    }
    setCreatingCand(false)
  }

  const handleGenerate = () => {
    if (!candidateId) return
    requireAck(() => runGenerate(candidateId))
  }

  const handleRegenerate = () => {
    if (!selected?.candidate_id) return
    requireAck(() => runGenerate(selected.candidate_id))
  }

  const handleDelete = async (id) => {
    setDeleting(id)
    await deleteDossier(id)
    if (selected?.id === id) setSelected(null)
    setConfirmDelete(null)
    setDeleting(null)
    fetchData()
  }

  // ── Bulk generate ──────────────────────────────────────────────────────────
  const runBulkGenerate = async () => {
    if (bulkSelected.size === 0 || bulkRunning) return
    const cids = [...bulkSelected]
    setBulkRunning(true)
    setBulkProgress({ current: 0, total: cids.length, currentName: '', results: [] })
    const results = []
    for (let i = 0; i < cids.length; i++) {
      const cid       = cids[i]
      const candidate = candidates.find(c => c.id === cid)
      if (!candidate) { results.push({ name: '(unknown)', status: 'error', error: 'Candidate not found' }); continue }
      setBulkProgress({ current: i + 1, total: cids.length, currentName: candidate.name, results: [...results] })
      try {
        // Fetch a fresh token for each candidate — bulk runs can exceed JWT lifetime
        const { data: { session } } = await supabase.auth.getSession()
        const bulkToken = session?.access_token || ''
        // Get pre-existing dossier IDs for this candidate
        const { data: beforeD } = await getDossiers(cid)
        const beforeBulkIds = new Set((beforeD || []).map(d => d.id))
        // Audit fix (#1): sync trigger surfaces limit/auth errors immediately
        // (a direct background POST always gets 202 — errors were invisible)
        const res = await fetch('/.netlify/functions/generate-dossier', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bulkToken}` },
          body: JSON.stringify({ candidate, candidate_id: cid }),
        })
        if (!res.ok && res.status !== 202) {
          let errMsg = 'Generation failed'
          try { const j = await res.json(); errMsg = j.error || errMsg } catch {}
          throw new Error(errMsg)
        }
        // Poll for new dossier (up to 5 minutes per candidate)
        const bulkPollStart = Date.now()
        let bulkNewDossier = null
        while (aliveRef.current && Date.now() - bulkPollStart < 300000) {
          await new Promise(r => setTimeout(r, 5000))
          const { data: cur } = await getDossiers(cid)
          bulkNewDossier = (cur || []).find(d => !beforeBulkIds.has(d.id))
          if (bulkNewDossier) break
        }
        if (!aliveRef.current) return
        if (!bulkNewDossier) throw new Error('Timed out waiting for profile')
        results.push({ name: candidate.name, status: 'success' })
      } catch (err) {
        results.push({ name: candidate.name, status: 'error', error: err.message || 'Unknown error' })
      }
      setBulkProgress(prev => ({ ...prev, results: [...results] }))
    }
    setBulkProgress(prev => ({ ...prev, current: cids.length, currentName: '', results: [...results], done: true }))
    setBulkRunning(false)
    setBulkSelected(new Set())
    await fetchData()
  }

  const filteredBulkCandidates = candidates.filter(c =>
    bulkSearch ? c.name?.toLowerCase().includes(bulkSearch.toLowerCase()) : true
  )

  const filteredDossiers = searchCand
    ? dossiers.filter(d => d.candidate?.name?.toLowerCase().includes(searchCand.toLowerCase()))
    : dossiers

  const selectedCandidate = candidates.find(c => c.id === candidateId)

  // Mirror the backend getResearchMode() logic so the UI shows the same mode
  const researchMode = (() => {
    if (!selectedCandidate) return null
    const isIncumbent = !!selectedCandidate.is_incumbent
    const hasOffice   = !!selectedCandidate.office?.name
    const status      = selectedCandidate.status?.toLowerCase() || ''
    if (isIncumbent) return 'incumbent'
    if (!hasOffice || !status || status === 'exploring' || status === 'lost' || status === 'withdrawn') return 'prospect'
    if (status === 'declared') return 'newly_declared'
    return 'challenger'
  })()

  const RESEARCH_MODE_CONFIG = {
    prospect:       { label: 'Prospect',          icon: '○', color: 'bg-gray-100 text-gray-700 border-gray-200',     desc: 'Civic background, professional record, community ties — no campaign data expected' },
    newly_declared: { label: 'Newly Declared',    icon: '◆', color: 'bg-blue-50 text-blue-700 border-blue-200',      desc: 'Announcement coverage, WEC filing, early fundraising, background that led to the run' },
    challenger:     { label: 'Challenger',         icon: '▲', color: 'bg-amber-50 text-amber-700 border-amber-200',   desc: 'Full electoral history, active campaign finance, head-to-head dynamics, polling' },
    incumbent:      { label: 'Incumbent',          icon: '■', color: 'bg-purple-50 text-purple-700 border-purple-200', desc: 'Voting record, bills sponsored, performance vs. promises, re-election dynamics' },
  }

  // Pre-populate research context from the candidate record when selection changes
  useEffect(() => {
    const cand = candidates.find(c => c.id === candidateId)
    if (cand?.research_context) {
      setResearchContext(cand.research_context)
    } else {
      setResearchContext('')
    }
  }, [candidateId, candidates])

  return (
    <div className="space-y-6">
      <LoadingBar loading={generating} />
      {/* Disclaimer gate modal */}
      {showDisclaimerModal && (
        <DossierDisclaimerModal
          onAcknowledged={handleAcknowledged}
          onClose={() => { setShowDisclaimerModal(false); setPendingAction(null) }}
        />
      )}

      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <FileText className="w-6 h-6 text-brand-red" /> Profiler
          </h1>
          <p className="text-gray-500 text-sm mt-1">AI-generated 14-section political intelligence reports</p>
        </div>
        <div className="sm:w-80">
          <DossierUsageBar used={dossiersUsed} limit={effectiveProfileLimit} />
        </div>
      </div>

      {/* Acknowledgment notice banner */}
      {ackState === 'pending' && (
        <div className="bg-amber-50 border border-amber-300 rounded-xl px-4 py-3 flex items-center gap-3">
          <Scale className="w-5 h-5 text-amber-600 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-amber-900">Research Use Disclaimer Required</p>
            <p className="text-xs text-amber-700 mt-0.5">
              You must acknowledge the Research Use Disclaimer before generating or viewing profiles.{' '}
              <a href="/dossier-disclaimer" target="_blank" rel="noopener noreferrer" className="underline">View disclaimer</a>
            </p>
          </div>
          <button
            onClick={() => setShowDisclaimerModal(true)}
            className="text-xs font-semibold text-amber-900 bg-amber-200 hover:bg-amber-300 px-3 py-1.5 rounded-lg transition-colors flex-shrink-0"
          >
            Acknowledge Now
          </button>
        </div>
      )}

      <div className="grid lg:grid-cols-3 gap-6">
        {/* Left panel */}
        <div className="space-y-4">
          {/* Generate card */}
          <div className="card border-2 border-brand-red/20">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Sparkles className="w-5 h-5 text-brand-red" />
                <h2 className="text-base font-bold text-gray-900">Generate Profile</h2>
              </div>
              <button
                onClick={() => { setShowNewCandModal(true); setCreateModalError(null) }}
                className="flex items-center gap-1 text-xs text-brand-red hover:text-red-700 font-medium"
                title="Add new candidate and run profile"
              >
                <UserPlus className="w-3.5 h-3.5" /> New Candidate
              </button>
            </div>

            {/* Compact usage bar */}
            {effectiveProfileLimit === Infinity ? (
              <div className="flex items-center gap-1.5 mb-3 text-xs text-green-700 font-medium">
                <CheckCircle className="w-3.5 h-3.5" /> Unlimited profiles
              </div>
            ) : (
              <div className="mb-3">
                <div className="flex items-center justify-between mb-1">
                  <span className={`text-xs font-semibold ${
                    dossiersUsed >= effectiveProfileLimit ? 'text-red-600' :
                    dossiersUsed / effectiveProfileLimit >= 0.6 ? 'text-orange-600' : 'text-gray-500'
                  }`}>
                    {effectiveProfileLimit - dossiersUsed <= 0
                      ? 'Limit reached'
                      : `${effectiveProfileLimit - dossiersUsed} of ${effectiveProfileLimit} remaining`}
                  </span>
                  <span className="text-xs text-gray-400">{dossiersUsed}/{effectiveProfileLimit}</span>
                </div>
                <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all duration-500"
                    style={{
                      width: `${Math.min(100, Math.round((dossiersUsed / effectiveProfileLimit) * 100))}%`,
                      backgroundColor:
                        dossiersUsed >= effectiveProfileLimit ? '#ef4444' :
                        dossiersUsed / effectiveProfileLimit >= 0.6 ? '#f97316' : '#22c55e',
                    }}
                  />
                </div>
              </div>
            )}

            {error && (
              <div className="flex items-start gap-2 mb-3 p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">
                <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                {error}
              </div>
            )}

            <div className="space-y-3">
              <div>
                <label className="label text-xs">Select Candidate</label>
                <SearchableSelect value={candidateId} onChange={setCandidateId}
                  options={(Array.isArray(candidates) ? candidates : []).map(c => ({
                    value: c.id,
                    label: `${c.name}${c.party ? ` (${c.party})` : ''} — ${c.office?.name || 'No office'}`,
                  }))}
                  placeholder="Choose candidate..."
                  searchPlaceholder="Search candidates..." />
              </div>

              {selectedCandidate && (
                <div className="p-3 bg-gray-50 rounded-lg text-xs text-gray-600 space-y-2">
                  <div>
                    <p className="font-semibold text-gray-800">{selectedCandidate.name}</p>
                    <p>{selectedCandidate.office?.name}{selectedCandidate.office?.district_name ? ` · ${selectedCandidate.office.district_name}` : ''}</p>
                    {selectedCandidate.party && <p className="mt-0.5 text-brand-red font-medium">{selectedCandidate.party}</p>}
                  </div>
                  {researchMode && (() => {
                    const cfg = RESEARCH_MODE_CONFIG[researchMode]
                    return (
                      <div className={`flex items-start gap-2 p-2 rounded-md border ${cfg.color}`}>
                        <span className="text-sm leading-none mt-0.5">{cfg.icon}</span>
                        <div>
                          <span className="font-semibold text-[11px]">Research Mode: {cfg.label}</span>
                          <p className="text-[10px] mt-0.5 opacity-80">{cfg.desc}</p>
                        </div>
                      </div>
                    )
                  })()}
                </div>
              )}

              <div>
                <label className="label text-xs flex items-center gap-1">
                  Research Context
                  <span className="text-gray-400 font-normal">(optional but recommended)</span>
                </label>
                <textarea
                  className="input text-xs resize-none"
                  rows={3}
                  value={researchContext}
                  onChange={e => setResearchContext(e.target.value)}
                  placeholder="Help the AI find the right person — e.g.: 'Lives in Wausau, owns Marathon Roofing LLC, considering Marathon County Board District 4. Not yet announced.'"
                  maxLength={1000}
                />
                <p className="text-xs text-gray-400 mt-1">
                  Include city, employer, profession, or any context that disambiguates this person. Critical for pre-announcement candidates.
                </p>
                {(() => {
                  const cand = candidates.find(c => c.id === candidateId)
                  if (!cand) return null
                  const chips = []
                  if (cand.office?.name && !researchContext.includes(cand.office.name)) chips.push({ label: 'their district', text: `Running for ${cand.office.name}.` })
                  if (cand.office?.county && !researchContext.includes(cand.office.county)) chips.push({ label: 'their county', text: `Based in ${cand.office.county} County, Wisconsin.` })
                  const opp = candidates.find(c => c.id !== cand.id && c.office_id && c.office_id === cand.office_id)
                  if (opp && !researchContext.includes(opp.name)) chips.push({ label: 'their opponent', text: `Opponent in the race: ${opp.name}.` })
                  if (!chips.length) return null
                  return (
                    <div className="flex gap-1.5 flex-wrap mt-2">
                      {chips.map(ch => (
                        <button key={ch.label} type="button"
                          onClick={() => setResearchContext(prev => (prev ? prev.replace(/\s+$/, '') + ' ' : '') + ch.text)}
                          className="text-[11px] font-semibold px-2.5 py-1 rounded-full border border-gray-200 text-gray-500 hover:border-brand-red hover:text-brand-red transition-colors">
                          ＋ {ch.label}
                        </button>
                      ))}
                    </div>
                  )
                })()}
              </div>

              {/* ── Upgrade gate: at monthly limit ── */}
              {effectiveProfileLimit !== Infinity && dossiersUsed >= effectiveProfileLimit ? (
                <UpgradePrompt
                  feature="Profile Generation"
                  hook={`You've used your ${effectiveProfileLimit} profile${effectiveProfileLimit === 1 ? '' : 's'} this month. Research firms charge $500–$2,000 for a single candidate profile. Upgrading your plan gives you more.`}
                  plan="Campaign"
                  price="from $89/mo"
                  benefits={[
                    'More profiles per month — upgrade your active candidate tier',
                    'Automated weekly refresh for active candidates',
                    'Campaign Intel briefs & AI discovery',
                    'Unlimited profiles on Campaign & Agency plans',
                  ]}
                />
              ) : (
                <>
                  <button
                    onClick={handleGenerate}
                    disabled={!candidateId || generating}
                    className="btn-primary w-full flex items-center justify-center gap-2"
                  >
                    {generating ? (
                      <><span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> Generating (2–4 min)...</>
                    ) : (
                      <><Sparkles className="w-4 h-4" /> Generate AI Profile</>
                    )}
                  </button>
                  <p className="text-xs text-gray-400 text-center">14-section report · 2–4 minutes · Grok + Perplexity + Claude scour the web, news &amp; social media</p>
                  {generating && <GenerationStrip startedAt={generationStartedAt} candidateName={candidates.find(c => c.id === pendingCandidateId)?.name || candidates.find(c => c.id === candidateId)?.name} />}
                </>
              )}
            </div>
          </div>

          {/* ── Bulk Generate (Agency / tier3 only) ── */}
          {effectiveProfileLimit === Infinity && (
            <div className="card border-2 border-brand-navy/20">
              {/* Header — always visible */}
              <button
                onClick={() => { setShowBulkPanel(v => !v); setBulkProgress(null) }}
                className="w-full flex items-center justify-between group"
              >
                <div className="flex items-center gap-2">
                  <Users className="w-5 h-5 text-brand-navy" />
                  <h2 className="text-base font-bold text-gray-900">Bulk Generate</h2>
                  {bulkSelected.size > 0 && !bulkRunning && (
                    <span className="ml-1 text-xs bg-brand-navy text-white px-2 py-0.5 rounded-full font-semibold">
                      {bulkSelected.size} selected
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-400 group-hover:text-gray-600">Agency plan</span>
                  {showBulkPanel
                    ? <ChevronUp className="w-4 h-4 text-gray-400" />
                    : <ChevronDown className="w-4 h-4 text-gray-400" />}
                </div>
              </button>

              {showBulkPanel && (
                <div className="mt-4 space-y-3">
                  {/* Progress / results area */}
                  {bulkProgress && (
                    <div className="rounded-lg border border-gray-200 overflow-hidden">
                      {/* Progress bar */}
                      {!bulkProgress.done && (
                        <div className="px-3 py-2.5 bg-brand-navy/5 border-b border-gray-200">
                          <div className="flex items-center justify-between mb-1.5">
                            <span className="text-xs font-semibold text-brand-navy">
                              Generating {bulkProgress.current} of {bulkProgress.total}
                            </span>
                            <span className="text-xs text-gray-400">
                              {Math.round((bulkProgress.current / bulkProgress.total) * 100)}%
                            </span>
                          </div>
                          <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-brand-navy rounded-full transition-all duration-500"
                              style={{ width: `${Math.round((bulkProgress.current / bulkProgress.total) * 100)}%` }}
                            />
                          </div>
                          {bulkProgress.currentName && (
                            <p className="text-xs text-gray-500 mt-1.5 flex items-center gap-1">
                              <span className="w-3 h-3 border-2 border-brand-navy/30 border-t-brand-navy rounded-full animate-spin flex-shrink-0 inline-block" />
                              {bulkProgress.currentName}
                            </p>
                          )}
                        </div>
                      )}

                      {bulkProgress.done && (
                        <div className="px-3 py-2 bg-green-50 border-b border-green-100 flex items-center gap-2">
                          <CheckCircle className="w-4 h-4 text-green-600 flex-shrink-0" />
                          <span className="text-xs font-semibold text-green-700">
                            Batch complete — {bulkProgress.results.filter(r => r.status === 'success').length} generated,{' '}
                            {bulkProgress.results.filter(r => r.status === 'error').length} failed
                          </span>
                        </div>
                      )}

                      {/* Per-candidate result list */}
                      {bulkProgress.results.length > 0 && (
                        <div className="max-h-36 overflow-y-auto divide-y divide-gray-100">
                          {bulkProgress.results.map((r, i) => (
                            <div key={i} className="flex items-center gap-2 px-3 py-1.5">
                              {r.status === 'success'
                                ? <CheckCircle className="w-3.5 h-3.5 text-green-500 flex-shrink-0" />
                                : <AlertCircle className="w-3.5 h-3.5 text-red-400 flex-shrink-0" />}
                              <span className="text-xs text-gray-700 flex-1 min-w-0 truncate">{r.name}</span>
                              {r.status === 'error' && r.error && (
                                <span className="text-xs text-red-500 truncate max-w-[100px]" title={r.error}>{r.error}</span>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Candidate picker (hidden while running) */}
                  {!bulkRunning && (
                    <>
                      {/* Search + select-all row */}
                      <div className="flex items-center gap-2">
                        <div className="relative flex-1">
                          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
                          <input
                            className="input pl-8 text-xs py-1.5"
                            placeholder="Search candidates..."
                            value={bulkSearch}
                            onChange={e => setBulkSearch(e.target.value)}
                          />
                        </div>
                        <button
                          onClick={() => {
                            const allIds = filteredBulkCandidates.map(c => c.id)
                            const allSelected = allIds.every(id => bulkSelected.has(id))
                            if (allSelected) {
                              setBulkSelected(prev => {
                                const next = new Set(prev)
                                allIds.forEach(id => next.delete(id))
                                return next
                              })
                            } else {
                              setBulkSelected(prev => new Set([...prev, ...allIds]))
                            }
                          }}
                          className="text-xs text-brand-navy hover:underline whitespace-nowrap font-medium"
                        >
                          {filteredBulkCandidates.every(c => bulkSelected.has(c.id)) ? 'Clear all' : 'Select all'}
                        </button>
                      </div>

                      {/* Candidate checkbox list */}
                      <div className="border border-gray-200 rounded-lg divide-y divide-gray-100 max-h-52 overflow-y-auto">
                        {filteredBulkCandidates.length === 0 ? (
                          <p className="text-xs text-gray-400 text-center py-4 italic">No candidates found</p>
                        ) : (
                          filteredBulkCandidates.map(c => (
                            <label
                              key={c.id}
                              className={`flex items-center gap-2.5 px-3 py-2 cursor-pointer hover:bg-gray-50 transition-colors ${
                                bulkSelected.has(c.id) ? 'bg-brand-navy/5' : ''
                              }`}
                            >
                              <input
                                type="checkbox"
                                checked={bulkSelected.has(c.id)}
                                onChange={() => {
                                  setBulkSelected(prev => {
                                    const next = new Set(prev)
                                    next.has(c.id) ? next.delete(c.id) : next.add(c.id)
                                    return next
                                  })
                                }}
                                className="rounded border-gray-300 text-brand-navy focus:ring-brand-navy"
                              />
                              <div className="flex-1 min-w-0">
                                <p className="text-xs font-semibold text-gray-800 truncate">{c.name}</p>
                                <p className="text-xs text-gray-400 truncate">{c.office?.name || 'No office'}</p>
                              </div>
                              {c.party && (
                                <span className="text-xs text-gray-500 flex-shrink-0">{c.party}</span>
                              )}
                            </label>
                          ))
                        )}
                      </div>

                      {/* Run button */}
                      <button
                        onClick={() => requireAck(runBulkGenerate)}
                        disabled={bulkSelected.size === 0}
                        className="btn-primary w-full flex items-center justify-center gap-2 disabled:opacity-40"
                        style={{ backgroundColor: '#1e3a5f', borderColor: '#1e3a5f' }}
                      >
                        <PlayCircle className="w-4 h-4" />
                        Run {bulkSelected.size > 0 ? `${bulkSelected.size} ` : ''}Profile{bulkSelected.size !== 1 ? 's' : ''}
                      </button>
                      <p className="text-xs text-gray-400 text-center">Runs sequentially · ~15–45 sec each</p>
                    </>
                  )}

                  {/* Running spinner / cancel info */}
                  {bulkRunning && (
                    <div className="text-xs text-gray-500 text-center py-1 italic">
                      Running batch — please keep this tab open
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Dossier list */}
          <div className="card">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-bold text-gray-900">Saved Profiles ({dossiers.length})</h2>
            </div>
            <div className="relative mb-3">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
              <input className="input pl-8 text-xs py-1.5" placeholder="Search..." value={searchCand} onChange={e => setSearchCand(e.target.value)} />
            </div>
            <div className="space-y-1 max-h-96 overflow-y-auto">
              {filteredDossiers.length === 0 ? (
                <p className="text-xs text-gray-400 text-center py-6 italic">
                  {dossiers.length === 0 ? 'No profiles yet' : 'No results'}
                </p>
              ) : (
                (Array.isArray(filteredDossiers) ? filteredDossiers : []).map(d => {
                  const nm = d.candidate?.name || 'Unknown'
                  const initials = nm.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase()
                  const avBg = d.candidate?.party === 'Republican' ? '#8B0000' : d.candidate?.party === 'Democrat' ? '#1D4ED8' : '#64748B'
                  const days = d.generated_at ? Math.floor((Date.now() - new Date(d.generated_at).getTime()) / 86400000) : null
                  const when = days === null ? '—' : days === 0 ? 'today' : days === 1 ? 'yesterday' : `${days}d ago`
                  return (
                    <div
                      key={d.id}
                      onClick={() => openDossier(d.id)}
                      className={`group relative flex items-center gap-2.5 p-2.5 rounded-xl cursor-pointer transition-colors ${
                        selected?.id === d.id ? 'bg-red-50' : 'hover:bg-gray-50'
                      }`}
                    >
                      {selected?.id === d.id && <span className="absolute left-0 top-2.5 bottom-2.5 w-[3px] rounded bg-brand-red" />}
                      <span className="w-9 h-9 rounded-lg flex items-center justify-center text-white text-[11px] font-extrabold flex-shrink-0" style={{ background: avBg }}>{initials}</span>
                      <div className="flex-1 min-w-0">
                        <p className={`text-xs font-bold truncate ${selected?.id === d.id ? 'text-brand-red' : 'text-gray-800'}`}>{nm}</p>
                        <p className="text-[11px] text-gray-400 truncate">{d.candidate?.office?.name || ''}</p>
                      </div>
                      <span className={`text-[11px] font-semibold flex-shrink-0 group-hover:hidden ${days !== null && days >= 30 ? 'text-amber-600' : 'text-gray-300'}`}>
                        {days !== null && days >= 30 ? `${days}d — update?` : when}
                      </span>
                      <div className="hidden group-hover:flex items-center gap-1 flex-shrink-0">
                        <button onClick={e => { e.stopPropagation(); openDossier(d.id) }}
                          className="text-[11px] font-bold px-2 py-1 rounded-md bg-gray-100 text-gray-600 hover:bg-gray-200">Open</button>
                        <button onClick={e => { e.stopPropagation(); setConfirmDelete(d.id) }}
                          className="p-1.5 rounded-md bg-gray-100 text-gray-400 hover:bg-red-50 hover:text-brand-red" title="Delete profile">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  )
                })
              )}
            </div>
          </div>
        </div>

        {/* Right panel — viewer */}
        <div className="lg:col-span-2">
          {!selected ? (
            <div className="card flex flex-col items-center justify-center py-24 text-center">
              <FileText className="w-16 h-16 text-gray-200 mb-4" />
              <p className="text-gray-500 font-semibold">No profile selected</p>
              <p className="text-gray-400 text-sm mt-1">Generate a new profile or pick one from the list</p>
            </div>
          ) : (
            <DossierViewer
              initialSection={deepLinkedRef.current ? initSection : null}
              key={selected.id}
              dossier={selected}
              onRegenerate={handleRegenerate}
              regenerating={generating}
              onDelete={() => setConfirmDelete(selected.id)}
              userPlan={userTier}
            />
          )}
        </div>
      </div>

      {/* New Candidate modal */}
      {showNewCandModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/40" onClick={() => setShowNewCandModal(false)} />
          <div className="relative bg-white rounded-xl shadow-xl p-6 w-full max-w-md">
            <div className="flex items-center gap-2 mb-4">
              <UserPlus className="w-5 h-5 text-brand-red" />
              <h3 className="font-bold text-gray-900">Add New Candidate & Run Profile</h3>
            </div>
            <p className="text-sm text-gray-500 mb-4">
              Create a new candidate record and immediately generate an AI profile.
            </p>
            <div className="space-y-3">
              <div>
                <label className="label text-xs">Full Name *</label>
                <input
                  className="input"
                  value={newCandForm.name}
                  onChange={e => setNewCandForm(p => ({ ...p, name: e.target.value }))}
                  placeholder="First Last"
                  autoFocus
                />
              </div>
              <div>
                <label className="label text-xs">Research Context <span className="text-gray-400 font-normal">(optional)</span></label>
                <textarea
                  className="input"
                  rows={3}
                  value={newCandForm.research_context}
                  onChange={e => setNewCandForm(p => ({ ...p, research_context: e.target.value }))}
                  placeholder="e.g. Republican candidate for State Assembly District 12 in Waukesha County. Ran in 2022, lost in primary. Known for school choice stance..."
                  maxLength={1000}
                />
                <p className="text-xs text-gray-400 mt-1">Help the profiler find the right person — add party, office, district, or any known background.</p>
              </div>
            </div>
            {createModalError && (
              <p className="text-sm text-red-600 mt-3 p-2 bg-red-50 rounded-lg">{createModalError}</p>
            )}
            <div className="flex gap-3 mt-5">
              <button onClick={() => { setShowNewCandModal(false); setCreateModalError(null) }} className="btn-secondary flex-1 text-sm">Cancel</button>
              <button
                onClick={handleCreateAndRunDossier}
                disabled={creatingCand || !newCandForm.name.trim()}
                className="btn-primary flex-1 text-sm flex items-center justify-center gap-2"
              >
                {creatingCand ? (
                  <><span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> Creating...</>
                ) : (
                  <><UserPlus className="w-4 h-4" /> Create & Run Profile</>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete modal */}
      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/40" onClick={() => setConfirmDelete(null)} />
          <div className="relative bg-white rounded-xl shadow-xl p-6 w-full max-w-sm">
            <h3 className="font-bold text-gray-900 mb-2">Delete Profile?</h3>
            <p className="text-sm text-gray-500 mb-4">This permanently deletes the AI-generated profile and cannot be undone.</p>
            <div className="flex gap-3">
              <button onClick={() => setConfirmDelete(null)} className="btn-secondary flex-1 text-sm">Cancel</button>
              <button
                onClick={() => handleDelete(confirmDelete)}
                disabled={deleting === confirmDelete}
                className="btn-primary flex-1 text-sm bg-brand-red"
              >
                {deleting === confirmDelete ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  )
}
