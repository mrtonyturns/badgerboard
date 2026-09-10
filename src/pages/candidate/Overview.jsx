// candidate/Overview.jsx — SPEC-candidate-profile.md §4.
//
// Left column: this week's update (dossiers.weekly_digest), what changed in this
// refresh (dossiers.refresh_diff), snapshot (useBioSummary + fact grid).
// Right rail: monitoring, status suggestion, do next, recent refreshes.
//
// Every value on this page comes from a row that exists. Where there is no row
// the card renders the honest empty state instead of a zero or a placeholder
// chart (SPEC rule 4 / §4 "never render zero-filled charts").

import React, { useEffect, useState } from 'react'
import { format } from 'date-fns'
import { getDossier } from '../../lib/supabase'
import { hasFindings } from '../../lib/profileContent'
import { candidateStatusLabel as statusLabel } from '../../lib/campaignEnums'
import {
  T, Card, CardHead, EmptyState, CtaButton, TextLink, LivePulseDot,
  fmtDate, safeISO, nextMonday, Btn, CategoryPill, sectionTarget, Spinner,
  digestItemMeta, isDigestItemUnread,
} from './shared'

// ── Status detection (unchanged rules from the previous page) ────────────────
export function detectStatusFromDossier(content) {
  if (!content) return null
  const text = content.toLowerCase()
  if (/\belecte[d]\b/.test(text) || /\bwon\s+(the\s+)?general\b/.test(text) || /\bwins?\s+(the\s+)?general\b/.test(text)) return 'elected'
  if (/\blost?\s+(the\s+)?(general|election|race)\b/.test(text) || /\bwas\s+defeated\b/.test(text) || /\bdefeat(?:ed)?\s+in\s+(the\s+)?general\b/.test(text)) return 'lost'
  if (/\bwithdr[ae]w[n]?\b/.test(text) || /\bdropped?\s+out\b/.test(text) || /\bended\s+their\s+campaign\b/.test(text)) return 'withdrawn'
  if (/\bwon\s+(the\s+)?primary\b/.test(text) || /\bprimary\s+winner\b/.test(text) || /\badvance[sd]\s+to\s+(the\s+)?general\b/.test(text)) return 'primary_winner'
  if (/\bhas\s+formally\s+(declared|announced|filed)\b/.test(text) || /\bofficially\s+(declared|announced|filed)\b/.test(text) || /\bhas\s+filed\b/.test(text) || /\bfiled\s+(their\s+)?candidacy\b/.test(text)) return 'declared'
  return null
}

// The old StatusRecommendationBanner, restyled into the right-rail card from the
// mockup. Same detection, same Confirm / Dismiss actions.
function StatusSuggestionCard({ candidate, dossiers, onAccept }) {
  const [rec, setRec] = useState(null)
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState(false)

  // This card stays mounted when the user moves between candidates, so a
  // Confirm/Dismiss on one candidate used to permanently suppress the
  // suggestion for every candidate opened afterwards. Reset per candidate id.
  useEffect(() => {
    setRec(null)
    setDone(false)
    setBusy(false)
  }, [candidate?.id])

  useEffect(() => {
    if (!dossiers?.length || done) return
    const latest = dossiers[0]
    const analyze = (content) => {
      const detected = detectStatusFromDossier(content)
      if (detected && detected !== candidate.status) setRec(detected)
    }
    if (latest.content) { analyze(latest.content); return }
    getDossier(latest.id).then(({ data }) => { if (data?.content) analyze(data.content) })
  }, [dossiers, candidate.status, done])

  if (!rec || done) return null

  return (
    <div style={{
      background: T.warmBg, border: `1px solid ${T.warmBr}`, borderRadius: 16, padding: '18px 20px',
    }}>
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.6px', color: T.warmInk, marginBottom: 6 }}>
        STATUS SUGGESTION
      </div>
      <div style={{ fontSize: 12.5, lineHeight: 1.5, marginBottom: 12 }}>
        The latest profile reads as <span style={{ fontWeight: 600 }}>{statusLabel(rec)}</span>.
        {' '}This candidate is recorded as <span style={{ fontWeight: 600 }}>{statusLabel(candidate.status)}</span> —
        confirm the change or dismiss it.
      </div>
      <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
        <Btn
          kind="primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            try { await onAccept(rec); setDone(true) } finally { setBusy(false) }
          }}
        >{busy ? 'Updating…' : `Confirm ${statusLabel(rec)}`}</Btn>
        <Btn kind="warm" onClick={() => setDone(true)}>Dismiss</Btn>
      </div>
    </div>
  )
}

