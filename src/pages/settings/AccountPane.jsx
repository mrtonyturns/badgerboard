// src/pages/settings/AccountPane.jsx — "Your account" pane (/settings/account).
//
// Display name and organization are NOT saved on blur: they feed the shell's
// unsaved-changes bar (Settings.jsx), which is the only thing that writes them.
//
// The photo is the exception — it saves immediately, because there is no text
// field to hold it. It is stored INLINE as a data URL in user_metadata
// (avatar_url) rather than in Storage: no bucket, no policy, no public object
// to leak. That only works because the image is downscaled to a 96px square
// JPEG first, which lands around 3–8KB. See shrinkToDataUrl().

import React, { useRef, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { Card, CardBody, Row, Field, Btn, LinkBtn, Pill, Note, Msg, Spinner, StubPill, T } from './shared'

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
          {/* Mockup: 56px avatar · gap 15 · name 15/700 · email 12.5 · pill on the right */}
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
              <Btn onClick={() => fileRef.current?.click()} disabled={photoBusy}>
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
