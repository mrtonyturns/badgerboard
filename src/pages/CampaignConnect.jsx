// Campaign Connect — links Action accounts (managers/consultants/parties) to Candidate
// accounts. Redesigned visual layer (v2): hero, connection motif, gradient stat tiles,
// card grids, modern empty states. Logic/endpoints unchanged.
import React, { useEffect, useState, useCallback } from 'react'
import { Users, UserPlus, Send, Clock, Check, X, Shield, AlertTriangle, RefreshCw, ChevronRight, Inbox, Trash2, Eye, ArrowLeft, Copy, Link2, Sparkles, CheckCircle2, ListChecks, FileText, Zap } from 'lucide-react'
import { supabase } from '../lib/supabase'
import SearchableSelect from '../components/SearchableSelect'
import { useAuth } from '../contexts/AuthContext'
import { getUserPlan, getUserPlanType } from '../lib/tiers'

const api = async (fn, body) => {
  const { data: { session } } = await supabase.auth.getSession()
  const res = await fetch(`/.netlify/functions/${fn}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json.error || 'Request failed')
  return json
}

const EXPIRY_OPTS = [
  { label: '30 minutes', ms: 30 * 60 * 1000 },
  { label: '1 hour', ms: 60 * 60 * 1000 },
  { label: '3 hours', ms: 3 * 3600 * 1000 },
  { label: '12 hours', ms: 12 * 3600 * 1000 },
  { label: '24 hours', ms: 24 * 3600 * 1000 },
  { label: '48 hours (default)', ms: 48 * 3600 * 1000 },
  { label: '3 days', ms: 3 * 24 * 3600 * 1000 },
  { label: '7 days', ms: 7 * 24 * 3600 * 1000 },
]

const GRADS = ['from-rose-500 to-red-700', 'from-sky-500 to-indigo-700', 'from-emerald-500 to-teal-700', 'from-amber-500 to-orange-700', 'from-violet-500 to-purple-700', 'from-cyan-500 to-blue-700', 'from-fuchsia-500 to-pink-700']
const gradFor = (seed = '') => { let h = 0; for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0; return GRADS[h % GRADS.length] }
const DOTS = "url(\"data:image/svg+xml,%3Csvg width='40' height='40' viewBox='0 0 40 40' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='%23ffffff' fill-opacity='0.06'%3E%3Ccircle cx='5' cy='5' r='1.5'/%3E%3Ccircle cx='25' cy='15' r='1.2'/%3E%3Ccircle cx='12' cy='30' r='1.4'/%3E%3Ccircle cx='34' cy='34' r='1.6'/%3E%3C/g%3E%3C/svg%3E\")"

function countdown(iso) {
  const ms = new Date(iso).getTime() - Date.now()
  if (ms <= 0) return 'expired'
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000)
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h left`
  return h > 0 ? `${h}h ${m}m left` : `${m}m left`
}

function Avatar({ seed, size = 'md', icon: Icon }) {
  const s = size === 'lg' ? 'w-14 h-14 text-xl' : size === 'sm' ? 'w-8 h-8 text-xs' : 'w-11 h-11 text-sm'
  return (
    <div className={`${s} rounded-2xl bg-gradient-to-br ${gradFor(seed)} flex items-center justify-center text-white font-extrabold shadow-md flex-shrink-0`}>
      {Icon ? <Icon className="w-1/2 h-1/2" /> : (seed?.[0] || '?').toUpperCase()}
    </div>
  )
}

export default function CampaignConnect() {
  const { user } = useAuth()
  const planType = getUserPlanType(user)
  const plan = getUserPlan(user)
  const isAction = planType === 'action'
  const isPaidCandidate = plan !== 'scout'

  const [tab, setTab] = useState(isAction ? 'team' : 'invites')
  const [toast, setToast] = useState(null)
  const flash = (m, err) => { setToast({ m, err }); setTimeout(() => setToast(null), 3500) }

  const tabs = [
    isAction && { k: 'team', icon: Users, label: 'My Team' },
    { k: 'invites', icon: Inbox, label: 'Invitations' },
    !isAction && { k: 'managers', icon: Shield, label: 'Connected Managers' },
    { k: 'shared', icon: Send, label: 'Shared Profiles' },
  ].filter(Boolean)

  return (
    <div className="space-y-6">
      {/* ── Hero ─────────────────────────────────────────────── */}
      <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-brand-navy via-[#0d1b30] to-[#16273f] text-white p-7 sm:p-9" style={{ backgroundImage: `${DOTS}, linear-gradient(to bottom right, #0A1628, #16273f)` }}>
        <div className="relative z-10 flex flex-col sm:flex-row sm:items-center gap-6">
          <div className="flex-1">
            <div className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider bg-white/10 rounded-full px-3 py-1 mb-3 backdrop-blur">
              <Zap className="w-3.5 h-3.5" /> Campaign Connect
            </div>
            <h1 className="text-3xl sm:text-4xl font-black leading-tight">Two accounts,<br className="hidden sm:block" /> one campaign.</h1>
            <p className="text-white/60 text-sm mt-3 max-w-lg">
              {isAction
                ? 'Connect to the candidates you manage — run their to-do lists, watch their metrics, and hand off finished profiles in a click.'
                : 'Link up with your campaign manager so they can help run your to-do list and share intelligence with you securely.'}
            </p>
          </div>
          {/* connection motif */}
          <div className="flex items-center gap-3 sm:gap-4 bg-white/5 rounded-2xl px-5 py-4 backdrop-blur border border-white/10">
            <div className="text-center">
              <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-brand-red to-rose-700 flex items-center justify-center shadow-lg"><Users className="w-6 h-6" /></div>
              <div className="text-[10px] font-bold text-white/50 mt-1.5 uppercase tracking-wide">Manager</div>
            </div>
            <div className="flex flex-col items-center">
              <Link2 className="w-6 h-6 text-white/70" />
              <div className="text-[9px] font-bold text-white/40 mt-0.5">LINKED</div>
            </div>
            <div className="text-center">
              <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-sky-500 to-indigo-700 flex items-center justify-center shadow-lg"><FileText className="w-6 h-6" /></div>
              <div className="text-[10px] font-bold text-white/50 mt-1.5 uppercase tracking-wide">Candidate</div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Tabs ─────────────────────────────────────────────── */}
      <div className="flex gap-1.5 flex-wrap">
        {tabs.map(({ k, icon: Icon, label }) => (
          <button key={k} onClick={() => setTab(k)}
            className={`flex items-center gap-2 text-sm font-bold px-4 py-2.5 rounded-2xl border-2 transition-all ${tab === k ? 'bg-brand-navy border-brand-navy text-white shadow-md scale-[1.02]' : 'bg-white border-gray-200 text-gray-500 hover:border-gray-300 hover:text-gray-700'}`}>
            <Icon className="w-4 h-4" /> {label}
          </button>
        ))}
      </div>

      {tab === 'team' && isAction && <TeamPanel flash={flash} />}
      {tab === 'invites' && <InvitesPanel flash={flash} isPaidCandidate={isPaidCandidate} />}
      {tab === 'managers' && !isAction && <ManagersPanel flash={flash} />}
      {tab === 'shared' && <SharedPanel isAction={isAction} flash={flash} />}

      {toast && (
        <div className={`fixed bottom-6 right-6 px-4 py-3 rounded-2xl text-sm font-bold shadow-2xl z-50 flex items-center gap-2 ${toast.err ? 'bg-red-600 text-white' : 'bg-brand-navy text-white'}`}>
          {toast.err ? <AlertTriangle className="w-4 h-4" /> : <CheckCircle2 className="w-4 h-4" />}{toast.m}
        </div>
      )}
    </div>
  )
}

function EmptyState({ icon: Icon, title, sub }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <div className="w-16 h-16 rounded-3xl bg-gray-100 flex items-center justify-center mb-3"><Icon className="w-8 h-8 text-gray-400" /></div>
      <div className="font-bold text-gray-700">{title}</div>
      {sub && <div className="text-sm text-gray-400 mt-1 max-w-xs">{sub}</div>}
    </div>
  )
}

