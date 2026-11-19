// candidate/IntelViews.jsx — the Intel tab of the candidate profile.
//
// One tab, four parts picked with a Segmented control (no sub-tab rows):
//
//   X & news          live X posts (fetch-candidate-x-feed: cached first, then
//                     refreshed in the background when stale) next to the
//                     profile's own news items (Section 1) and X posts (Section 10)
//   SWOT              four bold quadrant tiles, every point with its evidence,
//                     its rank in this race and what to do with it
//   Attack & defense  big cards: the attack line, the evidence, the defense —
//                     then key weaknesses and controversies as cards
//   Allies            endorsers and network (Sections 8 & 9) as cards
//
// What it reads: candidates.swot_data (research-swot v2, or older bullet
// strings), the newest dossier's content via ./intelModel.js, and the X feed
// function. The old Opposition view read candidates.weaknesses, which nothing
// writes — see intelModel.js.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AtSign, Newspaper, Target, Swords, Handshake, AlertTriangle, ShieldCheck,
  Flame, RefreshCw, Sparkles, Pencil, Quote, TrendingUp, TrendingDown,
} from 'lucide-react'
import { supabase, updateCandidate } from '../../lib/supabase'
import useFeature from '../../lib/useFeature'
import { Tile, Segmented, Avatar, EmptyState, Button, ICON_COLORS } from '../../components/ui'
import {
  LockedView, Spinner, parseSection, fmtDate, Chip,
} from './shared'
import { SectionHead, Pill, ConfidencePill, SourceLine, ImpactPips, ExtLink, hostOf } from './kit'
import {
  normalizeSwot, effectiveSwot, swotHasPoints, QUADRANT_KEYS,
  parseAttackDefense, parseControversies, keyWeaknesses,
  profileNews, profileXPosts,
} from './intelModel'

// ═══ Raw-AI-output display guards ═════════════════════════════════════════════
// DISPLAY LAYER ONLY. None of this rewrites a dossier or anything stored — it
// decides what the Intel tab is willing to put in front of a user, because the
// model's raw output leaks list delimiters, unfilled placeholders and the
// schema template row it was handed.
// ─── R1C PURE HELPERS BEGIN ───
/**
 * A SWOT quadrant arrives as a newline-delimited string, as an array of
 * points, or as ONE string with the model's '•' separators still in it. The
 * old renderer split on '\n' only, so an array became a single <li> reading
 * "…rural Wisconsin,• Established organizational credentials…". Split on both,
 * flatten arrays, strip bullet glyphs, drop empties.
 */
export function splitSwotPoints(value) {
  const entries = Array.isArray(value) ? value : [value]
  const out = []
  for (const entry of entries) {
    if (entry === null || entry === undefined) continue
    if (Array.isArray(entry)) { out.push(...splitSwotPoints(entry)); continue }
    for (const part of String(entry).split(/\r?\n|•/)) {
      const point = part.replace(/^\s*[-*]\s*/, '').replace(/^[\s,;]+|[\s,;]+$/g, '').trim()
      if (point) out.push(point)
    }
  }
  return out
}

/**
 * News summaries come out of the feed parser cut long, so a long summary can
 * land mid-word with no marker. Trim back to the last whole word and say so
 * with an ellipsis. Text comfortably under the cap is returned as-is.
 */
export function trimToWord(text, max = 250) {
  const s = String(text ?? '').trim()
  if (!s || s.length < max) return s
  const cut = s.slice(0, max)
  const lastSpace = cut.lastIndexOf(' ')
  // Only fall back to a mid-word cut if the last space is implausibly early
  // (one very long token), otherwise the summary loses most of its text.
  const body = (lastSpace > max * 0.5 ? cut.slice(0, lastSpace) : cut)
    .replace(/[\s,;:.\-–—]+$/, '')
  return body ? `${body}…` : ''
}

/**
 * True when a string carries no information a user can read — empty, or made
 * up entirely of unfilled bracket tokens like '[RESEARCH REQUIRED]',
 * '[TBD]', '[KNOWN] · [X/Live]' plus punctuation.
 */
export function isPlaceholderOnly(text) {
  const s = String(text ?? '').replace(/\*\*/g, '').trim()
  if (!s) return true
  return s.replace(/\[[^\]]*\]/g, ' ').replace(/[\s\-–—:;,.|·•]+/g, '') === ''
}

// Field names the profile schema hands the model as a header row. When a whole
// ally row is nothing but these, it's the template, not an ally.
const ALLY_TEMPLATE_NAMES  = new Set(['org', 'organization', 'organisation', 'name', 'entity', 'ally', 'person', 'group'])
const ALLY_TEMPLATE_FIELDS = new Set(['role', 'type', 'years', 'source', 'status', 'since', 'tier', 'notes', 'relationship', 'strength'])

/** The 'Org' / 'Role · Type · Years · Source' schema row that leaked into the list. */
export function isAllyTemplateRow(row) {
  const name = String(row?.name ?? '').replace(/\*\*/g, '').trim()
  const role = String(row?.role ?? '').replace(/\*\*/g, '').trim()
  if (!name || isPlaceholderOnly(name)) return true
  if (ALLY_TEMPLATE_NAMES.has(name.toLowerCase())) return true
  const fields = role.split(/[·|•]/).map(s => s.trim().toLowerCase()).filter(Boolean)
  return fields.length >= 2 && fields.every(f => ALLY_TEMPLATE_FIELDS.has(f))
}

