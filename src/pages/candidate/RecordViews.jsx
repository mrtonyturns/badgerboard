// candidate/RecordViews.jsx — SPEC-candidate-profile.md §5, Record group.
//
//   Election Results · Incumbent Record · Profile History
//
// Election Results keeps the Realtime subscription that updates vote counts live
// on election night. Incumbent Record keeps the full manual CRUD, the type
// filter pills and the AI-research extract/add-all flow. Profile History lists
// every generated profile newest-first with Auto/Manual and its item count.

import React, { useEffect, useState, useRef } from 'react'
import { format } from 'date-fns'
import {
  supabase, logActivity,
  createIncumbentRecord, updateIncumbentRecord, deleteIncumbentRecord,
} from '../../lib/supabase'
import {
  T, Card, EmptyState, CtaButton, TextLink, Btn, ViewHead, NewBadge,
  LockedView, Spinner, fmtDate, fmtInt, safeISO,
  fetchDossierContent, computeSectionDiff,
} from './shared'
import { RESULTS_ENABLED } from '../../lib/featureFlags'
import SearchableSelect from '../../components/SearchableSelect'

const RECORD_TYPES = ['bill', 'act', 'regulation', 'law', 'legal', 'vote', 'other']
const VOTE_RESULTS = ['yes', 'no', 'abstain', 'absent', 'not_applicable']
const SIGNIFICANCE = ['major', 'notable', 'minor']

const TYPE_HEX = {
  bill:       { c: '#1D4ED8', bg: '#E7F0FD' },
  act:        { c: '#7C3AED', bg: '#F3EDFB' },
  regulation: { c: '#C2410C', bg: '#FFEDD5' },
  law:        { c: '#15803D', bg: '#E6F5EC' },
  legal:      { c: '#B91C1C', bg: '#FBEAEA' },
  vote:       { c: '#4338CA', bg: '#EEF0FE' },
  other:      { c: '#52525B', bg: '#F1F1EF' },
}
const SIG_HEX = {
  major:   { c: '#B91C1C', bg: '#FBEAEA' },
  notable: { c: '#B45309', bg: '#FDF3E3' },
  minor:   { c: '#71717A', bg: '#F1F1EF' },
}
const VOTE_MARK = { yes: 'Voted yes', no: 'Voted no', abstain: 'Abstained', absent: 'Absent' }

const inputStyle = {
  width: '100%', boxSizing: 'border-box', border: '1px solid #DEDEDA', borderRadius: 9,
  padding: '9px 12px', fontSize: 12.5, fontFamily: 'inherit', outline: 'none', minHeight: 38,
  background: '#fff', color: T.ink,
}
const labelStyle = { display: 'block', fontSize: 11, color: T.muted, marginBottom: 4, fontWeight: 600 }

function Field({ label, children }) {
  return <div><span style={labelStyle}>{label}</span>{children}</div>
}

// ═══ Election Results ═════════════════════════════════════════════════════════

