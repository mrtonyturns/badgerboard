// Polling.jsx — BETA-ONLY AI-estimated district opinion snapshots (v1.22)
// Visible only to beta testers/admins (nav + route + server all enforce).
// A district selector up top; below it the snapshot card: Top Issues (ranked),
// Approval Estimate (approve/disapprove bar), Vote-Share Projection
// (horizontal bars), and a Confidence Indicator beside every number.
// Every figure is labeled AI-Estimated, timestamped, and source-cited.
import React, { useEffect, useState, useMemo, useRef, useCallback } from 'react'
import {
  BarChart2, RefreshCw, Loader2, AlertCircle, Sparkles, ExternalLink,
  Clock, ShieldAlert,
} from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import LoadingBar from '../components/LoadingBar'
import SearchableSelect from '../components/SearchableSelect'

// Categorical palette — validated (dataviz six checks, light surface):
// R red / D blue / I amber / Other teal; Undecided is a deliberate neutral,
// and every slice is direct-labeled in the ranking beside the donut.
const PARTY_COLOR = {
  Republican: '#B91C1C', Democrat: '#1D4ED8', Independent: '#B45309',
  Other: '#0D9488', None: '#94A3B8',
}

// shade steps for same-party primary fields (rank order, dark → light)
function shadeFor(hex, i, n) {
  if (n <= 1) return hex
  const f = 1 - (i / Math.max(1, n - 1)) * 0.52   // 1 → 0.48
  const c = parseInt(hex.slice(1), 16)
  const ch = (v) => Math.round(v * f + 246 * (1 - f))
  const r = ch((c >> 16) & 255), g = ch((c >> 8) & 255), b = ch(c & 255)
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`
}
const BAND_STYLE = {
  high:     { label: 'High confidence',     cls: 'bg-green-100 text-green-800' },
  moderate: { label: 'Moderate confidence', cls: 'bg-amber-100 text-amber-800' },
  low:      { label: 'Low confidence',      cls: 'bg-red-100 text-red-700' },
}

// District options: statewide + 8 congressional + 33 senate + 99 assembly
const DISTRICTS = [
  { key: 'state-wi', label: 'Wisconsin — Statewide', group: 'Statewide' },
  ...Array.from({ length: 8 },  (_, i) => ({ key: `congress-${i + 1}`, label: `Congressional District ${i + 1}`, group: 'U.S. House' })),
  ...Array.from({ length: 33 }, (_, i) => ({ key: `senate-${i + 1}`,   label: `State Senate District ${i + 1}`,  group: 'State Senate' })),
  ...Array.from({ length: 99 }, (_, i) => ({ key: `assembly-${i + 1}`, label: `Assembly District ${i + 1}`,      group: 'State Assembly' })),
]

const AiTag = () => (
  <span className="inline-flex items-center gap-1 text-[9px] font-extrabold uppercase tracking-wider bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded">
    <Sparkles style={{ width: 9, height: 9 }} /> AI-Estimated
  </span>
)

// ── Animated vote-share donut (v1.24.2) ─────────────────────────────────────
// A sweep-in donut with hover focus and a staggered ranked legend beside it.
// Respects prefers-reduced-motion (jumps straight to the final state).
function useAnimProgress(key, dur = 1100) {
  const [t, setT] = useState(0)
  useEffect(() => {
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { setT(1); return }
    let raf, start
    const step = (ts) => {
      if (start === undefined) start = ts
      const p = Math.min(1, (ts - start) / dur)
      setT(1 - Math.pow(1 - p, 3))            // ease-out cubic
      if (p < 1) raf = requestAnimationFrame(step)
    }
    setT(0)
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [key, dur])
  return t
}

function DonutChart({ slices, t, hover, setHover, centerTop, centerBottom }) {
  const cx = 90, cy = 90, r = 64, stroke = 26
  const C = 2 * Math.PI * r
  const total = slices.reduce((a, x) => a + (x.pct || 0), 0) || 100
  const GAP = 2.5                              // surface gap between slices
  let acc = 0
  const segs = slices.map((x, i) => { const start = acc / total; acc += (x.pct || 0); return { ...x, start, frac: (x.pct || 0) / total, i } })
  const hovered = hover != null ? segs[hover] : null
  return (
    <svg viewBox="0 0 180 180" className="w-40 h-40 sm:w-44 sm:h-44 flex-shrink-0 select-none" role="img" aria-label="Vote share projection">
      <g transform="rotate(-90 90 90)">
        {segs.map(seg => {
          const sweep = Math.max(0, Math.min(seg.frac, t - seg.start))   // clockwise wipe
          const len = Math.max(0, sweep * C - GAP)
          if (len <= 0) return null
          const dim = hover != null && hover !== seg.i
          return (
            <circle key={seg.i} cx={cx} cy={cy} r={r} fill="none"
              stroke={seg.color}
              strokeWidth={hover === seg.i ? stroke + 6 : stroke}
              strokeDasharray={`${len} ${Math.max(1, C - len)}`}
              strokeDashoffset={-(seg.start * C) - GAP / 2}
              opacity={dim ? 0.3 : 1}
              style={{ transition: 'stroke-width .18s ease, opacity .18s ease', cursor: 'pointer' }}
              onMouseEnter={() => setHover(seg.i)}
              onMouseLeave={() => setHover(null)}
            />
          )
        })}
      </g>
      <text x="90" y="86" textAnchor="middle" style={{ font: '800 21px system-ui, sans-serif', fill: '#111827', opacity: Math.min(1, t * 1.6) }}>
        {hovered ? `${Math.round(hovered.pct)}%` : centerTop}
      </text>
      <text x="90" y="104" textAnchor="middle" style={{ font: '700 9px system-ui, sans-serif', fill: '#9CA3AF', letterSpacing: '.07em', opacity: Math.min(1, t * 1.6) }}>
        {(hovered ? hovered.label : centerBottom || '').toUpperCase().slice(0, 24)}
      </text>
    </svg>
  )
}

function DonutRanking({ slices, t, hover, setHover }) {
  let rank = 0
  return (
    <div className="flex-1 min-w-0 space-y-1.5 w-full">
      {slices.map((x, i) => {
        const isUnd = /undecided/i.test(x.label)
        if (!isUnd) rank += 1
        const shown = t > 0.1 + i * 0.09
        const active = hover === i
        return (
          <div key={i}
            onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}
            className={`flex items-center gap-2.5 rounded-lg px-2 py-1.5 -mx-2 cursor-pointer ${active ? 'bg-gray-50' : ''}`}
            style={{
              opacity: shown ? (hover != null && !active ? 0.4 : 1) : 0,
              transform: shown ? 'translateX(0)' : 'translateX(14px)',
              transition: 'opacity .45s ease, transform .45s ease, background .15s ease',
            }}>
            {isUnd
              ? <span className="w-5 h-5 flex-shrink-0" />
              : <span className="w-5 h-5 rounded-md text-[10px] font-black flex items-center justify-center flex-shrink-0 bg-gray-900 text-white">{rank}</span>}
            <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: x.color }} />
            <span className={`text-sm truncate ${isUnd ? 'text-gray-400 font-semibold' : 'font-bold text-gray-800'}`}>
              {x.label}
              {x.party && x.party !== 'None' && <span className="text-[10px] font-semibold text-gray-400 ml-1.5">{x.party}</span>}
            </span>
            <span className="ml-auto pl-2 text-sm font-black tabular-nums text-gray-900">{Math.round(x.pct * t)}%</span>
          </div>
        )
      })}
    </div>
  )
}

function DonutGroup({ slices, animKey }) {
  const [hover, setHover] = useState(null)
  const t = useAnimProgress(animKey)
  const leader = slices.find(x => !/undecided/i.test(x.label)) || slices[0]
  const leadName = leader ? (leader.label.includes('(') ? leader.label.split('(')[0] : leader.label).trim().split(/\s+/).slice(-1)[0] : ''
  return (
    <div className="flex flex-col sm:flex-row items-center gap-4 sm:gap-7">
      <DonutChart slices={slices} t={t} hover={hover} setHover={setHover}
        centerTop={leader ? `${Math.round(leader.pct * t)}%` : ''}
        centerBottom={leader ? `${leadName} leads` : ''} />
      <DonutRanking slices={slices} t={t} hover={hover} setHover={setHover} />
    </div>
  )
}

export default function Polling() {
  const { user } = useAuth()
  const [district, setDistrict]   = useState('')
  const [snapshot, setSnapshot]   = useState(null)
  const [loading, setLoading]     = useState(false)
  const [generating, setGenerating] = useState(false)
  const [error, setError]         = useState(null)
  const pollRef = useRef(0)

  const api = useCallback(async (action, extra = {}) => {
    const { data: { session } } = await supabase.auth.getSession()
    const res = await fetch('/.netlify/functions/polling-snapshot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
      body: JSON.stringify({ action, district, ...extra }),
    })
    if (res.status === 404) throw new Error('Polling is not available on your account.')
    const json = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(json.error || 'Request failed')
    return json
  }, [district])

  // Load (or start generating) when a district is picked
  useEffect(() => {
    if (!district) { setSnapshot(null); return }
    const gen = ++pollRef.current
    const alive = () => pollRef.current === gen
    ;(async () => {
      setLoading(true); setError(null); setSnapshot(null); setGenerating(false)
      try {
        const { snapshot: snap } = await api('get')
        if (!alive()) return
        const ageOk = snap?.status === 'ready' && snap.generated_at && (Date.now() - new Date(snap.generated_at).getTime()) < 7 * 86400000
        if (snap && (ageOk || snap.status === 'ready')) {
          setSnapshot(snap); setLoading(false)
          return
        }
        // none / stale / errored → generate and poll
        await runGenerate(gen)
      } catch (e) { if (alive()) { setError(e.message); setLoading(false) } }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [district])

  const runGenerate = async (gen = ++pollRef.current, force = false) => {
    const alive = () => pollRef.current === gen
    setGenerating(true); setLoading(true); setError(null)
    try {
      await api('generate', force ? { force: true } : {})
      for (let i = 0; i < 50; i++) {
        await new Promise(r => setTimeout(r, 4000))
        if (!alive()) return
        const { snapshot: snap } = await api('get')
        if (!alive()) return
        if (snap?.status === 'ready' && (!force || Date.now() - new Date(snap.generated_at).getTime() < 10 * 60000)) {
          setSnapshot(snap); setGenerating(false); setLoading(false)
          return
        }
        if (snap?.status === 'error') throw new Error(snap.error_note || 'Snapshot generation failed — try again')
      }
      throw new Error('Generation is taking longer than expected — check back shortly')
    } catch (e) {
      if (alive()) { setError(e.message); setGenerating(false); setLoading(false) }
    }
  }

  const grouped = useMemo(() => {
    const g = {}
    DISTRICTS.forEach(d => { (g[d.group] ||= []).push(d) })
    return g
  }, [])

  const fmtDate = (iso) => iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''
  const band = snapshot?.confidence ? (BAND_STYLE[snapshot.confidence.band] || BAND_STYLE.moderate) : null
  const unsure = snapshot?.approval ? Math.max(0, 100 - (snapshot.approval.approval_pct + snapshot.approval.disapproval_pct)) : 0

  return (
    <div className="space-y-6">
      <LoadingBar loading={loading} />

      {/* Header lives in the top bar (v1.24.1) */}

      {/* District selector */}
      <div className="card py-4">
        <label className="block text-xs font-semibold text-gray-700 mb-2">District</label>
        <div className="max-w-md">
          <SearchableSelect
            value={district}
            onChange={setDistrict}
            groups={Object.entries(grouped).map(([group, items]) => ({
              label: group,
              options: items.map(d => ({ value: d.key, label: d.label })),
            }))}
            placeholder="Select a district…"
            buttonClassName="font-semibold"
            searchPlaceholder="Search districts…"
          />
        </div>
      </div>

      {/* Empty state */}
      {!district && !loading && (
        <div className="card py-16 text-center">
          <BarChart2 className="w-10 h-10 text-gray-200 mx-auto mb-3" />
          <p className="text-sm font-semibold text-gray-500">Pick a district to see its opinion snapshot</p>
          <p className="text-xs text-gray-400 mt-1">First generation for a district takes about a minute, then it's cached for the week.</p>
        </div>
      )}

      {/* Generating state */}
      {generating && (
        <div className="card py-14 text-center">
          <Loader2 className="w-8 h-8 text-brand-red animate-spin mx-auto mb-3" />
          <p className="text-sm font-bold text-gray-700">Building the snapshot…</p>
          <p className="text-xs text-gray-400 mt-1 max-w-sm mx-auto">Gathering cited news and polling signal, checking social conversation, then modeling the estimate. ~60–90 seconds.</p>
        </div>
      )}

      {/* Error state */}
      {error && !generating && (
        <div className="card py-8 text-center">
          <AlertCircle className="w-7 h-7 text-red-500 mx-auto mb-2" />
          <p className="text-sm font-bold text-red-600">{error}</p>
          {district && (
            <button onClick={() => runGenerate(undefined, true)} className="btn-secondary text-sm mt-3">Try again</button>
          )}
        </div>
      )}

      {/* Snapshot */}
      {snapshot?.status === 'ready' && !generating && (
        <div className="space-y-4">
          {/* Meta bar */}
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-sm font-bold text-gray-900">{snapshot.district_name}</span>
            <span className="text-xs text-gray-400 font-semibold flex items-center gap-1">
              <Clock className="w-3 h-3" /> Generated {fmtDate(snapshot.generated_at)}
            </span>
            {band && (
              <span className={`text-[10px] font-extrabold uppercase tracking-wide px-2 py-0.5 rounded-full ${band.cls}`}>
                ±{snapshot.confidence.margin_pts} pts · {band.label}
              </span>
            )}
            <button
              onClick={() => runGenerate(undefined, true)}
              className="ml-auto flex items-center gap-1.5 text-xs font-bold text-brand-red hover:underline"
            >
              <RefreshCw className="w-3.5 h-3.5" /> Refresh
            </button>
          </div>

          {/* Disclaimer — persistent and unmissable */}
          <div className="flex items-start gap-2.5 bg-purple-50 border border-purple-200 rounded-xl px-4 py-3">
            <ShieldAlert className="w-4 h-4 text-purple-600 flex-shrink-0 mt-0.5" />
            <p className="text-xs text-purple-900 leading-relaxed">
              <strong>AI-Estimated — a modeled directional read, not a scientific poll.</strong> Built from cited public signal; no voters were surveyed. Numbers carry the stated margin and should guide attention, not decisions requiring fielded polling.
            </p>
          </div>

          <div className="grid md:grid-cols-2 gap-4">
            {/* Top Issues */}
            <div className="card">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-bold text-gray-900">Top Issues</h2>
                <AiTag />
              </div>
              <div className="space-y-3">
                {(snapshot.top_issues || []).map(it => (
                  <div key={it.rank} className="flex items-start gap-3">
                    <span className="w-6 h-6 rounded-lg bg-brand-navy text-white text-xs font-extrabold flex items-center justify-center flex-shrink-0 mt-0.5">{it.rank}</span>
                    <div className="min-w-0">
                      <p className="text-sm font-bold text-gray-900 leading-snug">{it.issue}</p>
                      <p className="text-xs text-gray-500 leading-snug mt-0.5">{it.why}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Approval */}
            <div className="card">
              <div className="flex items-center justify-between mb-1">
                <h2 className="text-sm font-bold text-gray-900">Approval Estimate</h2>
                <AiTag />
              </div>
              <p className="text-xs text-gray-500 mb-4">{snapshot.approval?.subject}</p>
              <div className="flex items-end gap-6 mb-3">
                <div>
                  <div className="text-3xl font-black text-green-700">{snapshot.approval?.approval_pct}%</div>
                  <div className="text-[10px] font-bold uppercase tracking-wide text-gray-400">Approve</div>
                </div>
                <div>
                  <div className="text-3xl font-black text-red-700">{snapshot.approval?.disapproval_pct}%</div>
                  <div className="text-[10px] font-bold uppercase tracking-wide text-gray-400">Disapprove</div>
                </div>
                {unsure > 0 && (
                  <div>
                    <div className="text-3xl font-black text-gray-400">{Math.round(unsure)}%</div>
                    <div className="text-[10px] font-bold uppercase tracking-wide text-gray-400">Unsure</div>
                  </div>
                )}
              </div>
              <div className="h-3 rounded-full overflow-hidden flex bg-gray-100">
                <div style={{ width: `${snapshot.approval?.approval_pct}%`, background: '#15803d' }} />
                <div style={{ width: `${snapshot.approval?.disapproval_pct}%`, background: '#b91c1c' }} />
              </div>
              {band && (
                <p className="text-[11px] text-gray-400 font-semibold mt-3">
                  ±{snapshot.confidence.margin_pts} pts · {band.label.toLowerCase()} — {snapshot.confidence.note}
                </p>
              )}
            </div>
          </div>

          {/* Vote share — animated donut with ranked legend (v1.24.2).
              Primaries segregated per party until decided; general
              head-to-head once nominees are set. */}
          {(() => {
            const raw = snapshot.vote_share
            const vs = Array.isArray(raw) ? { phase: 'general', general: raw, primaries: [] } : (raw || { phase: 'general', general: [], primaries: [] })
            const isPrimary = vs.phase === 'primary' && (vs.primaries || []).length > 0
            const general = vs.general || []
            const sortSlices = (rows) => {
              const und = rows.filter(r => /undecided/i.test(r.candidate))
              const rest = rows.filter(r => !/undecided/i.test(r.candidate)).sort((a, b) => b.pct - a.pct)
              return [...rest, ...und]
            }
            const primarySlices = (p) => {
              const rows = sortSlices(p.candidates)
              const named = rows.filter(r => !/undecided/i.test(r.candidate))
              return rows.map(r => /undecided/i.test(r.candidate)
                ? { label: 'Undecided', pct: r.pct, color: PARTY_COLOR.None }
                : { label: r.candidate, pct: r.pct, color: shadeFor(PARTY_COLOR[p.party] || PARTY_COLOR.Other, named.indexOf(r), named.length) })
            }
            const generalSlices = sortSlices(general).map(r => ({
              label: r.candidate, party: /undecided/i.test(r.candidate) ? null : r.party, pct: r.pct,
              color: /undecided/i.test(r.candidate) ? PARTY_COLOR.None : (PARTY_COLOR[r.party] || PARTY_COLOR.Other),
            }))
            const baseKey = `${district}-${snapshot.generated_at || ''}`

            return (
              <div className="card">
                <div className="flex items-center justify-between mb-1">
                  <h2 className="text-sm font-bold text-gray-900">Vote-Share Projection</h2>
                  <AiTag />
                </div>
                <p className="text-xs text-gray-500 mb-5">
                  {isPrimary ? 'Primary fields shown per party — candidates only compete within their own primary' : 'If the election were held today'}
                </p>

                {isPrimary && (
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-2">
                    {vs.primaries.map((p, i) => (
                      <div key={i} className="rounded-xl border p-4 sm:p-5" style={{ borderColor: `${PARTY_COLOR[p.party] || '#64748B'}40`, background: `${PARTY_COLOR[p.party] || '#64748B'}08` }}>
                        <p className="text-xs font-extrabold uppercase tracking-wider mb-4" style={{ color: PARTY_COLOR[p.party] || '#334155' }}>
                          {p.party} primary
                        </p>
                        <DonutGroup slices={primarySlices(p)} animKey={`${baseKey}-p-${p.party}`} />
                      </div>
                    ))}
                  </div>
                )}

                {generalSlices.length > 0 && (
                  <div className={isPrimary ? 'mt-5 pt-5 border-t border-gray-100' : ''}>
                    {isPrimary && (
                      <p className="text-xs font-extrabold uppercase tracking-wider text-gray-500 mb-4">November general outlook</p>
                    )}
                    <div className={isPrimary ? 'max-w-xl' : 'max-w-2xl'}>
                      <DonutGroup slices={generalSlices} animKey={`${baseKey}-g`} />
                    </div>
                  </div>
                )}

                {band && (
                  <p className="text-[11px] text-gray-400 font-semibold mt-5">
                    Margin ±{snapshot.confidence.margin_pts} pts ({band.label.toLowerCase()}) applies to every figure above.
                  </p>
                )}
              </div>
            )
          })()}

          {/* Sources */}
          {(snapshot.sources || []).length > 0 && (
            <div className="card">
              <h2 className="text-sm font-bold text-gray-900 mb-3">Sources</h2>
              <div className="space-y-1.5">
                {snapshot.sources.map((s, i) => (
                  <a key={i} href={s.url} target="_blank" rel="noreferrer"
                    className="flex items-center gap-2 text-xs text-brand-navy hover:underline truncate">
                    <ExternalLink className="w-3 h-3 flex-shrink-0 text-gray-400" />
                    <span className="truncate">{s.title || s.url}</span>
                  </a>
                ))}
              </div>
              <p className="text-[10px] text-gray-400 font-semibold mt-3">
                Models: {snapshot.model_used} · {snapshot.disclaimer}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
