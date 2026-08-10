// src/pages/settings/AccountPane.jsx — "Your account" pane (/settings/account).
//
// Display name and organization are NOT saved on blur: they feed the shell's
// unsaved-changes bar (Settings.jsx), which is the only thing that writes them.

import React from 'react'
import { Card, CardBody, Row, Field, Btn, Pill, Note, StubPill, T } from './shared'

const SUPPORT_EMAIL = 'support@badgerboardwi.com'

const fmtDate = (v) => {
  const t = v ? new Date(v).getTime() : NaN
  return Number.isFinite(t)
    ? new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : null
}
const fmtDateTime = (v) => {
  const t = v ? new Date(v).getTime() : NaN
  return Number.isFinite(t)
    ? new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
    : null
}

export default function AccountPane({ user, savedName = '', nameField, orgField, onName, onOrg }) {
  const email       = user?.email || ''
  const shownName   = savedName || email.split('@')[0] || 'Your account'
  const initial     = (savedName || email || 'U').charAt(0).toUpperCase()
  const memberSince = fmtDate(user?.created_at)
  const lastSignIn  = fmtDateTime(user?.last_sign_in_at)

  const requestEmailChange = () => {
    const subject = encodeURIComponent('Email change request')
    const body    = encodeURIComponent(
      `Please change the email address on my Badger Board account.\n\nCurrent email: ${email}\nNew email: \n`
    )
    window.location.href = `mailto:${SUPPORT_EMAIL}?subject=${subject}&body=${body}`
  }

  return (
    <>
      <Card
        title="Your account"
        desc="How you appear inside Badger Board and to anyone you share work with."
      >
        <CardBody style={{ padding: '18px 24px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 15, marginBottom: 20 }}>
            <span aria-hidden="true" style={{
              flex: 'none', width: 56, height: 56, borderRadius: '50%', background: T.red,
              color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 21, fontWeight: 700,
            }}>{initial}</span>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 15, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis' }}>{shownName}</div>
              <div style={{ fontSize: 12.5, color: T.ink4, marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{email}</div>
            </div>
          </div>

          <div className="st-2col" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <Field
              label="Display name"
              value={nameField}
              onChange={e => onName(e.target.value)}
              maxLength={60}
              placeholder="Your name"
              autoComplete="name"
            />
            <Field
              label="Organization"
              value={orgField}
              onChange={e => onOrg(e.target.value)}
              maxLength={80}
              placeholder="Campaign, party or firm"
              autoComplete="organization"
            />
          </div>
          <Note style={{ marginTop: 10, fontSize: 11.5, color: T.muted }}>
            Changes are held until you save them from the bar at the bottom of the page.
          </Note>
        </CardBody>

        <Row
          title="Email address"
          desc={`${email} — used for sign-in, receipts and your monitoring digest.`}
          control={<Btn ctl onClick={requestEmailChange}>Request change</Btn>}
          last
        />
      </Card>

      <Card title="Account details" desc="What Badger Board records about this login.">
        <CardBody>
          <dl style={{ margin: 0, display: 'grid', gap: 9 }}>
            {[
              ['User ID', user?.id || 'Unknown', true],
              ['Member since', memberSince || 'Unknown', false],
              ['Last sign-in', lastSignIn || 'Unknown', false],
            ].map(([k, v, mono]) => (
              <div key={k} style={{ display: 'flex', gap: 12, alignItems: 'baseline', flexWrap: 'wrap' }}>
                <dt style={{ flex: 'none', width: 108, fontSize: 11.5, fontWeight: 600, color: T.ink3 }}>{k}</dt>
                <dd style={{
                  margin: 0, minWidth: 0, fontSize: 12.5, color: T.ink4, wordBreak: 'break-all',
                  fontFamily: mono ? 'ui-monospace, SFMono-Regular, Menlo, monospace' : 'inherit',
                }}>{v}</dd>
              </div>
            ))}
          </dl>
        </CardBody>
      </Card>

      {/* Signed-in devices — STUB. Supabase does not expose a session list to the
          client, so there is nothing real to render here yet. Everything below
          is either a fact we actually hold (last sign-in) or plainly labelled
          as unavailable. Nothing implies you can sign another device out. */}
      <Card
        title="Signed-in devices"
        desc="Opposition research is sensitive — a stray session is a leak."
        right={<StubPill />}
      >
        <Row
          title="This device"
          badge={<Pill c={T.green} bg={T.greenBg}>SIGNED IN</Pill>}
          desc={lastSignIn ? `Signed in ${lastSignIn}.` : 'Signed in now.'}
          last
        />
        <div style={{ padding: '13px 24px', background: T.hover, borderTop: `1px solid ${T.divider}` }}>
          <Note>
            Badger Board cannot yet list your other sessions or sign them out remotely. If you think
            someone else has your password, change it under Security — and contact support so we can
            end every session on the account.
          </Note>
        </div>
      </Card>
    </>
  )
}
