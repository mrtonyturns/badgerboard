import React, { useEffect, useState, useCallback, useRef } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { format } from 'date-fns'
import {
  ArrowLeft, Users, Sparkles, AlertTriangle, CheckCircle, XCircle,
  DollarSign, Vote, Target, Building2, FileText, Scale,
  ChevronDown, ChevronUp, TrendingUp, Trophy, Zap,
  MapPin, Globe, Phone, Mail, Briefcase, Home as HomeIcon, ExternalLink,
  BarChart2, Flag,
} from 'lucide-react'
import { getCandidates, getDossiers } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import LoadingBar from '../components/LoadingBar'
import SearchableSelect from '../components/SearchableSelect'

// ─── Theme: candidate A = red (left), candidate B = navy (right) ─────────────
const LEFT  = { primary: '#dc2626', bg: 'bg-red-50',   text: 'text-red-700',   border: 'border-red-200',   dot: 'bg-red-500',   ring: 'ring-red-200',   badge: 'bg-red-100 text-red-700 border border-red-200'   }
const RIGHT = { primary: '#1e3a5f', bg: 'bg-blue-50',  text: 'text-blue-800',  border: 'border-blue-200',  dot: 'bg-blue-700',  ring: 'ring-blue-200',  badge: 'bg-blue-100 text-blue-800 border border-blue-200' }

const partyColor = (p, side) => {
  if (p === 'Republican')  return 'bg-red-100 text-red-700 border border-red-200'
  if (p === 'Democrat')    return 'bg-blue-100 text-blue-700 border border-blue-200'
  if (p === 'Independent') return 'bg-gray-100 text-gray-700 border border-gray-200'
  return 'bg-purple-100 text-purple-700 border border-purple-200'
}

// ─── Section extraction helpers ───────────────────────────────────────────────
function extractSection(content, num) {
  if (!content) return ''
  const re = new RegExp(`## SECTION ${num}[\\s\\S]*?(?=## SECTION ${num + 1}|$)`, 'i')
  return content.match(re)?.[0]?.trim() || ''
}

function extractBullets(sectionText, limit = 8) {
  if (!sectionText) return []
  const lines = sectionText.split('\n')
  return lines
    .filter(l => /^[-*•] /.test(l.trim()))
    .map(l => l.trim().replace(/^[-*•] /, '').replace(/\*\*\[[A-Z ]+\]\*\*/g, '').replace(/\*{1,2}/g, '').trim())
    .filter(Boolean)
    .slice(0, limit)
}

