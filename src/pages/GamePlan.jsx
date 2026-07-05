// GamePlan.jsx — Campaign milestone & timeline tracker
// Redesigned: Linear/Notion-style — tight rows, hover-reveal actions, clean phase sections

import React, { useEffect, useState, useMemo, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  format, differenceInDays, differenceInCalendarDays,
  isPast, isFuture, parseISO, isToday,
} from 'date-fns'

// Crash-proof parseISO (see Elections.jsx): bad/missing dates → epoch.
const safeISO = (d) => {
  const t = parseISO(String(d ?? ''))
  return Number.isNaN(+t) ? new Date(0) : t
}

import {
  Target, CalendarDays, Plus, Clock, CheckCircle, Edit2, Trash2, X,
  BarChart2, AlertCircle, ChevronDown, ChevronRight, Users,
  Flag, DollarSign, Megaphone, Scale, Check, SkipForward,
  Loader2, AlertTriangle, List, ChevronUp,
} from 'lucide-react'
import {
  getMilestones, createMilestone, createMilestoneBatch,
  updateMilestone, deleteMilestone, deleteTemplateMilestones,
  getElections, createElection, updateElection, deleteElection,
  getCandidates,
} from '../lib/supabase'
import ElectionResultsBoard from './ElectionResultsBoard'
import LoadingBar from '../components/LoadingBar'
import TaskBoard from '../components/TaskBoard'

// ── Constants ─────────────────────────────────────────────────────────────────

const PHASES = [
  { key: 'planning',      label: 'Planning',       icon: Target,      dot: 'bg-purple-500', text: 'text-purple-700', headerBg: 'bg-purple-50',  borderL: 'border-l-purple-400', progressBg: 'bg-purple-500' },
  { key: 'filing',        label: 'Filing',         icon: Scale,       dot: 'bg-orange-500', text: 'text-orange-700', headerBg: 'bg-orange-50',  borderL: 'border-l-orange-400', progressBg: 'bg-orange-500' },
  { key: 'voter_contact', label: 'Voter Contact',  icon: Megaphone,   dot: 'bg-blue-500',   text: 'text-blue-700',   headerBg: 'bg-blue-50',    borderL: 'border-l-blue-400',   progressBg: 'bg-blue-500'   },
  { key: 'fundraising',   label: 'Fundraising',    icon: DollarSign,  dot: 'bg-emerald-500',text: 'text-emerald-700',headerBg: 'bg-emerald-50', borderL: 'border-l-emerald-400',progressBg: 'bg-emerald-500'},
  { key: 'gotv',          label: 'GOTV',           icon: Flag,        dot: 'bg-red-500',    text: 'text-red-700',    headerBg: 'bg-red-50',     borderL: 'border-l-red-400',    progressBg: 'bg-red-500'    },
  { key: 'election_day',  label: 'Election Day',   icon: CalendarDays,dot: 'bg-slate-500',  text: 'text-slate-700',  headerBg: 'bg-slate-50',   borderL: 'border-l-slate-400',  progressBg: 'bg-slate-500'  },
]

const PHASE_MAP = Object.fromEntries(PHASES.map(p => [p.key, p]))

const CATEGORIES = [
  { key: 'recruitment', label: 'Recruitment' },
  { key: 'legal',       label: 'Legal / Filing' },
  { key: 'outreach',    label: 'Voter Outreach' },
  { key: 'finance',     label: 'Finance' },
  { key: 'media',       label: 'Media / Comms' },
  { key: 'admin',       label: 'Administration' },
  { key: 'general',     label: 'General' },
]

const STATUSES = [
  { key: 'upcoming',    label: 'Upcoming',    },
  { key: 'in_progress', label: 'In Progress', },
  { key: 'complete',    label: 'Complete',    },
  { key: 'overdue',     label: 'Overdue',     },
  { key: 'skipped',     label: 'Skipped',     },
]

const STATUS_MAP = Object.fromEntries(STATUSES.map(s => [s.key, s]))

const ELECTION_TYPE_LABELS = {
  primary:        'Partisan Primary',
  general:        'General Election',
  spring_primary: 'Spring Primary',
  spring_general: 'Spring General',
  special:        'Special Election',
}
const ELECTION_TYPE_COLORS = {
  primary:        { bg: 'bg-orange-500', light: 'bg-orange-100 text-orange-800', border: 'border-orange-300' },
  general:        { bg: 'bg-blue-600',   light: 'bg-blue-100 text-blue-800',     border: 'border-blue-300' },
  spring_primary: { bg: 'bg-purple-600', light: 'bg-purple-100 text-purple-800', border: 'border-purple-300' },
  spring_general: { bg: 'bg-emerald-600',light: 'bg-emerald-100 text-emerald-800',border:'border-emerald-300' },
  special:        { bg: 'bg-yellow-500', light: 'bg-yellow-100 text-yellow-800', border: 'border-yellow-300' },
}

