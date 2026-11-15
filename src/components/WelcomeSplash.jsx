// WelcomeSplash — the animation that plays once right after you sign in.
//
// The Badger Board logo rises in on the brand navy, then the number of days
// until your election counts up underneath it ("47 days until the November 3
// General Election"). Candidate plans count down to their own race (the
// candidate record that is you); Action plans and anyone without a race on
// file see the next Wisconsin election. ~3 s, click or press any key to skip,
// and a calm still version for people who ask for reduced motion.
//
// Login.jsx sets sessionStorage 'bb_welcome' on a successful sign-in; this
// component consumes the flag, so a refresh or a later visit in the same tab
// never replays it.

import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { getCandidates, getElections } from '../lib/supabase'
import { getUserPlanType } from '../lib/tiers'
import { daysUntil, isUpcoming } from '../pages/dashboard/dueMath'
import { resolveSelfCandidate } from '../pages/dashboard/CandidateDashboard'

import { WELCOME_FLAG } from '../lib/welcome'

function takeWelcomeFlag() {
  try {
    const on = sessionStorage.getItem(WELCOME_FLAG) === '1'
    sessionStorage.removeItem(WELCOME_FLAG)
    return on
  } catch { return false }
}

const NAVY = '#0A1628'
const RED = '#B91C1C'
const SHOW_MS = 3200          // whole animation, including the fade-out
const DATA_WAIT_MS = 1400     // never hold the logo longer than this for the number
const reducedMotion = () => {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return false }
}

function raceLabel(e) {
  if (!e) return ''
  const d = new Date(`${String(e.election_date).slice(0, 10)}T12:00:00`)
  const when = d.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })
  const name = String(e.name || '').trim()
  return name ? `${when} ${name.replace(/^\d{4}\s+/, '')}` : `${when} election`
}

export default function WelcomeSplash() {
  const { user } = useAuth()
  const [active] = useState(() => takeWelcomeFlag())
  const [race, setRace] = useState(undefined)     // undefined = looking, null = none
  const [shown, setShown] = useState(0)           // the counting number
  const [leaving, setLeaving] = useState(false)
  const [gone, setGone] = useState(!active)
  const calm = useRef(reducedMotion()).current

  // Find the race: your own election first, else the next one in Wisconsin.
  useEffect(() => {
    if (!active || !user) return
    let dead = false
    const timer = setTimeout(() => { if (!dead) setRace(r => (r === undefined ? null : r)) }, DATA_WAIT_MS)
    ;(async () => {
      try {
        const [c, e] = await Promise.all([
          getUserPlanType(user) === 'candidate' ? getCandidates({}) : Promise.resolve({ data: [] }),
          getElections(),
        ])
        if (dead) return
        const self = resolveSelfCandidate(user, c.data || [])
        const mine = self?.election?.election_date && isUpcoming(self.election.election_date) ? self.election : null
        const next = (e.data || [])
          .filter(x => isUpcoming(x.election_date))
          .sort((a, b) => String(a.election_date).localeCompare(String(b.election_date)))[0] || null
        setRace(mine || next || null)
      } catch { if (!dead) setRace(null) }
    })()
    return () => { dead = true; clearTimeout(timer) }
  }, [active, user])

  const days = race ? daysUntil(race.election_date) : null

  // Count the number up once it's known.
  useEffect(() => {
    if (days === null || days === undefined) return
    if (calm || days <= 0) { setShown(Math.max(0, days)); return }
    const start = performance.now(), dur = 1100
    let raf
    const tick = (now) => {
      const p = Math.min(1, (now - start) / dur)
      setShown(Math.round(days * (1 - Math.pow(1 - p, 3))))
      if (p < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [days, calm])

  // Leave on schedule, or on any click / key.
  useEffect(() => {
    if (!active || gone) return
    const leave = () => setLeaving(true)
    const t = setTimeout(leave, calm ? 1800 : SHOW_MS - 450)
    window.addEventListener('keydown', leave)
    return () => { clearTimeout(t); window.removeEventListener('keydown', leave) }
  }, [active, gone, calm])
  useEffect(() => {
    if (!leaving) return
    const t = setTimeout(() => setGone(true), 450)
    return () => clearTimeout(t)
  }, [leaving])

  if (gone) return null

  const today = days === 0
  return (
    <div
      role="status"
      aria-live="polite"
      onClick={() => setLeaving(true)}
      style={{
        position: 'fixed', inset: 0, zIndex: 10000, background: NAVY,
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        padding: 24, cursor: 'pointer', textAlign: 'center',
        opacity: leaving ? 0 : 1, transition: 'opacity 450ms ease',
      }}
    >
      <style>{`
        @keyframes bbRise { from { opacity: 0; transform: translateY(18px) scale(.94) } to { opacity: 1; transform: none } }
        @keyframes bbFadeUp { from { opacity: 0; transform: translateY(10px) } to { opacity: 1; transform: none } }
        @keyframes bbSweep { from { transform: scaleX(0) } to { transform: scaleX(1) } }
      `}</style>
      <img
        src="/badger-board-logo.png"
        alt="Badger Board"
        style={{ width: 'min(300px, 62vw)', height: 'auto', animation: calm ? 'none' : 'bbRise 700ms cubic-bezier(.2,.8,.2,1) both' }}
      />
      <div style={{ height: 3, width: 'min(300px, 62vw)', marginTop: 22, background: RED, transformOrigin: 'left', animation: calm ? 'none' : 'bbSweep 900ms 250ms cubic-bezier(.2,.8,.2,1) both' }} />

      <div style={{ minHeight: 120, marginTop: 26, fontFamily: "'Geist','Inter',system-ui,sans-serif" }}>
        {race && days !== null && (
          <div style={{ animation: calm ? 'none' : 'bbFadeUp 500ms 350ms both' }}>
            {today ? (
              <div style={{ fontSize: 'clamp(40px, 9vw, 72px)', fontWeight: 800, color: '#fff', lineHeight: 1 }}>Election Day</div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'center', gap: 12 }}>
                <span style={{ fontSize: 'clamp(56px, 13vw, 104px)', fontWeight: 800, color: '#fff', lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>{shown}</span>
                <span style={{ fontSize: 'clamp(18px, 3.4vw, 26px)', fontWeight: 600, color: 'rgba(255,255,255,.82)' }}>{days === 1 ? 'day' : 'days'}</span>
              </div>
            )}
            <div style={{ fontSize: 'clamp(14px, 2.4vw, 17px)', color: 'rgba(255,255,255,.7)', marginTop: 10 }}>
              {today ? `It's here: ${raceLabel(race)}` : `until the ${raceLabel(race)}`}
            </div>
          </div>
        )}
        {race === null && (
          <div style={{ fontSize: 18, color: 'rgba(255,255,255,.8)', animation: calm ? 'none' : 'bbFadeUp 500ms 350ms both' }}>Welcome back</div>
        )}
      </div>
    </div>
  )
}