/**
 * Split a string into plain-text runs and bracket tokens so the tokens can be
 * rendered as the same chips the section markdown uses. Markdown links
 * (`[label](url)`) are left as text — they are not status tokens.
 */
export function splitBracketTokens(text) {
  const s = String(text ?? '')
  const out = []
  const push = (type, value) => {
    if (type === 'text') {
      const v = value.replace(/\s+/g, ' ').trim()
      if (v) out.push({ type, value: v })
      return
    }
    out.push({ type, value })
  }
  const re = /\[([^\]]+)\]/g
  let last = 0, m
  while ((m = re.exec(s)) !== null) {
    if (s[m.index + m[0].length] === '(') continue   // markdown link, not a token
    push('text', s.slice(last, m.index))
    push('badge', m[1].trim())
    last = m.index + m[0].length
  }
  push('text', s.slice(last))
  return out
}
// ─── R1C PURE HELPERS END ───

/** Renders text with any [BRACKET] tokens promoted to chips. */
function TokenText({ text, className }) {
  const parts = splitBracketTokens(text)
  if (!parts.some(p => p.type === 'badge')) return <span className={className}>{String(text ?? '')}</span>
  return (
    <span className={`inline-flex flex-wrap items-center gap-1.5 ${className || ''}`}>
      {parts.map((p, i) => p.type === 'badge'
        ? <Chip key={i} label={p.value} />
        : <span key={i}>{p.value}</span>)}
    </span>
  )
}

// ── NEW badge rule ────────────────────────────────────────────────────────────
// An item is "new" when its own published date is after the last time this user
// opened the profile. Items whose date string can't be parsed get no badge —
// the page never guesses.
export function isNewByDate(dateStr, lastViewed) {
  if (!lastViewed || !dateStr) return false
  const t = Date.parse(dateStr)
  if (Number.isNaN(t)) return false
  return t > Date.parse(lastViewed)
}

const newestDossierDate = (dossiers) => dossiers?.[0]?.generated_at ? fmtDate(dossiers[0].generated_at, 'MMM d, yyyy') : null

// ═══ Intel tab ════════════════════════════════════════════════════════════════

export const INTEL_VIEWS = [
  { value: 'x',      label: 'X & news' },
  { value: 'swot',   label: 'SWOT' },
  { value: 'attack', label: 'Attack & defense' },
  { value: 'allies', label: 'Allies' },
]
// Deep links written before the redesign.
export const LEGACY_INTEL_VIEW = { news: 'x', opposition: 'attack' }

export default function IntelView({
  candidate, dossiers, content, contentLoading, canIntel, view, onView,
  perspective, onPerspective, xHandle, lastViewed, unseenByView = {}, onRefresh, nav,
}) {
  if (!canIntel) return <LockedView title="Intel" onSeePlans={() => nav('/plans')} />

  const options = INTEL_VIEWS.map(o => ({ ...o, count: unseenByView[o.value] ? `${unseenByView[o.value]} new` : undefined }))

  return (
    <div className="flex flex-col gap-6">
      <div className="-mx-1 overflow-x-auto px-1 pb-1 scrollbar-hide">
        <Segmented options={options} value={view} onChange={onView} className="w-max !p-1.5 [&>button]:whitespace-nowrap [&>button]:!px-3.5 [&>button]:!py-2.5 [&>button]:!text-[14px]" />
      </div>

      {!dossiers?.length && view !== 'swot' ? (
        <NoProfileTile candidate={candidate} nav={nav} />
      ) : contentLoading ? (
        <Tile className="p-8"><Spinner /></Tile>
      ) : view === 'x' ? (
        <XAndNews candidate={candidate} content={content} xHandle={xHandle} lastViewed={lastViewed} dossiers={dossiers} />
      ) : view === 'swot' ? (
        <SwotSection candidate={candidate} dossiers={dossiers} content={content} perspective={perspective} onPerspective={onPerspective} onRefresh={onRefresh} />
      ) : view === 'attack' ? (
        <AttackDefense candidate={candidate} dossiers={dossiers} content={content} perspective={perspective} onPerspective={onPerspective} nav={nav} />
      ) : (
        <AlliesSection candidate={candidate} dossiers={dossiers} content={content} nav={nav} />
      )}
    </div>
  )
}

function NoProfileTile({ candidate, nav }) {
  return (
    <Tile className="p-7">
      <EmptyState
        icon={Sparkles}
        color="red"
        title="No research profile yet"
        body={`Intel comes from ${candidate.name}'s research profile: news and X posts, the SWOT, attack lines with defenses, and allies. Generate one and this fills in.`}
        action={<Button icon={Sparkles} onClick={() => nav(`/dossiers?candidate=${candidate.id}`)}>Generate profile</Button>}
      />
    </Tile>
  )
}

