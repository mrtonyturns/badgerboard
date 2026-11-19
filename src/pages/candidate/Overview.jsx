// candidate/Overview.jsx — the first thing on a candidate's profile.
//
//   Who they are   the profile's own PROFILE SNAPSHOT (no AI call on open —
//                  the old Snapshot fired generate-bio-summary on every visit
//                  and sat on "Generating…" whenever that call stalled)
//   This week      the newest weekly digest when monitoring has written one,
//                  otherwise when the next refresh runs
//   Key facts      a handful of number tiles (attack lines, weak spots, news,
//                  X, allies, profiles) — each opens the part of the page it
//                  counts. Tiles with nothing to count are left out.
//
// No profile at all → one friendly empty state instead of a stack of panels
// that each say "nothing yet".

import { useEffect, useMemo, useState } from 'react'
import { format } from 'date-fns'
import {
  Sparkles, Radar, Swords, TrendingDown, Newspaper, AtSign, Handshake, FileText, Info,
} from 'lucide-react'
import { getDossier } from '../../lib/supabase'
import { candidateStatusLabel as statusLabel } from '../../lib/campaignEnums'
import { Tile, TileHead, BigNumber, OpenCue, EmptyState, Button, IconChip } from '../../components/ui'
import { fmtDate, nextMonday, digestItemMeta, isDigestItemUnread, catMeta, parseSection } from './shared'
import {
  profileSnapshot, parseAttackDefense, effectiveSwot, profileNews, profileXPosts,
  parseControversies, refreshOverdue,
} from './intelModel'
import { parseAllies, isAllyTemplateRow } from './IntelViews'

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

// The status suggestion: same detection, same Confirm / Dismiss actions.
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
    <Tile className="flex flex-wrap items-center gap-4 p-5" style={{ background: '#FFF8EC' }}>
      <IconChip icon={Info} color="orange" size={36} />
      <p className="min-w-0 flex-1 text-[15px] leading-snug text-brand-ink">
        The latest profile reads as <b>{statusLabel(rec)}</b>. {candidate.name} is recorded as <b>{statusLabel(candidate.status)}</b>.
      </p>
      <div className="flex gap-2">
        <Button
          variant="dark"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            try { await onAccept(rec); setDone(true) } finally { setBusy(false) }
          }}
        >{busy ? 'Updating…' : `Mark ${statusLabel(rec)}`}</Button>
        <Button variant="secondary" onClick={() => setDone(true)}>Dismiss</Button>
      </div>
    </Tile>
  )
}

function FactTile({ icon, color, title, value, unit, note, onOpen }) {
  return (
    <Tile onClick={onOpen} className="flex min-h-[176px] flex-col p-5">
      <TileHead icon={icon} color={color} title={title} />
      <div className="mt-4 [overflow-wrap:anywhere]"><BigNumber value={value} unit={unit} size={typeof value === 'number' ? 44 : 24} /></div>
      {note && <p className="mt-1.5 line-clamp-2 text-[13.5px] leading-snug text-brand-mute">{note}</p>}
      <div className="mt-auto pt-3"><OpenCue /></div>
    </Tile>
  )
}

