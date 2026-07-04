// ─── TaskBoard — Todoist-style task manager for the Game Plan tab ─────────────
// Projects → sections → tasks. Subtasks, p1–p4 priorities, labels, Quick Add
// with #project @label p1 + natural-language dates, Today/Upcoming/Inbox views,
// List + Board layouts, completed history, WI campaign plan template generator.

import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  format, parseISO, isToday, isPast, addDays, differenceInCalendarDays,
} from 'date-fns'
import {
  Plus, Calendar, CalendarDays, Inbox, CheckCircle2, Circle, Flag, Tag,
  Hash, ChevronDown, ChevronRight, X, Trash2, Edit2, Loader2, LayoutGrid,
  List as ListIcon, Sun, RotateCcw, Sparkles, MoreHorizontal, GripVertical,
  AlertCircle, Star,
} from 'lucide-react'
import {
  getTaskProjects, createTaskProject, updateTaskProject, deleteTaskProject,
  getTaskSections, createTaskSection, updateTaskSection, deleteTaskSection,
  getTasks, getCompletedTasks, createTask, updateTask, deleteTask,
  getTaskLabels, createTaskLabel, deleteTaskLabel,
  getTaskPlanOwners, getElections,
} from '../lib/supabase'
import { parseQuickAdd } from '../lib/quickAdd'
import LoadingBar from './LoadingBar'

// ── Constants ─────────────────────────────────────────────────────────────────

export const PRIORITIES = [
  { p: 1, label: 'Priority 1', flag: 'text-red-600',    ring: 'border-red-500',    fill: 'bg-red-100'    },
  { p: 2, label: 'Priority 2', flag: 'text-orange-500', ring: 'border-orange-400', fill: 'bg-orange-100' },
  { p: 3, label: 'Priority 3', flag: 'text-blue-600',   ring: 'border-blue-500',   fill: 'bg-blue-100'   },
  { p: 4, label: 'Priority 4', flag: 'text-gray-400',   ring: 'border-gray-300',   fill: 'bg-gray-100'   },
]
const PRI = Object.fromEntries(PRIORITIES.map(x => [x.p, x]))

export const PROJECT_COLORS = [
  '#8B0000', '#DB4035', '#FF9933', '#FAD000', '#7ECC49',
  '#299438', '#14AAF5', '#4073FF', '#884DFF', '#EB96EB',
  '#808080', '#0A1628',
]

// WI campaign plan template (offsets = days relative to election day)
const PLAN_TEMPLATE = [
  { off: -300, phase: 'Planning',      label: 'legal',       title: 'Confirm eligibility & residency requirements' },
  { off: -285, phase: 'Planning',      label: 'recruitment', title: 'Recruit campaign leadership (manager, treasurer)' },
  { off: -275, phase: 'Planning',      label: 'admin',       title: 'Open dedicated campaign bank account' },
  { off: -265, phase: 'Planning',      label: null,          title: 'Draft campaign plan, message & budget' },
  { off: -255, phase: 'Filing',        label: 'legal',       title: 'Register campaign committee (CF-1) with the WEC / filing officer' },
  { off: -240, phase: 'Fundraising',   label: 'finance',     title: 'Launch initial fundraising push (early money)' },
  { off: -210, phase: 'Filing',        label: 'legal',       title: 'Begin circulating nomination papers' },
  { off: -180, phase: 'Voter Contact', label: 'outreach',    title: 'Build voter universe & targeting lists' },
  { off: -155, phase: 'Filing',        label: 'legal',       title: 'File nomination papers & declaration of candidacy' },
  { off: -145, phase: 'Filing',        label: 'legal',       title: 'Confirm ballot access with filing officer' },
  { off: -120, phase: 'Voter Contact', label: 'outreach',    title: 'Launch door-to-door canvassing program' },
  { off: -90,  phase: 'Fundraising',   label: 'finance',     title: 'File pre-primary campaign finance report' },
  { off: -75,  phase: 'Voter Contact', label: 'outreach',    title: 'Distribute yard signs & field materials' },
  { off: -60,  phase: 'Voter Contact', label: 'media',       title: 'Direct mail round 1 + digital ads live' },
  { off: -21,  phase: 'GOTV',          label: 'outreach',    title: 'Absentee & early-vote push begins' },
  { off: -8,   phase: 'Fundraising',   label: 'finance',     title: 'File pre-election campaign finance report' },
  { off: -3,   phase: 'GOTV',          label: 'outreach',    title: 'GOTV weekend canvass & phone blitz' },
  { off: 0,    phase: 'Election Day',  label: 'admin',       title: 'Election Day — turnout tracking & poll coverage' },
  { off: 14,   phase: 'Election Day',  label: 'admin',       title: 'Thank-you notes to volunteers & donors' },
  { off: 30,   phase: 'Election Day',  label: 'finance',     title: 'File post-election campaign finance report' },
]
const PHASE_ORDER = ['Planning', 'Filing', 'Voter Contact', 'Fundraising', 'GOTV', 'Election Day']

// ── Small helpers ─────────────────────────────────────────────────────────────

const todayStr = () => format(new Date(), 'yyyy-MM-dd')

function dueMeta(dateStr) {
  if (!dateStr) return null
  const d = parseISO(dateStr)
  const diff = differenceInCalendarDays(d, new Date())
  if (diff === 0)  return { label: 'Today',    cls: 'text-green-700 bg-green-50 border-green-200' }
  if (diff === 1)  return { label: 'Tomorrow', cls: 'text-amber-700 bg-amber-50 border-amber-200' }
  if (diff < 0)    return { label: `${format(d, 'MMM d')} · ${Math.abs(diff)}d overdue`, cls: 'text-red-700 bg-red-50 border-red-200 font-semibold' }
  if (diff <= 7)   return { label: format(d, 'EEEE'),  cls: 'text-purple-700 bg-purple-50 border-purple-200' }
  return { label: format(d, 'MMM d'), cls: 'text-gray-500 bg-gray-50 border-gray-200' }
}

// ── Priority checkbox ─────────────────────────────────────────────────────────
function TaskCheck({ task, onToggle }) {
  const pri = PRI[task.priority] || PRI[4]
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onToggle(task) }}
      title={task.completed ? 'Reopen task' : 'Complete task'}
      className={`w-[18px] h-[18px] mt-0.5 rounded-full border-2 flex-shrink-0 flex items-center justify-center transition-all
        ${pri.ring} ${task.completed ? pri.fill : `${pri.fill} bg-opacity-30 hover:bg-opacity-100`}`}
    >
      {task.completed && <CheckCircle2 className={`w-3.5 h-3.5 ${pri.flag}`} />}
    </button>
  )
}

