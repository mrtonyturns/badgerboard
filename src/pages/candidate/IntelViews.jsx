// candidate/IntelViews.jsx — SPEC-candidate-profile.md §5, Intel group.
//
//   News Feed  · SWOT · Opposition · Allies
//
// Every data path from the previous tabs survives: Section 1 / Section 10
// parsing, the live X feed, the SWOT edit + AI-generate flow, the weaknesses /
// Section 6 / Section 13 opposition panels, and the Sections 8 & 9 allies
// content. The plan gate (canIntel) and its Lock behavior are preserved.

import React, { useEffect, useState } from 'react'
import { supabase, updateCandidate, getDossier } from '../../lib/supabase'
import {
  T, Card, EmptyState, CtaButton, TextLink, Btn, ViewHead, NewBadge,
  LockedView, Spinner, CategoryPill, useDossierSection, SectionContent,
  parseNewsItems, parseSocialItems, parseSection, detectPlatform, initialsOf, fmtDate,
  headlineFrom, fetchDossierContent, Chip,
} from './shared'

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
 * News summaries come out of parseNewsItems (shared.jsx) already cut to 250
 * characters with a hard .slice(), so a long summary lands mid-word with no
 * marker — "…a difference of" just stops. Trim back to the last whole word and
 * say so with an ellipsis. Text comfortably under the cap is returned as-is.
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
function TokenText({ text, style }) {
  const parts = splitBracketTokens(text)
  if (!parts.some(p => p.type === 'badge')) return <span style={style}>{String(text ?? '')}</span>
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', ...style }}>
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

// ═══ News Feed ════════════════════════════════════════════════════════════════

function NewsCard({ item, isNew }) {
  const category = item.isSocial ? 'social' : 'news'
  return (
    <div style={{
      background: '#fff', border: `1px solid ${isNew ? '#F4D8D9' : T.border}`,
      borderRadius: 14, padding: '16px 20px', boxShadow: '0 1px 3px rgba(0,0,0,.03)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 7, flexWrap: 'wrap' }}>
        <CategoryPill category={category} width={72} />
        <span style={{ fontSize: 11, color: T.faint }}>
          {[item.source, item.date].filter(Boolean).join(' · ') || 'Source not recorded'}
        </span>
        {isNew && <NewBadge />}
        {item.flag && (
          <span style={{
            fontSize: 9, fontWeight: 700, background: '#FEF3C7', color: '#92400E',
            borderRadius: 99, padding: '3px 8px',
          }}>{item.flag}</span>
        )}
      </div>
      <div style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.4, marginBottom: 5 }}>{item.title}</div>
      {item.description && (
        <div style={{ fontSize: 12.5, color: T.ink3, lineHeight: 1.55 }}>{trimToWord(item.description)}</div>
      )}
      <a
        className="cp-a"
        href={item.searchUrl || item.url}
        target="_blank"
        rel="noopener noreferrer"
        style={{ display: 'inline-flex', alignItems: 'center', fontSize: 11.5, marginTop: 9, minHeight: 24 }}
      >Read source →</a>
    </div>
  )
}

// Live X / Twitter feed — unchanged behavior, restyled shell.
function XFeed({ candidate }) {
  const [tweets, setTweets] = useState([])
  const [loading, setLoading] = useState(false)
  const [fetched, setFetched] = useState(false)
  const [error, setError] = useState('')

  const loadTweets = async () => {
    setLoading(true); setError('')
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch('/.netlify/functions/fetch-candidate-x-feed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({
          candidateName: candidate?.name || '',
          handle: candidate?.twitter_handle || '',
          district: candidate?.office?.district_name || '',
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `Error ${res.status}`)
      setTweets(data.tweets || [])
      setFetched(true)
    } catch (e) { setError(e.message) } finally { setLoading(false) }
  }

  return (
    <Card style={{ padding: '18px 20px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13.5, fontWeight: 700 }}>X / Twitter</span>
        {fetched && tweets.length > 0 && (
          <span style={{ fontSize: 10.5, color: T.faint }}>{tweets.length} posts</span>
        )}
        <span style={{ marginLeft: 'auto' }}>
          <TextLink onClick={loadTweets}>
            {loading ? 'Loading…' : fetched ? 'Refresh' : 'Load posts'}
          </TextLink>
        </span>
      </div>

      {!fetched && !loading && !error && (
        <EmptyState
          title="Posts are loaded on demand"
          body={`Pulls recent public posts about ${candidate?.name || 'this candidate'} from X. Nothing is fetched until you ask for it.`}
          action={<CtaButton onClick={loadTweets}>Load X posts</CtaButton>}
        />
      )}
      {loading && <Spinner pad={24} />}
      {error && (
        <div style={{ fontSize: 11.5, color: T.redHot, lineHeight: 1.55 }}>
          Could not load X posts: {error}
          <div style={{ marginTop: 8 }}><TextLink onClick={loadTweets}>Try again</TextLink></div>
        </div>
      )}
      {fetched && !loading && tweets.length === 0 && (
        <EmptyState
          title="No recent posts found"
          body={candidate?.twitter_handle
            ? `Nothing recent came back for @${String(candidate.twitter_handle).replace('@', '')}.`
            : 'Add this candidate’s X handle under Profile Data to narrow the search.'}
        />
      )}
      {fetched && tweets.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxHeight: 520, overflowY: 'auto' }}>
          {tweets.map(t => (
            <a
              key={t.id}
              href={t.author_username ? `https://x.com/${t.author_username}/status/${t.id}` : `https://x.com/search?q=${encodeURIComponent(t.text?.slice(0, 40) || '')}`}
              target="_blank" rel="noopener noreferrer"
              style={{ textDecoration: 'none', color: 'inherit' }}
            >
              <div className="cp-row" style={{ border: `1px solid ${T.divider}`, borderRadius: 10, padding: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 11.5, fontWeight: 700 }}>{t.author_name}</span>
                  {t.author_username && <span style={{ fontSize: 11, color: T.faint }}>@{t.author_username}</span>}
                  {t.created_at && (
                    <span style={{ marginLeft: 'auto', fontSize: 10.5, color: T.faint }}>{fmtDate(t.created_at)}</span>
                  )}
                </div>
                <div style={{ fontSize: 12, color: T.ink2, lineHeight: 1.5 }}>{t.text}</div>
              </div>
            </a>
          ))}
        </div>
      )}
    </Card>
  )
}

