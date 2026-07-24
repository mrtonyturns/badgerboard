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

const PARTY_COLOR = {
  Republican: '#B91C1C', Democrat: '#1D4ED8', Independent: '#7C3AED',
  Other: '#64748B', None: '#94A3B8',
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
    <div className="space-y-6 max-w-4xl">
      <LoadingBar loading={loading} />

      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
          <BarChart2 className="w-6 h-6 text-brand-red" /> Polling
          <span className="text-[10px] font-extrabold uppercase tracking-wider bg-purple-600 text-white px-2 py-0.5 rounded-full">Beta</span>
        </h1>
        <p className="text-gray-500 text-sm mt-1">
          AI-estimated district opinion snapshots — a fast directional read between real polls, built from cited local news, public polling, past results, and social signal.
        </p>
      </div>

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

          {/* Vote share */}
          <div className="card">
            <div className="flex items-center justify-between mb-1">
              <h2 className="text-sm font-bold text-gray-900">Vote-Share Projection</h2>
              <AiTag />
            </div>
            <p className="text-xs text-gray-500 mb-4">If the election were held today</p>
            <div className="space-y-3">
              {(snapshot.vote_share || []).map((v, i) => (
                <div key={i}>
                  <div className="flex items-baseline justify-between mb-1">
                    <span className="text-sm font-bold text-gray-800">
                      {v.candidate}
                      {v.party && v.party !== 'None' && <span className="text-xs font-semibold text-gray-400 ml-2">{v.party}</span>}
                    </span>
                    <span className="text-sm font-black tabular-nums" style={{ color: PARTY_COLOR[v.party] || '#334155' }}>{v.pct}%</span>
                  </div>
                  <div className="h-2.5 bg-gray-100 rounded-full overflow-hidden">
                    <div className="h-full rounded-full" style={{ width: `${Math.min(100, v.pct)}%`, background: PARTY_COLOR[v.party] || '#64748B' }} />
                  </div>
                </div>
              ))}
            </div>
            {band && (
              <p className="text-[11px] text-gray-400 font-semibold mt-4">
                Margin ±{snapshot.confidence.margin_pts} pts ({band.label.toLowerCase()}) applies to every figure above.
              </p>
            )}
          </div>

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