// ── Standard Wisconsin campaign plan template ─────────────────────────────────
// Day offsets are relative to election day (negative = days before).
const PLAN_TEMPLATE = [
  { off: -300, phase: 'planning',      category: 'legal',       title: 'Confirm eligibility & residency requirements' },
  { off: -285, phase: 'planning',      category: 'recruitment', title: 'Recruit campaign leadership (manager, treasurer)' },
  { off: -275, phase: 'planning',      category: 'admin',       title: 'Open dedicated campaign bank account' },
  { off: -265, phase: 'planning',      category: 'general',     title: 'Draft campaign plan, message & budget' },
  { off: -255, phase: 'filing',        category: 'legal',       title: 'Register campaign committee (CF-1) with the WEC / filing officer' },
  { off: -240, phase: 'fundraising',   category: 'finance',     title: 'Launch initial fundraising push (early money)' },
  { off: -210, phase: 'filing',        category: 'legal',       title: 'Begin circulating nomination papers' },
  { off: -180, phase: 'voter_contact', category: 'outreach',    title: 'Build voter universe & targeting lists' },
  { off: -155, phase: 'filing',        category: 'legal',       title: 'File nomination papers & declaration of candidacy' },
  { off: -145, phase: 'filing',        category: 'legal',       title: 'Confirm ballot access with filing officer' },
  { off: -120, phase: 'voter_contact', category: 'outreach',    title: 'Launch door-to-door canvassing program' },
  { off: -90,  phase: 'fundraising',   category: 'finance',     title: 'File pre-primary campaign finance report' },
  { off: -75,  phase: 'voter_contact', category: 'outreach',    title: 'Distribute yard signs & field materials' },
  { off: -60,  phase: 'voter_contact', category: 'media',       title: 'Direct mail round 1 + digital ads live' },
  { off: -21,  phase: 'gotv',          category: 'outreach',    title: 'Absentee & early-vote push begins' },
  { off: -8,   phase: 'fundraising',   category: 'finance',     title: 'File pre-election campaign finance report' },
  { off: -3,   phase: 'gotv',          category: 'outreach',    title: 'GOTV weekend canvass & phone blitz' },
  { off: 0,    phase: 'election_day',  category: 'admin',       title: 'Election Day — turnout tracking & poll coverage' },
  { off: 14,   phase: 'election_day',  category: 'admin',       title: 'Thank-you notes to volunteers & donors' },
  { off: 30,   phase: 'election_day',  category: 'finance',     title: 'File post-election campaign finance report' },
]

const defaultMilestoneForm = {
  title: '', notes: '', phase: 'planning', category: 'general',
  due_date: '', status: 'upcoming', candidate_id: '', election_id: '',
}

function autoStatus(m) {
  if (m.status === 'complete' || m.status === 'skipped') return m.status
  if (m.due_date && isPast(safeISO(m.due_date)) && !isToday(safeISO(m.due_date))) return 'overdue'
  return m.status
}