// ── Label chip ────────────────────────────────────────────────────────────────
function LabelChip({ name, onClick, small }) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-0.5 ${small ? 'text-[10px] px-1.5 py-px' : 'text-xs px-2 py-0.5'}
        rounded-full bg-brand-navy/5 text-brand-navy/70 hover:bg-brand-navy/10 transition-colors`}
    >
      <Tag className="w-2.5 h-2.5" />{name}
    </button>
  )
}

// ── Task row (list views) ─────────────────────────────────────────────────────
function TaskRow({ task, subtasks = [], projects, onToggle, onOpen, onDelete, showProject,
                   draggable, onDragStart, onDropOn }) {
  const [expanded, setExpanded] = useState(true)
  const due = dueMeta(task.due_date)
  const project = projects.find(p => p.id === task.project_id)
  const openSubs = subtasks.filter(s => !s.completed)

  return (
    <div>
      <div
        draggable={draggable}
        onDragStart={(e) => {
          e.stopPropagation()
          e.dataTransfer.setData('text/plain', task.id)
          e.dataTransfer.effectAllowed = 'move'
          onDragStart?.(task)
        }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); e.stopPropagation(); onDropOn?.(task) }}
        onClick={() => onOpen(task)}
        className="group flex items-start gap-2.5 px-3 py-2.5 rounded-lg hover:bg-gray-50 cursor-pointer border-b border-gray-100 last:border-b-0"
      >
        {draggable && (
          <GripVertical className="w-3.5 h-3.5 mt-1 text-gray-300 opacity-0 group-hover:opacity-100 cursor-grab flex-shrink-0" />
        )}
        {subtasks.length > 0 ? (
          <button
            onClick={(e) => { e.stopPropagation(); setExpanded(x => !x) }}
            className="mt-0.5 -ml-1 text-gray-400 hover:text-gray-600 flex-shrink-0"
          >
            {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          </button>
        ) : null}
        <TaskCheck task={task} onToggle={onToggle} />
        <div className="flex-1 min-w-0">
          <p className={`text-sm leading-snug ${task.completed ? 'line-through text-gray-400' : 'text-gray-900'}`}>
            {task.content}
          </p>
          {task.description && (
            <p className="text-xs text-gray-400 truncate mt-0.5">{task.description}</p>
          )}
          {(due || task.labels?.length > 0 || subtasks.length > 0 || (showProject && project)) && (
            <div className="flex items-center flex-wrap gap-1.5 mt-1">
              {due && (
                <span className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-px rounded border ${due.cls}`}>
                  <Calendar className="w-2.5 h-2.5" />{due.label}
                </span>
              )}
              {subtasks.length > 0 && (
                <span className="text-[10px] text-gray-400">
                  {subtasks.length - openSubs.length}/{subtasks.length}
                </span>
              )}
              {task.labels?.map(l => <LabelChip key={l} name={l} small />)}
              {showProject && project && (
                <span className="inline-flex items-center gap-1 text-[10px] text-gray-400 ml-auto">
                  {project.name}
                  <span className="w-2 h-2 rounded-full" style={{ backgroundColor: project.color }} />
                </span>
              )}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
          <button onClick={(e) => { e.stopPropagation(); onOpen(task) }}
            className="p-1.5 text-gray-400 hover:text-brand-navy hover:bg-gray-100 rounded" title="Edit">
            <Edit2 className="w-3.5 h-3.5" />
          </button>
          <button onClick={(e) => { e.stopPropagation(); onDelete(task) }}
            className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded" title="Delete">
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
      {expanded && subtasks.length > 0 && (
        <div className="ml-10 border-l border-gray-100">
          {subtasks.map(s => (
            <div key={s.id}
              onClick={() => onOpen(s)}
              className="group flex items-start gap-2.5 px-3 py-1.5 hover:bg-gray-50 cursor-pointer">
              <TaskCheck task={s} onToggle={onToggle} />
              <p className={`text-[13px] flex-1 min-w-0 ${s.completed ? 'line-through text-gray-400' : 'text-gray-700'}`}>
                {s.content}
              </p>
              <button onClick={(e) => { e.stopPropagation(); onDelete(s) }}
                className="p-1 text-gray-300 hover:text-red-500 opacity-0 group-hover:opacity-100">
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Quick Add bar ─────────────────────────────────────────────────────────────
function QuickAdd({ projects, context, onAdd, autoFocus }) {
  const [value, setValue]   = useState('')
  const [saving, setSaving] = useState(false)
  const inputRef = useRef(null)

  const submit = async () => {
    if (saving) return
    const parsed = parseQuickAdd(value, projects)
    if (!parsed.content) return
    setSaving(true)
    const ok = await onAdd(parsed)
    setSaving(false)
    if (ok !== false) setValue('')
    inputRef.current?.focus()
  }

  return (
    <div className="border border-gray-200 rounded-xl px-3 py-2 flex items-center gap-2 bg-white focus-within:border-brand-red/50 focus-within:ring-2 focus-within:ring-brand-red/10">
      <Plus className="w-4 h-4 text-brand-red flex-shrink-0" />
      <input
        ref={inputRef}
        autoFocus={autoFocus}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
        placeholder={`Add a task${context ? ` to ${context}` : ''} — try "Call donors tomorrow p1 @finance"`}
        className="flex-1 text-sm outline-none placeholder:text-gray-400 bg-transparent"
      />
      {saving
        ? <Loader2 className="w-4 h-4 text-gray-400 animate-spin" />
        : value.trim() && (
          <button onClick={submit} className="text-xs font-bold text-white bg-brand-red hover:bg-red-700 px-3 py-1 rounded-lg">
            Add
          </button>
        )}
    </div>
  )
}

// ── Task detail modal ─────────────────────────────────────────────────────────
function TaskDetailModal({ task, tasks, projects, sections, labels, onClose, onSave, onDelete, onToggle, onAddSub }) {
  const [content, setContent]         = useState(task.content)
  const [description, setDescription] = useState(task.description || '')
  const [dueDate, setDueDate]         = useState(task.due_date || '')
  const [priority, setPriority]       = useState(task.priority)
  const [projectId, setProjectId]     = useState(task.project_id || '')
  const [sectionId, setSectionId]     = useState(task.section_id || '')
  const [taskLabels, setTaskLabels]   = useState(task.labels || [])
  const [newLabel, setNewLabel]       = useState('')
  const [newSub, setNewSub]           = useState('')
  const [saving, setSaving]           = useState(false)

  const subtasks = tasks.filter(t => t.parent_id === task.id)
  const projectSections = sections.filter(s => s.project_id === projectId)

  const save = async () => {
    if (!content.trim()) return
    setSaving(true)
    await onSave(task.id, {
      content: content.trim(),
      description: description.trim() || null,
      due_date: dueDate || null,
      priority,
      project_id: projectId || null,
      section_id: (projectId && projectSections.some(s => s.id === sectionId)) ? sectionId : null,
      labels: taskLabels,
    })
    setSaving(false)
    onClose()
  }

  const addLabel = (name) => {
    const l = name.trim().toLowerCase().replace(/\s+/g, '-')
    if (l && !taskLabels.includes(l)) setTaskLabels([...taskLabels, l])
    setNewLabel('')
  }

  const addSub = async () => {
    if (!newSub.trim()) return
    await onAddSub(task, newSub.trim())
    setNewSub('')
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[8vh]" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[80vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-start gap-3 p-5 border-b border-gray-100">
          <TaskCheck task={task} onToggle={(t) => { onToggle(t); onClose() }} />
          <div className="flex-1 min-w-0">
            <input
              value={content}
              onChange={(e) => setContent(e.target.value)}
              className="w-full text-base font-semibold text-gray-900 outline-none"
              placeholder="Task name"
            />
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder="Description"
              className="w-full text-sm text-gray-600 outline-none mt-1 resize-none placeholder:text-gray-300"
            />
          </div>
          <button onClick={onClose} className="p-1.5 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 grid grid-cols-1 sm:grid-cols-2 gap-4">
          {/* Project / section */}
          <div>
            <label className="text-[11px] font-bold text-gray-400 uppercase tracking-wider">Project</label>
            <select value={projectId} onChange={(e) => { setProjectId(e.target.value); setSectionId('') }}
              className="mt-1 w-full text-sm border border-gray-200 rounded-lg px-2.5 py-2 bg-white">
              <option value="">Inbox</option>
              {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            {projectSections.length > 0 && (
              <select value={sectionId || ''} onChange={(e) => setSectionId(e.target.value)}
                className="mt-2 w-full text-sm border border-gray-200 rounded-lg px-2.5 py-2 bg-white">
                <option value="">No section</option>
                {projectSections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            )}
          </div>

          {/* Due date + priority */}
          <div>
            <label className="text-[11px] font-bold text-gray-400 uppercase tracking-wider">Due date</label>
            <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)}
              className="mt-1 w-full text-sm border border-gray-200 rounded-lg px-2.5 py-2" />
            <label className="block text-[11px] font-bold text-gray-400 uppercase tracking-wider mt-3">Priority</label>
            <div className="flex gap-1.5 mt-1">
              {PRIORITIES.map(({ p, flag }) => (
                <button key={p} onClick={() => setPriority(p)}
                  className={`flex-1 flex items-center justify-center gap-1 text-xs font-semibold border rounded-lg py-2 transition-all
                    ${priority === p ? 'border-brand-navy bg-brand-navy/5' : 'border-gray-200 hover:border-gray-300'}`}>
                  <Flag className={`w-3.5 h-3.5 ${flag}`} fill={p < 4 ? 'currentColor' : 'none'} />p{p}
                </button>
              ))}
            </div>
          </div>

          {/* Labels */}
          <div className="sm:col-span-2">
            <label className="text-[11px] font-bold text-gray-400 uppercase tracking-wider">Labels</label>
            <div className="flex items-center flex-wrap gap-1.5 mt-1.5">
              {taskLabels.map(l => (
                <span key={l} className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full bg-brand-navy/5 text-brand-navy/80">
                  <Tag className="w-3 h-3" />{l}
                  <button onClick={() => setTaskLabels(taskLabels.filter(x => x !== l))} className="hover:text-red-600">
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
              <input
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') addLabel(newLabel) }}
                list="tb-known-labels"
                placeholder="+ add label"
                className="text-xs outline-none border border-dashed border-gray-300 rounded-full px-2.5 py-1 w-28 focus:border-brand-navy"
              />
              <datalist id="tb-known-labels">
                {labels.map(l => <option key={l.id} value={l.name} />)}
              </datalist>
            </div>
          </div>

          {/* Subtasks (only for top-level tasks) */}
          {!task.parent_id && (
            <div className="sm:col-span-2">
              <label className="text-[11px] font-bold text-gray-400 uppercase tracking-wider">
                Subtasks {subtasks.length > 0 && `(${subtasks.filter(s => s.completed).length}/${subtasks.length})`}
              </label>
              <div className="mt-1.5 space-y-1">
                {subtasks.map(s => (
                  <div key={s.id} className="flex items-center gap-2 group">
                    <TaskCheck task={s} onToggle={onToggle} />
                    <span className={`text-sm flex-1 ${s.completed ? 'line-through text-gray-400' : 'text-gray-700'}`}>{s.content}</span>
                    <button onClick={() => onDelete(s, { silent: true })}
                      className="p-1 text-gray-300 hover:text-red-500 opacity-0 group-hover:opacity-100">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
                <div className="flex items-center gap-2">
                  <Plus className="w-4 h-4 text-gray-300" />
                  <input
                    value={newSub}
                    onChange={(e) => setNewSub(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') addSub() }}
                    placeholder="Add a subtask"
                    className="flex-1 text-sm outline-none py-1 placeholder:text-gray-300"
                  />
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-4 border-t border-gray-100">
          <button onClick={() => { onDelete(task); onClose() }}
            className="text-xs text-red-500 font-semibold hover:underline inline-flex items-center gap-1">
            <Trash2 className="w-3.5 h-3.5" /> Delete task
          </button>
          <div className="flex gap-2">
            <button onClick={onClose} className="text-sm text-gray-500 px-4 py-2 rounded-lg hover:bg-gray-100">Cancel</button>
            <button onClick={save} disabled={saving || !content.trim()}
              className="text-sm font-bold text-white bg-brand-red hover:bg-red-700 px-5 py-2 rounded-lg disabled:opacity-50 inline-flex items-center gap-1.5">
              {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Save
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Project create/edit modal ─────────────────────────────────────────────────
function ProjectModal({ editing, onClose, onSave }) {
  const [name, setName]         = useState(editing?.name || '')
  const [color, setColor]       = useState(editing?.color || PROJECT_COLORS[0])
  const [favorite, setFavorite] = useState(editing?.is_favorite || false)
  const [saving, setSaving]     = useState(false)

  const save = async () => {
    if (!name.trim()) return
    setSaving(true)
    await onSave({ name: name.trim(), color, is_favorite: favorite })
    setSaving(false)
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[15vh]" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-5" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-base font-bold text-gray-900 mb-4">{editing ? 'Edit project' : 'Add project'}</h3>
        <label className="text-[11px] font-bold text-gray-400 uppercase tracking-wider">Name</label>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') save() }}
          className="mt-1 w-full text-sm border border-gray-200 rounded-lg px-3 py-2 mb-4" placeholder="e.g. Fundraising" />
        <label className="text-[11px] font-bold text-gray-400 uppercase tracking-wider">Color</label>
        <div className="flex flex-wrap gap-2 mt-1.5 mb-4">
          {PROJECT_COLORS.map(c => (
            <button key={c} onClick={() => setColor(c)}
              className={`w-7 h-7 rounded-full border-2 ${color === c ? 'border-gray-800 scale-110' : 'border-transparent'} transition-all`}
              style={{ backgroundColor: c }} />
          ))}
        </div>
        <label className="flex items-center gap-2 text-sm text-gray-600 mb-5 cursor-pointer">
          <input type="checkbox" checked={favorite} onChange={(e) => setFavorite(e.target.checked)} className="rounded" />
          <Star className="w-4 h-4 text-amber-400" /> Add to favorites
        </label>
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="text-sm text-gray-500 px-4 py-2 rounded-lg hover:bg-gray-100">Cancel</button>
          <button onClick={save} disabled={saving || !name.trim()}
            className="text-sm font-bold text-white bg-brand-red hover:bg-red-700 px-5 py-2 rounded-lg disabled:opacity-50">
            {editing ? 'Save' : 'Add'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Campaign template modal ───────────────────────────────────────────────────
function TemplateModal({ onClose, onGenerate }) {
  const [elections, setElections] = useState([])
  const [electionId, setElectionId] = useState('')
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)

  useEffect(() => {
    getElections().then(({ data }) => {
      const future = (data || []).filter(e => e.election_date && !isPast(parseISO(e.election_date)))
      setElections(future.length ? future : (data || []))
      if (future[0]) setElectionId(future[0].id)
      setLoading(false)
    })
  }, [])

  const run = async () => {
    const el = elections.find(e => e.id === electionId)
    if (!el) return
    setGenerating(true)
    await onGenerate(el)
    setGenerating(false)
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[15vh]" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-5" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-base font-bold text-gray-900 mb-1 flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-brand-red" /> Generate campaign plan
        </h3>
        <p className="text-xs text-gray-500 mb-4">
          Creates a project with {PLAN_TEMPLATE.length} standard Wisconsin campaign tasks organized into
          phase sections, with due dates keyed to election day.
        </p>
        {loading ? (
          <div className="flex justify-center py-6"><Loader2 className="w-5 h-5 animate-spin text-gray-400" /></div>
        ) : elections.length === 0 ? (
          <p className="text-sm text-gray-500 py-4">No elections found — add one on the Calendar tab first.</p>
        ) : (
          <select value={electionId} onChange={(e) => setElectionId(e.target.value)}
            className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 mb-5 bg-white">
            {elections.map(e => (
              <option key={e.id} value={e.id}>
                {e.name} — {e.election_date ? format(parseISO(e.election_date), 'MMM d, yyyy') : 'no date'}
              </option>
            ))}
          </select>
        )}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="text-sm text-gray-500 px-4 py-2 rounded-lg hover:bg-gray-100">Cancel</button>
          <button onClick={run} disabled={generating || !electionId}
            className="text-sm font-bold text-white bg-brand-red hover:bg-red-700 px-5 py-2 rounded-lg disabled:opacity-50 inline-flex items-center gap-1.5">
            {generating && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Generate
          </button>
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// Main TaskBoard
// ═══════════════════════════════════════════════════════════════════════════════
export default function TaskBoard() {
  const [projects, setProjects]   = useState([])
  const [sections, setSections]   = useState([])
  const [tasks, setTasks]         = useState([])
  const [labels, setLabels]       = useState([])
  const [completed, setCompleted] = useState([])
  const [loading, setLoading]     = useState(true)
  const [fromCache, setFromCache] = useState(false)
  const [setupNeeded, setSetupNeeded] = useState(false)

  const [opError, setOpError] = useState(null)   // last failed mutation message
  const opErrTimer = useRef(null)
  const failOp = (msg) => {
    setOpError(msg)
    clearTimeout(opErrTimer.current)
    opErrTimer.current = setTimeout(() => setOpError(null), 6000)
    loadAll()  // resync state from server (rolls back optimistic change)
  }

  // Campaign Connect: plans this user can open (own + connected candidates)
  const [planOwners, setPlanOwners]   = useState([])
  const [activePlan, setActivePlan]   = useState(null)   // { id, label, canEdit, self }
  const canEdit = activePlan ? activePlan.canEdit : true

  // view: { type: 'today'|'upcoming'|'inbox'|'completed'|'project'|'label', id? }
  const [view, setView]           = useState({ type: 'today' })
  const [layout, setLayout]       = useState('list')   // list | board (project views)
  const [detail, setDetail]       = useState(null)      // task open in modal
  const [projectModal, setProjectModal] = useState(null) // false | 'new' | project
  const [templateModal, setTemplateModal] = useState(false)
  const [addingSection, setAddingSection] = useState(false)
  const [newSectionName, setNewSectionName] = useState('')
  const dragTask = useRef(null)

  // ── Load ────────────────────────────────────────────────────────────────────
  const ownerId = activePlan?.self === false ? activePlan.id : null

  const loadSeq = useRef(0)
  const loadAll = async (owner = ownerId) => {
    const seq = ++loadSeq.current
    const [p, s, t, l] = await Promise.all([
      getTaskProjects(owner), getTaskSections(owner), getTasks(owner), getTaskLabels(owner),
    ])
    if (seq !== loadSeq.current) return   // a newer load (e.g. plan switch) superseded this one
    setProjects(p.data || [])
    setSections(s.data || [])
    setTasks(t.data || [])
    setLabels(l.data || [])
    setFromCache(Boolean(p.fromCache || t.fromCache))
    // Missing tables → migration hasn't been applied yet
    const errMsg = String(p.error?.message || t.error?.message || '')
    setSetupNeeded(/relation .* does not exist|schema cache/i.test(errMsg))
    setLoading(false)
  }

  useEffect(() => {
    getTaskPlanOwners().then(({ data }) => {
      setPlanOwners(data || [])
      setActivePlan((data || [])[0] || null)
    })
    loadAll(null)
  }, [])

  const switchPlan = async (id) => {
    const plan = planOwners.find(o => o.id === id)
    if (!plan || plan.id === activePlan?.id) return
    setActivePlan(plan)
    setLoading(true)
    setView({ type: 'today' })
    setCompleted([])
    await loadAll(plan.self ? null : plan.id)
  }

  const loadCompleted = async () => {
    const { data } = await getCompletedTasks(ownerId)
    setCompleted(data || [])
  }
  useEffect(() => { if (view.type === 'completed') loadCompleted() }, [view.type, activePlan?.id])

  // ── Derived ─────────────────────────────────────────────────────────────────
  const topTasks    = useMemo(() => tasks.filter(t => !t.parent_id), [tasks])
  const subsByParent = useMemo(() => {
    const m = {}
    tasks.forEach(t => { if (t.parent_id) (m[t.parent_id] ||= []).push(t) })
    return m
  }, [tasks])

  const counts = useMemo(() => ({
    today:   topTasks.filter(t => t.due_date && differenceInCalendarDays(parseISO(t.due_date), new Date()) <= 0).length,
    inbox:   topTasks.filter(t => !t.project_id).length,
  }), [topTasks])

  const byPriorityThenOrder = (a, b) =>
    (a.priority - b.priority) || (a.sort_order - b.sort_order) || a.created_at.localeCompare(b.created_at)

  // ── Task ops (optimistic) ───────────────────────────────────────────────────
  const handleToggle = async (task) => {
    if (!canEdit) return
    const nowDone = !task.completed
    const stamp = nowDone ? new Date().toISOString() : null

    if (task.parent_id) {
      // Subtask: stays in state either way so parent progress counts stay right
      setTasks(prev => prev.map(t => t.id === task.id ? { ...t, completed: nowDone, completed_at: stamp } : t))
      const { error } = await updateTask(task.id, { completed: nowDone, completed_at: stamp })
      if (error) failOp("Couldn't update the task — are you online?")
      return
    }

    if (nowDone) {
      // Complete parent + its open subtasks
      const subIds = (subsByParent[task.id] || []).filter(s => !s.completed).map(s => s.id)
      setTasks(prev => prev.filter(t => t.id !== task.id && t.parent_id !== task.id))
      setCompleted(prev => [{ ...task, completed: true, completed_at: stamp }, ...prev])
      for (const id of [task.id, ...subIds]) {
        const { error } = await updateTask(id, { completed: true, completed_at: stamp })
        if (error) { failOp("Couldn't complete the task — are you online?"); return }
      }
    } else {
      // Reopen from Completed view, then resync to pull its subtasks back
      setCompleted(prev => prev.filter(t => t.id !== task.id))
      setTasks(prev => [...prev, { ...task, completed: false, completed_at: null }])
      const { error } = await updateTask(task.id, { completed: false, completed_at: null })
      if (error) { failOp("Couldn't reopen the task — are you online?"); return }
      loadAll()
    }
  }

  const handleDelete = async (task) => {
    if (!canEdit) return
    setTasks(prev => prev.filter(t => t.id !== task.id && t.parent_id !== task.id))
    setCompleted(prev => prev.filter(t => t.id !== task.id))
    const { error } = await deleteTask(task.id)
    if (error) failOp("Couldn't delete the task — are you online?")
  }

  const registerLabels = async (names = []) => {
    for (const name of names) {
      if (!labels.some(l => l.name === name)) {
        const { data: nl } = await createTaskLabel({ name }, ownerId)
        if (nl) setLabels(prev => prev.some(l => l.name === nl.name) ? prev : [...prev, nl])
      }
    }
  }

  const handleSave = async (id, patch) => {
    if (!canEdit) return
    const before = tasks.find(t => t.id === id)
    setTasks(prev => prev.map(t => t.id === id ? { ...t, ...patch } : t))
    const { data, error } = await updateTask(id, patch)
    if (error) { failOp("Couldn't save the task — are you online?"); return }
    if (data) setTasks(prev => prev.map(t => t.id === id ? data : t))
    // Keep subtasks in the same project/section as their parent
    if (before && !before.parent_id &&
        (patch.project_id !== before.project_id || patch.section_id !== before.section_id)) {
      const move = { project_id: patch.project_id, section_id: patch.section_id }
      setTasks(prev => prev.map(t => t.parent_id === id ? { ...t, ...move } : t))
      for (const s of tasks.filter(t => t.parent_id === id)) await updateTask(s.id, move)
    }
    await registerLabels(patch.labels)
  }

  const handleAddSub = async (parent, content) => {
    if (!canEdit) return
    const { data, error } = await createTask({
      content, parent_id: parent.id,
      project_id: parent.project_id, section_id: parent.section_id,
    }, ownerId)
    if (error) { failOp("Couldn't add the subtask — are you online?"); return false }
    if (data) setTasks(prev => [...prev, data])
    return true
  }

  const handleQuickAdd = async (parsed, ctx = {}) => {
    if (!canEdit) return
    const payload = {
      content: parsed.content,
      priority: parsed.priority,
      labels: parsed.labels,
      due_date: parsed.dueDate || ctx.dueDate || null,
      project_id: parsed.projectId || ctx.projectId || null,
      section_id: parsed.projectId ? null : (ctx.sectionId || null),
    }
    const { data, error } = await createTask(payload, ownerId)
    if (error) { failOp("Couldn't add the task — are you online?"); return false }
    if (data) setTasks(prev => [...prev, data])
    await registerLabels(parsed.labels)
    return true
  }

  // ── Drag & drop ─────────────────────────────────────────────────────────────
  const onDragStart = (task) => { dragTask.current = task }

  const moveToSection = async (sectionId, projectId) => {
    if (!canEdit) { dragTask.current = null; return }
    const t = dragTask.current
    if (!t) return
    dragTask.current = null
    if (t.section_id === sectionId && t.project_id === projectId) return
    const patch = { section_id: sectionId, project_id: projectId }
    setTasks(prev => prev.map(x => (x.id === t.id || x.parent_id === t.id) ? { ...x, ...patch } : x))
    const { error } = await updateTask(t.id, patch)
    if (error) { failOp("Couldn't move the task — are you online?"); return }
    for (const s of subsByParent[t.id] || []) await updateTask(s.id, patch)
  }

  // Reorder within a project view: may also change section (drop target's home).
  const reorderOn = async (target) => {
    if (!canEdit) { dragTask.current = null; return }
    const t = dragTask.current
    dragTask.current = null
    if (!t || t.id === target.id) return
    const patch = {
      section_id: target.section_id, project_id: target.project_id,
      sort_order: target.sort_order + 1,
    }
    setTasks(prev => prev.map(x => (x.id === t.id || x.parent_id === t.id) ? { ...x, ...patch } : x))
    const { error } = await updateTask(t.id, patch)
    if (error) { failOp("Couldn't reorder the task — are you online?"); return }
    for (const s of subsByParent[t.id] || []) await updateTask(s.id, patch)
  }

  // Reorder in cross-project views (Today/Inbox): sort only — never re-home the task.
  const reorderOnly = async (target) => {
    if (!canEdit) { dragTask.current = null; return }
    const t = dragTask.current
    dragTask.current = null
    if (!t || t.id === target.id) return
    const patch = { sort_order: target.sort_order + 1 }
    setTasks(prev => prev.map(x => x.id === t.id ? { ...x, ...patch } : x))
    const { error } = await updateTask(t.id, patch)
    if (error) failOp("Couldn't reorder the task — are you online?")
  }

  // ── Project / section ops ───────────────────────────────────────────────────
  const saveProject = async (form) => {
    if (!canEdit) return
    if (projectModal && projectModal !== 'new') {
      const { data } = await updateTaskProject(projectModal.id, form)
      if (data) setProjects(prev => prev.map(p => p.id === data.id ? data : p))
    } else {
      const { data } = await createTaskProject({ ...form, sort_order: projects.length }, ownerId)
      if (data) { setProjects(prev => [...prev, data]); setView({ type: 'project', id: data.id }) }
    }
  }

  const removeProject = async (project) => {
    if (!canEdit) return
    if (!window.confirm(`Delete "${project.name}" and all its tasks?`)) return
    setProjects(prev => prev.filter(p => p.id !== project.id))
    setTasks(prev => prev.filter(t => t.project_id !== project.id))
    setSections(prev => prev.filter(s => s.project_id !== project.id))
    if (view.type === 'project' && view.id === project.id) setView({ type: 'today' })
    const { error } = await deleteTaskProject(project.id)
    if (error) failOp("Couldn't delete the project — are you online?")
  }

  const addSection = async (projectId) => {
    const name = newSectionName.trim()
    if (!name) { setAddingSection(false); return }
    const secs = sections.filter(s => s.project_id === projectId)
    const { data } = await createTaskSection({ project_id: projectId, name, sort_order: secs.length }, ownerId)
    if (data) setSections(prev => [...prev, data])
    setNewSectionName(''); setAddingSection(false)
  }

  const removeSection = async (section) => {
    if (!canEdit) return
    if (!window.confirm(`Delete section "${section.name}"? Its tasks move to the project root.`)) return
    setSections(prev => prev.filter(s => s.id !== section.id))
    setTasks(prev => prev.map(t => t.section_id === section.id ? { ...t, section_id: null } : t))
    const { error } = await deleteTaskSection(section.id)
    if (error) failOp("Couldn't delete the section — are you online?")
  }

  // ── Template generator ──────────────────────────────────────────────────────
  const generateTemplate = async (election) => {
    if (!canEdit) return
    const base = parseISO(election.election_date)
    const { data: proj } = await createTaskProject({
      name: `Campaign — ${election.name}`, color: '#8B0000', is_favorite: true,
      sort_order: projects.length,
    }, ownerId)
    if (!proj) return
    const secMap = {}
    for (let i = 0; i < PHASE_ORDER.length; i++) {
      const { data: sec } = await createTaskSection({ project_id: proj.id, name: PHASE_ORDER[i], sort_order: i }, ownerId)
      if (sec) secMap[PHASE_ORDER[i]] = sec.id
    }
    const newTasks = []
    for (let i = 0; i < PLAN_TEMPLATE.length; i++) {
      const t = PLAN_TEMPLATE[i]
      const { data } = await createTask({
        content: t.title,
        project_id: proj.id,
        section_id: secMap[t.phase] || null,
        due_date: format(addDays(base, t.off), 'yyyy-MM-dd'),
        labels: t.label ? [t.label] : [],
        priority: 4,
        sort_order: i,
      }, ownerId)
      if (data) newTasks.push(data)
    }
    setProjects(prev => [...prev, proj])
    setSections(prev => [...prev, ...Object.entries(secMap).map(([name, id], i) =>
      ({ id, project_id: proj.id, name, sort_order: i }))])
    setTasks(prev => [...prev, ...newTasks])
    setView({ type: 'project', id: proj.id })
  }

  // ── View data ───────────────────────────────────────────────────────────────
  const activeProject = view.type === 'project' ? projects.find(p => p.id === view.id) : null

  if (loading) return <LoadingBar />

  if (setupNeeded) {
    return (
      <div className="bg-white border border-amber-200 rounded-2xl p-8 text-center">
        <AlertCircle className="w-8 h-8 text-amber-500 mx-auto mb-3" />
        <h3 className="text-base font-bold text-gray-900 mb-1">Task system needs a one-time database setup</h3>
        <p className="text-sm text-gray-500 max-w-md mx-auto">
          Run the migration <code className="text-xs bg-gray-100 px-1.5 py-0.5 rounded">supabase/migrations/20260704000001_game_plan_tasks.sql</code>{' '}
          in the Supabase SQL Editor, then reload this page.
        </p>
      </div>
    )
  }

  return (
    <div className="flex gap-0 bg-white border border-gray-200 rounded-2xl overflow-hidden min-h-[70vh]">

      {/* ══ Sidebar ══ */}
      <aside className="w-56 flex-shrink-0 bg-gray-50/80 border-r border-gray-200 p-3 hidden md:flex flex-col gap-0.5 overflow-y-auto">
        {/* Campaign Connect plan switcher */}
        {planOwners.length > 1 && (
          <div className="mb-2">
            <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-wider px-3 mb-1">Viewing plan</label>
            <select
              value={activePlan?.id || ''}
              onChange={(e) => switchPlan(e.target.value)}
              className="w-full text-xs font-medium border border-gray-200 rounded-lg px-2 py-1.5 bg-white truncate"
            >
              {planOwners.map(o => (
                <option key={o.id} value={o.id}>{o.self ? 'My plan' : o.label}</option>
              ))}
            </select>
            {activePlan && !activePlan.self && (
              <p className="px-1 mt-1 text-[10px] text-gray-400">
                Connected candidate {activePlan.canEdit ? '· can manage' : '· view only'}
              </p>
            )}
          </div>
        )}
        {[
          { key: 'today',     icon: Sun,          label: 'Today',     count: counts.today },
          { key: 'upcoming',  icon: CalendarDays, label: 'Upcoming' },
          { key: 'inbox',     icon: Inbox,        label: 'Inbox',     count: counts.inbox },
          { key: 'completed', icon: CheckCircle2, label: 'Completed' },
        ].map(({ key, icon: Icon, label, count }) => (
          <button key={key} onClick={() => setView({ type: key })}
            className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors text-left
              ${view.type === key ? 'bg-brand-red/10 text-brand-red' : 'text-gray-700 hover:bg-gray-100'}`}>
            <Icon className="w-4 h-4 flex-shrink-0" />
            <span className="flex-1">{label}</span>
            {count > 0 && <span className="text-[10px] text-gray-400 tabular-nums">{count}</span>}
          </button>
        ))}

        {/* Projects */}
        <div className="flex items-center justify-between mt-4 mb-1 px-3">
          <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Projects</span>
          {canEdit && (
            <button onClick={() => setProjectModal('new')} className="p-0.5 text-gray-400 hover:text-brand-red" title="Add project">
              <Plus className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        {projects.length === 0 && (
          <p className="px-3 text-xs text-gray-400">No projects yet</p>
        )}
        {[...projects].sort((a, b) => (b.is_favorite - a.is_favorite) || a.sort_order - b.sort_order).map(p => {
          const n = topTasks.filter(t => t.project_id === p.id).length
          return (
            <div key={p.id} className="group flex items-center">
              <button onClick={() => setView({ type: 'project', id: p.id })}
                className={`flex-1 flex items-center gap-2.5 px-3 py-1.5 rounded-lg text-sm transition-colors text-left min-w-0
                  ${view.type === 'project' && view.id === p.id ? 'bg-brand-red/10 text-brand-red font-medium' : 'text-gray-700 hover:bg-gray-100'}`}>
                <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: p.color }} />
                <span className="flex-1 truncate">{p.name}</span>
                {p.is_favorite && <Star className="w-3 h-3 text-amber-400 flex-shrink-0" fill="currentColor" />}
                {n > 0 && <span className="text-[10px] text-gray-400 tabular-nums">{n}</span>}
              </button>
              <button onClick={() => setProjectModal(p)}
                className="p-1 text-gray-300 hover:text-gray-600 opacity-0 group-hover:opacity-100" title="Edit project">
                <MoreHorizontal className="w-3.5 h-3.5" />
              </button>
            </div>
          )
        })}

        {/* Labels */}
        {labels.length > 0 && (
          <>
            <div className="mt-4 mb-1 px-3">
              <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Labels</span>
            </div>
            {labels.map(l => (
              <button key={l.id} onClick={() => setView({ type: 'label', id: l.name })}
                className={`flex items-center gap-2.5 px-3 py-1.5 rounded-lg text-sm transition-colors text-left
                  ${view.type === 'label' && view.id === l.name ? 'bg-brand-red/10 text-brand-red font-medium' : 'text-gray-600 hover:bg-gray-100'}`}>
                <Tag className="w-3.5 h-3.5 flex-shrink-0 text-gray-400" />
                <span className="flex-1 truncate">{l.name}</span>
              </button>
            ))}
          </>
        )}

        {canEdit && (
          <button onClick={() => setTemplateModal(true)}
            className="mt-auto pt-4 flex items-center gap-2 px-3 py-2 text-xs font-semibold text-brand-navy/70 hover:text-brand-red transition-colors">
            <Sparkles className="w-3.5 h-3.5" /> Generate campaign plan
          </button>
        )}
      </aside>

      {/* ══ Main pane ══ */}
      <main className="flex-1 min-w-0 p-4 md:p-6 overflow-y-auto">

        {/* Mobile plan switcher */}
        {planOwners.length > 1 && (
          <select
            value={activePlan?.id || ''}
            onChange={(e) => switchPlan(e.target.value)}
            className="md:hidden w-full text-xs font-medium border border-gray-200 rounded-lg px-2 py-2 bg-white mb-3"
          >
            {planOwners.map(o => (
              <option key={o.id} value={o.id}>{o.self ? 'My plan' : `Plan: ${o.label}`}</option>
            ))}
          </select>
        )}

        {/* Mobile view switcher */}
        <div className="md:hidden flex gap-1.5 mb-4 overflow-x-auto pb-1">
          {[
            { key: 'today', label: 'Today' }, { key: 'upcoming', label: 'Upcoming' },
            { key: 'inbox', label: 'Inbox' }, { key: 'completed', label: 'Done' },
            ...projects.map(p => ({ key: `project:${p.id}`, label: p.name })),
          ].map(({ key, label }) => {
            const isActive = key.startsWith('project:')
              ? view.type === 'project' && view.id === key.slice(8)
              : view.type === key
            return (
              <button key={key}
                onClick={() => key.startsWith('project:')
                  ? setView({ type: 'project', id: key.slice(8) })
                  : setView({ type: key })}
                className={`px-3 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap border
                  ${isActive ? 'bg-brand-red text-white border-brand-red' : 'text-gray-600 border-gray-200'}`}>
                {label}
              </button>
            )
          })}
          {canEdit && (
            <button onClick={() => setProjectModal('new')}
              className="px-3 py-1.5 rounded-full text-xs border border-dashed border-gray-300 text-gray-400">+ Project</button>
          )}
        </div>

        {fromCache && (
          <div className="flex items-center gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-4">
            <AlertCircle className="w-3.5 h-3.5" /> Offline — showing your last synced tasks. Changes can't be saved until you reconnect.
          </div>
        )}
        {opError && (
          <div className="flex items-center gap-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-4">
            <AlertCircle className="w-3.5 h-3.5" /> {opError}
          </div>
        )}

        {view.type === 'today'     && <TodayView     {...{ topTasks, subsByParent, projects, handleToggle, setDetail, handleDelete, handleQuickAdd, byPriorityThenOrder, onDragStart, canEdit }} reorderOn={reorderOnly} />}
        {view.type === 'upcoming'  && <UpcomingView  {...{ topTasks, subsByParent, projects, handleToggle, setDetail, handleDelete, handleQuickAdd, byPriorityThenOrder, canEdit }} />}
        {view.type === 'inbox'     && <InboxView     {...{ topTasks, subsByParent, projects, handleToggle, setDetail, handleDelete, handleQuickAdd, byPriorityThenOrder, onDragStart, canEdit }} reorderOn={reorderOnly} />}
        {view.type === 'label'     && <LabelView     labelName={view.id} {...{ topTasks, subsByParent, projects, handleToggle, setDetail, handleDelete, handleQuickAdd, byPriorityThenOrder, canEdit }} />}
        {view.type === 'completed' && <CompletedView completed={completed} projects={projects} onToggle={handleToggle} onDelete={handleDelete} />}
        {view.type === 'project' && activeProject && (
          <ProjectView
            project={activeProject}
            sections={sections.filter(s => s.project_id === activeProject.id)}
            {...{ topTasks, subsByParent, projects, layout, setLayout, handleToggle, setDetail, handleDelete,
                  handleQuickAdd, byPriorityThenOrder, onDragStart, reorderOn, moveToSection,
                  addingSection, setAddingSection, newSectionName, setNewSectionName, addSection, removeSection, canEdit,
                  onEditProject: () => setProjectModal(activeProject), onDeleteProject: () => removeProject(activeProject) }}
          />
        )}
      </main>

      {/* ══ Modals ══ */}
      {detail && (
        <TaskDetailModal
          task={tasks.find(t => t.id === detail.id) || detail}
          tasks={tasks} projects={projects} sections={sections} labels={labels}
          onClose={() => setDetail(null)}
          onSave={handleSave} onDelete={handleDelete} onToggle={handleToggle} onAddSub={handleAddSub}
        />
      )}
      {projectModal && (
        <ProjectModal
          editing={projectModal === 'new' ? null : projectModal}
          onClose={() => setProjectModal(null)}
          onSave={saveProject}
        />
      )}
      {templateModal && <TemplateModal onClose={() => setTemplateModal(false)} onGenerate={generateTemplate} />}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// Views
// ═══════════════════════════════════════════════════════════════════════════════

function ViewHeader({ title, subtitle, right }) {
  return (
    <div className="flex items-end justify-between mb-4">
      <div>
        <h2 className="text-lg font-black text-gray-900">{title}</h2>
        {subtitle && <p className="text-xs text-gray-400 mt-0.5">{subtitle}</p>}
      </div>
      {right}
    </div>
  )
}

function EmptyState({ text }) {
  return (
    <div className="text-center py-14">
      <CheckCircle2 className="w-10 h-10 text-gray-200 mx-auto mb-3" />
      <p className="text-sm text-gray-400">{text}</p>
    </div>
  )
}

function TaskList({ items, subsByParent, projects, handleToggle, setDetail, handleDelete,
                    showProject, draggable, onDragStart, reorderOn }) {
  return (
    <div>
      {items.map(t => (
        <TaskRow key={t.id} task={t} subtasks={subsByParent[t.id] || []}
          projects={projects} onToggle={handleToggle} onOpen={setDetail} onDelete={handleDelete}
          showProject={showProject} draggable={draggable} onDragStart={onDragStart} onDropOn={reorderOn} />
      ))}
    </div>
  )
}

// ── Today ─────────────────────────────────────────────────────────────────────
function TodayView({ topTasks, subsByParent, projects, handleToggle, setDetail, handleDelete,
                     handleQuickAdd, byPriorityThenOrder, onDragStart, reorderOn, canEdit = true }) {
  const overdue = topTasks
    .filter(t => t.due_date && differenceInCalendarDays(parseISO(t.due_date), new Date()) < 0)
    .sort((a, b) => a.due_date.localeCompare(b.due_date) || byPriorityThenOrder(a, b))
  const today = topTasks
    .filter(t => t.due_date && isToday(parseISO(t.due_date)))
    .sort(byPriorityThenOrder)

  return (
    <div>
      <ViewHeader title="Today" subtitle={format(new Date(), 'EEEE, MMMM d')} />
      {canEdit && (
        <div className="mb-4">
          <QuickAdd projects={projects} context="Today"
            onAdd={(p) => handleQuickAdd(p, { dueDate: todayStr() })} />
        </div>
      )}
      {overdue.length > 0 && (
        <>
          <p className="text-xs font-bold text-red-600 uppercase tracking-wider mb-1 mt-2">Overdue</p>
          <TaskList items={overdue} {...{ subsByParent, projects, handleToggle, setDetail, handleDelete }}
            showProject draggable={canEdit} onDragStart={onDragStart} reorderOn={reorderOn} />
        </>
      )}
      {today.length > 0 && (
        <>
          <p className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-1 mt-4">Today</p>
          <TaskList items={today} {...{ subsByParent, projects, handleToggle, setDetail, handleDelete }} showProject />
        </>
      )}
      {overdue.length === 0 && today.length === 0 && <EmptyState text="Nothing due today — enjoy the clear runway." />}
    </div>
  )
}

// ── Upcoming ──────────────────────────────────────────────────────────────────
function UpcomingView({ topTasks, subsByParent, projects, handleToggle, setDetail, handleDelete,
                        handleQuickAdd, byPriorityThenOrder, canEdit = true }) {
  const dated = topTasks.filter(t => t.due_date)
  const days = []
  for (let i = 0; i < 14; i++) {
    const d = addDays(new Date(), i)
    const key = format(d, 'yyyy-MM-dd')
    const items = dated.filter(t => t.due_date === key).sort(byPriorityThenOrder)
    if (i === 0 || items.length > 0) days.push({ d, key, items, idx: i })
  }
  const later = dated
    .filter(t => differenceInCalendarDays(parseISO(t.due_date), new Date()) >= 14)
    .sort((a, b) => a.due_date.localeCompare(b.due_date))
  const overdue = dated
    .filter(t => differenceInCalendarDays(parseISO(t.due_date), new Date()) < 0)
    .sort((a, b) => a.due_date.localeCompare(b.due_date))
  const noDate = topTasks.filter(t => !t.due_date).sort(byPriorityThenOrder)

  return (
    <div>
      <ViewHeader title="Upcoming" subtitle="Next two weeks and beyond" />
      {canEdit && <div className="mb-4"><QuickAdd projects={projects} onAdd={handleQuickAdd} /></div>}
      {overdue.length > 0 && (
        <>
          <p className="text-xs font-bold text-red-600 uppercase tracking-wider mb-1">Overdue</p>
          <TaskList items={overdue} {...{ subsByParent, projects, handleToggle, setDetail, handleDelete }} showProject />
        </>
      )}
      {days.map(({ d, key, items, idx }) => (
        <div key={key} className="mt-4">
          <p className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-1">
            {idx === 0 ? 'Today' : idx === 1 ? 'Tomorrow' : format(d, 'EEEE, MMM d')}
          </p>
          {items.length > 0
            ? <TaskList items={items} {...{ subsByParent, projects, handleToggle, setDetail, handleDelete }} showProject />
            : <p className="text-xs text-gray-300 px-3 py-2">No tasks</p>}
        </div>
      ))}
      {later.length > 0 && (
        <div className="mt-4">
          <p className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-1">Later</p>
          <TaskList items={later} {...{ subsByParent, projects, handleToggle, setDetail, handleDelete }} showProject />
        </div>
      )}
      {noDate.length > 0 && (
        <div className="mt-4">
          <p className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-1">No date</p>
          <TaskList items={noDate} {...{ subsByParent, projects, handleToggle, setDetail, handleDelete }} showProject />
        </div>
      )}
    </div>
  )
}

// ── Inbox ─────────────────────────────────────────────────────────────────────
function InboxView({ topTasks, subsByParent, projects, handleToggle, setDetail, handleDelete,
                     handleQuickAdd, byPriorityThenOrder, onDragStart, reorderOn, canEdit = true }) {
  const items = topTasks.filter(t => !t.project_id).sort(byPriorityThenOrder)
  return (
    <div>
      <ViewHeader title="Inbox" subtitle="Capture now, organize later" />
      {canEdit && <div className="mb-4"><QuickAdd projects={projects} context="Inbox" onAdd={handleQuickAdd} autoFocus /></div>}
      {items.length === 0
        ? <EmptyState text="Inbox zero. Nicely done." />
        : <TaskList items={items} {...{ subsByParent, projects, handleToggle, setDetail, handleDelete }}
            draggable={canEdit} onDragStart={onDragStart} reorderOn={reorderOn} />}
    </div>
  )
}

// ── Label view ────────────────────────────────────────────────────────────────
function LabelView({ labelName, topTasks, subsByParent, projects, handleToggle, setDetail,
                     handleDelete, handleQuickAdd, byPriorityThenOrder, canEdit = true }) {
  const items = topTasks.filter(t => t.labels?.includes(labelName)).sort(byPriorityThenOrder)
  return (
    <div>
      <ViewHeader title={`@${labelName}`} subtitle={`${items.length} task${items.length === 1 ? '' : 's'}`} />
      {canEdit && (
        <div className="mb-4">
          <QuickAdd projects={projects}
            onAdd={(p) => handleQuickAdd({ ...p, labels: [...new Set([...p.labels, labelName])] })} />
        </div>
      )}
      {items.length === 0
        ? <EmptyState text={`No open tasks with @${labelName}.`} />
        : <TaskList items={items} {...{ subsByParent, projects, handleToggle, setDetail, handleDelete }} showProject />}
    </div>
  )
}

// ── Completed ─────────────────────────────────────────────────────────────────
function CompletedView({ completed, projects, onToggle, onDelete }) {
  return (
    <div>
      <ViewHeader title="Completed" subtitle="Most recent first" />
      {completed.length === 0
        ? <EmptyState text="No completed tasks yet." />
        : completed.filter(t => !t.parent_id).map(t => {
            const project = projects.find(p => p.id === t.project_id)
            return (
              <div key={t.id} className="group flex items-center gap-2.5 px-3 py-2 border-b border-gray-100 last:border-b-0">
                <CheckCircle2 className="w-4 h-4 text-green-500 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-gray-400 line-through truncate">{t.content}</p>
                  <p className="text-[10px] text-gray-300">
                    {t.completed_at && format(parseISO(t.completed_at), 'MMM d, h:mm a')}
                    {project && ` · ${project.name}`}
                  </p>
                </div>
                <button onClick={() => onToggle(t)}
                  className="p-1.5 text-gray-300 hover:text-brand-navy opacity-0 group-hover:opacity-100" title="Reopen">
                  <RotateCcw className="w-3.5 h-3.5" />
                </button>
                <button onClick={() => onDelete(t)}
                  className="p-1.5 text-gray-300 hover:text-red-500 opacity-0 group-hover:opacity-100" title="Delete forever">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            )
          })}
    </div>
  )
}

// ── Project view (List + Board) ───────────────────────────────────────────────
function ProjectView({ project, sections, topTasks, subsByParent, projects, layout, setLayout,
                       handleToggle, setDetail, handleDelete, handleQuickAdd, byPriorityThenOrder,
                       onDragStart, reorderOn, moveToSection,
                       addingSection, setAddingSection, newSectionName, setNewSectionName,
                       addSection, removeSection, canEdit = true, onEditProject, onDeleteProject }) {
  const projectTasks = topTasks.filter(t => t.project_id === project.id)
  const noSection    = projectTasks.filter(t => !t.section_id || !sections.some(s => s.id === t.section_id))
  const groups = [
    { section: null, items: noSection.sort((a, b) => (a.sort_order - b.sort_order) || byPriorityThenOrder(a, b)) },
    ...sections.map(s => ({
      section: s,
      items: projectTasks.filter(t => t.section_id === s.id)
        .sort((a, b) => (a.sort_order - b.sort_order) || byPriorityThenOrder(a, b)),
    })),
  ]
  const done  = projectTasks.filter(t => t.completed).length
  const total = projectTasks.length

  return (
    <div>
      <ViewHeader
        title={
          <span className="inline-flex items-center gap-2">
            <span className="w-3 h-3 rounded-full inline-block" style={{ backgroundColor: project.color }} />
            {project.name}
          </span>
        }
        subtitle={`${total} open task${total === 1 ? '' : 's'}`}
        right={
          <div className="flex items-center gap-1.5">
            <div className="flex rounded-lg border border-gray-200 overflow-hidden">
              <button onClick={() => setLayout('list')}
                className={`px-2.5 py-1.5 ${layout === 'list' ? 'bg-brand-navy text-white' : 'text-gray-500 hover:bg-gray-50'}`} title="List view">
                <ListIcon className="w-3.5 h-3.5" />
              </button>
              <button onClick={() => setLayout('board')}
                className={`px-2.5 py-1.5 ${layout === 'board' ? 'bg-brand-navy text-white' : 'text-gray-500 hover:bg-gray-50'}`} title="Board view">
                <LayoutGrid className="w-3.5 h-3.5" />
              </button>
            </div>
            {canEdit && (
              <>
                <button onClick={onEditProject} className="p-2 text-gray-400 hover:text-brand-navy rounded-lg hover:bg-gray-100" title="Edit project">
                  <Edit2 className="w-3.5 h-3.5" />
                </button>
                <button onClick={onDeleteProject} className="p-2 text-gray-400 hover:text-red-600 rounded-lg hover:bg-red-50" title="Delete project">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </>
            )}
          </div>
        }
      />

      {canEdit && (
        <div className="mb-5">
          <QuickAdd projects={projects} context={project.name}
            onAdd={(p) => handleQuickAdd(p, { projectId: project.id })} />
        </div>
      )}

      {layout === 'list' ? (
        <div className="space-y-5">
          {groups.map(({ section, items }) => (
            (section || items.length > 0) && (
              <div key={section?.id || '__none'}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => { e.preventDefault(); moveToSection(section?.id || null, project.id) }}>
                {section ? (
                  <div className="group flex items-center gap-2 border-b-2 border-gray-200 pb-1 mb-1">
                    <p className="text-sm font-bold text-gray-800">{section.name}</p>
                    <span className="text-[10px] text-gray-400 tabular-nums">{items.length}</span>
                    <button onClick={() => removeSection(section)}
                      className="ml-auto p-1 text-gray-300 hover:text-red-500 opacity-0 group-hover:opacity-100" title="Delete section">
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                ) : items.length > 0 && sections.length > 0 && (
                  <p className="text-sm font-bold text-gray-400 border-b-2 border-gray-100 pb-1 mb-1">No section</p>
                )}
                <TaskList items={items} {...{ subsByParent, projects, handleToggle, setDetail, handleDelete }}
                  draggable={canEdit} onDragStart={onDragStart} reorderOn={reorderOn} />
                {canEdit && (
                  <div className="mt-1 ml-3">
                    <InlineAdd onAdd={(p) => handleQuickAdd(p, { projectId: project.id, sectionId: section?.id || null })} projects={projects} />
                  </div>
                )}
              </div>
            )
          ))}
          {addingSection ? (
            <div className="flex items-center gap-2">
              <input autoFocus value={newSectionName} onChange={(e) => setNewSectionName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') addSection(project.id); if (e.key === 'Escape') setAddingSection(false) }}
                placeholder="Section name"
                className="text-sm border border-gray-200 rounded-lg px-3 py-1.5 w-56" />
              <button onClick={() => addSection(project.id)} className="text-xs font-bold text-white bg-brand-red px-3 py-1.5 rounded-lg">Add</button>
              <button onClick={() => setAddingSection(false)} className="text-xs text-gray-400">Cancel</button>
            </div>
          ) : canEdit && (
            <button onClick={() => setAddingSection(true)}
              className="text-xs font-semibold text-gray-400 hover:text-brand-red inline-flex items-center gap-1">
              <Plus className="w-3.5 h-3.5" /> Add section
            </button>
          )}
        </div>
      ) : (
        /* ── Board layout ── */
        <div className="flex gap-4 overflow-x-auto pb-4 items-start">
          {groups.map(({ section, items }) => (
            <div key={section?.id || '__none'}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); moveToSection(section?.id || null, project.id) }}
              className="w-64 flex-shrink-0 bg-gray-50 rounded-xl p-3">
              <div className="flex items-center gap-2 mb-2 px-1">
                <p className="text-xs font-bold text-gray-700">{section ? section.name : 'No section'}</p>
                <span className="text-[10px] text-gray-400 tabular-nums">{items.length}</span>
                {section && (
                  <button onClick={() => removeSection(section)} className="ml-auto p-0.5 text-gray-300 hover:text-red-500">
                    <Trash2 className="w-3 h-3" />
                  </button>
                )}
              </div>
              <div className="space-y-2">
                {items.map(t => {
                  const due = dueMeta(t.due_date)
                  const subs = subsByParent[t.id] || []
                  return (
                    <div key={t.id} draggable={canEdit}
                      onDragStart={(e) => {
                        e.dataTransfer.setData('text/plain', t.id)
                        e.dataTransfer.effectAllowed = 'move'
                        onDragStart(t)
                      }}
                      onClick={() => setDetail(t)}
                      className="bg-white rounded-lg border border-gray-200 p-3 cursor-pointer hover:shadow-sm group">
                      <div className="flex items-start gap-2">
                        <TaskCheck task={t} onToggle={handleToggle} />
                        <p className="text-[13px] text-gray-900 leading-snug flex-1">{t.content}</p>
                      </div>
                      {(due || t.labels?.length > 0 || subs.length > 0) && (
                        <div className="flex items-center flex-wrap gap-1 mt-2 ml-6">
                          {due && <span className={`text-[10px] px-1.5 py-px rounded border ${due.cls}`}>{due.label}</span>}
                          {subs.length > 0 && <span className="text-[10px] text-gray-400">{subs.filter(s => s.completed).length}/{subs.length}</span>}
                          {t.labels?.map(l => <LabelChip key={l} name={l} small />)}
                        </div>
                      )}
                    </div>
                  )
                })}
                {canEdit && <InlineAdd board onAdd={(p) => handleQuickAdd(p, { projectId: project.id, sectionId: section?.id || null })} projects={projects} />}
              </div>
            </div>
          ))}
          {canEdit && (
            <button onClick={() => setAddingSection(true)}
              className="w-52 flex-shrink-0 border-2 border-dashed border-gray-200 rounded-xl p-3 text-xs font-semibold text-gray-400 hover:border-brand-red/40 hover:text-brand-red">
              + Add section
            </button>
          )}
          {addingSection && (
            <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-[20vh]" onClick={() => setAddingSection(false)}>
              <div className="bg-white rounded-xl p-4 flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                <input autoFocus value={newSectionName} onChange={(e) => setNewSectionName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') addSection(project.id) }}
                  placeholder="Section name" className="text-sm border border-gray-200 rounded-lg px-3 py-2 w-56" />
                <button onClick={() => addSection(project.id)} className="text-xs font-bold text-white bg-brand-red px-3 py-2 rounded-lg">Add</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Inline "+ Add task" that expands into a QuickAdd ─────────────────────────
function InlineAdd({ onAdd, projects, board }) {
  const [open, setOpen] = useState(false)
  if (!open) {
    return (
      <button onClick={() => setOpen(true)}
        className={`inline-flex items-center gap-1 text-xs text-gray-400 hover:text-brand-red font-medium ${board ? 'w-full justify-center py-1.5 rounded-lg hover:bg-white' : 'py-1'}`}>
        <Plus className="w-3.5 h-3.5" /> Add task
      </button>
    )
  }
  return (
    <div className="my-1">
      <QuickAdd projects={projects} autoFocus onAdd={(p) => onAdd(p)} />
      <button onClick={() => setOpen(false)} className="text-[10px] text-gray-400 hover:text-gray-600 mt-1">Close</button>
    </div>
  )
}