function PerspectiveToggle({ perspective, onPerspective }) {
  return (
    <Segmented
      value={perspective}
      onChange={onPerspective}
      options={[{ value: 'opponent', label: 'Opponent' }, { value: 'self', label: 'My candidate' }]}
    />
  )
}

// ═══ X & news ═════════════════════════════════════════════════════════════════

const XFEED_TTL_MS = 6 * 60 * 60 * 1000
const xKey = (id) => `bb:xfeed:${id}`
function readLocalFeed(id) {
  try { return JSON.parse(localStorage.getItem(xKey(id)) || 'null') } catch { return null }
}
function writeLocalFeed(id, value) {
  try { localStorage.setItem(xKey(id), JSON.stringify(value)) } catch { /* private mode */ }
}

async function callXFeed(body) {
  const { data: { session } } = await supabase.auth.getSession()
  const res = await fetch('/.netlify/functions/fetch-candidate-x-feed', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token || ''}` },
    body: JSON.stringify(body),
  })
  let data = {}
  try { data = await res.json() } catch { /* non-JSON error page */ }
  if (!res.ok) throw new Error(data.error || `X search failed (${res.status})`)
  return data
}

/**
 * Loads X posts automatically when the tab opens: the cached feed first (no
 * AI call), then — when that is older than six hours or missing — a fresh
 * search in the background. A browser copy stands in while the server cache
 * table is not there yet, so a page open never re-pays for a search it ran
 * an hour ago.
 */
export function useXFeed(candidateId, handle) {
  const [state, setState] = useState(() => {
    const local = readLocalFeed(candidateId)
    return { posts: local?.posts || [], handle: local?.handle || null, fetchedAt: local?.fetched_at || null, loading: true, refreshing: false, error: '' }
  })
  const handleRef = useRef(handle)
  handleRef.current = handle
  const idRef = useRef(candidateId)
  idRef.current = candidateId

  const refresh = useCallback(async (force = false) => {
    const local = readLocalFeed(candidateId)
    if (!force && local?.attempted_at && Date.now() - Date.parse(local.attempted_at) < XFEED_TTL_MS) return
    writeLocalFeed(candidateId, { ...(local || {}), attempted_at: new Date().toISOString() })
    setState(s => ({ ...s, refreshing: true, error: '' }))
    try {
      const data = await callXFeed({ candidate_id: candidateId, handle: handleRef.current || undefined, refresh: true })
      const next = { posts: data.posts || [], handle: data.handle || null, fetched_at: data.fetched_at || new Date().toISOString(), attempted_at: new Date().toISOString() }
      writeLocalFeed(candidateId, next)
      if (idRef.current !== candidateId) return
      setState(s => ({ ...s, posts: next.posts, handle: next.handle, fetchedAt: next.fetched_at, refreshing: false, error: data.refresh_error || '' }))
    } catch (e) {
      if (idRef.current === candidateId) setState(s => ({ ...s, refreshing: false, error: e.message }))
    }
  }, [candidateId])

  useEffect(() => {
    let cancelled = false
    const local = readLocalFeed(candidateId)
    setState({ posts: local?.posts || [], handle: local?.handle || null, fetchedAt: local?.fetched_at || null, loading: true, refreshing: false, error: '' })
    ;(async () => {
      let stale
      try {
        const data = await callXFeed({ candidate_id: candidateId, handle: handleRef.current || undefined })
        if (cancelled) return
        const serverNewer = data.fetched_at && (!local?.fetched_at || Date.parse(data.fetched_at) >= Date.parse(local.fetched_at))
        if (serverNewer) {
          writeLocalFeed(candidateId, { ...(local || {}), posts: data.posts || [], handle: data.handle || null, fetched_at: data.fetched_at })
          setState(s => ({ ...s, posts: data.posts || [], handle: data.handle || s.handle, fetchedAt: data.fetched_at }))
        }
        const newest = serverNewer ? data.fetched_at : local?.fetched_at
        stale = !newest || Date.now() - Date.parse(newest) > XFEED_TTL_MS
      } catch (e) {
        if (!cancelled) setState(s => ({ ...s, error: e.message }))
        stale = false   // the function is unreachable; don't stack a refresh on it
      }
      if (cancelled) return
      setState(s => ({ ...s, loading: false }))
      if (stale) refresh(false)
    })()
    return () => { cancelled = true }
  }, [candidateId, refresh])

  return { ...state, refresh: () => refresh(true) }
}

/** "Aug 17, 2026" / ISO / "May–Jun 2026" → a short date, or the original text when it isn't one. */
function postDate(v) {
  if (!v) return ''
  // Only a string that names a day is a date; "May–Jun 2026" stays as written.
  if (!/\d{4}-\d{2}-\d{2}|[A-Za-z]{3,}\.? \d{1,2},? \d{4}/.test(String(v))) return String(v)
  const t = Date.parse(v)
  if (Number.isNaN(t)) return String(v)
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function PostCard({ post }) {
  const when = postDate(post.created_at)
  return (
    <a
      href={post.url}
      target="_blank"
      rel="noopener noreferrer"
      className="tile tile-link block p-5"
    >
      <div className="flex items-center gap-3">
        <Avatar name={(post.author_name || '').replace(/^@/, '') || post.author_username} size={40} color={post.about === 'by_candidate' ? ICON_COLORS.ink : ICON_COLORS.gray} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-bold text-brand-ink">{post.author_name || `@${post.author_username}`}</div>
          <div className="truncate text-[13px] text-brand-faint">@{post.author_username}{when ? ` · ${when}` : ''}</div>
        </div>
        {post.from === 'profile' && <Pill>From profile</Pill>}
      </div>
      <p className="mt-3 whitespace-pre-line text-[15px] leading-relaxed text-brand-ink">{post.text}</p>
      <div className="mt-3 text-[13px] font-semibold text-brand-mute">View on X →</div>
    </a>
  )
}

function NewsCard({ item, isNew }) {
  return (
    <div className="tile p-5">
      <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-brand-faint">
        <span className="font-semibold text-brand-mute">{item.source || (item.url ? hostOf(item.url) : 'Source not recorded')}</span>
        {item.date && <span>· {item.date}</span>}
        {isNew && <Pill tone="red">New</Pill>}
        <ConfidencePill value={item.confidence} />
      </div>
      <div className="mt-1.5 text-[16px] font-bold leading-snug text-brand-ink">
        {item.url ? <a href={item.url} target="_blank" rel="noopener noreferrer" className="hover:underline">{item.title}</a> : item.title}
      </div>
      {item.description && <p className="mt-1.5 text-[14px] leading-relaxed text-brand-mute">{trimToWord(item.description)}</p>}
      {item.url && <div className="mt-2"><ExtLink href={item.url} className="text-[13px]">Read the story</ExtLink></div>}
    </div>
  )
}

function XAndNews({ candidate, content, xHandle, lastViewed, dossiers }) {
  const feed = useXFeed(candidate.id, xHandle)
  const fromProfile = useMemo(() => profileXPosts(content), [content])
  const news = useMemo(() => profileNews(content).map(n => ({ ...n, description: n.summary })), [content])

  const posts = useMemo(() => {
    const seen = new Set()
    const out = []
    for (const p of [...(feed.posts || []), ...fromProfile]) {
      if (seen.has(p.id)) continue
      seen.add(p.id)
      out.push(p)
    }
    return out.sort((a, b) => (Date.parse(b.created_at || 0) || 0) - (Date.parse(a.created_at || 0) || 0))
  }, [feed.posts, fromProfile])

  const handle = feed.handle || xHandle
  const updated = feed.fetchedAt ? fmtDate(feed.fetchedAt, 'MMM d, h:mm a') : null

  return (
    <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
      <section className="flex min-w-0 flex-col gap-4">
        <SectionHead
          icon={AtSign}
          color="ink"
          title="On X"
          sub={handle
            ? <>Posts by <ExtLink href={`https://x.com/${handle}`} className="text-[14px]">@{handle}</ExtLink> and about {candidate.name}</>
            : `Posts about ${candidate.name}`}
          right={
            <Button variant="secondary" icon={RefreshCw} onClick={feed.refresh} disabled={feed.refreshing} className={feed.refreshing ? '[&>svg]:animate-spin' : ''}>
              {feed.refreshing ? 'Searching X…' : 'Refresh'}
            </Button>
          }
        />
        <div className="text-[12.5px] text-brand-faint">
          {feed.refreshing
            ? 'Searching X for new posts — this takes about half a minute. What we already have is below.'
            : updated ? `Searched ${updated}.` : null}
          {feed.error && !feed.refreshing && <span className="text-[#B42318]"> {feed.error}</span>}
        </div>
        {feed.loading && !posts.length ? (
          <Tile className="p-6"><Spinner pad={16} /></Tile>
        ) : posts.length ? (
          <div className="flex flex-col gap-3">
            {posts.map(p => <PostCard key={p.id} post={p} />)}
          </div>
        ) : (
          <Tile className="p-6">
            <EmptyState
              icon={AtSign}
              title={feed.refreshing ? 'Looking for posts…' : 'No X posts found yet'}
              body={handle
                ? `Nothing recent came back for @${handle}.`
                : `We search X by name and place. If ${candidate.name} has an X account, add it with Edit and the next search pulls their own posts.`}
            />
          </Tile>
        )}
      </section>

      <section className="flex min-w-0 flex-col gap-4">
        <SectionHead
          icon={Newspaper}
          color="blue"
          title="In the news"
          sub={news.length ? `${news.length} ${news.length === 1 ? 'story' : 'stories'} in the ${newestDossierDate(dossiers) || 'latest'} profile` : 'From the latest profile'}
        />
        {news.length ? (
          <div className="flex flex-col gap-3">
            {news.map((item, i) => <NewsCard key={`${item.title}-${i}`} item={item} isNew={isNewByDate(item.date, lastViewed)} />)}
          </div>
        ) : (
          <Tile className="p-6">
            <EmptyState icon={Newspaper} title="No press coverage found" body="The latest profile found no news stories. The next refresh searches again." />
          </Tile>
        )}
      </section>
    </div>
  )
}