export function NewsFeedView({ candidate, dossiers, canIntel, lastViewed, nav }) {
  const [loading, setLoading] = useState(false)
  const [newsItems, setNewsItems] = useState(null)
  const [socialItems, setSocialItems] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!dossiers || dossiers.length === 0) return
    const latest = dossiers[0]
    const extract = (content) => {
      const section1 = parseSection(content, 1)
      const sec1Items = section1 ? parseNewsItems(section1) : []
      const keep = (it) => (it.source || it.url) && !it.title.startsWith('NOT FOUND')
      const news = sec1Items.filter(it => keep(it) && !it.isSocial)
      const sec1Social = sec1Items.filter(it => keep(it) && it.isSocial)
      const sec10 = parseSocialItems(content).filter(keep)
      const seen = new Set()
      const social = []
      for (const item of [...sec10, ...sec1Social]) {
        const k = item.title.toLowerCase().trim()
        if (!seen.has(k)) { seen.add(k); social.push(item) }
      }
      setNewsItems(news)
      setSocialItems(social)
      if (news.length === 0 && social.length === 0) {
        setError('No structured news items were found in the latest profile.')
      }
    }
    if (latest.content) { extract(latest.content); return }
    setLoading(true)
    getDossier(latest.id).then(({ data, error: err }) => {
      setLoading(false)
      if (err || !data?.content) { setError('Could not load profile content'); return }
      extract(data.content)
    })
  }, [dossiers])

  if (!canIntel) return <LockedView title="News Feed" onSeePlans={() => nav('/plans')} />

  if (!dossiers?.length) {
    return (
      <Card style={{ padding: '20px 24px' }}>
        <ViewHead title="News feed" sub="from Section 1 and Section 10 of the latest profile" />
        <EmptyState
          title="No profile generated yet"
          body={`Press coverage and social activity for ${candidate.name} come out of the AI profile. Generate one and this feed fills in.`}
          action={<CtaButton onClick={() => nav(`/dossiers?candidate=${candidate.id}`)}>Generate profile</CtaButton>}
        />
      </Card>
    )
  }

  if (loading) return <Card style={{ padding: 20 }}><Spinner /></Card>

  const hasNews = newsItems && newsItems.length > 0
  const hasSocial = socialItems && socialItems.length > 0

  return (
    <div className="cp-cols" style={{ display: 'grid', gridTemplateColumns: '1.7fr 1fr', gap: 16, alignItems: 'start' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
        {hasNews ? newsItems.map((item, i) => (
          <NewsCard key={i} item={item} isNew={isNewByDate(item.date, lastViewed)} />
        )) : (
          <Card style={{ padding: '20px 24px' }}>
            <ViewHead title="News feed" />
            <EmptyState
              title="No press items in the latest profile"
              body={error || 'Regenerate the profile to search for new coverage.'}
              action={<CtaButton onClick={() => nav(`/dossiers?candidate=${candidate.id}`)}>Regenerate profile</CtaButton>}
            />
          </Card>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
        <XFeed candidate={candidate} />
        <Card style={{ padding: '18px 20px' }}>
          <ViewHead
            title="Social posts"
            sub={hasSocial ? `${socialItems.length} from the profile` : null}
          />
          {hasSocial ? (
            /* paddingBottom: the scroll box ended flush with the last card, so
               its platform · date row was sliced in half at the clip edge. */
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxHeight: 520, overflowY: 'auto', paddingBottom: 8 }}>
              {socialItems.map((item, i) => (
                <a key={i} href={item.searchUrl || item.url} target="_blank" rel="noopener noreferrer"
                  style={{ textDecoration: 'none', color: 'inherit' }}>
                  <div className="cp-row" style={{ border: `1px solid ${T.divider}`, borderRadius: 10, padding: 10 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 600, lineHeight: 1.45 }}>{item.title}</div>
                    <div style={{ fontSize: 10.5, color: T.faint, marginTop: 3 }}>
                      {[detectPlatform(item.source) || item.source, item.date].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                </a>
              ))}
            </div>
          ) : (
            <EmptyState
              title="No social posts in the latest profile"
              body="Section 10 of the profile holds social activity. Regenerate the profile to search again."
            />
          )}
        </Card>
      </div>
    </div>
  )
}

// ═══ SWOT ═════════════════════════════════════════════════════════════════════

const QUADRANTS = [
  { key: 'strengths',     label: 'Strengths',     color: '#15803d' },
  { key: 'weaknesses',    label: 'Weaknesses',    color: '#b91c1c' },
  { key: 'opportunities', label: 'Opportunities', color: '#1d4ed8' },
  { key: 'threats',       label: 'Threats',       color: '#b45309' },
]

export function SwotView({ candidate, dossiers, canIntel, swotUpdated, onRefresh, nav }) {
  const blank = { strengths: '', weaknesses: '', opportunities: '', threats: '' }
  const [swot, setSwot] = useState(candidate.swot_data || blank)
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [aiLoading, setAiLoading] = useState(false)
  const [aiError, setAiError] = useState('')

  useEffect(() => { setSwot(candidate.swot_data || blank) }, [candidate.id])

  if (!canIntel) return <LockedView title="SWOT" onSeePlans={() => nav('/plans')} />

  const hasContent = QUADRANTS.some(q => splitSwotPoints(swot[q.key]).length > 0)

  const handleSave = async () => {
    setSaving(true); setAiError('')
    const { error } = await updateCandidate(candidate.id, { swot_data: swot })
    setSaving(false)
    if (error) {
      setAiError(error.message || 'Could not save the SWOT — your edits were not stored.')
      return   // stay in edit mode so nothing typed is lost
    }
    setEditing(false); onRefresh()
  }

  const handleAiGenerate = async () => {
    if (!dossiers?.length) return
    setAiLoading(true); setAiError('')
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch('/.netlify/functions/research-swot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token || ''}` },
        body: JSON.stringify({ candidate_id: candidate.id, candidate_name: candidate.name }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'SWOT analysis failed')
      setSwot(data.swot)
      const { error: saveErr } = await updateCandidate(candidate.id, { swot_data: data.swot })
      if (saveErr) throw new Error(saveErr.message || 'SWOT was generated but could not be saved.')
      onRefresh()
    } catch (err) { setAiError(err.message || 'Failed to generate SWOT') }
    setAiLoading(false)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 14, fontWeight: 700 }}>SWOT</span>
        <span style={{ fontSize: 11.5, color: T.faint }}>strategic read of this candidate</span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 7, flexWrap: 'wrap' }}>
          {dossiers?.length > 0 && !editing && (
            <Btn onClick={handleAiGenerate} disabled={aiLoading}>
              {aiLoading ? 'Analyzing…' : 'AI generate'}
            </Btn>
          )}
          {!editing && <Btn onClick={() => setEditing(true)}>Edit</Btn>}
          {editing && (
            <>
              <Btn onClick={() => { setEditing(false); setSwot(candidate.swot_data || blank) }}>Cancel</Btn>
              <Btn kind="primary" onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Btn>
            </>
          )}
        </span>
      </div>

      {aiError && (
        <div style={{
          background: T.warmBg, border: `1px solid ${T.warmBr}`, borderRadius: 12,
          padding: '10px 14px', fontSize: 11.5, color: T.warmInk,
        }}>{aiError}</div>
      )}

      {!hasContent && !editing ? (
        <Card style={{ padding: '20px 24px' }}>
          <EmptyState
            title="No SWOT yet"
            body={dossiers?.length
              ? 'Run AI generate to build one from the latest profile, or Edit to write it yourself.'
              : 'Generate a profile first — the AI SWOT reads from it. You can also write one by hand with Edit.'}
          />
        </Card>
      ) : (
        <div className="cp-cols2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          {QUADRANTS.map(q => (
            <Card key={q.key} style={{ padding: '18px 20px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: q.color }} />
                <span style={{ fontSize: 13.5, fontWeight: 700 }}>{q.label}</span>
                {swotUpdated && <NewBadge label="UPDATED" />}
              </div>
              {editing ? (
                <textarea
                  /* Strings edit verbatim; an array would render as "a,b,c" in
                     a textarea, so only arrays get flattened to one per line. */
                  value={typeof swot[q.key] === 'string'
                    ? swot[q.key]
                    : splitSwotPoints(swot[q.key]).join('\n')}
                  onChange={e => setSwot(p => ({ ...p, [q.key]: e.target.value }))}
                  placeholder={`Enter ${q.label.toLowerCase()}…`}
                  style={{
                    width: '100%', boxSizing: 'border-box', minHeight: 96, border: '1px solid #DEDEDA',
                    borderRadius: 11, padding: '11px 13px', fontSize: 12.5, lineHeight: 1.55,
                    fontFamily: 'inherit', resize: 'vertical', outline: 'none',
                  }}
                />
              ) : splitSwotPoints(swot[q.key]).length > 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                  {splitSwotPoints(swot[q.key]).map((point, i) => (
                    <div key={i} style={{ display: 'flex', gap: 9 }}>
                      <span style={{ flexShrink: 0, width: 5, height: 5, borderRadius: '50%', background: q.color, marginTop: 6 }} />
                      <div style={{ fontSize: 12.5, lineHeight: 1.5 }}>{point}</div>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ fontSize: 12, color: T.faint }}>Not yet analyzed.</div>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}

// ═══ Opposition ═══════════════════════════════════════════════════════════════

const SEVERITY = {
  critical: { label: 'HIGH',   c: '#b91c1c', bg: '#fee2e2' },
  high:     { label: 'HIGH',   c: '#b91c1c', bg: '#fee2e2' },
  medium:   { label: 'MEDIUM', c: '#c2410c', bg: '#ffedd5' },
  low:      { label: 'LOW',    c: '#52525b', bg: '#f1f1ef' },
}

export function OppositionView({ candidate, dossiers, canIntel, weaknesses, oppositionUpdated, nav }) {
  const { content, loading } = useDossierSection(dossiers, [6, 13])
  const [panel, setPanel] = useState('weaknesses')

  if (!canIntel) return <LockedView title="Opposition research" onSeePlans={() => nav('/plans')} />

  const newest = dossiers?.[0] || null
  const hasDossier = !!newest
  // Unfilled model output ('[RESEARCH REQUIRED]' with an empty body) used to
  // render as a card whose entire title was the placeholder. Drop those before
  // anything counts them — including the panel's own "(N)" badge — so the tab
  // falls through to its empty state rather than showing hollow cards.
  const list = (weaknesses || []).filter(w => !isPlaceholderOnly(typeof w === 'string' ? w : w?.text))

  const panels = [
    { id: 'weaknesses',    label: 'Key weaknesses', count: list.length },
    hasDossier && { id: 'controversies', label: 'Controversies' },
    hasDossier && { id: 'attack',        label: 'Attack & defense' },
  ].filter(Boolean)

  const sparHref = newest ? `/broadside?dossier=${newest.id}` : null

  if (!hasDossier && list.length === 0) {
    return (
      <Card style={{ padding: '20px 24px' }}>
        <ViewHead title="Opposition research" />
        <EmptyState
          title="Nothing on file"
          body={`Weaknesses, controversies and attack lines for ${candidate.name} come out of the AI profile (Sections 6 and 13). Generate one to populate this view.`}
          action={<CtaButton onClick={() => nav(`/dossiers?candidate=${candidate.id}`)}>Generate profile</CtaButton>}
        />
      </Card>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {panels.length > 1 && (
        <div className="cp-nav" style={{ display: 'flex', gap: 7, flexWrap: 'nowrap', overflowX: 'auto' }}>
          {panels.map(p => (
            <button
              key={p.id}
              type="button"
              onClick={() => setPanel(p.id)}
              style={{
                border: `1px solid ${panel === p.id ? T.navy : T.border}`,
                background: panel === p.id ? T.navy : '#fff',
                color: panel === p.id ? '#fff' : T.muted,
                borderRadius: 99, padding: '8px 14px', fontSize: 12, fontWeight: 600,
                fontFamily: 'inherit', cursor: 'pointer', whiteSpace: 'nowrap', minHeight: 36,
              }}
            >{p.label}{p.count != null ? ` (${p.count})` : ''}</button>
          ))}
        </div>
      )}

      {panel === 'weaknesses' && (
        list.length === 0 ? (
          <Card style={{ padding: '20px 24px' }}>
            <EmptyState
              title="No key weaknesses recorded"
              body="Weaknesses are extracted when a profile is generated. Regenerate the profile if you expect some."
            />
          </Card>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {list.map((w, i) => {
              const text = typeof w === 'string' ? w : w.text
              const sev = typeof w === 'object' && w.severity ? SEVERITY[String(w.severity).toLowerCase()] : null
              // Headline is lifted from the weakness text itself — first
              // sentence / clause, cut at a word boundary. When nothing can be
              // extracted the card keeps its positional label.
              const headline = headlineFrom(text)
              const body = String(text || '').trim()
              return (
                <Card key={i} style={{ padding: '16px 20px', borderRadius: 14 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 6, flexWrap: 'wrap' }}>
                    {sev && (
                      <span style={{
                        fontSize: 9, fontWeight: 700, letterSpacing: '.4px',
                        color: sev.c, background: sev.bg, borderRadius: 99, padding: '3px 9px',
                      }}>{sev.label}</span>
                    )}
                    <span style={{ fontSize: 13.5, fontWeight: 600, lineHeight: 1.4 }}>
                      {headline || `Weakness ${i + 1}`}
                    </span>
                    {oppositionUpdated && <NewBadge />}
                  </div>
                  {(!headline || headline !== body) && (
                    <div style={{ fontSize: 12.5, color: T.ink3, lineHeight: 1.55 }}>{body}</div>
                  )}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginTop: 10, flexWrap: 'wrap' }}>
                    {/* A `title` on a DISABLED button never shows — browsers
                        swallow hover events on disabled controls, so the "why
                        is this greyed out?" answer was unreachable. Same
                        group-hover span pattern as Candidates.jsx. */}
                    <span className="relative group" style={{ display: 'inline-flex' }}>
                      <Btn
                        kind="primary"
                        disabled={!sparHref}
                        title={sparHref ? 'Open Broadside and spar against this profile' : undefined}
                        onClick={() => sparHref && nav(sparHref)}
                      >Spar on this in Broadside</Btn>
                      {!sparHref && (
                        <span className="absolute bottom-full left-0 mb-2 w-56 bg-gray-900 text-white text-xs rounded-lg px-3 py-2 shadow-xl hidden group-hover:block z-20 leading-relaxed">
                          Generate a profile first — Broadside spars against the profile's content.
                        </span>
                      )}
                    </span>
                    <span style={{ fontSize: 11, color: T.faint }}>
                      From the profile{newest?.generated_at ? ` · ${fmtDate(newest.generated_at)}` : ''}
                    </span>
                  </div>
                </Card>
              )
            })}
          </div>
        )
      )}

      {panel === 'controversies' && (
        <Card style={{ padding: '20px 24px' }}>
          <ViewHead title="Controversies & opposition research" sub="Section 6 of the latest profile" />
          {loading ? <Spinner /> : (
            <SectionContent
              sectionText={content?.[6]}
              emptyMessage="No controversies section was found in the latest profile. Regenerate it to try again."
            />
          )}
          {newest && (
            <div style={{ marginTop: 14 }}>
              <Btn kind="primary" onClick={() => nav(sparHref)}>Spar on this in Broadside</Btn>
            </div>
          )}
        </Card>
      )}

      {panel === 'attack' && (
        <Card style={{ padding: '20px 24px' }}>
          <ViewHead title="Attack & defense" sub="Section 13 of the latest profile" />
          {loading ? <Spinner /> : (
            <SectionContent
              sectionText={content?.[13]}
              emptyMessage="No attack & defense section was found in the latest profile. Regenerate it to try again."
            />
          )}
          {newest && (
            <div style={{ marginTop: 14 }}>
              <Btn kind="primary" onClick={() => nav(sparHref)}>Spar on this in Broadside</Btn>
            </div>
          )}
        </Card>
      )}
    </div>
  )
}

// ═══ Allies ═══════════════════════════════════════════════════════════════════

// Sections 8 & 9 are free-form markdown. Where the model produced a table or a
// "**Name** — role" bullet the rows are lifted into the card list from the
// mockup; anything that doesn't parse is rendered as the original markdown
// underneath so no content is ever dropped.
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
      if (!cells[0] || cells[0] === '—') continue
      out.push({ name: cells[0], role: cells.slice(1).filter(Boolean).join(' · ') })
      continue
    }
    const bullet = line.match(/^[-*]\s+\*\*(.+?)\*\*\s*[—–:-]\s*(.+)$/)
    if (bullet) { out.push({ name: bullet[1].trim(), role: bullet[2].trim() }); continue }
  }
  return out.filter(a => a.name.length > 1 && a.name.length < 90).slice(0, 40)
}

// Names present in the newest profile's Sections 8 & 9 but absent from the
// previous profile's. Pure set difference on the same parser — no model call,
// no guessing — and it simply doesn't run when there is no previous dossier.
function usePreviousAllyNames(dossiers) {
  const prevId = dossiers?.[1]?.id || null
  const [names, setNames] = useState(null)
  useEffect(() => {
    const prev = dossiers?.[1]
    if (!prev) { setNames(null); return }
    let cancelled = false
    fetchDossierContent(prev).then(content => {
      if (cancelled) return
      if (!content) { setNames(null); return }
      const found = [
        ...parseAllies(parseSection(content, 8)),
        ...parseAllies(parseSection(content, 9)),
      ].map(a => a.name.trim().toLowerCase())
      setNames(new Set(found))
    })
    return () => { cancelled = true }
  }, [prevId]) // eslint-disable-line react-hooks/exhaustive-deps
  return names
}

export function AlliesView({ candidate, dossiers, canIntel, alliesUpdated, nav }) {
  const { content, loading } = useDossierSection(dossiers, [8, 9])
  const prevAllyNames = usePreviousAllyNames(dossiers)

  if (!canIntel) return <LockedView title="Allies" onSeePlans={() => nav('/plans')} />

  if (!dossiers?.length) {
    return (
      <Card style={{ padding: '20px 24px' }}>
        <ViewHead title="Allies & endorsements" />
        <EmptyState
          title="No profile generated yet"
          body={`Endorsements and the political network for ${candidate.name} come from Sections 8 and 9 of the AI profile.`}
          action={<CtaButton onClick={() => nav(`/dossiers?candidate=${candidate.id}`)}>Generate profile</CtaButton>}
        />
      </Card>
    )
  }

  if (loading || content === null) return <Card style={{ padding: 20 }}><Spinner /></Card>

  const s8 = content?.[8] || ''
  const s9 = content?.[9] || ''
  const newestDate = dossiers[0]?.generated_at ? fmtDate(dossiers[0].generated_at, 'MMM d') : null
  // The schema template row ('Org' / 'Role · Type · Years · Source') parses
  // exactly like a real ally, so it was rendered as one. Drop it — and any row
  // that is only unfilled bracket tokens — before de-duplicating.
  const allies = [...parseAllies(s8), ...parseAllies(s9)].filter(a => !isAllyTemplateRow(a))
  const seen = new Set()
  const rows = allies.filter(a => {
    const k = a.name.toLowerCase()
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })

  if (!s8.trim() && !s9.trim()) {
    return (
      <Card style={{ padding: '20px 24px' }}>
        <ViewHead title="Allies & endorsements" />
        <EmptyState
          title="No ally or endorsement data in the latest profile"
          body="Regenerate the profile to search again for endorsements and network connections."
          action={<CtaButton onClick={() => nav(`/dossiers?candidate=${candidate.id}`)}>Regenerate profile</CtaButton>}
        />
      </Card>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {rows.length > 0 && (
        <Card style={{ padding: '20px 24px' }}>
          <ViewHead
            title="Allies & endorsements"
            sub="from profile sections 8 & 9"
            right={alliesUpdated ? <NewBadge label="UPDATED" /> : null}
          />
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {rows.map((a, i) => {
              const isNewAlly = !!prevAllyNames && !prevAllyNames.has(a.name.trim().toLowerCase())
              return (
              <div key={`${a.name}-${i}`} style={{
                display: 'flex', alignItems: 'center', gap: 12,
                padding: '11px 0', borderTop: `1px solid ${T.divider}`, minHeight: 44,
              }}>
                <span style={{
                  flexShrink: 0, width: 32, height: 32, borderRadius: '50%', background: T.chip,
                  color: T.ink3, fontSize: 10.5, fontWeight: 700,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>{initialsOf(String(a.name).replace(/\[[^\]]*\]/g, '').trim() || a.name)}</span>
                <div style={{ minWidth: 0 }}>
                  {/* [KNOWN] / [X/Live] used to sit here as literal text. Same
                      chip renderer the Section 8 markdown table uses. */}
                  <div style={{ fontSize: 12.5, fontWeight: 600 }}>
                    <TokenText text={a.name} />
                  </div>
                  {a.role && !isPlaceholderOnly(a.role) && (
                    <div style={{ fontSize: 11, color: T.faint, marginTop: 1 }}>
                      <TokenText text={a.role} />
                    </div>
                  )}
                </div>
                {isNewAlly && newestDate && (
                  <span style={{ marginLeft: 'auto', flexShrink: 0 }}>
                    <NewBadge label={`New ${newestDate}`} />
                  </span>
                )}
              </div>
              )
            })}
          </div>
        </Card>
      )}

      {s8.trim() && (
        <Card style={{ padding: '20px 24px' }}>
          <ViewHead title="Affiliations & endorsements" sub="Section 8" />
          <SectionContent sectionText={s8} />
        </Card>
      )}
      {s9.trim() && (
        <Card style={{ padding: '20px 24px' }}>
          <ViewHead
            title="Political network & allies"
            sub="Section 9"
            right={<TextLink onClick={() => nav(`/dossiers?view=${dossiers[0].id}`)}>Full profile →</TextLink>}
          />
          <SectionContent sectionText={s9} />
        </Card>
      )}
    </div>
  )
}
