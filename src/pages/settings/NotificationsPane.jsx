// src/pages/settings/NotificationsPane.jsx — Notifications pane
// (/settings/notifications).
//
// Two rules this file exists to hold:
//   1. payment_failed and account_locked are ALWAYS ON and visibly locked.
//      Letting someone silence them is how access lapses without warning.
//   2. Only cadences the server actually honours are offered. The Monday digest
//      is gated by notification_preferences.weekly_digest, which
//      netlify/functions/monitoring-digest.js reads:
//        `if (prefs.weekly_digest === false) { ... status: 'opted_out'; continue }`
//      There is no server behaviour behind a "only when something changes"
//      cadence, so that option is not offered rather than shipped dead.

import React from 'react'
import { Card, CardBody, Row, ChoicePill, Toggle, Pill, Note, Msg, StubPill, plural, T } from './shared'

// `lockNote` is per-alert on purpose: both locked rows used to append one
// shared boilerplate sentence about silenced alerts letting access lapse, so
// the two descriptions ended verbatim identical and read as a copy-paste slip.
// Each now explains why ITS OWN alert is locked.
export const NOTIF_PREFS = [
  { key: 'payment_failed',  locked: true,  label: 'Payment failed warning',
    desc: 'Sent when a payment attempt fails, so you can fix your card before access is interrupted.',
    lockNote: 'Locked on: a failed payment is the one warning that still has time to save your subscription.' },
  { key: 'account_locked',  locked: true,  label: 'Account security alerts',
    desc: 'Sent if your account is locked by a security event or by repeated failed payments.',
    lockNote: 'Locked on: if someone else triggers a lock on this account, you have to hear about it from us.' },
  { key: 'payment_receipt', locked: false, label: 'Payment receipts',
    desc: 'A receipt each time a subscription payment goes through.' },
  { key: 'plan_changed',    locked: false, label: 'Plan changes',
    desc: 'When your plan is upgraded, downgraded or cancelled.' },
  { key: 'dossier_ready',   locked: false, label: 'Profile ready',
    desc: 'When a profile you requested finishes generating — useful for bulk runs.' },
]

const DIGEST_NOTE = {
  monday: 'One email each Monday, after every monitored profile has refreshed. The most common choice.',
  never:  'No digest email. Refreshes still run on Monday, and the changes wait for you in the app.',
}

export default function NotificationsPane({
  prefs, onToggle, digest, onDigest, digestMsg, monitoredCount, monitoringLoading,
}) {
  return (
    <>
      <Card
        title="Monitoring digest"
        desc="Active Monitoring refreshes monitored profiles every Monday. Choose how you hear about it."
      >
        <CardBody>
          <div style={{ fontSize: 11.5, fontWeight: 600, color: T.ink3, marginBottom: 8 }}>Send the digest</div>
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 12 }}>
            <ChoicePill label="Monday morning" on={digest !== 'never'} onClick={() => onDigest('monday')} />
            <ChoicePill label="Never"          on={digest === 'never'} onClick={() => onDigest('never')} />
          </div>
          <Note>{DIGEST_NOTE[digest === 'never' ? 'never' : 'monday']}</Note>
          <Note style={{ marginTop: 8, fontSize: 11.5, color: T.muted }}>
            {monitoringLoading
              ? 'Checking how many candidates you monitor…'
              : monitoredCount > 0
                ? `${plural(monitoredCount, 'candidate')} currently monitored.`
                : 'No candidates are monitored yet, so there is nothing to digest — turn monitoring on from a candidate to start.'}
          </Note>
          {digestMsg && <div style={{ marginTop: 12 }}><Msg type={digestMsg.type}>{digestMsg.text}</Msg></div>}
        </CardBody>

        {/* STUB: no immediate-alert path exists on the server. Shown locked off
            and labelled so nobody thinks controversies are being pushed. */}
        <Row
          title="Alert me immediately on controversy items"
          badge={<StubPill />}
          desc="Not built yet. Controversy findings arrive with the Monday digest and are waiting on the candidate's profile before then."
          control={(
            <Toggle
              on={false}
              unavailable
              label="Immediate controversy alerts (not yet available)"
              title="Not yet available — there is no immediate-alert path on the server"
            />
          )}
          last
        />
      </Card>

      <Card
        title="Email notifications"
        desc="Billing and security alerts stay on — they are what protect your access."
      >
        {NOTIF_PREFS.map((p, i) => {
          const on = p.locked ? true : !!prefs[p.key]
          return (
            <Row
              key={p.key}
              title={p.label}
              badge={p.locked ? <Pill>ALWAYS ON</Pill> : null}
              desc={p.locked ? `${p.desc} ${p.lockNote}` : p.desc}
              control={(
                <Toggle
                  on={on}
                  disabled={p.locked}
                  onChange={() => onToggle(p.key)}
                  label={p.label}
                  title={p.locked ? 'Always on — this alert protects your access' : undefined}
                />
              )}
              last={i === NOTIF_PREFS.length - 1}
            />
          )
        })}
      </Card>
    </>
  )
}
