// Campaign Connect — links Action accounts (managers/consultants/parties) to Candidate
// accounts. Action side: invite + manage a candidate's tasks/metrics + send profiles.
// Candidate side: accept/decline invites, see connected managers, receive profiles (48h).
import React, { useEffect, useState, useCallback } from 'react'
import { Users, UserPlus, Send, Clock, Check, X, Shield, AlertTriangle, RefreshCw, ChevronRight, Inbox, Trash2, Eye, ArrowLeft, Copy } from 'lucide-react'
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

export default function CampaignConnect() {
  const { user } = useAuth()
  const planType = getUserPlanType(user)
  const plan = getUserPlan(user)
  const isAction = planType === 'action'
  const isPaidCandidate = plan !== 'scout'

  const [tab, setTab] = useState(isAction ? 'team' : 'invites')
  const [toast, setToast] = useState(null)
  const flash = (m, err) => { setToast({ m, err }); setTimeout(() => setToast(null), 3500) }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2"><Users className="w-6 h-6 text-brand-red" /> Campaign Connect</h1>
        <p className="text-gray-500 text-sm mt-1">
          {isAction
            ? 'Connect to the candidates you manage — run their to-do lists, track their metrics, and send them completed profiles.'
            : 'Connect with your campaign manager or consultant so they can help run your to-do list and share profiles with you.'}
        </p>
      </div>

      <div className="flex gap-1.5 flex-wrap">
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
      className={`flex items-center gap-1.5 text-sm font-bold px-3.5 py-2 rounded-full border-2 transition-colors ${tab === k ? 'bg-brand-navy border-brand-navy text-white' : 'bg-white border-gray-200 text-gray-500 hover:border-gray-300'}`}>
      <Icon className="w-4 h-4" /> {label}
    </button>
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
      <div className="card">
        <h2 className="font-bold text-gray-900 flex items-center gap-2 mb-3"><UserPlus className="w-4 h-4 text-brand-red" /> Invite a candidate</h2>
        <div className="flex flex-col sm:flex-row gap-3 sm:items-center">
          <input className="input flex-1" type="email" placeholder="candidate@email.com" value={email} onChange={e => setEmail(e.target.value)} />
          <select className="input sm:w-56" value={relType} onChange={e => setRelType(e.target.value)}>
            <option value="team">My Team (staff / consultant)</option>
            <option value="outside">Outside organization</option>
          </select>
          <button onClick={invite} disabled={busy} className="btn-primary whitespace-nowrap">{busy ? 'Sending…' : 'Send invite'}</button>
        </div>
        {relType === 'outside' && (
          <div className="mt-3 flex items-start gap-2 text-xs font-semibold text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-3">
            <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <span>Coordination caution: if your organization makes independent expenditures (e.g. a PAC), directly managing a candidate's plan may count as illegal coordination under FEC rules. Use view-only and keep your own records. This is not legal advice.</span>
          </div>
        )}
        {lastCode && (
          <div className="mt-3 flex items-center gap-2 text-sm font-bold text-brand-navy bg-brand-navy/5 border border-brand-navy/20 rounded-lg p-3">
            <span className="text-gray-500 font-semibold">Connect code:</span>
            <span className="tracking-widest text-lg">{lastCode}</span>
            <button onClick={() => { navigator.clipboard?.writeText(lastCode); flash('Code copied') }} className="ml-auto text-brand-red hover:underline flex items-center gap-1"><Copy className="w-4 h-4" /> Copy</button>
          </div>
        )}
        <p className="text-xs text-gray-400 mt-2">If the email matches their Badger Board account, the invite appears in their app automatically. Otherwise share the connect code — they redeem it under Campaign Connect → Invitations to link instantly. They can revoke access anytime.</p>
      </div>

      <div className="card">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-bold text-gray-900">Linked candidates</h2>
          <button onClick={load} className="text-gray-400 hover:text-brand-red"><RefreshCw className="w-4 h-4" /></button>
        </div>
        {links.length === 0 ? <p className="text-sm text-gray-400">No candidates linked yet. Send an invite above.</p> : (
          <div className="divide-y divide-gray-100">
            {links.map(l => (
              <div key={l.id} className="flex items-center gap-3 py-3">
                <div className="w-9 h-9 rounded-full bg-brand-navy/10 flex items-center justify-center text-brand-navy font-bold text-sm">{l.candidate_email[0].toUpperCase()}</div>
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-gray-900 text-sm truncate">{l.candidate_email}</div>
                  <div className="text-xs text-gray-400">{l.relationship_type === 'team' ? 'My Team' : 'Outside org'} · {l.status === 'active' ? 'Connected' : 'Invite pending'}</div>
                </div>
                {l.status === 'active'
                  ? <button onClick={() => setActive(l)} className="text-sm font-bold text-brand-red hover:underline flex items-center gap-1">Manage <ChevronRight className="w-4 h-4" /></button>
                  : (l.invite_code
                      ? <button onClick={() => { navigator.clipboard?.writeText(l.invite_code); flash('Code copied') }} title="Copy connect code" className="text-xs font-bold text-brand-navy bg-brand-navy/5 border border-brand-navy/20 px-2.5 py-1 rounded-full flex items-center gap-1 hover:bg-brand-navy/10"><Copy className="w-3 h-3" /> {l.invite_code}</button>
                      : <span className="text-xs font-bold text-amber-600 bg-amber-50 px-2.5 py-1 rounded-full">Pending</span>)}
                <button onClick={() => revoke(l.id)} className="text-gray-300 hover:text-red-500 p-1" title="Remove"><Trash2 className="w-4 h-4" /></button>
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
  return (
    <div className="space-y-5">
      <button onClick={onBack} className="text-sm font-bold text-gray-500 hover:text-brand-red flex items-center gap-1"><ArrowLeft className="w-4 h-4" /> Back to team</button>
      <div className="card">
        <div className="font-bold text-gray-900">{link.candidate_email}</div>
        <div className="text-xs text-gray-400 mb-3">{link.relationship_type === 'team' ? 'My Team' : 'Outside org'} · Connected</div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[['Candidates', m.candidates], ['Profiles', m.profiles], ['Open tasks', m.tasks_open], ['Done', m.tasks_done]].map(([k, v]) => (
            <div key={k} className="bg-gray-50 rounded-xl p-3 text-center">
              <div className="text-2xl font-extrabold text-brand-navy">{v ?? '—'}</div>
              <div className="text-xs font-semibold text-gray-500">{k}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <h3 className="font-bold text-gray-900 mb-3">To-do list & tasks</h3>
        {canManage && (
          <div className="flex gap-2 mb-3">
            <input className="input flex-1" placeholder="Add a task for this candidate…" value={newTask} onChange={e => setNewTask(e.target.value)} onKeyDown={e => e.key === 'Enter' && addTask()} />
            <button onClick={addTask} className="btn-primary">Add</button>
          </div>
        )}
        {!canManage && <p className="text-xs text-amber-600 font-semibold mb-2">View-only — this link does not permit editing tasks.</p>}
        <div className="divide-y divide-gray-100">
          {(ws?.tasks || []).length === 0 && <p className="text-sm text-gray-400 py-2">No tasks yet.</p>}
          {(ws?.tasks || []).map(t => (
            <div key={t.id} className="flex items-center gap-3 py-2.5">
              <button disabled={!canManage} onClick={() => toggle(t)} className={`w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0 ${t.status === 'done' ? 'bg-green-500 border-green-500' : 'border-gray-300'} disabled:opacity-50`}>
                {t.status === 'done' && <Check className="w-3 h-3 text-white" />}
              </button>
              <div className="flex-1 min-w-0">
                <div className={`text-sm ${t.status === 'done' ? 'line-through text-gray-400' : 'text-gray-800'}`}>{t.title}</div>
                <div className="text-xs text-gray-400">{t.phase}{t.due_date ? ` · due ${t.due_date}` : ''}</div>
              </div>
              {canManage && <button onClick={() => del(t)} className="text-gray-300 hover:text-red-500 p-1"><Trash2 className="w-4 h-4" /></button>}
            </div>
          ))}
        </div>
      </div>

      {ws?.permissions?.receive_profiles && (
        <div className="card">
          <h3 className="font-bold text-gray-900 mb-3 flex items-center gap-2"><Send className="w-4 h-4 text-brand-red" /> Send a profile to this candidate</h3>
          <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
            <select className="input flex-1" value={sendPick} onChange={e => setSendPick(e.target.value)}>
              <option value="">Choose one of your profiles…</option>
              {myDossiers.map(d => <option key={d.id} value={d.id}>{d.title}</option>)}
            </select>
            <select className="input sm:w-48" value={expiry} onChange={e => setExpiry(Number(e.target.value))}>
              {EXPIRY_OPTS.map(o => <option key={o.ms} value={o.ms}>{o.label}</option>)}
            </select>
            <button onClick={sendProfile} disabled={!sendPick} className="btn-primary whitespace-nowrap">Send</button>
          </div>
          <p className="text-xs text-gray-400 mt-2">The candidate can view it for the window you pick (30 min – 7 days). After that it's hidden from them — your copy is never deleted.</p>
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
    <div className="card">
      <h2 className="font-bold text-gray-900 mb-3">Invitations to connect</h2>
      <div className="mb-4 flex flex-col sm:flex-row gap-2 sm:items-center">
        <input className="input flex-1 tracking-widest font-bold uppercase" placeholder="Enter connect code (e.g. AB12-CD34)" value={code} onChange={e => setCode(e.target.value)} onKeyDown={e => e.key === 'Enter' && redeem()} />
        <button onClick={redeem} disabled={!isPaidCandidate} className="btn-primary whitespace-nowrap disabled:opacity-50">Connect with code</button>
      </div>
      {!isPaidCandidate && (
        <div className="mb-3 text-xs font-semibold text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-3">
          Accepting a manager requires a paid plan. Upgrade from Scout to let a manager help run your campaign.
        </div>
      )}
      {invites.length === 0 ? <p className="text-sm text-gray-400">No pending invitations.</p> : (
        <div className="divide-y divide-gray-100">
          {invites.map(i => (
            <div key={i.id} className="py-3">
              <div className="font-semibold text-gray-900 text-sm">A {i.relationship_type === 'team' ? 'campaign team member' : 'organization'} wants to connect to your account</div>
              <div className="text-xs text-gray-400 mb-2">They'll be able to view your metrics{i.permissions?.manage_tasks ? ', manage your to-do list' : ''} and send you profiles. You can revoke anytime.</div>
              <div className="flex gap-2">
                <button onClick={() => accept(i.id)} disabled={!isPaidCandidate} className="btn-primary text-sm py-1.5 disabled:opacity-50 flex items-center gap-1"><Check className="w-4 h-4" /> Accept</button>
                <button onClick={() => decline(i.id)} className="btn-secondary text-sm py-1.5 flex items-center gap-1"><X className="w-4 h-4" /> Decline</button>
              </div>
            </div>
          ))}
        </div>
      )}
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
    <div className="card">
      <h2 className="font-bold text-gray-900 mb-3">Who can access your account</h2>
      {managers.length === 0 ? <p className="text-sm text-gray-400">No managers connected.</p> : (
        <div className="divide-y divide-gray-100">
          {managers.map(m => (
            <div key={m.id} className="flex items-center gap-3 py-3">
              <Shield className="w-5 h-5 text-brand-navy" />
              <div className="flex-1">
                <div className="text-sm font-semibold text-gray-900">{m.relationship_type === 'team' ? 'Campaign team' : 'Outside organization'}</div>
                <div className="text-xs text-gray-400">Can view metrics{m.permissions?.manage_tasks ? ' · manage tasks' : ''}{m.permissions?.receive_profiles ? ' · send profiles' : ''}</div>
              </div>
              <button onClick={() => revoke(m.id)} className="text-sm font-bold text-red-500 hover:underline">Revoke</button>
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
    <div className="card">
      <h2 className="font-bold text-gray-900 mb-3">{isAction ? 'Profiles you have sent' : 'Profiles shared with you'}</h2>
      {rows.length === 0 ? <p className="text-sm text-gray-400">{isAction ? 'You have not sent any profiles yet.' : 'Nothing shared with you right now.'}</p> : (
        <div className="divide-y divide-gray-100">
          {rows.map(h => (
            <div key={h.id} className="flex items-center gap-3 py-3">
              <Send className="w-5 h-5 text-brand-red flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-gray-900 truncate">{h.title || 'Profile'}</div>
                <div className={`text-xs flex items-center gap-1 ${h.expired || h.status !== 'active' ? 'text-gray-400' : 'text-brand-red font-bold'}`}>
                  <Clock className="w-3 h-3" /> {h.status !== 'active' ? h.status : countdown(h.expires_at)}
                </div>
              </div>
              {isAction
                ? (h.status === 'active' && !h.expired && <button onClick={() => revoke(h)} className="text-sm font-bold text-red-500 hover:underline">Recall</button>)
                : <button onClick={() => openProfile(h)} className="text-sm font-bold text-brand-red hover:underline flex items-center gap-1"><Eye className="w-4 h-4" /> View</button>}
            </div>
          ))}
        </div>
      )}

      {open && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={() => setOpen(null)}>
          <div className="bg-white rounded-2xl max-w-3xl w-full max-h-[85vh] overflow-auto p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-bold text-lg text-gray-900">{open.dossier?.title || 'Profile'}</h3>
              <button onClick={() => setOpen(null)} className="text-gray-400 hover:text-gray-700"><X className="w-5 h-5" /></button>
            </div>
            <div className="text-xs text-brand-red font-bold mb-3 flex items-center gap-1"><Clock className="w-3 h-3" /> {countdown(open.handoff.expires_at)}</div>
            <div className="prose prose-sm max-w-none whitespace-pre-wrap text-sm text-gray-800">{open.dossier?.content || 'Content unavailable.'}</div>
          </div>
        </div>
      )}
    </div>
  )
}