// ═══ SWOT ═════════════════════════════════════════════════════════════════════

const QUADRANTS = [
  { key: 'strengths',     label: 'Strengths',     color: '#16803C', icon: TrendingUp },
  { key: 'weaknesses',    label: 'Weaknesses',    color: '#E0362C', icon: TrendingDown },
  { key: 'opportunities', label: 'Opportunities', color: '#2F6BFF', icon: Target },
  { key: 'threats',       label: 'Threats',       color: '#C2410C', icon: AlertTriangle },
]

/** What the "play" on a point means, by quadrant and perspective. */
export function playLabel(quadrant, perspective) {
  const bad = quadrant === 'weaknesses' || quadrant === 'threats'
  if (perspective === 'self') return bad ? 'How to defend it' : 'How to press it'
  return bad ? 'How to use it' : 'How to blunt it'
}

function SwotPoint({ item, rank, quadrant, color, perspective }) {
  return (
    <li className="flex gap-3">
      {item.impact
        ? <span className="mt-0.5 inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-[13px] font-extrabold text-white" style={{ background: color }} title="Rank in this race">{rank}</span>
        : <span className="mt-2 h-2 w-2 flex-shrink-0 rounded-full" style={{ background: color }} />}
      <div className="min-w-0 flex-1">
        <div className="text-[15.5px] font-bold leading-snug text-brand-ink">{item.point}</div>
        {item.evidence && <p className="mt-1 text-[13.5px] leading-relaxed text-brand-mute">{item.evidence}</p>}
        {(item.source || item.impact) && (
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
            <ImpactPips value={item.impact} color={color} />
            {item.source && <span className="text-[12.5px] text-brand-faint">Source: {item.source}</span>}
          </div>
        )}
        {item.play && (
          <div className="mt-2.5 rounded-xl px-3.5 py-2.5" style={{ background: `${color}10` }}>
            <div className="text-[11px] font-extrabold uppercase tracking-[0.08em]" style={{ color }}>{playLabel(quadrant, perspective)}</div>
            <div className="mt-0.5 text-[14px] leading-snug text-brand-ink">{item.play}</div>
          </div>
        )}
      </div>
    </li>
  )
}

