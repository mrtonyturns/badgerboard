import React, { useEffect, useState, useCallback, useRef } from 'react'
import { hasFindings } from '../lib/profileContent'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { format } from 'date-fns'
import {
  ArrowLeft, Mail, Phone, Globe, Twitter, Facebook, Instagram,
  Building2, CalendarDays, Briefcase, Edit2, Save, X, FileText,
  ListChecks, User, DollarSign, MapPin, Trash2, Zap, Megaphone,
  Shield, Lock, AlertTriangle, Clock, Plus, ChevronDown, ChevronUp,
  CheckCircle, XCircle, MinusCircle, ExternalLink, Gavel, Sparkles,
  Target, Newspaper, MessageSquare, AlertCircle, TrendingUp, TrendingDown, Users,
  BarChart2, Trophy, RefreshCw, Search,
  Paperclip, Download, Bot, Upload, Check,
} from 'lucide-react'
import {
  getCandidate, updateCandidate, deleteCandidate, getDossiers, getDossier,
  getIncumbentRecords, createIncumbentRecord, updateIncumbentRecord, deleteIncumbentRecord,
  logActivity,
} from '../lib/supabase'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { getUserTier, hasFeature } from '../lib/tiers'
import LoadingBar from '../components/LoadingBar'

const PARTIES   = ['Republican','Democrat','Independent','Libertarian','Green','Constitution','Nonpartisan','Other']
const STATUSES  = ['exploring','declared','primary_winner','general','elected','lost','withdrawn']

const STATUS_LABELS = {
  exploring:     'Not Known',
  declared:      'Declared',
  primary_winner:'Primary Winner',
  general:       'General',
  elected:       'Elected',
  lost:          'Lost',
  withdrawn:     'Withdrawn',
}
const statusLabel = (s) => STATUS_LABELS[s] ?? (s ? s.replace(/_/g, ' ') : '')

const RECORD_TYPES = ['bill','act','regulation','law','legal','vote','other']
const VOTE_RESULTS = ['yes','no','abstain','absent','not_applicable']
const SIGNIFICANCE = ['major','notable','minor']

const partyColor = (p) => ({
  Republican:  'bg-red-100 text-brand-red border border-red-200',
  Democrat:    'bg-blue-100 text-blue-800 border border-blue-200',
  Independent: 'bg-gray-100 text-gray-700 border border-gray-200',
  Nonpartisan: 'bg-purple-100 text-purple-800 border border-purple-200',
}[p] || 'bg-gray-100 text-gray-700 border border-gray-200')

const statusBadge = (s) => ({
  exploring:      'bg-gray-100 text-gray-600',
  declared:       'bg-blue-100 text-blue-700',
  primary_winner: 'bg-purple-100 text-purple-700',
  general:        'bg-yellow-100 text-yellow-700',
  elected:        'bg-green-100 text-green-700',
  lost:           'bg-red-100 text-red-600',
  withdrawn:      'bg-gray-100 text-gray-400',
}[s] || 'bg-gray-100 text-gray-600')

const voteIcon = (v) => ({
  yes:            <CheckCircle className="w-4 h-4 text-green-600" />,
  no:             <XCircle className="w-4 h-4 text-red-500" />,
  abstain:        <MinusCircle className="w-4 h-4 text-yellow-500" />,
  absent:         <MinusCircle className="w-4 h-4 text-gray-400" />,
  not_applicable: null,
}[v] || null)

const sigBadge = (s) => ({
  major:   'bg-red-100 text-red-700',
  notable: 'bg-yellow-100 text-yellow-700',
  minor:   'bg-gray-100 text-gray-500',
}[s] || 'bg-gray-100 text-gray-500')

const typeColor = (t) => ({
  bill:       'bg-blue-100 text-blue-700',
  act:        'bg-purple-100 text-purple-700',
  regulation: 'bg-orange-100 text-orange-700',
  law:        'bg-green-100 text-green-700',
  legal:      'bg-red-100 text-red-700',
  vote:       'bg-indigo-100 text-indigo-700',
  other:      'bg-gray-100 text-gray-600',
}[t] || 'bg-gray-100 text-gray-600')

function SectionTimestamp({ ts }) {
  if (!ts || !ts.updated_at) return null
  return (
    <span className="flex items-center gap-1 text-xs text-gray-400 ml-auto">
      <Clock className="w-3 h-3" />
      Updated {format(new Date(ts.updated_at), 'MMM d, yyyy')}
      {ts.updated_by && ` · ${ts.updated_by}`}
    </span>
  )
}

function LockedFeatureCard({ icon: Icon, title }) {
  return (
    <div className="card flex flex-col items-center justify-center py-20 text-center">
      <div className="w-14 h-14 rounded-2xl bg-gray-100 flex items-center justify-center mb-4">
        <Lock className="w-7 h-7 text-gray-400" />
      </div>
      <div className="flex items-center gap-2 mb-2">
        <Icon className="w-4 h-4 text-gray-400" />
        <p className="font-semibold text-gray-600">{title} Locked</p>
      </div>
      <p className="text-gray-400 text-sm max-w-xs mb-5">
        Upgrade to Campaign or Agency to unlock AI-powered campaign intelligence.
      </p>
      <Link to="/plans" className="btn-primary text-sm">
        View Plans →
      </Link>
    </div>
  )
}

// ── Incumbent Record Form ─────────────────────────────────────────────────────
function IncumbentRecordForm({ candidateId, userId, onSave, onCancel, existing }) {
  const blank = {
    candidate_id: candidateId,
    record_type: 'bill',
    title: '',
    description: '',
    bill_number: '',
    vote_result: 'not_applicable',
    date: '',
    significance: 'notable',
    url: '',
    source: '',
    notes: '',
    created_by: userId,
  }
  const [form, setForm] = useState(existing ? { ...existing } : blank)
  const [saving, setSaving] = useState(false)

  const f = (key) => (e) => setForm(p => ({ ...p, [key]: e.target.value }))

  const handleSave = async () => {
    if (!form.title.trim()) return
    setSaving(true)
    if (existing?.id) {
      await updateIncumbentRecord(existing.id, form)
      logActivity('update', 'incumbent_record', existing.id, { candidate_id: candidateId, record_title: form.title, record_type: form.record_type }).catch(() => {})
    } else {
      await createIncumbentRecord(form)
      logActivity('create', 'incumbent_record', candidateId, { candidate_id: candidateId, record_title: form.title, record_type: form.record_type, source: 'manual' }).catch(() => {})
    }
    setSaving(false)
    onSave()
  }

  return (
    <div className="bg-gray-50 rounded-xl border border-gray-200 p-4 space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="label text-xs">Type</label>
          <select className="input" value={form.record_type} onChange={f('record_type')}>
            {RECORD_TYPES.map(t => <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>)}
          </select>
        </div>
        <div>
          <label className="label text-xs">Significance</label>
          <select className="input" value={form.significance} onChange={f('significance')}>
            {SIGNIFICANCE.map(s => <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>)}
          </select>
        </div>
      </div>

      <div>
        <label className="label text-xs">Title *</label>
        <input className="input" value={form.title} onChange={f('title')} placeholder="e.g. Assembly Bill 123 — Property Tax Reform" />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="label text-xs">Bill / Case Number</label>
          <input className="input" value={form.bill_number} onChange={f('bill_number')} placeholder="AB 123" />
        </div>
        <div>
          <label className="label text-xs">Vote Result</label>
          <select className="input" value={form.vote_result} onChange={f('vote_result')}>
            {VOTE_RESULTS.map(v => <option key={v} value={v}>{v.replace('_',' ')}</option>)}
          </select>
        </div>
      </div>

      <div>
        <label className="label text-xs">Date</label>
        <input className="input" type="date" value={form.date} onChange={f('date')} />
      </div>

      <div>
        <label className="label text-xs">Description</label>
        <textarea className="input" rows={3} value={form.description} onChange={f('description')} placeholder="Brief summary of what this bill/act/event involved..." />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="label text-xs">Source</label>
          <input className="input" value={form.source} onChange={f('source')} placeholder="Wisconsin Legislature, WI Courts..." />
        </div>
        <div>
          <label className="label text-xs">URL</label>
          <input className="input" value={form.url} onChange={f('url')} placeholder="https://..." />
        </div>
      </div>

      <div>
        <label className="label text-xs">Notes</label>
        <input className="input" value={form.notes} onChange={f('notes')} placeholder="Additional context..." />
      </div>

      <div className="flex gap-2 justify-end pt-1">
        <button onClick={onCancel} className="btn-secondary text-sm">Cancel</button>
        <button onClick={handleSave} disabled={saving || !form.title.trim()} className="btn-primary text-sm">
          {saving ? 'Saving...' : (existing ? 'Update Record' : 'Add Record')}
        </button>
      </div>
    </div>
  )
}

