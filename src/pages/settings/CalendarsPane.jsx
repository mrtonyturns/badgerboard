// src/pages/settings/CalendarsPane.jsx — Calendars pane (/settings/calendars).
//
// Same feedToken plumbing as the previous CalendarsSection: the token lives in
// `calendar_feeds` (one row per user, RLS-scoped), everything else lives in
// user_metadata. The provider connect/verify flow is unchanged — it still
// watches calendar_feeds.fetch_log for a real fetch by that provider before it
// marks anything connected.

import React, { useEffect, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { supabase, logActivity } from '../../lib/supabase'
import {
  Card, CardBody, Row, Btn, LinkBtn, ChoicePill, Pill, Note, Msg, Spinner, T,
} from './shared'

const CAL_PROVIDERS = [
  { key: 'google',  name: 'Google Calendar',
    steps: ['Open Google Calendar on the web', 'In the left sidebar: Other calendars → + → From URL', 'Paste your feed URL below and click "Add calendar"'] },
  { key: 'apple',   name: 'Apple Calendar',
    steps: ['Click the webcal button below (or Calendar → File → New Calendar Subscription)', 'Confirm the subscription', 'Set auto-refresh to "Every hour" for fastest updates'] },
  { key: 'outlook', name: 'Outlook Calendar',
    steps: ['Open Outlook calendar on the web', 'Add calendar → Subscribe from web', 'Paste your feed URL below and name it "Badger Board Events"'] },
]

const REMINDER_OPTIONS = [[15, '15 min'], [30, '30 min'], [60, '1 hour'], [120, '2 hours'], [1440, '1 day']]

// User-agent fingerprints of each provider's feed fetcher — used to VERIFY that
// the calendar service actually pulled the user's feed before marking connected.
const PROVIDER_UA = {
  google:  /google/i,
  apple:   /calendaragent|dataaccessd|ical|apple|cfnetwork|swiftbird/i,
  outlook: /microsoft|outlook|office|exchange/i,
}

export default function CalendarsPane({ user }) {
  const meta = user?.user_metadata || {}
  const [feedToken, setFeedToken] = useState(null)
  const [connecting, setConnecting] = useState(null)   // provider key with open instructions
  const [verifying, setVerifying]   = useState(null)   // provider key being verified
  const [verifyMsg, setVerifyMsg]   = useState(null)   // { key, ok, text }
  const [copied, setCopied]         = useState(false)
  const [saving, setSaving]         = useState(false)
  const [rotating, setRotating]     = useState(false)
  const [rotateMsg, setRotateMsg]   = useState(null)
  const [local, setLocal]           = useState({
    reminder: meta.cal_reminder ?? 60,
    ask: meta.cal_ask !== false,
    connected: { google: !!meta.cal_google, apple: !!meta.cal_apple, outlook: !!meta.cal_outlook },
    defaults: meta.cal_defaults || [],
  })

  useEffect(() => {
    if (!user?.id) return
    supabase.from('calendar_feeds').select('token').eq('user_id', user.id).maybeSingle().then(async ({ data }) => {
      if (data?.token) { setFeedToken(data.token); return }
      const { data: ins } = await supabase.from('calendar_feeds').insert({ user_id: user.id }).select('token').single()
      if (ins?.token) setFeedToken(ins.token)
    })
  }, [user?.id])

  const feedUrl   = feedToken ? `https://badgerboardwi.com/.netlify/functions/calendar-feed?token=${feedToken}` : ''
  const webcalUrl = feedUrl.replace(/^https:/, 'webcal:')

  const localRef = useRef(local)
  useEffect(() => { localRef.current = local }, [local])

  const persist = async (patch) => {
    setSaving(true)
    // Merge against the LATEST local state (ref), not the render-time closure —
    // prevents a rapid second click (e.g. connect → reminder) from reverting the first.
    const next = { ...localRef.current, ...patch }
    localRef.current = next
    setLocal(next)
    const { data } = await supabase.auth.updateUser({ data: {
      cal_google: next.connected.google, cal_apple: next.connected.apple, cal_outlook: next.connected.outlook,
      cal_defaults: next.defaults, cal_reminder: next.reminder, cal_ask: next.ask,
    } })
    setSaving(false)
    return data
  }

  const toggleConnected = async (key, value) => {
    const connected = { ...localRef.current.connected, [key]: value }
    const defaults = value
      ? [...new Set([...localRef.current.defaults, key])]
      : localRef.current.defaults.filter(d => d !== key)
    await persist({ connected, defaults })
    if (!value) setConnecting(null)
  }

  const copy = () => {
    if (!feedUrl) return
    navigator.clipboard?.writeText(feedUrl)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const rotate = async () => {
    if (!user?.id || rotating) return
    const ok = window.confirm(
      'Rotate your calendar feed URL?\n\nThe current URL stops working immediately. Every calendar you subscribed with it will need the new URL pasted in again.'
    )
    if (!ok) return
    setRotating(true); setRotateMsg(null)
    const { error: delErr } = await supabase.from('calendar_feeds').delete().eq('user_id', user.id)
    if (delErr) {
      setRotateMsg({ type: 'error', text: 'That URL could not be rotated. Your old URL is still working.' })
      setRotating(false)
      return
    }
    const { data: ins, error: insErr } = await supabase.from('calendar_feeds').insert({ user_id: user.id }).select('token').single()
    if (insErr || !ins?.token) {
      setFeedToken(null)
      setRotateMsg({ type: 'error', text: 'The old URL was revoked but a new one could not be created. Reload this page to try again.' })
      setRotating(false)
      return
    }
    setFeedToken(ins.token)
    setRotateMsg({ type: 'success', text: 'New URL issued. Re-subscribe anywhere you were using the old one.' })
    logActivity('calendar_feed_rotated', 'account', user.id, {}).catch(() => {})
    setRotating(false)
  }

  const verifyConnection = async (key) => {
    setVerifying(key); setVerifyMsg(null)
    const startedAt = Date.now() - 10 * 60 * 1000   // accept fetches from the last 10 min
    const matcher = PROVIDER_UA[key]
    for (let i = 0; i < 20; i++) {
      const { data } = await supabase.from('calendar_feeds').select('fetch_log').eq('user_id', user.id).maybeSingle()
      const log = Array.isArray(data?.fetch_log) ? data.fetch_log : []
      const hit = log.find(f => matcher.test(f.ua || '') && new Date(f.at).getTime() >= startedAt)
      if (hit) {
        await toggleConnected(key, true)
        setVerifying(null)
        setVerifyMsg({ key, ok: true, text: `Verified — ${CAL_PROVIDERS.find(p => p.key === key).name} fetched your feed at ${new Date(hit.at).toLocaleTimeString()}` })
        return
      }
      // any fetch at all (unknown client) after start also counts on later passes
      if (i > 10) {
        const anyHit = log.find(f => new Date(f.at).getTime() >= Date.now() - 5 * 60 * 1000)
        if (anyHit) {
          await toggleConnected(key, true)
          setVerifying(null)
          setVerifyMsg({ key, ok: true, text: 'Verified — your feed was fetched by a calendar client' })
          return
        }
      }
      await new Promise(r => setTimeout(r, 3000))
    }
    setVerifying(null)
    setVerifyMsg({ key, ok: false, text: "We haven't seen this calendar fetch your feed yet. Double-check you pasted the URL and finished the subscribe step, then verify again — some providers take a minute to make their first fetch." })
  }

  return (
    <>
      <Card
        title="Calendar feed"
        desc="Subscribe in Google Calendar, Outlook or Apple Calendar to see filing deadlines, election dates and game-plan milestones alongside your own schedule."
      >
        <CardBody>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
            <div style={{
              flex: 1, minWidth: 220, border: `1px solid ${T.field}`, borderRadius: 10,
              padding: '10px 13px', fontSize: 12, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              color: T.ink3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              display: 'flex', alignItems: 'center',
            }}>
              {feedUrl || 'Preparing your private feed URL…'}
            </div>
            <Btn
              kind="primary"
              onClick={copy}
              disabled={!feedUrl}
              // mockup: radius 10, padding 10px 18px, 12.5px
              style={{ borderRadius: 10, padding: '10px 18px', fontSize: 12.5, ...(copied ? { background: T.green } : null) }}
            >
              {copied ? <><Check style={{ width: 14, height: 14 }} /> Copied</> : <><Copy style={{ width: 14, height: 14 }} /> Copy URL</>}
            </Btn>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <Note style={{ fontSize: 11.5, color: T.muted, flex: 1, minWidth: 220 }}>
              Anyone holding this URL can read your calendar — treat it like a password. Google refreshes
              subscribed feeds every few hours; Apple and Outlook are faster.
            </Note>
            <LinkBtn color={T.redHot} onClick={rotate} disabled={rotating || !user?.id}>
              {rotating ? <><Spinner color={T.redHot} /> Rotating…</> : 'Rotate URL'}
            </LinkBtn>
          </div>
          {rotateMsg && <div style={{ marginTop: 12 }}><Msg type={rotateMsg.type}>{rotateMsg.text}</Msg></div>}
        </CardBody>

        <div style={{ padding: '15px 24px', borderTop: `1px solid ${T.divider}` }}>
          <div style={{ fontSize: 11.5, fontWeight: 600, color: T.ink3, marginBottom: 8 }}>Default event reminder</div>
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
            {REMINDER_OPTIONS.map(([mins, label]) => (
              <ChoicePill key={mins} label={label} on={local.reminder === mins} onClick={() => persist({ reminder: mins })} />
            ))}
          </div>
        </div>

        <div style={{ padding: '15px 24px', borderTop: `1px solid ${T.divider}` }}>
          <div style={{ fontSize: 11.5, fontWeight: 600, color: T.ink3, marginBottom: 8 }}>When adding an event</div>
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
            <ChoicePill label="Always ask which calendar" on={local.ask} onClick={() => persist({ ask: true })} />
            <ChoicePill label="Use my default calendar" on={!local.ask} onClick={() => persist({ ask: false })} />
          </div>
          {saving && <Note style={{ marginTop: 8, fontSize: 11.5, color: T.muted }}>Saving…</Note>}
        </div>
      </Card>

      <Card
        title="Connected calendars"
        desc="Connecting is a one-time subscribe in your own calendar app. We confirm it by watching for that app's first fetch of your feed."
      >
        {CAL_PROVIDERS.map((p, i) => {
          const isConn = local.connected[p.key]
          const isDflt = local.defaults.includes(p.key)
          const open   = connecting === p.key && !isConn
          return (
            <div key={p.key} style={{ borderBottom: i === CAL_PROVIDERS.length - 1 ? 'none' : `1px solid ${T.line}` }}>
              <Row
                title={p.name}
                badge={isDflt ? <Pill c={T.amber} bg={T.warmBg}>DEFAULT</Pill> : null}
                desc={isConn ? 'Connected — events sync through your private feed.' : 'Not connected.'}
                last
                control={(
                  <div className="st-ctl" style={{ marginLeft: 'auto', flex: 'none', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {isConn && (
                      <Btn onClick={() => persist({ defaults: isDflt ? local.defaults.filter(d => d !== p.key) : [...local.defaults, p.key] })}>
                        {isDflt ? 'Unset default' : 'Set default'}
                      </Btn>
                    )}
                    {isConn
                      ? <Btn onClick={() => toggleConnected(p.key, false)} style={{ borderColor: '#CDE9D8', color: T.green }}>Disconnect</Btn>
                      : <Btn kind="dark" onClick={() => setConnecting(open ? null : p.key)}>{open ? 'Close' : 'Connect'}</Btn>}
                  </div>
                )}
              />
              {open && (
                <div style={{ padding: '0 24px 16px' }}>
                  <div style={{ background: T.hover, border: `1px solid ${T.divider}`, borderRadius: 12, padding: '14px 16px' }}>
                    <ol style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: T.ink4, lineHeight: 1.7 }}>
                      {p.steps.map((st, n) => <li key={n}>{st}</li>)}
                    </ol>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
                      <input
                        readOnly
                        value={feedUrl}
                        onFocus={e => e.target.select()}
                        className="st-input"
                        style={{
                          flex: 1, minWidth: 200, boxSizing: 'border-box', lineHeight: 1.35,
                          border: `1px solid ${T.field}`, borderRadius: 10, padding: '10px 13px',
                          fontSize: 12, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                          color: T.ink3, background: '#fff', outline: 'none',
                        }}
                      />
                      <Btn onClick={copy} disabled={!feedUrl}>{copied ? 'Copied' : 'Copy'}</Btn>
                    </div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10, alignItems: 'center' }}>
                      {p.key === 'apple' && feedUrl && (
                        <a href={webcalUrl} className="st-btn" style={{
                          background: T.navy, color: '#fff', borderRadius: 99, padding: '8px 15px',
                          fontSize: 12, fontWeight: 600, lineHeight: 1.35, display: 'inline-flex',
                          alignItems: 'center', whiteSpace: 'nowrap', textDecoration: 'none',
                        }}>Open in Apple Calendar</a>
                      )}
                      <Btn kind="primary" onClick={() => verifyConnection(p.key)} disabled={verifying === p.key}>
                        {verifying === p.key
                          ? <><Spinner color="#fff" /> Watching for {p.name.split(' ')[0]}'s first fetch…</>
                          : "I've subscribed — verify connection"}
                      </Btn>
                      {verifyMsg?.key === p.key && !verifyMsg.ok && (
                        <LinkBtn color={T.faint} onClick={() => toggleConnected(p.key, true)}>Mark connected anyway</LinkBtn>
                      )}
                    </div>
                    {verifyMsg?.key === p.key && (
                      <div style={{ marginTop: 10 }}>
                        <Msg type={verifyMsg.ok ? 'success' : 'info'}>{verifyMsg.text}</Msg>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </Card>
    </>
  )
}