const BLANK_SWOT = { strengths: '', weaknesses: '', opportunities: '', threats: '' }

/** Edited text (one point per line) → v2 items, keeping the evidence of unchanged points. */
export function swotFromEdit(draft, previous, perspective) {
  const prev = normalizeSwot(previous)
  const out = { v: 2, perspective, generated_at: prev.generated_at || new Date().toISOString(), bottom_line: prev.bottom_line || '' }
  for (const k of QUADRANT_KEYS) {
    const byPoint = new Map(prev[k].map(x => [x.point.trim().toLowerCase(), x]))
    out[k] = splitSwotPoints(draft[k]).map(p => byPoint.get(p.toLowerCase()) || { point: p, evidence: '', source: '', impact: null, play: '' })
  }
  return out
}

function SwotSection({ candidate, dossiers, content, perspective, onPerspective, onRefresh }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(BLANK_SWOT)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const swot = useMemo(() => effectiveSwot(candidate.swot_data, content), [candidate.swot_data, content])
  const sharp = swot.v === 2 && QUADRANT_KEYS.some(k => swot[k].some(x => x.evidence || x.play))
  const stalePerspective = sharp && swot.perspective && swot.perspective !== perspective

  const startEdit = () => {
    setDraft(Object.fromEntries(QUADRANT_KEYS.map(k => [k, swot[k].map(x => x.point).join('\n')])))
    setEditing(true)
  }

  const save = async () => {
    setBusy(true); setError('')
    const next = swotFromEdit(draft, candidate.swot_data, perspective)
    const { error: err } = await updateCandidate(candidate.id, { swot_data: next })
    setBusy(false)
    if (err) { setError(err.message || 'Could not save the SWOT — your edits are still here.'); return }
    setEditing(false)
    onRefresh()
  }

  const rebuild = async () => {
    if (!dossiers?.length) return
    setBusy(true); setError('')
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch('/.netlify/functions/research-swot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token || ''}` },
        body: JSON.stringify({ candidate_id: candidate.id, perspective }),
      })
      let data = {}
      try { data = await res.json() } catch { /* non-JSON error page */ }
      if (!res.ok) throw new Error(data.error || `SWOT failed (${res.status})`)
      const { error: saveErr } = await updateCandidate(candidate.id, { swot_data: data.swot })
      if (saveErr) throw new Error(saveErr.message || 'The SWOT was built but could not be saved.')
      onRefresh()
    } catch (e) { setError(e.message || 'Failed to build the SWOT') }
    setBusy(false)
  }

  const builtOn = swot.generated_at ? fmtDate(swot.generated_at, 'MMM d, yyyy') : null

  return (
    <section className="flex flex-col gap-5">
      <SectionHead
        icon={Target}
        color="purple"
        title="SWOT"
        sub={sharp
          ? `Ranked by how much each point matters in this race${builtOn ? ` · built ${builtOn}` : ''}`
          : swot.from === 'profile' ? `The quick read from the ${newestDossierDate(dossiers) || 'latest'} profile` : 'Strengths, weaknesses, opportunities and threats'}
        right={!editing && (
          <>
            <PerspectiveToggle perspective={perspective} onPerspective={onPerspective} />
            {dossiers?.length > 0 && (
              <Button variant={sharp && !stalePerspective ? 'secondary' : 'primary'} icon={Sparkles} onClick={rebuild} disabled={busy}>
                {busy ? 'Building… (about 30s)' : sharp ? 'Rebuild' : 'Build the full SWOT'}
              </Button>
            )}
            <Button variant="ghost" icon={Pencil} onClick={startEdit}>Edit</Button>
          </>
        )}
      />

      {error && <div className="rounded-xl bg-[#FFF1E6] px-4 py-3 text-[14px] text-[#B54708]">{error}</div>}

      {!editing && dossiers?.length > 0 && (!sharp || stalePerspective) && swotHasPoints(swot) && (
        <div className="flex flex-wrap items-center gap-3 rounded-tile bg-brand-navy px-5 py-4 text-white shadow-e2">
          <Sparkles className="h-5 w-5 flex-shrink-0 text-white/80" />
          <p className="min-w-0 flex-1 text-[14.5px] leading-snug text-white/90">
            {stalePerspective
              ? `This SWOT was written as if ${candidate.name} were ${swot.perspective === 'self' ? 'your candidate' : 'an opponent'}. Rebuild it to get ${perspective === 'self' ? 'how to defend' : 'how to use'} each weakness.`
              : `Build the full SWOT: every point backed by evidence from the profile, ranked by how much it matters in this race, with ${perspective === 'self' ? 'how to defend' : 'how to use'} each weakness and threat.`}
          </p>
        </div>
      )}

      {swot.bottom_line && !editing && (
        <Tile className="p-6">
          <div className="flex gap-3">
            <Quote className="h-6 w-6 flex-shrink-0 text-brand-red" />
            <div>
              <div className="text-[11px] font-extrabold uppercase tracking-[0.1em] text-brand-faint">Bottom line</div>
              <p className="mt-1 text-[19px] font-bold leading-snug tracking-tight text-brand-ink">{swot.bottom_line}</p>
            </div>
          </div>
        </Tile>
      )}

      {!swotHasPoints(swot) && !editing ? (
        <Tile className="p-7">
          <EmptyState
            icon={Target}
            color="purple"
            title="No SWOT yet"
            body={dossiers?.length
              ? 'Build one from the latest profile, or write it yourself with Edit.'
              : 'Generate a profile first — the SWOT reads from it. You can also write one by hand with Edit.'}
          />
        </Tile>
      ) : (
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
          {QUADRANTS.map(q => {
            const items = swot[q.key] || []
            return (
              <Tile key={q.key} className="flex flex-col p-6" style={{ borderTop: `5px solid ${q.color}` }}>
                <div className="flex items-center gap-2.5">
                  <q.icon className="h-5 w-5" style={{ color: q.color }} />
                  <span className="text-[20px] font-extrabold tracking-display text-brand-ink">{q.label}</span>
                  {!editing && <span className="ml-auto inline-flex h-7 min-w-[28px] items-center justify-center rounded-full px-2 text-[13px] font-bold text-white" style={{ background: q.color }}>{items.length}</span>}
                </div>
                {editing ? (
                  <textarea
                    value={typeof draft[q.key] === 'string' ? draft[q.key] : splitSwotPoints(draft[q.key]).join('\n')}
                    onChange={e => setDraft(p => ({ ...p, [q.key]: e.target.value }))}
                    placeholder={`One ${q.label.toLowerCase().replace(/s$/, '').replace(/ie$/, 'y')} per line…`}
                    className="input mt-4 min-h-[140px] resize-y text-[14px] leading-relaxed"
                  />
                ) : items.length ? (
                  <ol className="mt-4 flex flex-col gap-4">
                    {items.map((item, i) => (
                      <SwotPoint key={`${q.key}-${i}`} item={item} rank={i + 1} quadrant={q.key} color={q.color} perspective={perspective} />
                    ))}
                  </ol>
                ) : (
                  <p className="mt-4 text-[14px] text-brand-faint">Nothing here the profile can back up.</p>
                )}
              </Tile>
            )
          })}
        </div>
      )}

      {editing && (
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => { setEditing(false); setError('') }}>Cancel</Button>
          <Button variant="dark" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save SWOT'}</Button>
        </div>
      )}
    </section>
  )
}

