// src/pages/profiler/ClaimReviewer.jsx — the flagged-claim audit trail.
//
// Same endpoint and same review vocabulary as before the redesign; it now opens
// as a right-hand drawer from the reader's "More" menu instead of squeezing the
// document into a narrower column.

import React, { useEffect, useState } from 'react'
import { ThumbsUp, ThumbsDown, HelpCircle, Check, X } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { parseFlaggedClaims } from './reportModel'
import { T } from './shared'

const BADGE_TINT = {
  'RESEARCH REQUIRED': { c: '#92400E', bg: '#FDF3E3' },
  'Verify':            { c: '#854D0E', bg: '#FDF6E3' },
  'Likely':            { c: '#6B21A8', bg: '#F3EDFB' },
}

const STATUS_BUTTONS = [
  { status: 'confirmed',      icon: ThumbsUp,   label: 'Confirmed'      },
  { status: 'rejected',       icon: ThumbsDown, label: 'Rejected'       },
  { status: 'needs_research', icon: HelpCircle, label: 'Needs research' },
]

export default function ClaimReviewer({ dossier, onClose }) {
  const [reviews, setReviews]   = useState({})
  const [saving, setSaving]     = useState(null)
  const [savedIds, setSavedIds] = useState(new Set())
  const [error, setError]       = useState('')

  const claims = parseFlaggedClaims(dossier?.content || '')

  const getToken = async () => {
    const { data: { session } } = await supabase.auth.getSession()
    return session?.access_token || null
  }

  useEffect(() => {
    const load = async () => {
      try {
        const token = await getToken()
        if (!token) return
        const res = await fetch('/.netlify/functions/dossier-review', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ action: 'get_reviews', dossier_id: dossier.id }),
        })
        const data = await res.json()
        if (data.reviews) {
          const map = {}
          data.reviews.forEach(r => {
            map[`${r.section_id}::${r.claim_text.slice(0, 60)}`] = { status: r.status, note: r.note || '' }
          })
          setReviews(map)
          setSavedIds(new Set(Object.keys(map)))
        }
      } catch { /* the panel still works; saves report their own errors */ }
    }
    if (dossier?.id) load()
  }, [dossier?.id])

  const saveReview = async (claim, status) => {
    setSaving(claim.id); setError('')
    try {
      const token = await getToken()
      if (!token) throw new Error('Not signed in')
      await fetch('/.netlify/functions/dossier-review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          action: 'save_review', dossier_id: dossier.id, section_id: claim.sectionId,
          claim_text: claim.text, status, note: reviews[claim.id]?.note || '',
        }),
      })
      setReviews(prev => ({ ...prev, [claim.id]: { status, note: prev[claim.id]?.note || '' } }))
      setSavedIds(prev => new Set([...prev, claim.id]))
    } catch (err) {
      setError(err.message || 'Save failed')
    }
    setSaving(null)
  }

  return (
    <div style={{
      position: 'fixed', top: 0, right: 0, bottom: 0, width: 'min(380px, 100vw)', zIndex: 60,
      background: '#fff', borderLeft: `1px solid ${T.border}`, boxShadow: '-12px 0 40px rgba(13,21,38,.12)',
      display: 'flex', flexDirection: 'column', fontFamily: T.font, color: T.ink,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px',
        borderBottom: `1px solid ${T.divider}`,
      }}>
        <span style={{ fontSize: 13.5, fontWeight: 700 }}>Claim review</span>
        <span style={{ fontSize: 11.5, color: T.muted }}>
          {savedIds.size} of {claims.length} reviewed
        </span>
        <button
          type="button" onClick={onClose} aria-label="Close claim review"
          style={{
            marginLeft: 'auto', width: 34, height: 34, borderRadius: 8, border: 0,
            background: 'transparent', color: T.ink4, cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        ><X className="w-4 h-4" /></button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        {claims.length === 0 && (
          <div style={{ fontSize: 12.5, color: T.muted, lineHeight: 1.6 }}>
            Nothing in this profile is tagged Verify, Likely or Research Required — there is no
            audit trail to build.
          </div>
        )}
        {error && (
          <div style={{
            fontSize: 11.5, color: '#B91C1C', background: '#FEF2F2',
            border: '1px solid #FBD5D5', borderRadius: 10, padding: '8px 10px',
          }}>{error}</div>
        )}
        {claims.map(claim => {
          const review = reviews[claim.id]
          const tint = BADGE_TINT[claim.badge] || { c: T.ink4, bg: T.chip }
          return (
            <div key={claim.id} style={{
              border: `1px solid ${savedIds.has(claim.id) ? T.border : T.warmBr}`,
              background: savedIds.has(claim.id) ? '#fff' : T.warmBg,
              borderRadius: 12, padding: 12,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span style={{
                  fontSize: 11, fontWeight: 700, color: tint.c, background: tint.bg,
                  borderRadius: 6, padding: '2px 7px',
                }}>{claim.badge}</span>
                <span style={{ fontSize: 11, color: T.muted }}>
                  {claim.sectionId.replace('section-', 'Section ')}
                </span>
              </div>
              <div style={{ fontSize: 12.5, color: T.ink3, lineHeight: 1.55, marginBottom: 10 }}>{claim.text}</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {STATUS_BUTTONS.map(({ status, icon: Icon, label }) => {
                  const on = review?.status === status
                  return (
                    <button
                      key={status}
                      type="button"
                      disabled={saving === claim.id}
                      onClick={() => saveReview(claim, status)}
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: 5, minHeight: 32,
                        border: `1px solid ${on ? T.ink : T.border}`, background: on ? T.ink : '#fff',
                        color: on ? '#fff' : T.ink4, borderRadius: 99, padding: '6px 11px',
                        fontSize: 11.5, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer',
                        opacity: saving === claim.id ? 0.5 : 1,
                      }}
                    >
                      <Icon className="w-3 h-3" />
                      {label}
                      {on && <Check className="w-3 h-3" />}
                    </button>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>

      <div style={{ padding: '12px 16px', borderTop: `1px solid ${T.divider}`, background: '#FCFCFB' }}>
        <div style={{ fontSize: 11.5, color: T.muted, lineHeight: 1.55 }}>
          Reviewing flagged claims creates an audit trail showing you evaluated AI-generated content
          before using it.
        </div>
      </div>
    </div>
  )
}
