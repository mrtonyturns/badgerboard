// candidate/EditCandidate.jsx — the header's Edit dialog.
//
// Replaces the Profile Data tab (removed Nov 2026: its contact / finance /
// background cards were mostly empty or wrong). Only the basics a person
// actually maintains by hand: name, party, status, office, election, the
// links research uses to find the right person, and a photo.

import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import SearchableSelect from '../../components/SearchableSelect'
import { getOffices, getElections } from '../../lib/supabase'
import { candidateStatusLabel } from '../../lib/campaignEnums'
import { DB_PARTIES } from '../../lib/party'
import { Button } from '../../components/ui'

// The party picker must offer exactly what `candidates.party` accepts —
// DB_PARTIES is that CHECK constraint, in lib/party.js.
export const PARTIES = DB_PARTIES
export const STATUSES = ['exploring', 'declared', 'primary_winner', 'general', 'elected', 'lost', 'withdrawn']

function Field({ label, hint, children }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[12px] text-brand-faint">{hint}</span>}
    </label>
  )
}

export default function EditCandidate({ form, setForm, saving, error, onSave, onCancel }) {
  const [offices, setOffices] = useState([])
  const [elections, setElections] = useState([])

  useEffect(() => {
    let cancelled = false
    Promise.all([getOffices(), getElections()]).then(([o, e]) => {
      if (cancelled) return
      setOffices(o?.data || [])
      setElections(e?.data || [])
    }).catch(() => {})
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onCancel() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const f = (key) => (e) => {
    const val = e.target.type === 'checkbox' ? e.target.checked : e.target.value
    setForm(p => ({ ...p, [key]: val }))
  }

  return (
    <div
      role="presentation"
      onClick={onCancel}
      className="fixed inset-0 z-[45] flex items-start justify-center overflow-y-auto bg-black/40 p-3 md:p-8"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Edit ${form.name || 'candidate'}`}
        onClick={e => e.stopPropagation()}
        className="my-auto w-full max-w-2xl rounded-tile bg-white shadow-e5"
      >
        <div className="flex items-center gap-3 border-b border-black/5 px-6 py-4">
          <h2 className="display text-[22px]">Edit candidate</h2>
          <button type="button" onClick={onCancel} className="ml-auto rounded-xl p-2 text-brand-mute hover:bg-black/5" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="grid grid-cols-1 gap-4 px-6 py-5 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Field label="Name"><input className="input" value={form.name || ''} onChange={f('name')} /></Field>
          </div>
          <Field label="Party">
            <SearchableSelect
              value={form.party || ''}
              onChange={v => setForm(p => ({ ...p, party: v }))}
              options={[{ value: '', label: 'No party' }, ...PARTIES.map(p => ({ value: p, label: p }))]}
              placeholder="No party"
            />
          </Field>
          <Field label="Status">
            <select className="input" value={form.status || ''} onChange={f('status')}>
              {STATUSES.map(s => <option key={s} value={s}>{candidateStatusLabel(s)}</option>)}
            </select>
          </Field>
          <div className="sm:col-span-2">
            <Field label="Office">
              <SearchableSelect
                value={form.office_id || ''}
                onChange={v => setForm(p => ({ ...p, office_id: v }))}
                options={[{ value: '', label: 'No office' }, ...offices.map(o => ({
                  value: o.id,
                  label: `${o.name}${o.district_number ? ` — District ${o.district_number}` : ''}${o.district_name ? ` (${o.district_name})` : ''}${o.county ? ` · ${o.county}` : ''}`,
                }))]}
                placeholder="Select office…"
                searchPlaceholder="Search offices…"
              />
            </Field>
          </div>
          <div className="sm:col-span-2">
            <Field label="Election" hint="Sets the countdown in the header.">
              <SearchableSelect
                value={form.election_id || ''}
                onChange={v => setForm(p => ({ ...p, election_id: v }))}
                options={[{ value: '', label: 'No election' }, ...elections.map(e => ({ value: e.id, label: e.name }))]}
                placeholder="Select election…"
                searchPlaceholder="Search elections…"
              />
            </Field>
          </div>
          <label className="flex items-center gap-2.5 text-[14px] font-medium text-brand-ink sm:col-span-2">
            <input type="checkbox" className="h-4 w-4" checked={!!form.is_incumbent} onChange={f('is_incumbent')} />
            Currently holds this office
          </label>

          <div className="sm:col-span-2 mt-1 text-[12px] font-extrabold uppercase tracking-[0.1em] text-brand-faint">Links</div>
          <Field label="Website"><input className="input" value={form.website || ''} onChange={f('website')} placeholder="https://…" /></Field>
          <Field label="X handle" hint="Their X posts load on the Intel tab."><input className="input" value={form.twitter_handle || ''} onChange={f('twitter_handle')} placeholder="@handle" /></Field>
          <Field label="Facebook"><input className="input" value={form.facebook_url || ''} onChange={f('facebook_url')} placeholder="https://facebook.com/…" /></Field>
          <Field label="Instagram"><input className="input" value={form.instagram_handle || ''} onChange={f('instagram_handle')} placeholder="@handle" /></Field>
          <Field label="LinkedIn"><input className="input" value={form.linkedin_url || ''} onChange={f('linkedin_url')} placeholder="https://linkedin.com/in/…" /></Field>
          <Field label="Photo" hint="Link to a headshot (https://…)."><input className="input" value={form.photo_url || ''} onChange={f('photo_url')} placeholder="https://…/photo.jpg" /></Field>
          <div className="sm:col-span-2">
            <Field label="Who is this? (helps research find the right person)" hint={`${(form.research_context || '').length}/1000 · read every time a profile is generated`}>
              <textarea
                className="input min-h-[84px] resize-y"
                value={form.research_context || ''}
                onChange={f('research_context')}
                maxLength={1000}
                placeholder="Town, employer, profession — anything that tells them apart from someone with the same name."
              />
            </Field>
          </div>
        </div>

        {error && <div className="mx-6 mb-2 rounded-xl bg-[#FBEDEB] px-4 py-3 text-[14px] text-[#B42318]">{error}</div>}

        <div className="flex justify-end gap-2 border-t border-black/5 px-6 py-4">
          <Button variant="secondary" onClick={onCancel}>Cancel</Button>
          <Button variant="dark" onClick={onSave} disabled={saving || !String(form.name || '').trim()}>{saving ? 'Saving…' : 'Save'}</Button>
        </div>
      </div>
    </div>
  )
}
