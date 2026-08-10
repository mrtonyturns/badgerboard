// campaignEnums.js — single source of truth for campaign taxonomy.
//
// Before the dashboard redesign these maps were defined inline in GamePlan.jsx
// and Candidates.jsx. The plan dashboards need the same phase/status/party/
// election-type vocabulary but render with inline styles rather than Tailwind
// classes, so each entry carries BOTH: the Tailwind class names the existing
// pages already use, and the hex equivalents the dashboards need.
//
// Pure data. No imports, no JSX, no React — safe to pull into any module.

// ── Game plan phases ──────────────────────────────────────────────────────────
// `icon` is attached in GamePlan.jsx (lucide components don't belong in a data
// module). `hex` is the inline-style equivalent of `dot`.
export const PHASES = [
  { key: 'planning',     label: 'Planning',      hex: '#a855f7', dot: 'bg-purple-500',  text: 'text-purple-700',  headerBg: 'bg-purple-50',  borderL: 'border-l-purple-400',  progressBg: 'bg-purple-500'  },
  { key: 'filing',       label: 'Filing',        hex: '#f97316', dot: 'bg-orange-500',  text: 'text-orange-700',  headerBg: 'bg-orange-50',  borderL: 'border-l-orange-400',  progressBg: 'bg-orange-500'  },
  { key: 'voter_contact',label: 'Voter Contact', hex: '#3b82f6', dot: 'bg-blue-500',    text: 'text-blue-700',    headerBg: 'bg-blue-50',    borderL: 'border-l-blue-400',    progressBg: 'bg-blue-500'    },
  { key: 'fundraising',  label: 'Fundraising',   hex: '#10b981', dot: 'bg-emerald-500', text: 'text-emerald-700', headerBg: 'bg-emerald-50', borderL: 'border-l-emerald-400', progressBg: 'bg-emerald-500' },
  { key: 'gotv',         label: 'GOTV',          hex: '#ef4444', dot: 'bg-red-500',     text: 'text-red-700',     headerBg: 'bg-red-50',     borderL: 'border-l-red-400',     progressBg: 'bg-red-500'     },
  { key: 'election_day', label: 'Election Day',  hex: '#64748b', dot: 'bg-slate-500',   text: 'text-slate-700',   headerBg: 'bg-slate-50',   borderL: 'border-l-slate-400',   progressBg: 'bg-slate-500'   },
]

export const PHASE_MAP = Object.fromEntries(PHASES.map(p => [p.key, p]))

// ── Milestone categories & statuses ───────────────────────────────────────────
export const MILESTONE_CATEGORIES = [
  { key: 'recruitment', label: 'Recruitment' },
  { key: 'legal',       label: 'Legal / Filing' },
  { key: 'outreach',    label: 'Voter Outreach' },
  { key: 'finance',     label: 'Finance' },
  { key: 'media',       label: 'Media / Comms' },
  { key: 'admin',       label: 'Administration' },
  { key: 'general',     label: 'General' },
]

export const MILESTONE_STATUSES = [
  { key: 'upcoming',    label: 'Upcoming' },
  { key: 'in_progress', label: 'In Progress' },
  { key: 'complete',    label: 'Complete' },
  { key: 'overdue',     label: 'Overdue' },
  { key: 'skipped',     label: 'Skipped' },
]

// ── Elections ─────────────────────────────────────────────────────────────────
export const ELECTION_TYPE_LABELS = {
  primary:        'Partisan Primary',
  general:        'General Election',
  spring_primary: 'Spring Primary',
  spring_general: 'Spring General',
  special:        'Special Election',
}

export const ELECTION_TYPE_COLORS = {
  primary:        { bg: 'bg-orange-500',  light: 'bg-orange-100 text-orange-800',   border: 'border-orange-300' },
  general:        { bg: 'bg-blue-600',    light: 'bg-blue-100 text-blue-800',       border: 'border-blue-300' },
  spring_primary: { bg: 'bg-purple-600',  light: 'bg-purple-100 text-purple-800',   border: 'border-purple-300' },
  spring_general: { bg: 'bg-emerald-600', light: 'bg-emerald-100 text-emerald-800', border: 'border-emerald-300' },
  special:        { bg: 'bg-yellow-500',  light: 'bg-yellow-100 text-yellow-800',   border: 'border-yellow-300' },
}

// Inline-style equivalents of ELECTION_TYPE_COLORS.light, for the dashboards.
export const ELECTION_TYPE_HEX = {
  primary:        { c: '#c2410c', bg: '#ffedd5' },
  general:        { c: '#1d4ed8', bg: '#dbeafe' },
  spring_primary: { c: '#7c3aed', bg: '#ede9fe' },
  spring_general: { c: '#15803d', bg: '#dcfce7' },
  special:        { c: '#b45309', bg: '#fdf3e3' },
}

