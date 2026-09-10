// OnboardingChecklist.jsx — the "Get set up" card that sits at the top of both
// dashboards until the account is set up (or the user dismisses it).
//
// Presentational on purpose: it takes an already-built `steps` array (see
// ./steps.js — that's the unit-tested half) plus two callbacks, and holds no
// data of its own. It does not import the router either; the dashboard passes
// `onNavigate`, so this file can be rendered anywhere and tested in isolation.
//
// Styling matches the dashboards, not Tailwind: tokens come from
// pages/dashboard/shared so the card can't drift from the cards below it.

import React from 'react'
import { T, Card, CtaButton, TextLink } from '../../pages/dashboard/shared'
import { onboardingProgress } from './steps.js'

// ── check circle ─────────────────────────────────────────────────────────────
// Three states, and the third one matters: a step the plan doesn't sell is
// neither done nor waiting on the user, so it gets an upgrade caret rather than
// an empty circle that reads as "you forgot this". (A caret, not a padlock
// emoji — the rest of the dashboard uses text glyphs like ✦ ⚑︎ ◷ ☰, which
// render identically everywhere; emoji do not.)
function StepMark({ done, locked }) {
  if (done) {
    return (
      <span
        aria-hidden="true"
        style={{
          flex: 'none', width: 22, height: 22, borderRadius: '50%',
          background: T.red, color: '#fff', fontSize: 12, fontWeight: 700,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
      >✓</span>
    )
  }
  return (
    <span
      aria-hidden="true"
      style={{
        flex: 'none', width: 22, height: 22, borderRadius: '50%',
        border: `1.5px solid ${locked ? T.border : '#D9CDCD'}`,
        background: locked ? T.chip : T.card,
        color: locked ? T.warmInk : T.faint,
        fontSize: 11, fontWeight: 700, lineHeight: 1,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >{locked ? '↑' : ''}</span>
  )
}

// ── one row ──────────────────────────────────────────────────────────────────
function StepRow({ step, index, onNavigate }) {
  const { done, locked, label, why, cta, href } = step
  const interactive = !done && typeof onNavigate === 'function'
  return (
    <div
      className={interactive ? 'bb-row' : undefined}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={interactive ? () => onNavigate(href) : undefined}
      onKeyDown={interactive ? (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onNavigate(href) }
      } : undefined}
      style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '10px 12px', margin: '0 -12px', borderRadius: 10,
        cursor: interactive ? 'pointer' : 'default',
      }}
    >
      <StepMark done={done} locked={locked} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{
          fontSize: 13, fontWeight: 600, lineHeight: 1.35,
          color: done ? T.faint : T.ink,
          textDecoration: done ? 'line-through' : 'none',
        }}>
          <span style={{ color: T.faint, fontWeight: 600, marginRight: 6 }}>{index + 1}.</span>
          {label}
        </div>
        <div style={{
          fontSize: 11, color: T.faint, marginTop: 2, lineHeight: 1.45,
          overflow: 'hidden', textOverflow: 'ellipsis',
        }}>{done ? 'Done' : why}</div>
      </div>
      {!done && (
        <span style={{
          flex: 'none', display: 'flex', alignItems: 'center', gap: 5,
          fontSize: 11.5, fontWeight: 600, color: T.red, whiteSpace: 'nowrap',
        }}>
          {cta}<span aria-hidden="true">→</span>
        </span>
      )}
    </div>
  )
}

// ── card ─────────────────────────────────────────────────────────────────────
/**
 * @param {Array}    steps        from buildOnboardingSteps()
 * @param {Function} onDismiss    called when the user clicks Dismiss
 * @param {Function} onNavigate   (href) => void — the dashboard's nav()
 * @param {boolean}  welcome      true on a genuinely empty account: the card
 *                                becomes the page's hero instead of a strip
 * @param {string}   firstName    used only by the welcome heading
 */