function extractSummary(content, maxLen = 220) {
  if (!content) return ''
  const plain = content
    .replace(/## SECTION \d+[^\n]*/g, '')
    .replace(/\*{1,2}([^*]+)\*{1,2}/g, '$1')
    .replace(/#{1,4} .+/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return plain.length > maxLen ? plain.slice(0, maxLen) + '…' : plain
}

// ─── Candidate picker ────────────────────────────────────────────────────────
function CandidatePicker({ candidates, value, onChange, exclude, side }) {
  const theme = side === 'left' ? LEFT : RIGHT
  const filtered = candidates.filter(c => c.id !== exclude)
  return (
    <SearchableSelect
      value={value || ''}
      onChange={v => onChange(v || null)}
      options={filtered.map(c => ({
        value: c.id,
        label: `${c.name} ${c.party ? `(${c.party[0]})` : ''} ${c.office?.name ? `— ${c.office.name}` : ''}`.trim(),
      }))}
      placeholder="— Select a candidate —"
      searchPlaceholder="Search candidates..."
      buttonClassName={`rounded-xl ${theme.border}`}
    />
  )
}

// ─── Candidate card header ────────────────────────────────────────────────────
function CandidateHeader({ candidate, dossier, side }) {
  const theme = side === 'left' ? LEFT : RIGHT
  const accentBorder = side === 'left' ? 'border-t-4 border-t-red-500' : 'border-t-4 border-t-blue-800'
  return (
    <div className={`bg-white rounded-2xl shadow-sm overflow-hidden border border-gray-200 ${accentBorder}`}>
      <div className="p-5">
        {/* Name + party */}
        <div className="flex items-start justify-between gap-2 mb-3">
          <div className="min-w-0 flex-1">
            <h3 className="font-bold text-gray-900 text-xl leading-tight">{candidate.name}</h3>
            {candidate.office?.name && (
              <p className="text-xs text-gray-500 mt-0.5">
                {candidate.office.name}
                {candidate.office.district_name ? ` — ${candidate.office.district_name}` : ''}
              </p>
            )}
          </div>
          <Link
            to={`/candidates/${candidate.id}`}
            className={`flex items-center gap-1 text-xs font-medium flex-shrink-0 ${theme.text} hover:opacity-80`}
          >
            Profile <ExternalLink className="w-3 h-3" />
          </Link>
        </div>

        {/* Badges */}
        <div className="flex flex-wrap gap-1.5">
          {candidate.party && (
            <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${partyColor(candidate.party)}`}>
              {candidate.party}
            </span>
          )}
          {candidate.status && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 capitalize">
              {candidate.status.replace(/_/g, ' ')}
            </span>
          )}
          {candidate.is_incumbent && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-yellow-100 text-yellow-700 border border-yellow-200 font-semibold">
              Incumbent
            </span>
          )}
        </div>

        {/* Dossier status */}
        <div className="mt-3">
          {dossier ? (
            <div className="flex items-center gap-1.5 text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-2.5 py-1.5">
              <CheckCircle className="w-3.5 h-3.5 flex-shrink-0" />
              <span>Profile: {format(new Date(dossier.generated_at), 'MMM d, yyyy')}</span>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5">
              <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
              <span>No profile — comparison limited</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Overall score card ───────────────────────────────────────────────────────
function ScoreCard({ left, right, leftDossier, rightDossier, leftSections, rightSections }) {
  const lDataPts  = leftSections.reduce((a, b) => a + b, 0)
  const rDataPts  = rightSections.reduce((a, b) => a + b, 0)
  const lSections = leftSections.filter(Boolean).length
  const rSections = rightSections.filter(Boolean).length
  const lFresh    = leftDossier  ? new Date(leftDossier.generated_at)  : null
  const rFresh    = rightDossier ? new Date(rightDossier.generated_at) : null

  const metrics = [
    {
      label: 'Intelligence Points',
      leftVal:  lDataPts,
      rightVal: rDataPts,
      leftDisp: lDataPts,
      rightDisp: rDataPts,
      higherBetter: true,
    },
    {
      label: 'Sections Covered',
      leftVal:  lSections,
      rightVal: rSections,
      leftDisp: `${lSections}/6`,
      rightDisp: `${rSections}/6`,
      higherBetter: true,
    },
    {
      label: 'Profile Age',
      leftVal:  lFresh ? lFresh.getTime() : 0,
      rightVal: rFresh ? rFresh.getTime() : 0,
      leftDisp: lFresh  ? format(lFresh, 'MMM d, yyyy')  : '—',
      rightDisp: rFresh ? format(rFresh, 'MMM d, yyyy') : '—',
      higherBetter: true,
    },
    {
      label: 'Incumbent',
      leftVal: left.is_incumbent ? 1 : 0,
      rightVal: right.is_incumbent ? 1 : 0,
      leftDisp: left.is_incumbent  ? '✓ Yes' : 'Challenger',
      rightDisp: right.is_incumbent ? '✓ Yes' : 'Challenger',
      neutral: true,
    },
  ]

  const lAdv = metrics.filter(m => !m.neutral && m.leftVal > m.rightVal).length
  const rAdv = metrics.filter(m => !m.neutral && m.leftVal < m.rightVal).length
  const tied = metrics.filter(m => !m.neutral && m.leftVal === m.rightVal).length

  // Intelligence score (0-100)
  const maxPts = Math.max(lDataPts + rDataPts, 1)
  const lScore = Math.round((lDataPts / maxPts) * 100)
  const rScore = 100 - lScore

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
      {/* Header */}
      <div className="grid grid-cols-[1fr,auto,1fr] bg-gradient-to-r from-red-50 via-white to-blue-50 border-b border-gray-100">
        <div className="p-5 text-center">
          <div className="text-4xl font-black text-red-600 tabular-nums">{lAdv}</div>
          <div className="text-[10px] text-gray-500 uppercase tracking-wide mt-0.5 font-semibold">Advantages</div>
          <div className="font-bold text-sm text-gray-800 mt-2 truncate px-2">{left.name}</div>
        </div>
        <div className="py-5 px-6 text-center border-x border-gray-100 flex flex-col items-center justify-center">
          <Scale className="w-6 h-6 text-gray-300 mb-1" />
          <div className="text-xs font-semibold text-gray-400 uppercase tracking-widest">vs</div>
          {tied > 0 && <div className="text-[10px] text-gray-400 mt-1">{tied} tied</div>}
        </div>
        <div className="p-5 text-center">
          <div className="text-4xl font-black text-blue-800 tabular-nums">{rAdv}</div>
          <div className="text-[10px] text-gray-500 uppercase tracking-wide mt-0.5 font-semibold">Advantages</div>
          <div className="font-bold text-sm text-gray-800 mt-2 truncate px-2">{right.name}</div>
        </div>
      </div>

      {/* Intelligence bar */}
      {(lDataPts > 0 || rDataPts > 0) && (
        <div className="px-5 py-3 bg-gray-50/50 border-b border-gray-100">
          <div className="flex items-center justify-between text-[10px] text-gray-500 mb-1.5 font-medium uppercase tracking-wide">
            <span>Intelligence Coverage</span>
            <span>{lDataPts + rDataPts} total points</span>
          </div>
          <div className="h-3 bg-gray-200 rounded-full overflow-hidden flex">
            <div
              className="bg-red-500 transition-all duration-500"
              style={{ width: `${lScore}%` }}
            />
            <div
              className="bg-blue-700 transition-all duration-500"
              style={{ width: `${rScore}%` }}
            />
          </div>
          <div className="flex items-center justify-between text-[10px] mt-1 font-medium">
            <span className="text-red-600">{lDataPts} pts</span>
            <span className="text-blue-700">{rDataPts} pts</span>
          </div>
        </div>
      )}

      {/* Metrics rows */}
      <div className="divide-y divide-gray-50">
        {metrics.map(m => {
          const lWins = !m.neutral && m.leftVal > m.rightVal
          const rWins = !m.neutral && m.leftVal < m.rightVal
          return (
            <div key={m.label} className="grid grid-cols-[1fr,auto,1fr] items-center text-sm px-5 py-3">
              <div className={`font-semibold truncate ${lWins ? 'text-emerald-600' : 'text-gray-700'}`}>
                {lWins && <TrendingUp className="w-3.5 h-3.5 inline mr-1 text-emerald-500" />}
                {m.leftDisp}
              </div>
              <div className="px-4 text-[10px] text-gray-400 text-center uppercase tracking-widest whitespace-nowrap">{m.label}</div>
              <div className={`font-semibold text-right truncate ${rWins ? 'text-emerald-600' : 'text-gray-700'}`}>
                {m.rightDisp}
                {rWins && <TrendingUp className="w-3.5 h-3.5 inline ml-1 text-emerald-500" />}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── Profile facts row ────────────────────────────────────────────────────────
function FactRow({ icon: Icon, label, left, right, leftAdv, rightAdv }) {
  const isEmpty = !left && !right
  if (isEmpty) return null
  const differ = left !== right && left && right
  return (
    <div className={`grid grid-cols-2 gap-px border-b border-gray-50 last:border-0 ${differ ? 'bg-yellow-50/30' : ''}`}>
      <div className={`px-4 py-2.5 flex items-center gap-2 text-sm ${leftAdv ? 'text-emerald-700 font-semibold' : 'text-gray-700'}`}>
        {leftAdv && <TrendingUp className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0" />}
        {left || <span className="text-gray-300 italic text-xs">—</span>}
      </div>
      <div className={`px-4 py-2.5 flex items-center gap-2 text-sm ${rightAdv ? 'text-emerald-700 font-semibold' : 'text-gray-700'}`}>
        {rightAdv && <TrendingUp className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0" />}
        {right || <span className="text-gray-300 italic text-xs">—</span>}
      </div>
    </div>
  )
}

// ─── Dossier section compare block ───────────────────────────────────────────
function SectionBlock({ title, icon: Icon, leftBullets, rightBullets, leftName, rightName, emptyLeft, emptyRight }) {
  const [open, setOpen] = useState(true)
  const total = leftBullets.length + rightBullets.length
  if (total === 0 && emptyLeft && emptyRight) return null
  const maxLen = Math.max(leftBullets.length, rightBullets.length)
  const lEdge = leftBullets.length > rightBullets.length
  const rEdge = rightBullets.length > leftBullets.length

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
      {/* Section header */}
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between px-5 py-3.5 bg-gray-50 hover:bg-gray-100 transition-colors"
      >
        <span className="flex items-center gap-2.5 text-sm font-bold text-gray-800">
          <Icon className="w-4 h-4 text-gray-500" />
          {title}
        </span>
        <div className="flex items-center gap-3">
          {total > 0 && (
            <div className="flex items-center gap-2 text-[10px] font-medium">
              <span className={`px-2 py-0.5 rounded-full ${lEdge ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-500'}`}>
                {leftBullets.length}
              </span>
              <span className="text-gray-300">vs</span>
              <span className={`px-2 py-0.5 rounded-full ${rEdge ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-500'}`}>
                {rightBullets.length}
              </span>
            </div>
          )}
          {open ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
        </div>
      </button>

      {/* Depth bar */}
      {open && total > 0 && (
        <div className="px-5 py-2 border-b border-gray-100">
          <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden flex">
            <div
              className="bg-red-500 transition-all duration-500"
              style={{ width: `${Math.round((leftBullets.length / (total || 1)) * 100)}%` }}
            />
            <div
              className="bg-blue-700 transition-all duration-500"
              style={{ width: `${Math.round((rightBullets.length / (total || 1)) * 100)}%` }}
            />
          </div>
          <div className="flex justify-between text-[9px] mt-1 text-gray-400">
            <span>{leftBullets.length} pt{leftBullets.length !== 1 ? 's' : ''} {lEdge && '▲'}</span>
            <span>{rEdge && '▲'} {rightBullets.length} pt{rightBullets.length !== 1 ? 's' : ''}</span>
          </div>
        </div>
      )}

      {/* Columns */}
      {open && (
        <div className="grid grid-cols-1 sm:grid-cols-2 sm:divide-x divide-gray-100">
          <div className="p-4">
            {leftBullets.length > 0
              ? <ul className="space-y-2.5">
                  {leftBullets.map((b, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm text-gray-700 leading-relaxed">
                      <span className="mt-1.5 w-2 h-2 rounded-full bg-red-400 flex-shrink-0" />
                      {b}
                    </li>
                  ))}
                </ul>
              : <p className="text-sm text-gray-400 italic">{emptyLeft || 'No data available'}</p>
            }
          </div>
          <div className="p-4">
            {rightBullets.length > 0
              ? <ul className="space-y-2.5">
                  {rightBullets.map((b, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm text-gray-700 leading-relaxed">
                      <span className="mt-1.5 w-2 h-2 rounded-full bg-blue-600 flex-shrink-0" />
                      {b}
                    </li>
                  ))}
                </ul>
              : <p className="text-sm text-gray-400 italic">{emptyRight || 'No data available'}</p>
            }
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function Compare() {
  const { user } = useAuth()
  const [searchParams, setSearchParams] = useSearchParams()

  const [candidates, setCandidates]         = useState([])
  const [loadingCandidates, setLoadingCand] = useState(true)
  const [leftId,  setLeftId]  = useState(searchParams.get('a') || null)
  const [rightId, setRightId] = useState(searchParams.get('b') || null)
  const [leftCandidate,  setLC] = useState(null)
  const [rightCandidate, setRC] = useState(null)
  const [leftDossier,    setLD] = useState(null)
  const [rightDossier,   setRD] = useState(null)
  const [loading, setLoading]   = useState(false)

  // Use a ref so loadSide always has the latest candidates without being a dependency
  const candidatesRef = useRef([])

  useEffect(() => {
    getCandidates().then(({ data }) => {
      const list = data || []
      setCandidates(list)
      candidatesRef.current = list
      setLoadingCand(false)
    })
  }, [])

  useEffect(() => {
    const params = {}
    if (leftId)  params.a = leftId
    if (rightId) params.b = rightId
    setSearchParams(params, { replace: true })
  }, [leftId, rightId])

  const loadSide = useCallback(async (id) => {
    if (!id) return [null, null]
    const candidate = candidatesRef.current.find(c => c.id === id) || null
    const { data: dossiers } = await getDossiers(id)
    return [candidate, dossiers?.[0] || null]
  }, [])  // stable — reads candidatesRef.current at call time

  useEffect(() => {
    // Wait for candidates to load before reading candidatesRef
    if (loadingCandidates) return
    if (!leftId && !rightId) {
      setLC(null); setRC(null); setLD(null); setRD(null)
      return
    }
    setLoading(true)
    Promise.all([loadSide(leftId), loadSide(rightId)]).then(([[lc, ld], [rc, rd]]) => {
      setLC(lc); setRC(rc); setLD(ld); setRD(rd)
      setLoading(false)
    })
  }, [leftId, rightId, loadSide, loadingCandidates])

  const hasComparison = leftId && rightId && leftCandidate && rightCandidate

  // Section extraction
  const lC = leftDossier?.content  || ''
  const rC = rightDossier?.content || ''
  const lSec = n => extractSection(lC, n)
  const rSec = n => extractSection(rC, n)
  const lb   = n => extractBullets(lSec(n))
  const rb   = n => extractBullets(rSec(n))

  const sectionCounts = [1, 4, 5, 6, 7, 8].map(n => [lb(n).length, rb(n).length])
  const leftTotals  = sectionCounts.map(([l]) => l)
  const rightTotals = sectionCounts.map(([, r]) => r)

  const lName = leftCandidate?.name  || 'Candidate A'
  const rName = rightCandidate?.name || 'Candidate B'

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <LoadingBar loading={loading} />
      {/* Page header */}
      <div className="flex items-center gap-3">
        <Link to="/candidates" className="btn-secondary text-xs py-1.5 px-2.5 flex items-center gap-1">
          <ArrowLeft className="w-3.5 h-3.5" /> Candidates
        </Link>
      </div>

      {/* Selector card */}
      <div className="card">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-6">
          <div>
            <label className="flex items-center gap-2 text-xs font-bold text-red-600 mb-2 uppercase tracking-wide">
              <div className="w-3 h-3 rounded-full bg-red-500" />
              Candidate A
            </label>
            <CandidatePicker candidates={candidates} value={leftId} onChange={setLeftId} exclude={rightId} side="left" />
          </div>
          <div>
            <label className="flex items-center gap-2 text-xs font-bold text-blue-800 mb-2 uppercase tracking-wide">
              <div className="w-3 h-3 rounded-full bg-blue-700" />
              Candidate B
            </label>
            <CandidatePicker candidates={candidates} value={rightId} onChange={setRightId} exclude={leftId} side="right" />
          </div>
        </div>
      </div>

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-16">
          <div className="w-8 h-8 border-4 border-brand-red border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {/* Comparison content */}
      {!loading && hasComparison && (
        <>
          {/* Candidate headers */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <CandidateHeader candidate={leftCandidate}  dossier={leftDossier}  side="left"  />
            <CandidateHeader candidate={rightCandidate} dossier={rightDossier} side="right" />
          </div>

          {/* Scorecard */}
          {(lC || rC) && (
            <ScoreCard
              left={leftCandidate}   right={rightCandidate}
              leftDossier={leftDossier}  rightDossier={rightDossier}
              leftSections={leftTotals}  rightSections={rightTotals}
            />
          )}

          {/* Profile facts */}
          <div className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
            {/* Section header */}
            <div className="px-5 py-3.5 bg-gray-50 border-b border-gray-100">
              <h3 className="font-bold text-sm text-gray-800 flex items-center gap-2">
                <FileText className="w-4 h-4 text-gray-500" />
                Profile Facts
              </h3>
            </div>
            {/* Sticky column headers */}
            <div className="grid grid-cols-2 divide-x divide-gray-100 border-b border-gray-200 bg-gradient-to-r from-red-50 to-blue-50 sticky top-0 z-10 text-xs sm:text-sm">
              <div className="px-4 py-2 flex items-center gap-2">
                <div className="w-2.5 h-2.5 rounded-full bg-red-500" />
                <span className="text-xs font-bold text-red-700 truncate">{lName}</span>
              </div>
              <div className="px-4 py-2 flex items-center gap-2">
                <div className="w-2.5 h-2.5 rounded-full bg-blue-700" />
                <span className="text-xs font-bold text-blue-800 truncate">{rName}</span>
              </div>
            </div>
            {/* Rows */}
            {[
              { label: 'Party',       left: leftCandidate.party,                              right: rightCandidate.party },
              { label: 'Office',      left: leftCandidate.office?.name,                       right: rightCandidate.office?.name },
              { label: 'District',    left: leftCandidate.office?.district_name,              right: rightCandidate.office?.district_name },
              { label: 'Status',      left: leftCandidate.status?.replace(/_/g,' '),          right: rightCandidate.status?.replace(/_/g,' ') },
              { label: 'Incumbent',   left: leftCandidate.is_incumbent ? '✓ Yes' : 'Challenger', right: rightCandidate.is_incumbent ? '✓ Yes' : 'Challenger',
                leftAdv: leftCandidate.is_incumbent && !rightCandidate.is_incumbent,
                rightAdv: rightCandidate.is_incumbent && !leftCandidate.is_incumbent },
              { label: 'Hometown',    left: leftCandidate.hometown,                           right: rightCandidate.hometown },
              { label: 'Occupation',  left: leftCandidate.occupation,                         right: rightCandidate.occupation },
              { label: 'Website',     left: leftCandidate.website,                            right: rightCandidate.website },
            ].map(row => (
              <FactRow key={row.label} {...row} icon={FileText} />
            ))}
          </div>

          {/* Intelligence sections */}
          {(lC || rC) ? (
            <div className="space-y-4">
              {/* Section column headers (sticky legend) */}
              <div className="flex items-center justify-between">
                <h2 className="text-base font-bold text-gray-900 flex items-center gap-2">
                  <Sparkles className="w-4 h-4 text-brand-red" />
                  Intelligence Comparison
                  <span className="text-xs text-gray-400 font-normal">(from AI profiles)</span>
                </h2>
                <div className="flex items-center gap-3 text-[11px]">
                  <span className="flex items-center gap-1.5 font-semibold text-red-600">
                    <div className="w-2 h-2 rounded-full bg-red-500" />
                    {lName.split(' ').slice(-1)[0]}
                  </span>
                  <span className="flex items-center gap-1.5 font-semibold text-blue-700">
                    <div className="w-2 h-2 rounded-full bg-blue-600" />
                    {rName.split(' ').slice(-1)[0]}
                  </span>
                </div>
              </div>

              <SectionBlock
                title="Recent News & Media"
                icon={FileText}
                leftBullets={lb(1)}  rightBullets={rb(1)}
                leftName={lName}     rightName={rName}
                emptyLeft={!lC  ? 'No profile available' : 'No news items found'}
                emptyRight={!rC ? 'No profile available' : 'No news items found'}
              />
              <SectionBlock
                title="Political Record"
                icon={Vote}
                leftBullets={lb(4)}  rightBullets={rb(4)}
                leftName={lName}     rightName={rName}
                emptyLeft={!lC  ? 'No profile available' : 'No political record items'}
                emptyRight={!rC ? 'No profile available' : 'No political record items'}
              />
              <SectionBlock
                title="Campaign Finance"
                icon={DollarSign}
                leftBullets={lb(5)}  rightBullets={rb(5)}
                leftName={lName}     rightName={rName}
                emptyLeft={!lC  ? 'No profile available' : 'No financial data'}
                emptyRight={!rC ? 'No profile available' : 'No financial data'}
              />
              <SectionBlock
                title="Controversies & Opposition Research"
                icon={AlertTriangle}
                leftBullets={lb(6)}  rightBullets={rb(6)}
                leftName={lName}     rightName={rName}
                emptyLeft={!lC  ? 'No profile available' : 'No controversies noted'}
                emptyRight={!rC ? 'No profile available' : 'No controversies noted'}
              />
              <SectionBlock
                title="Policy Positions"
                icon={Target}
                leftBullets={lb(7)}  rightBullets={rb(7)}
                leftName={lName}     rightName={rName}
                emptyLeft={!lC  ? 'No profile available' : 'No policy positions found'}
                emptyRight={!rC ? 'No profile available' : 'No policy positions found'}
              />
              <SectionBlock
                title="Affiliations & Organizations"
                icon={Building2}
                leftBullets={lb(8)}  rightBullets={rb(8)}
                leftName={lName}     rightName={rName}
                emptyLeft={!lC  ? 'No profile available' : 'No affiliations found'}
                emptyRight={!rC ? 'No profile available' : 'No affiliations found'}
              />
            </div>
          ) : (
            <div className="card text-center py-10 text-gray-500">
              <Sparkles className="w-8 h-8 text-gray-300 mx-auto mb-2" />
              <p className="font-medium text-sm">No profiles available for either candidate.</p>
              <p className="text-xs mt-1 text-gray-400">
                Generate profiles from the{' '}
                <Link to="/dossiers" className="text-brand-red hover:underline">Profiler</Link>{' '}
                page to enable full comparison.
              </p>
            </div>
          )}

          {/* Disclaimer */}
          <div className="flex items-start gap-2 px-4 py-3 bg-amber-50 rounded-xl border border-amber-200 text-xs text-amber-800">
            <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
            Comparison data is AI-generated and may contain inaccuracies. Verify all information through official sources before use.
          </div>
        </>
      )}

      {/* Partial selection prompt */}
      {!loading && !hasComparison && (leftId || rightId) && (
        <div className="card text-center py-10 text-gray-400">
          <Users className="w-8 h-8 mx-auto mb-2 text-gray-300" />
          <p className="text-sm">Select both Candidate A and Candidate B above to see their comparison.</p>
        </div>
      )}

      {/* Empty state */}
      {!loading && !leftId && !rightId && (
        <div className="card text-center py-14 text-gray-400">
          <div className="flex items-center justify-center gap-4 mb-4">
            <div className="w-12 h-12 bg-red-100 rounded-2xl flex items-center justify-center">
              <Flag className="w-6 h-6 text-red-500" />
            </div>
            <Scale className="w-8 h-8 text-gray-200" />
            <div className="w-12 h-12 bg-blue-100 rounded-2xl flex items-center justify-center">
              <Flag className="w-6 h-6 text-blue-600" />
            </div>
          </div>
          <p className="font-semibold text-gray-600 text-sm">Compare any two candidates side by side</p>
          <p className="text-xs mt-1">
            Select Candidate A and Candidate B above to compare profiles,
            profile intelligence, and key facts.
          </p>
        </div>
      )}
    </div>
  )
}