// ═══ Attack & defense ═════════════════════════════════════════════════════════

const PRIORITY_TONE = { HIGH: 'red', MEDIUM: 'orange', LOW: 'gray' }

function AttackCard({ pair, perspective }) {
  const self = perspective === 'self'
  return (
    <Tile className="flex flex-col p-6 md:p-7">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12px] font-extrabold uppercase tracking-[0.12em] text-brand-red">{pair.title}</span>
        <ConfidencePill value={pair.confidence} />
      </div>
      <p className="mt-2 text-[24px] font-extrabold leading-[1.15] tracking-display text-brand-ink md:text-[28px]">
        “{pair.line}”
      </p>
      {pair.evidence && (
        <div className="mt-4">
          <div className="text-[11px] font-extrabold uppercase tracking-[0.1em] text-brand-faint">The evidence</div>
          <p className="mt-1 text-[15px] leading-relaxed text-brand-ink">{pair.evidence}</p>
          <SourceLine source={pair.source} url={pair.url} className="mt-1" />
        </div>
      )}
      {pair.defense && (
        <div className="mt-5 rounded-2xl bg-[#E8F6EE] p-4">
          <div className="flex items-center gap-1.5 text-[11px] font-extrabold uppercase tracking-[0.1em] text-[#16803C]">
            <ShieldCheck className="h-4 w-4" /> {self ? 'Your answer' : 'Their likely defense'}
          </div>
          {pair.defense.response && <p className="mt-1.5 text-[16px] font-bold leading-snug text-brand-ink">{pair.defense.response}</p>}
          {pair.defense.context && <p className="mt-1 text-[14px] leading-relaxed text-brand-mute">{pair.defense.context}</p>}
        </div>
      )}
    </Tile>
  )
}