export default function Overview({
  candidate, dossiers, content, monitored, canMonitor, unseen,
  onNavigate, onToggleMonitoring, onAcceptStatus, nav, xHandle, canIntel,
}) {
  const newest = dossiers[0] || null
  const digest = newest?.weekly_digest || null
  const isNewDossier = newest && unseen.isUnseenDossier(newest)

  const facts = useMemo(() => {
    if (!content) return null
    const swot = effectiveSwot(candidate.swot_data, content)
    const attacks = parseAttackDefense(content)
    const controversies = parseControversies(content)
    const news = profileNews(content)
    const xPosts = profileXPosts(content)
    const allies = [...parseAllies(parseSection(content, 8)), ...parseAllies(parseSection(content, 9))].filter(a => !isAllyTemplateRow(a))
    return { swot, attacks, controversies, news, xPosts, allies, snapshot: profileSnapshot(content) }
  }, [content, candidate.swot_data])

  if (!newest) {
    return (
      <div className="flex flex-col gap-5">
        <Tile className="p-7 md:p-9">
          <EmptyState
            icon={Sparkles}
            color="red"
            title={`No research profile for ${candidate.name} yet`}
            body="Generate one and this page fills in: who they are, their X posts and news, a ranked SWOT, attack lines with the defense for each, and their record."
            action={<Button icon={Sparkles} onClick={() => nav(`/dossiers?candidate=${candidate.id}`)}>Generate profile</Button>}
          />
        </Tile>
        <WatchTile candidate={candidate} monitored={monitored} canMonitor={canMonitor} newest={null} digest={null} onToggleMonitoring={onToggleMonitoring} nav={nav} />
      </div>
    )
  }

  const go = (tab, view) => () => onNavigate(tab, view)
  const tiles = []
  if (facts) {
    const nWeak = facts.swot.weaknesses.length
    if (facts.attacks.length) tiles.push(<FactTile key="atk" icon={Swords} color="red" title="Attack lines" value={facts.attacks.length} unit="with defenses" note={`“${facts.attacks[0].line}”`} onOpen={go('intel', 'attack')} />)
    if (nWeak) tiles.push(<FactTile key="weak" icon={TrendingDown} color="orange" title="Weak spots" value={nWeak} unit={nWeak === 1 ? 'weakness' : 'weaknesses'} note={facts.swot.weaknesses[0].point} onOpen={go('intel', 'swot')} />)
    else if (facts.controversies.length) tiles.push(<FactTile key="con" icon={TrendingDown} color="orange" title="On the record" value={facts.controversies.length} unit="items to check" note={facts.controversies[0].issue} onOpen={go('intel', 'attack')} />)
    if (facts.news.length) tiles.push(<FactTile key="news" icon={Newspaper} color="blue" title="In the news" value={facts.news.length} unit={facts.news.length === 1 ? 'story' : 'stories'} note={facts.news[0].title} onOpen={go('intel', 'x')} />)
    if (xHandle || facts.xPosts.length) tiles.push(<FactTile key="x" icon={AtSign} color="ink" title="On X" value={xHandle ? `@${xHandle}` : facts.xPosts.length} unit={xHandle ? '' : 'posts in the profile'} note={facts.xPosts[0]?.text || 'Their posts load on the Intel tab.'} onOpen={go('intel', 'x')} />)
    if (facts.allies.length && tiles.length < 4) tiles.push(<FactTile key="allies" icon={Handshake} color="green" title="Allies" value={facts.allies.length} unit="organizations & people" note={facts.allies.slice(0, 3).map(a => a.name.replace(/\[[^\]]*\]/g, '').trim()).join(', ')} onOpen={go('intel', 'allies')} />)
  }
  if (tiles.length < 4) {
    tiles.push(<FactTile key="prof" icon={FileText} color="gray" title="Profiles" value={dossiers.length} unit={dossiers.length === 1 ? 'profile' : 'profiles'} note={`Latest ${fmtDate(newest.generated_at, 'MMM d, yyyy')}`} onOpen={go('record', null)} />)
  }

  const note = newest.research_note?.finding

  return (
    <div className="flex flex-col gap-5">
      <StatusSuggestionCard candidate={candidate} dossiers={dossiers} onAccept={onAcceptStatus} />

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <Tile className="flex flex-col p-6 md:p-7 lg:col-span-2">
          <TileHead icon={Sparkles} color="red" title="Who they are" />
          {facts?.snapshot ? (
            <p className="mt-4 text-[18px] leading-relaxed text-brand-ink md:text-[19px]">{facts.snapshot}</p>
          ) : (
            <p className="mt-4 text-[15px] leading-relaxed text-brand-mute">
              This profile has no snapshot paragraph. The full profile has the biography.
            </p>
          )}
          {note && (
            <div className="mt-5 flex gap-3 rounded-2xl bg-[#FFF8EC] px-4 py-3">
              <Info className="mt-0.5 h-4 w-4 flex-shrink-0 text-[#B54708]" />
              <p className="text-[14px] leading-snug text-brand-ink"><b>Heads up from the research: </b>{note}</p>
            </div>
          )}
          <div className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-2 pt-5 text-[13px] text-brand-faint">
            <span>From the {fmtDate(newest.generated_at, 'MMM d, yyyy')} profile · AI research, verify before use</span>
            <button type="button" onClick={() => nav(`/dossiers?view=${newest.id}`)} className="font-bold text-brand-ink hover:underline">Read the full profile →</button>
          </div>
        </Tile>

        <WatchTile candidate={candidate} monitored={monitored} canMonitor={canMonitor} newest={newest} digest={digest} isNewDossier={isNewDossier} unseen={unseen} onNavigate={onNavigate} onToggleMonitoring={onToggleMonitoring} nav={nav} />
      </div>

      {canIntel && tiles.length > 0 && (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">{tiles.slice(0, 4)}</div>
      )}
    </div>
  )
}

