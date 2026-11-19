// src/pages/candidates/AddCandidateSheet.jsx — "Add a candidate" for Candidate
// plans. A sheet on phones, a dialog on wider screens.
//
// Name search first (the owner's call, Nov 19 2026):
//   1. "Who are you adding?" — full name, the office they're running for, and
//      This is me / An opponent. "Look them up" asks autofill-candidate.
//   2. What the lookup found (photo, party, website, X, Facebook, plus any
//      extras) as editable fields, each found one tagged, for the user to
//      confirm — then Save.
// "Skip the lookup and fill it in myself" goes straight to step 2 with
// nothing looked up. A failed or empty lookup also lands on step 2, with
// whatever the user already typed, and says so plainly.
//
// Nothing is written until Save. "This is me" also pins
// user_metadata.self_candidate_id to the new row, so resolveSelfCandidate()
// (dashboards, welcome splash, the tiles) knows which record is the user.

import { useEffect, useMemo, useRef, useState } from 'react'
import { X, Search, ArrowLeft, Sparkles, UserRound, Swords, Check } from 'lucide-react'
import { supabase, getOffices, getElections, createCandidate } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import useFeature from '../../lib/useFeature'
import { getUserTier, SCOUT_CANDIDATE_LIMIT } from '../../lib/tiers'
import { scoutCapMessage } from '../../lib/capErrors'
import { PARTIES } from '../../lib/campaignEnums'
import { useDialog } from '../../lib/useDialog'
import { Button, Segmented, ICON_COLORS } from '../../components/ui'
import Portrait from './Portrait'
import {
  EMPTY_ADD_FORM, EXTRA_FIELDS, searchOffices, buildCandidatePayload, lookupToForm,
  isMissingColumnError, withoutColumn, defaultRole, lookupFailureMessage, cleanPhotoUrl,
} from './helpers'

const cx = (...a) => a.filter(Boolean).join(' ')
const LOOKUP_TIMEOUT_MS = 30000

function FoundTag() {
  return (
    <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-brand-red-wash px-2 py-0.5 text-[11px] font-bold text-brand-red">
      <Sparkles className="h-3 w-3" /> Found
    </span>
  )
}

function Field({ label, found, hint, className = '', children }) {
  return (
    <label className={cx('block', className)}>
      <span className="mb-1 flex items-center text-[13px] font-semibold text-brand-ink">
        {label}{found && <FoundTag />}
      </span>
      {children}
      {hint && <span className="mt-1 block text-[12px] text-brand-faint">{hint}</span>}
    </label>
  )
}