function ControversyCard({ c }) {
  return (
    <Tile className="flex flex-col p-5">
      <div className="flex flex-wrap items-center gap-2">
        {c.date && <Pill tone="dark">{c.date}</Pill>}
        {c.priority && <Pill tone={PRIORITY_TONE[c.priority]}>{c.priority.toLowerCase()} priority</Pill>}
        {c.status && <Pill>{c.status}</Pill>}
        <ConfidencePill value={c.confidence} />
      </div>
      <div className="mt-2.5 text-[18px] font-extrabold leading-snug tracking-tight text-brand-ink">{c.issue}</div>
      {c.summary && <p className="mt-1.5 text-[14.5px] leading-relaxed text-brand-mute">{c.summary}</p>}
      {c.response && (
        <p className="mt-2 text-[14px] leading-relaxed text-brand-ink"><span className="font-bold">Their response: </span>{c.response}</p>
      )}
      <SourceLine source={c.source} url={c.url} className="mt-auto pt-3" />
    </Tile>
  )
}

function AttackDefense({ candidate, dossiers, content, perspective, onPerspective, nav }) {
  const canBroadside = useFeature('broadside')
  const swot = useMemo(() => effectiveSwot(candidate.swot_data, content), [candidate.swot_data, content])
  const pairs = useMemo(() => parseAttackDefense(content), [content])
  const controversies = useMemo(() => parseControversies(content), [content])
  // candidates.weaknesses is never written by the pipeline; it is only merged
  // in for rows that carry hand-entered ones. Placeholders are dropped first.
  const weaknesses = useMemo(() => {
    const legacy = (candidate.weaknesses || []).filter(w => !isPlaceholderOnly(typeof w === 'string' ? w : w?.text))
    return keyWeaknesses(swot, legacy)
  }, [swot, candidate.weaknesses])
  const self = perspective === 'self'
  const newest = dossiers?.[0]
  const sparHref = newest ? `/broadside?dossier=${newest.id}` : null

  // No Section 13 table (older or lite profiles): the ranked weaknesses that
  // carry a play stand in as attack cards.
  const cards = pairs.length ? pairs : weaknesses.filter(w => w.play).slice(0, 4).map(w => ({
    title: 'Weakness', line: w.point, evidence: w.evidence, source: w.source, url: null, confidence: '',
    defense: self ? { response: w.play, context: '' } : null,
  }))

  const nothing = !cards.length && !weaknesses.length && !controversies.length

  return (
    <div className="flex flex-col gap-10">
      <section className="flex flex-col gap-5">
        <SectionHead
          icon={Swords}
          color="red"
          title="Attack & defense"
          sub={self
            ? `What opponents will say about ${candidate.name} — and your answer`
            : `The lines to run against ${candidate.name} — and how they will answer`}
          right={
            <>
              <PerspectiveToggle perspective={perspective} onPerspective={onPerspective} />
              {canBroadside && sparHref && (
                <span className="group relative inline-flex">
                  <Button
                    variant="dark"
                    icon={Swords}
                    onClick={() => sparHref && nav(sparHref)}
                    disabled={!sparHref}
                    title={sparHref ? 'Open Broadside and spar against this profile' : undefined}
                  >Spar in Broadside</Button>
                  {!sparHref && (
                    <span className="absolute bottom-full left-0 z-20 mb-2 w-56 hidden group-hover:block rounded-lg bg-gray-900 px-3 py-2 text-xs leading-relaxed text-white shadow-xl">
                      Generate a profile first — Broadside spars against the profile's content.
                    </span>
                  )}
                </span>
              )}
            </>
          }
        />
        {nothing ? (
          <Tile className="p-7">
            <EmptyState
              icon={Swords}
              color="red"
              title="Nothing to attack or defend yet"
              body="The latest profile found no documented vulnerabilities. Build the full SWOT or regenerate the profile to look again."
            />
          </Tile>
        ) : cards.length ? (
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
            {cards.map((p, i) => <AttackCard key={`${p.title}-${i}`} pair={p} perspective={perspective} />)}
          </div>
        ) : null}
      </section>

      {weaknesses.length > 0 && (
        <section className="flex flex-col gap-5">
          <SectionHead
            icon={TrendingDown}
            color="orange"
            title="Key weaknesses"
            sub={swot.v === 2 ? 'From the SWOT, strongest first' : `From the ${swot.from === 'profile' ? 'profile’s' : 'saved'} SWOT`}
          />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {weaknesses.map((w, i) => (
              <Tile key={`${w.point}-${i}`} className="flex flex-col p-5" style={{ borderTop: '5px solid #C2410C' }}>
                {w.impact ? (
                  <div className="mb-2 flex items-center gap-2">
                    <span className="text-[28px] font-extrabold leading-none tracking-display text-[#C2410C]">{i + 1}</span>
                    <ImpactPips value={w.impact} color="#C2410C" />
                  </div>
                ) : null}
                <div className="text-[16px] font-bold leading-snug text-brand-ink">{w.point}</div>
                {w.evidence && <p className="mt-1.5 text-[13.5px] leading-relaxed text-brand-mute">{w.evidence}</p>}
                {w.source && <div className="mt-1 text-[12.5px] text-brand-faint">Source: {w.source}</div>}
                {w.play && (
                  <div className="mt-3 rounded-xl bg-[#FFF1E6] px-3.5 py-2.5">
                    <div className="text-[11px] font-extrabold uppercase tracking-[0.08em] text-[#C2410C]">{playLabel('weaknesses', perspective)}</div>
                    <div className="mt-0.5 text-[14px] leading-snug text-brand-ink">{w.play}</div>
                  </div>
                )}
              </Tile>
            ))}
          </div>
        </section>
      )}

      {controversies.length > 0 && (
        <section className="flex flex-col gap-5">
          <SectionHead
            icon={Flame}
            color="ink"
            title="Controversies"
            sub="What the public record shows — documented items only, highest research priority first"
          />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {controversies.map((c, i) => <ControversyCard key={`${c.issue}-${i}`} c={c} />)}
          </div>
        </section>
      )}
    </div>
  )
}