/** This week: the digest, or when the next weekly refresh lands, or the switch to turn it on. */
function WatchTile({ candidate, monitored, canMonitor, newest, digest, isNewDossier, unseen, onNavigate, onToggleMonitoring, nav }) {
  if (!monitored) {
    return (
      <Tile className="flex flex-col p-6">
        <TileHead icon={Radar} color="gray" title="Weekly watch is off" />
        <p className="mt-4 text-[15px] leading-relaxed text-brand-mute">
          Turn it on and {candidate.name}'s profile refreshes every Monday — free, no quota used — with a short list of what changed.
        </p>
        <div className="mt-auto pt-5">
          {canMonitor
            ? <Button variant="dark" icon={Radar} onClick={onToggleMonitoring}>Turn on weekly watch</Button>
            : <Button variant="secondary" onClick={() => nav('/plans')}>See plans</Button>}
        </div>
      </Tile>
    )
  }
  if (digest) {
    const items = (digest.items || []).slice(0, 4)
    return (
      <Tile dark className="flex flex-col p-6">
        <TileHead dark icon={Radar} title="This week" right={unseen?.total > 0 ? <span className="rounded-full bg-brand-red px-2 py-0.5 text-[12px] font-bold">{unseen.total} new</span> : null} />
        <div className="mt-1 text-[12.5px] text-white/60">Week of {format(new Date(newest.generated_at), 'MMM d')}</div>
        <p className="mt-3 text-[15px] leading-relaxed text-white/90">{digest.summary}</p>
        {items.length > 0 && (
          <ul className="mt-4 flex flex-col gap-2">
            {items.map((it, i) => {
              const unread = isDigestItemUnread(it, newest, unseen?.lastViewed, isNewDossier)
              return (
                <li key={i}>
                  <button
                    type="button"
                    onClick={() => onNavigate(...unseen.categoryTargetOf(it.category))}
                    className="flex w-full items-start gap-2.5 rounded-xl bg-white/5 px-3 py-2 text-left hover:bg-white/10"
                  >
                    <span className="mt-1.5 h-2 w-2 flex-shrink-0 rounded-full" style={{ background: unread ? '#E0362C' : catMeta(it.category).c }} />
                    <span className="min-w-0">
                      <span className="block text-[14px] font-semibold leading-snug text-white">{it.title}</span>
                      <span className="block text-[12px] text-white/55">{digestItemMeta(it, newest)}</span>
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </Tile>
    )
  }
  const overdue = refreshOverdue(newest, candidate.section_timestamps?.monitoring_updated_at)
  return (
    <Tile className="flex flex-col p-6">
      <TileHead icon={Radar} color="green" title="Weekly watch is on" />
      <div className="mt-4"><BigNumber value={format(nextMonday(), 'MMM d')} unit="next refresh" size={36} /></div>
      <p className="mt-3 text-[14.5px] leading-relaxed text-brand-mute">
        {newest
          ? `Each Monday the profile is refreshed and what changed shows up here. Last profile: ${fmtDate(newest.generated_at, 'MMM d, yyyy')}.`
          : `Generate the first profile and the Monday refresh takes it from there.`}
      </p>
      {overdue && (
        <div className="mt-4 rounded-xl bg-[#FFF8EC] px-3.5 py-3 text-[13.5px] leading-snug text-brand-ink">
          <b>No weekly refresh has arrived in {overdue} weeks.</b> Regenerate the profile to bring it up to date.
        </div>
      )}
    </Tile>
  )
}