export default function OnboardingChecklist({
  steps = [],
  onDismiss,
  onNavigate,
  welcome = false,
  firstName,
}) {
  const { done, total, complete } = onboardingProgress(steps)

  // Belt and braces — the dashboards already gate on this, but a completed
  // checklist must never be able to render from anywhere.
  if (!steps.length || complete) return null

  const pct = total ? Math.round((done / total) * 100) : 0
  const primary = steps.find(s => !s.done && !s.locked) || steps.find(s => !s.done)

  return (
    <Card
      style={{
        marginBottom: 18,
        padding: welcome ? '26px 28px' : '20px 24px',
        // The welcome variant is the hero of an otherwise-empty page, so it
        // gets the brand accent; the returning-user strip stays quiet so it
        // doesn't outrank the real data underneath it.
        borderColor: welcome ? '#EBD7D7' : T.border,
        background: welcome
          ? 'linear-gradient(180deg, #FEFAFA 0%, #FFFFFF 62%)'
          : T.card,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 240 }}>
          {welcome ? (
            <>
              <span style={{
                fontSize: 9, fontWeight: 700, letterSpacing: '.6px', color: T.red,
                background: '#FBEAEA', borderRadius: 99, padding: '3px 8px',
              }}>GETTING STARTED</span>
              <div style={{
                fontSize: 21, fontWeight: 700, letterSpacing: '-.3px', marginTop: 11,
              }}>
                Welcome to Badger Board{firstName ? `, ${firstName}` : ''}
              </div>
              <div style={{
                fontSize: 13, color: T.muted, lineHeight: 1.55, marginTop: 6, maxWidth: 620,
              }}>
                Badger Board tracks the candidates in your race — neutral AI research,
                weekly monitoring digests, voter data and a dated plan, all in one place.
                Four steps and this dashboard fills in.
              </div>
            </>
          ) : (
            <>
              <div style={{ fontSize: 15, fontWeight: 700 }}>Get set up</div>
              <div style={{ fontSize: 12, color: T.muted, marginTop: 3 }}>
                A few steps left before this dashboard has everything it needs.
              </div>
            </>
          )}
        </div>

        <div style={{ flex: 'none', minWidth: 150, textAlign: 'right' }}>
          <div style={{ fontSize: 11.5, fontWeight: 600, color: T.muted }}>
            {done} of {total} complete
          </div>
          <div
            role="progressbar"
            aria-valuenow={done}
            aria-valuemin={0}
            aria-valuemax={total}
            aria-label="Setup progress"
            style={{
              height: 6, borderRadius: 99, background: T.chip,
              overflow: 'hidden', marginTop: 7, width: 150, marginLeft: 'auto',
            }}
          >
            <div style={{
              width: `${pct}%`, height: '100%', background: T.red,
              transition: 'width .25s ease',
            }} />
          </div>
        </div>
      </div>

      <div style={{
        display: 'flex', flexDirection: 'column',
        marginTop: welcome ? 18 : 12,
        paddingTop: welcome ? 16 : 10,
        borderTop: `1px solid ${T.divider}`,
      }}>
        {steps.map((s, i) => (
          <StepRow key={s.id} step={s} index={i} onNavigate={onNavigate} />
        ))}
      </div>

      <div style={{
        display: 'flex', alignItems: 'center', gap: 12,
        marginTop: welcome ? 18 : 12, flexWrap: 'wrap',
      }}>
        {welcome && primary && (
          <CtaButton
            onClick={() => onNavigate?.(primary.href)}
            style={{ padding: '10px 20px', fontSize: 12.5 }}
          >
            {primary.id === 'candidate' ? 'Add your first candidate' : primary.cta}
          </CtaButton>
        )}
        <span style={{ marginLeft: welcome ? 0 : 'auto' }}>
          {/* Honest about what it does: dismissing hides the card, it does not
              mark anything as done, and finishing the steps hides it anyway. */}
          <TextLink onClick={onDismiss} style={{ fontSize: 11, color: T.faint }}>
            Dismiss — I'll set this up myself
          </TextLink>
        </span>
      </div>
    </Card>
  )
}