// ─── Action side: My Team ─────────────────────────────────────────────────────
function TeamPanel({ flash }) {
  const [links, setLinks] = useState([])
  const [email, setEmail] = useState('')
  const [relType, setRelType] = useState('team')
  const [busy, setBusy] = useState(false)
  const [active, setActive] = useState(null)
  const [lastCode, setLastCode] = useState(null)

  const load = useCallback(async () => {
    try { const r = await api('campaign-connect', { action: 'my_links' }); setLinks(r.links) } catch (e) { flash(e.message, true) }
  }, [flash])
  useEffect(() => { load() }, [load])

  const invite = async () => {
    if (!email.trim()) return
    setBusy(true)
    try { const r = await api('campaign-connect', { action: 'invite', email, relationship_type: relType }); setEmail(''); setLastCode(r.link?.invite_code || null); flash(r.invitee_has_account ? 'Invitation sent — it will appear in their app' : 'Invitation created — share the connect code'); load() }
    catch (e) { flash(e.message, true) } finally { setBusy(false) }
  }
  const revoke = async (id) => { try { await api('campaign-connect', { action: 'revoke', link_id: id }); flash('Link removed'); load() } catch (e) { flash(e.message, true) } }

  if (active) return <Workspace link={active} onBack={() => { setActive(null); load() }} flash={flash} />

  const activeCount = links.filter(l => l.status === 'active').length
  const pendingCount = links.filter(l => l.status !== 'active').length

  return (
    <div className="space-y-5">
      {/* summary strip */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <MiniStat label="Connected" value={activeCount} icon={CheckCircle2} grad="from-emerald-500 to-teal-600" />
        <MiniStat label="Pending" value={pendingCount} icon={Clock} grad="from-amber-500 to-orange-600" />
        <MiniStat label="Total" value={links.length} icon={Users} grad="from-brand-navy to-[#22364f]" />
      </div>

      {/* invite */}
      <div className="rounded-2xl border border-gray-100 bg-white shadow-sm p-5">
        <h2 className="font-bold text-gray-900 flex items-center gap-2 mb-4"><span className="w-8 h-8 rounded-xl bg-brand-red/10 flex items-center justify-center"><UserPlus className="w-4 h-4 text-brand-red" /></span> Invite a candidate</h2>
        <input className="input w-full mb-3" type="email" placeholder="candidate@email.com" value={email} onChange={e => setEmail(e.target.value)} />
        <div className="grid grid-cols-2 gap-2 mb-3">
          {[['team', 'My Team', 'Staff / consultant you hired', Users], ['outside', 'Outside org', 'Party, PAC, or affiliate', Shield]].map(([val, title, sub, Icon]) => (
            <button key={val} onClick={() => setRelType(val)}
              className={`text-left rounded-xl border-2 p-3 transition-all ${relType === val ? 'border-brand-red bg-brand-red/5' : 'border-gray-200 hover:border-gray-300'}`}>
              <Icon className={`w-4 h-4 mb-1 ${relType === val ? 'text-brand-red' : 'text-gray-400'}`} />
              <div className="text-sm font-bold text-gray-900">{title}</div>
              <div className="text-xs text-gray-400">{sub}</div>
            </button>
          ))}
        </div>
        {relType === 'outside' && (
          <div className="mb-3 flex items-start gap-2 text-xs font-semibold text-amber-700 bg-amber-50 border border-amber-200 rounded-xl p-3">
            <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <span>Coordination caution: if your organization makes independent expenditures (e.g. a PAC), directly managing a candidate's plan may count as illegal coordination under FEC rules. This is not legal advice.</span>
          </div>
        )}
        <button onClick={invite} disabled={busy} className="btn-primary w-full">{busy ? 'Sending…' : 'Send invite'}</button>
        {lastCode && (
          <div className="mt-3 relative overflow-hidden rounded-xl border-2 border-dashed border-brand-navy/30 bg-brand-navy/5 p-4 flex items-center gap-3">
            <Sparkles className="w-5 h-5 text-brand-red" />
            <div className="flex-1">
              <div className="text-xs font-semibold text-gray-500">Connect code</div>
              <div className="text-2xl font-black tracking-[0.2em] text-brand-navy">{lastCode}</div>
            </div>
            <button onClick={() => { navigator.clipboard?.writeText(lastCode); flash('Code copied') }} className="btn-primary py-2 px-3 flex items-center gap-1"><Copy className="w-4 h-4" /> Copy</button>
          </div>
        )}
        <p className="text-xs text-gray-400 mt-3">If the email matches their Badger Board account, the invite appears in their app automatically. Otherwise share the connect code — they redeem it under Campaign Connect → Invitations. They can revoke anytime.</p>
      </div>

      {/* linked candidates grid */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-bold text-gray-900">Linked candidates</h2>
          <button onClick={load} className="text-gray-400 hover:text-brand-red p-1.5 rounded-lg hover:bg-gray-100"><RefreshCw className="w-4 h-4" /></button>
        </div>
        {links.length === 0 ? (
          <div className="rounded-2xl border border-gray-100 bg-white shadow-sm"><EmptyState icon={Users} title="No candidates linked yet" sub="Send an invite above to start managing a candidate." /></div>
        ) : (
          <div className="grid sm:grid-cols-2 gap-3">
            {links.map(l => (
              <div key={l.id} className="group rounded-2xl border border-gray-100 bg-white shadow-sm hover:shadow-md transition-all p-4 flex items-center gap-3">
                <Avatar seed={l.candidate_email} />
                <div className="flex-1 min-w-0">
                  <div className="font-bold text-gray-900 text-sm truncate">{l.candidate_email}</div>
                  <div className="flex items-center gap-1.5 mt-1">
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${l.relationship_type === 'team' ? 'bg-brand-navy/10 text-brand-navy' : 'bg-amber-100 text-amber-700'}`}>{l.relationship_type === 'team' ? 'MY TEAM' : 'OUTSIDE'}</span>
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${l.status === 'active' ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500'}`}>{l.status === 'active' ? 'CONNECTED' : 'PENDING'}</span>
                  </div>
                </div>
                {l.status === 'active'
                  ? <button onClick={() => setActive(l)} className="text-sm font-bold text-white bg-brand-red rounded-xl px-3 py-2 flex items-center gap-1 hover:bg-brand-red/90">Manage <ChevronRight className="w-4 h-4" /></button>
                  : (l.invite_code && <button onClick={() => { navigator.clipboard?.writeText(l.invite_code); flash('Code copied') }} title="Copy connect code" className="text-xs font-black tracking-widest text-brand-navy bg-brand-navy/5 border border-brand-navy/20 px-2.5 py-2 rounded-xl flex items-center gap-1 hover:bg-brand-navy/10"><Copy className="w-3 h-3" /> {l.invite_code}</button>)}
                <button onClick={() => revoke(l.id)} className="text-gray-300 hover:text-red-500 p-1 opacity-0 group-hover:opacity-100 transition-opacity" title="Remove"><Trash2 className="w-4 h-4" /></button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function MiniStat({ label, value, icon: Icon, grad }) {
  return (
    <div className={`rounded-2xl bg-gradient-to-br ${grad} text-white p-4 shadow-sm`}>
      <Icon className="w-5 h-5 text-white/70 mb-2" />
      <div className="text-3xl font-black leading-none">{value}</div>
      <div className="text-xs font-semibold text-white/70 mt-1">{label}</div>
    </div>
  )
}

// ─── Action side: candidate workspace ─────────────────────────────────────────
function Workspace({ link, onBack, flash }) {
  const [ws, setWs] = useState(null)
  const [newTask, setNewTask] = useState('')
  const [myDossiers, setMyDossiers] = useState([])
  const [sendPick, setSendPick] = useState('')
  const [expiry, setExpiry] = useState(48 * 3600 * 1000)
  const cuid = link.candidate_user_id

  const load = useCallback(async () => {
    try { const r = await api('campaign-connect-delegate', { action: 'workspace', candidate_user_id: cuid }); setWs(r) }
    catch (e) { flash(e.message, true) }
  }, [cuid, flash])
  useEffect(() => { load(); (async () => {
    const { data } = await supabase.from('dossiers').select('id,title,generated_at').order('generated_at', { ascending: false }).limit(50)
    setMyDossiers(data || [])
  })() }, [load])

  const addTask = async () => { if (!newTask.trim()) return; try { await api('campaign-connect-delegate', { action: 'task_create', candidate_user_id: cuid, title: newTask }); setNewTask(''); flash('Task added'); load() } catch (e) { flash(e.message, true) } }
  const toggle = async (t) => { try { await api('campaign-connect-delegate', { action: 'task_toggle', candidate_user_id: cuid, task_id: t.id, done: !(t.status === 'done') }); load() } catch (e) { flash(e.message, true) } }
  const del = async (t) => { try { await api('campaign-connect-delegate', { action: 'task_delete', candidate_user_id: cuid, task_id: t.id }); load() } catch (e) { flash(e.message, true) } }
  const sendProfile = async () => { if (!sendPick) return; try { await api('profile-handoff', { action: 'send', candidate_user_id: cuid, dossier_id: sendPick, expires_ms: expiry }); setSendPick(''); flash('Profile sent to candidate') } catch (e) { flash(e.message, true) } }

  const m = ws?.metrics || {}
  const canManage = ws?.permissions?.manage_tasks
  const tasks = ws?.tasks || []
  const donePct = m.tasks_total ? Math.round((m.tasks_done / m.tasks_total) * 100) : 0

  return (
    <div className="space-y-5">
      <button onClick={onBack} className="text-sm font-bold text-gray-500 hover:text-brand-red flex items-center gap-1"><ArrowLeft className="w-4 h-4" /> Back to team</button>

      {/* candidate hero */}
      <div className="rounded-2xl border border-gray-100 bg-white shadow-sm p-5 flex items-center gap-4">
        <Avatar seed={link.candidate_email} size="lg" />
        <div className="flex-1 min-w-0">
          <div className="font-black text-gray-900 text-lg truncate">{link.candidate_email}</div>
          <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${link.relationship_type === 'team' ? 'bg-brand-navy/10 text-brand-navy' : 'bg-amber-100 text-amber-700'}`}>{link.relationship_type === 'team' ? 'MY TEAM' : 'OUTSIDE'} · CONNECTED</span>
        </div>
      </div>

      {/* metric tiles */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <MiniStat label="Candidates" value={m.candidates ?? '—'} icon={Users} grad="from-sky-500 to-indigo-600" />
        <MiniStat label="Profiles" value={m.profiles ?? '—'} icon={FileText} grad="from-violet-500 to-purple-700" />
        <MiniStat label="Open tasks" value={m.tasks_open ?? '—'} icon={ListChecks} grad="from-amber-500 to-orange-600" />
        <MiniStat label="Done" value={m.tasks_done ?? '—'} icon={CheckCircle2} grad="from-emerald-500 to-teal-600" />
      </div>

      {/* tasks */}
      <div className="rounded-2xl border border-gray-100 bg-white shadow-sm p-5">
        <div className="flex items-center justify-between mb-1">
          <h3 className="font-bold text-gray-900 flex items-center gap-2"><ListChecks className="w-4 h-4 text-brand-red" /> To-do list & tasks</h3>
          <span className="text-xs font-bold text-gray-400">{m.tasks_done || 0}/{m.tasks_total || 0} done</span>
        </div>
        <div className="h-2 rounded-full bg-gray-100 overflow-hidden mb-4"><div className="h-full bg-gradient-to-r from-emerald-500 to-teal-500 transition-all" style={{ width: `${donePct}%` }} /></div>
        {canManage && (
          <div className="flex gap-2 mb-3">
            <input className="input flex-1" placeholder="Add a task for this candidate…" value={newTask} onChange={e => setNewTask(e.target.value)} onKeyDown={e => e.key === 'Enter' && addTask()} />
            <button onClick={addTask} className="btn-primary">Add</button>
          </div>
        )}
        {!canManage && <p className="text-xs text-amber-600 font-semibold mb-2">View-only — this link does not permit editing tasks.</p>}
        <div className="divide-y divide-gray-100">
          {tasks.length === 0 && <EmptyState icon={ListChecks} title="No tasks yet" />}
          {tasks.map(t => (
            <div key={t.id} className="flex items-center gap-3 py-2.5 group">
              <button disabled={!canManage} onClick={() => toggle(t)} className={`w-5 h-5 rounded-lg border-2 flex items-center justify-center flex-shrink-0 transition-colors ${t.status === 'done' ? 'bg-emerald-500 border-emerald-500' : 'border-gray-300 hover:border-brand-red'} disabled:opacity-50`}>
                {t.status === 'done' && <Check className="w-3 h-3 text-white" />}
              </button>
              <div className="flex-1 min-w-0">
                <div className={`text-sm ${t.status === 'done' ? 'line-through text-gray-400' : 'text-gray-800'}`}>{t.title}</div>
                <div className="text-xs text-gray-400">{t.phase}{t.due_date ? ` · due ${t.due_date}` : ''}</div>
              </div>
              {canManage && <button onClick={() => del(t)} className="text-gray-300 hover:text-red-500 p-1 opacity-0 group-hover:opacity-100"><Trash2 className="w-4 h-4" /></button>}
            </div>
          ))}
        </div>
      </div>

      {/* send profile */}
      {ws?.permissions?.receive_profiles && (
        <div className="rounded-2xl border-2 border-brand-red/20 bg-gradient-to-br from-brand-red/5 to-white shadow-sm p-5">
          <h3 className="font-bold text-gray-900 mb-3 flex items-center gap-2"><span className="w-8 h-8 rounded-xl bg-brand-red/10 flex items-center justify-center"><Send className="w-4 h-4 text-brand-red" /></span> Send a profile to this candidate</h3>
          <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
            <SearchableSelect className="flex-1" value={sendPick} onChange={setSendPick}
              options={myDossiers.map(d => ({ value: d.id, label: d.title }))}
              placeholder="Choose one of your profiles…"
              searchPlaceholder="Search profiles…" />
            <SearchableSelect className="sm:w-48" value={expiry} onChange={v => setExpiry(Number(v))}
              options={EXPIRY_OPTS.map(o => ({ value: o.ms, label: o.label }))}
              placeholder="Link expiry" />
            <button onClick={sendProfile} disabled={!sendPick} className="btn-primary whitespace-nowrap">Send</button>
          </div>
          <p className="text-xs text-gray-400 mt-2">Viewable for the window you pick (30 min – 7 days), then hidden from them. Your copy is never deleted.</p>
        </div>
      )}
    </div>
  )
}

// ─── Invitations ──────────────────────────────────────────────────────────────
function InvitesPanel({ flash, isPaidCandidate }) {
  const [invites, setInvites] = useState([])
  const [code, setCode] = useState('')
  const load = useCallback(async () => { try { const r = await api('campaign-connect', { action: 'my_invites' }); setInvites(r.invites) } catch (e) { flash(e.message, true) } }, [flash])
  useEffect(() => { load() }, [load])

  const accept = async (id) => { try { await api('campaign-connect', { action: 'accept', link_id: id }); flash('Manager connected'); load() } catch (e) { flash(e.message, true) } }
  const decline = async (id) => { try { await api('campaign-connect', { action: 'decline', link_id: id }); flash('Invite declined'); load() } catch (e) { flash(e.message, true) } }
  const redeem = async () => { if (!code.trim()) return; try { await api('campaign-connect', { action: 'redeem', code }); setCode(''); flash('Connected!'); load() } catch (e) { flash(e.message, true) } }

  return (
    <div className="space-y-5">
      {/* redeem code */}
      <div className="rounded-2xl border-2 border-dashed border-brand-navy/25 bg-brand-navy/5 p-5">
        <h2 className="font-bold text-gray-900 flex items-center gap-2 mb-1"><Sparkles className="w-4 h-4 text-brand-red" /> Have a connect code?</h2>
        <p className="text-xs text-gray-500 mb-3">Paste the code your manager gave you to link instantly.</p>
        <div className="flex flex-col sm:flex-row gap-2">
          <input className="input flex-1 tracking-[0.25em] font-black uppercase text-center" placeholder="AB12-CD34" value={code} onChange={e => setCode(e.target.value)} onKeyDown={e => e.key === 'Enter' && redeem()} />
          <button onClick={redeem} disabled={!isPaidCandidate} className="btn-primary whitespace-nowrap disabled:opacity-50">Connect</button>
        </div>
        {!isPaidCandidate && <p className="mt-2 text-xs font-semibold text-amber-700">Connecting a manager requires a paid plan — upgrade from Scout.</p>}
      </div>

      {/* pending invites */}
      <div className="rounded-2xl border border-gray-100 bg-white shadow-sm p-5">
        <h2 className="font-bold text-gray-900 mb-3">Pending invitations</h2>
        {invites.length === 0 ? <EmptyState icon={Inbox} title="No pending invitations" sub="When a manager invites you, it shows up here." /> : (
          <div className="space-y-3">
            {invites.map(i => (
              <div key={i.id} className="rounded-xl border border-gray-100 p-4 flex items-start gap-3">
                <Avatar seed={i.relationship_type} icon={i.relationship_type === 'team' ? Users : Shield} />
                <div className="flex-1">
                  <div className="font-bold text-gray-900 text-sm">A {i.relationship_type === 'team' ? 'campaign team member' : 'organization'} wants to connect</div>
                  <div className="text-xs text-gray-400 mb-2">They'll view your metrics{i.permissions?.manage_tasks ? ', manage your to-do list' : ''} and can send you profiles. Revoke anytime.</div>
                  <div className="flex gap-2">
                    <button onClick={() => accept(i.id)} disabled={!isPaidCandidate} className="btn-primary text-sm py-1.5 disabled:opacity-50 flex items-center gap-1"><Check className="w-4 h-4" /> Accept</button>
                    <button onClick={() => decline(i.id)} className="btn-secondary text-sm py-1.5 flex items-center gap-1"><X className="w-4 h-4" /> Decline</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Connected managers ───────────────────────────────────────────────────────
function ManagersPanel({ flash }) {
  const [managers, setManagers] = useState([])
  const load = useCallback(async () => { try { const r = await api('campaign-connect', { action: 'my_managers' }); setManagers(r.managers) } catch (e) { flash(e.message, true) } }, [flash])
  useEffect(() => { load() }, [load])
  const revoke = async (id) => { try { await api('campaign-connect', { action: 'revoke', link_id: id }); flash('Access revoked'); load() } catch (e) { flash(e.message, true) } }
  return (
    <div className="rounded-2xl border border-gray-100 bg-white shadow-sm p-5">
      <h2 className="font-bold text-gray-900 mb-3">Who can access your account</h2>
      {managers.length === 0 ? <EmptyState icon={Shield} title="No managers connected" sub="Accept an invite or enter a connect code to link a manager." /> : (
        <div className="grid sm:grid-cols-2 gap-3">
          {managers.map(m => (
            <div key={m.id} className="rounded-xl border border-gray-100 p-4 flex items-center gap-3">
              <Avatar seed={m.relationship_type} icon={Shield} />
              <div className="flex-1">
                <div className="text-sm font-bold text-gray-900">{m.relationship_type === 'team' ? 'Campaign team' : 'Outside organization'}</div>
                <div className="text-xs text-gray-400">View metrics{m.permissions?.manage_tasks ? ' · manage tasks' : ''}{m.permissions?.receive_profiles ? ' · send profiles' : ''}</div>
              </div>
              <button onClick={() => revoke(m.id)} className="text-sm font-bold text-red-500 hover:underline">Revoke</button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Shared profiles ──────────────────────────────────────────────────────────
function SharedPanel({ isAction, flash }) {
  const [rows, setRows] = useState([])
  const [open, setOpen] = useState(null)
  const load = useCallback(async () => {
    try { const r = await api('profile-handoff', { action: isAction ? 'sent' : 'inbox' }); setRows(r.handoffs) } catch (e) { flash(e.message, true) }
  }, [isAction, flash])
  useEffect(() => { load(); const t = setInterval(load, 60000); return () => clearInterval(t) }, [load])

  const openProfile = async (h) => { try { const r = await api('profile-handoff', { action: 'open', handoff_id: h.id }); setOpen(r) } catch (e) { flash(e.message, true) } }
  const revoke = async (h) => { try { await api('profile-handoff', { action: 'revoke', handoff_id: h.id }); flash('Recalled'); load() } catch (e) { flash(e.message, true) } }

  return (
    <div className="rounded-2xl border border-gray-100 bg-white shadow-sm p-5">
      <h2 className="font-bold text-gray-900 mb-3">{isAction ? 'Profiles you have sent' : 'Profiles shared with you'}</h2>
      {rows.length === 0 ? <EmptyState icon={Send} title={isAction ? 'Nothing sent yet' : 'Nothing shared with you'} sub={isAction ? 'Send a profile from a linked candidate’s workspace.' : 'Profiles your manager shares will appear here with a countdown.'} /> : (
        <div className="grid sm:grid-cols-2 gap-3">
          {rows.map(h => {
            const dead = h.expired || h.status !== 'active'
            return (
              <div key={h.id} className="rounded-xl border border-gray-100 p-4 flex items-center gap-3">
                <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${dead ? 'bg-gray-100 text-gray-400' : 'bg-brand-red/10 text-brand-red'}`}><FileText className="w-5 h-5" /></div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-bold text-gray-900 truncate">{h.title || 'Profile'}</div>
                  <div className={`text-xs font-bold flex items-center gap-1 ${dead ? 'text-gray-400' : 'text-brand-red'}`}>
                    <Clock className="w-3 h-3" /> {h.status !== 'active' ? h.status : countdown(h.expires_at)}
                  </div>
                </div>
                {isAction
                  ? (!dead && <button onClick={() => revoke(h)} className="text-sm font-bold text-red-500 hover:underline">Recall</button>)
                  : <button onClick={() => openProfile(h)} className="text-sm font-bold text-white bg-brand-red rounded-xl px-3 py-2 flex items-center gap-1 hover:bg-brand-red/90"><Eye className="w-4 h-4" /> View</button>}
              </div>
            )
          })}
        </div>
      )}

      {open && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={() => setOpen(null)}>
          <div className="bg-white rounded-3xl max-w-3xl w-full max-h-[85vh] overflow-auto p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-black text-lg text-gray-900">{open.dossier?.title || 'Profile'}</h3>
              <button onClick={() => setOpen(null)} className="text-gray-400 hover:text-gray-700 p-1 rounded-lg hover:bg-gray-100"><X className="w-5 h-5" /></button>
            </div>
            <div className="inline-flex text-xs text-brand-red font-bold mb-3 items-center gap-1 bg-brand-red/10 rounded-full px-2.5 py-1"><Clock className="w-3 h-3" /> {countdown(open.handoff.expires_at)}</div>
            <div className="prose prose-sm max-w-none whitespace-pre-wrap text-sm text-gray-800">{open.dossier?.content || 'Content unavailable.'}</div>
          </div>
        </div>
      )}
    </div>
  )
}
