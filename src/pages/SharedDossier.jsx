// src/pages/SharedDossier.jsx — the public, time-limited share of a profile.
//
// Same route (/temporary-dossier/:token) and same endpoint as before. What
// changed is the body: it now renders the SAME reader component the Profiler
// uses (src/pages/profiler/ReportReader.jsx) instead of a second copy of the
// markdown pipeline, so the shared view can never drift from the in-app one.
//
// Still no auth dependency: everything session-shaped (research note actions,
// share management, regenerate) is simply not passed in.

import React, { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { formatDistanceToNow } from 'date-fns'
import ReportReader from './profiler/ReportReader'
import { ProfilerStyles, T, cardStyle } from './profiler/shared'
import { parseSections, buildReport, buildPrintHtml } from './profiler/reportModel'
import { filterSections } from '../lib/profileContent'
import { WebOnlyCta } from '../components/UpgradeCta'

export default function SharedDossier() {
  const { token } = useParams()
  const [state, setState]     = useState('loading') // loading | ready | expired | notfound | error
  const [dossier, setDossier] = useState(null)
  const [share, setShare]     = useState(null)

  useEffect(() => {
    if (!token) { setState('notfound'); return }
    fetch(`/.netlify/functions/get-shared-dossier?token=${encodeURIComponent(token)}`)
      .then(res => res.json().then(data => ({ ok: res.ok, status: res.status, data })))
      .then(({ ok, status, data }) => {
        if (status === 410) { setState('expired'); return }
        if (status === 404) { setState('notfound'); return }
        if (!ok) { setState('error'); return }
        setDossier(data.dossier)
        setShare(data.share)
        setState('ready')
      })
      .catch(() => setState('error'))
  }, [token])

  const exportPdf = () => {
    if (!dossier) return
    const { sections } = filterSections(parseSections(dossier.content || ''))
    const report = buildReport(dossier.content || '', sections)
    const win = window.open('', '_blank')
    if (!win) return
    win.document.write(buildPrintHtml(dossier, report))
    win.document.close()
    setTimeout(() => { win.focus(); win.print() }, 700)
  }

  if (state === 'loading') {
    return (
      <Frame>
        <div style={{ ...cardStyle, padding: '48px 24px', textAlign: 'center' }}>
          <div style={{ fontSize: 13.5, fontWeight: 600 }}>Loading this profile…</div>
        </div>
      </Frame>
    )
  }

  if (state !== 'ready') {
    const messages = {
      expired:  { title: 'This link has expired', body: 'Temporary profile links stop working automatically. Ask the person who shared it for a new one.' },
      notfound: { title: 'This link is not active', body: 'It is either invalid or it has been deactivated by the person who created it.' },
      error:    { title: 'This profile could not be loaded', body: 'Something went wrong on our side. Try again in a moment.' },
    }
    const m = messages[state] || messages.error
    return (
      <Frame>
        <div style={{ ...cardStyle, padding: '48px 24px', textAlign: 'center', maxWidth: 520, margin: '0 auto' }}>
          <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>{m.title}</div>
          <div style={{ fontSize: 13, color: T.ink4, lineHeight: 1.6 }}>{m.body}</div>
        </div>
      </Frame>
    )
  }

  const expired = share?.expires_at ? new Date(share.expires_at) < new Date() : false
  const expiresLabel = share?.expires_at && !expired
    ? `Access ends ${formatDistanceToNow(new Date(share.expires_at), { addSuffix: true })}`
    : expired ? 'Access has ended' : ''

  return (
    <Frame wide>
      <ReportReader
        dossier={dossier}
        content={dossier.content || ''}
        onExportPdf={exportPdf}
        exportLabel="Print / save as PDF"
        notice={(
          <div style={{
            display: 'flex', alignItems: 'flex-start', gap: 12, background: T.warmBg,
            border: `1px solid ${T.warmBr}`, borderRadius: 14, padding: '13px 18px', marginBottom: 16,
            flexWrap: 'wrap',
          }}>
            <div style={{ fontSize: 12, color: T.ink3, lineHeight: 1.6, flex: 1, minWidth: 240 }}>
              <strong style={{ fontWeight: 700 }}>Temporary profile link.</strong>{' '}
              This report is AI-generated from publicly available sources and has not been
              independently verified. Do not use it for FCRA-regulated purposes (employment,
              credit, housing) or in formal legal proceedings. The Bluejack Group assumes no
              liability for the use of shared profile links.
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, textAlign: 'right', flex: 'none' }}>
              {expiresLabel && (
                <span style={{ fontSize: 11.5, fontWeight: 700, color: T.amber }}>{expiresLabel}</span>
              )}
              {share && (
                <span style={{ fontSize: 11, color: T.muted }}>
                  {(share.view_count + 1).toLocaleString()} view{share.view_count + 1 === 1 ? '' : 's'}
                </span>
              )}
            </div>
          </div>
        )}
      />
    </Frame>
  )
}