// ═══ Allies ═══════════════════════════════════════════════════════════════════

// Sections 8 & 9 are free-form markdown. Where the model produced a table or a
// "**Name** — role" bullet the rows are lifted into cards; header rows and the
// schema template row are dropped.
export function parseAllies(sectionText) {
  if (!sectionText) return []
  const out = []
  const lines = sectionText.split('\n')
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (/^\|[\s\-|:]+\|$/.test(line)) continue
    if (line.startsWith('|')) {
      const cells = line.split('|').slice(1, -1).map(c => c.replace(/\*\*/g, '').trim())
      if (cells.length < 2) continue
      if (/^(name|organi[sz]ation|entity|ally)$/i.test(cells[0])) continue
      if (!cells[0] || cells[0] === '—' || /^(not found|none|n\/a|unknown)\b/i.test(cells[0])) continue
      out.push({ name: cells[0], role: cells.slice(1).filter(Boolean).join(' · ') })
      continue
    }
    const bullet = line.match(/^[-*]\s+\*\*(.+?)\*\*\s*[—–:-]\s*(.+)$/)
    if (bullet) { out.push({ name: bullet[1].trim(), role: bullet[2].trim() }); continue }
  }
  return out.filter(a => a.name.length > 1 && a.name.length < 90).slice(0, 40)
}

function AlliesSection({ candidate, dossiers, content, nav }) {
  const rows = useMemo(() => {
    const all = [...parseAllies(parseSection(content, 8)), ...parseAllies(parseSection(content, 9))]
      .filter(a => !isAllyTemplateRow(a))
    const seen = new Set()
    return all.filter(a => {
      const k = a.name.toLowerCase()
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
  }, [content])

  return (
    <section className="flex flex-col gap-5">
      <SectionHead
        icon={Handshake}
        color="green"
        title="Allies & network"
        sub={rows.length ? `${rows.length} organizations and people from the ${newestDossierDate(dossiers) || 'latest'} profile` : 'Endorsements, organizations and political network'}
        right={dossiers?.[0] && <Button variant="secondary" onClick={() => nav(`/dossiers?view=${dossiers[0].id}`)}>Full profile</Button>}
      />
      {rows.length ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {rows.map((a, i) => (
            <Tile key={`${a.name}-${i}`} className="flex items-start gap-3 p-4">
              <Avatar name={String(a.name).replace(/\[[^\]]*\]/g, '').trim() || a.name} size={40} color={ICON_COLORS.green} />
              <div className="min-w-0">
                <div className="text-[15px] font-bold leading-snug text-brand-ink">
                  <TokenText text={a.name} />
                </div>
                {a.role && !isPlaceholderOnly(a.role) && (
                  <div className="mt-0.5 text-[13px] leading-snug text-brand-mute"><TokenText text={a.role} /></div>
                )}
              </div>
            </Tile>
          ))}
        </div>
      ) : (
        <Tile className="p-7">
          <EmptyState
            icon={Handshake}
            color="green"
            title="No allies on record"
            body={`The latest profile found no endorsements or network ties for ${candidate.name}. The next refresh looks again.`}
          />
        </Tile>
      )}
    </section>
  )
}
