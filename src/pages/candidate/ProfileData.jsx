// candidate/ProfileData.jsx — SPEC-candidate-profile.md §6.
//
// The old Profile tab's fields, regrouped into four cards (Contact, Campaign,
// Finance, Background), each stamped from candidates.section_timestamps. The
// edit/save flow is the one that already exists: the page owns `editing` and
// `form`, this view renders inputs when editing and read rows when not.

import React, { useEffect, useMemo, useState } from 'react'
import SearchableSelect from '../../components/SearchableSelect'
import { getOfficeOptions, getElections } from '../../lib/supabase'
import { candidateStatusLabel } from '../../lib/campaignEnums'
import { DB_PARTIES } from '../../lib/party'
import { hasFindings } from '../../lib/profileContent'
import { officeLine } from '../../lib/office'
import { T, Card, EmptyState, fmtDate } from './shared'

// The party picker must offer exactly what `candidates.party` accepts — this
// list was hand-maintained and had fallen a value behind (no 'Working
// Families'), so the one party you could not pick here was one the DB allows.
// DB_PARTIES is that CHECK constraint, in lib/party.js.
export const PARTIES = DB_PARTIES
export const STATUSES = ['exploring', 'declared', 'primary_winner', 'general', 'elected', 'lost', 'withdrawn']

// Which section_timestamps key stamps which card. `contact` / `campaign` are
// already written by the existing flow; finance and background fall back to the
// whole-profile stamp when they have never been touched individually.
export const CARD_STAMP_KEYS = {
  contact:    'contact',
  campaign:   'campaign',
  finance:    'finance',
  background: 'background',
}

const inputStyle = {
  width: '100%', boxSizing: 'border-box', border: '1px solid #DEDEDA', borderRadius: 9,
  padding: '9px 12px', fontSize: 12.5, fontFamily: 'inherit', outline: 'none',
  minHeight: 38, background: '#fff', color: T.ink,
}

function Stamp({ timestamps, cardKey }) {
  const ts = timestamps?.[CARD_STAMP_KEYS[cardKey]] || timestamps?.profile
  if (!ts?.updated_at) return <span style={{ marginLeft: 'auto', fontSize: 10.5, color: T.faint }}>Never edited</span>
  const who = ts.updated_by ? String(ts.updated_by).split('@')[0] : 'You'
  return (
    <span style={{ marginLeft: 'auto', fontSize: 10.5, color: T.faint }}>
      {who} · {fmtDate(ts.updated_at)}
    </span>
  )
}

function DataCard({ title, timestamps, cardKey, children }) {
  return (
    <Card style={{ padding: '18px 20px', borderRadius: 14 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', marginBottom: 12, gap: 8 }}>
        <span style={{ fontSize: 13.5, fontWeight: 700 }}>{title}</span>
        <Stamp timestamps={timestamps} cardKey={cardKey} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>{children}</div>
    </Card>
  )
}

function Row({ k, v }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
      <span style={{ flexShrink: 0, width: 112, fontSize: 11.5, color: T.faint }}>{k}</span>
      <span style={{ fontSize: 12.5, fontWeight: 500, minWidth: 0, wordBreak: 'break-word' }}>
        {v || <span style={{ color: T.faint, fontWeight: 400 }}>Not on file</span>}
      </span>
    </div>
  )
}

function EditRow({ k, children }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: T.muted, fontWeight: 600, marginBottom: 4 }}>{k}</div>
      {children}
    </div>
  )
}

const money = (v) => (v == null || v === '' ? null : `$${Number(v).toLocaleString()}`)

// ── Office / Election pickers ────────────────────────────────────────────────
// The header says "No office linked — set one under Profile Data", but this
// form never had an Office or Election field, so there was nowhere to set one.
// Same pickers as the Candidates page's add/edit modal; the office list is
// ~7,400 rows so it is fetched lazily (first time the form opens) with only
// the label columns, and grouped by level so the search stays navigable.
const LEVEL_ORDER = ['federal', 'state', 'county', 'municipal']
const LEVEL_LABEL = { federal: 'Federal', state: 'State', county: 'County', municipal: 'Municipal' }

/** "State Representative — Assembly District 87 (Marathon)" */
export function officeOptionLabel(o) {
  const base = officeLine(o, { empty: '' })
  const place = o?.county || o?.city
  return place && !String(base).includes(place) ? `${base} (${place})` : base
}

/** "Fall General Election 2026 — Nov 3, 2026" */
export function electionOptionLabel(e) {
  const when = e?.election_date ? fmtDate(e.election_date, 'MMM d, yyyy') : ''
  return when ? `${e.name} — ${when}` : (e?.name || '')
}