// ── Incumbent Record Row ──────────────────────────────────────────────────────
function IncumbentRecordRow({ record, onEdit, onDelete }) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="border border-gray-200 rounded-xl overflow-hidden">
      <div
        className="flex items-center gap-3 p-3 cursor-pointer hover:bg-gray-50 transition-colors"
        onClick={() => setExpanded(e => !e)}
      >
        <span className={`text-xs font-semibold px-2 py-0.5 rounded-full capitalize ${typeColor(record.record_type)}`}>
          {record.record_type}
        </span>
        {record.vote_result && record.vote_result !== 'not_applicable' && voteIcon(record.vote_result)}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-gray-900 truncate">{record.title}</p>
          {record.bill_number && <p className="text-xs text-gray-400">{record.bill_number}</p>}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {record.significance && (
            <span className={`text-xs font-semibold px-2 py-0.5 rounded-full capitalize ${sigBadge(record.significance)}`}>
              {record.significance}
            </span>
          )}
          {record.date && record.date.trim() && <span className="text-xs text-gray-400">{format(new Date(record.date), 'MMM yyyy')}</span>}
          {expanded ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
        </div>
      </div>

      {expanded && (
        <div className="px-4 pb-4 pt-1 border-t border-gray-100 bg-white space-y-2">
          {record.description && <p className="text-sm text-gray-700 leading-relaxed">{record.description}</p>}
          {record.notes && <p className="text-xs text-gray-500 italic">{record.notes}</p>}
          <div className="flex items-center justify-between pt-1">
            <div className="flex items-center gap-3">
              {record.source && <span className="text-xs text-gray-400">Source: {record.source}</span>}
              {record.url && (
                <a href={record.url} target="_blank" rel="noopener noreferrer"
                  className="flex items-center gap-1 text-xs text-brand-red hover:underline">
                  <ExternalLink className="w-3 h-3" /> View Source
                </a>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => onEdit(record)} className="text-xs text-gray-500 hover:text-brand-red">Edit</button>
              <button onClick={() => onDelete(record.id)} className="text-xs text-red-500 hover:text-red-700">Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── News & Social Tab ─────────────────────────────────────────────────────
const SOURCE_DOMAIN_MAP = {
  'WSAU': 'wsau.com', 'WKOW': 'wkow.com', 'WEAU': 'weau.com', 'WBAY': 'wbay.com',
  'WSAW': 'wsaw.com', 'WXOW': 'wxow.com', 'WITI': 'fox6now.com', 'FOX6': 'fox6now.com',
  'WTMJ': 'wtmj.com', 'WISN': 'wisn.com', 'TMJ4': 'tmj4.com', 'WFRV': 'wfrv.com',
  'WLUK': 'fox11online.com', 'NBC15': 'nbc15.com', 'CBS58': 'cbs58.com',
  'WPR': 'wpr.org', 'Wisconsin Public Radio': 'wpr.org',
  'Milwaukee Journal Sentinel': 'jsonline.com', 'Journal Sentinel': 'jsonline.com',
  'Wisconsin State Journal': 'madison.com', 'Cap Times': 'captimes.com',
  'Capital Times': 'captimes.com', 'Wausau Daily Herald': 'wausaudailyherald.com',
  'Green Bay Press-Gazette': 'greenbaypressgazette.com',
  'Appleton Post-Crescent': 'postcrescent.com', 'La Crosse Tribune': 'lacrossetribune.com',
  'Wisconsin Watch': 'wisconsinwatch.org', 'Urban Milwaukee': 'urbanmilwaukee.com',
  'WisPolitics': 'wispolitics.com', 'Wisconsin Examiner': 'wisconsinexaminer.com',
  'AP': 'apnews.com', 'Associated Press': 'apnews.com', 'Reuters': 'reuters.com',
  'Politico': 'politico.com', 'The Hill': 'thehill.com', 'NPR': 'npr.org',
  'Facebook': 'facebook.com', 'Twitter': 'twitter.com', 'X': 'x.com',
  'Instagram': 'instagram.com', 'YouTube': 'youtube.com',
  'LinkedIn': 'linkedin.com', 'TikTok': 'tiktok.com',
}
const SOCIAL_PLATFORMS_SET = new Set(['facebook', 'twitter', 'x', 'instagram', 'youtube', 'linkedin', 'tiktok', 'reddit', 'threads', 'nextdoor'])

const PLATFORM_META = {
  facebook:  { color: 'bg-blue-600',   label: 'Facebook',  icon: 'f' },
  twitter:   { color: 'bg-sky-500',    label: 'Twitter/X', icon: '𝕏' },
  x:         { color: 'bg-black',      label: 'X',         icon: '𝕏' },
  instagram: { color: 'bg-pink-500',   label: 'Instagram', icon: 'ig' },
  youtube:   { color: 'bg-red-600',    label: 'YouTube',   icon: '▶' },
  linkedin:  { color: 'bg-blue-700',   label: 'LinkedIn',  icon: 'in' },
  tiktok:    { color: 'bg-gray-900',   label: 'TikTok',    icon: '♪' },
  reddit:    { color: 'bg-orange-500', label: 'Reddit',    icon: 'r/' },
  threads:   { color: 'bg-gray-800',   label: 'Threads',   icon: '@' },
  nextdoor:  { color: 'bg-green-600',  label: 'Nextdoor',  icon: 'N' },
}

const SENTIMENT_BADGE = {
  '+': 'bg-green-100 text-green-700 border-green-200',
  '-': 'bg-red-100 text-red-700 border-red-200',
  '~': 'bg-gray-100 text-gray-600 border-gray-200',
}

function isSocialSrc(source = '') {
  const lower = source.toLowerCase()
  return SOCIAL_PLATFORMS_SET.has(lower) ||
    lower.includes('facebook') || lower.includes('twitter') ||
    lower.includes('instagram') || lower.includes('youtube') ||
    lower.includes('linkedin') || lower.includes('tiktok')
}

function getDomain(source = '', url = null) {
  try { if (url) return new URL(url).hostname.replace(/^www\./, '') } catch {}
  if (!source) return null
  if (SOURCE_DOMAIN_MAP[source]) return SOURCE_DOMAIN_MAP[source]
  for (const [key, domain] of Object.entries(SOURCE_DOMAIN_MAP)) {
    if (source.toLowerCase().includes(key.toLowerCase()) || key.toLowerCase().includes(source.toLowerCase())) return domain
  }
  return null
}

function parseNewsItems(content = '') {
  const items = []
  const lines = content.split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.startsWith('### ')) {
      const headingText = line.slice(4).trim()
      const linkMatch = headingText.match(/^\[([^\]]+)\]\((https?:\/\/[^)]+)\)\s*$/)
      const title = linkMatch ? linkMatch[1] : headingText.replace(/\*\*/g, '').replace(/`/g, '')
      const url = linkMatch ? linkMatch[2] : null
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
          const bm = dl.match(/\*\*\[([A-Za-z ]+)\]\*\*/)
          if (bm) flag = bm[1].toUpperCase()
        }
        const cleaned = dl.replace(/\*\*\[[A-Za-z ]+\]\*\*/g, '').replace(/\*\*/g, '').trim()
        if (cleaned) descParts.push(cleaned)
        j++
      }
      const domain = getDomain(source, url)
      const isSocial = isSocialSrc(source)
      const searchUrl = url || `https://www.google.com/search?q=${encodeURIComponent((title + ' ' + source).trim())}`
      items.push({ title, url, searchUrl, source, date, description: descParts.join(' ').slice(0, 250), flag, domain, isSocial })
      i = j
    } else { i++ }
  }
  return items
}

const FLAG_COLORS = {
  'VERIFY':            'bg-yellow-100 text-yellow-700 border-yellow-200',
  'RESEARCH REQUIRED': 'bg-amber-100 text-amber-700 border-amber-200',
  'LIKELY':            'bg-purple-100 text-purple-700 border-purple-200',
  'KNOWN':             'bg-green-100 text-green-700 border-green-200',
  'HIGH':              'bg-red-100 text-red-700 border-red-200',
  'MEDIUM':            'bg-orange-100 text-orange-700 border-orange-200',
}

function MiniNewsCard({ title, searchUrl, url, source, date, description, flag, domain }) {
  const [imgErr, setImgErr] = useState(false)
  const [showTip, setShowTip] = useState(false)
  const fav = domain && !imgErr ? `https://www.google.com/s2/favicons?domain=${domain}&sz=32` : null
  const href = searchUrl || url

  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="block no-underline">
      <div className="flex items-start gap-3 p-3 rounded-xl border border-gray-200 hover:border-blue-300 hover:bg-blue-50/40 cursor-pointer transition-colors group">
        <div className="w-6 h-6 flex-shrink-0 mt-0.5 rounded overflow-hidden flex items-center justify-center bg-gray-50 border border-gray-100">
          {fav ? (
            <img src={fav} alt={source || 'source'} className="w-4 h-4 object-contain" onError={() => setImgErr(true)} />
          ) : (
            <FileText className="w-3.5 h-3.5 text-blue-400" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold leading-snug text-gray-900 group-hover:text-blue-700">{title}</p>
          {(source || date) && <p className="text-xs text-gray-500 mt-0.5">{[source, date].filter(Boolean).join(' · ')}</p>}
          {description && <p className="text-xs text-gray-600 mt-1 leading-relaxed line-clamp-2">{description}</p>}
        </div>
        {flag && (
          <div className="relative flex-shrink-0" onMouseEnter={() => setShowTip(true)} onMouseLeave={() => setShowTip(false)}>
            <span className={`inline-flex items-center gap-1 text-xs font-semibold px-1.5 py-0.5 rounded border ${FLAG_COLORS[flag] || 'bg-gray-100 text-gray-600 border-gray-200'}`}>
              <AlertCircle className="w-3 h-3" /> Flagged
            </span>
            {showTip && (
              <div className="absolute right-0 top-6 z-50 bg-gray-900 text-white text-xs rounded-lg px-2.5 py-1.5 whitespace-nowrap shadow-lg pointer-events-none">{flag}</div>
            )}
          </div>
        )}
      </div>
    </a>
  )
}

/** Parse Section 10 (Social Posts) — uses same ### heading format as Section 1 */
function parseSocialItems(content = '') {
  const parts = ('\n' + content).split(/\n(?=## SECTION \d)/i)
  let section10 = ''
  for (const part of parts) {
    if (/^## SECTION 10[:\s]/i.test(part.trim())) { section10 = part.trim(); break }
  }
  if (!section10) return []

  // Reuse the same parseNewsItems logic on section 10 content
  const items = parseNewsItems(section10)
  // Mark all items from Section 10 as social
  return items.map(it => ({ ...it, isSocial: true }))
}

/** Detect platform from source string */
function detectPlatform(source = '') {
  const lower = source.toLowerCase()
  for (const p of SOCIAL_PLATFORMS_SET) {
    if (lower.includes(p)) return p
  }
  return null
}

function SocialMediaCard({ title, searchUrl, url, source, date, description, flag, domain }) {
  const [showTip, setShowTip] = useState(false)
  const platform = detectPlatform(source)
  const meta = platform ? PLATFORM_META[platform] : null
  const href = searchUrl || url

  // Detect sentiment from description
  let sentiment = null
  if (description) {
    if (/sentiment:\s*\+/i.test(description)) sentiment = '+'
    else if (/sentiment:\s*-/i.test(description)) sentiment = '-'
    else if (/sentiment:\s*~/i.test(description)) sentiment = '~'
  }
  // Clean sentiment tag from display description
  const cleanDesc = description ? description.replace(/\s*sentiment:\s*[+\-~]\s*\.?\s*/gi, '').trim() : ''

  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="block no-underline">
      <div className="flex items-start gap-3 p-3 rounded-xl border border-gray-200 hover:border-purple-300 hover:bg-purple-50/30 cursor-pointer transition-colors group">
        {/* Platform badge */}
        <div className={`w-7 h-7 flex-shrink-0 mt-0.5 rounded-lg flex items-center justify-center text-white text-xs font-bold ${meta?.color || 'bg-gray-500'}`}>
          {meta?.icon || '?'}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold leading-snug text-gray-900 group-hover:text-purple-700">{title}</p>
          <div className="flex items-center gap-2 mt-0.5 flex-wrap">
            {source && <span className="text-xs font-medium text-purple-600">{source}</span>}
            {date && <span className="text-xs text-gray-400">· {date}</span>}
            {sentiment && (
              <span className={`inline-flex items-center text-xs font-semibold px-1.5 py-0.5 rounded border ${SENTIMENT_BADGE[sentiment]}`}>
                {sentiment === '+' ? '▲ Positive' : sentiment === '-' ? '▼ Negative' : '– Neutral'}
              </span>
            )}
          </div>
          {cleanDesc && <p className="text-xs text-gray-600 mt-1 leading-relaxed line-clamp-2">{cleanDesc}</p>}
        </div>
        {flag && (
          <div className="relative flex-shrink-0" onMouseEnter={() => setShowTip(true)} onMouseLeave={() => setShowTip(false)}>
            <span className={`inline-flex items-center gap-1 text-xs font-semibold px-1.5 py-0.5 rounded border ${FLAG_COLORS[flag] || 'bg-gray-100 text-gray-600 border-gray-200'}`}>
              <AlertCircle className="w-3 h-3" /> Flagged
            </span>
            {showTip && (
              <div className="absolute right-0 top-6 z-50 bg-gray-900 text-white text-xs rounded-lg px-2.5 py-1.5 whitespace-nowrap shadow-lg pointer-events-none">{flag}</div>
            )}
          </div>
        )}
      </div>
    </a>
  )
}

// ── Parse a numbered section from dossier content ─────────────────────────────
function parseSection(content, sectionNum) {
  if (!content) return null
  const parts = ('\n' + content).split(/\n(?=## SECTION \d)/i)
  for (const part of parts) {
    if (new RegExp(`^## SECTION ${sectionNum}[:\\s]`, 'i').test(part.trim())) {
      return part.trim()
    }
  }
  return null
}

// ── Minimal markdown → styled HTML for dossier section rendering ──────────────
const BADGE_STYLES_CD = {
  'KNOWN':'background:#dcfce7;color:#166534;border:1px solid #bbf7d0;',
  'RESEARCH REQUIRED':'background:#fef3c7;color:#92400e;border:1px solid #fde68a;',
  'CONFIRMED':'background:#dbeafe;color:#1e40af;border:1px solid #bfdbfe;',
  'LIKELY':'background:#f3e8ff;color:#6b21a8;border:1px solid #e9d5ff;',
  'VERIFY':'background:#fefce8;color:#854d0e;border:1px solid #fef08a;',
  'HIGH':'background:#fee2e2;color:#991b1b;border:1px solid #fecaca;',
  'MEDIUM':'background:#ffedd5;color:#9a3412;border:1px solid #fed7aa;',
  'LOW':'background:#f0fdf4;color:#166534;border:1px solid #bbf7d0;',
}
function applyInlineCD(text) {
  return text
    .replace(/\*\*\[([A-Z ]+)\]\*\*/g, (_, b) => {
      const s = BADGE_STYLES_CD[b.toUpperCase()] || 'background:#f3f4f6;color:#374151;border:1px solid #d1d5db;'
      return `<span style="display:inline-block;font-size:0.7rem;font-weight:700;padding:1px 6px;border-radius:4px;${s}">${b}</span>`
    })
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer" style="color:#1d4ed8;text-decoration:underline;">$1</a>')
}
function mdToHtmlCD(text) {
  if (!text) return ''
  // Strip any AI reasoning/thinking tags that should never be displayed
  text = text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
  text = text.replace(/<ant[Tt]hinking>[\s\S]*?<\/ant[Tt]hinking>/gi, '')
  const lines = text.split('\n')
  const out = []
  let inTable = false, inUl = false, tableHeader = null
  lines.forEach(line => {
    const trimmed = line.trim()
    // Table rows
    if (trimmed.startsWith('|')) {
      if (!inTable) {
        inTable = true
        out.push('<div style="overflow-x:auto;margin:8px 0"><table style="width:100%;border-collapse:collapse;font-size:0.78rem">')
        tableHeader = trimmed
        out.push('<thead><tr>' + trimmed.split('|').filter((_, i, a) => i > 0 && i < a.length - 1).map(c => `<th style="padding:6px 10px;text-align:left;border-bottom:2px solid #e5e7eb;background:#f9fafb;white-space:nowrap">${applyInlineCD(c.trim())}</th>`).join('') + '</tr></thead><tbody>')
        return
      }
      if (/^\|[\s\-|]+\|$/.test(trimmed)) return // separator
      out.push('<tr>' + trimmed.split('|').filter((_, i, a) => i > 0 && i < a.length - 1).map(c => `<td style="padding:5px 10px;border-bottom:1px solid #f3f4f6;vertical-align:top">${applyInlineCD(c.trim())}</td>`).join('') + '</tr>')
      return
    }
    if (inTable) { out.push('</tbody></table></div>'); inTable = false }
    if (inUl && !trimmed.startsWith('-') && !trimmed.startsWith('*')) { out.push('</ul>'); inUl = false }
    if (!trimmed) { out.push('<br/>'); return }
    if (trimmed.startsWith('#### ')) { out.push(`<h4 style="font-size:0.8rem;font-weight:700;color:#374151;margin:10px 0 4px">${applyInlineCD(trimmed.slice(5))}</h4>`); return }
    if (trimmed.startsWith('### ')) { out.push(`<h3 style="font-size:0.875rem;font-weight:700;color:#111827;margin:12px 0 4px">${applyInlineCD(trimmed.slice(4))}</h3>`); return }
    if (trimmed.startsWith('## ')) { out.push(`<h2 style="font-size:1rem;font-weight:800;color:#111827;margin:14px 0 6px;padding-bottom:4px;border-bottom:1px solid #e5e7eb">${applyInlineCD(trimmed.slice(3))}</h2>`); return }
    if (trimmed.startsWith('- ') || trimmed.startsWith('* ') || (trimmed.startsWith('[ ]') || trimmed.startsWith('[x]'))) {
      if (!inUl) { out.push('<ul style="margin:4px 0;padding-left:20px;list-style:disc">'); inUl = true }
      out.push(`<li style="margin:2px 0;font-size:0.82rem;color:#374151">${applyInlineCD(trimmed.replace(/^[-*]\s/, '').replace(/^\[[x ]\]\s/, ''))}</li>`)
      return
    }
    out.push(`<p style="margin:4px 0;font-size:0.82rem;color:#374151;line-height:1.6">${applyInlineCD(trimmed)}</p>`)
  })
  if (inTable) out.push('</tbody></table></div>')
  if (inUl) out.push('</ul>')
  return out.join('')
}

// ── Dossier Section Content Renderer ─────────────────────────────────────────
function DossierSectionContent({ sectionText, emptyMessage }) {
  if (!sectionText) return <p className="text-sm text-gray-400 italic">{emptyMessage || 'No content available.'}</p>
  // Remove the first line (## SECTION N: Title) and the confidence badge line if present
  const lines = sectionText.split('\n')
  const body = lines.slice(lines[1]?.match(/^\*\*\[/) ? 2 : 1).join('\n').trim()
  if (!body) return <p className="text-sm text-gray-400 italic">{emptyMessage || 'No content available.'}</p>
  return <div dangerouslySetInnerHTML={{ __html: mdToHtmlCD(body) }} />
}

// ── Hook: load latest dossier content ────────────────────────────────────────
function useDossierSection(dossiers, sectionNums) {
  const [content, setContent] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!dossiers || dossiers.length === 0) return
    const latest = dossiers[0]
    const doExtract = (rawContent) => {
      const sections = {}
      for (const n of sectionNums) {
        sections[n] = parseSection(rawContent, n)
      }
      setContent(sections)
    }
    if (latest.content) { doExtract(latest.content); return }
    setLoading(true)
    getDossier(latest.id).then(({ data, error: err }) => {
      setLoading(false)
      if (err || !data?.content) { setError('Could not load profile content'); return }
      doExtract(data.content)
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dossiers, JSON.stringify(sectionNums)])
  return { content, loading, error }
}

// ── Hook: Haiku-generated bio summary from dossier Section 1 ─────────────────
// Calls generate-bio-summary on demand. Caches result in state so navigating
// back to the profile tab doesn't re-fire.  Exposed as { summary, loading, error, generate }.
function useBioSummary(dossiers, candidateName, session) {
  const [summary, setSummary]   = useState(null)
  const [loading, setLoading]   = useState(false)
  const [error, setError]       = useState(null)
  const [triggered, setTriggered] = useState(false)

  const generate = useCallback(async () => {
    if (!dossiers || dossiers.length === 0) return
    const latestId = dossiers[0].id
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/.netlify/functions/generate-bio-summary', {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          Authorization:   `Bearer ${session?.access_token}`,
        },
        body: JSON.stringify({ dossier_id: latestId, candidate_name: candidateName }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      // Strip any leading title/header lines the model sometimes outputs
      const raw = data.summary || null
      const stripped = raw
        ? raw
            .replace(/^(#{1,6}[^\n]*\n+)+/m, '')
            .replace(/^Political Intelligence Briefing[^\n]*\n*/im, '')
            .replace(/^[A-Z][^\n]{0,80}Candidate[^\n]*\n*/m, '')
            .replace(/^[A-Z][^\n]{0,80}Briefing[^\n]*\n*/m, '')
            .trim()
        : null
      setSummary(stripped || null)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [dossiers, candidateName, session])

  // Auto-generate once when dossiers become available
  useEffect(() => {
    if (!triggered && dossiers && dossiers.length > 0 && session?.access_token) {
      setTriggered(true)
      generate()
    }
  }, [dossiers, session, triggered, generate])

  return { summary, loading, error, generate }
}

// ── Opposition Research Tab ───────────────────────────────────────────────────
function OppositionResearchTab({ candidateId, dossiers, canIntel, weaknesses, timestamps }) {
  const { content, loading } = useDossierSection(dossiers, [6, 13])
  const [activeSection, setActiveSection] = useState('weaknesses')

  if (!canIntel) return <LockedFeatureCard icon={Shield} title="Opposition Research" />

  const hasDossier  = dossiers && dossiers.length > 0
  const hasWeakness = weaknesses.length > 0
  const navItems = [
    hasWeakness  && { id: 'weaknesses',    label: 'Key Weaknesses',     count: weaknesses.length,  dot: 'bg-red-500' },
    hasDossier   && { id: 'controversies', label: 'Controversies',      count: null,                dot: 'bg-amber-500' },
    hasDossier   && { id: 'attack',        label: 'Attack & Defense',   count: null,                dot: 'bg-blue-500' },
  ].filter(Boolean)

  // default to first available section
  const visibleSection = navItems.find(n => n.id === activeSection) ? activeSection
    : navItems[0]?.id || 'weaknesses'

  return (
    <div className="space-y-4">
      {/* Overview strip */}
      <div className="card !p-4 flex items-center gap-4 flex-wrap">
        <Shield className="w-5 h-5 text-brand-red flex-shrink-0" />
        <div>
          <p className="text-sm font-bold text-gray-900">Opposition Research</p>
          <p className="text-xs text-gray-500">
            {hasWeakness ? `${weaknesses.length} known weakness${weaknesses.length !== 1 ? 'es' : ''}` : 'No weaknesses on file'}
            {hasDossier ? ' · AI profile available' : ' · No profile generated yet'}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {hasDossier && (
            <Link to={`/dossiers?view=${dossiers[0]?.id}`} className="btn-secondary text-xs">Full profile →</Link>
          )}
          <Link to={`/dossiers?candidate=${candidateId}`} className="btn-primary text-xs flex items-center gap-1">
            <FileText className="w-3 h-3" /> {hasDossier ? 'Regenerate' : 'Generate Profile'}
          </Link>
        </div>
      </div>

      {/* Section nav (only if there are sections to show) */}
      {navItems.length > 1 && (
        <div className="flex gap-2 flex-wrap">
          {navItems.map(n => (
            <button
              key={n.id}
              onClick={() => setActiveSection(n.id)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all border ${
                visibleSection === n.id
                  ? 'bg-brand-navy text-white border-brand-navy shadow-sm'
                  : 'bg-white text-gray-600 border-gray-200 hover:border-gray-300'
              }`}
            >
              <span className={`w-2 h-2 rounded-full ${n.dot} ${visibleSection === n.id ? 'opacity-80' : ''}`} />
              {n.label}
              {n.count != null && (
                <span className={`ml-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-bold ${
                  visibleSection === n.id ? 'bg-white/20 text-white' : 'bg-gray-100 text-gray-500'
                }`}>{n.count}</span>
              )}
            </button>
          ))}
        </div>
      )}

      {/* Key Weaknesses panel */}
      {visibleSection === 'weaknesses' && (
        <div className="card">
          <h3 className="text-sm font-bold text-gray-900 mb-4 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-red-500" /> Key Weaknesses
            <SectionTimestamp ts={timestamps.weaknesses} />
          </h3>
          {hasWeakness ? (
            <div className="space-y-2">
              {weaknesses.map((w, i) => {
                const text = typeof w === 'string' ? w : w.text
                const severity = typeof w === 'object' && w.severity
                return (
                  <div key={i} className="flex items-start gap-3 p-3 bg-red-50 border border-red-100 rounded-lg">
                    <span className="flex-shrink-0 w-5 h-5 rounded-full bg-red-500 text-white flex items-center justify-center text-[10px] font-bold mt-0.5">
                      {i + 1}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-red-800 leading-relaxed">{text}</p>
                      {severity && (
                        <span className={`mt-1 inline-block text-[10px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wide ${
                          severity === 'critical' ? 'bg-red-200 text-red-800' :
                          severity === 'high'     ? 'bg-orange-100 text-orange-700' :
                                                    'bg-yellow-100 text-yellow-700'
                        }`}>{severity}</span>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            <p className="text-sm text-gray-400 italic py-4 text-center">No key weaknesses recorded for this candidate.</p>
          )}
        </div>
      )}

      {/* Controversies panel */}
      {visibleSection === 'controversies' && (
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-base font-bold text-gray-900 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-500" /> Controversies &amp; Opposition Research
            </h2>
            <SectionTimestamp ts={timestamps.controversies} />
          </div>
          {loading ? (
            <div className="flex justify-center py-8"><div className="w-6 h-6 border-3 border-brand-red border-t-transparent rounded-full animate-spin" /></div>
          ) : (
            <DossierSectionContent sectionText={content?.[6]} emptyMessage="No controversies section found in profile. Try regenerating." />
          )}
        </div>
      )}

      {/* Attack & Defense panel */}
      {visibleSection === 'attack' && (
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-base font-bold text-gray-900 flex items-center gap-2">
              <Target className="w-4 h-4 text-blue-500" /> Attack &amp; Defense Analysis
            </h2>
            <SectionTimestamp ts={timestamps.attack} />
          </div>
          {loading ? (
            <div className="flex justify-center py-8"><div className="w-6 h-6 border-3 border-brand-red border-t-transparent rounded-full animate-spin" /></div>
          ) : (
            <DossierSectionContent sectionText={content?.[13]} emptyMessage="No attack & defense section found in profile. Try regenerating." />
          )}
        </div>
      )}

      {/* Empty state when no dossier and no weaknesses */}
      {!hasDossier && !hasWeakness && (
        <div className="card text-center py-12">
          <Shield className="w-10 h-10 text-gray-200 mx-auto mb-3" />
          <p className="text-sm text-gray-500 mb-2">No opposition research yet.</p>
          <p className="text-xs text-gray-400 mb-4">Generate an AI profile to populate controversies, attack lines, and defense talking points.</p>
          <Link to={`/dossiers?candidate=${candidateId}`} className="btn-primary text-sm inline-flex items-center gap-2">
            <FileText className="w-4 h-4" /> Generate AI Profile →
          </Link>
        </div>
      )}
    </div>
  )
}

// ── Allies Tab ────────────────────────────────────────────────────────────────
function AlliesTab({ candidateId, dossiers, canIntel }) {
  const { content, loading } = useDossierSection(dossiers, [8, 9])

  if (!canIntel) return <LockedFeatureCard icon={Users} title="Allies & Network" />

  if (!dossiers || dossiers.length === 0) {
    return (
      <div className="card text-center py-12">
        <Users className="w-10 h-10 text-gray-200 mx-auto mb-3" />
        <p className="text-sm text-gray-500 mb-2">No profile generated yet.</p>
        <p className="text-xs text-gray-400 mb-4">Generate an AI profile to see endorsements, allies, and political network.</p>
        <Link to={`/dossiers?candidate=${candidateId}`} className="btn-primary text-sm inline-flex items-center gap-2">
          <FileText className="w-4 h-4" /> Generate AI Profile →
        </Link>
      </div>
    )
  }

  if (loading || content === null) {
    return (
      <div className="card flex justify-center py-12">
        <div className="w-6 h-6 border-3 border-brand-red border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  const hasSection8 = content?.[8] && content[8].trim().length > 0
  const hasSection9 = content?.[9] && content[9].trim().length > 0

  if (!hasSection8 && !hasSection9) {
    return (
      <div className="card text-center py-12">
        <Users className="w-10 h-10 text-gray-200 mx-auto mb-3" />
        <p className="text-sm text-gray-500 mb-2">No ally or endorsement data found in the latest profile.</p>
        <Link to={`/dossiers?candidate=${candidateId}`} className="btn-primary text-sm inline-flex items-center gap-2">
          <FileText className="w-4 h-4" /> Regenerate Profile →
        </Link>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Section 8: Affiliations & Endorsements — only if content exists */}
      {hasSection8 && (
        <div className="card">
          <h2 className="text-base font-bold text-gray-900 flex items-center gap-2 mb-4">
            <CheckCircle className="w-4 h-4 text-green-600" /> Affiliations &amp; Endorsements
          </h2>
          <DossierSectionContent sectionText={content[8]} />
        </div>
      )}

      {/* Section 9: Political Network — only if content exists */}
      {hasSection9 && (
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-base font-bold text-gray-900 flex items-center gap-2">
              <Users className="w-4 h-4 text-brand-navy" /> Political Network &amp; Allies
            </h2>
            <Link to={`/dossiers?view=${dossiers[0]?.id}`} className="text-xs text-brand-red hover:underline">Full profile →</Link>
          </div>
          <DossierSectionContent sectionText={content[9]} />
        </div>
      )}

      <div className="flex gap-3">
        <Link to={`/dossiers?view=${dossiers[0]?.id}`} className="text-xs text-brand-red hover:underline font-medium">
          View full profile →
        </Link>
        <span className="text-xs text-gray-300">|</span>
        <Link to={`/dossiers?candidate=${candidateId}`} className="text-xs text-gray-500 hover:text-gray-700">
          Regenerate for latest data
        </Link>
      </div>
    </div>
  )
}

// ── X / Twitter live feed ──────────────────────────────────────────────────
function XTweetCard({ id, text, author_name, author_username, author_image, created_at, public_metrics }) {
  const tweetUrl = author_username
    ? `https://x.com/${author_username}/status/${id}`
    : `https://x.com/search?q=${encodeURIComponent(text?.slice(0, 40) || '')}`

  const dateStr = created_at
    ? new Date(created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : ''

  const likes    = public_metrics?.like_count    ?? 0
  const retweets = public_metrics?.retweet_count ?? 0
  const replies  = public_metrics?.reply_count   ?? 0

  return (
    <a href={tweetUrl} target="_blank" rel="noopener noreferrer"
      className="block border border-gray-100 rounded-lg p-3 hover:bg-gray-50 transition-colors group">
      <div className="flex items-start gap-2.5">
        {/* Avatar */}
        <div className="w-8 h-8 rounded-full bg-black flex items-center justify-center flex-shrink-0 overflow-hidden">
          {author_image
            ? <img src={author_image} alt={author_name} className="w-full h-full object-cover" />
            : <span className="text-white text-xs font-bold">𝕏</span>
          }
        </div>
        <div className="flex-1 min-w-0">
          {/* Author + date */}
          <div className="flex items-center gap-1.5 mb-1">
            <span className="text-xs font-bold text-gray-900 truncate max-w-[120px]">{author_name}</span>
            {author_username && (
              <span className="text-xs text-gray-400 truncate">@{author_username}</span>
            )}
            {dateStr && (
              <span className="text-xs text-gray-400 ml-auto flex-shrink-0">{dateStr}</span>
            )}
          </div>
          {/* Tweet text */}
          <p className="text-xs text-gray-700 leading-relaxed line-clamp-4 group-hover:line-clamp-none transition-all">{text}</p>
          {/* Metrics */}
          {(likes > 0 || retweets > 0 || replies > 0) && (
            <div className="flex items-center gap-3 mt-1.5 text-xs text-gray-400">
              {replies  > 0 && <span>↩ {replies.toLocaleString()}</span>}
              {retweets > 0 && <span>↻ {retweets.toLocaleString()}</span>}
              {likes    > 0 && <span>♡ {likes.toLocaleString()}</span>}
            </div>
          )}
        </div>
      </div>
    </a>
  )
}

// ── Candidate Election Results Tab ────────────────────────────────────────────
// Shows this candidate's results across all elections they appeared in.
// Uses the new election_results + election_contests tables.
// Subscribes to Realtime so numbers update live on election night.
function CandidateElectionResultsTab({ candidate }) {
  const [results,  setResults]  = useState([])   // [{result, contest, election}]
  const [loading,  setLoading]  = useState(true)
  const [isLive,   setIsLive]   = useState(false)

  useEffect(() => {
    if (!candidate?.id) return
    loadResults()
  }, [candidate?.id])

  // Realtime subscription: update this candidate's numbers live
  useEffect(() => {
    if (!candidate?.id) return
    const channel = supabase
      .channel(`cand-results-${candidate.id}`)
      .on('postgres_changes', {
        event:  'UPDATE',
        schema: 'public',
        table:  'election_results',
        filter: `candidate_id=eq.${candidate.id}`,
      }, (payload) => {
        setResults(prev =>
          prev.map(row =>
            row.result.id === payload.new.id
              ? { ...row, result: payload.new }
              : row
          )
        )
        setIsLive(true)
      })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [candidate?.id])

  async function loadResults() {
    setLoading(true)
    try {
      // Find results where candidate_id matches
      const { data: resultRows } = await supabase
        .from('election_results')
        .select('*, contest:election_contests(*, election:elections(id, name, election_date, type))')
        .eq('candidate_id', candidate.id)
        .order('updated_at', { ascending: false })

      if (resultRows?.length) {
        setResults(resultRows.map(r => ({
          result:  r,
          contest: r.contest,
          election: r.contest?.election,
        })))
      } else {
        // Fallback: try name match if candidate_id wasn't linked yet
        const lastName = candidate.name?.split(' ').pop() || ''
        if (lastName.length > 2) {
          const { data: nameRows } = await supabase
            .from('election_results')
            .select('*, contest:election_contests(*, election:elections(id, name, election_date, type))')
            .ilike('candidate_name', `%${lastName}%`)
            .order('updated_at', { ascending: false })
            .limit(20)
          setResults((nameRows || []).map(r => ({ result: r, contest: r.contest, election: r.contest?.election })))
        }
      }
    } catch (err) {
      console.error('[CandidateElectionResultsTab] load error:', err)
    }
    setLoading(false)
  }

  const partyStyle = (party) => ({
    Democrat:    'bg-blue-100 text-blue-800',
    Republican:  'bg-red-100 text-brand-red',
    Independent: 'bg-purple-100 text-purple-800',
    Nonpartisan: 'bg-gray-100 text-gray-600',
  }[party] || 'bg-gray-100 text-gray-600')

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="w-8 h-8 border-4 border-brand-red border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  if (!results.length) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <div className="w-14 h-14 rounded-full bg-gray-100 flex items-center justify-center mb-4">
          <BarChart2 className="w-7 h-7 text-gray-300" />
        </div>
        <p className="text-gray-500 font-semibold">No election results on file</p>
        <p className="text-gray-400 text-sm mt-1 max-w-xs">
          Results populate automatically via the WEC API when this candidate appears in an active Wisconsin election.
        </p>
        <Link
          to="/elections"
          className="mt-4 text-xs text-brand-red hover:underline font-medium"
        >
          View Elections Calendar →
        </Link>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-bold text-gray-900 flex items-center gap-2">
          <BarChart2 className="w-4 h-4 text-brand-red" />
          Election History
          {isLive && (
            <span className="flex items-center gap-1 text-xs text-red-600 font-semibold">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500" />
              </span>
              Live
            </span>
          )}
        </h3>
        <span className="text-xs text-gray-400">{results.length} race{results.length !== 1 ? 's' : ''}</span>
      </div>

      <div className="space-y-3">
        {results.map(({ result, contest, election }) => {
          const isWinner  = result.winner
          const isDeclared = result.declared
          const votePct   = result.vote_pct != null ? Number(result.vote_pct).toFixed(1) : null

          return (
            <div
              key={result.id}
              className={`rounded-xl border-2 p-4 transition-all ${
                isWinner && isDeclared
                  ? 'border-green-200 bg-green-50'
                  : 'border-gray-200 bg-white'
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  {/* Race + election */}
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    {isWinner && isDeclared && <Trophy className="w-4 h-4 text-green-500 flex-shrink-0" />}
                    <span className={`font-semibold text-sm ${isWinner && isDeclared ? 'text-green-800' : 'text-gray-900'}`}>
                      {contest?.office || 'Unknown Race'}
                    </span>
                    {isWinner && isDeclared && (
                      <span className="text-xs bg-green-100 text-green-700 px-1.5 py-0.5 rounded font-semibold">
                        WON
                      </span>
                    )}
                    {!isWinner && result.votes > 0 && (
                      <span className="text-xs bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded">
                        Lost
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-gray-400 mb-2">
                    {election?.name || 'Wisconsin Election'}
                    {election?.election_date && ` · ${election.election_date}`}
                  </p>

                  {/* Vote bar */}
                  {votePct != null && (
                    <div className="flex items-center gap-2">
                      <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all duration-700 ${
                            isWinner ? 'bg-green-500' : 'bg-gray-400'
                          }`}
                          style={{ width: `${Math.min(100, Number(votePct))}%` }}
                        />
                      </div>
                      <span className="text-xs font-bold tabular-nums text-gray-700 w-12 text-right">
                        {votePct}%
                      </span>
                    </div>
                  )}
                </div>

                {/* Votes count */}
                <div className="text-right flex-shrink-0">
                  {result.votes != null && (
                    <>
                      <p className="text-lg font-bold tabular-nums text-gray-900">
                        {Number(result.votes).toLocaleString()}
                      </p>
                      <p className="text-xs text-gray-400">votes</p>
                    </>
                  )}
                  {result.party && (
                    <span className={`inline-block mt-1 text-xs px-1.5 py-0.5 rounded font-medium ${partyStyle(result.party)}`}>
                      {result.party}
                    </span>
                  )}
                </div>
              </div>

              {/* Link to full results */}
              {election?.id && (
                <Link
                  to={`/elections?tab=results&election=${election.id}`}
                  className="mt-2 inline-flex items-center gap-1 text-xs text-brand-red hover:underline"
                >
                  <BarChart2 className="w-3 h-3" />
                  View full race results
                </Link>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function XFeed({ candidate }) {
  const [tweets,  setTweets]  = useState([])
  const [loading, setLoading] = useState(false)
  const [fetched, setFetched] = useState(false)
  const [error,   setError]   = useState('')

  const loadTweets = async () => {
    setLoading(true)
    setError('')
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token
      const res = await fetch('/.netlify/functions/fetch-candidate-x-feed', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          candidateName: candidate?.name || '',
          handle:        candidate?.twitter_handle || '',
          district:      candidate?.office?.district_name || '',
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `Error ${res.status}`)
      setTweets(data.tweets || [])
      setFetched(true)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
      {/* Header */}
      <div className="flex items-center gap-2 mb-3 pb-2 border-b border-gray-100">
        <div className="w-4 h-4 rounded bg-black flex items-center justify-center flex-shrink-0">
          <span className="text-white font-bold" style={{ fontSize: 9 }}>𝕏</span>
        </div>
        <h4 className="text-sm font-bold text-gray-800">X / Twitter</h4>
        <span className="text-xs bg-black text-white px-1.5 py-0.5 rounded font-bold tracking-wide" style={{ fontSize: 9 }}>LIVE</span>
        {fetched && tweets.length > 0 && (
          <span className="text-xs text-gray-400 ml-1">{tweets.length} posts</span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {candidate?.twitter_handle && (
            <a href={`https://x.com/${candidate.twitter_handle}`} target="_blank" rel="noopener noreferrer"
              className="text-xs text-gray-400 hover:text-gray-600">
              @{candidate.twitter_handle} ↗
            </a>
          )}
          <button onClick={loadTweets} disabled={loading}
            className="text-xs text-brand-red hover:underline font-medium disabled:opacity-50">
            {loading ? 'Loading…' : fetched ? '↻ Refresh' : 'Load Posts'}
          </button>
        </div>
      </div>

      {/* Body */}
      {!fetched && !loading && !error && (
        <div className="text-center py-6">
          <div className="w-10 h-10 rounded-full bg-black flex items-center justify-center mx-auto mb-3">
            <span className="text-white font-bold text-base">𝕏</span>
          </div>
          <p className="text-xs text-gray-500 mb-3">
            Load real-time posts from X about{' '}
            <span className="font-semibold">{candidate?.name}</span>.
          </p>
          <button onClick={loadTweets}
            className="btn-primary text-xs px-4 py-2">
            Load X Posts
          </button>
        </div>
      )}

      {loading && (
        <div className="flex justify-center py-8">
          <div className="w-5 h-5 border-2 border-black border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-xs text-red-700">
          <p className="font-semibold mb-1">Could not load X posts</p>
          <p className="text-red-600">{error}</p>
          {error.includes('not configured') && (
            <p className="mt-2 text-gray-500">Add <code className="bg-gray-100 px-1 rounded">X_BEARER_TOKEN</code> to your Netlify environment variables.</p>
          )}
          <button onClick={loadTweets} className="mt-2 text-brand-red hover:underline font-medium">Try again</button>
        </div>
      )}

      {fetched && !loading && tweets.length === 0 && (
        <div className="text-center py-6">
          <p className="text-xs text-gray-400">No recent X posts found for {candidate?.name}.</p>
          {candidate?.twitter_handle
            ? <p className="text-xs text-gray-400 mt-1">Try checking <a href={`https://x.com/${candidate.twitter_handle}`} target="_blank" rel="noopener noreferrer" className="text-brand-red hover:underline">@{candidate.twitter_handle}</a> directly.</p>
            : <p className="text-xs text-gray-400 mt-1">Add their X handle to the candidate profile to improve results.</p>
          }
        </div>
      )}

      {fetched && tweets.length > 0 && (
        <div className="space-y-2 max-h-[600px] overflow-y-auto">
          {tweets.map(t => <XTweetCard key={t.id} {...t} />)}
        </div>
      )}
    </div>
  )
}

function NewsAndSocialTab({ candidateId, candidate, dossiers, canIntel }) {
  const [loading, setLoading] = useState(false)
  const [newsItems, setNewsItems] = useState(null)
  const [socialItems, setSocialItems] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!dossiers || dossiers.length === 0) return
    const latest = dossiers[0]
    // If content is already in the dossier list, use it
    if (latest.content) {
      extractItems(latest.content)
    } else {
      // Fetch full dossier
      setLoading(true)
      getDossier(latest.id).then(({ data, error: err }) => {
        setLoading(false)
        if (err || !data?.content) { setError('Could not load profile content'); return }
        extractItems(data.content)
      })
    }
  }, [dossiers])

  const extractItems = (content) => {
    // Find section 1 content (news & media)
    const parts = ('\n' + content).split(/\n(?=## SECTION \d)/i)
    let section1 = ''
    for (const part of parts) {
      if (/^## SECTION 1[:\s]/i.test(part.trim())) { section1 = part.trim(); break }
    }

    // Parse Section 1 for news items
    const sec1Items = section1 ? parseNewsItems(section1) : []
    const qualifiedNews = sec1Items.filter(it => (it.source || it.url) && !it.title.startsWith('NOT FOUND') && !it.isSocial)
    const sec1Social = sec1Items.filter(it => (it.source || it.url) && !it.title.startsWith('NOT FOUND') && it.isSocial)

    // Parse Section 10 for dedicated social media posts
    const sec10Items = parseSocialItems(content)
    const qualifiedSec10 = sec10Items.filter(it => (it.source || it.url) && !it.title.startsWith('NOT FOUND'))

    // Merge social items from both sections (dedup by title)
    const seenTitles = new Set()
    const allSocial = []
    for (const item of [...qualifiedSec10, ...sec1Social]) {
      const key = item.title.toLowerCase().trim()
      if (!seenTitles.has(key)) { seenTitles.add(key); allSocial.push(item) }
    }

    if (qualifiedNews.length === 0 && allSocial.length === 0) {
      setError('No structured news items found. Regenerate the profile to get clickable news cards.')
      return
    }

    setNewsItems(qualifiedNews)
    setSocialItems(allSocial)
  }

  if (!canIntel) return <LockedFeatureCard icon={Newspaper} title="News & Social" />

  if (!dossiers || dossiers.length === 0) {
    return (
      <div className="card text-center py-12">
        <Newspaper className="w-10 h-10 text-gray-200 mx-auto mb-3" />
        <p className="text-sm text-gray-500 mb-2">No profiles generated yet.</p>
        <p className="text-xs text-gray-400 mb-4">Generate an AI profile to see news coverage and social media activity.</p>
        <Link to={`/dossiers?candidate=${candidateId}`} className="btn-primary text-sm inline-flex items-center gap-2">
          <FileText className="w-4 h-4" /> Generate AI Profile →
        </Link>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="card flex justify-center py-16">
        <div className="w-6 h-6 border-3 border-brand-red border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="card">
        <div className="flex items-center gap-2 mb-4">
          <Newspaper className="w-5 h-5 text-brand-red" />
          <h2 className="text-base font-bold text-gray-900">News Feed</h2>
        </div>
        <div className="bg-blue-50 border border-blue-200 rounded-xl px-3 py-2 flex items-center gap-2">
          <Sparkles className="w-3.5 h-3.5 text-blue-500 flex-shrink-0" />
          <p className="text-xs text-blue-700">
            <span className="font-semibold">{error}</span>
          </p>
        </div>
        <div className="mt-4">
          <Link to={`/dossiers?candidate=${candidateId}`} className="btn-primary text-sm inline-flex items-center gap-2">
            <FileText className="w-4 h-4" /> {newsItems === null ? 'Generate' : 'Regenerate'} Profile →
          </Link>
        </div>
      </div>
    )
  }

  const hasNews = newsItems && newsItems.length > 0
  const hasSocial = socialItems && socialItems.length > 0

  return (
    <div className="space-y-4">
      {/* 2-column layout: news left, X feed + social right */}
      <div className="flex gap-6">
        {/* Left column — News Feed */}
        <div className="flex-1 min-w-0">
          <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
            <div className="flex items-center gap-2 mb-3 pb-2 border-b border-gray-100">
              <Newspaper className="w-4 h-4 text-blue-600" />
              <h4 className="text-sm font-bold text-gray-800">News Feed</h4>
              {hasNews && <span className="text-xs text-gray-400 ml-auto">{newsItems.length} items</span>}
            </div>
            {hasNews ? (
              <div className="space-y-2 max-h-[700px] overflow-y-auto">
                {newsItems.map((item, idx) => <MiniNewsCard key={idx} {...item} />)}
              </div>
            ) : (
              <p className="text-xs text-gray-400 italic py-2">No press items found in the latest profile.</p>
            )}
          </div>
        </div>

        {/* Right column — X / Twitter feed at top, then social media posts */}
        <div className="w-80 shrink-0 flex flex-col gap-4">
          {/* X / Twitter live feed */}
          <XFeed candidate={candidate} />

          {/* Social Media Feed panel */}
          <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
            <div className="flex items-center gap-2 mb-3 pb-2 border-b border-purple-100">
              <MessageSquare className="w-4 h-4 text-purple-600" />
              <h4 className="text-sm font-bold text-gray-800">Social Media Feed</h4>
              {hasSocial && <span className="text-xs text-gray-400 ml-auto">{socialItems.length} posts</span>}
            </div>
            {hasSocial ? (
              <div className="space-y-2 max-h-[500px] overflow-y-auto">
                {socialItems.map((item, idx) => <SocialMediaCard key={idx} {...item} />)}
              </div>
            ) : (
              <div className="text-center py-6">
                <MessageSquare className="w-8 h-8 text-purple-200 mx-auto mb-2" />
                <p className="text-xs text-gray-400 mb-1">No social media posts found in the latest profile.</p>
                <p className="text-xs text-gray-400">Regenerate the profile to search for social media activity.</p>
              </div>
            )}
            {/* Platform legend */}
            {hasSocial && (
              <div className="flex flex-wrap gap-1.5 mt-3 pt-2 border-t border-gray-100">
                {Object.entries(PLATFORM_META).filter(([key]) => socialItems.some(it => detectPlatform(it.source) === key)).map(([key, meta]) => (
                  <span key={key} className={`inline-flex items-center gap-1 text-xs text-white px-1.5 py-0.5 rounded ${meta.color}`}>
                    <span className="font-bold text-[10px]">{meta.icon}</span> {meta.label}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Link to={`/dossiers?view=${dossiers[0]?.id}`} className="text-xs text-brand-red hover:underline font-medium">
          View full profile →
        </Link>
        <span className="text-xs text-gray-300">|</span>
        <Link to={`/dossiers?candidate=${candidateId}`} className="text-xs text-gray-500 hover:text-gray-700">
          Regenerate profile for latest news
        </Link>
      </div>
    </div>
  )
}

// ── SWOT Analysis Tab ─────────────────────────────────────────────────────
function SwotTab({ candidate, dossiers, user, onRefresh }) {
  const [swot, setSwot] = useState(candidate.swot_data || { strengths: '', weaknesses: '', opportunities: '', threats: '' })
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [aiLoading, setAiLoading] = useState(false)
  const [aiError, setAiError] = useState('')

  const hasContent = swot.strengths || swot.weaknesses || swot.opportunities || swot.threats

  const handleSave = async () => {
    setSaving(true)
    await updateCandidate(candidate.id, { swot_data: swot })
    setSaving(false)
    setEditing(false)
    onRefresh()
  }

  const handleAiGenerate = async () => {
    if (!dossiers?.length) return
    setAiLoading(true)
    setAiError('')
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token || ''
      const res = await fetch('/.netlify/functions/research-swot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ candidate_id: candidate.id, candidate_name: candidate.name }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'SWOT analysis failed')
      setSwot(data.swot)
      // Auto-save
      await updateCandidate(candidate.id, { swot_data: data.swot })
      onRefresh()
    } catch (err) {
      setAiError(err.message || 'Failed to generate SWOT')
    }
    setAiLoading(false)
  }

  const quadrants = [
    { key: 'strengths',     label: 'Strengths',      icon: TrendingUp,    color: 'green',  borderColor: 'border-green-200', bgColor: 'bg-green-50', textColor: 'text-green-700', iconColor: 'text-green-600' },
    { key: 'weaknesses',    label: 'Weaknesses',     icon: TrendingDown,  color: 'red',    borderColor: 'border-red-200',   bgColor: 'bg-red-50',   textColor: 'text-red-700',   iconColor: 'text-red-600' },
    { key: 'opportunities', label: 'Opportunities',  icon: Target,        color: 'blue',   borderColor: 'border-blue-200',  bgColor: 'bg-blue-50',  textColor: 'text-blue-700',  iconColor: 'text-blue-600' },
    { key: 'threats',       label: 'Threats',         icon: AlertTriangle, color: 'amber',  borderColor: 'border-amber-200', bgColor: 'bg-amber-50', textColor: 'text-amber-700', iconColor: 'text-amber-600' },
  ]

  return (
    <div className="space-y-4">
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Target className="w-5 h-5 text-brand-red" />
            <h2 className="text-base font-bold text-gray-900">SWOT Analysis</h2>
          </div>
          <div className="flex items-center gap-2">
            {dossiers?.length > 0 && (
              <button
                onClick={handleAiGenerate}
                disabled={aiLoading}
                className="btn-secondary text-sm flex items-center gap-1.5"
                title="Generate SWOT analysis from this candidate's profile"
              >
                <Sparkles className={`w-4 h-4 text-amber-500 ${aiLoading ? 'animate-spin' : ''}`} />
                {aiLoading ? 'Analyzing…' : 'AI Generate'}
              </button>
            )}
            {hasContent && !editing && (
              <button onClick={() => setEditing(true)} className="btn-secondary text-sm flex items-center gap-1.5">
                <Edit2 className="w-4 h-4" /> Edit
              </button>
            )}
            {editing && (
              <>
                <button onClick={() => { setEditing(false); setSwot(candidate.swot_data || { strengths: '', weaknesses: '', opportunities: '', threats: '' }) }} className="btn-secondary text-sm">Cancel</button>
                <button onClick={handleSave} disabled={saving} className="btn-primary text-sm">{saving ? 'Saving…' : 'Save'}</button>
              </>
            )}
          </div>
        </div>

        {aiError && (
          <div className="mb-4 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
            <p className="text-xs text-amber-800">{aiError}</p>
            <button onClick={() => setAiError('')} className="ml-auto text-amber-500 hover:text-amber-700"><X className="w-3.5 h-3.5" /></button>
          </div>
        )}

        {!hasContent && !editing ? (
          <div className="text-center py-10 text-gray-400">
            <Target className="w-10 h-10 mx-auto mb-2 opacity-30" />
            <p className="text-sm mb-1">No SWOT analysis yet.</p>
            {dossiers?.length > 0 ? (
              <p className="text-xs">Click <span className="font-semibold text-amber-600">AI Generate</span> to auto-create from the profile, or <button onClick={() => setEditing(true)} className="font-semibold text-brand-red hover:underline">add manually</button>.</p>
            ) : (
              <p className="text-xs">Generate a profile first, then come back to create a SWOT analysis.</p>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {quadrants.map(({ key, label, icon: Icon, borderColor, bgColor, textColor, iconColor }) => (
              <div key={key} className={`rounded-xl border ${borderColor} ${bgColor} p-4`}>
                <div className="flex items-center gap-2 mb-2">
                  <Icon className={`w-4 h-4 ${iconColor}`} />
                  <h3 className={`text-sm font-bold ${textColor}`}>{label}</h3>
                </div>
                {editing ? (
                  <textarea
                    className="w-full bg-white/80 border border-gray-200 rounded-lg p-2 text-sm text-gray-700 min-h-[80px] resize-y"
                    value={swot[key] || ''}
                    onChange={(e) => setSwot(prev => ({ ...prev, [key]: e.target.value }))}
                    placeholder={`Enter ${label.toLowerCase()}...`}
                  />
                ) : (
                  <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-line">
                    {swot[key] || <span className="text-gray-400 italic">Not yet analyzed</span>}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Status detection from dossier content ────────────────────────────────────
function detectStatusFromDossier(content) {
  if (!content) return null
  const text = content.toLowerCase()
  // Order: most definitive first
  if (/\belecte[d]\b/.test(text) || /\bwon\s+(the\s+)?general\b/.test(text) || /\bwins?\s+(the\s+)?general\b/.test(text)) return 'elected'
  if (/\blost?\s+(the\s+)?(general|election|race)\b/.test(text) || /\bwas\s+defeated\b/.test(text) || /\bdefeat(?:ed)?\s+in\s+(the\s+)?general\b/.test(text)) return 'lost'
  if (/\bwithdr[ae]w[n]?\b/.test(text) || /\bdropped?\s+out\b/.test(text) || /\bended\s+their\s+campaign\b/.test(text)) return 'withdrawn'
  if (/\bwon\s+(the\s+)?primary\b/.test(text) || /\bprimary\s+winner\b/.test(text) || /\badvance[sd]\s+to\s+(the\s+)?general\b/.test(text)) return 'primary_winner'
  if (/\bhas\s+formally\s+(declared|announced|filed)\b/.test(text) || /\bofficially\s+(declared|announced|filed)\b/.test(text) || /\bhas\s+filed\b/.test(text) || /\bfiled\s+(their\s+)?candidacy\b/.test(text)) return 'declared'
  return null
}

const STATUS_REC_LABELS = {
  declared:      'Declared',
  withdrawn:     'Withdrawn',
  primary_winner:'Primary Winner',
  elected:       'Elected',
  lost:          'Lost',
}

function StatusRecommendationBanner({ candidate, dossiers, onAccept, onDismiss }) {
  const [rec, setRec] = useState(null)
  const [accepted, setAccepted] = useState(false)
  const [accepting, setAccepting] = useState(false)

  useEffect(() => {
    if (!dossiers?.length || accepted) return
    const latest = dossiers[0]
    const analyze = (content) => {
      const detected = detectStatusFromDossier(content)
      if (detected && detected !== candidate.status) setRec(detected)
    }
    if (latest.content) { analyze(latest.content); return }
    getDossier(latest.id).then(({ data }) => { if (data?.content) analyze(data.content) })
  }, [dossiers, candidate.status, accepted])

  if (!rec || accepted) return null

  const recLabel = STATUS_REC_LABELS[rec] || rec
  const curLabel = STATUS_LABELS[candidate.status] || candidate.status

  return (
    <div className="flex items-center gap-3 px-4 py-3 rounded-xl border border-amber-200 bg-amber-50">
      <div className="w-8 h-8 rounded-lg bg-amber-100 flex items-center justify-center flex-shrink-0">
        <Sparkles className="w-4 h-4 text-amber-600" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-amber-900">Profile suggests a status update</p>
        <p className="text-xs text-amber-700 mt-0.5">
          Current: <span className="font-medium">{curLabel}</span> → Suggested: <span className="font-medium">{recLabel}</span>
        </p>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        <button
          onClick={() => { setAccepted(true); onDismiss?.() }}
          className="text-xs text-amber-600 hover:text-amber-800 font-medium px-2 py-1 rounded hover:bg-amber-100 transition-colors"
        >
          Dismiss
        </button>
        <button
          onClick={async () => {
            setAccepting(true)
            try {
              await onAccept(rec)
              setAccepted(true)
            } finally {
              setAccepting(false)
            }
          }}
          disabled={accepting}
          className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-700 text-white transition-colors disabled:opacity-50"
        >
          {accepting ? 'Updating...' : `Update to ${recLabel}`}
        </button>
      </div>
    </div>
  )
}

// ── Notes data helpers ────────────────────────────────────────────────────────
function parseNotesData(raw) {
  if (!raw) return { v: 2, notes: [], files: [] }
  if (typeof raw === 'string' && raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw)
      if (parsed.v === 2) return parsed
    } catch {}
  }
  // Legacy plain-text note
  if (raw && raw.trim()) {
    return { v: 2, notes: [{ id: 'legacy', text: raw, ts: null }], files: [] }
  }
  return { v: 2, notes: [], files: [] }
}

function fileIcon(mimeType = '') {
  if (mimeType.includes('pdf'))    return 'PDF'
  if (mimeType.includes('word') || mimeType.includes('document')) return 'DOC'
  if (mimeType.includes('sheet') || mimeType.includes('excel') || mimeType.includes('csv')) return 'XLS'
  if (mimeType.startsWith('image/')) return 'IMG'
  return 'FILE'
}

function formatBytes(bytes) {
  if (bytes < 1024)    return `${bytes} B`
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1048576).toFixed(1)} MB`
}

// ── Notes & Files Panel ───────────────────────────────────────────────────────
function NotesAndFilesPanel({ candidateId, userId, rawNotes, onSaved }) {
  const [data, setData]               = useState(() => parseNotesData(rawNotes))
  const [noteText, setNoteText]       = useState('')
  const [addingNote, setAddingNote]   = useState(false)
  const [savingNote, setSavingNote]   = useState(false)
  const [uploadingFile, setUploadingFile] = useState(false)
  const [uploadError, setUploadError] = useState('')
  const [togglingId, setTogglingId]   = useState(null)
  const [deletingId, setDeletingId]   = useState(null)
  const [signedUrls, setSignedUrls]   = useState({})
  const fileRef = useRef(null)

  useEffect(() => { setData(parseNotesData(rawNotes)) }, [rawNotes])

  const persist = async (newData) => {
    setData(newData)
    await updateCandidate(candidateId, { notes: JSON.stringify(newData) })
    onSaved?.()
  }

  const handleAddNote = async () => {
    if (!noteText.trim()) return
    setSavingNote(true)
    const note = {
      id: (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36)),
      text: noteText.trim(),
      ts: new Date().toISOString(),
    }
    await persist({ ...data, notes: [note, ...(data.notes || [])] })
    setNoteText(''); setAddingNote(false); setSavingNote(false)
  }

  const handleDeleteNote = async (noteId) => {
    setDeletingId(noteId)
    await persist({ ...data, notes: (data.notes || []).filter(n => n.id !== noteId) })
    setDeletingId(null)
  }

  const handleFileUpload = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    setUploadingFile(true); setUploadError('')
    const fileId   = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36)
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_')
    const path     = `${userId}/${candidateId}/${fileId}-${safeName}`
    try {
      const { error: upErr } = await supabase.storage.from('candidate-files').upload(path, file, { cacheControl: '3600', upsert: false })
      if (upErr) throw new Error(upErr.message)
      await persist({
        ...data,
        files: [...(data.files || []), {
          id: fileId, name: file.name, path,
          size: file.size, type: file.type || 'application/octet-stream',
          ai_access: false, ts: new Date().toISOString(),
        }],
      })
    } catch (err) { setUploadError(err.message || 'Upload failed') }
    setUploadingFile(false)
  }

  const handleToggleAi = async (fileId) => {
    setTogglingId(fileId)
    await persist({ ...data, files: (data.files || []).map(f => f.id === fileId ? { ...f, ai_access: !f.ai_access } : f) })
    setTogglingId(null)
  }

  const handleDeleteFile = async (file) => {
    if (!window.confirm(`Delete "${file.name}"? This cannot be undone.`)) return
    setDeletingId(file.id)
    try { await supabase.storage.from('candidate-files').remove([file.path]) } catch {}
    await persist({ ...data, files: (data.files || []).filter(f => f.id !== file.id) })
    setDeletingId(null)
  }

  const handleDownload = async (file) => {
    if (signedUrls[file.id]) { window.open(signedUrls[file.id], '_blank'); return }
    const { data: urlData, error } = await supabase.storage.from('candidate-files').createSignedUrl(file.path, 3600)
    if (error || !urlData?.signedUrl) { alert('Could not generate download link.'); return }
    setSignedUrls(p => ({ ...p, [file.id]: urlData.signedUrl }))
    window.open(urlData.signedUrl, '_blank')
  }

  const notes = data.notes || []
  const files = data.files || []
  const aiFiles = files.filter(f => f.ai_access).length

  return (
    <div className="space-y-4">
      {/* Notes */}
      <div className="card">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-bold text-gray-900 flex items-center gap-2">
            <MessageSquare className="w-4 h-4 text-brand-navy" /> Internal Notes
            {notes.length > 0 && <span className="text-xs font-normal text-gray-400">({notes.length})</span>}
          </h2>
          {!addingNote && (
            <button onClick={() => setAddingNote(true)} className="flex items-center gap-1.5 text-xs font-semibold text-brand-red hover:text-red-700 border border-brand-red/20 hover:border-brand-red/50 rounded-lg px-2.5 py-1 transition-all">
              <Plus className="w-3.5 h-3.5" /> Add Note
            </button>
          )}
        </div>

        {addingNote && (
          <div className="mb-4 space-y-2">
            <textarea
              autoFocus
              className="input text-sm"
              rows={3}
              value={noteText}
              onChange={e => setNoteText(e.target.value)}
              placeholder="Type your note here... (Cmd+Enter to save)"
              onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleAddNote() }}
            />
            <div className="flex items-center justify-end gap-2">
              <button onClick={() => { setAddingNote(false); setNoteText('') }} className="btn-secondary text-xs py-1.5">Cancel</button>
              <button
                onClick={handleAddNote}
                disabled={savingNote || !noteText.trim()}
                className="btn-primary text-xs py-1.5 flex items-center gap-1.5"
              >
                {savingNote ? <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                Save Note
              </button>
            </div>
          </div>
        )}

        {notes.length === 0 && !addingNote ? (
          <div className="text-center py-6 border border-dashed border-gray-200 rounded-xl">
            <MessageSquare className="w-7 h-7 text-gray-200 mx-auto mb-1.5" />
            <p className="text-xs text-gray-400">No notes yet</p>
            <button onClick={() => setAddingNote(true)} className="text-xs text-brand-red hover:underline mt-1">Add the first note →</button>
          </div>
        ) : (
          <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
            {notes.map(note => (
              <div key={note.id} className={`group relative p-3 rounded-xl border border-gray-100 bg-gray-50 hover:bg-white hover:border-gray-200 transition-all ${deletingId === note.id ? 'opacity-50' : ''}`}>
                <p className="text-sm text-gray-800 leading-relaxed whitespace-pre-line pr-6">{note.text}</p>
                {note.ts && (
                  <p className="text-xs text-gray-400 mt-1.5">
                    <Clock className="w-3 h-3 inline mr-1" />
                    {note.ts ? format(new Date(note.ts), 'MMM d, yyyy · h:mm a') : 'Legacy note'}
                  </p>
                )}
                <button
                  onClick={() => handleDeleteNote(note.id)}
                  disabled={deletingId === note.id}
                  className="absolute top-2.5 right-2.5 opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-red-50 text-gray-300 hover:text-brand-red transition-all"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Files */}
      <div className="card">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-bold text-gray-900 flex items-center gap-2">
            <Paperclip className="w-4 h-4 text-brand-navy" /> Files & Attachments
            {files.length > 0 && <span className="text-xs font-normal text-gray-400">({files.length})</span>}
          </h2>
          <button
            onClick={() => fileRef.current?.click()}
            disabled={uploadingFile}
            className="flex items-center gap-1.5 text-xs font-semibold text-brand-navy hover:text-brand-navy/80 border border-brand-navy/20 hover:border-brand-navy/50 rounded-lg px-2.5 py-1 transition-all disabled:opacity-50"
          >
            {uploadingFile ? <span className="w-3.5 h-3.5 border-2 border-brand-navy/30 border-t-brand-navy rounded-full animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
            {uploadingFile ? 'Uploading...' : 'Upload File'}
          </button>
          <input ref={fileRef} type="file" onChange={handleFileUpload} className="hidden" accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.png,.jpg,.jpeg,.gif,.webp" />
        </div>

        {uploadError && (
          <div className="mb-3 p-2.5 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700 flex items-start gap-2">
            <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" /> {uploadError}
          </div>
        )}

        {files.length === 0 ? (
          <div onClick={() => fileRef.current?.click()} className="text-center py-6 border border-dashed border-gray-200 rounded-xl cursor-pointer hover:border-brand-navy/30 hover:bg-brand-navy/5 transition-all">
            <Paperclip className="w-7 h-7 text-gray-200 mx-auto mb-1.5" />
            <p className="text-xs text-gray-400">No files attached</p>
            <p className="text-xs text-brand-navy mt-1">Click to upload →</p>
          </div>
        ) : (
          <div className="space-y-2">
            {files.map(file => (
              <div key={file.id} className={`flex items-center gap-3 p-3 rounded-xl border border-gray-100 hover:border-gray-200 hover:bg-gray-50 transition-all ${deletingId === file.id ? 'opacity-50' : ''}`}>
                <span className="text-xl flex-shrink-0">{fileIcon(file.type)}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-gray-800 truncate">{file.name}</p>
                  <p className="text-xs text-gray-400">{formatBytes(file.size)} · {format(new Date(file.ts), 'MMM d, yyyy')}</p>
                </div>
                <button
                  onClick={() => handleToggleAi(file.id)}
                  disabled={togglingId === file.id}
                  title={file.ai_access ? 'AI can use this file — click to disable' : 'AI cannot use this file — click to enable'}
                  className={`flex items-center gap-1 text-xs px-2 py-1 rounded-lg border font-semibold transition-all flex-shrink-0 ${file.ai_access ? 'bg-brand-red/10 text-brand-red border-brand-red/30 hover:bg-brand-red/20' : 'bg-gray-100 text-gray-400 border-gray-200 hover:bg-gray-200'}`}
                >
                  <Bot className="w-3 h-3" /> {file.ai_access ? 'AI On' : 'AI Off'}
                </button>
                <button onClick={() => handleDownload(file)} title="Download" className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-700 transition-colors flex-shrink-0">
                  <Download className="w-3.5 h-3.5" />
                </button>
                <button onClick={() => handleDeleteFile(file)} disabled={deletingId === file.id} title="Delete" className="p-1.5 rounded-lg hover:bg-red-50 text-gray-300 hover:text-brand-red transition-colors flex-shrink-0">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}

        {aiFiles > 0 && (
          <div className="mt-3 p-2.5 bg-brand-red/5 border border-brand-red/20 rounded-lg flex items-start gap-2">
            <Bot className="w-3.5 h-3.5 text-brand-red flex-shrink-0 mt-0.5" />
            <p className="text-xs text-gray-600">
              <span className="font-semibold text-brand-red">{aiFiles} file{aiFiles !== 1 ? 's' : ''}</span> will be referenced when generating AI profiles for this candidate.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Main Component ────────────────────────────────────────────────────────────
export default function CandidateDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { user, session } = useAuth()
  const [candidate, setCandidate] = useState(null)
  const [dossiers, setDossiers]   = useState([])
  const [loading, setLoading]     = useState(true)
  const [editing, setEditing]     = useState(false)
  const [form, setForm]           = useState({})
  const [saving, setSaving]       = useState(false)
  const [activeTab, setActiveTab] = useState('profile')

  // Incumbent Records
  const [incumbentRecords, setIncumbentRecords] = useState([])
  const [showRecordForm, setShowRecordForm]     = useState(false)
  const [editingRecord, setEditingRecord]       = useState(null)
  const [incumbentFilter, setIncumbentFilter]   = useState('all')

  // AI Research for Incumbent Records
  const [aiResearching, setAiResearching]       = useState(false)
  const [aiSuggested, setAiSuggested]           = useState(null)   // { records, dossier_title } | null
  const [aiResearchError, setAiResearchError]   = useState('')
  const [addingAll, setAddingAll]               = useState(false)

  // Active monitoring toggle — must be declared here (before any early returns) to satisfy React Hook rules
  const [monitorSaving, setMonitorSaving] = useState(false)

  // Haiku bio summary — auto-generates from latest dossier Section 1
  const bioSummary = useBioSummary(dossiers, candidate?.name, session)

  useEffect(() => { fetchCandidate() }, [id])

  const fetchCandidate = async () => {
    setLoading(true)
    const [{ data: c }, { data: d }, { data: ir }] = await Promise.all([
      getCandidate(id),
      getDossiers(id),
      getIncumbentRecords(id),
    ])
    setCandidate(c)
    setForm(c || {})
    setDossiers(d || [])
    setIncumbentRecords(ir || [])
    setLoading(false)
  }

  const stampSection = (section) => {
    const existing = form.section_timestamps || {}
    return {
      ...existing,
      [section]: {
        updated_at: new Date().toISOString(),
        updated_by: user?.email || user?.user_metadata?.display_name || 'You',
      }
    }
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      // Strip trailing commas / empty entries from email before saving
      const cleanEmail = (form.email || '').split(',').map(v => v.trim()).filter(Boolean).join(',')
      // Build new section timestamps — stamp all sections that were touched
      const newTimestamps = {
        ...candidate.section_timestamps,  // preserves monitoring, monitoring_updated_at, etc.
        profile: {
          updated_at: new Date().toISOString(),
          updated_by: user?.email || user?.user_metadata?.display_name || 'You',
        }
      }
      const changedFields = Object.keys(form).filter(k => {
        const oldVal = candidate[k] ?? ''
        const newVal = form[k] ?? ''
        return String(oldVal) !== String(newVal)
      })
      const { error } = await updateCandidate(id, {
        name: form.name, party: form.party, status: form.status,
        email: cleanEmail, phone: form.phone, website: form.website,
        campaign_address: form.campaign_address, campaign_city: form.campaign_city,
        campaign_zip: form.campaign_zip, campaign_committee: form.campaign_committee,
        campaign_manager: form.campaign_manager, treasurer: form.treasurer,
        occupation: form.occupation, employer: form.employer,
        bio_summary: form.bio_summary, notes: form.notes,
        research_context: form.research_context || null,
        twitter_handle: form.twitter_handle, facebook_url: form.facebook_url,
        instagram_handle: form.instagram_handle,
        total_raised: form.total_raised || null,
        total_spent: form.total_spent || null,
        cash_on_hand: form.cash_on_hand || null,
        is_incumbent: form.is_incumbent || false,
        incumbent_since: form.incumbent_since || null,
        section_timestamps: newTimestamps,
      })
      if (error) throw error
      // #17 Audit log
      logActivity('update', 'candidate', id, {
        candidate_name: form.name,
        fields_changed: changedFields,
        changed_count: changedFields.length,
      }).catch(() => {}) // non-blocking
      setEditing(false)
      fetchCandidate()
    } catch (err) {
      alert(`Save failed: ${err.message || 'Unknown error'}`)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!window.confirm(`Delete ${candidate.name}? This cannot be undone.`)) return
    logActivity('delete', 'candidate', id, { candidate_name: candidate.name }).catch(() => {})
    await deleteCandidate(id)
    navigate('/candidates')
  }

  const f = (key) => (e) => {
    const val = e.target.type === 'checkbox' ? e.target.checked : e.target.value
    setForm(p => ({ ...p, [key]: val }))
  }

  const handleDeleteRecord = async (recordId) => {
    if (!window.confirm('Delete this record?')) return
    const record = incumbentRecords.find(r => r.id === recordId)
    logActivity('delete', 'incumbent_record', recordId, { candidate_id: id, candidate_name: candidate?.name, record_title: record?.title }).catch(() => {})
    await deleteIncumbentRecord(recordId)
    fetchCandidate()
  }

  const handleAiResearch = async () => {
    setAiResearching(true)
    setAiResearchError('')
    setAiSuggested(null)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token || ''
      const res = await fetch('/.netlify/functions/research-incumbent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ candidate_id: id, candidate_name: candidate?.name }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Research failed')
      if (data.records?.length === 0) {
        setAiResearchError('No incumbent record items were found in this candidate\'s profile. The profile may not contain enough legislative or voting history.')
      } else {
        setAiSuggested(data)
      }
    } catch (err) {
      setAiResearchError(err.message || 'Research failed')
    }
    setAiResearching(false)
  }

  const cleanRecordForInsert = (record) => ({
    candidate_id: record.candidate_id || id,
    record_type:  record.record_type  || 'other',
    title:        (record.title || '').slice(0, 200),
    description:  record.description  || '',
    bill_number:  record.bill_number  || null,
    vote_result:  record.vote_result  || 'not_applicable',
    significance: record.significance || 'notable',
    date:         (record.date && /^\d{4}-\d{2}-\d{2}$/.test(record.date)) ? record.date : null,
    source:       record.source       || null,
    notes:        record.notes        || null,
    url:          record.url          || null,
    created_by:   user?.id || null,
  })

  const handleAddSuggestedRecord = async (record) => {
    const cleaned = cleanRecordForInsert(record)
    const { error: err } = await createIncumbentRecord(cleaned)
    if (err) {
      console.error('Failed to add record:', err)
      setAiResearchError(`Failed to save "${record.title}": ${err.message || JSON.stringify(err)}`)
      return
    }
    logActivity('create', 'incumbent_record', id, { candidate_name: candidate?.name, record_title: record.title, record_type: record.record_type, source: 'ai_research' }).catch(() => {})
    setAiSuggested(prev => prev ? { ...prev, records: prev.records.filter(r => r !== record) } : null)
    fetchCandidate()
  }

  const handleAddAllSuggested = async () => {
    if (!aiSuggested?.records?.length) return
    setAddingAll(true)
    const errors = []
    for (const record of aiSuggested.records) {
      const cleaned = cleanRecordForInsert(record)
      const { error: err } = await createIncumbentRecord(cleaned)
      if (err) {
        console.error('Failed to add record:', err)
        errors.push(record.title)
      }
    }
    logActivity('create', 'incumbent_record', id, { candidate_name: candidate?.name, source: 'ai_research_bulk', count: aiSuggested.records.length - errors.length }).catch(() => {})
    if (errors.length > 0) {
      setAiResearchError(`Failed to save ${errors.length} record(s): ${errors.join(', ')}`)
    }
    setAiSuggested(null)
    await fetchCandidate()
    setAddingAll(false)
  }

  const filteredRecords = incumbentFilter === 'all'
    ? incumbentRecords
    : incumbentRecords.filter(r => r.record_type === incumbentFilter)

  if (loading) return (
    <div className="flex justify-center py-24">
      <div className="w-8 h-8 border-4 border-brand-red border-t-transparent rounded-full animate-spin" />
    </div>
  )

  if (!candidate) return (
    <div className="text-center py-24">
      <p className="text-gray-500">Candidate not found.</p>
      <Link to="/candidates" className="btn-primary mt-4">Back to Candidates</Link>
    </div>
  )

  const c = editing ? form : candidate
  const userTier       = getUserTier(user)
  const canIntel       = hasFeature(userTier, 'campaignIntel')
  const canMonitor     = hasFeature(userTier, 'weeklyProfile')
  const isMonitored    = candidate.section_timestamps?.monitoring === true
  const weaknesses     = candidate.weaknesses || []
  const timestamps     = candidate.section_timestamps || {}

  // Toggle active monitoring on/off immediately (no full edit mode required)
  const handleAcceptStatus = async (newStatus) => {
    const { error } = await updateCandidate(id, { status: newStatus })
    if (error) { console.error('Status update failed:', error); return }
    await fetchCandidate()
  }

  const handleMonitoringToggle = async () => {
    if (!canMonitor) return
    setMonitorSaving(true)
    const newVal = !isMonitored
    const prevTimestamps = candidate.section_timestamps
    const newTimestamps = {
      ...(candidate.section_timestamps || {}),
      monitoring: newVal,
      monitoring_updated_at: new Date().toISOString(),
      monitoring_updated_by: user?.email || 'You',
    }
    // Optimistic update — toggle responds instantly without full-page reload
    setCandidate(prev => prev ? { ...prev, section_timestamps: newTimestamps } : prev)
    const { error } = await updateCandidate(id, { section_timestamps: newTimestamps })
    if (error) {
      // Revert on DB failure so UI doesn't lie
      setCandidate(prev => prev ? { ...prev, section_timestamps: prevTimestamps } : prev)
    } else {
      logActivity(newVal ? 'enable_monitoring' : 'disable_monitoring', 'candidate', id, {
        candidate_name: candidate.name,
      }).catch(() => {})
    }
    setMonitorSaving(false)
  }

  const TABS = [
    { id: 'profile',    label: 'Profile'          },
    { id: 'results',    label: 'Election Results'  },
    { id: 'news',       label: 'News Feed'        },
    { id: 'incumbent',  label: 'Incumbent Record' },
    { id: 'allies',     label: 'Allies'           },
    { id: 'swot',       label: 'SWOT Analysis'    },
    { id: 'intel',      label: 'Profile History'  },
    { id: 'opposition', label: 'Opposition'       },
  ]

  return (
    <div className="space-y-6 max-w-5xl">
      <LoadingBar loading={loading} />
      {/* Back */}
      <Link to="/candidates" className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-brand-red transition-colors">
        <ArrowLeft className="w-4 h-4" /> Back to Candidates
      </Link>

      {/* Header Card */}
      <div className="card">
        <div className="flex flex-col sm:flex-row sm:items-start gap-4">
          <div className="w-16 h-16 rounded-2xl bg-brand-red/10 text-brand-red flex items-center justify-center text-2xl font-bold flex-shrink-0">
            {candidate.name[0]}
          </div>
          <div className="flex-1">
            {editing ? (
              <input className="input text-xl font-bold mb-2" value={form.name} onChange={f('name')} />
            ) : (
              <div className="flex items-center gap-2">
                <h1 className="text-2xl font-bold text-gray-900">{candidate.name}</h1>
                {candidate.is_incumbent && (
                  <span className="text-xs bg-amber-100 text-amber-700 border border-amber-200 px-2 py-0.5 rounded-full font-semibold">
                    Incumbent
                  </span>
                )}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2 mt-2">
              {editing ? (
                <>
                  <select className="input w-44" value={form.party || ''} onChange={f('party')}>
                    <option value="">No party</option>
                    {PARTIES.map(p => <option key={p} value={p}>{p}</option>)}
                  </select>
                  <select className="input w-44" value={form.status} onChange={f('status')}>
                    {STATUSES.map(s => <option key={s} value={s}>{statusLabel(s)}</option>)}
                  </select>
                  <label className="flex items-center gap-2 text-sm text-gray-600 ml-2">
                    <input type="checkbox" checked={form.is_incumbent || false} onChange={f('is_incumbent')} className="rounded" />
                    Incumbent
                  </label>
                  {form.is_incumbent && (
                    <input type="date" className="input w-40" value={form.incumbent_since || ''} onChange={f('incumbent_since')} placeholder="Since date" />
                  )}
                </>
              ) : (
                <>
                  {candidate.party && <span className={`text-sm px-3 py-1 rounded-full font-semibold ${partyColor(candidate.party)}`}>{candidate.party}</span>}
                  <span className={`text-sm px-3 py-1 rounded-full font-medium ${statusBadge(candidate.status)}`}>{statusLabel(candidate.status)}</span>
                </>
              )}
            </div>
            {candidate.office && (
              <div className="flex items-center gap-2 mt-3 text-sm text-gray-600">
                <Building2 className="w-4 h-4 text-gray-400" />
                <span className="font-medium">{candidate.office.name}</span>
                {candidate.office.district_name && <span className="text-gray-400">— {candidate.office.district_name}</span>}
              </div>
            )}
            {candidate.election && (
              <div className="flex items-center gap-2 mt-1 text-sm text-gray-500">
                <CalendarDays className="w-4 h-4 text-gray-400" />
                {candidate.election.name}{candidate.election.election_date ? ` · ${format(new Date(candidate.election.election_date), 'MMMM d, yyyy')}` : ''}
              </div>
            )}
          </div>

          <div className="flex items-center gap-2 flex-shrink-0">
            {editing ? (
              <>
                <button onClick={() => { setEditing(false); setForm({...candidate}) }} className="btn-secondary flex items-center gap-1.5 text-sm">
                  <X className="w-4 h-4" /> Cancel
                </button>
                <button onClick={handleSave} disabled={saving} className="btn-primary flex items-center gap-1.5 text-sm">
                  <Save className="w-4 h-4" /> {saving ? 'Saving...' : 'Save'}
                </button>
              </>
            ) : (
              <>
                <button onClick={() => setEditing(true)} className="btn-secondary flex items-center gap-1.5 text-sm">
                  <Edit2 className="w-4 h-4" /> Edit
                </button>
                <button onClick={handleDelete} className="p-2 rounded-lg text-gray-400 hover:text-brand-red hover:bg-red-50 transition-colors">
                  <Trash2 className="w-4 h-4" />
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* ── Active Monitoring Banner ──────────────────────────────────────── */}
      {canMonitor ? (
        <div className={`flex items-center justify-between gap-4 px-4 py-3 rounded-xl border transition-all ${
          isMonitored
            ? 'bg-emerald-50 border-emerald-200'
            : 'bg-gray-50 border-gray-200'
        }`}>
          <div className="flex items-center gap-3 min-w-0">
            <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${isMonitored ? 'bg-emerald-100' : 'bg-gray-200'}`}>
              <Zap className={`w-4 h-4 ${isMonitored ? 'text-emerald-600' : 'text-gray-400'}`} />
            </div>
            <div className="min-w-0">
              <p className={`text-sm font-semibold ${isMonitored ? 'text-emerald-800' : 'text-gray-700'}`}>
                {isMonitored ? 'Active Monitoring ON' : 'Active Monitoring OFF'}
              </p>
              <p className="text-xs text-gray-500">
                {isMonitored
                  ? 'Profile auto-refreshes every Monday — free, no quota used'
                  : 'Enable to automatically refresh this candidate\'s profile weekly'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3 flex-shrink-0">
            {isMonitored && timestamps.monitoring_updated_at && (
              <span className="text-xs text-gray-400 hidden sm:block">
                On since {format(new Date(timestamps.monitoring_updated_at), 'MMM d')}
              </span>
            )}
            <button
              onClick={handleMonitoringToggle}
              disabled={monitorSaving}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none ${
                isMonitored ? 'bg-emerald-500' : 'bg-gray-300'
              } ${monitorSaving ? 'opacity-50 cursor-wait' : 'cursor-pointer'}`}
              title={isMonitored ? 'Disable active monitoring' : 'Enable active monitoring'}
            >
              <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                isMonitored ? 'translate-x-6' : 'translate-x-1'
              }`} />
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-3 px-4 py-3 rounded-xl border border-dashed border-gray-200 bg-gray-50">
          <Zap className="w-4 h-4 text-gray-300 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-xs text-gray-500">
              <span className="font-semibold text-gray-600">Active Monitoring</span> — automatically refresh this candidate's profile every week, free of charge.
              Available on Campaign & Agency plans.
            </p>
          </div>
          <Link to="/plans" className="text-xs text-brand-red font-semibold hover:underline flex-shrink-0">Upgrade →</Link>
        </div>
      )}

      <StatusRecommendationBanner candidate={candidate} dossiers={dossiers} onAccept={handleAcceptStatus} onDismiss={() => {}} />

      {/* Tab bar */}
      <div className="flex gap-1 border-b border-gray-200 overflow-x-auto">
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setActiveTab(t.id)}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px whitespace-nowrap ${
              activeTab === t.id
                ? 'border-brand-red text-brand-red'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {t.label}
            {['intel','swot','opposition'].includes(t.id) && !canIntel && (
              <Lock className="inline w-3 h-3 ml-1 text-gray-400" />
            )}
            {t.id === 'incumbent' && incumbentRecords.length > 0 && (
              <span className="ml-1.5 text-xs bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full font-semibold">
                {incumbentRecords.length}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Dossier History Tab */}
      {activeTab === 'intel' && (
        canIntel ? (
          <div className="card">
            <div className="flex items-center gap-2 mb-4">
              <Zap className="w-5 h-5 text-brand-red" />
              <h2 className="text-base font-bold text-gray-900">Profile History</h2>
              <SectionTimestamp ts={timestamps.intel} />
            </div>
            {dossiers.length > 0 ? (
              <div className="space-y-3">
                {dossiers.map(d => (
                  <Link key={d.id} to={`/dossiers?view=${d.id}`} className="flex items-start gap-2 p-3 rounded-lg border border-gray-200 hover:border-brand-red hover:bg-red-50/30 transition-colors">
                    <FileText className="w-4 h-4 text-brand-red flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="text-sm font-medium text-gray-800">{d.title}</p>
                      <p className="text-xs text-gray-400 mt-0.5">{d.generated_at ? format(new Date(d.generated_at), 'MMM d, yyyy') : '—'}</p>
                    </div>
                  </Link>
                ))}
              </div>
            ) : (
              <p className="text-sm text-gray-500">
                AI-generated campaign intelligence will appear here. Use the Profiler page to generate a full profile.
              </p>
            )}
            <div className="mt-4">
              <Link to={`/dossiers?candidate=${id}`} className="btn-primary text-sm inline-flex items-center gap-2">
                <FileText className="w-4 h-4" /> Generate AI Profile →
              </Link>
            </div>
          </div>
        ) : (
          <LockedFeatureCard icon={Zap} title="Profile History" />
        )
      )}

      {/* Election Results Tab */}
      {activeTab === 'results' && (
        <div className="card">
          <CandidateElectionResultsTab candidate={candidate} />
        </div>
      )}

      {/* News & Social Tab */}
      {activeTab === 'news' && (
        <NewsAndSocialTab candidateId={id} candidate={candidate} dossiers={dossiers} canIntel={canIntel} />
      )}

      {/* SWOT Analysis Tab */}
      {activeTab === 'swot' && (
        canIntel ? (
          <SwotTab candidate={candidate} dossiers={dossiers} user={user} onRefresh={fetchCandidate} />
        ) : (
          <LockedFeatureCard icon={Target} title="SWOT Analysis" />
        )
      )}

      {/* Opposition Tab */}
      {activeTab === 'opposition' && (
        <OppositionResearchTab
          candidateId={id}
          dossiers={dossiers}
          canIntel={canIntel}
          weaknesses={weaknesses}
          timestamps={timestamps}
        />
      )}

      {/* Allies Tab */}
      {activeTab === 'allies' && (
        <AlliesTab candidateId={id} dossiers={dossiers} canIntel={canIntel} />
      )}

      {/* Incumbent Record Tab */}
      {activeTab === 'incumbent' && (
        <div className="space-y-4">
          <div className="card">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Gavel className="w-5 h-5 text-brand-red" />
                <h2 className="text-base font-bold text-gray-900">Incumbent Record</h2>
                <SectionTimestamp ts={timestamps.incumbent} />
              </div>
              <div className="flex items-center gap-2">
                {dossiers.length > 0 && (
                  <button
                    onClick={handleAiResearch}
                    disabled={aiResearching}
                    className="btn-secondary text-sm flex items-center gap-1.5"
                    title="Extract bills, votes, and acts from this candidate's profile"
                  >
                    <Sparkles className={`w-4 h-4 text-amber-500 ${aiResearching ? 'animate-spin' : ''}`} />
                    {aiResearching ? 'Researching…' : 'AI Research'}
                  </button>
                )}
                <button
                  onClick={() => { setShowRecordForm(true); setEditingRecord(null) }}
                  className="btn-primary text-sm flex items-center gap-1.5"
                >
                  <Plus className="w-4 h-4" /> Add Record
                </button>
              </div>
            </div>

            <p className="text-sm text-gray-500 mb-4">
              Track bills, acts, regulations, laws, notable legal events, and votes from this politician's current or most recent term.
            </p>

            {/* AI Research error */}
            {aiResearchError && (
              <div className="mb-4 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
                <p className="text-xs text-amber-800">{aiResearchError}</p>
                <button onClick={() => setAiResearchError('')} className="ml-auto text-amber-500 hover:text-amber-700"><X className="w-3.5 h-3.5" /></button>
              </div>
            )}

            {/* AI Research suggested records panel */}
            {aiSuggested && aiSuggested.records.length > 0 && (
              <div className="mb-4 bg-blue-50 border border-blue-200 rounded-xl p-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <Sparkles className="w-4 h-4 text-blue-600" />
                    <span className="text-sm font-bold text-blue-900">
                      {aiSuggested.records.length} record{aiSuggested.records.length !== 1 ? 's' : ''} found in profile
                    </span>
                    <span className="text-xs text-blue-500">Review before adding</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleAddAllSuggested}
                      disabled={addingAll}
                      className="text-xs bg-blue-600 text-white px-3 py-1.5 rounded-lg font-semibold hover:bg-blue-700 transition-colors disabled:opacity-50"
                    >
                      {addingAll ? 'Adding…' : `Add All (${aiSuggested.records.length})`}
                    </button>
                    <button onClick={() => setAiSuggested(null)} className="text-blue-400 hover:text-blue-700"><X className="w-4 h-4" /></button>
                  </div>
                </div>
                <div className="space-y-2 max-h-72 overflow-y-auto">
                  {aiSuggested.records.map((rec, idx) => (
                    <div key={idx} className="bg-white rounded-lg border border-blue-200 p-3 flex items-start gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap mb-0.5">
                          <span className="text-xs font-bold text-gray-800 capitalize bg-gray-100 px-2 py-0.5 rounded">{rec.record_type}</span>
                          {rec.bill_number && <span className="text-xs text-gray-500">{rec.bill_number}</span>}
                          {rec.date && <span className="text-xs text-gray-400">{rec.date}</span>}
                          <span className={`text-xs px-1.5 py-0.5 rounded font-medium capitalize ${
                            rec.significance === 'critical' ? 'bg-red-100 text-red-700' :
                            rec.significance === 'major' ? 'bg-amber-100 text-amber-700' :
                            rec.significance === 'notable' ? 'bg-blue-100 text-blue-700' :
                            'bg-gray-100 text-gray-500'
                          }`}>{rec.significance}</span>
                        </div>
                        <p className="text-sm font-semibold text-gray-900 leading-snug">{rec.title}</p>
                        {rec.description && <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">{rec.description}</p>}
                        {rec.source && <p className="text-xs text-gray-400 mt-0.5">Source: {rec.source}</p>}
                      </div>
                      <button
                        onClick={() => handleAddSuggestedRecord(rec)}
                        className="flex-shrink-0 text-xs bg-brand-navy text-white px-2.5 py-1 rounded-lg font-medium hover:bg-navy-700 transition-colors"
                      >
                        Add
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Filter pills */}
            <div className="flex flex-wrap gap-2 mb-4">
              {['all', ...RECORD_TYPES].map(t => (
                <button
                  key={t}
                  onClick={() => setIncumbentFilter(t)}
                  className={`text-xs px-3 py-1 rounded-full font-medium capitalize transition-colors ${
                    incumbentFilter === t
                      ? 'bg-brand-navy text-white'
                      : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                  }`}
                >
                  {t} {t === 'all' ? `(${incumbentRecords.length})` : `(${incumbentRecords.filter(r => r.record_type === t).length})`}
                </button>
              ))}
            </div>

            {showRecordForm && !editingRecord && (
              <div className="mb-4">
                <IncumbentRecordForm
                  candidateId={id}
                  userId={user?.id}
                  onSave={() => { setShowRecordForm(false); fetchCandidate() }}
                  onCancel={() => setShowRecordForm(false)}
                />
              </div>
            )}

            {filteredRecords.length === 0 && !aiSuggested ? (
              <div className="text-center py-10 text-gray-400">
                <Gavel className="w-10 h-10 mx-auto mb-2 opacity-30" />
                <p className="text-sm mb-1">No records yet.</p>
                {dossiers.length > 0 ? (
                  <p className="text-xs">Click <span className="font-semibold text-blue-500">AI Research</span> to auto-extract from the profile, or <span className="font-semibold">Add Record</span> to enter manually.</p>
                ) : (
                  <p className="text-xs">Click "Add Record" to track bills, votes, and legal events.</p>
                )}
              </div>
            ) : filteredRecords.length > 0 ? (
              <div className="space-y-2">
                {filteredRecords.map(record => (
                  editingRecord?.id === record.id ? (
                    <IncumbentRecordForm
                      key={record.id}
                      candidateId={id}
                      userId={user?.id}
                      existing={record}
                      onSave={() => { setEditingRecord(null); fetchCandidate() }}
                      onCancel={() => setEditingRecord(null)}
                    />
                  ) : (
                    <IncumbentRecordRow
                      key={record.id}
                      record={record}
                      onEdit={(r) => { setEditingRecord(r); setShowRecordForm(false) }}
                      onDelete={handleDeleteRecord}
                    />
                  )
                ))}
              </div>
            ) : null}
          </div>
        </div>
      )}

      {/* Profile Tab */}
      {activeTab === 'profile' && <div className="grid lg:grid-cols-3 gap-6">
        {/* Left column */}
        <div className="lg:col-span-2 space-y-6">
          {/* Contact Info */}
          <div className="card">
            <div className="flex items-center gap-2 mb-4">
              <h2 className="text-base font-bold text-gray-900 flex items-center gap-2">
                <User className="w-4 h-4 text-brand-red" /> Contact Information
              </h2>
              <SectionTimestamp ts={timestamps.contact} />
            </div>
            {editing ? (
              <div className="space-y-3">
                {/* Multiple Emails */}
                {(() => {
                  const rawEmails = (form.email || '').split(',').map(e => e.trim())
                  const rows = rawEmails.length > 0 && rawEmails.some(Boolean) ? rawEmails : ['']
                  return (
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <label className="label text-xs">Email Addresses</label>
                        <button
                          type="button"
                          onClick={() => {
                            const list = (form.email || '').split(',').map(e => e.trim()).filter(Boolean)
                            setForm(p => ({ ...p, email: [...list, ''].join(',') }))
                          }}
                          className="text-xs text-brand-red hover:underline flex items-center gap-1"
                        >
                          <Plus className="w-3 h-3" /> Add email
                        </button>
                      </div>
                      <div className="space-y-2">
                        {rows.map((emailVal, idx) => (
                          <div key={idx} className="flex items-center gap-2">
                            <input
                              className="input flex-1"
                              type="email"
                              value={emailVal}
                              onChange={e => {
                                const list = (form.email || '').split(',').map(v => v.trim())
                                while (list.length <= idx) list.push('')
                                list[idx] = e.target.value
                                setForm(p => ({ ...p, email: list.join(',') }))
                              }}
                              placeholder={idx === 0 ? 'primary@example.com' : 'additional@example.com'}
                            />
                            {rows.length > 1 && (
                              <button
                                type="button"
                                onClick={() => {
                                  const list = (form.email || '').split(',').map(v => v.trim())
                                  list.splice(idx, 1)
                                  setForm(p => ({ ...p, email: list.filter(Boolean).join(',') || '' }))
                                }}
                                className="text-gray-400 hover:text-red-500 transition-colors flex-shrink-0"
                              >
                                <X className="w-4 h-4" />
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )
                })()}
                <div>
                  <label className="label text-xs">Phone</label>
                  <input className="input" type="tel" value={form.phone || ''} onChange={f('phone')} placeholder="(608) 555-0100" />
                </div>
                <div>
                  <label className="label text-xs">Website</label>
                  <input className="input" value={form.website || ''} onChange={f('website')} placeholder="https://..." />
                </div>
                <div>
                  <label className="label text-xs">Campaign Address</label>
                  <input className="input" value={form.campaign_address || ''} onChange={f('campaign_address')} />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="label text-xs">City</label>
                    <input className="input" value={form.campaign_city || ''} onChange={f('campaign_city')} />
                  </div>
                  <div>
                    <label className="label text-xs">ZIP</label>
                    <input className="input" value={form.campaign_zip || ''} onChange={f('campaign_zip')} />
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                {/* Render each email as its own row */}
                {candidate.email
                  ? candidate.email.split(',').map(e => e.trim()).filter(Boolean).map((emailVal, idx) => (
                    <div key={`email-${idx}`} className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-lg bg-gray-100 flex items-center justify-center flex-shrink-0">
                        <Mail className="w-4 h-4 text-gray-500" />
                      </div>
                      <div>
                        <p className="text-xs text-gray-400 font-medium">{idx === 0 ? 'Email' : 'Email (alt)'}</p>
                        <a href={`mailto:${emailVal}`} className="text-sm text-brand-red hover:underline">{emailVal}</a>
                      </div>
                    </div>
                  ))
                  : null}
                {[
                  { icon: Phone, label: 'Phone', val: candidate.phone, href: `tel:${candidate.phone}` },
                  { icon: Globe, label: 'Website', val: candidate.website, href: candidate.website, external: true },
                  { icon: MapPin, label: 'Address', val: [candidate.campaign_address, candidate.campaign_city, candidate.campaign_zip].filter(Boolean).join(', ') },
                ].map(({ icon: Icon, label, val, href, external }) => val ? (
                  <div key={label} className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg bg-gray-100 flex items-center justify-center flex-shrink-0">
                      <Icon className="w-4 h-4 text-gray-500" />
                    </div>
                    <div>
                      <p className="text-xs text-gray-400 font-medium">{label}</p>
                      {href ? (
                        <a href={href} target={external ? '_blank' : undefined} rel={external ? 'noopener noreferrer' : undefined}
                          className="text-sm text-brand-red hover:underline">{val}</a>
                      ) : (
                        <p className="text-sm text-gray-700">{val}</p>
                      )}
                    </div>
                  </div>
                ) : null)}
                {!candidate.email && !candidate.phone && !candidate.website && (
                  <p className="text-sm text-gray-400 italic">No contact information on file</p>
                )}
              </div>
            )}
          </div>

          {/* Campaign Details */}
          <div className="card">
            <div className="flex items-center gap-2 mb-4">
              <h2 className="text-base font-bold text-gray-900 flex items-center gap-2">
                <Briefcase className="w-4 h-4 text-brand-red" /> Campaign Details
              </h2>
              <SectionTimestamp ts={timestamps.campaign} />
            </div>
            {editing ? (
              <div className="space-y-3">
                <div>
                  <label className="label text-xs">Committee Name</label>
                  <input className="input" value={form.campaign_committee || ''} onChange={f('campaign_committee')} />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="label text-xs">Campaign Manager</label>
                    <input className="input" value={form.campaign_manager || ''} onChange={f('campaign_manager')} />
                  </div>
                  <div>
                    <label className="label text-xs">Treasurer</label>
                    <input className="input" value={form.treasurer || ''} onChange={f('treasurer')} />
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label className="label text-xs">Total Raised ($)</label>
                    <input className="input" type="number" value={form.total_raised || ''} onChange={f('total_raised')} />
                  </div>
                  <div>
                    <label className="label text-xs">Total Spent ($)</label>
                    <input className="input" type="number" value={form.total_spent || ''} onChange={f('total_spent')} />
                  </div>
                  <div>
                    <label className="label text-xs">Cash on Hand ($)</label>
                    <input className="input" type="number" value={form.cash_on_hand || ''} onChange={f('cash_on_hand')} />
                  </div>
                </div>
                <div>
                  <label className="label text-xs">Occupation</label>
                  <input className="input" value={form.occupation || ''} onChange={f('occupation')} />
                </div>
                <div>
                  <label className="label text-xs">Employer</label>
                  <input className="input" value={form.employer || ''} onChange={f('employer')} />
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {[
                  { label: 'Committee', val: candidate.campaign_committee },
                  { label: 'Campaign Manager', val: candidate.campaign_manager },
                  { label: 'Treasurer', val: candidate.treasurer },
                  { label: 'Occupation', val: candidate.occupation },
                  { label: 'Employer', val: candidate.employer },
                ].map(({ label, val }) => val ? (
                  <div key={label}>
                    <p className="text-xs text-gray-400 font-medium">{label}</p>
                    <p className="text-sm text-gray-800 font-medium mt-0.5">{val}</p>
                  </div>
                ) : null)}
                {(candidate.total_raised || candidate.total_spent || candidate.cash_on_hand) && (
                  <div className="sm:col-span-2 grid grid-cols-3 gap-3 p-3 bg-gray-50 rounded-lg">
                    {candidate.total_raised && <div><p className="text-xs text-gray-400">Total Raised</p><p className="text-sm font-bold text-gray-900">${Number(candidate.total_raised).toLocaleString()}</p></div>}
                    {candidate.total_spent  && <div><p className="text-xs text-gray-400">Total Spent</p><p className="text-sm font-bold text-gray-900">${Number(candidate.total_spent).toLocaleString()}</p></div>}
                    {candidate.cash_on_hand && <div><p className="text-xs text-gray-400">Cash on Hand</p><p className="text-sm font-bold text-green-700">${Number(candidate.cash_on_hand).toLocaleString()}</p></div>}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Bio */}
          <div className="card">
            <div className="flex items-center gap-2 mb-3">
              <h2 className="text-base font-bold text-gray-900">Bio / Summary</h2>
              <SectionTimestamp ts={timestamps.bio} />
              {/* When a dossier exists, show Regenerate button (not in edit mode) */}
              {!editing && dossiers.length > 0 && (
                <button
                  onClick={bioSummary.generate}
                  disabled={bioSummary.loading}
                  title="Regenerate summary from latest profile"
                  className="ml-auto flex items-center gap-1 text-xs text-gray-500 hover:text-brand-red transition disabled:opacity-40"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${bioSummary.loading ? 'animate-spin' : ''}`} />
                  {bioSummary.loading ? 'Generating…' : 'Regenerate'}
                </button>
              )}
            </div>

            {editing ? (
              <textarea
                className="input"
                rows={6}
                value={form.bio_summary || ''}
                onChange={f('bio_summary')}
                placeholder="Candidate background, political history, key issues..."
              />
            ) : dossiers.length > 0 ? (
              /* Dossier exists — show Haiku-generated summary */
              bioSummary.loading ? (
                <div className="flex items-center gap-2 py-4 text-sm text-gray-400">
                  <div className="w-4 h-4 border-2 border-gray-300 border-t-brand-red rounded-full animate-spin" />
                  Generating summary from profile…
                </div>
              ) : bioSummary.error ? (
                <div className="space-y-2">
                  <p className="text-xs text-red-500">Could not generate summary: {bioSummary.error}</p>
                  {candidate.bio_summary && hasFindings(candidate.bio_summary) && (
                    <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-line">
                      {candidate.bio_summary}
                    </p>
                  )}
                </div>
              ) : bioSummary.summary ? (
                <div>
                  <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-line">
                    {bioSummary.summary}
                  </p>
                  <p className="text-xs text-gray-400 mt-3 flex items-center gap-1">
                    <Sparkles className="w-3 h-3" />
                    Generated by AI from profile · Not saved to profile
                  </p>
                </div>
              ) : (
                <p className="text-sm text-gray-400 italic">
                  No biographical data found in profile.{' '}
                  <Link to={`/dossiers?candidate=${candidate.id}`} className="text-brand-red underline">Regenerate profile →</Link>
                </p>
              )
            ) : (
              /* No dossier — fall back to manual bio_summary field */
              <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-line">
                {(candidate.bio_summary && hasFindings(candidate.bio_summary) ? candidate.bio_summary : null) || (
                  <span className="text-gray-400 italic">
                    No bio on file.{' '}
                    <Link to={`/dossiers?candidate=${candidate.id}`} className="text-brand-red underline">Generate a profile</Link>{' '}
                    to auto-populate, or click Edit to add one manually.
                  </span>
                )}
              </p>
            )}
          </div>

          {/* Key Weaknesses (visible from AI profile if populated) */}
          {weaknesses.length > 0 && (
            <div className="card border-red-100">
              <div className="flex items-center gap-2 mb-3">
                <AlertTriangle className="w-4 h-4 text-red-500" />
                <h2 className="text-base font-bold text-gray-900">Key Weaknesses</h2>
                <SectionTimestamp ts={timestamps.weaknesses} />
              </div>
              <p className="text-xs text-gray-400 mb-3">Extracted from AI profile analysis</p>
              <div className="space-y-2">
                {weaknesses.map((w, i) => (
                  <div key={i} className="flex items-start gap-2 p-3 bg-red-50 border border-red-100 rounded-lg">
                    <AlertTriangle className="w-3.5 h-3.5 text-red-400 flex-shrink-0 mt-0.5" />
                    <p className="text-sm text-red-800">{typeof w === 'string' ? w : w.text}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Research Context */}
          <div className="card border-l-4 border-l-brand-red">
            <div className="flex items-center gap-2 mb-1">
              <Search className="w-4 h-4 text-brand-red" />
              <h2 className="text-base font-bold text-gray-900">Profile Research Context</h2>
            </div>
            <p className="text-xs text-gray-500 mb-3">
              Help the AI find the right person — especially for pre-announcement candidates. Include city, employer, profession, or any context that disambiguates this individual. Saved here and auto-loaded every time you generate a profile.
            </p>
            {editing ? (
              <>
                <textarea
                  className="input"
                  rows={3}
                  value={form.research_context || ''}
                  onChange={f('research_context')}
                  placeholder="e.g. 'Lives in Wausau, owns Marathon Roofing LLC, considering Marathon County Board District 4. Not yet announced. Active on Wausau Pilot & Review Facebook page.'"
                  maxLength={1000}
                />
                <p className="text-xs text-gray-400 mt-1">{(form.research_context || '').length}/1000 characters</p>
              </>
            ) : (
              <p className="text-sm text-gray-600 leading-relaxed whitespace-pre-line">
                {candidate.research_context || <span className="text-gray-400 italic">No research context set. Add context to improve profile accuracy for this candidate.</span>}
              </p>
            )}
          </div>

          {/* Notes & Files */}
          <NotesAndFilesPanel
            candidateId={id}
            userId={user?.id}
            rawNotes={candidate.notes}
            onSaved={fetchCandidate}
          />
        </div>

        {/* Right column */}
        <div className="space-y-6">
          {/* Candidate Intelligence Card */}
          <div className="card bg-gradient-to-br from-brand-navy/5 to-brand-red/5 border border-brand-navy/10">
            <h2 className="text-sm font-bold text-gray-900 mb-3 flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-brand-red" /> Intelligence Summary
            </h2>
            <div className="space-y-2.5">
              {candidate.office && (
                <div className="flex items-start gap-2">
                  <Building2 className="w-3.5 h-3.5 text-gray-400 mt-0.5 flex-shrink-0" />
                  <div>
                    <p className="text-xs text-gray-400">Office</p>
                    <p className="text-xs font-semibold text-gray-800">{candidate.office?.name || '—'}{candidate.office?.district_name ? ` · ${candidate.office.district_name}` : ''}</p>
                  </div>
                </div>
              )}
              {candidate.election && (
                <div className="flex items-start gap-2">
                  <CalendarDays className="w-3.5 h-3.5 text-gray-400 mt-0.5 flex-shrink-0" />
                  <div>
                    <p className="text-xs text-gray-400">Election</p>
                    <p className="text-xs font-semibold text-gray-800">{candidate.election?.name || '—'}</p>
                  </div>
                </div>
              )}
              <div className="flex items-start gap-2">
                <Shield className="w-3.5 h-3.5 text-gray-400 mt-0.5 flex-shrink-0" />
                <div>
                  <p className="text-xs text-gray-400">Incumbent Status</p>
                  <p className={`text-xs font-semibold ${candidate.is_incumbent ? 'text-amber-700' : 'text-gray-500'}`}>
                    {candidate.is_incumbent ? '✓ Current Incumbent' : 'Non-Incumbent / Challenger'}
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-2">
                <FileText className="w-3.5 h-3.5 text-gray-400 mt-0.5 flex-shrink-0" />
                <div>
                  <p className="text-xs text-gray-400">Profiles Generated</p>
                  <p className="text-xs font-semibold text-gray-800">
                    {dossiers.length === 0 ? 'None yet' : `${dossiers.length} profile${dossiers.length !== 1 ? 's' : ''}`}
                    {dossiers.length > 0 && dossiers[0].generated_at && <span className="text-gray-400 font-normal"> · Last {format(new Date(dossiers[0].generated_at), 'MMM d')}</span>}
                  </p>
                </div>
              </div>
              {incumbentRecords.length > 0 && (
                <div className="flex items-start gap-2">
                  <Gavel className="w-3.5 h-3.5 text-gray-400 mt-0.5 flex-shrink-0" />
                  <div>
                    <p className="text-xs text-gray-400">Incumbent Records</p>
                    <p className="text-xs font-semibold text-gray-800">{incumbentRecords.length} record{incumbentRecords.length !== 1 ? 's' : ''} on file</p>
                  </div>
                </div>
              )}
              {weaknesses.length > 0 && (
                <div className="flex items-start gap-2">
                  <AlertTriangle className="w-3.5 h-3.5 text-red-400 mt-0.5 flex-shrink-0" />
                  <div>
                    <p className="text-xs text-gray-400">Research Priorities</p>
                    <p className="text-xs font-semibold text-red-700">{weaknesses.length} item{weaknesses.length !== 1 ? 's' : ''} flagged</p>
                  </div>
                </div>
              )}
            </div>
            <div className="mt-4 pt-3 border-t border-gray-200">
              <Link to={`/dossiers?candidate=${id}`} className="text-xs text-brand-red hover:underline font-semibold flex items-center gap-1">
                <Sparkles className="w-3 h-3" /> {dossiers.length > 0 ? 'Regenerate profile' : 'Generate AI profile'} →
              </Link>
            </div>
          </div>

          {/* Social */}
          <div className="card">
            <div className="flex items-center gap-2 mb-3">
              <h2 className="text-sm font-bold text-gray-900">Social Media</h2>
              <SectionTimestamp ts={timestamps.social} />
            </div>
            {editing ? (
              <div className="space-y-3">
                <div>
                  <label className="label text-xs">Twitter / X</label>
                  <input className="input" value={form.twitter_handle || ''} onChange={f('twitter_handle')} placeholder="@handle" />
                </div>
                <div>
                  <label className="label text-xs">Facebook</label>
                  <input className="input" value={form.facebook_url || ''} onChange={f('facebook_url')} placeholder="https://facebook.com/..." />
                </div>
                <div>
                  <label className="label text-xs">Instagram</label>
                  <input className="input" value={form.instagram_handle || ''} onChange={f('instagram_handle')} placeholder="@handle" />
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                {candidate.twitter_handle && (
                  <a href={`https://twitter.com/${candidate.twitter_handle.replace('@','')}`} target="_blank" rel="noopener noreferrer"
                    className="flex items-center gap-2 text-sm text-blue-500 hover:underline">
                    <Twitter className="w-4 h-4" /> {candidate.twitter_handle}
                  </a>
                )}
                {candidate.facebook_url && (
                  <a href={candidate.facebook_url} target="_blank" rel="noopener noreferrer"
                    className="flex items-center gap-2 text-sm text-blue-700 hover:underline">
                    <Facebook className="w-4 h-4" /> Facebook
                  </a>
                )}
                {candidate.instagram_handle && (
                  <a href={`https://instagram.com/${candidate.instagram_handle.replace('@','')}`} target="_blank" rel="noopener noreferrer"
                    className="flex items-center gap-2 text-sm text-pink-600 hover:underline">
                    <Instagram className="w-4 h-4" /> {candidate.instagram_handle}
                  </a>
                )}
                {!candidate.twitter_handle && !candidate.facebook_url && !candidate.instagram_handle && (
                  <p className="text-sm text-gray-400 italic">No social media on file</p>
                )}
              </div>
            )}
          </div>

          {/* Dossiers */}
          <div className="card">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-bold text-gray-900 flex items-center gap-1.5">
                <FileText className="w-4 h-4 text-brand-red" /> Profiles
              </h2>
              <Link to={`/dossiers?candidate=${id}`} className="text-xs text-brand-red hover:underline">Build →</Link>
            </div>
            {dossiers.length === 0 ? (
              <div className="text-center py-6">
                <FileText className="w-8 h-8 text-gray-200 mx-auto mb-2" />
                <p className="text-xs text-gray-400">No profiles yet</p>
                <Link to={`/dossiers?candidate=${id}`} className="text-xs text-brand-red font-medium hover:underline mt-1 block">
                  Generate AI Profile →
                </Link>
              </div>
            ) : (
              <div className="space-y-2">
                {dossiers.map(d => (
                  <Link key={d.id} to={`/dossiers?view=${d.id}`} className="flex items-start gap-2 p-2 rounded-lg hover:bg-gray-50 transition-colors">
                    <FileText className="w-4 h-4 text-gray-400 flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="text-xs font-medium text-gray-700">{d.title}</p>
                      <p className="text-xs text-gray-400">{d.generated_at ? format(new Date(d.generated_at), 'MMM d, yyyy') : '—'}</p>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </div>

          {/* Quick Actions */}
          <div className="card">
            <h2 className="text-sm font-bold text-gray-900 mb-3">Quick Actions</h2>
            <div className="space-y-2">
              <Link to={`/dossiers?candidate=${id}`} className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium text-brand-red bg-brand-red/5 hover:bg-brand-red/10 transition-colors">
                <FileText className="w-4 h-4" /> Generate AI Profile
              </Link>
              <Link to={`/prospecting?candidate=${id}`} className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 transition-colors">
                <ListChecks className="w-4 h-4" /> Add to Prospect List
              </Link>
              <button
                onClick={() => setActiveTab('incumbent')}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium text-amber-700 bg-amber-50 hover:bg-amber-100 transition-colors"
              >
                <Gavel className="w-4 h-4" /> Add Incumbent Record
              </button>
            </div>
          </div>
        </div>
      </div>}

    </div>
  )
}
