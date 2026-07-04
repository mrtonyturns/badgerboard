// Campaign Connect — links Action accounts (managers/consultants/parties) to Candidate
// accounts. Action side: invite + manage a candidate's tasks/metrics + send profiles.
// Candidate side: accept/decline invites, see connected managers, receive profiles (48h).
import React, { useEffect, useState, useCallback } from 'react'
import {
  Users, UserPlus, Send, Clock, Check, X, Shield, ShieldCheck, AlertTriangle, RefreshCw,
  ChevronRight, ChevronDown, Inbox, Trash2, Eye, ArrowLeft, ArrowRight, Copy, Mail,
  KeyRound, Link2, ListChecks, BarChart3, Sparkles, HelpCircle, CheckCircle2, Zap,
} from 'lucide-react'
import { supabase } from '../lib/supabase'
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

function countdown(iso) {
  const ms = new Date(iso).getTime() - Date.now()
  if (ms <= 0) return 'expired'
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000)
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h left`
  return h > 0 ? `${h}h ${m}m left` : `${m}m left`
}

// Decorative connection-network backdrop for the hero
function HeroNetwork() {
  return (
    <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 800 240" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs>
        <linearGradient id="cc-line" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#A52A2A" stopOpacity="0.55" />
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0.12" />
        </linearGradient>
      </defs>
      <g fill="none" stroke="url(#cc-line)" strokeWidth="1.2">
        <path d="M60 190 C 180 90, 300 210, 430 110 S 660 60, 780 140" />
        <path d="M-20 90 C 120 160, 260 40, 420 170 S 640 210, 820 80" opacity="0.6" />
        <path d="M120 -10 C 200 120, 420 30, 560 190" opacity="0.4" />
      </g>
      <g fill="#ffffff">
        {[[60,190],[430,110],[780,140],[420,170],[120,60],[560,190],[680,90],[250,140]].map(([x,y],i) => (
          <circle key={i} cx={x} cy={y} r={i % 3 === 0 ? 4 : 2.5} opacity={i % 2 ? 0.35 : 0.7} />
        ))}
        {[[430,110],[420,170]].map(([x,y],i) => (
          <circle key={`r${i}`} cx={x} cy={y} r="8" fill="none" stroke="#A52A2A" strokeOpacity="0.6" strokeWidth="1.5" />
        ))}
      </g>
    </svg>
  )
}

// ─── How it works — visual walkthrough ────────────────────────────────────────
function HowItWorks({ isAction, open, onToggle }) {
  const steps = isAction
    ? [
        { icon: Mail, title: '1. Send an invite', body: 'Enter your candidate’s email. If it matches their Badger Board account, the invite lands inside their app instantly.' },
        { icon: KeyRound, title: '2. Or share the code', body: 'Every invite also mints a unique connect code. They paste it in their app — perfect if they signed up under a different email.' },
        { icon: Link2, title: '3. Accounts link up', body: 'The moment they accept, your accounts connect. They stay in control and can revoke your access at any time.' },
        { icon: ListChecks, title: '4. Run the campaign', body: 'Manage their to-do list, watch their metrics, and hand off completed profiles on a timer you choose — 30 minutes to 7 days.' },
      ]
    : [
        { icon: Inbox, title: '1. Invite arrives', body: 'Your manager or consultant sends an invite. It shows up right here under Invitations — or they hand you a connect code.' },
        { icon: KeyRound, title: '2. Accept or redeem', body: 'Accept the invite, or paste the connect code below. Either way the link is instant and consent-based.' },
        { icon: ShieldCheck, title: '3. You stay in control', body: 'You choose who’s connected. Every action they take is logged, and you can revoke access with one click, anytime.' },
        { icon: Send, title: '4. Receive handoffs', body: 'They can help run your to-do list and send you completed profiles that stay visible for a set window before expiring.' },
      ]
  return (
    <div className="rounded-2xl border border-gray-200 bg-white overflow-hidden">
      <button onClick={onToggle} className="w-full flex items-center gap-2.5 px-5 py-4 text-left hover:bg-gray-50 transition-colors">
        <span className="w-8 h-8 rounded-lg bg-gradient-to-br from-brand-navy to-brand-navy-light flex items-center justify-center flex-shrink-0">
          <HelpCircle className="w-4 h-4 text-white" />
        </span>
        <span className="font-bold text-gray-900 flex-1">How Campaign Connect works</span>
        <ChevronDown className={`w-5 h-5 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="px-5 pb-6 pt-1">
          {/* mini flow diagram */}
          <div className="flex items-center justify-center gap-2 sm:gap-4 mb-6 py-4 px-3 rounded-xl bg-gradient-to-r from-brand-navy/[0.04] via-brand-red/[0.04] to-brand-navy/[0.04] border border-gray-100">
            <div className="flex flex-col items-center gap-1.5">
              <div className="w-11 h-11 rounded-full bg-gradient-to-br from-brand-navy to-brand-navy-light flex items-center justify-center shadow-md">
                <Users className="w-5 h-5 text-white" />
              </div>
              <span className="text-[10px] font-extrabold uppercase tracking-wide text-brand-navy">Action</span>
            </div>
            <div className="flex-1 max-w-[90px] border-t-2 border-dashed border-gray-300 relative top-[-9px]">
              <ArrowRight className="w-4 h-4 text-gray-400 absolute -right-1 -top-2 bg-transparent" />
            </div>
            <div className="flex flex-col items-center gap-1.5">
              <div className="px-3 py-2 rounded-lg border-2 border-dashed border-brand-red/40 bg-brand-red/5 font-mono font-extrabold text-brand-red text-xs tracking-[0.2em]">AB12-CD34</div>
              <span className="text-[10px] font-extrabold uppercase tracking-wide text-brand-red">Invite + code</span>
            </div>
            <div className="flex-1 max-w-[90px] border-t-2 border-dashed border-gray-300 relative top-[-9px]">
              <ArrowRight className="w-4 h-4 text-gray-400 absolute -right-1 -top-2" />
            </div>
            <div className="flex flex-col items-center gap-1.5">
              <div className="w-11 h-11 rounded-full bg-gradient-to-br from-brand-red to-brand-red-dark flex items-center justify-center shadow-md">
                <UserPlus className="w-5 h-5 text-white" />
              </div>
              <span className="text-[10px] font-extrabold uppercase tracking-wide text-brand-red-dark">Candidate</span>
            </div>
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {steps.map((s, i) => (
              <div key={i} className="relative rounded-xl border border-gray-100 bg-gray-50/60 p-4 hover:border-brand-red/30 hover:bg-white hover:shadow-md transition-all group">
                <div className="w-9 h-9 rounded-lg bg-white border border-gray-200 shadow-sm flex items-center justify-center mb-3 group-hover:border-brand-red/40 group-hover:scale-105 transition-all">
                  <s.icon className="w-4 h-4 text-brand-red" />
                </div>
                <div className="font-bold text-sm text-gray-900 mb-1">{s.title}</div>
                <p className="text-xs text-gray-500 leading-relaxed">{s.body}</p>
                {i < steps.length - 1 && (
                  <ChevronRight className="hidden lg:block w-4 h-4 text-gray-300 absolute top-1/2 -right-[9.5px] -translate-y-1/2 z-10" />
                )}
              </div>
            ))}
          </div>

          <div className="mt-4 flex items-start gap-2 text-xs text-gray-500 bg-brand-navy/[0.03] border border-gray-100 rounded-lg p-3">
            <Shield className="w-4 h-4 text-brand-navy flex-shrink-0 mt-0.5" />
            <span><strong className="text-gray-700">Consent-first by design.</strong> Nothing is shared until the candidate accepts. Every manager action is written to an audit log the candidate can see, and access can be revoked by either side at any time.</span>
          </div>
        </div>
      )}
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
  const [showHow, setShowHow] = useState(true)
  const flash = (m, err) => { setToast({ m, err }); setTimeout(() => setToast(null), 3500) }

  return (
    <div className="space-y-5">
      {/* Hero */}
      <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-brand-navy via-brand-navy-mid to-brand-navy-light p-6 sm:p-8 shadow-lg">
        <HeroNetwork />
        <div className="relative">
          <div className="inline-flex items-center gap-1.5 text-[11px] font-extrabold uppercase tracking-wider text-white/80 bg-white/10 border border-white/15 rounded-full px-3 py-1 mb-3 backdrop-blur-sm">
            <Zap className="w-3 h-3 text-brand-red-light" /> Outreach
          </div>
          <h1 className="text-2xl sm:text-3xl font-extrabold text-white flex items-center gap-3">
            <span className="w-11 h-11 rounded-xl bg-gradient-to-br from-brand-red to-brand-red-dark flex items-center justify-center shadow-lg flex-shrink-0">
              <Users className="w-6 h-6 text-white" />
            </span>
            Campaign Connect
          </h1>
          <p className="text-white/60 text-sm mt-2.5 max-w-2xl leading-relaxed">
            {isAction
              ? 'Connect to the candidates you manage — run their to-do lists, track their metrics, and send them completed profiles.'
              : 'Connect with your campaign manager or consultant so they can help run your to-do list and share profiles with you.'}
          </p>
        </div>
      </div>

      <HowItWorks isAction={isAction} open={showHow} onToggle={() => setShowHow(v => !v)} />

      {/* Tabs */}
      <div className="inline-flex gap-1 flex-wrap bg-white border border-gray-200 rounded-full p-1 shadow-sm">
        {isAction && <TabBtn k="team" tab={tab} setTab={setTab} icon={Users} label="My Team" />}
        <TabBtn k="invites" tab={tab} setTab={setTab} icon={Inbox} label="Invitations" />
        {!isAction && <TabBtn k="managers" tab={tab} setTab={setTab} icon={Shield} label="Connected Managers" />}
        <TabBtn k="shared" tab={tab} setTab={setTab} icon={Send} label="Shared Profiles" />
      </div>

      {tab === 'team' && isAction && <TeamPanel flash={flash} />}
      {tab === 'invites' && <InvitesPanel flash={flash} isPaidCandidate={isPaidCandidate} />}
      {tab === 'managers' && !isAction && <ManagersPanel flash={flash} />}
      {tab === 'shared' && <SharedPanel isAction={isAction} flash={flash} />}

      {toast && (
        <div className={`fixed bottom-6 right-6 px-4 py-3 rounded-xl text-sm font-bold shadow-lg z-50 ${toast.err ? 'bg-red-600 text-white' : 'bg-brand-navy text-white'}`}>{toast.m}</div>
      )}
    </div>
  )
}