// ── Items-per-refresh bar chart ──────────────────────────────────────────────
// Last 8 refreshes, oldest → newest, newest in red. Renders nothing at all when
// no refresh has produced a digest yet — no zero-filled bars.
function RefreshBars({ refreshes }) {
  const withData = refreshes.filter(r => r.count > 0)
  if (!withData.length) {
    return (
      <EmptyState
        title="No digest items yet"
        body="This chart counts the items in each weekly digest. The first bar appears after the next Monday refresh produces one."
      />
    )
  }
  const max = Math.max(1, ...refreshes.map(r => r.count))
  const slot = 240 / refreshes.length
  const barW = Math.max(8, Math.min(20, slot - 9))
  return (
    <>
      <svg width="100%" height="72" viewBox="0 0 240 72" preserveAspectRatio="none" role="img"
        aria-label="Items surfaced per weekly refresh">
        <line x1="0" y1="60" x2="240" y2="60" stroke={T.border} strokeWidth="1" />
        {refreshes.map((r, i) => {
          // Zero weeks get a 2px baseline stub (not the old 4px gray pill,
          // which read as a broken render next to a full-height bar).
          const h = r.count === 0 ? 2 : Math.max(4, (r.count / max) * 52)
          return (
            <rect
              key={r.id}
              x={(i * slot) + (slot - barW) / 2}
              y={60 - h}
              width={barW}
              height={h}
              rx={r.count === 0 ? 1 : 3}
              fill={i === refreshes.length - 1 ? T.red : r.count === 0 ? T.border : '#E4DFDA'}
            >
              <title>{`${fmtDate(r.generated_at)} — ${r.count} item${r.count === 1 ? '' : 's'}`}</title>
            </rect>
          )
        })}
      </svg>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9.5, color: T.faint, marginTop: 4 }}>
        <span>{fmtDate(refreshes[0].generated_at)}</span>
        {refreshes.length > 1 && <span>{fmtDate(refreshes[refreshes.length - 1].generated_at)}</span>}
      </div>
    </>
  )
}

const DIFF_CHIP = {
  new:       { c: T.red,     bg: '#FBEAEA' },
  updated:   { c: T.warmInk, bg: '#FDF3E3' },
  unchanged: { c: T.muted,   bg: T.chip },
}

function Fact({ k, v }) {
  return (
    <div style={{ background: T.hover, border: `1px solid ${T.divider}`, borderRadius: 11, padding: '10px 13px' }}>
      <div style={{ fontSize: 10, color: T.faint }}>{k}</div>
      <div style={{ fontSize: 12.5, fontWeight: 600, marginTop: 2 }}>{v}</div>
    </div>
  )
}

