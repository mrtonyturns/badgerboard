// src/pages/settings/PrivacyPane.jsx — Data & privacy pane (/settings/privacy).
//
// The one real switch here is the org-level AI default, stored on the user's
// notification_preferences row in column `ai_access_default` (added by
// supabase/migrations/20260721000005_share_ack_org_ai_default.sql). It is READ
// and WRITTEN by Settings.jsx through the same notification_preferences path
// the email toggles use.
//
// Server enforcement already exists and is NOT rebuilt here:
// netlify/functions/_candidate-context.js reads candidates.ai_access_notes
// first — an explicit per-candidate lock (false) always wins — and only falls
// back to this default when the candidate has never been set either way (null).
// The copy below has to say that, because the switch genuinely cannot override
// a locked candidate.
//
// The delete-account card lives at the bottom of THIS pane only. It is never
// adjacent to a preference.

import React from 'react'
import { Card, CardBody, Row, Btn, Toggle, Pill, Note, Msg, StubPill, T, plural } from './shared'

export default function PrivacyPane({
  aiDefault, onAiDefault, aiMsg, aiLoading,
  shareCount, shareLoading, onReviewShares, onDeleteAccount,
}) {
  return (
    <>
      <Card
        title="What AI can read"
        desc="The default for candidates you haven't decided about individually. Each candidate's own AI-access lock always overrides this."
      >
        <Row
          title="Team notes and uploaded documents"
          badge={aiDefault ? <Pill c={T.green} bg={T.greenBg}>ALLOWED</Pill> : <Pill c={T.redHot} bg={T.redBg}>WITHHELD</Pill>}
          desc="Lets profile generation read the notes and documents attached to a candidate record when it writes for you. Turn it off and new candidates start closed until you open them one by one."
          control={(
            <Toggle
              on={!!aiDefault}
              disabled={aiLoading}
              onChange={() => onAiDefault(!aiDefault)}
              label="Let AI tools read team notes and uploaded documents by default"
            />
          )}
          last
        />
        <div style={{ padding: '14px 24px', background: T.hover, borderTop: `1px solid ${T.divider}` }}>
          <Note>
            A candidate you have locked stays locked no matter what this is set to — the lock is checked
            first, on the server, every time. This switch only decides what happens for candidates you
            have never set either way.
          </Note>
          <Note style={{ marginTop: 8 }}>
            Badger Board never trains models on your notes, documents or lists. This controls only whether
            your own AI tools may read them while generating for you.
          </Note>
          {aiMsg && <div style={{ marginTop: 12 }}><Msg type={aiMsg.type}>{aiMsg.text}</Msg></div>}
        </div>
      </Card>

      <Card title="Your data" desc="Take it with you, or check who can still read what you shared.">
        {/* STUB: there is no export endpoint yet, so this is a labelled
            placeholder rather than a button that quietly does nothing. */}
        <Row
          title="Export all data"
          badge={<StubPill />}
          desc="A single-archive export of profiles, candidates, game plans, notes and lists is not built yet. Profiles can be exported one at a time as PDFs from the Profiler."
          control={<Btn ctl disabled title="Not yet available">Request export</Btn>}
        />
        <Row
          title="Active share links"
          badge={shareLoading
            ? null
            : shareCount > 0
              ? <Pill c={T.amber} bg={T.warmBg}>{shareCount === 1 ? '1 LIVE' : `${shareCount} LIVE`}</Pill>
              : <Pill>NONE LIVE</Pill>}
          desc={shareLoading
            ? 'Counting your live share links…'
            : shareCount > 0
              ? `${plural(shareCount, 'link')} can be opened right now by anyone holding the URL, until each one expires.`
              : 'No live share links. Anyone you sent an expired link to gets nothing.'}
          control={<Btn ctl onClick={onReviewShares}>Open Profiler</Btn>}
          last
        >
          <Note style={{ fontSize: 11.5, color: T.muted, marginTop: 6 }}>
            Share links are created and revoked from each profile's share dialog in the Profiler.
          </Note>
        </Row>
      </Card>

      <Card tone="danger" title="Delete account" desc="Permanent and immediate. There is no restore.">
        <CardBody>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginBottom: 14 }}>
            {[
              ['All profiles', 'every generated profile and every version of it'],
              ['All candidates', 'records, notes, uploaded documents and game plans'],
              ['All lists', 'voter lists, prospect lists, filters and classifications'],
              ['Your account', 'credentials, billing history and audit trail'],
            ].map(([k, v]) => (
              <div key={k} style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
                <span aria-hidden="true" style={{ flex: 'none', width: 4, height: 4, borderRadius: '50%', background: T.redHot, transform: 'translateY(-2px)' }} />
                <div style={{ fontSize: 12.5, lineHeight: 1.5 }}>
                  <span style={{ fontWeight: 600 }}>{k}</span> — {v}
                </div>
              </div>
            ))}
          </div>
          <Note style={{ marginBottom: 14 }}>
            Your subscription cancels at the same time. If you only want to stop paying, change your plan
            instead — your work stays put.
          </Note>
          <Btn kind="danger" onClick={onDeleteAccount}>Delete my account</Btn>
        </CardBody>
      </Card>
    </>
  )
}
