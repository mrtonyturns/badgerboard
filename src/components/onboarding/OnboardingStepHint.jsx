// OnboardingStepHint.jsx — the one line that ties a page's existing empty
// state back to the dashboard checklist ("This is step 2 of your setup →").
//
// Deliberately tiny, and deliberately self-contained: every call site is a
// single line inside an empty state that already exists, so this component
// does its own dismissal check rather than making four pages thread a user id
// through. If the user has dismissed the checklist they have said they don't
// want to be walked through setup — so the hint goes quiet too.
//
// Styled inline rather than with Tailwind classes because two of the four
// pages that use it (Dossiers, Prospecting) are inline-token pages; inline
// styles land identically on both kinds.

import React from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import { getUserPlan, isActionPlan } from '../../lib/tiers.js'
import {
  ONBOARDING_STEP_COUNT, onboardingStepNumber, isOnboardingDismissed,
} from './steps.js'

/**
 * @param {string}  stepId  'candidate' | 'profile' | 'monitoring' | 'voter-list' | 'game-plan'
 * @param {string} [to]     where the step is done, when it isn't this page
 * @param {string} [linkLabel]
 * @param {object} [style]
 */
export default function OnboardingStepHint({ stepId, to, linkLabel = 'Back to your dashboard', style }) {
  const { user } = useAuth()
  const n = onboardingStepNumber(stepId)
  if (!n || isOnboardingDismissed(user?.id)) return null
  // Step 4 is family-specific (Action uploads a voter list, Candidate builds a
  // game plan). Don't number a step that isn't on this account's checklist.
  const action = isActionPlan(getUserPlan(user))
  if (stepId === 'voter-list' && !action) return null
  if (stepId === 'game-plan' && action) return null
  return (
    <div style={{ fontSize: 11.5, color: '#A1A19A', marginTop: 10, ...style }}>
      This is step {n} of {ONBOARDING_STEP_COUNT} in your setup
      {to && (
        <>
          {' · '}
          <Link to={to} style={{ color: '#8B0000', fontWeight: 600, textDecoration: 'none' }}>
            {linkLabel} →
          </Link>
        </>
      )}
    </div>
  )
}
