// useFeature('offices') → true when the signed-in account may use a feature.
// Same rule as FeatureRoute and the sidebar: admins and beta testers see
// everything; everyone else gets their plan's flags (tiers.js, including the
// plan-family lineup in FAMILY_FEATURES).
import { useAuth } from '../contexts/AuthContext'
import { getUserPlan, hasFeature, isBetaActive } from './tiers'

export function canUseFeature(user, isAdmin, feature) {
  if (isAdmin || isBetaActive(user)) return true
  return hasFeature(getUserPlan(user), feature)
}

export default function useFeature(feature) {
  const { user, isAdmin } = useAuth()
  return canUseFeature(user, isAdmin, feature)
}