/** Free-text office with suggestions from the offices table. */
function OfficeInput({ value, officeId, offices, onChange, inputClass = 'input', placeholder }) {
  const [focused, setFocused] = useState(false)
  const hits = useMemo(
    () => (focused && !officeId ? searchOffices(value, offices) : []),
    [focused, officeId, value, offices],
  )
  return (
    <div className="relative">
      <input
        className={inputClass}
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={e => onChange(e.target.value, '')}
      />
      {officeId && (
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[#16803C]" title="Matched to a Wisconsin office">
          <Check className="h-4 w-4" />
        </span>
      )}
      {hits.length > 0 && (
        <ul role="listbox" className="absolute inset-x-0 top-full z-10 mt-1 max-h-60 overflow-y-auto rounded-xl bg-white py-1 shadow-e4">
          {hits.map(h => (
            <li key={h.office.id} role="option" aria-selected="false">
              <button
                type="button"
                // mousedown, not click: it lands before the input's blur closes the list
                onMouseDown={(e) => { e.preventDefault(); onChange(h.label, h.office.id); setFocused(false) }}
                className="block w-full px-3.5 py-2 text-left text-[14px] text-brand-ink hover:bg-black/5"
              >{h.label}</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function RoleChoice({ role, onChange }) {
  const opts = [
    { value: 'self', icon: UserRound, title: 'This is me', sub: 'My own record', color: ICON_COLORS.ink },
    { value: 'opponent', icon: Swords, title: 'An opponent', sub: 'Someone I’m running against', color: ICON_COLORS.red },
  ]
  return (
    <div className="grid grid-cols-2 gap-3" role="radiogroup" aria-label="Who is this?">
      {opts.map(o => {
        const on = role === o.value
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.value)}
            className={cx(
              'flex min-h-[104px] flex-col justify-between rounded-2xl p-4 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-ink/40',
              on ? 'text-white shadow-e2' : 'bg-white text-brand-ink ring-1 ring-black/10 hover:ring-black/25',
            )}
            style={on ? { background: o.color } : undefined}
          >
            <o.icon className="h-6 w-6" strokeWidth={2} />
            <span>
              <span className="block text-[17px] font-extrabold leading-tight tracking-display">{o.title}</span>
              <span className={cx('block text-[12.5px]', on ? 'text-white/80' : 'text-brand-mute')}>{o.sub}</span>
            </span>
          </button>
        )
      })}
    </div>
  )
}

export default function AddCandidateSheet({ candidates = [], onClose, onSaved }) {
  const { user, session } = useAuth()
  const canLookup = useFeature('autofill')
  const [step, setStep]       = useState('who')        // who | looking | confirm
  const [role, setRole]       = useState(() => defaultRole(candidates))
  const [form, setForm]       = useState(EMPTY_ADD_FORM)
  const [found, setFound]     = useState([])           // form fields the lookup filled
  const [extras, setExtras]   = useState({})
  const [note, setNote]       = useState('')
  const [outcome, setOutcome] = useState(null)         // found | nothing | failed | skipped
  const [failMsg, setFailMsg] = useState('')
  const [offices, setOffices] = useState([])
  const [elections, setElections] = useState([])
  const [saving, setSaving]   = useState(false)
  const [error, setError]     = useState('')
  const nameRef   = useRef(null)
  const abortRef  = useRef(null)
  const cancelRef = useRef(false)
  useDialog(onClose, { initialFocusRef: nameRef })

  // Reference data for the office suggestions and the election picker.
  useEffect(() => {
    let dead = false
    getOffices().then(({ data }) => { if (!dead) setOffices(data || []) }).catch(() => {})
    getElections().then(({ data }) => { if (!dead) setElections(data || []) }).catch(() => {})
    return () => { dead = true; abortRef.current?.abort() }
  }, [])
  const today = new Date().toISOString().slice(0, 10)
  const upcoming = useMemo(() => elections
    .filter(e => !e.election_date || e.election_date >= today)
    .sort((a, b) => String(a.election_date || '').localeCompare(String(b.election_date || ''))), [elections, today])

  const set = (key) => (e) => {
    const v = e?.target ? e.target.value : e
    setForm(prev => ({ ...prev, [key]: v }))
    setFound(prev => prev.filter(k => k !== key))   // an edited field is the user's now
  }
  const setOffice = (text, id) => setForm(prev => ({ ...prev, office_text: text, office_id: id || '' }))
  const name = form.name.trim()

  // Skipping drops anything an earlier lookup filled that the user never
  // touched (an edited field left `found` already), so the form starts clean.
  const skip = () => {
    if (found.length) setForm(prev => ({ ...prev, ...Object.fromEntries(found.map(k => [k, ''])) }))
    setOutcome('skipped'); setFound([]); setExtras({}); setNote('')
    setStep('confirm')
  }

  const lookUp = async () => {
    if (!name) { nameRef.current?.focus(); return }
    if (!canLookup) { skip(); return }
    setError('')
    setStep('looking')
    cancelRef.current = false
    const ctrl = new AbortController()
    abortRef.current = ctrl
    const timer = setTimeout(() => ctrl.abort(), LOOKUP_TIMEOUT_MS)
    try {
      const res = await fetch('/.netlify/functions/autofill-candidate', {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({
          name,
          party: form.party || '',
          office: form.office_text.trim(),
          election: elections.find(e => e.id === form.election_id)?.name || '',
        }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        setFailMsg(lookupFailureMessage(res.status, json.error))
        setOutcome('failed'); setFound([]); setExtras({}); setNote('')
      } else {
        const r = lookupToForm(json.fields)
        setForm(prev => ({ ...prev, ...r.patch }))
        setFound(r.found)
        setExtras(r.extras)
        setNote(r.note)
        setOutcome(r.found.length || Object.keys(r.extras).length ? 'found' : 'nothing')
      }
    } catch {
      if (cancelRef.current) { setOutcome('skipped') } else {
        setFailMsg(ctrl.signal.aborted
          ? 'The lookup took too long. Fill in what you know below.'
          : lookupFailureMessage(0))
        setOutcome('failed')
      }
      setFound([]); setExtras({}); setNote('')
    } finally {
      clearTimeout(timer)
      abortRef.current = null
      setStep('confirm')
    }
  }

  const cancelLookup = () => { cancelRef.current = true; abortRef.current?.abort() }

  const save = async (e) => {
    e?.preventDefault?.()
    if (!name) { setError('Add their name first.'); return }
    setSaving(true); setError('')
    try {
      // Scout cap: the polite pre-check; the scout_candidate_cap trigger is
      // the real gate and its error is translated below.
      if (getUserTier(user) === 'scout') {
        const { count } = await supabase.from('candidates').select('id', { count: 'exact', head: true }).eq('created_by', user.id)
        if ((count ?? 0) >= SCOUT_CANDIDATE_LIMIT) {
          setError(`The free Scout plan tracks ${SCOUT_CANDIDATE_LIMIT} people. Upgrade to add more.`)
          return
        }
      }
      const payload = buildCandidatePayload(form, { offices, extras })
      let res = await createCandidate(payload)
      // photo_url ships with its own migration; until it runs, save without it.
      if (res.error && payload.photo_url && isMissingColumnError(res.error, 'photo_url')) {
        res = await createCandidate(withoutColumn(payload, 'photo_url'))
      }
      if (res.error) {
        setError(scoutCapMessage(res.error) || res.error.message || 'Couldn’t save. Please try again.')
        return
      }
      if (role === 'self' && res.data?.id) {
        const { error: pinErr } = await supabase.auth.updateUser({ data: { self_candidate_id: res.data.id } })
        if (pinErr) console.warn('[AddCandidate] could not pin self_candidate_id:', pinErr.message)
      }
      onSaved?.(res.data, role)
    } finally {
      setSaving(false)
    }
  }

  const headline = {
    found:   'Here’s what we found',
    nothing: 'We didn’t find much',
    failed:  'Fill in the details',
    skipped: 'Fill in the details',
  }[outcome] || 'Fill in the details'
  const subline = {
    found:   'Check each detail before you save — lookups can be wrong, especially in local races.',
    nothing: `No public details turned up for ${name || 'them'}. Add what you know; you can fill in more later.`,
    failed:  failMsg,
    skipped: 'Only the name is required. You can add more later.',
  }[outcome] || ''
  const extraKeys = Object.keys(extras)
  const isFound = (k) => found.includes(k)
  const photo = cleanPhotoUrl(form.photo_url)

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4">
      <div className="absolute inset-0 bg-brand-ink/50" onClick={onClose} aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-cand-title"
        className="relative flex max-h-[94vh] w-full flex-col rounded-t-[24px] bg-brand-gray shadow-e5 sm:max-w-[560px] sm:rounded-tile"
      >
        <div className="flex items-center justify-between gap-3 px-5 pb-1 pt-5 sm:px-7">
          <span className="eyebrow">{step === 'confirm' && outcome === 'found' ? 'Check and save' : 'Add a candidate'}</span>
          <button type="button" onClick={onClose} aria-label="Close" className="flex h-9 w-9 items-center justify-center rounded-full bg-white text-brand-ink shadow-e1 hover:bg-gray-50">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* ── Step 1: who ─────────────────────────────────────────────────── */}
        {step === 'who' && (
          <form
            className="overflow-y-auto px-5 pb-6 pt-3 sm:px-7"
            onSubmit={(e) => { e.preventDefault(); lookUp() }}
          >
            <h2 id="add-cand-title" className="display text-[28px] leading-tight">Who are you adding?</h2>
            <div className="mt-5 space-y-4">
              <RoleChoice role={role} onChange={setRole} />
              <Field label="Full name">
                <input
                  ref={nameRef}
                  className="input py-3 text-[16px]"
                  value={form.name}
                  onChange={set('name')}
                  placeholder="Jane Smith"
                  autoComplete="off"
                  required
                />
              </Field>
              <Field label="Running for" hint="Free text is fine — pick a match if one shows up.">
                <OfficeInput
                  value={form.office_text}
                  officeId={form.office_id}
                  offices={offices}
                  onChange={setOffice}
                  inputClass="input py-3 text-[16px]"
                  placeholder="e.g. Marathon County Board, District 12"
                />
              </Field>
            </div>
            <Button type="submit" icon={canLookup ? Search : undefined} className="mt-6 w-full py-3 text-[16px]" disabled={!name}>
              {canLookup ? 'Look them up' : 'Continue'}
            </Button>
            {canLookup && (
              <p className="mt-2 text-center text-[12.5px] text-brand-faint">We search public info and show you what we find. Nothing is saved until you say so.</p>
            )}
            <div className="mt-4 text-center">
              <button type="button" onClick={skip} className="text-[14px] font-semibold text-brand-ink underline decoration-black/20 underline-offset-4 hover:decoration-brand-ink">
                Skip the lookup and fill it in myself
              </button>
            </div>
          </form>
        )}

        {/* ── Looking ─────────────────────────────────────────────────────── */}
        {step === 'looking' && (
          <div className="flex flex-col items-center px-6 pb-10 pt-8 text-center" aria-live="polite">
            <span className="relative inline-flex h-24 w-24 items-center justify-center rounded-full bg-white shadow-e2">
              <span className="absolute inset-0 animate-ping rounded-full bg-brand-red/10" />
              <Search className="h-9 w-9 text-brand-red" />
            </span>
            <h2 id="add-cand-title" className="display mt-6 text-[24px] leading-tight">Looking up {name}…</h2>
            <p className="mt-2 max-w-sm text-[14px] leading-relaxed text-brand-mute">Checking what’s public about them — campaign site, social accounts, party. This takes a few seconds.</p>
            <button type="button" onClick={cancelLookup} className="mt-6 text-[14px] font-semibold text-brand-mute underline underline-offset-4 hover:text-brand-ink">
              Stop and fill it in myself
            </button>
          </div>
        )}

        {/* ── Step 2: confirm / fill in ───────────────────────────────────── */}
        {step === 'confirm' && (
          <form className="flex min-h-0 flex-1 flex-col" onSubmit={save}>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4 pt-2 sm:px-7">
              <h2 id="add-cand-title" className="display text-[26px] leading-tight">{headline}</h2>
              {subline && <p className={cx('mt-1 text-[14px] leading-relaxed', outcome === 'failed' ? 'text-brand-red-dark' : 'text-brand-mute')}>{subline}</p>}

              {/* what the tile will look like */}
              <div className="mt-4 flex items-center gap-4 rounded-tile bg-white p-4 shadow-e2">
                <Portrait name={form.name || '?'} photo={photo} size={64} color={role === 'self' ? ICON_COLORS.navy : '#11161C'} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[19px] font-extrabold tracking-display text-brand-ink">{form.name || 'Their name'}</div>
                  <div className="mt-0.5 truncate text-[13.5px] text-brand-mute">
                    {[form.party, form.office_text].filter(Boolean).join(' · ') || 'Party and office will show here'}
                  </div>
                </div>
                <Segmented
                  options={[{ value: 'self', label: 'Me' }, { value: 'opponent', label: 'Opponent' }]}
                  value={role}
                  onChange={setRole}
                  className="hidden sm:inline-flex"
                />
              </div>
              <Segmented
                options={[{ value: 'self', label: 'This is me' }, { value: 'opponent', label: 'An opponent' }]}
                value={role}
                onChange={setRole}
                className="mt-3 sm:hidden"
              />

              <div className="mt-5 grid gap-4 sm:grid-cols-2">
                <Field label="Full name" className="sm:col-span-2">
                  <input className="input py-2.5" value={form.name} onChange={set('name')} required />
                </Field>
                <Field label="Party" found={isFound('party')}>
                  <select className="input py-2.5" value={form.party} onChange={set('party')}>
                    <option value="">Not sure</option>
                    {PARTIES.map(p => <option key={p} value={p}>{p}</option>)}
                  </select>
                </Field>
                <Field label="Election (optional)">
                  <select className="input py-2.5" value={form.election_id} onChange={set('election_id')}>
                    <option value="">Not sure yet</option>
                    {upcoming.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
                  </select>
                </Field>
                <Field label="Office / district" className="sm:col-span-2">
                  <OfficeInput value={form.office_text} officeId={form.office_id} offices={offices} onChange={setOffice} inputClass="input py-2.5" placeholder="e.g. State Assembly, District 86" />
                </Field>
                <Field label="Website" found={isFound('website')}>
                  <input className="input py-2.5" inputMode="url" value={form.website} onChange={set('website')} placeholder="janeforwisconsin.com" />
                </Field>
                <Field label="X / Twitter" found={isFound('twitter_handle')}>
                  <input className="input py-2.5" value={form.twitter_handle} onChange={set('twitter_handle')} placeholder="@JaneForWI" />
                </Field>
                <Field label="Facebook" found={isFound('facebook_url')}>
                  <input className="input py-2.5" inputMode="url" value={form.facebook_url} onChange={set('facebook_url')} placeholder="facebook.com/JaneForWisconsin" />
                </Field>
                <Field label="Photo link" found={isFound('photo_url')} hint={isFound('photo_url') ? 'From their website — clear it if it isn’t them.' : 'Paste an https link to a headshot.'}>
                  <input className="input py-2.5" inputMode="url" value={form.photo_url} onChange={set('photo_url')} placeholder="https://…/headshot.jpg" />
                </Field>
              </div>

              {extraKeys.length > 0 && (
                <div className="mt-5 rounded-tile bg-white p-4 shadow-e1">
                  <div className="flex items-center text-[13px] font-bold text-brand-ink">Also found <FoundTag /></div>
                  <p className="mt-0.5 text-[12.5px] text-brand-mute">Saved with them unless you remove it.</p>
                  <ul className="mt-2 divide-y divide-black/5">
                    {extraKeys.map(k => (
                      <li key={k} className="flex items-start gap-3 py-2">
                        <span className="w-24 flex-shrink-0 text-[12.5px] font-semibold text-brand-mute">{EXTRA_FIELDS[k]}</span>
                        <span className="min-w-0 flex-1 break-words text-[13.5px] text-brand-ink">{extras[k].length > 160 ? `${extras[k].slice(0, 160)}…` : extras[k]}</span>
                        <button
                          type="button"
                          aria-label={`Remove ${EXTRA_FIELDS[k]}`}
                          onClick={() => setExtras(prev => { const n = { ...prev }; delete n[k]; return n })}
                          className="flex-shrink-0 rounded-full p-1 text-brand-faint hover:bg-black/5 hover:text-brand-ink"
                        ><X className="h-3.5 w-3.5" /></button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {note && outcome === 'found' && (
                <p className="mt-4 text-[12.5px] leading-relaxed text-brand-faint">About this lookup: {note}</p>
              )}

              {error && (
                <div role="alert" className="mt-4 rounded-xl bg-brand-red-wash px-3.5 py-2.5 text-[13.5px] text-brand-red-dark">{error}</div>
              )}
            </div>

            <div className="flex gap-3 border-t border-black/5 bg-white px-5 py-4 sm:rounded-b-tile sm:px-7">
              <Button variant="secondary" icon={ArrowLeft} className="flex-1" onClick={() => setStep('who')}>Back</Button>
              <Button type="submit" className="flex-[2]" disabled={saving || !name}>
                {saving ? 'Saving…' : role === 'self' ? 'Save — this is me' : 'Save opponent'}
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