// Last word of a name, lower-cased and stripped of punctuation ("Ott," → "ott").
const lastNameOf = (name) => String(name || '')
  .trim().split(/\s+/).pop()?.replace(/[^\p{L}\p{N}'-]/gu, '').toLowerCase() || ''

export function ElectionResultsView({ candidate, nav }) {
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(true)
  const [isLive, setIsLive] = useState(false)
  // A failed load used to be console.error only, so a broken query and a
  // genuinely empty record both rendered "No election results on file".
  const [loadError, setLoadError] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  // Realtime needs to know which rows are on screen without re-subscribing
  // every time they change.
  const rowsRef = useRef([])
  useEffect(() => { rowsRef.current = results }, [results])

  useEffect(() => {
    if (!candidate?.id) return
    let cancelled = false
    const load = async () => {
      setLoading(true)
      setLoadError(false)
      try {
        const sel = '*, contest:election_contests(*, election:elections(id, name, election_date, type))'
        const { data: rows, error: qErr } = await supabase
          .from('election_results').select(sel)
          .eq('candidate_id', candidate.id)
          .order('updated_at', { ascending: false })
        if (qErr) throw qErr
        let mapped = (rows || []).map(r => ({ result: r, contest: r.contest, election: r.contest?.election }))
        if (!mapped.length) {
          // Fallback: name match for results that were never linked by id.
          // The `ilike` is only a coarse net — a substring match happily
          // attributes "Scott" to a candidate named "Ott", so every row is
          // re-checked client-side: the row's LAST word must equal this
          // candidate's last name.
          const lastName = lastNameOf(candidate.name)
          if (lastName.length > 2) {
            const { data: nameRows, error: nameErr } = await supabase
              .from('election_results').select(sel)
              .ilike('candidate_name', `%${lastName}%`)
              .order('updated_at', { ascending: false })
              .limit(50)
            if (nameErr) throw nameErr
            mapped = (nameRows || [])
              .filter(r => lastNameOf(r.candidate_name) === lastName)
              .slice(0, 20)
              .map(r => ({ result: r, contest: r.contest, election: r.contest?.election }))
          }
        }
        if (!cancelled) setResults(mapped)
      } catch (err) {
        console.error('[CandidateProfile] election results load error:', err)
        if (!cancelled) { setResults([]); setLoadError(true) }
      }
      if (!cancelled) setLoading(false)
    }
    load()
    return () => { cancelled = true }
  }, [candidate?.id, candidate?.name, reloadKey])

  // Realtime. The old subscription filtered on candidate_id — but the rows this
  // view shows are mostly matched by name and carry no candidate_id, so the
  // filter could never fire. Subscribe unfiltered and match the payload against
  // the rows actually on screen. The channel topic gets a random suffix so two
  // mounts (or a remount before cleanup lands) never collide on one topic.
  useEffect(() => {
    if (!candidate?.id) return
    const topic = `cand-results-${candidate.id}-${Math.random().toString(36).slice(2, 8)}`
    const channel = supabase
      .channel(topic)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'election_results' }, (payload) => {
        const row = payload.new
        if (!row?.id) return
        if (!rowsRef.current.some(r => r.result?.id === row.id)) return
        setResults(prev => prev.map(r => (r.result.id === row.id ? { ...r, result: { ...r.result, ...row } } : r)))
        setIsLive(true)
      })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [candidate?.id])

  if (loading) return <Card style={{ padding: 20 }}><Spinner /></Card>

  return (
    <Card style={{ padding: '20px 24px' }}>
      <ViewHead
        title="Election results"
        sub={results.length ? `${results.length} race${results.length === 1 ? '' : 's'}` : null}
        right={isLive ? (
          <span style={{ fontSize: 10.5, fontWeight: 700, color: T.red }}>LIVE</span>
        ) : null}
      />
      {loadError ? (
        <EmptyState
          title="Couldn't load election results"
          body="The results query failed — this is a connection problem, not an empty record. Try again in a moment."
          action={<CtaButton onClick={() => setReloadKey(k => k + 1)}>Retry</CtaButton>}
        />
      ) : !results.length ? (
        <EmptyState
          title="No election results on file"
          body={`Results populate automatically from the WEC feed when ${candidate.name} appears in a Wisconsin election that BadgerBoard is tracking.`}
          action={<CtaButton onClick={() => nav('/elections')}>Open elections calendar</CtaButton>}
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {results.map(({ result, contest, election }) => {
            const pct = result.vote_pct != null ? Number(result.vote_pct) : null
            const won = result.winner && result.declared
            const outcome = won ? 'Won' : result.votes > 0 ? 'Lost' : 'Pending'
            const oc = won ? { c: '#15803D', bg: '#E6F5EC' }
              : outcome === 'Lost' ? { c: '#DC2626', bg: '#FDECEC' }
              : { c: T.muted, bg: T.chip }
            return (
              <div key={result.id} style={{ padding: '12px 0', borderTop: `1px solid ${T.divider}` }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, marginBottom: 6, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 12.5, fontWeight: 600 }}>{contest?.office || 'Race not named'}</span>
                  <span style={{ fontSize: 11, color: T.faint }}>
                    {[election?.name, election?.election_date ? fmtDate(election.election_date, 'MMM d, yyyy') : null]
                      .filter(Boolean).join(' · ')}
                  </span>
                  <span style={{
                    marginLeft: 'auto', fontSize: 10.5, fontWeight: 700,
                    color: oc.c, background: oc.bg, borderRadius: 99, padding: '3px 10px',
                  }}>{outcome}</span>
                </div>
                {pct != null && (
                  <>
                    <div style={{ display: 'flex', height: 8, borderRadius: 99, overflow: 'hidden', background: T.chip }}>
                      <div style={{
                        width: `${Math.max(0, Math.min(100, pct))}%`,
                        background: won ? '#15803D' : '#DC2626',
                      }} />
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10.5, color: T.faint, marginTop: 4 }}>
                      <span>{result.votes != null ? `${fmtInt(Number(result.votes))} votes` : 'Votes not reported'}</span>
                      <span>{pct.toFixed(1)}%</span>
                    </div>
                  </>
                )}
                {pct == null && result.votes != null && (
                  <div style={{ fontSize: 10.5, color: T.faint }}>{fmtInt(Number(result.votes))} votes · share not reported</div>
                )}
                {RESULTS_ENABLED && election?.id && (
                  <div style={{ marginTop: 8 }}>
                    <TextLink onClick={() => nav(`/elections?tab=results&election=${election.id}`)}>
                      View full race results →
                    </TextLink>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}

// ═══ Incumbent Record ═════════════════════════════════════════════════════════

function RecordForm({ candidateId, userId, existing, onSave, onCancel }) {
  const blank = {
    candidate_id: candidateId, record_type: 'bill', title: '', description: '',
    bill_number: '', vote_result: 'not_applicable', date: '', significance: 'notable',
    url: '', source: '', notes: '', created_by: userId,
  }
  const [form, setForm] = useState(existing ? { ...existing } : blank)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const f = (key) => (e) => setForm(p => ({ ...p, [key]: e.target.value }))
  // SearchableSelect hands back the value directly, not an event
  const fv = (key) => (v) => setForm(p => ({ ...p, [key]: v }))

  const handleSave = async () => {
    if (!form.title.trim()) return
    setSaving(true)
    setSaveError('')
    // An empty date must go in as NULL — '' is not a valid DATE and the insert
    // is rejected outright.
    const payload = { ...form, date: form.date || null }
    let error = null
    if (existing?.id) {
      ({ error } = await updateIncumbentRecord(existing.id, payload))
      if (!error) {
        logActivity('update', 'incumbent_record', existing.id, {
          candidate_id: candidateId, record_title: form.title, record_type: form.record_type,
        }).catch(() => {})
      }
    } else {
      ({ error } = await createIncumbentRecord(payload))
      if (!error) {
        logActivity('create', 'incumbent_record', candidateId, {
          candidate_id: candidateId, record_title: form.title, record_type: form.record_type, source: 'manual',
        }).catch(() => {})
      }
    }
    setSaving(false)
    if (error) {
      setSaveError(error.message || 'Could not save this record. Please try again.')
      return
    }
    onSave()
  }

  return (
    <div style={{
      background: T.hover, border: `1px solid ${T.border}`, borderRadius: 12,
      padding: 16, display: 'flex', flexDirection: 'column', gap: 12,
    }}>
      <div className="cp-cols2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field label="Type">
          <SearchableSelect value={form.record_type} onChange={fv('record_type')}
            options={RECORD_TYPES.map(t => ({ value: t, label: t.charAt(0).toUpperCase() + t.slice(1) }))} />
        </Field>
        <Field label="Significance">
          <SearchableSelect value={form.significance} onChange={fv('significance')}
            options={SIGNIFICANCE.map(s => ({ value: s, label: s.charAt(0).toUpperCase() + s.slice(1) }))} />
        </Field>
      </div>
      <Field label="Title">
        <input style={inputStyle} value={form.title} onChange={f('title')}
          placeholder="e.g. Assembly Bill 123 — Property Tax Reform" />
      </Field>
      <div className="cp-cols2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field label="Bill / case number">
          <input style={inputStyle} value={form.bill_number || ''} onChange={f('bill_number')} placeholder="AB 123" />
        </Field>
        <Field label="Vote result">
          <SearchableSelect value={form.vote_result} onChange={fv('vote_result')}
            options={VOTE_RESULTS.map(v => ({ value: v, label: v.replace(/_/g, ' ') }))} />
        </Field>
      </div>
      <Field label="Date">
        <input style={inputStyle} type="date" value={form.date || ''} onChange={f('date')} />
      </Field>
      <Field label="Description">
        <textarea style={{ ...inputStyle, minHeight: 76, resize: 'vertical', lineHeight: 1.55 }}
          value={form.description || ''} onChange={f('description')}
          placeholder="Brief summary of what this bill, act or event involved…" />
      </Field>
      <div className="cp-cols2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field label="Source">
          <input style={inputStyle} value={form.source || ''} onChange={f('source')}
            placeholder="Wisconsin Legislature, WI Courts…" />
        </Field>
        <Field label="URL">
          <input style={inputStyle} value={form.url || ''} onChange={f('url')} placeholder="https://…" />
        </Field>
      </div>
      <Field label="Notes">
        <input style={inputStyle} value={form.notes || ''} onChange={f('notes')} placeholder="Additional context…" />
      </Field>
      {saveError && (
        <div style={{ fontSize: 11.5, color: T.redHot }}>{saveError}</div>
      )}
      <div style={{ display: 'flex', gap: 7, justifyContent: 'flex-end' }}>
        <Btn onClick={onCancel}>Cancel</Btn>
        <Btn kind="primary" onClick={handleSave} disabled={saving || !form.title.trim()}>
          {saving ? 'Saving…' : existing ? 'Update record' : 'Add record'}
        </Btn>
      </div>
    </div>
  )
}

function RecordRow({ record, onEdit, onDelete }) {
  const [open, setOpen] = useState(false)
  const ty = TYPE_HEX[record.record_type] || TYPE_HEX.other
  const sg = SIG_HEX[record.significance] || SIG_HEX.minor
  const d = safeISO(record.date)
  return (
    <div style={{ border: `1px solid ${T.border}`, borderRadius: 12, overflow: 'hidden' }}>
      <div
        className="cp-row"
        role="button"
        tabIndex={0}
        onClick={() => setOpen(o => !o)}
        onKeyDown={e => { if (e.key === 'Enter') setOpen(o => !o) }}
        style={{
          display: 'flex', alignItems: 'center', gap: 10, padding: 12,
          cursor: 'pointer', borderRadius: 0, minHeight: 44,
        }}
      >
        <span style={{
          fontSize: 9, fontWeight: 700, letterSpacing: '.4px', textTransform: 'uppercase',
          color: ty.c, background: ty.bg, borderRadius: 99, padding: '3px 9px', flexShrink: 0,
        }}>{record.record_type}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {record.title}
          </div>
          <div style={{ fontSize: 10.5, color: T.faint, marginTop: 1 }}>
            {[record.bill_number, VOTE_MARK[record.vote_result], d ? format(d, 'MMM yyyy') : null]
              .filter(Boolean).join(' · ') || 'No number or date recorded'}
          </div>
        </div>
        {record.significance && (
          <span style={{
            fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase', flexShrink: 0,
            color: sg.c, background: sg.bg, borderRadius: 99, padding: '3px 9px',
          }}>{record.significance}</span>
        )}
        <span style={{ flexShrink: 0, fontSize: 12, color: '#C0BFBA' }}>{open ? '▴' : '▾'}</span>
      </div>
      {open && (
        <div style={{ padding: '4px 14px 14px', borderTop: `1px solid ${T.divider}`, background: '#fff' }}>
          {record.description && (
            <div style={{ fontSize: 12.5, color: T.ink2, lineHeight: 1.6, marginTop: 10 }}>{record.description}</div>
          )}
          {record.notes && (
            <div style={{ fontSize: 11.5, color: T.faint, marginTop: 8 }}>{record.notes}</div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12, flexWrap: 'wrap' }}>
            {record.source && <span style={{ fontSize: 11, color: T.faint }}>Source: {record.source}</span>}
            {record.url && (
              <a className="cp-a" href={record.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11.5 }}>
                View source →
              </a>
            )}
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 7 }}>
              <Btn onClick={() => onEdit(record)}>Edit</Btn>
              <Btn onClick={() => onDelete(record.id)}>Delete</Btn>
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

const cleanRecordForInsert = (record, candidateId, userId) => ({
  candidate_id: record.candidate_id || candidateId,
  record_type:  record.record_type || 'other',
  title:        (record.title || '').slice(0, 200),
  description:  record.description || '',
  bill_number:  record.bill_number || null,
  vote_result:  record.vote_result || 'not_applicable',
  significance: record.significance || 'notable',
  date:         (record.date && /^\d{4}-\d{2}-\d{2}$/.test(record.date)) ? record.date : null,
  source:       record.source || null,
  notes:        record.notes || null,
  url:          record.url || null,
  created_by:   userId || null,
})

export function IncumbentRecordView({ candidate, records, dossiers, userId, onRefresh, timestamps }) {
  const [showForm, setShowForm] = useState(false)
  const [editingRecord, setEditingRecord] = useState(null)
  const [filter, setFilter] = useState('all')
  const [researching, setResearching] = useState(false)
  const [suggested, setSuggested] = useState(null)
  const [error, setError] = useState('')
  const [addingAll, setAddingAll] = useState(false)

  const stamp = timestamps?.incumbent

  const handleDelete = async (recordId) => {
    if (!window.confirm('Delete this record?')) return
    const record = records.find(r => r.id === recordId)
    logActivity('delete', 'incumbent_record', recordId, {
      candidate_id: candidate.id, candidate_name: candidate.name, record_title: record?.title,
    }).catch(() => {})
    await deleteIncumbentRecord(recordId)
    onRefresh()
  }

  const handleResearch = async () => {
    setResearching(true); setError(''); setSuggested(null)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch('/.netlify/functions/research-incumbent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token || ''}` },
        body: JSON.stringify({ candidate_id: candidate.id, candidate_name: candidate.name }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Research failed')
      if (!data.records?.length) {
        setError('No incumbent record items were found in this candidate’s profile. It may not contain enough legislative or voting history.')
      } else {
        setSuggested(data)
      }
    } catch (err) { setError(err.message || 'Research failed') }
    setResearching(false)
  }

  const addSuggested = async (record) => {
    const { error: err } = await createIncumbentRecord(cleanRecordForInsert(record, candidate.id, userId))
    if (err) { setError(`Failed to save "${record.title}": ${err.message || 'unknown error'}`); return }
    logActivity('create', 'incumbent_record', candidate.id, {
      candidate_name: candidate.name, record_title: record.title,
      record_type: record.record_type, source: 'ai_research',
    }).catch(() => {})
    setSuggested(prev => prev ? { ...prev, records: prev.records.filter(r => r !== record) } : null)
    onRefresh()
  }

  const addAllSuggested = async () => {
    if (!suggested?.records?.length) return
    setAddingAll(true)
    const failures = []
    for (const record of suggested.records) {
      const { error: err } = await createIncumbentRecord(cleanRecordForInsert(record, candidate.id, userId))
      if (err) failures.push(record.title)
    }
    logActivity('create', 'incumbent_record', candidate.id, {
      candidate_name: candidate.name, source: 'ai_research_bulk',
      count: suggested.records.length - failures.length,
    }).catch(() => {})
    if (failures.length) setError(`Failed to save ${failures.length} record(s): ${failures.join(', ')}`)
    setSuggested(null)
    await onRefresh()
    setAddingAll(false)
  }

  const filtered = filter === 'all' ? records : records.filter(r => r.record_type === filter)

  return (
    <Card style={{ padding: '20px 24px' }}>
      <ViewHead
        title="Incumbent record"
        sub="votes, sponsorships & public positions"
        right={
          <span style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
            {dossiers?.length > 0 && (
              <Btn onClick={handleResearch} disabled={researching}>
                {researching ? 'Researching…' : 'AI research'}
              </Btn>
            )}
            <Btn kind="primary" onClick={() => { setShowForm(true); setEditingRecord(null) }}>Add record</Btn>
          </span>
        }
      />

      {stamp?.updated_at && (
        <div style={{ fontSize: 10.5, color: T.faint, marginTop: -8, marginBottom: 12 }}>
          Updated {fmtDate(stamp.updated_at, 'MMM d, yyyy')}{stamp.updated_by ? ` · ${stamp.updated_by}` : ''}
        </div>
      )}

      {error && (
        <div style={{
          background: T.warmBg, border: `1px solid ${T.warmBr}`, borderRadius: 12,
          padding: '10px 14px', fontSize: 11.5, color: T.warmInk, marginBottom: 14,
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <span style={{ flex: 1 }}>{error}</span>
          <TextLink onClick={() => setError('')}>Dismiss</TextLink>
        </div>
      )}

      {suggested?.records?.length > 0 && (
        <div style={{
          background: '#F6F9FE', border: '1px solid #DBE7FA', borderRadius: 12,
          padding: 14, marginBottom: 14,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 10, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12.5, fontWeight: 700 }}>
              {suggested.records.length} record{suggested.records.length === 1 ? '' : 's'} found in the profile
            </span>
            <span style={{ fontSize: 11, color: T.faint }}>Review before adding</span>
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 7 }}>
              <Btn kind="primary" onClick={addAllSuggested} disabled={addingAll}>
                {addingAll ? 'Adding…' : `Add all (${suggested.records.length})`}
              </Btn>
              <Btn onClick={() => setSuggested(null)}>Dismiss</Btn>
            </span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 320, overflowY: 'auto' }}>
            {suggested.records.map(rec => (
              <div key={`${rec.record_type}|${rec.title}|${rec.date || ''}`} style={{
                background: '#fff', border: '1px solid #DBE7FA', borderRadius: 10,
                padding: 12, display: 'flex', gap: 12, alignItems: 'flex-start',
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 10.5, color: T.faint, marginBottom: 2 }}>
                    {[rec.record_type, rec.bill_number, rec.date, rec.significance].filter(Boolean).join(' · ')}
                  </div>
                  <div style={{ fontSize: 12.5, fontWeight: 600, lineHeight: 1.45 }}>{rec.title}</div>
                  {rec.description && (
                    <div style={{ fontSize: 11.5, color: T.muted, marginTop: 3, lineHeight: 1.5 }}>{rec.description}</div>
                  )}
                  {rec.source && <div style={{ fontSize: 10.5, color: T.faint, marginTop: 3 }}>Source: {rec.source}</div>}
                </div>
                <Btn onClick={() => addSuggested(rec)}>Add</Btn>
              </div>
            ))}
          </div>
        </div>
      )}

      {records.length > 0 && (
        <div className="cp-nav" style={{ display: 'flex', gap: 7, marginBottom: 14, overflowX: 'auto' }}>
          {['all', ...RECORD_TYPES].map(t => {
            const n = t === 'all' ? records.length : records.filter(r => r.record_type === t).length
            const on = filter === t
            return (
              <button
                key={t}
                type="button"
                onClick={() => setFilter(t)}
                style={{
                  border: `1px solid ${on ? T.navy : T.border}`, background: on ? T.navy : '#fff',
                  color: on ? '#fff' : T.muted, borderRadius: 99, padding: '7px 13px',
                  fontSize: 11.5, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer',
                  whiteSpace: 'nowrap', textTransform: 'capitalize', minHeight: 34,
                }}
              >{t} ({n})</button>
            )
          })}
        </div>
      )}

      {showForm && !editingRecord && (
        <div style={{ marginBottom: 14 }}>
          <RecordForm
            candidateId={candidate.id}
            userId={userId}
            onSave={() => { setShowForm(false); onRefresh() }}
            onCancel={() => setShowForm(false)}
          />
        </div>
      )}

      {filtered.length === 0 && !suggested ? (
        <EmptyState
          title={candidate.is_incumbent ? 'No records yet' : `${candidate.name} is not an incumbent`}
          body={candidate.is_incumbent
            ? (dossiers?.length
                ? 'Run AI research to extract bills, votes and legal events from the latest profile, or add one by hand.'
                : 'Add a record by hand, or generate a profile first and let AI research extract them.')
            : 'There is no voting record to track for a candidate who has not held this office. If they win, records can be added here by hand or pulled out of a profile with AI research.'}
        />
      ) : filtered.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {filtered.map(record => (
            editingRecord?.id === record.id ? (
              <RecordForm
                key={record.id}
                candidateId={candidate.id}
                userId={userId}
                existing={record}
                onSave={() => { setEditingRecord(null); onRefresh() }}
                onCancel={() => setEditingRecord(null)}
              />
            ) : (
              <RecordRow
                key={record.id}
                record={record}
                onEdit={(r) => { setEditingRecord(r); setShowForm(false) }}
                onDelete={handleDelete}
              />
            )
          ))}
        </div>
      ) : null}
    </Card>
  )
}

// ═══ Profile History ══════════════════════════════════════════════════════════

// ── Compare two profiles ─────────────────────────────────────────────────────
// Same deterministic comparison the backend runs when it stores refresh_diff
// (split on `## SECTION n`, normalized-line set difference), computed in the
// browser on demand for any pair in the history. Nothing is generated: the
// lines listed under a section are the literal lines the newer profile added.
const CMP_CHIP = {
  new:       { c: T.red,     bg: '#FBEAEA' },
  updated:   { c: T.warmInk, bg: '#FDF3E3' },
  unchanged: { c: T.muted,   bg: T.chip },
}

function CompareModal({ candidate, newer, older, onClose }) {
  const [state, setState] = useState({ loading: true, error: '', diff: null })

  useEffect(() => {
    let cancelled = false
    setState({ loading: true, error: '', diff: null })
    Promise.all([fetchDossierContent(newer), fetchDossierContent(older)])
      .then(([a, b]) => {
        if (cancelled) return
        if (!a || !b) {
          setState({ loading: false, diff: null, error: 'One of these profiles has no stored content, so there is nothing to compare.' })
          return
        }
        setState({ loading: false, error: '', diff: computeSectionDiff(b, a) })
      })
      .catch(e => { if (!cancelled) setState({ loading: false, diff: null, error: e.message || 'Could not load the profiles.' }) })
    return () => { cancelled = true }
  }, [newer?.id, older?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const sections = state.diff?.sections || []
  const changed = sections.filter(s => s.status === 'new' || s.status === 'updated')
  const unchanged = sections.filter(s => s.status !== 'new' && s.status !== 'updated')

  return (
    <div
      role="presentation"
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(24,24,27,.45)', zIndex: 1000,
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: 20, overflowY: 'auto',
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Compare the ${fmtDate(newer.generated_at)} profile with the ${fmtDate(older.generated_at)} profile`}
        onClick={e => e.stopPropagation()}
        style={{
          background: '#fff', borderRadius: 16, border: `1px solid ${T.border}`, width: '100%',
          maxWidth: 720, margin: 'auto', boxShadow: '0 18px 48px rgba(0,0,0,.18)',
        }}
      >
        <div style={{
          display: 'flex', alignItems: 'flex-start', gap: 12,
          padding: '18px 22px', borderBottom: `1px solid ${T.divider}`,
        }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 700 }}>What changed between these two profiles</div>
            <div style={{ fontSize: 11.5, color: T.faint, marginTop: 3 }}>
              {candidate?.name ? `${candidate.name} · ` : ''}
              {fmtDate(newer.generated_at, 'MMM d, yyyy')} vs. {fmtDate(older.generated_at, 'MMM d, yyyy')}
            </div>
          </div>
          <span style={{ marginLeft: 'auto' }}>
            <Btn onClick={onClose} title="Close">Close</Btn>
          </span>
        </div>

        <div style={{ padding: '16px 22px 22px', maxHeight: '70vh', overflowY: 'auto' }}>
          {state.loading && <Spinner />}
          {!state.loading && state.error && (
            <EmptyState title="Comparison unavailable" body={state.error} />
          )}
          {!state.loading && !state.error && sections.length === 0 && (
            <EmptyState
              title="No sections to compare"
              body="Neither profile is laid out in the numbered section format the comparison reads."
            />
          )}
          {!state.loading && !state.error && sections.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {changed.length === 0 && (
                <EmptyState
                  title="Nothing moved between these refreshes"
                  body="Every section came back with the same content."
                />
              )}
              {changed.map(s => {
                const st = CMP_CHIP[s.status] || CMP_CHIP.unchanged
                const more = s.added_total - s.added.length
                return (
                  <div key={s.section} style={{
                    border: `1px solid ${T.divider}`, borderRadius: 12, padding: '12px 14px',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 12.5, fontWeight: 700 }}>{s.label}</span>
                      <span style={{ fontSize: 10.5, color: T.faint }}>{s.section}</span>
                      <span style={{
                        marginLeft: 'auto', flexShrink: 0, fontSize: 10.5, fontWeight: 600,
                        color: st.c, background: st.bg, borderRadius: 99, padding: '3px 10px',
                      }}>
                        {s.new_items > 0 ? `${s.new_items} new` : s.status === 'new' ? 'new' : 'updated'}
                      </span>
                    </div>
                    <div style={{ fontSize: 11, color: T.faint, marginTop: 3 }}>{s.note}</div>
                    {s.added.length > 0 && (
                      <ul style={{ margin: '9px 0 0', paddingLeft: 18, listStyle: 'disc' }}>
                        {s.added.map((line, i) => (
                          <li key={i} style={{ fontSize: 11.5, color: T.ink3, lineHeight: 1.5, margin: '3px 0' }}>
                            {line.replace(/^[-*]\s+/, '')}
                          </li>
                        ))}
                      </ul>
                    )}
                    {more > 0 && (
                      <div style={{ fontSize: 11, color: T.faint, marginTop: 6 }}>
                        +{more} more added line{more === 1 ? '' : 's'} in this section
                      </div>
                    )}
                    {s.added.length === 0 && s.removed > 0 && (
                      <div style={{ fontSize: 11, color: T.faint, marginTop: 6 }}>
                        {s.removed} line{s.removed === 1 ? '' : 's'} from the older profile are no longer present.
                      </div>
                    )}
                  </div>
                )
              })}
              {unchanged.length > 0 && (
                <div style={{
                  border: `1px solid ${T.divider}`, borderRadius: 12, padding: '12px 14px', background: T.hover,
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 12.5, fontWeight: 600, color: T.ink3 }}>
                      {unchanged.map(s => s.label).join(' · ')}
                    </span>
                    <span style={{
                      marginLeft: 'auto', flexShrink: 0, fontSize: 10.5, fontWeight: 600,
                      color: CMP_CHIP.unchanged.c, background: '#fff', borderRadius: 99, padding: '3px 10px',
                    }}>no change</span>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export function ProfileHistoryView({ candidate, dossiers, canIntel, unseen, nav }) {
  const [compare, setCompare] = useState(null) // { newer, older }

  if (!canIntel) return <LockedView title="Profile history" onSeePlans={() => nav('/plans')} />

  return (
    <>
    <Card style={{ padding: '20px 24px' }}>
      <ViewHead
        title="Profile history"
        sub="every generated profile, newest first · Compare diffs a profile against the one before it"
        right={<Btn kind="primary" onClick={() => nav(`/dossiers?candidate=${candidate.id}`)}>Regenerate profile</Btn>}
      />
      {!dossiers.length ? (
        <EmptyState
          title="No profiles generated yet"
          body={`Nothing has been generated for ${candidate.name}. Build the first profile from the Profiler and every refresh after it is listed here.`}
          action={<CtaButton onClick={() => nav(`/dossiers?candidate=${candidate.id}`)}>Generate profile</CtaButton>}
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {dossiers.map((d, i) => {
            const n = (d.weekly_digest?.items || []).length
            const isNew = unseen.isUnseenDossier(d)
            const predecessor = dossiers[i + 1] || null
            return (
              <div
                key={d.id}
                className="cp-row"
                role="button"
                tabIndex={0}
                onClick={() => nav(`/dossiers?view=${d.id}`)}
                onKeyDown={e => { if (e.key === 'Enter') nav(`/dossiers?view=${d.id}`) }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 12, padding: '11px 10px',
                  margin: '0 -10px', borderTop: `1px solid ${T.divider}`, cursor: 'pointer', minHeight: 44,
                }}
              >
                <span style={{
                  flexShrink: 0, width: 7, height: 7, borderRadius: '50%',
                  background: i === 0 ? T.red : '#15803D',
                }} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
                    {fmtDate(d.generated_at, 'EEE, MMM d, yyyy')}
                    {isNew && <NewBadge />}
                  </div>
                  <div style={{ fontSize: 11, color: T.faint, marginTop: 1 }}>
                    {d.weekly_digest
                      ? `${n} item${n === 1 ? '' : 's'} in the digest`
                      : d.title || 'No digest written for this refresh'}
                  </div>
                </div>
                <span style={{ marginLeft: 'auto', flexShrink: 0, fontSize: 10.5, color: T.faint }}>
                  {d.generated_by ? 'Manual' : 'Auto'}
                </span>
                {predecessor && (
                  <span
                    style={{ flexShrink: 0 }}
                    title={`Compare with the ${fmtDate(predecessor.generated_at)} profile`}
                    onClick={e => { e.stopPropagation(); setCompare({ newer: d, older: predecessor }) }}
                  >
                    <TextLink style={{ fontSize: 11.5, color: T.red, fontWeight: 600 }}>Compare →</TextLink>
                  </span>
                )}
                <span style={{ flexShrink: 0, fontSize: 11.5, color: T.muted }}>Open profile →</span>
              </div>
            )
          })}
        </div>
      )}
    </Card>
    {compare && (
      <CompareModal
        candidate={candidate}
        newer={compare.newer}
        older={compare.older}
        onClose={() => setCompare(null)}
      />
    )}
    </>
  )
}