// Short pill copy — the full labels overflow a 9.5px pill in a 206px card.
export const ELECTION_TYPE_SHORT = {
  primary:        'Partisan Primary',
  general:        'General',
  spring_primary: 'Spring Primary',
  spring_general: 'Spring General',
  special:        'Special',
}

// ── Candidates ────────────────────────────────────────────────────────────────
export const PARTIES = [
  'Republican', 'Democrat', 'Independent', 'Libertarian',
  'Green', 'Constitution', 'Nonpartisan', 'Other',
]

// DB values are unchanged; `exploring` has always displayed as "Not Known".
export const CANDIDATE_STATUSES = [
  'exploring', 'declared', 'primary_winner', 'general', 'elected', 'lost', 'withdrawn',
]

export const CANDIDATE_STATUS_LABELS = {
  exploring:      'Not Known',
  declared:       'Declared',
  primary_winner: 'Primary Winner',
  general:        'General',
  elected:        'Elected',
  lost:           'Lost',
  withdrawn:      'Withdrawn',
}

export const candidateStatusLabel = (s) =>
  CANDIDATE_STATUS_LABELS[s] ?? (s ? String(s).replace(/_/g, ' ') : '')

export const CANDIDATE_STATUS_HEX = {
  exploring:      { c: '#52525B', bg: '#F1F1EF' },
  declared:       { c: '#1D4ED8', bg: '#E7F0FD' },
  primary_winner: { c: '#7C3AED', bg: '#F3EDFB' },
  general:        { c: '#B45309', bg: '#FDF3E3' },
  elected:        { c: '#15803D', bg: '#E6F5EC' },
  lost:           { c: '#DC2626', bg: '#FDECEC' },
  withdrawn:      { c: '#71717A', bg: '#F1F1EF' },
}

// Party text/tint pairs. Text colors match PARTY_COLOR in DistrictDashboard.jsx.
export const PARTY_HEX = {
  Republican:   { c: '#B91C1C', bg: '#FBEAEA' },
  Democrat:     { c: '#2563EB', bg: '#E7F0FD' },
  Independent:  { c: '#7C3AED', bg: '#F3EDFB' },
  Libertarian:  { c: '#B45309', bg: '#FDF3E3' },
  Green:        { c: '#15803D', bg: '#E6F5EC' },
  Constitution: { c: '#0F766E', bg: '#E6F5F3' },
  Nonpartisan:  { c: '#52525B', bg: '#F1F1EF' },
  Other:        { c: '#52525B', bg: '#F1F1EF' },
}

export const partyHex = (p) => PARTY_HEX[p] || PARTY_HEX.Other

// One-letter party abbreviation for pills and avatars.
export const partyInitial = (p) => (p ? String(p).charAt(0).toUpperCase() : '?')

// ── Weekly digest categories ──────────────────────────────────────────────────
// MIRRORS `CATEGORY_META` in netlify/functions/monitoring-digest.js. That file
// is CommonJS and runs in the Netlify bundler; this one is ESM and runs in the
// Vite bundle, so they can't share a module without risking the live digest
// build. Keep the two in sync — the digest function is the producer, this is
// the consumer.
export const DIGEST_CATEGORY_META = {
  news:        { label: 'News',        c: '#1d4ed8', bg: '#dbeafe' },
  social:      { label: 'Social',      c: '#0369a1', bg: '#e0f2fe' },
  podcast:     { label: 'Podcast/TV',  c: '#7c3aed', bg: '#ede9fe' },
  controversy: { label: 'Controversy', c: '#b91c1c', bg: '#fee2e2' },
  polling:     { label: 'Polling',     c: '#0d9488', bg: '#ccfbf1' },
  endorsement: { label: 'Endorsement', c: '#15803d', bg: '#dcfce7' },
  other:       { label: 'Update',      c: '#475569', bg: '#f1f5f9' },
}

export const digestCategory = (k) =>
  DIGEST_CATEGORY_META[k] || DIGEST_CATEGORY_META.other

// Stacked-bar series for the monitoring activity chart, in stacking order.
// Every digest category is represented — the chart and legend render only the
// series that actually occur in the window, so nothing is dropped into a
// bucket it doesn't belong to and nothing is charted at a flat zero.
export const MONITORING_SERIES = [
  { key: 'news',        label: 'News',        hex: '#1d4ed8' },
  { key: 'social',      label: 'Social',      hex: '#38bdf8' },
  { key: 'endorsement', label: 'Endorsement', hex: '#15803d' },
  { key: 'controversy', label: 'Controversy', hex: '#b91c1c' },
  { key: 'polling',     label: 'Polling',     hex: '#0d9488' },
  { key: 'podcast',     label: 'Podcast/TV',  hex: '#7c3aed' },
  { key: 'other',       label: 'Update',      hex: '#94a3b8' },
]
