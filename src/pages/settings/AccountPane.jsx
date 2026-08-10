// src/pages/settings/AccountPane.jsx — "Your account" pane (/settings/account).
//
// Display name and organization are NOT saved on blur: they feed the shell's
// unsaved-changes bar (Settings.jsx), which is the only thing that writes them.
// Their initial values come from the SAME place that save path writes —
// user_metadata.display_name and user_metadata.business — so the bar diffs
// against what is actually stored. See Settings.jsx → metaName / metaOrg.
//
// The photo is the exception — it saves immediately, because there is no text
// field to hold it. It is stored INLINE as a data URL in user_metadata
// (avatar_url) rather than in Storage: no bucket, no policy, no public object
// to leak. That only works because the image is downscaled to a 96px square
// JPEG first, which lands around 3–8KB. See shrinkToDataUrl().
//
// Signed-in devices is real, not a stub: supabase/migrations/
// 20260810000001_session_list_rpc.sql exposes auth.sessions to its own owner
// through get_my_sessions() / revoke_my_session(). We show the raw IP because
// we have no geolocation — a wrong city is worse than an honest address.

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { Card, CardBody, Row, Field, Btn, LinkBtn, Pill, Note, Msg, Spinner, T } from './shared'

const SUPPORT_EMAIL = 'support@badgerboardwi.com'

// Avatar: 96px square, and the data URL has to stay small — user_metadata rides
// inside the JWT, so a fat string there bloats every request the app makes.
const AVATAR_PX  = 96
const MAX_CHARS  = 20 * 1024

/** Centre-crop to a square, downscale to 96px, encode JPEG under ~20KB. */
function shrinkToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(objectUrl)
      const side = Math.min(img.naturalWidth, img.naturalHeight)
      if (!side) { reject(new Error('unreadable')); return }
      const canvas = document.createElement('canvas')
      canvas.width = AVATAR_PX
      canvas.height = AVATAR_PX
      const ctx = canvas.getContext('2d')
      if (!ctx) { reject(new Error('unreadable')); return }
      ctx.drawImage(
        img,
        (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side,
        0, 0, AVATAR_PX, AVATAR_PX,
      )
      let out = ''
      for (const q of [0.8, 0.7, 0.6, 0.5, 0.4, 0.3]) {
        out = canvas.toDataURL('image/jpeg', q)
        if (out.length <= MAX_CHARS) break
      }
      if (out.length > MAX_CHARS) reject(new Error('too-large'))
      else resolve(out)
    }
    img.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error('unreadable')) }
    img.src = objectUrl
  })
}

// ── User-agent → a name you can recognise ─────────────────────────────────────
// Deliberately tiny and local: no ua-parser dependency for one line of text.
// ORDER MATTERS. Edge and Opera both put "Chrome" in their UA, and every iOS
// browser puts "Safari" in its own, so the specific tokens are tested first.

