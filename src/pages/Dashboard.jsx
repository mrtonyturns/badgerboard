import { Suspense, lazy } from 'react'
import LoadingBar from '../components/LoadingBar'
import { useAuth } from '../contexts/AuthContext'
import { getUserPlanType, getUserPlan, hasFeature } from '../lib/tiers'

// Two plan-specific dashboards. The plan family in src/lib/tiers.js decides
// which one renders: candidate-family plans get the candidate-running-their-own-
// campaign view, action-family plans get the portfolio view used by managers,
// consultants, county parties and agencies.
const CandidateDashboard = lazy(() => import('./dashboard/CandidateDashboard'))
const ActionDashboard    = lazy(() => import('./dashboard/ActionDashboard'))
// Nov 15 2026: Candidate plans get the Field home instead of the old dashboard
// (tiers.js FAMILY_FEATURES.candidate.fieldHome). Admins keep their portfolio view.
const FieldHome          = lazy(() => import('./dashboard/FieldHome'))

export default function Dashboard() {
  const { user, loading } = useAuth()

  // Wait for the session before choosing. getUserPlanType() falls back to
  // 'candidate' for a null user, so rendering early would flash the wrong
  // dashboard at an action-plan user on every hard refresh.
  if (loading) return <LoadingBar loading />

  const planType = getUserPlanType(user)   // 'candidate' | 'action'

  return (
    <Suspense fallback={<LoadingBar loading />}>
      {planType === 'action' ? <ActionDashboard /> : hasFeature(getUserPlan(user), 'fieldHome') ? <FieldHome /> : <CandidateDashboard />}
    </Suspense>
  )
}