// ─── Public chrome ───────────────────────────────────────────────────────────

function Frame({ children, wide }) {
  return (
    <div style={{
      minHeight: '100vh', background: T.page, fontFamily: T.font, color: T.ink,
      display: 'flex', flexDirection: 'column',
    }}>
      <ProfilerStyles />
      <header style={{ background: T.navy, color: '#fff', flex: 'none' }}>
        <div style={{
          maxWidth: 1180, margin: '0 auto', padding: '14px 20px',
          display: 'flex', alignItems: 'center', gap: 12,
        }}>
          <span style={{
            fontFamily: "'Archivo',system-ui,sans-serif", fontWeight: 900,
            fontSize: 14, letterSpacing: '.6px',
          }}>BADGERBOARD</span>
          <span style={{ fontSize: 11.5, color: '#B7BECD' }}>Temporary intelligence profile</span>
          <Link
            to="/login"
            style={{
              marginLeft: 'auto', fontSize: 11.5, fontWeight: 600, color: '#fff',
              border: '1px solid rgba(255,255,255,.28)', borderRadius: 99,
              padding: '8px 14px', textDecoration: 'none',
            }}
          >Sign in</Link>
        </div>
      </header>

      <main style={{ flex: 1, width: '100%', maxWidth: wide ? 1180 : 760, margin: '0 auto', padding: '24px 20px 48px' }}>
        {children}
      </main>

      <footer style={{ background: T.navy, color: '#fff', flex: 'none' }}>
        <div style={{
          maxWidth: 1180, margin: '0 auto', padding: '20px', display: 'flex',
          alignItems: 'center', gap: 16, flexWrap: 'wrap',
        }}>
          <div style={{ fontSize: 11.5, color: '#B7BECD', lineHeight: 1.55, maxWidth: '62ch' }}>
            Badger Board by The Bluejack Group · AI-generated political intelligence.
            Shared via a temporary link. All information requires independent verification.
          </div>
          {/* Acquisition CTA — hidden inside the native app, where store rules
              forbid steering users to an external purchase flow. */}
          <WebOnlyCta>
            <Link
              to="/plans"
              style={{
                marginLeft: 'auto', background: T.red, color: '#fff', borderRadius: 99,
                padding: '9px 16px', fontSize: 12, fontWeight: 600, textDecoration: 'none',
                whiteSpace: 'nowrap',
              }}
            >Run your own profiles</Link>
          </WebOnlyCta>
          <div style={{ fontSize: 11, color: '#8A93A6', width: '100%' }}>
            © {new Date().getFullYear()} The Bluejack Group ·{' '}
            <a href="/dossier-disclaimer" style={{ color: '#B7BECD' }}>Disclaimer</a> ·{' '}
            <a href="/terms" style={{ color: '#B7BECD' }}>Terms</a>
          </div>
        </div>
      </footer>
    </div>
  )
}
