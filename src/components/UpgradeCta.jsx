import React from 'react'
import { Link } from 'react-router-dom'
import { isNativeApp } from '../lib/native'

/**
 * Store-rules helpers for upgrade CTAs.
 *
 * App Store and Play Store rules don't allow an app to steer users to an
 * external purchase flow for a digital subscription. Pricing.jsx,
 * settings/PlanPane.jsx and components/UpgradePrompt.jsx each already branch on
 * `isNativeApp` for exactly this reason; the one-off "Upgrade →" links and
 * "/plans" buttons scattered through Dossiers, Candidates, CandidateDetail and
 * SharedDossier did not, and shipped a live upgrade funnel inside the native
 * shell. These two components are the shared version of the same rule so the
 * remaining call sites stop drifting apart.
 *
 * Both take a `native` prop:
 *   omitted / null  → render nothing at all inside the app (hide the CTA)
 *   any node        → render that instead (neutral, non-linking copy)
 */

/** Standard neutral replacement copy. */
export const NATIVE_PLAN_NOTE =
  'Plan changes are made from your account on the Badger Board website.'

/** Drop-in for `<Link to="/plans">…</Link>`. */
export function UpgradeLink({ children, native = null, ...rest }) {
  if (isNativeApp) return native
  return <Link to="/plans" {...rest}>{children}</Link>
}

/**
 * Wrapper for CTAs that aren't links — buttons with an `onClick` that navigates
 * to /plans, price callouts, credit-pack prompts.
 */
export function WebOnlyCta({ children, native = null }) {
  return isNativeApp ? <>{native}</> : <>{children}</>
}

/** True inside the native shell — for the rare call site that needs the raw flag. */
export { isNativeApp }