export default function Overview({
  candidate, dossiers, monitored, canMonitor, unseen, bioSummary,
  onNavigate, onToggleMonitoring, onAcceptStatus, nav, incumbentRecordCount,
}) {
  const newest = dossiers[0] || null
  const prev = dossiers[1] || null
  const digest = newest?.weekly_digest || null
  const diff = newest?.refresh_diff || null
  const isNewDossier = newest && unseen.isUnseenDossier(newest)

  // Last 8 refreshes oldest → newest for the chart, newest-first for the list.
  const last8 = dossiers.slice(0, 8).map(d => ({
    id: d.id,
    generated_at: d.generated_at,
    count: (d.weekly_digest?.items || []).length,
    auto: !d.generated_by,
  })).reverse()

  const totalItems = dossiers.reduce((n, d) => n + (d.weekly_digest?.items || []).length, 0)
  const oldest = dossiers[dossiers.length - 1]
  const monitoringSince = candidate.section_timestamps?.monitoring_updated_at

  // The stored bio is only shown when it carries real findings — a "no findings"
  // placeholder from an old profile run is not a snapshot.
  const manualBio = candidate.bio_summary && hasFindings(candidate.bio_summary)
    ? candidate.bio_summary
    : null

  const cash = candidate.cash_on_hand != null && candidate.cash_on_hand !== ''
    ? `$${Number(candidate.cash_on_hand).toLocaleString()}`
    : 'Not on file'

  const facts = [
    { k: 'Office sought', v: candidate.office
        ? [candidate.office.name, candidate.office.district_name].filter(Boolean).join(' — ')
        : 'No office linked' },
    { k: 'Status',        v: statusLabel(candidate.status) || 'Not set' },
    { k: 'Party',         v: candidate.party || 'No party on file' },
    { k: 'Incumbent',     v: candidate.is_incumbent ? 'Yes' : 'No' },
    { k: 'Committee',     v: candidate.campaign_committee || 'Not on file' },
    { k: 'Cash on hand',  v: cash },
  ]

  const actions = [
    {
      label: 'Spar in Broadside',
      sub: newest ? 'Practice against this profile' : 'Generate a profile first',
      glyph: 'B', tileBg: '#FBEAEA', tileFg: T.red,
      disabled: !newest,
      go: () => newest && nav(`/broadside?dossier=${newest.id}`),
    },
    {
      label: 'Compare vs. opponent',
      sub: 'Side-by-side with another candidate',
      glyph: 'C', tileBg: '#F3EDFB', tileFg: '#7C3AED',
      go: () => nav(`/compare?a=${candidate.id}`),
    },
    {
      label: 'Add to Game Plan',
      sub: 'Turn this week into dated milestones',
      glyph: 'G', tileBg: '#E7F0FD', tileFg: '#1D4ED8',
      go: () => nav('/game-plan'),
    },
    {
      label: 'Pull voter list',
      sub: 'Build a list for this district',
      glyph: 'V', tileBg: '#E6F5EC', tileFg: '#15803D',
      go: () => nav('/voter-lists'),
    },
  ]

  return (
    <div className="cp-cols" style={{ display: 'grid', gridTemplateColumns: '1.7fr 1fr', gap: 16, alignItems: 'start' }}>
      {/* ── left column ── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>

        {!monitored && (
          <div style={{ background: '#fff', border: '1px dashed #DEDEDA', borderRadius: 16, padding: '22px 24px' }}>
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 5 }}>Active Monitoring is off</div>
            <div style={{ fontSize: 12.5, color: T.muted, lineHeight: 1.6, marginBottom: 14 }}>
              Turn it on and {candidate.name}&rsquo;s profile refreshes automatically every Monday — free, no quota
              used. You&rsquo;ll get a weekly digest of what changed, and new items surface here instead of you having
              to regenerate manually.{' '}
              {newest?.generated_at
                ? `Last profile was generated ${fmtDate(newest.generated_at, 'MMM d')}.`
                : 'No profile has been generated for this candidate yet.'}
            </div>
            {canMonitor ? (
              <CtaButton onClick={onToggleMonitoring}>Turn on Active Monitoring</CtaButton>
            ) : (
              <CtaButton onClick={() => nav('/plans')}>See plans</CtaButton>
            )}
          </div>
        )}

        {monitored && (
          <Card>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '18px 24px 0', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 15, fontWeight: 700 }}>This week&rsquo;s update</span>
              {unseen.total > 0 && (
                <span style={{
                  fontSize: 10, fontWeight: 700, background: '#FBEAEA', color: T.red,
                  borderRadius: 99, padding: '3px 8px',
                }}>{unseen.total} NEW</span>
              )}
              {newest && (
                <TextLink style={{ marginLeft: 'auto' }} onClick={() => nav(`/dossiers?view=${newest.id}`)}>
                  Open full profile →
                </TextLink>
              )}
            </div>

            {digest ? (
              <>
                <div style={{ fontSize: 11.5, color: T.faint, padding: '4px 24px 0' }}>
                  {newest.generated_at
                    ? `Week of ${format(safeISO(newest.generated_at), 'MMM d')} · refreshed ${newest.generated_by ? 'manually' : 'automatically'} ${format(safeISO(newest.generated_at), 'EEEE')} at ${format(safeISO(newest.generated_at), 'h:mm a')}`
                    : 'Refresh date not recorded'}
                </div>
                <div style={{ fontSize: 13, lineHeight: 1.6, color: T.ink2, padding: '12px 24px 16px' }}>
                  {digest.summary}
                </div>
                {(digest.items || []).length > 0 && (
                  <div style={{ borderTop: `1px solid ${T.divider}`, padding: '6px 24px 14px' }}>
                    {digest.items.map((it, i) => {
                      const itemUnread = isDigestItemUnread(it, newest, unseen.lastViewed, isNewDossier)
                      return (
                      <div
                        key={i}
                        className="cp-row"
                        role="button"
                        tabIndex={0}
                        onClick={() => onNavigate(...unseen.categoryTargetOf(it.category))}
                        onKeyDown={e => { if (e.key === 'Enter') onNavigate(...unseen.categoryTargetOf(it.category)) }}
                        style={{ display: 'flex', gap: 11, padding: '11px 10px', margin: '0 -10px', cursor: 'pointer', minHeight: 44 }}
                      >
                        <CategoryPill category={it.category} />
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 12.5, lineHeight: 1.5 }}>
                            <span style={{ fontWeight: 600 }}>{it.title}</span>
                            {it.note ? ` — ${it.note}` : ''}
                          </div>
                          <div style={{ fontSize: 10.5, color: T.faint, marginTop: 3 }}>
                            {digestItemMeta(it, newest)}
                          </div>
                        </div>
                        {itemUnread && (
                          <span
                            aria-label="Unread"
                            style={{
                              flexShrink: 0, marginLeft: 'auto', width: 7, height: 7, borderRadius: '50%',
                              background: T.red, marginTop: 5,
                            }}
                          />
                        )}
                      </div>
                      )
                    })}
                  </div>
                )}
                {(digest.items || []).length === 0 && (
                  <div style={{ padding: '0 24px 18px' }}>
                    <EmptyState
                      title="No individual items this week"
                      body="The refresh ran and found nothing new worth listing. The summary above is the whole week."
                    />
                  </div>
                )}
              </>
            ) : (
              <div style={{ padding: '0 24px 18px' }}>
                <EmptyState
                  title="No weekly digest yet"
                  body={newest
                    ? `${candidate.name} is being monitored. A digest is written when a refresh finds something new against the previous profile — the next one runs ${format(nextMonday(), 'EEEE, MMM d')}.`
                    : `${candidate.name} is being monitored but has no profile yet. Generate one and the Monday refresh will start producing digests.`}
                  action={!newest ? <CtaButton onClick={() => nav(`/dossiers?candidate=${candidate.id}`)}>Generate profile</CtaButton> : null}
                />
              </div>
            )}
          </Card>
        )}

        {monitored && (
          <Card style={{ padding: '20px 24px' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 4, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 14, fontWeight: 700 }}>What changed in this refresh</span>
              {prev?.generated_at && (
                <span style={{ fontSize: 11.5, color: T.faint }}>vs. the {fmtDate(prev.generated_at)} profile</span>
              )}
            </div>
            <div style={{ fontSize: 11.5, color: T.faint, marginBottom: 14 }}>
              Jump straight to the sections that moved.
            </div>

            {!diff ? (
              <EmptyState
                title="Diff available after the next refresh"
                body="Section-level diffs are computed when a profile is refreshed. This profile predates that, so there is nothing to compare yet."
              />
            ) : (
              <RefreshDiffRows diff={diff} onNavigate={onNavigate} />
            )}
          </Card>
        )}

        <Card style={{ padding: '20px 24px' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', marginBottom: 13, flexWrap: 'wrap', gap: 8 }}>
            <span style={{ fontSize: 14, fontWeight: 700 }}>Snapshot</span>
            <span style={{ fontSize: 11.5, color: T.faint }}>
              from the latest profile · AI-generated, verify before use
            </span>
            {dossiers.length > 0 && (
              <TextLink style={{ marginLeft: 'auto' }} onClick={bioSummary.generate}>
                {bioSummary.loading ? 'Generating…' : 'Regenerate'}
              </TextLink>
            )}
          </div>

          <div style={{ fontSize: 13, lineHeight: 1.6, color: T.ink2, marginBottom: 16 }}>
            {dossiers.length === 0
              ? (manualBio || (
                  <span style={{ color: T.faint }}>
                    No profile has been generated for {candidate.name} yet, so there is no snapshot to show.
                    Generate one from the Profiler and it will appear here.
                  </span>
                ))
              : bioSummary.loading ? <Spinner pad={12} />
              : bioSummary.error ? (manualBio || (
                  <span style={{ color: T.faint }}>Could not generate a snapshot: {bioSummary.error}</span>
                ))
              : bioSummary.summary || (
                  <span style={{ color: T.faint }}>
                    No biographical detail was found in the latest profile. Regenerate the profile to try again.
                  </span>
                )}
          </div>

          <div className="cp-cols3" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
            {facts.map(f => <Fact key={f.k} k={f.k} v={f.v} />)}
          </div>
        </Card>
      </div>

      {/* ── right rail ── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>

        {monitored && (
          <Card style={{ padding: '18px 20px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 3 }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#15803D' }} />
              <span style={{ fontSize: 13.5, fontWeight: 700 }}>Monitoring</span>
            </div>
            <div style={{ fontSize: 11, color: T.faint, marginBottom: 14 }}>
              Auto-refreshes Mondays · free, no quota used
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 9, marginBottom: 16 }}>
              <div style={{ background: T.hover, border: `1px solid ${T.divider}`, borderRadius: 10, padding: '9px 12px' }}>
                <div style={{ fontSize: 10, color: T.faint }}>Next refresh</div>
                <div style={{ fontSize: 12.5, fontWeight: 600, marginTop: 1 }}>{format(nextMonday(), 'EEE, MMM d')}</div>
              </div>
              <div style={{ background: T.hover, border: `1px solid ${T.divider}`, borderRadius: 10, padding: '9px 12px' }}>
                <div style={{ fontSize: 10, color: T.faint }}>On since</div>
                <div style={{ fontSize: 12.5, fontWeight: 600, marginTop: 1 }}>
                  {monitoringSince ? fmtDate(monitoringSince) : 'Not recorded'}
                </div>
              </div>
            </div>
            <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.6px', color: T.muted, marginBottom: 8 }}>
              ITEMS PER WEEKLY REFRESH
            </div>
            <RefreshBars refreshes={last8} />
            {dossiers.length > 0 && (
              <div style={{ fontSize: 11, color: T.faint, marginTop: 12, paddingTop: 12, borderTop: `1px solid ${T.divider}` }}>
                {dossiers.length} refresh{dossiers.length === 1 ? '' : 'es'}
                {oldest?.generated_at ? ` since ${fmtDate(oldest.generated_at, 'MMMM')}` : ''}
                {' · '}{totalItems} item{totalItems === 1 ? '' : 's'} surfaced
              </div>
            )}
          </Card>
        )}

        {monitored && (
          <StatusSuggestionCard candidate={candidate} dossiers={dossiers} onAccept={onAcceptStatus} />
        )}

        <Card style={{ padding: '18px 20px' }}>
          <div style={{ fontSize: 13.5, fontWeight: 700, marginBottom: 12 }}>Do next</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {actions.map(a => (
              <div
                key={a.label}
                className="cp-row"
                role="button"
                tabIndex={a.disabled ? -1 : 0}
                onClick={() => !a.disabled && a.go()}
                onKeyDown={e => { if (e.key === 'Enter' && !a.disabled) a.go() }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 11, padding: 8, margin: '0 -8px',
                  cursor: a.disabled ? 'default' : 'pointer', opacity: a.disabled ? 0.5 : 1, minHeight: 44,
                }}
              >
                <span style={{
                  flexShrink: 0, width: 30, height: 30, borderRadius: 8,
                  background: a.tileBg, color: a.tileFg, fontSize: 12, fontWeight: 800,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>{a.glyph}</span>
                <div>
                  <div style={{ fontSize: 12.5, fontWeight: 600 }}>{a.label}</div>
                  <div style={{ fontSize: 10.5, color: T.faint }}>{a.sub}</div>
                </div>
              </div>
            ))}
          </div>
        </Card>

        <Card style={{ padding: '18px 20px' }}>
          <CardHead
            title="Recent refreshes"
            right={<TextLink onClick={() => onNavigate('record', 'history')}>History →</TextLink>}
          />
          {dossiers.length === 0 ? (
            <EmptyState
              title="No profiles yet"
              body={`Nothing has been generated for ${candidate.name}. Generate the first profile from the Profiler and every refresh after it is listed here.`}
              action={<CtaButton onClick={() => nav(`/dossiers?candidate=${candidate.id}`)}>Generate profile</CtaButton>}
            />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
              {dossiers.slice(0, 5).map((d, i) => {
                const n = (d.weekly_digest?.items || []).length
                return (
                  <div key={d.id} style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
                    <span style={{
                      flexShrink: 0, width: 7, height: 7, borderRadius: '50%', marginTop: 4,
                      background: i === 0 ? T.red : '#15803D',
                    }} />
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 600 }}>{fmtDate(d.generated_at, 'EEE, MMM d')}</div>
                      <div style={{ fontSize: 10.5, color: T.faint, marginTop: 1 }}>
                        {d.weekly_digest
                          ? `${n} item${n === 1 ? '' : 's'} in the digest`
                          : 'No digest written for this refresh'}
                      </div>
                    </div>
                    <span style={{ marginLeft: 'auto', flexShrink: 0, fontSize: 10.5, color: T.faint }}>
                      {d.generated_by ? 'Manual' : 'Auto'}
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </Card>

        {incumbentRecordCount > 0 && (
          <Card style={{ padding: '18px 20px' }}>
            <CardHead title="Incumbent record" />
            <div style={{ fontSize: 12.5, color: T.ink2 }}>
              {incumbentRecordCount} record{incumbentRecordCount === 1 ? '' : 's'} on file
            </div>
            <div style={{ marginTop: 10 }}>
              <TextLink onClick={() => onNavigate('record', 'incumbent')}>Open Incumbent Record →</TextLink>
            </div>
          </Card>
        )}
      </div>
    </div>
  )
}

// ── refresh_diff rows ────────────────────────────────────────────────────────
// Every changed section gets a row that navigates to the view that owns it.
// All unchanged sections collapse into one grey row (SPEC §4.2).
function RefreshDiffRows({ diff, onNavigate }) {
  const sections = Array.isArray(diff?.sections) ? diff.sections : []
  if (!sections.length) {
    return (
      <EmptyState
        title="Nothing moved in this refresh"
        body="The refresh ran and every section came back unchanged against the previous profile."
      />
    )
  }
  const changed = sections.filter(s => s.status === 'new' || s.status === 'updated')
  const unchanged = sections.filter(s => s.status !== 'new' && s.status !== 'updated')

  const Row = ({ label, detail, chip, chipStyle, dot, target }) => (
    <div
      className="cp-row"
      role="button"
      tabIndex={0}
      onClick={() => onNavigate(...target)}
      onKeyDown={e => { if (e.key === 'Enter') onNavigate(...target) }}
      style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 10, margin: '0 -10px', cursor: 'pointer', minHeight: 44 }}
    >
      <span style={{ flexShrink: 0, width: 6, height: 6, borderRadius: '50%', background: dot }} />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600 }}>{label}</div>
        {detail && <div style={{ fontSize: 11, color: T.faint, marginTop: 1 }}>{detail}</div>}
      </div>
      <span style={{
        marginLeft: 'auto', flexShrink: 0, fontSize: 10.5, fontWeight: 600,
        color: chipStyle.c, background: chipStyle.bg, borderRadius: 99, padding: '3px 10px',
      }}>{chip}</span>
      <span style={{ flexShrink: 0, fontSize: 12, color: '#C0BFBA' }}>→</span>
    </div>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {changed.map((s, i) => {
        const st = DIFF_CHIP[s.status] || DIFF_CHIP.unchanged
        const n = Number(s.new_items) || 0
        return (
          <Row
            key={`${s.section}-${i}`}
            label={s.label || s.section}
            detail={s.note}
            chip={s.status === 'new' && n > 0 ? `${n} new` : s.status === 'new' ? 'new' : 'updated'}
            chipStyle={st}
            dot={st.c}
            target={sectionTarget(s.section)}
          />
        )
      })}
      {unchanged.length > 0 && (
        <Row
          label={unchanged.map(s => s.label || s.section).join(' · ')}
          detail={`${unchanged.length} section${unchanged.length === 1 ? '' : 's'} came back unchanged`}
          chip="no change"
          chipStyle={DIFF_CHIP.unchanged}
          dot="#D6D6D2"
          target={['record', 'history']}
        />
      )}
    </div>
  )
}

export { StatusSuggestionCard }
