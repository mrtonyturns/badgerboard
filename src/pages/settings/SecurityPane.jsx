// src/pages/settings/SecurityPane.jsx — Security pane (/settings/security).
//
// Password change keeps the existing re-authenticate-then-update flow: sign in
// again with the current password (the only way to verify it through the client
// SDK), then updateUser({ password }). Minimum length is 12 per the spec.

import React, { useEffect, useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { supabase, getRecentActivity, logActivity } from '../../lib/supabase'
import {
  Card, CardBody, Row, Field, Btn, Pill, Note, Msg, Spinner, StubPill, T,
} from './shared'

const MIN_PW = 12

// Actions from the logActivity audit trail that belong on a security screen.
// Everything else in activity_log is candidate/record bookkeeping.
const SECURITY_ACTIONS = new Set([
  'password_changed', 'profile_updated', 'ai_access_default_changed',
  'share_created', 'calendar_feed_rotated',
])
const isSecurityAction = (a = '') =>
  SECURITY_ACTIONS.has(a) || a.startsWith('ai_') || a.includes('share')

const humanize = (row) => {
  const base = String(row.action || '').replace(/_/g, ' ').trim()
  const label = base ? base.charAt(0).toUpperCase() + base.slice(1) : 'Account activity'
  const name  = row.details?.candidate_name || row.details?.name
  return name ? `${label} · ${name}` : label
}

const whenLabel = (iso) => {
  const t = iso ? new Date(iso).getTime() : NaN
  if (!Number.isFinite(t)) return ''
  const d = new Date(t)
  const today = new Date(); today.setHours(0, 0, 0, 0)
  return t >= today.getTime()
    ? `Today, ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
    : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export default function SecurityPane({ user }) {
  const [currentPw, setCurrentPw]     = useState('')
  const [newPw, setNewPw]             = useState('')
  const [confirmPw, setConfirmPw]     = useState('')
  const [showCurrent, setShowCurrent] = useState(false)
  const [showNew, setShowNew]         = useState(false)
  const [saving, setSaving]           = useState(false)
  const [msg, setMsg]                 = useState(null)

  const [audit, setAudit]     = useState([])
  const [auditLoading, setAL] = useState(true)

  useEffect(() => {
    let alive = true
    getRecentActivity(40)
      .then(({ data }) => {
        if (!alive) return
        setAudit((data || []).filter(r => isSecurityAction(r.action)).slice(0, 8))
        setAL(false)
      })
      .catch(() => { if (alive) { setAudit([]); setAL(false) } })
    return () => { alive = false }
  }, [user?.id])

  const changePassword = async () => {
    setMsg(null)
    if (!newPw || newPw.length < MIN_PW) {
      setMsg({ type: 'error', text: `Your new password must be at least ${MIN_PW} characters.` }); return
    }
    if (newPw !== confirmPw) {
      setMsg({ type: 'error', text: 'The two new passwords do not match.' }); return
    }
    setSaving(true)
    // Re-authenticate first — this is what verifies the current password.
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: user.email, password: currentPw,
    })
    if (signInError) {
      setMsg({ type: 'error', text: 'That current password is incorrect.' })
      setSaving(false)
      return
    }
    const { error } = await supabase.auth.updateUser({ password: newPw })
    if (error) {
      setMsg({ type: 'error', text: error.message })
    } else {
      setMsg({ type: 'success', text: 'Password changed. Use the new one next time you sign in.' })
      setCurrentPw(''); setNewPw(''); setConfirmPw('')
      logActivity('password_changed', 'account', user?.id, {}).catch(() => {})
    }
    setSaving(false)
  }

  const eyeBtn = (shown, set) => (
    <button type="button" onClick={() => set(v => !v)} aria-label={shown ? 'Hide password' : 'Show password'}
      style={{
        // sits over the input, which is now the mockup's ~38px field (was 44)
        position: 'absolute', right: 6, top: 20, width: 38, height: 38,
        background: 'none', border: 0, color: T.faint, cursor: 'pointer', fontFamily: 'inherit',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
      {shown ? <EyeOff style={{ width: 16, height: 16 }} /> : <Eye style={{ width: 16, height: 16 }} />}
    </button>
  )

  return (
    <>
      <Card
        title="Password"
        desc="Your password is what stands between this account and the research inside it. Use at least 12 characters you don't use anywhere else."
      >
        <CardBody>
          <div className="st-2col" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <div style={{ position: 'relative' }}>
              <Field
                label="Current password"
                type={showCurrent ? 'text' : 'password'}
                value={currentPw}
                onChange={e => setCurrentPw(e.target.value)}
                placeholder="Enter current password"
                autoComplete="current-password"
                inputStyle={{ paddingRight: 46 }}
              />
              {eyeBtn(showCurrent, setShowCurrent)}
            </div>
            <div style={{ position: 'relative' }}>
              <Field
                label="New password"
                type={showNew ? 'text' : 'password'}
                value={newPw}
                onChange={e => setNewPw(e.target.value)}
                placeholder={`At least ${MIN_PW} characters`}
                autoComplete="new-password"
                inputStyle={{ paddingRight: 46 }}
              />
              {eyeBtn(showNew, setShowNew)}
            </div>
          </div>
          <div className="st-2col" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginTop: 14 }}>
            <Field
              label="Confirm new password"
              type="password"
              value={confirmPw}
              onChange={e => setConfirmPw(e.target.value)}
              placeholder="Repeat the new password"
              autoComplete="new-password"
            />
            <span />
          </div>

          {msg && <div style={{ marginTop: 14 }}><Msg type={msg.type}>{msg.text}</Msg></div>}

          <div style={{ marginTop: 14 }}>
            <Btn
              kind="primary"
              onClick={changePassword}
              disabled={saving || !currentPw || !newPw || !confirmPw}
              style={{ padding: '9px 18px', fontSize: 12.5 }}   // mockup
            >
              {saving ? <><Spinner color="#fff" /> Updating…</> : 'Update password'}
            </Btn>
          </div>
        </CardBody>
      </Card>

      {/* Two-factor — STUB. Nothing is enrolled, nothing is enforced. The badge
          says so plainly rather than showing a "Set up" button that goes
          nowhere. */}
      <Card
        title="Two-factor authentication"
        desc="An account holding research on real people should offer it. Badger Board does not yet."
        right={<StubPill />}
      >
        <Row
          title="Authenticator app"
          badge={<Pill c={T.redHot} bg={T.redBg}>NOT AVAILABLE</Pill>}
          desc="Two-factor sign-in is not built yet, so your password alone protects this account. We will announce it in-app when it ships."
          last
        />
      </Card>

      <Card
        title="Recent security activity"
        desc="Password changes, AI-access changes and share links created on your account."
      >
        <Row
          title="Most recent sign-in"
          desc={user?.last_sign_in_at
            ? new Date(user.last_sign_in_at).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
            : 'Not recorded.'}
          last={!auditLoading && audit.length === 0}
        />
        {auditLoading && (
          <div style={{ padding: '14px 24px', display: 'flex', alignItems: 'center', gap: 9 }}>
            <Spinner /><Note>Loading your activity…</Note>
          </div>
        )}
        {!auditLoading && audit.length === 0 && (
          <div style={{ padding: '14px 24px', background: T.hover, borderTop: `1px solid ${T.divider}` }}>
            <Note>
              No other security events recorded yet. Sign-ins are not written to this log — password
              and AI-access changes made from this page are, and will show up here.
            </Note>
          </div>
        )}
        {!auditLoading && audit.map((row, i) => (
          <div key={row.id || i} style={{
            display: 'flex', gap: 12, alignItems: 'baseline',
            padding: '12px 24px', borderBottom: i === audit.length - 1 ? 'none' : `1px solid ${T.line}`,
          }}>
            <span style={{ flex: 'none', width: 100, fontSize: 11.5, color: T.muted }}>{whenLabel(row.created_at)}</span>
            <span style={{ fontSize: 12.5, lineHeight: 1.5, minWidth: 0 }}>{humanize(row)}</span>
          </div>
        ))}
        {!auditLoading && audit.length > 0 && (
          <div style={{ padding: '12px 24px 14px', background: T.hover, borderTop: `1px solid ${T.divider}` }}>
            <Note style={{ fontSize: 11.5, color: T.muted }}>
              {audit.length === 1
                ? 'Showing the most recent security event on this account.'
                : `Showing the ${audit.length} most recent security events on this account.`}
            </Note>
          </div>
        )}
      </Card>
    </>
  )
}