export function groupOfficeOptions(offices) {
  const byLevel = new Map()
  for (const o of offices || []) {
    const lvl = o.level || 'other'
    if (!byLevel.has(lvl)) byLevel.set(lvl, [])
    byLevel.get(lvl).push({ value: o.id, label: officeOptionLabel(o) })
  }
  const levels = [...byLevel.keys()].sort((a, b) => {
    const ia = LEVEL_ORDER.indexOf(a), ib = LEVEL_ORDER.indexOf(b)
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
  })
  return levels.map(l => ({ label: LEVEL_LABEL[l] || l, options: byLevel.get(l) }))
}

function useReferenceOptions(active) {
  const [offices, setOffices] = useState(null)
  const [elections, setElections] = useState(null)
  useEffect(() => {
    if (!active || offices) return
    let alive = true
    Promise.all([getOfficeOptions(), getElections()]).then(([o, e]) => {
      if (!alive) return
      setOffices(o.data || [])
      setElections(e.data || [])
    })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])
  return { offices, elections }
}

export default function ProfileData({ candidate, editing, form, setForm, timestamps }) {
  const f = (key) => (e) => {
    const val = e.target.type === 'checkbox' ? e.target.checked : e.target.value
    setForm(p => ({ ...p, [key]: val }))
  }
  const c = editing ? form : candidate
  const { offices, elections } = useReferenceOptions(editing)
  const officeGroups = useMemo(() => {
    const groups = groupOfficeOptions(offices)
    // Keep the currently linked office selectable even before the list lands.
    if (!offices && candidate?.office?.id) return [{ label: null, options: [{ value: candidate.office.id, label: officeOptionLabel(candidate.office) }] }]
    return groups
  }, [offices, candidate?.office])
  const electionOptions = useMemo(() => {
    if (!elections) return candidate?.election?.id ? [{ value: candidate.election.id, label: electionOptionLabel(candidate.election) }] : []
    return elections.map(e => ({ value: e.id, label: electionOptionLabel(e) }))
  }, [elections, candidate?.election])

  const emails = (c.email || '').split(',').map(e => e.trim()).filter(Boolean)
  const emailRows = editing
    ? ((form.email || '').split(',').map(e => e.trim()).some(Boolean)
        ? (form.email || '').split(',').map(e => e.trim())
        : [''])
    : emails

  const setEmailAt = (idx, value) => {
    const list = (form.email || '').split(',').map(v => v.trim())
    while (list.length <= idx) list.push('')
    list[idx] = value
    setForm(p => ({ ...p, email: list.join(',') }))
  }

  return (
    <div className="cp-cols2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, alignItems: 'start' }}>

      {/* ── Contact ── */}
      <DataCard title="Contact" timestamps={timestamps} cardKey="contact">
        {editing ? (
          <>
            <EditRow k="Email addresses">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {emailRows.map((val, idx) => (
                  <div key={idx} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <input
                      style={inputStyle}
                      type="email"
                      value={val}
                      onChange={e => setEmailAt(idx, e.target.value)}
                      placeholder={idx === 0 ? 'primary@example.com' : 'additional@example.com'}
                    />
                    {emailRows.length > 1 && (
                      <button
                        type="button"
                        onClick={() => {
                          const list = (form.email || '').split(',').map(v => v.trim())
                          list.splice(idx, 1)
                          setForm(p => ({ ...p, email: list.filter(Boolean).join(',') }))
                        }}
                        style={{
                          border: 0, background: 'none', color: T.faint, cursor: 'pointer',
                          fontSize: 14, width: 32, minHeight: 38,
                        }}
                        aria-label="Remove email"
                      >×</button>
                    )}
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => {
                    const list = (form.email || '').split(',').map(e => e.trim()).filter(Boolean)
                    setForm(p => ({ ...p, email: [...list, ''].join(',') }))
                  }}
                  style={{
                    alignSelf: 'flex-start', border: 0, background: 'none', color: T.red,
                    fontSize: 11.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', padding: '6px 0',
                  }}
                >+ Add email</button>
              </div>
            </EditRow>
            <EditRow k="Phone"><input style={inputStyle} type="tel" value={form.phone || ''} onChange={f('phone')} placeholder="(608) 555-0100" /></EditRow>
            <EditRow k="Website"><input style={inputStyle} value={form.website || ''} onChange={f('website')} placeholder="https://…" /></EditRow>
            <EditRow k="Address"><input style={inputStyle} value={form.campaign_address || ''} onChange={f('campaign_address')} /></EditRow>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <EditRow k="City"><input style={inputStyle} value={form.campaign_city || ''} onChange={f('campaign_city')} /></EditRow>
              <EditRow k="ZIP"><input style={inputStyle} value={form.campaign_zip || ''} onChange={f('campaign_zip')} /></EditRow>
            </div>
            <EditRow k="X / Twitter"><input style={inputStyle} value={form.twitter_handle || ''} onChange={f('twitter_handle')} placeholder="@handle" /></EditRow>
            <EditRow k="Facebook"><input style={inputStyle} value={form.facebook_url || ''} onChange={f('facebook_url')} placeholder="https://facebook.com/…" /></EditRow>
            <EditRow k="Instagram"><input style={inputStyle} value={form.instagram_handle || ''} onChange={f('instagram_handle')} placeholder="@handle" /></EditRow>
          </>
        ) : (
          <>
            {emails.length === 0 && <Row k="Email" v={null} />}
            {emails.map((e, i) => (
              <Row key={e} k={i === 0 ? 'Email' : 'Email (alt)'} v={<a className="cp-a" href={`mailto:${e}`}>{e}</a>} />
            ))}
            <Row k="Phone" v={candidate.phone ? <a className="cp-a" href={`tel:${candidate.phone}`}>{candidate.phone}</a> : null} />
            <Row k="Website" v={candidate.website
              ? <a className="cp-a" href={candidate.website} target="_blank" rel="noopener noreferrer">{candidate.website}</a>
              : null} />
            <Row k="Address" v={[candidate.campaign_address, candidate.campaign_city, candidate.campaign_zip].filter(Boolean).join(', ') || null} />
            <Row k="X / Twitter" v={candidate.twitter_handle
              ? <a className="cp-a" href={`https://x.com/${String(candidate.twitter_handle).replace('@', '')}`} target="_blank" rel="noopener noreferrer">{candidate.twitter_handle}</a>
              : null} />
            <Row k="Facebook" v={candidate.facebook_url
              ? <a className="cp-a" href={candidate.facebook_url} target="_blank" rel="noopener noreferrer">Facebook page</a>
              : null} />
            <Row k="Instagram" v={candidate.instagram_handle
              ? <a className="cp-a" href={`https://instagram.com/${String(candidate.instagram_handle).replace('@', '')}`} target="_blank" rel="noopener noreferrer">{candidate.instagram_handle}</a>
              : null} />
          </>
        )}
      </DataCard>

      {/* ── Campaign ── */}
      <DataCard title="Campaign" timestamps={timestamps} cardKey="campaign">
        {editing ? (
          <>
            <EditRow k="Name"><input style={inputStyle} value={form.name || ''} onChange={f('name')} /></EditRow>
            <EditRow k="Party">
              <SearchableSelect
                value={form.party || ''}
                onChange={v => setForm(p => ({ ...p, party: v }))}
                options={[{ value: '', label: 'No party' }, ...PARTIES.map(p => ({ value: p, label: p }))]}
                placeholder="No party"
              />
            </EditRow>
            <EditRow k="Status">
              <SearchableSelect
                value={form.status || ''}
                onChange={v => setForm(p => ({ ...p, status: v }))}
                options={STATUSES.map(s => ({ value: s, label: candidateStatusLabel(s) }))}
              />
            </EditRow>
            <EditRow k="Office">
              <SearchableSelect
                value={form.office_id || ''}
                onChange={v => setForm(p => ({ ...p, office_id: v || null }))}
                groups={[{ label: null, options: [{ value: '', label: 'No office' }] }, ...officeGroups]}
                placeholder={offices ? 'Select office…' : 'Loading offices…'}
                searchPlaceholder="Search offices…"
              />
            </EditRow>
            <EditRow k="Election">
              <SearchableSelect
                value={form.election_id || ''}
                onChange={v => setForm(p => ({ ...p, election_id: v || null }))}
                options={[{ value: '', label: 'No election' }, ...electionOptions]}
                placeholder={elections ? 'Select election…' : 'Loading elections…'}
                searchPlaceholder="Search elections…"
              />
            </EditRow>
            <EditRow k="Committee"><input style={inputStyle} value={form.campaign_committee || ''} onChange={f('campaign_committee')} /></EditRow>
            <EditRow k="Campaign manager"><input style={inputStyle} value={form.campaign_manager || ''} onChange={f('campaign_manager')} /></EditRow>
            <EditRow k="Treasurer"><input style={inputStyle} value={form.treasurer || ''} onChange={f('treasurer')} /></EditRow>
          </>
        ) : (
          <>
            <Row k="Name" v={candidate.name} />
            <Row k="Party" v={candidate.party} />
            <Row k="Status" v={candidateStatusLabel(candidate.status)} />
            <Row k="Office" v={candidate.office ? officeOptionLabel(candidate.office) : null} />
            <Row k="Election" v={candidate.election ? electionOptionLabel(candidate.election) : null} />
            <Row k="Committee" v={candidate.campaign_committee} />
            <Row k="Campaign manager" v={candidate.campaign_manager} />
            <Row k="Treasurer" v={candidate.treasurer} />
          </>
        )}
      </DataCard>

      {/* ── Finance ── */}
      <DataCard title="Finance" timestamps={timestamps} cardKey="finance">
        {editing ? (
          <>
            <EditRow k="Total raised ($)"><input style={inputStyle} type="number" value={form.total_raised || ''} onChange={f('total_raised')} /></EditRow>
            <EditRow k="Total spent ($)"><input style={inputStyle} type="number" value={form.total_spent || ''} onChange={f('total_spent')} /></EditRow>
            <EditRow k="Cash on hand ($)"><input style={inputStyle} type="number" value={form.cash_on_hand || ''} onChange={f('cash_on_hand')} /></EditRow>
          </>
        ) : (
          (candidate.total_raised == null && candidate.total_spent == null && candidate.cash_on_hand == null) ? (
            <EmptyState
              title="No finance figures on file"
              body="Enter totals from the candidate’s campaign finance report with Edit, or generate a profile — Section 5 researches them."
            />
          ) : (
            <>
              <Row k="Total raised" v={money(candidate.total_raised)} />
              <Row k="Total spent" v={money(candidate.total_spent)} />
              <Row k="Cash on hand" v={money(candidate.cash_on_hand)} />
            </>
          )
        )}
      </DataCard>

      {/* ── Background ── */}
      <DataCard title="Background" timestamps={timestamps} cardKey="background">
        {editing ? (
          <>
            <EditRow k="Occupation"><input style={inputStyle} value={form.occupation || ''} onChange={f('occupation')} /></EditRow>
            <EditRow k="Employer"><input style={inputStyle} value={form.employer || ''} onChange={f('employer')} /></EditRow>
            <EditRow k="Incumbent">
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, minHeight: 38 }}>
                <input type="checkbox" checked={!!form.is_incumbent} onChange={f('is_incumbent')} />
                Currently holds this office
              </label>
            </EditRow>
            {form.is_incumbent && (
              <EditRow k="Incumbent since">
                <input style={inputStyle} type="date" value={form.incumbent_since || ''} onChange={f('incumbent_since')} />
              </EditRow>
            )}
            <EditRow k="Bio / summary">
              <textarea
                style={{ ...inputStyle, minHeight: 110, resize: 'vertical', lineHeight: 1.55 }}
                value={form.bio_summary || ''}
                onChange={f('bio_summary')}
                placeholder="Candidate background, political history, key issues…"
              />
            </EditRow>
            <EditRow k="Profile research context">
              <textarea
                style={{ ...inputStyle, minHeight: 84, resize: 'vertical', lineHeight: 1.55 }}
                value={form.research_context || ''}
                onChange={f('research_context')}
                maxLength={1000}
                placeholder="City, employer, profession — anything that helps the profiler find the right person."
              />
              <div style={{ fontSize: 10.5, color: T.faint, marginTop: 4 }}>
                {(form.research_context || '').length}/1000 characters · loaded every time you generate a profile
              </div>
            </EditRow>
          </>
        ) : (
          <>
            <Row k="Occupation" v={candidate.occupation} />
            <Row k="Employer" v={candidate.employer} />
            <Row k="Incumbent" v={candidate.is_incumbent
              ? `Yes${candidate.incumbent_since ? ` · since ${fmtDate(candidate.incumbent_since, 'MMM yyyy')}` : ''}`
              : 'No'} />
            <div style={{ borderTop: `1px solid ${T.divider}`, paddingTop: 10, marginTop: 2 }}>
              <div style={{ fontSize: 11.5, color: T.faint, marginBottom: 4 }}>Bio / summary</div>
              <div style={{ fontSize: 12.5, lineHeight: 1.6, color: T.ink2, whiteSpace: 'pre-line' }}>
                {(candidate.bio_summary && hasFindings(candidate.bio_summary) ? candidate.bio_summary : null) || (
                  <span style={{ color: T.faint }}>
                    No bio on file. Generate a profile to auto-populate one, or add it with Edit.
                  </span>
                )}
              </div>
            </div>
            <div style={{ borderTop: `1px solid ${T.divider}`, paddingTop: 10, marginTop: 2 }}>
              <div style={{ fontSize: 11.5, color: T.faint, marginBottom: 4 }}>Profile research context</div>
              <div style={{ fontSize: 12.5, lineHeight: 1.6, color: T.ink2, whiteSpace: 'pre-line' }}>
                {candidate.research_context || (
                  <span style={{ color: T.faint }}>
                    No research context set. Adding city, employer or profession improves profile accuracy for this candidate.
                  </span>
                )}
              </div>
            </div>
          </>
        )}
      </DataCard>
    </div>
  )
}