function TabBtn({ k, tab, setTab, icon: Icon, label }) {
  return (
    <button onClick={() => setTab(k)}
      className={`flex items-center gap-1.5 text-sm font-bold px-4 py-2 rounded-full transition-all ${tab === k ? 'bg-gradient-to-r from-brand-navy to-brand-navy-light text-white shadow-md' : 'text-gray-500 hover:text-brand-navy hover:bg-gray-50'}`}>
      <Icon className="w-4 h-4" /> {label}
    </button>
  )
}

function EmptyState({ icon: Icon, title, sub }) {
  return (
    <div className="flex flex-col items-center text-center py-10">
      <div className="relative mb-4">
        <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-brand-navy/[0.06] to-brand-red/[0.06] border border-gray-100 flex items-center justify-center">
          <Icon className="w-7 h-7 text-gray-300" />
        </div>
        <Sparkles className="w-4 h-4 text-brand-red/40 absolute -top-1 -right-1" />
      </div>
      <div className="font-bold text-gray-700 text-sm">{title}</div>
      <p className="text-xs text-gray-400 mt-1 max-w-xs">{sub}</p>
    </div>
  )
}

// ─── Action side: My Team ─────────────────────────────────────────────────────
function TeamPanel({ flash }) {
  const [links, setLinks] = useState([])
  const [email, setEmail] = useState('')
  const [relType, setRelType] = useState('team')
  const [busy, setBusy] = useState(false)
  const [active, setActive] = useState(null) // selected candidate workspace
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

  return (
    <div className="space-y-5">
      {/* Invite card */}
      <div className="rounded-2xl p-[1.5px] bg-gradient-to-r from-brand-navy via-brand-red/60 to-brand-navy shadow-sm">
        <div className="bg-white rounded-[14.5px] p-6">
          <h2 className="font-bold text-gray-900 flex items-center gap-2.5 mb-1">
            <span className="w-8 h-8 rounded-lg bg-gradient-to-br from-brand-red to-brand-red-dark flex items-center justify-center flex-shrink-0">
              <UserPlus className="w-4 h-4 text-white" />
            </span>
            Invite a candidate
          </h2>
          <p className="text-xs text-gray-400 mb-4 ml-[42px]">One invite, two ways in — in-app if their email matches, connect code either way.</p>
          <div className="flex flex-col sm:flex-row gap-3 sm:items-center">
            <input className="input flex-1" type="email" placeholder="candidate@email.com" value={email} onChange={e => setEmail(e.target.value)} />
            <select className="input sm:w-56" value={relType} onChange={e => setRelType(e.target.value)}>
              <option value="team">My Team (staff / consultant)</option>
              <option value="outside">Outside organization</option>
            </select>
            <button onClick={invite} disabled={busy} className="btn-primary whitespace-nowrap flex items-center gap-1.5"><Send className="w-4 h-4" /> {busy ? 'Sending…' : 'Send invite'}</button>
          </div>
          {relType === 'outside' && (
            <div className="mt-3 flex items-start gap-2 text-xs font-semibold text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-3">
              <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <span>Coordination caution: if your organization makes independent expenditures (e.g. a PAC), directly managing a candidate's plan may count as illegal coordination under FEC rules. Use view-only and keep your own records. This is not legal advice.</span>
            </div>
          )}
          {lastCode && (
            <div className="mt-4 flex items-center gap-3 rounded-xl border-2 border-dashed border-brand-navy/25 bg-gradient-to-r from-brand-navy/[0.04] to-brand-red/[0.04] p-4">
              <span className="w-9 h-9 rounded-lg bg-brand-navy flex items-center justify-center flex-shrink-0"><KeyRound className="w-4 h-4 text-white" /></span>
              <div className="flex-1 min-w-0">
                <div className="text-[10px] font-extrabold uppercase tracking-wider text-gray-400">Connect code</div>
                <div className="font-mono font-extrabold text-brand-navy text-xl tracking-[0.25em]">{lastCode}</div>
              </div>
              <button onClick={() => { navigator.clipboard?.writeText(lastCode); flash('Code copied') }} className="btn-secondary text-sm py-1.5 flex items-center gap-1.5 flex-shrink-0"><Copy className="w-4 h-4" /> Copy</button>
            </div>
          )}
          <p className="text-xs text-gray-400 mt-3">If the email matches their Badger Board account, the invite appears in their app automatically. Otherwise share the connect code — they redeem it under Campaign Connect → Invitations to link instantly. They can revoke access anytime.</p>
        </div>
      </div>

      {/* Linked candidates */}
      <div className="card rounded-2xl">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-bold text-gray-900 flex items-center gap-2"><Link2 className="w-4 h-4 text-brand-red" /> Linked candidates</h2>
          <button onClick={load} className="w-8 h-8 rounded-lg border border-gray-200 flex items-center justify-center text-gray-400 hover:text-brand-red hover:border-brand-red/40 transition-colors" title="Refresh"><RefreshCw className="w-4 h-4" /></button>
        </div>
        {links.length === 0 ? (
          <EmptyState icon={Users} title="No candidates linked yet" sub="Send an invite above — connected candidates show up here as manageable cards." />
        ) : (
          <div className="grid sm:grid-cols-2 gap-3">
            {links.map(l => (
              <div key={l.id} className={`relative rounded-xl border p-4 transition-all ${l.status === 'active' ? 'border-gray-200 bg-white hover:shadow-md hover:border-brand-navy/30' : 'border-dashed border-gray-300 bg-gray-50/50'}`}>
                <div className="flex items-center gap-3">
                  <div className={`w-11 h-11 rounded-full flex items-center justify-center text-white font-extrabold text-base flex-shrink-0 shadow-sm ${l.status === 'active' ? 'bg-gradient-to-br from-brand-navy to-brand-navy-light' : 'bg-gray-300'}`}>
                    {l.candidate_email[0].toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold text-gray-900 text-sm truncate">{l.candidate_email}</div>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <span className={`inline-flex items-center gap-1 text-[10px] font-extrabold uppercase tracking-wide px-2 py-0.5 rounded-full ${l.status === 'active' ? 'bg-emerald-50 text-emerald-600' : 'bg-amber-50 text-amber-600'}`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${l.status === 'active' ? 'bg-emerald-500' : 'bg-amber-400'}`} />
                        {l.status === 'active' ? 'Connected' : 'Pending'}
                      </span>
                      <span className="text-[10px] font-bold uppercase tracking-wide text-gray-400">{l.relationship_type === 'team' ? 'My Team' : 'Outside org'}</span>
                    </div>
                  </div>
                  <button onClick={() => revoke(l.id)} className="text-gray-300 hover:text-red-500 p-1 flex-shrink-0" title="Remove"><Trash2 className="w-4 h-4" /></button>
                </div>
                <div className="mt-3 pt-3 border-t border-gray-100 flex items-center justify-between gap-2">
                  {l.status === 'active'
                    ? <button onClick={() => setActive(l)} className="w-full btn-primary text-sm py-1.5 flex items-center justify-center gap-1">Manage campaign <ChevronRight className="w-4 h-4" /></button>
                    : (l.invite_code
                        ? <button onClick={() => { navigator.clipboard?.writeText(l.invite_code); flash('Code copied') }} title="Copy connect code" className="w-full text-xs font-mono font-extrabold text-brand-navy bg-brand-navy/5 border border-dashed border-brand-navy/25 px-2.5 py-2 rounded-lg flex items-center justify-center gap-1.5 hover:bg-brand-navy/10 tracking-[0.15em]"><Copy className="w-3.5 h-3.5" /> {l.invite_code}</button>
                        : <span className="w-full text-center text-xs font-bold text-amber-600 bg-amber-50 px-2.5 py-2 rounded-lg">Awaiting response</span>)}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Action side: a candidate's workspace (metrics + tasks + send profile) ─────
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
    const { data } = await supabase.from('dossiers').select('id,title,created_at').order('created_at', { ascending: false }).limit(50)
    setMyDossiers(data || [])
  })() }, [load])

  const addTask = async () => { if (!newTask.trim()) return; try { await api('campaign-connect-delegate', { action: 'task_create', candidate_user_id: cuid, title: newTask }); setNewTask(''); flash('Task added'); load() } catch (e) { flash(e.message, true) } }
  const toggle = async (t) => { try { await api('campaign-connect-delegate', { action: 'task_toggle', candidate_user_id: cuid, task_id: t.id, done: !(t.status === 'done') }); load() } catch (e) { flash(e.message, true) } }
  const del = async (t) => { try { await api('campaign-connect-delegate', { action: 'task_delete', candidate_user_id: cuid, task_id: t.id }); load() } catch (e) { flash(e.message, true) } }
  const sendProfile = async () => { if (!sendPick) return; try { await api('profile-handoff', { action: 'send', candidate_user_id: cuid, dossier_id: sendPick, expires_ms: expiry }); setSendPick(''); flash('Profile sent to candidate') } catch (e) { flash(e.message, true) } }

  const m = ws?.metrics || {}
  const canManage = ws?.permissions?.manage_tasks
  const tiles = [
    { k: 'Candidates', v: m.candidates, icon: Users, cls: 'from-brand-navy to-brand-navy-light' },
    { k: 'Profiles', v: m.profiles, icon: BarChart3, cls: 'from-brand-red to-brand-red-dark' },
    { k: 'Open tasks', v: m.tasks_open, icon: ListChecks, cls: 'from-amber-500 to-amber-600' },
    { k: 'Done', v: m.tasks_done, icon: CheckCircle2, cls: 'from-emerald-500 to-emerald-600' },
  ]
  return (
    <div className="space-y-5">
      <button onClick={onBack} className="text-sm font-bold text-gray-500 hover:text-brand-red flex items-center gap-1 transition-colors"><ArrowLeft className="w-4 h-4" /> Back to team</button>

      {/* Candidate header + metric tiles */}
      <div className="rounded-2xl overflow-hidden border border-gray-200 bg-white shadow-sm">
        <div className="bg-gradient-to-r from-brand-navy to-brand-navy-light px-6 py-5 flex items-center gap-4">
          <div className="w-12 h-12 rounded-full bg-white/10 border border-white/20 backdrop-blur-sm flex items-center justify-center text-white font-extrabold text-lg flex-shrink-0">
            {link.candidate_email[0].toUpperCase()}
          </div>
          <div className="min-w-0">
            <div className="font-bold text-white truncate">{link.candidate_email}</div>
            <div className="text-xs text-white/50 flex items-center gap-1.5 mt-0.5">
              <span className="inline-flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-emerald-400" /> Connected</span>
              · {link.relationship_type === 'team' ? 'My Team' : 'Outside org'}
            </div>
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 p-5">
          {tiles.map(({ k, v, icon: Icon, cls }) => (
            <div key={k} className={`relative overflow-hidden rounded-xl bg-gradient-to-br ${cls} p-4 text-white shadow-sm`}>
              <Icon className="w-10 h-10 absolute -right-1.5 -bottom-1.5 opacity-15" />
              <div className="text-2xl font-extrabold leading-none">{v ?? '—'}</div>
              <div className="text-[11px] font-bold uppercase tracking-wide opacity-75 mt-1.5">{k}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Tasks */}
      <div className="card rounded-2xl">
        <h3 className="font-bold text-gray-900 mb-3 flex items-center gap-2"><ListChecks className="w-4 h-4 text-brand-red" /> To-do list & tasks</h3>
        {canManage && (
          <div className="flex gap-2 mb-3">
            <input className="input flex-1" placeholder="Add a task for this candidate…" value={newTask} onChange={e => setNewTask(e.target.value)} onKeyDown={e => e.key === 'Enter' && addTask()} />
            <button onClick={addTask} className="btn-primary">Add</button>
          </div>
        )}
        {!canManage && <p className="text-xs text-amber-600 font-semibold mb-2">View-only — this link does not permit editing tasks.</p>}
        <div className="divide-y divide-gray-100">
          {(ws?.tasks || []).length === 0 && <EmptyState icon={ListChecks} title="No tasks yet" sub={canManage ? 'Add the first task above to start running this campaign.' : 'Tasks will appear here once created.'} />}
          {(ws?.tasks || []).map(t => (
            <div key={t.id} className="flex items-center gap-3 py-2.5 group">
              <button disabled={!canManage} onClick={() => toggle(t)} className={`w-5 h-5 rounded-md border-2 flex items-center justify-center flex-shrink-0 transition-colors ${t.status === 'done' ? 'bg-emerald-500 border-emerald-500' : 'border-gray-300 hover:border-brand-red'} disabled:opacity-50`}>
                {t.status === 'done' && <Check className="w-3 h-3 text-white" />}
              </button>
              <div className="flex-1 min-w-0">
                <div className={`text-sm ${t.status === 'done' ? 'line-through text-gray-400' : 'text-gray-800'}`}>{t.title}</div>
                <div className="text-xs text-gray-400">{t.phase}{t.due_date ? ` · due ${t.due_date}` : ''}</div>
              </div>
              {canManage && <button onClick={() => del(t)} className="text-gray-300 hover:text-red-500 p-1 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity"><Trash2 className="w-4 h-4" /></button>}
            </div>
          ))}
        </div>
      </div>

      {/* Send profile */}
      {ws?.permissions?.receive_profiles && (
        <div className="card rounded-2xl">
          <h3 className="font-bold text-gray-900 mb-1 flex items-center gap-2"><Send className="w-4 h-4 text-brand-red" /> Send a profile to this candidate</h3>
          <p className="text-xs text-gray-400 mb-4 flex items-center gap-1"><Clock className="w-3 h-3" /> Visible for the window you pick — 30 minutes to 7 days — then it quietly expires. Your copy is never deleted.</p>
          <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
            <select className="input flex-1" value={sendPick} onChange={e => setSendPick(e.target.value)}>
              <option value="">Choose one of your profiles…</option>
              {myDossiers.map(d => <option key={d.id} value={d.id}>{d.title}</option>)}
            </select>
            <select className="input sm:w-48" value={expiry} onChange={e => setExpiry(Number(e.target.value))}>
              {EXPIRY_OPTS.map(o => <option key={o.ms} value={o.ms}>{o.label}</option>)}
            </select>
            <button onClick={sendProfile} disabled={!sendPick} className="btn-primary whitespace-nowrap flex items-center gap-1.5"><Send className="w-4 h-4" /> Send</button>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Invitations (candidate accepts/declines) ─────────────────────────────────
function InvitesPanel({ flash, isPaidCandidate }) {
  const [invites, setInvites] = useState([])
  const load = useCallback(async () => { try { const r = await api('campaign-connect', { action: 'my_invites' }); setInvites(r.invites) } catch (e) { flash(e.message, true) } }, [flash])
  useEffect(() => { load() }, [load])

  const [code, setCode] = useState('')
  const accept = async (id) => { try { await api('campaign-connect', { action: 'accept', link_id: id }); flash('Manager connected'); load() } catch (e) { flash(e.message, true) } }
  const decline = async (id) => { try { await api('campaign-connect', { action: 'decline', link_id: id }); flash('Invite declined'); load() } catch (e) { flash(e.message, true) } }
  const redeem = async () => { if (!code.trim()) return; try { await api('campaign-connect', { action: 'redeem', code }); setCode(''); flash('Connected!'); load() } catch (e) { flash(e.message, true) } }

  return (
    <div className="space-y-5">
      {/* Redeem code */}
      <div className="rounded-2xl p-[1.5px] bg-gradient-to-r from-brand-navy via-brand-red/60 to-brand-navy shadow-sm">
        <div className="bg-white rounded-[14.5px] p-6">
          <h2 className="font-bold text-gray-900 flex items-center gap-2.5 mb-1">
            <span className="w-8 h-8 rounded-lg bg-gradient-to-br from-brand-navy to-brand-navy-light flex items-center justify-center flex-shrink-0">
              <KeyRound className="w-4 h-4 text-white" />
            </span>
            Have a connect code?
          </h2>
          <p className="text-xs text-gray-400 mb-4 ml-[42px]">Your manager can hand you a code like <span className="font-mono font-bold text-gray-500">AB12-CD34</span> — paste it here to link instantly.</p>
          <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
            <input className="input flex-1 tracking-[0.2em] font-mono font-extrabold uppercase" placeholder="AB12-CD34" value={code} onChange={e => setCode(e.target.value)} onKeyDown={e => e.key === 'Enter' && redeem()} />
            <button onClick={redeem} disabled={!isPaidCandidate} className="btn-primary whitespace-nowrap disabled:opacity-50 flex items-center gap-1.5"><Link2 className="w-4 h-4" /> Connect with code</button>
          </div>
          {!isPaidCandidate && (
            <div className="mt-3 text-xs font-semibold text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-3">
              Accepting a manager requires a paid plan. Upgrade from Scout to let a manager help run your campaign.
            </div>
          )}
        </div>
      </div>

      {/* Pending invites */}
      <div className="card rounded-2xl">
        <h2 className="font-bold text-gray-900 mb-3 flex items-center gap-2"><Inbox className="w-4 h-4 text-brand-red" /> Invitations to connect</h2>
        {invites.length === 0 ? (
          <EmptyState icon={Inbox} title="No pending invitations" sub="When a manager or consultant invites you, it lands here — or redeem their connect code above." />
        ) : (
          <div className="space-y-3">
            {invites.map(i => (
              <div key={i.id} className="rounded-xl border border-gray-200 p-4 hover:border-brand-navy/30 hover:shadow-sm transition-all">
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 rounded-full bg-gradient-to-br from-brand-navy to-brand-navy-light flex items-center justify-center flex-shrink-0">
                    <Mail className="w-4 h-4 text-white" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold text-gray-900 text-sm">A {i.relationship_type === 'team' ? 'campaign team member' : 'organization'} wants to connect to your account</div>
                    <div className="text-xs text-gray-400 mt-0.5 mb-3">They'll be able to view your metrics{i.permissions?.manage_tasks ? ', manage your to-do list' : ''} and send you profiles. You can revoke anytime.</div>
                    <div className="flex gap-2">
                      <button onClick={() => accept(i.id)} disabled={!isPaidCandidate} className="btn-primary text-sm py-1.5 disabled:opacity-50 flex items-center gap-1"><Check className="w-4 h-4" /> Accept</button>
                      <button onClick={() => decline(i.id)} className="btn-secondary text-sm py-1.5 flex items-center gap-1"><X className="w-4 h-4" /> Decline</button>
                    </div>
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

// ─── Connected managers (candidate revokes) ───────────────────────────────────
function ManagersPanel({ flash }) {
  const [managers, setManagers] = useState([])
  const load = useCallback(async () => { try { const r = await api('campaign-connect', { action: 'my_managers' }); setManagers(r.managers) } catch (e) { flash(e.message, true) } }, [flash])
  useEffect(() => { load() }, [load])
  const revoke = async (id) => { try { await api('campaign-connect', { action: 'revoke', link_id: id }); flash('Access revoked'); load() } catch (e) { flash(e.message, true) } }
  return (
    <div className="card rounded-2xl">
      <h2 className="font-bold text-gray-900 mb-1 flex items-center gap-2"><ShieldCheck className="w-4 h-4 text-brand-red" /> Who can access your account</h2>
      <p className="text-xs text-gray-400 mb-4">You're in control — revoke anyone's access instantly, no questions asked.</p>
      {managers.length === 0 ? (
        <EmptyState icon={Shield} title="No managers connected" sub="Accept an invitation or redeem a connect code to let a manager help run your campaign." />
      ) : (
        <div className="grid sm:grid-cols-2 gap-3">
          {managers.map(mg => (
            <div key={mg.id} className="rounded-xl border border-gray-200 p-4 hover:shadow-sm transition-all">
              <div className="flex items-center gap-3 mb-3">
                <div className="w-10 h-10 rounded-full bg-gradient-to-br from-brand-navy to-brand-navy-light flex items-center justify-center flex-shrink-0">
                  <Shield className="w-4 h-4 text-white" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-gray-900">{mg.relationship_type === 'team' ? 'Campaign team' : 'Outside organization'}</div>
                  <div className="text-[10px] font-bold uppercase tracking-wide text-emerald-600 flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500" /> Active link</div>
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5 mb-3">
                <span className="text-[10px] font-bold uppercase tracking-wide bg-gray-100 text-gray-500 px-2 py-1 rounded-full">View metrics</span>
                {mg.permissions?.manage_tasks && <span className="text-[10px] font-bold uppercase tracking-wide bg-gray-100 text-gray-500 px-2 py-1 rounded-full">Manage tasks</span>}
                {mg.permissions?.receive_profiles && <span className="text-[10px] font-bold uppercase tracking-wide bg-gray-100 text-gray-500 px-2 py-1 rounded-full">Send profiles</span>}
              </div>
              <button onClick={() => revoke(mg.id)} className="w-full text-sm font-bold text-red-500 border border-red-200 hover:bg-red-50 rounded-lg py-1.5 transition-colors">Revoke access</button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Shared profiles (candidate inbox / action sent) ──────────────────────────
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
    <div className="card rounded-2xl">
      <h2 className="font-bold text-gray-900 mb-1 flex items-center gap-2"><Send className="w-4 h-4 text-brand-red" /> {isAction ? 'Profiles you have sent' : 'Profiles shared with you'}</h2>
      <p className="text-xs text-gray-400 mb-4">{isAction ? 'Each handoff runs on its own timer — recall one early anytime.' : 'Shared profiles stay readable until their timer runs out.'}</p>
      {rows.length === 0 ? (
        <EmptyState icon={Send} title={isAction ? 'Nothing sent yet' : 'Nothing shared with you right now'} sub={isAction ? 'Open a linked candidate and send them a completed profile — it shows up here with a live countdown.' : 'When a manager sends you a profile, it appears here with a live countdown.'} />
      ) : (
        <div className="space-y-2.5">
          {rows.map(h => {
            const live = h.status === 'active' && !h.expired
            return (
              <div key={h.id} className={`flex items-center gap-3 rounded-xl border p-3.5 transition-all ${live ? 'border-gray-200 bg-white hover:shadow-sm' : 'border-gray-100 bg-gray-50/60'}`}>
                <div className={`w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 ${live ? 'bg-gradient-to-br from-brand-red to-brand-red-dark' : 'bg-gray-200'}`}>
                  <Send className={`w-4 h-4 ${live ? 'text-white' : 'text-gray-400'}`} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className={`text-sm font-semibold truncate ${live ? 'text-gray-900' : 'text-gray-400'}`}>{h.title || 'Profile'}</div>
                  <div className={`text-xs flex items-center gap-1 mt-0.5 ${live ? 'text-brand-red font-bold' : 'text-gray-400'}`}>
                    <Clock className="w-3 h-3" /> {h.status !== 'active' ? h.status : countdown(h.expires_at)}
                  </div>
                </div>
                {isAction
                  ? (live && <button onClick={() => revoke(h)} className="text-sm font-bold text-red-500 border border-red-200 hover:bg-red-50 rounded-lg px-3 py-1.5 transition-colors flex-shrink-0">Recall</button>)
                  : <button onClick={() => openProfile(h)} className="btn-primary text-sm py-1.5 flex items-center gap-1 flex-shrink-0"><Eye className="w-4 h-4" /> View</button>}
              </div>
            )
          })}
        </div>
      )}

      {open && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setOpen(null)}>
          <div className="bg-white rounded-2xl max-w-3xl w-full max-h-[85vh] overflow-auto p-6 shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-bold text-lg text-gray-900">{open.dossier?.title || 'Profile'}</h3>
              <button onClick={() => setOpen(null)} className="text-gray-400 hover:text-gray-700"><X className="w-5 h-5" /></button>
            </div>
            <div className="inline-flex items-center gap-1.5 text-xs text-brand-red font-bold mb-3 bg-brand-red/5 border border-brand-red/15 rounded-full px-3 py-1"><Clock className="w-3 h-3" /> {countdown(open.handoff.expires_at)}</div>
            <div className="prose prose-sm max-w-none whitespace-pre-wrap text-sm text-gray-800">{open.dossier?.content || 'Content unavailable.'}</div>
          </div>
        </div>
      )}
    </div>
  )
}