function browserOf(ua) {
  if (/\bEdg(e|A|iOS)?\//i.test(ua))       return 'Edge'
  if (/\bOPR\/|\bOpera[\s/]/i.test(ua))    return 'Opera'
  if (/\bSamsungBrowser\//i.test(ua))      return 'Samsung Internet'
  if (/\bFirefox\/|\bFxiOS\//i.test(ua))   return 'Firefox'
  if (/\bCriOS\/|\bChrome\//i.test(ua))    return 'Chrome'
  if (/\bSafari\//i.test(ua))              return 'Safari'
  return null
}

function platformOf(ua) {
  if (/\biPhone\b/i.test(ua))                  return 'iPhone'
  if (/\biPad\b/i.test(ua))                    return 'iPad'
  if (/\bAndroid\b/i.test(ua))                 return 'Android'
  if (/\bCrOS\b/.test(ua))                     return 'ChromeOS'
  if (/\bWindows\b/i.test(ua))                 return 'Windows'
  if (/\bMac OS X\b|\bMacintosh\b/i.test(ua))  return 'macOS'
  if (/\bLinux\b/i.test(ua))                   return 'Linux'
  return null
}

/** "Chrome · macOS", "Safari · iPhone", or an honest "Unknown device". */
export function deviceLabel(userAgent) {
  const ua = (userAgent || '').trim()
  if (!ua) return 'Unknown device'
  const browser  = browserOf(ua)
  const platform = platformOf(ua)
  if (browser && platform) return `${browser} · ${platform}`
  return browser || platform || 'Unknown device'
}

/** "Active now" / "Active 42m ago" / "Active 2h ago" / "Active 3d ago". */
function activeLabel(lastActive, isCurrent) {
  if (isCurrent) return 'Active now'
  const t = lastActive ? new Date(lastActive).getTime() : NaN
  if (!Number.isFinite(t)) return 'Last active unknown'
  const mins = Math.floor((Date.now() - t) / 60000)
  if (mins < 1)  return 'Active now'
  if (mins < 60) return `Active ${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `Active ${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `Active ${days}d ago`
  return `Active ${new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`
}

// ── Signed-in devices ─────────────────────────────────────────────────────────

function SessionsCard() {
  const [rows, setRows]       = useState([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed]   = useState(false)
  const [busyId, setBusyId]   = useState(null)
  const [allBusy, setAllBusy] = useState(false)
  const [msg, setMsg]         = useState(null)
  const alive = useRef(true)

  const load = useCallback(async ({ quiet } = {}) => {
    if (!quiet) { setLoading(true); setFailed(false) }
    if (!supabase) { if (alive.current) { setLoading(false); setFailed(true) } return }
    const { data, error } = await supabase.rpc('get_my_sessions')
    if (!alive.current) return
    setLoading(false)
    if (error) { setFailed(true); setRows([]); return }
    setFailed(false)
    setRows(Array.isArray(data) ? data : [])
  }, [])

  useEffect(() => {
    alive.current = true
    load()
    return () => { alive.current = false }
  }, [load])

  const revoke = async (id) => {
    setBusyId(id); setMsg(null)
    const { data, error } = await supabase.rpc('revoke_my_session', { sid: id })
    if (!alive.current) return
    setBusyId(null)
    // The function refuses the current session server-side and returns false;
    // never claim a sign-out the database did not perform.
    if (error || data === false) {
      setMsg({ type: 'error', text: 'That device could not be signed out. Please try again.' })
      return
    }
    setRows(list => list.filter(r => r.id !== id))
    setMsg({ type: 'success', text: 'That device was signed out.' })
  }

  const signOutOthers = async () => {
    setAllBusy(true); setMsg(null)
    const { error } = await supabase.auth.signOut({ scope: 'others' })
    if (!alive.current) return
    if (error) {
      setAllBusy(false)
      setMsg({ type: 'error', text: 'Those devices could not be signed out. Please try again.' })
      return
    }
    await load({ quiet: true })
    if (!alive.current) return
    setAllBusy(false)
    setMsg({ type: 'success', text: 'Every other device was signed out.' })
  }

  const others = rows.filter(r => !r.is_current).length

  return (
    <Card
      title="Signed-in devices"
      desc="Sign out anywhere you don't recognize. Opposition research is sensitive — treat a stray session as a leak."
    >
      {msg && (
        <div style={{ padding: '14px 24px 0' }}>
          <Msg type={msg.type} onDismiss={() => setMsg(null)}>{msg.text}</Msg>
        </div>
      )}

      {loading && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 9,
          padding: '14px 24px', fontSize: 12.5, color: T.muted,
        }}>
          <Spinner size={13} /> Loading sessions…
        </div>
      )}

      {!loading && failed && (
        <CardBody style={{ padding: '14px 24px 18px' }}>
          <Msg type="error">Couldn't load your sessions — try again.</Msg>
          <div style={{ marginTop: 12 }}>
            <Btn onClick={() => load()}>Try again</Btn>
          </div>
        </CardBody>
      )}

      {!loading && !failed && rows.length === 0 && (
        <CardBody style={{ padding: '14px 24px 18px' }}>
          <Note>No signed-in sessions are on record for this account.</Note>
        </CardBody>
      )}

      {!loading && !failed && rows.map(s => (
        <div key={s.id} className="st-row" style={{
          display: 'flex', alignItems: 'center', gap: 14,
          padding: '14px 24px', borderBottom: `1px solid ${T.line}`,
          fontFamily: 'inherit',
        }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{deviceLabel(s.user_agent)}</span>
              {s.is_current && <Pill c={T.green} bg={T.greenBg}>THIS DEVICE</Pill>}
            </div>
            <div style={{ fontSize: 11.5, color: T.muted, marginTop: 2, wordBreak: 'break-word' }}>
              {(s.ip || 'Location unknown')} · {activeLabel(s.last_active, s.is_current)}
            </div>
          </div>
          {!s.is_current && (
            <Btn
              ctl
              kind="danger"
              onClick={() => revoke(s.id)}
              disabled={busyId === s.id || allBusy}
              style={{ marginLeft: 'auto', padding: '7px 14px' }}
            >
              {busyId === s.id ? <><Spinner size={12} color={T.redHot} /> Signing out…</> : 'Sign out'}
            </Btn>
          )}
        </div>
      ))}

      {!loading && !failed && others > 0 && (
        <div style={{ padding: '13px 24px' }}>
          <LinkBtn
            color={T.redHot}
            onClick={signOutOthers}
            disabled={allBusy || busyId !== null}
            style={{ padding: 0 }}
          >
            {allBusy ? <><Spinner size={12} color={T.redHot} /> Signing out…</> : 'Sign out of all other devices'}
          </LinkBtn>
        </div>
      )}
    </Card>
  )
}

// ── Pane ──────────────────────────────────────────────────────────────────────

export default function AccountPane({ user, savedName = '', nameField, orgField, onName, onOrg }) {
  const email     = user?.email || ''
  const shownName = savedName || email.split('@')[0] || 'Your account'
  const initial   = (savedName || email || 'U').charAt(0).toUpperCase()

  // ── Photo ───────────────────────────────────────────────────────────────────
  // `pending` shows the new photo the instant it is saved, without waiting for
  // the USER_UPDATED event to work its way back through AuthContext.
  const fileRef = useRef(null)
  const [pending, setPending] = useState(null)
  const [photoBusy, setPhotoBusy] = useState(false)
  const [photoMsg, setPhotoMsg]   = useState(null)
  const avatarUrl = pending ?? (user?.user_metadata?.avatar_url || '')

  const savePhoto = async (dataUrl) => {
    setPhotoBusy(true); setPhotoMsg(null)
    const { error } = await supabase.auth.updateUser({ data: { avatar_url: dataUrl } })
    setPhotoBusy(false)
    if (error) {
      setPhotoMsg({ type: 'error', text: `That photo could not be saved — ${error.message}` })
      return false
    }
    setPending(dataUrl)
    setPhotoMsg({ type: 'success', text: dataUrl ? 'Photo updated.' : 'Photo removed.' })
    return true
  }

  const pickPhoto = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''                       // so re-picking the same file fires again
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setPhotoMsg({ type: 'error', text: 'That file is not an image. Use a JPEG, PNG or WebP.' })
      return
    }
    setPhotoBusy(true); setPhotoMsg(null)
    let dataUrl
    try {
      dataUrl = await shrinkToDataUrl(file)
    } catch (err) {
      setPhotoBusy(false)
      setPhotoMsg({
        type: 'error',
        text: err?.message === 'too-large'
          ? 'That image could not be compressed small enough. Try a simpler or smaller photo.'
          : 'That image could not be read. Try a JPEG or PNG.',
      })
      return
    }
    await savePhoto(dataUrl)
  }

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
          {/* Mockup: 56px avatar · gap 15 · name 15/700 · email 12.5 · pill on the right.
              `.st-row` stacks this below 900px and `.st-ctl` takes the pill full-width. */}
          <div className="st-row" style={{ display: 'flex', alignItems: 'center', gap: 15, marginBottom: 20 }}>
            {avatarUrl ? (
              <img
                src={avatarUrl}
                alt=""
                style={{
                  flex: 'none', width: 56, height: 56, borderRadius: '50%',
                  objectFit: 'cover', display: 'block', background: T.chip,
                }}
              />
            ) : (
              <span aria-hidden="true" style={{
                flex: 'none', width: 56, height: 56, borderRadius: '50%', background: T.red,
                color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 21, fontWeight: 700, lineHeight: 1,
              }}>{initial}</span>
            )}
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 15, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis' }}>{shownName}</div>
              <div style={{ fontSize: 12.5, color: T.ink4, marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{email}</div>
            </div>
            <div className="st-ctl" style={{ marginLeft: 'auto', flex: 'none', display: 'flex', alignItems: 'center', gap: 8 }}>
              {avatarUrl && !photoBusy && (
                <LinkBtn color={T.muted} onClick={() => savePhoto('')}>Remove</LinkBtn>
              )}
              {/* flex:'1 1 auto' — content width beside the name at desktop, full
                  width once `.st-ctl` goes to 100% below 900px. */}
              <Btn onClick={() => fileRef.current?.click()} disabled={photoBusy} style={{ flex: '1 1 auto' }}>
                {photoBusy ? <><Spinner /> Saving…</> : 'Change photo'}
              </Btn>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              onChange={pickPhoto}
              style={{ display: 'none' }}
              aria-hidden="true"
              tabIndex={-1}
            />
          </div>

          {photoMsg && (
            <div style={{ marginBottom: 16 }}>
              <Msg type={photoMsg.type} onDismiss={() => setPhotoMsg(null)}>{photoMsg.text}</Msg>
            </div>
          )}

          {/* Values are prefilled by Settings.jsx from user_metadata
              (display_name / business) — the same keys saveChanges() writes. */}
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
        </CardBody>

        <Row
          title="Email address"
          desc={`${email} — used for sign-in, receipts and your monitoring digest.`}
          control={<Btn ctl onClick={requestEmailChange}>Request change</Btn>}
          last
        />
      </Card>

      <SessionsCard />
    </>
  )
}