// ─────────────────────────────────────────────────────────────────────────────
// MilestoneRow — scannable list item with clear column layout
// ─────────────────────────────────────────────────────────────────────────────
function MilestoneRow({ milestone, onEdit, onDelete, onStatusChange, candidates, elections, deleting, phaseLabel }) {
  const computedStatus = autoStatus(milestone)
  const isComplete     = computedStatus === 'complete'
  const isOverdue      = computedStatus === 'overdue'
  const isInProgress   = computedStatus === 'in_progress'
  const isSkipped      = computedStatus === 'skipped'
  const isDeleting     = deleting === milestone.id
  const daysUntil = milestone.due_date
    ? differenceInCalendarDays(safeISO(milestone.due_date), new Date())
    : null
  const cand = candidates?.find(c => c.id === milestone.candidate_id)

  // Due date chip
  const dueDateChip = (() => {
    if (!milestone.due_date) return null
    if (isComplete) return { label: format(safeISO(milestone.due_date), 'MMM d'), cls: 'text-gray-400 bg-gray-50' }
    if (isToday(safeISO(milestone.due_date))) return { label: 'Today', cls: 'text-orange-700 bg-orange-50 font-semibold border border-orange-200' }
    if (daysUntil < 0) return { label: `${Math.abs(daysUntil)}d overdue`, cls: 'text-red-700 bg-red-50 font-semibold border border-red-200' }
    if (daysUntil <= 7)  return { label: `${daysUntil}d`, cls: 'text-orange-600 bg-orange-50 font-semibold border border-orange-200' }
    if (daysUntil <= 30) return { label: `${daysUntil}d`, cls: 'text-amber-700 bg-amber-50 border border-amber-200' }
    return { label: format(safeISO(milestone.due_date), 'MMM d'), cls: 'text-gray-500 bg-gray-50 border border-gray-200' }
  })()

  return (
    <div className={`group flex items-center gap-3 px-4 py-3 transition-colors ${
      isOverdue  ? 'bg-red-50/60 hover:bg-red-50' :
      isComplete ? 'hover:bg-gray-50/60' :
      'hover:bg-gray-50/70'
    } ${isDeleting ? 'opacity-40 pointer-events-none' : ''}`}>

      {/* Checkbox */}
      <button
        onClick={() => onStatusChange(milestone.id, isComplete ? 'upcoming' : 'complete')}
        className={`flex-shrink-0 w-[18px] h-[18px] rounded-full border-2 flex items-center justify-center transition-all ${
          isComplete   ? 'bg-green-500 border-green-500' :
          isOverdue    ? 'border-red-400 hover:border-red-500' :
          isInProgress ? 'border-yellow-400 hover:border-yellow-500' :
          'border-gray-300 hover:border-gray-400'
        }`}
        title={isComplete ? 'Mark incomplete' : 'Mark complete'}
      >
        {isComplete   && <Check className="w-2.5 h-2.5 text-white" strokeWidth={3} />}
        {isInProgress && <div className="w-1.5 h-1.5 rounded-full bg-yellow-400" />}
        {isOverdue    && !isComplete && <div className="w-1.5 h-1.5 rounded-full bg-red-400" />}
      </button>

      {/* Title — takes remaining width */}
      <span className={`flex-1 text-sm leading-snug min-w-0 truncate ${
        isComplete ? 'line-through text-gray-400' :
        isSkipped  ? 'text-gray-400 italic' :
        isOverdue  ? 'text-gray-900 font-medium' :
        'text-gray-800'
      }`}>
        {milestone.title}
      </span>

      {/* Right-side columns — fixed widths so they align */}
      <div className="flex items-center gap-2 flex-shrink-0">

        {/* Candidate tag */}
        {cand && (
          <span className="hidden lg:inline text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded truncate max-w-[100px]">
            {cand.name}
          </span>
        )}

        {/* Phase label (list view only) */}
        {phaseLabel && (
          <span className="hidden md:inline text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded">
            {phaseLabel}
          </span>
        )}

        {/* Status chip — only for non-default statuses */}
        {isInProgress && (
          <span className="text-xs font-medium text-yellow-700 bg-yellow-50 border border-yellow-200 px-2 py-0.5 rounded whitespace-nowrap">
            In progress
          </span>
        )}
        {isSkipped && (
          <span className="text-xs text-gray-400 bg-gray-50 border border-gray-200 px-2 py-0.5 rounded">
            Skipped
          </span>
        )}

        {/* Due date chip — fixed width column */}
        <div className="w-20 text-right">
          {dueDateChip && (
            <span className={`inline-block text-xs px-2 py-0.5 rounded whitespace-nowrap ${dueDateChip.cls}`}>
              {dueDateChip.label}
            </span>
          )}
        </div>
      </div>

      {/* Hover actions */}
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 w-14 justify-end">
        <button onClick={() => onEdit(milestone)} className="p-1 rounded hover:bg-white text-gray-400 hover:text-gray-700 transition-colors" title="Edit">
          <Edit2 className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => { if (window.confirm('Delete this milestone?')) onDelete(milestone.id) }}
          disabled={isDeleting}
          className="p-1 rounded hover:bg-white text-gray-400 hover:text-red-500 transition-colors"
          title="Delete"
        >
          {isDeleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
        </button>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// PhaseSection — clear header with real visual weight + scannable rows
// ─────────────────────────────────────────────────────────────────────────────
function PhaseSection({ phase, milestones, onEdit, onDelete, onStatusChange, candidates, elections, deletingMilestone, onAddToPhase, defaultOpen = true }) {
  const [open, setOpen]             = useState(defaultOpen)
  const [quickTitle, setQuickTitle] = useState('')
  const [quickDue,   setQuickDue]   = useState('')
  const [showQuick,  setShowQuick]  = useState(false)
  const [quickSaving, setQuickSaving] = useState(false)
  const quickRef = useRef(null)
  const PhaseIcon = phase.icon
  const total   = milestones.length
  const done    = milestones.filter(m => m.status === 'complete').length
  const overdue = milestones.filter(m => autoStatus(m) === 'overdue').length
  const pct     = total ? Math.round((done / total) * 100) : 0

  useEffect(() => { if (showQuick) quickRef.current?.focus() }, [showQuick])

  const handleQuickAdd = async (e) => {
    e?.preventDefault()
    if (!quickTitle.trim()) return
    setQuickSaving(true)
    await onAddToPhase({ title: quickTitle.trim(), phase: phase.key, due_date: quickDue || null, status: 'upcoming', category: 'general' })
    setQuickTitle(''); setQuickDue(''); setQuickSaving(false); setShowQuick(false)
  }

  const orderedMilestones = [
    ...milestones.filter(m => autoStatus(m) === 'overdue'),
    ...milestones.filter(m => autoStatus(m) === 'in_progress'),
    ...milestones.filter(m => autoStatus(m) === 'upcoming'),
    ...milestones.filter(m => ['complete','skipped'].includes(autoStatus(m))),
  ]

  return (
    <div className="border-b border-gray-100 last:border-b-0">
      {/* ── Phase header — colored left stripe, subtle bg, clear label ── */}
      <button
        onClick={() => setOpen(o => !o)}
        className={`w-full flex items-center gap-3 px-4 py-3 text-left border-l-4 ${phase.borderL} ${phase.headerBg} hover:brightness-95 transition-all`}
      >
        <PhaseIcon className={`w-4 h-4 flex-shrink-0 ${phase.text}`} />
        <span className={`text-sm font-bold ${phase.text} flex-shrink-0`}>{phase.label}</span>

        {overdue > 0 && (
          <span className="flex items-center gap-1 text-xs font-bold bg-red-500 text-white px-2 py-0.5 rounded-full">
            <AlertTriangle className="w-3 h-3" />{overdue} overdue
          </span>
        )}

        {total > 0 && (
          <div className="flex items-center gap-2 ml-1">
            <span className="text-xs text-gray-500 font-medium tabular-nums">{done}/{total}</span>
            <div className="w-16 h-1.5 bg-white/70 rounded-full overflow-hidden border border-white/50">
              <div
                className={`h-full rounded-full transition-all ${pct === 100 ? 'bg-green-500' : phase.progressBg}`}
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className={`text-xs font-semibold ${pct === 100 ? 'text-green-700' : phase.text}`}>{pct}%</span>
          </div>
        )}

        {total === 0 && <span className="text-xs text-gray-400 italic ml-1">No milestones</span>}

        <div className="ml-auto">
          {open
            ? <ChevronDown className={`w-4 h-4 ${phase.text} opacity-60`} />
            : <ChevronRight className={`w-4 h-4 ${phase.text} opacity-60`} />}
        </div>
      </button>

      {/* ── Rows ── */}
      {open && (
        <div className="divide-y divide-gray-100/80">
          {/* Column header — only when there are milestones */}
          {total > 0 && (
            <div className="flex items-center gap-3 px-4 py-1.5 bg-gray-50/50">
              <div className="w-[18px] flex-shrink-0" />
              <span className="flex-1 text-xs text-gray-400 font-medium uppercase tracking-wide">Milestone</span>
              <div className="flex items-center gap-2 flex-shrink-0">
                <div className="w-20 text-right">
                  <span className="text-xs text-gray-400 font-medium uppercase tracking-wide">Due</span>
                </div>
                <div className="w-14" />
              </div>
            </div>
          )}

          {orderedMilestones.length === 0 && !showQuick ? (
            <p className="text-xs text-gray-400 py-3 px-4 italic">Nothing added yet.</p>
          ) : (
            orderedMilestones.map(m => (
              <MilestoneRow
                key={m.id}
                milestone={m}
                onEdit={onEdit}
                onDelete={onDelete}
                onStatusChange={onStatusChange}
                candidates={candidates}
                elections={elections}
                deleting={deletingMilestone}
              />
            ))
          )}

          {/* Quick-add */}
          {showQuick ? (
            <form onSubmit={handleQuickAdd} className="flex items-center gap-3 px-4 py-2.5 bg-gray-50/50">
              <div className="w-[18px] h-[18px] rounded-full border-2 border-gray-300 flex-shrink-0" />
              <input
                ref={quickRef}
                value={quickTitle}
                onChange={e => setQuickTitle(e.target.value)}
                placeholder="Milestone title…"
                className="flex-1 text-sm outline-none bg-transparent text-gray-800 placeholder-gray-400"
                onKeyDown={e => { if (e.key === 'Escape') { setShowQuick(false); setQuickTitle(''); setQuickDue('') } }}
              />
              <input
                type="date"
                value={quickDue}
                onChange={e => setQuickDue(e.target.value)}
                className="text-xs text-gray-500 outline-none bg-white border border-gray-200 rounded px-2 py-1 w-32"
              />
              <button type="submit" disabled={!quickTitle.trim() || quickSaving} className="text-xs text-white bg-brand-red rounded px-2.5 py-1.5 font-medium disabled:opacity-40 transition-opacity">
                {quickSaving ? '…' : 'Add'}
              </button>
              <button type="button" onClick={() => { setShowQuick(false); setQuickTitle(''); setQuickDue('') }} className="p-1 text-gray-400 hover:text-gray-600">
                <X className="w-3.5 h-3.5" />
              </button>
            </form>
          ) : (
            <button
              onClick={() => setShowQuick(true)}
              className={`w-full flex items-center gap-2 px-4 py-2 text-xs text-gray-400 hover:text-gray-600 hover:${phase.headerBg} transition-colors`}
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Add to {phase.label}</span>
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// MilestoneModal — full edit form
// ─────────────────────────────────────────────────────────────────────────────
function MilestoneModal({ open, onClose, onSave, editing, candidates, elections, saving, saveError }) {
  const [form, setForm] = useState(defaultMilestoneForm)

  useEffect(() => {
    if (editing) {
      setForm({
        title:        editing.title || '',
        notes:        editing.notes || '',
        phase:        editing.phase || 'planning',
        category:     editing.category || 'general',
        due_date:     editing.due_date || '',
        status:       editing.status || 'upcoming',
        candidate_id: editing.candidate_id || '',
        election_id:  editing.election_id  || '',
      })
    } else {
      setForm(defaultMilestoneForm)
    }
  }, [editing, open])

  if (!open) return null
  const f = (k) => e => setForm(p => ({ ...p, [k]: e.target.value }))

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-black/40 backdrop-blur-[1px]" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-lg ring-1 ring-gray-200">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 className="text-base font-semibold text-gray-900">{editing ? 'Edit milestone' : 'New milestone'}</h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>
        <form onSubmit={e => { e.preventDefault(); onSave(form) }} className="p-6 space-y-4">
          <div>
            <label className="label">Title *</label>
            <input className="input" value={form.title} onChange={f('title')} placeholder="e.g. Nomination papers filed" required autoFocus />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">Phase *</label>
              <select className="input" value={form.phase} onChange={f('phase')}>
                {PHASES.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Category</label>
              <select className="input" value={form.category} onChange={f('category')}>
                {CATEGORIES.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">Due Date</label>
              <input className="input" type="date" value={form.due_date} onChange={f('due_date')} />
            </div>
            <div>
              <label className="label">Status</label>
              <select className="input" value={form.status} onChange={f('status')}>
                {STATUSES.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
              </select>
            </div>
          </div>

          {candidates.length > 0 && (
            <div>
              <label className="label">Candidate <span className="text-gray-400 font-normal">(optional)</span></label>
              <select className="input" value={form.candidate_id} onChange={f('candidate_id')}>
                <option value="">All candidates</option>
                {candidates.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
          )}

          {elections && elections.length > 0 && (
            <div>
              <label className="label">Election <span className="text-gray-400 font-normal">(optional)</span></label>
              <select className="input" value={form.election_id} onChange={f('election_id')}>
                <option value="">Not tied to a specific election</option>
                {elections.map(e => (
                  <option key={e.id} value={e.id}>
                    {e.name}{e.election_date ? ` · ${format(parseISO(e.election_date), 'MMM d, yyyy')}` : ''}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label className="label">Notes <span className="text-gray-400 font-normal">(optional)</span></label>
            <textarea className="input" rows={2} value={form.notes} onChange={f('notes')} placeholder="Any additional context..." />
          </div>

          {saveError && (
            <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{saveError}</p>
          )}

          <div className="flex gap-3 pt-1">
            <button type="button" onClick={saving ? undefined : onClose} disabled={saving} className="btn-secondary flex-1">Cancel</button>
            <button type="submit" className="btn-primary flex-1" disabled={saving}>
              {saving ? 'Saving…' : editing ? 'Save changes' : 'Add milestone'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// ElectionModal
// ─────────────────────────────────────────────────────────────────────────────
const defaultElectionForm = {
  name: '', election_date: '', filing_deadline: '', type: 'general',
  year: new Date().getFullYear(), notes: '',
}

function GeneratePlanModal({ open, onClose, onGenerate, generating, elections, candidates }) {
  const [electionId,  setElectionId]  = useState('')
  const [candidateId, setCandidateId] = useState('')

  useEffect(() => {
    if (open) {
      // default to the next upcoming election
      const next = [...elections]
        .filter(e => !isPast(parseISO(e.election_date)) || isToday(parseISO(e.election_date)))
        .sort((a, b) => parseISO(a.election_date) - parseISO(b.election_date))[0]
      setElectionId(next?.id || elections[0]?.id || '')
      setCandidateId('')
    }
  }, [open, elections])

  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-md">
        <div className="p-6 border-b border-gray-100">
          <h2 className="text-lg font-bold text-gray-900">Generate standard campaign plan</h2>
          <p className="text-sm text-gray-500 mt-1">
            Creates {PLAN_TEMPLATE.length} standard Wisconsin campaign milestones with due dates
            calculated from the election date. You can edit or delete any of them afterward.
          </p>
        </div>
        <div className="p-6 space-y-4">
          <div>
            <label className="label">Election *</label>
            <select className="input" value={electionId} onChange={e => setElectionId(e.target.value)}>
              {elections.length === 0 && <option value="">No elections — add one on the Calendar tab first</option>}
              {[...elections].sort((a, b) => parseISO(a.election_date) - parseISO(b.election_date)).map(e => (
                <option key={e.id} value={e.id}>
                  {e.name} — {format(parseISO(e.election_date), 'MMM d, yyyy')}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Candidate (optional)</label>
            <select className="input" value={candidateId} onChange={e => setCandidateId(e.target.value)}>
              <option value="">All / campaign-wide</option>
              {candidates.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <p className="text-xs text-gray-400">
            Dates are estimates based on a typical WI race calendar — filing windows and finance
            report deadlines vary by office. Always confirm with the WEC or your filing officer.
          </p>
        </div>
        <div className="p-6 pt-0 flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} className="btn-secondary text-sm">Cancel</button>
          <button
            type="button"
            disabled={!electionId || generating}
            onClick={() => onGenerate({ electionId, candidateId })}
            className="btn-primary text-sm flex items-center gap-2 disabled:opacity-50"
          >
            {generating && <Loader2 className="w-4 h-4 animate-spin" />}
            Generate {PLAN_TEMPLATE.length} milestones
          </button>
        </div>
      </div>
    </div>
  )
}

function ElectionModal({ open, onClose, editing, onSave, saving }) {
  const [form, setForm] = useState(defaultElectionForm)
  useEffect(() => {
    setForm(editing
      ? { name: editing.name, election_date: editing.election_date, filing_deadline: editing.filing_deadline || '', type: editing.type, year: editing.year, notes: editing.notes || '' }
      : defaultElectionForm)
  }, [editing, open])

  if (!open) return null
  const f = k => e => setForm(p => ({ ...p, [k]: e.target.value }))

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-black/40 backdrop-blur-[1px]" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-lg ring-1 ring-gray-200">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 className="text-base font-semibold text-gray-900">{editing ? 'Edit election' : 'Add election'}</h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-gray-100 text-gray-400 transition-colors"><X className="w-4 h-4" /></button>
        </div>
        <form onSubmit={e => { e.preventDefault(); onSave(form) }} className="p-6 space-y-4">
          <div>
            <label className="label">Election Name *</label>
            <input className="input" value={form.name} onChange={f('name')} placeholder="e.g. 2026 November General Election" required autoFocus />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">Election Date *</label>
              <input className="input" type="date" value={form.election_date} onChange={f('election_date')} required />
            </div>
            <div>
              <label className="label">Filing Deadline</label>
              <input className="input" type="date" value={form.filing_deadline} onChange={f('filing_deadline')} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">Type *</label>
              <select className="input" value={form.type} onChange={f('type')}>
                {Object.entries(ELECTION_TYPE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Year *</label>
              <input className="input" type="number" value={form.year} onChange={f('year')} min={2024} max={2035} required />
            </div>
          </div>
          <div>
            <label className="label">Notes</label>
            <textarea className="input" rows={2} value={form.notes} onChange={f('notes')} placeholder="Additional context…" />
          </div>
          <div className="flex gap-3 pt-1">
            <button type="button" onClick={onClose} className="btn-secondary flex-1">Cancel</button>
            <button type="submit" className="btn-primary flex-1" disabled={saving}>
              {saving ? 'Saving…' : editing ? 'Save changes' : 'Add election'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// ElectionRow
// ─────────────────────────────────────────────────────────────────────────────
function ElectionRow({ election, onEdit, onDelete, deleting, onViewResults, onViewMilestones, milestoneCount }) {
  const daysUntil  = differenceInDays(parseISO(election.election_date), new Date())
  const isUpcoming = isFuture(parseISO(election.election_date))
  const isOngoing  = isToday(parseISO(election.election_date))
  const colors     = ELECTION_TYPE_COLORS[election.type] || ELECTION_TYPE_COLORS.general

  return (
    <div className={`p-4 rounded-xl border-2 ${isUpcoming || isOngoing ? colors.border : 'border-gray-200'} ${isUpcoming || isOngoing ? 'bg-white' : 'bg-gray-50'} transition-all hover:shadow-sm`}>
      <div className="flex items-start gap-4">
        <div className={`${isUpcoming || isOngoing ? colors.bg : 'bg-gray-400'} text-white rounded-xl p-3 text-center min-w-[60px] flex-shrink-0`}>
          <p className="text-xs font-medium opacity-80">{format(parseISO(election.election_date), 'MMM')}</p>
          <p className="text-2xl font-bold leading-tight">{format(parseISO(election.election_date), 'd')}</p>
          <p className="text-xs opacity-80">{format(parseISO(election.election_date), 'yyyy')}</p>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h3 className={`font-bold ${isUpcoming || isOngoing ? 'text-gray-900' : 'text-gray-500'}`}>{election.name}</h3>
              <div className="flex items-center gap-2 mt-1 flex-wrap">
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${colors.light}`}>
                  {ELECTION_TYPE_LABELS[election.type] || election.type}
                </span>
                {isOngoing && (
                  <span className="flex items-center gap-1 text-xs font-bold text-red-600">
                    <span className="relative flex h-2 w-2">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500" />
                    </span>
                    Election Night
                  </span>
                )}
                {isUpcoming && !isOngoing && (
                  <span className={`flex items-center gap-1 text-xs font-semibold ${daysUntil <= 30 ? 'text-brand-red' : daysUntil <= 90 ? 'text-orange-600' : 'text-gray-500'}`}>
                    <Clock className="w-3 h-3" />
                    {daysUntil === 0 ? 'Today!' : `${daysUntil} days away`}
                  </span>
                )}
                {!isUpcoming && !isOngoing && (
                  <span className="flex items-center gap-1 text-xs text-gray-400">
                    <CheckCircle className="w-3 h-3" /> Completed
                  </span>
                )}
              </div>
            </div>
            <div className="flex items-center gap-1 flex-shrink-0">
              {milestoneCount > 0 && onViewMilestones && (
                <button onClick={() => onViewMilestones(election.id)} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold transition-colors bg-purple-50 text-purple-700 hover:bg-purple-600 hover:text-white">
                  <Target className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">Milestones ({milestoneCount})</span>
                  <span className="sm:hidden">{milestoneCount}</span>
                </button>
              )}
              <button onClick={() => onViewResults(election.id)} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold transition-colors bg-brand-red/10 text-brand-red hover:bg-brand-red hover:text-white">
                <BarChart2 className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Results</span>
              </button>
              <button onClick={() => onEdit(election)} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-700 transition-colors">
                <Edit2 className="w-4 h-4" />
              </button>
              <button onClick={() => { if (window.confirm('Delete this election?')) onDelete(election.id) }} disabled={deleting === election.id} className="p-1.5 rounded-lg hover:bg-red-50 text-gray-400 hover:text-brand-red transition-colors">
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mt-3">
            {election.filing_deadline && (
              <div>
                <p className="text-xs text-gray-400 font-medium">Filing Deadline</p>
                <p className={`text-sm font-semibold ${isPast(parseISO(election.filing_deadline)) ? 'text-gray-400' : 'text-brand-red'}`}>
                  {format(parseISO(election.filing_deadline), 'MMM d, yyyy')}
                </p>
              </div>
            )}
            <div>
              <p className="text-xs text-gray-400 font-medium">Election Date</p>
              <p className="text-sm font-semibold text-gray-900">{format(parseISO(election.election_date), 'EEEE, MMMM d, yyyy')}</p>
            </div>
          </div>
          {election.notes && (() => {
            try { const p = JSON.parse(election.notes); if (p.results) return null } catch {}
            return <p className="text-xs text-gray-400 mt-2 italic">{election.notes}</p>
          })()}
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Main GamePlan component
// ─────────────────────────────────────────────────────────────────────────────
export default function GamePlan() {
  const [searchParams, setSearchParams] = useSearchParams()
  const activeTab = searchParams.get('tab') || 'milestones'

  const _rawElection = searchParams.get('election')
  const selectedResultsId = (_rawElection && _rawElection !== 'null' && _rawElection !== 'undefined')
    ? _rawElection : null

  // ── Milestone state ───────────────────────────────────────────────────────
  const [milestones,        setMilestones]       = useState([])
  const [candidates,        setCandidates]       = useState([])
  const [loading,           setLoading]          = useState(true)
  const [milestoneError,    setMilestoneError]   = useState(null)
  const [showMilestone,     setShowMilestone]    = useState(false)
  const [editing,           setEditing]          = useState(null)
  const [saving,            setSaving]           = useState(false)
  const [saveError,         setSaveError]        = useState(null)
  const [deletingMilestone, setDeletingMilestone]= useState(null)
  const [milestoneView,     setMilestoneView]    = useState('phase') // 'phase' | 'list'
  const [filterCand,        setFilterCand]       = useState('')
  const [filterStatus,      setFilterStatus]     = useState('')
  const [filterElection,    setFilterElection]   = useState('')
  const priorStatusRef = useRef({})

  // ── Elections state ───────────────────────────────────────────────────────
  const [elections,     setElections]    = useState([])
  const [electLoading,  setElectLoading] = useState(true)
  const [showElect,     setShowElect]    = useState(false)
  const [editingElect,  setEditingElect] = useState(null)
  const [electSaving,   setElectSaving]  = useState(false)
  const [electError,    setElectError]   = useState(null)
  const [deleting,      setDeleting]     = useState(null)
  const [yearFilter,    setYearFilter]   = useState(String(new Date().getFullYear()))

  // ── Load data ─────────────────────────────────────────────────────────────
  useEffect(() => { fetchAll() }, [])

  const fetchAll = async () => {
    try {
      const [mRes, cRes, eRes] = await Promise.all([getMilestones(), getCandidates(), getElections()])
      setMilestones(mRes.data || [])
      setCandidates(cRes.data || [])
      setElections(eRes.data || [])
    } catch (err) {
      console.error('fetchAll error:', err)
    } finally {
      setLoading(false)
      setElectLoading(false)
    }
  }

  const fetchMilestones = async () => {
    const { data, error } = await getMilestones()
    if (!error) setMilestones(data || [])
  }

  const fetchElections = async () => {
    setElectLoading(true)
    const { data } = await getElections()
    setElections(data || [])
    setElectLoading(false)
  }

  const goToTab     = (t)  => setSearchParams(t === 'milestones' ? {} : { tab: t })
  const goToResults = (id) => {
    const params = { tab: 'results' }
    if (id && id !== 'null' && id !== 'undefined') params.election = id
    setSearchParams(params)
  }

  // ── Milestone CRUD ────────────────────────────────────────────────────────
  const [showGenerate, setShowGenerate] = useState(false)
  const [generating,   setGenerating]   = useState(false)

  const hasTemplateMilestones = milestones.some(m => m.is_template)

  const handleGeneratePlan = async ({ electionId, candidateId }) => {
    const election = elections.find(e => e.id === electionId)
    if (!election?.election_date) return
    setGenerating(true)
    try {
      const base = parseISO(election.election_date)
      const rows = PLAN_TEMPLATE.map(t => {
        const d = new Date(base)
        d.setDate(d.getDate() + t.off)
        return {
          title: t.title,
          phase: t.phase,
          category: t.category,
          due_date: d.toISOString().slice(0, 10),
          status: 'upcoming',
          election_id: electionId,
          candidate_id: candidateId || null,
          is_template: true,
          notes: 'Generated from the standard WI campaign plan — adjust dates to your race. Filing deadlines vary by office; always confirm with your filing officer.',
        }
      })
      const { error } = await createMilestoneBatch(rows)
      if (error) throw error
      await fetchMilestones()
      setShowGenerate(false)
    } catch (err) {
      console.error('[GamePlan] generate plan failed:', err)
      setSaveError(err.message || 'Failed to generate plan')
    } finally {
      setGenerating(false)
    }
  }

  const handleRemoveGenerated = async () => {
    if (!window.confirm('Remove all generated plan milestones? Milestones you added manually are kept.')) return
    await deleteTemplateMilestones()
    fetchMilestones()
  }

  const openAdd  = ()  => { setEditing(null); setSaveError(null); setShowMilestone(true) }
  const openEdit = (m) => { setEditing(m); setSaveError(null); setShowMilestone(true) }

  const handleSaveMilestone = async (form) => {
    setSaving(true); setSaveError(null)
    const payload = {
      title: form.title, notes: form.notes || null, phase: form.phase,
      category: form.category, due_date: form.due_date || null,
      status: form.status, candidate_id: form.candidate_id || null,
      election_id: form.election_id || null,
    }
    const { error } = editing
      ? await updateMilestone(editing.id, payload)
      : await createMilestone(payload)
    setSaving(false)
    if (error) { setSaveError('Failed to save milestone. Please try again.'); return }
    setShowMilestone(false)
    await fetchMilestones()
  }

  // Quick-add (from inline form in phase section)
  const handleQuickAdd = async (partial) => {
    const payload = {
      title: partial.title, phase: partial.phase,
      status: 'upcoming', category: partial.category || 'general',
      due_date: partial.due_date || null,
      notes: null, candidate_id: null, election_id: null,
    }
    await createMilestone(payload)
    await fetchMilestones()
  }

  const handleDelete = async (id) => {
    setDeletingMilestone(id)
    const { error } = await deleteMilestone(id)
    setDeletingMilestone(null)
    if (!error) await fetchMilestones()
  }

  const handleStatusChange = async (id, newStatus) => {
    if (newStatus === 'complete') {
      const current = milestones.find(m => m.id === id)
      if (current) priorStatusRef.current[id] = current.status
    }
    let resolvedStatus = newStatus
    if (newStatus !== 'complete' && priorStatusRef.current[id]) {
      resolvedStatus = priorStatusRef.current[id]
      delete priorStatusRef.current[id]
    }
    setMilestones(prev => prev.map(m => m.id === id ? { ...m, status: resolvedStatus } : m))
    const { error } = await updateMilestone(id, { status: resolvedStatus })
    if (error) await fetchMilestones()
  }

  const goToMilestonesForElection = (electionId) => {
    setFilterElection(electionId); setFilterCand(''); setFilterStatus(''); goToTab('milestones')
  }

  // ── Elections CRUD ────────────────────────────────────────────────────────
  const handleSaveElection = async (form) => {
    setElectSaving(true); setElectError(null)
    const payload = { ...form, year: parseInt(form.year), filing_deadline: form.filing_deadline || null }
    const { error } = editingElect
      ? await updateElection(editingElect.id, payload)
      : await createElection(payload)
    setElectSaving(false)
    if (error) { setElectError('Failed to save election.'); return }
    setEditingElect(null); setShowElect(false); fetchElections()
  }

  const handleDeleteElection = async (id) => {
    setDeleting(id)
    const { error } = await deleteElection(id)
    setDeleting(null)
    if (error) { console.error('Delete election error:', error); return }
    fetchElections()
  }

  // ── Derived ───────────────────────────────────────────────────────────────
  const filtered = useMemo(() => milestones.filter(m => {
    if (filterCand     && m.candidate_id !== filterCand)     return false
    if (filterStatus   && autoStatus(m)  !== filterStatus)   return false
    if (filterElection && m.election_id  !== filterElection) return false
    return true
  }), [milestones, filterCand, filterStatus, filterElection])

  const byPhase = useMemo(() =>
    Object.fromEntries(PHASES.map(p => [p.key, filtered.filter(m => m.phase === p.key)]))
  , [filtered])

  const totalComplete = milestones.filter(m => m.status === 'complete').length
  const totalOverdue  = milestones.filter(m => autoStatus(m) === 'overdue').length
  const pctComplete   = milestones.length ? Math.round((totalComplete / milestones.length) * 100) : 0

  // Next upcoming deadline
  const nextDue = useMemo(() => {
    const upcoming = milestones
      .filter(m => m.due_date && autoStatus(m) !== 'complete' && autoStatus(m) !== 'skipped')
      .sort((a, b) => a.due_date.localeCompare(b.due_date))
    return upcoming[0] || null
  }, [milestones])

  const hasTodayElection = elections.some(e => isToday(parseISO(e.election_date)))
  const years            = [...new Set(elections.map(e => e.year))].sort()
  const filteredElect    = yearFilter ? elections.filter(e => String(e.year) === String(yearFilter)) : elections
  const upcoming         = filteredElect.filter(e => isFuture(parseISO(e.election_date)) || isToday(parseISO(e.election_date)))
  const past             = filteredElect.filter(e => isPast(parseISO(e.election_date)) && !isToday(parseISO(e.election_date)))
                             .sort((a, b) => parseISO(b.election_date) - parseISO(a.election_date))
  const resolvedResultsId = selectedResultsId
    || elections.find(e => isToday(parseISO(e.election_date)))?.id
    || [...elections].filter(e => isPast(parseISO(e.election_date))).sort((a, b) => parseISO(b.election_date) - parseISO(a.election_date))[0]?.id
    || null

  const hasFilters = !!(filterCand || filterStatus || filterElection)

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-5">
      <LoadingBar loading={loading} />

      {/* ── Page header ── */}
      <div className="flex items-center gap-4">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Game Plan</h1>
          <p className="text-gray-400 text-sm mt-0.5">Campaign tasks &amp; election calendar</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {activeTab === 'calendar' && (
            <button onClick={() => { setEditingElect(null); setShowElect(true) }} className="btn-primary flex items-center gap-2 text-sm">
              <Plus className="w-4 h-4" /> Add election
            </button>
          )}
        </div>
      </div>

      {/* ── Tab bar ── */}
      <div className="flex gap-0 border-b border-gray-200">
        {[
          { key: 'milestones', label: 'Tasks', Icon: Target },
          { key: 'calendar',   label: 'Calendar',   Icon: CalendarDays },
          { key: 'results',    label: 'Results',     Icon: BarChart2, live: hasTodayElection },
        ].map(({ key, label, Icon, live }) => (
          <button
            key={key}
            onClick={() => key === 'results' ? goToResults(resolvedResultsId) : goToTab(key)}
            className={`flex items-center gap-2 px-5 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px ${
              activeTab === key
                ? 'border-brand-red text-brand-red'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
            }`}
          >
            <Icon className="w-4 h-4" />
            {label}
            {live && (
              <span className="relative flex h-2 w-2 ml-0.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500" />
              </span>
            )}
          </button>
        ))}
      </div>

      {/* ══════════════════════════════════════════════════════════ */}
      {/* TASKS TAB — Todoist-style task manager                    */}
      {/* ══════════════════════════════════════════════════════════ */}
      {/* Kept mounted across tab switches so the board doesn't refetch on every flip */}
      <div className={activeTab === 'milestones' ? '' : 'hidden'}>
        <TaskBoard />
      </div>

      {/* ══════════════════════════════════════════════════════════ */}
      {/* CALENDAR TAB                                             */}
      {/* ══════════════════════════════════════════════════════════ */}
      {activeTab === 'calendar' && (
        <>
          {hasTodayElection && (() => {
            const todayEl = elections.find(e => isToday(parseISO(e.election_date)))
            return (
              <button
                onClick={() => goToResults(todayEl?.id)}
                className="w-full rounded-xl bg-brand-navy text-white p-4 flex items-center justify-between gap-4 hover:bg-brand-navy/90 transition-colors text-left"
              >
                <div className="flex items-center gap-3">
                  <span className="relative flex h-3 w-3 flex-shrink-0">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
                    <span className="relative inline-flex rounded-full h-3 w-3 bg-red-500" />
                  </span>
                  <div>
                    <p className="font-bold text-sm">Election Night — Live Results</p>
                    <p className="text-xs text-white/70">Results updating automatically via WEC · Click to open the live board</p>
                  </div>
                </div>
                <BarChart2 className="w-5 h-5 text-white/60 flex-shrink-0" />
              </button>
            )
          })()}

          {years.length > 1 && (
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs text-gray-500 font-medium">Year:</span>
              <button onClick={() => setYearFilter('')} className={`text-xs px-3 py-1 rounded-full font-medium transition-colors ${!yearFilter ? 'bg-brand-red text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>All</button>
              {years.map(y => (
                <button key={y} onClick={() => setYearFilter(String(y))} className={`text-xs px-3 py-1 rounded-full font-medium transition-colors ${String(yearFilter) === String(y) ? 'bg-brand-red text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>{y}</button>
              ))}
            </div>
          )}

          {electLoading ? (
            <div className="flex items-center justify-center py-20">
              <div className="w-7 h-7 border-2 border-brand-red border-t-transparent rounded-full animate-spin" />
            </div>
          ) : (
            <div className="space-y-6">
              {upcoming.length > 0 && (
                <div>
                  <div className="flex items-center gap-2 mb-3">
                    <AlertCircle className="w-4 h-4 text-brand-red" />
                    <h2 className="text-sm font-bold text-gray-900">Upcoming</h2>
                    <span className="text-xs bg-brand-red text-white px-2 py-0.5 rounded-full">{upcoming.length}</span>
                  </div>
                  <div className="space-y-3">
                    {upcoming.map(e => <ElectionRow key={e.id} election={e} onEdit={el => { setEditingElect(el); setShowElect(true) }} onDelete={handleDeleteElection} deleting={deleting} onViewResults={goToResults} onViewMilestones={goToMilestonesForElection} milestoneCount={milestones.filter(m => m.election_id === e.id).length} />)}
                  </div>
                </div>
              )}
              {past.length > 0 && (
                <div>
                  <div className="flex items-center gap-2 mb-3">
                    <CheckCircle className="w-4 h-4 text-gray-400" />
                    <h2 className="text-sm font-bold text-gray-500">Past Elections</h2>
                    <span className="text-xs bg-gray-200 text-gray-600 px-2 py-0.5 rounded-full">{past.length}</span>
                  </div>
                  <div className="space-y-3">
                    {past.map(e => <ElectionRow key={e.id} election={e} onEdit={el => { setEditingElect(el); setShowElect(true) }} onDelete={handleDeleteElection} deleting={deleting} onViewResults={goToResults} onViewMilestones={goToMilestonesForElection} milestoneCount={milestones.filter(m => m.election_id === e.id).length} />)}
                  </div>
                </div>
              )}
              {filteredElect.length === 0 && (
                <div className="text-center py-16 border-2 border-dashed border-gray-200 rounded-2xl">
                  <CalendarDays className="w-10 h-10 text-gray-300 mx-auto mb-3" />
                  {elections.length > 0 && yearFilter ? (
                    <>
                      <p className="text-gray-500 font-medium text-sm">No elections in {yearFilter}</p>
                      <button onClick={() => setYearFilter('')} className="btn-secondary text-sm mt-4">Show all years</button>
                    </>
                  ) : (
                    <>
                      <p className="text-gray-500 font-medium text-sm mb-1">No elections added yet</p>
                      <p className="text-gray-400 text-sm mb-4">Add elections to track filing deadlines and results</p>
                      <button onClick={() => { setEditingElect(null); setShowElect(true) }} className="btn-primary text-sm">Add first election</button>
                    </>
                  )}
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* ══════════════════════════════════════════════════════════ */}
      {/* RESULTS TAB                                              */}
      {/* ══════════════════════════════════════════════════════════ */}
      {activeTab === 'results' && (
        <ElectionResultsBoard
          elections={elections}
          selectedId={resolvedResultsId}
          onSelectElection={goToResults}
        />
      )}

      {/* ── Modals ── */}
      <ElectionModal
        open={showElect}
        onClose={() => { if (!electSaving) { setEditingElect(null); setShowElect(false) } }}
        editing={editingElect}
        onSave={handleSaveElection}
        saving={electSaving}
      />
    </div>
  )
}
