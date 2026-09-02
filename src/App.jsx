import React, { Suspense, lazy } from 'react'
import { BrowserRouter, Routes, Route, Navigate, useParams, useLocation } from 'react-router-dom'

// ─── Stale-deploy chunk recovery ─────────────────────────────────────────────
// A phone that kept the app open across a deploy holds an old bundle whose
// lazy-route chunk hashes no longer exist on the CDN. The import then fails
// ("Failed to fetch dynamically imported module" / Safari: "Importing a module
// script failed") and the user sees the error screen. Recovery: reload ONCE —
// the fresh shell carries the new hashes. A sessionStorage guard prevents a
// reload loop when the failure is something else (e.g. genuinely offline).
const CHUNK_ERR = /failed to fetch dynamically imported module|importing a module script failed|error loading dynamically imported module|chunkloaderror|failed to load module script/i
const RELOAD_GUARD = 'bb-chunk-reload'

function reloadOnceForStaleChunk(err) {
  try {
    if (!CHUNK_ERR.test(String(err?.message || err || ''))) return false
    if (sessionStorage.getItem(RELOAD_GUARD)) return false
    sessionStorage.setItem(RELOAD_GUARD, String(Date.now()))
    window.location.reload()
    return true
  } catch { return false }
}

// Vite fires this for failed <link rel="modulepreload"> / dynamic imports.
if (typeof window !== 'undefined') {
  window.addEventListener('vite:preloadError', (event) => {
    if (reloadOnceForStaleChunk(event?.payload || { message: 'failed to fetch dynamically imported module' })) {
      event.preventDefault()
    }
  })
}

const lazyRetry = (factory) => lazy(() =>
  factory().catch((err) => {
    if (reloadOnceForStaleChunk(err)) return new Promise(() => {}) // page is reloading
    throw err
  })
)

// ─── Global error boundary ────────────────────────────────────────────────────
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, error: null }
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error }
  }
  componentDidCatch(error, info) {
    console.error('[ErrorBoundary] Unhandled error:', error, info)
    reloadOnceForStaleChunk(error)
  }
  componentDidMount() {
    try { sessionStorage.removeItem(RELOAD_GUARD) } catch { /* noop */ }
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-brand-navy flex items-center justify-center p-8">
          <div className="text-center max-w-md">
            <div className="w-16 h-16 bg-red-500/20 rounded-full flex items-center justify-center mx-auto mb-4">
              <span className="text-3xl font-black text-red-400">!</span>
            </div>
            <h1 className="text-white text-xl font-bold mb-2">Something went wrong</h1>
            <p className="text-white/60 text-sm mb-6">
              An unexpected error occurred. Please refresh the page to continue.
            </p>
            <button
              onClick={() => { this.setState({ hasError: false, error: null }); window.location.reload() }}
              className="bg-brand-red text-white px-6 py-2.5 rounded-lg text-sm font-medium hover:bg-red-700 transition-colors"
            >
              Refresh page
            </button>
            {process.env.NODE_ENV === 'development' && this.state.error && (
              <pre className="mt-4 text-left text-xs text-red-300 bg-black/30 rounded p-3 overflow-auto max-h-40">
                {this.state.error.toString()}
              </pre>
            )}
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
import { AuthProvider, useAuth } from './contexts/AuthContext'
import { isBetaActive, hasFeature, getUserPlan } from './lib/tiers'
import { supabaseConfigured } from './lib/supabase'
import { DossierStatusProvider } from './contexts/DossierStatusContext'
import Layout from './components/Layout'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import Offices from './pages/Offices'
const Elections = lazyRetry(() => import('./pages/Elections'))  // code-split: trims the initial bundle (M1)
const GamePlan = lazyRetry(() => import('./pages/GamePlan'))  // code-split: trims the initial bundle (M1)
// ElectionResults (legacy standalone page) replaced by Elections.jsx two-tab UI.
// Redirect helper preserves bookmarked /elections/results/:id URLs.
function ElectionResultsRedirect() {
  const { id } = useParams()
  return <Navigate to={`/elections?tab=results${id ? `&election=${id}` : ''}`} replace />
}
const Candidates = lazyRetry(() => import('./pages/Candidates'))  // code-split: trims the initial bundle (M1)
const CandidateDetail = lazyRetry(() => import('./pages/CandidateDetail'))  // code-split: trims the initial bundle (M1)
const Prospecting = lazyRetry(() => import('./pages/Prospecting'))  // code-split: trims the initial bundle (M1)
const Recruit = lazyRetry(() => import('./pages/Recruit'))  // code-split: Action-plan exclusive (v1.29)
const VoterLists = lazyRetry(() => import('./pages/VoterLists'))  // code-split: trims the initial bundle (M1)
// Door Knocking — re-enabled Sept 2026 (QA bug #2: the page shipped in the
// bundle but had no route, so every link/bookmark 404'd). Admin-gated as it
// was when parked; the page sells Scout users the upgrade in-page.
const DoorKnocking = lazyRetry(() => import('./pages/DoorKnocking'))  // code-split: heavy Leaflet page
const CampaignConnect = lazyRetry(() => import('./pages/CampaignConnect'))  // code-split: trims the initial bundle (M1)
const Dossiers = lazyRetry(() => import('./pages/Dossiers'))  // code-split: trims the initial bundle (M1)
import Settings from './pages/Settings'
import Terms from './pages/Terms'
const Pricing = lazyRetry(() => import('./pages/Pricing'))  // code-split: trims the initial bundle (M1)
const AdminDashboard = lazyRetry(() => import('./pages/AdminDashboard'))  // code-split: trims the initial bundle (M1)
import DossierDisclaimer from './pages/DossierDisclaimer'
const Compare = lazyRetry(() => import('./pages/Compare'))  // code-split: trims the initial bundle (M1)
import VolunteerPortal from './pages/VolunteerPortal'
import SharedDossier from './pages/SharedDossier'
const Events = lazyRetry(() => import('./pages/Events'))  // code-split: trims the initial bundle (M1)
const Broadside = lazyRetry(() => import('./pages/Broadside'))  // code-split: admin-only beta
const CityDemographics = lazyRetry(() => import('./pages/CityDemographics'))  // code-split: trims the initial bundle (M1)
const Polling = lazyRetry(() => import('./pages/Polling'))  // code-split: beta-only (v1.22)
import ResetPassword from './pages/ResetPassword'
import NotFound from './pages/NotFound'

const ProtectedRoute = ({ children }) => {
  const { user, loading } = useAuth()

  if (loading) {
    return (
      <div className="min-h-screen bg-brand-navy flex items-center justify-center">
        <div className="text-center">
          <div className="w-12 h-12 border-4 border-brand-red border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-white/70 text-sm">Loading...</p>
        </div>
      </div>
    )
  }

  if (!user) return <Navigate to="/login" replace />
  return children
}

// Admin-only route — redirects non-admins silently to dashboard
const AdminRoute = ({ children }) => {
  const { isAdmin, loading } = useAuth()
  if (loading) {
    return (
      <div className="min-h-screen bg-brand-navy flex items-center justify-center">
        <div className="w-12 h-12 border-4 border-brand-red border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }
  if (!isAdmin) return <Navigate to="/" replace />
  return children
}

// Beta-only route (v1.22) — silently redirects everyone without beta access to
// the dashboard. Intentionally NOT a "you're not allowed" page: the feature
// shouldn't be discoverable outside the beta group.
const BetaRoute = ({ children }) => {
  const { user, isAdmin, loading } = useAuth()
  if (loading) {
    return (
      <div className="min-h-screen bg-brand-navy flex items-center justify-center">
        <div className="w-12 h-12 border-4 border-brand-red border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }
  if (!isAdmin && !isBetaActive(user)) return <Navigate to="/" replace />
  return children
}

// Feature route — plan-feature gate (v1.18.2). Admins and beta-mode users pass
// automatically because getUserPlan resolves them to the top plan; paid plans
// pass via their feature flag in tiers.js.
const FeatureRoute = ({ feature, children }) => {
  const { user, isAdmin, loading } = useAuth()
  if (loading) {
    return (
      <div className="min-h-screen bg-brand-navy flex items-center justify-center">
        <div className="w-12 h-12 border-4 border-brand-red border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }
  if (!isAdmin && !isBetaActive(user) && !hasFeature(getUserPlan(user), feature)) return <Navigate to="/" replace />
  return children
}

// Routes that must paint without waiting for the auth session to restore.
// Restoring a session can take up to 10 seconds (AuthContext races getSession()
// against a 10s timeout), and holding the whole router behind that spinner blanked
// the volunteer portal, shared profile links and the login screen for visitors who
// have no session to restore in the first place. Each of these either brings its
// own auth (the volunteer portal) or needs none at all.
const PUBLIC_PATHS = [
  /^\/v(\/|$)/,
  /^\/volunteer(\/|$)/,
  /^\/temporary-dossier(\/|$)/,
  /^\/login(\/|$)/,
  /^\/reset-password(\/|$)/,
  /^\/terms(\/|$)/,
  /^\/plans(\/|$)/,
  /^\/dossier-disclaimer(\/|$)/,
]
const isPublicPath = (pathname) => PUBLIC_PATHS.some(re => re.test(pathname))

const AppRoutes = () => {
  const { user, loading } = useAuth()
  const { pathname } = useLocation()

  // Protected routes still wait — ProtectedRoute/AdminRoute would otherwise
  // bounce a signed-in user to /login before the session lands.
  if (loading && !isPublicPath(pathname)) {
    return (
      <div className="min-h-screen bg-brand-navy flex items-center justify-center">
        <div className="w-12 h-12 border-4 border-brand-red border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  return (
    <Suspense fallback={
      <div className="flex items-center justify-center py-24">
        <div className="w-10 h-10 border-4 border-brand-red border-t-transparent rounded-full animate-spin" />
      </div>
    }>
    <Routes>
      {/* Volunteer portal — completely separate auth, no Layout */}
      <Route path="/v" element={<VolunteerPortal />} />
      <Route path="/volunteer" element={<Navigate to="/v" replace />} />

      {/* Temporary shared dossier — public, no auth */}
      <Route path="/temporary-dossier/:token" element={<SharedDossier />} />

      {/* Renders straight away; once the session restores (if there is one) the
          redirect to the app fires. */}
      <Route path="/login" element={user ? <Navigate to="/" replace /> : <Login />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route path="/terms" element={<Terms />} />
      <Route path="/plans" element={<Pricing />} />
      <Route path="/dossier-disclaimer" element={<DossierDisclaimer />} />
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }
      >
        <Route index element={<Dashboard />} />
        <Route path="offices" element={<Offices />} />
        <Route path="places/:countySlug/:nameSlug" element={<CityDemographics />} />
        <Route path="elections" element={<Elections />} />
        <Route path="elections/results/:id" element={<ElectionResultsRedirect />} />
        <Route path="elections/results" element={<Navigate to="/elections?tab=results" replace />} />
        <Route path="game-plan" element={<GamePlan />} />
        <Route path="candidates" element={<Candidates />} />
        <Route path="candidates/:id" element={<CandidateDetail />} />
        <Route path="prospecting" element={<Prospecting />} />
        {/* Recruit gates in-page with hasFeature(tier,'recruit') + UpgradePrompt,
            exactly like Prospecting — the page sells the upgrade instead of
            bouncing the user to the dashboard. */}
        <Route path="recruit" element={<Recruit />} />
        <Route path="voter-lists" element={<VoterLists />} />
        <Route path="door-knocking" element={<AdminRoute><DoorKnocking /></AdminRoute>} />
        <Route path="dossiers" element={<Dossiers />} />
        <Route path="profiler" element={<Dossiers />} />
        {/* Compare is sold as a plan feature (tiers.js features.compare) and the
            page has no in-page gate of its own — without this any Scout/Monitor
            account could reach it by URL. */}
        <Route path="compare" element={<FeatureRoute feature="compare"><Compare /></FeatureRoute>} />
        <Route path="events" element={<Events />} />
        <Route path="campaign-connect" element={<CampaignConnect />} />
        {/* Settings panes are deep-linkable: /settings/plan, /settings/security, …
            /settings alone renders the default pane (Your account). */}
        <Route path="settings" element={<Settings />} />
        <Route path="settings/:pane" element={<Settings />} />
        {/* /plans is a standalone route above (outside Layout) — the nested
            duplicate rendered the pricing page a second time inside the app
            chrome, which is not what any link to /plans expects. */}
        <Route path="broadside" element={<FeatureRoute feature="broadside"><Broadside /></FeatureRoute>} />
        <Route path="polling" element={<BetaRoute><Polling /></BetaRoute>} />
        <Route path="admin" element={<AdminRoute><AdminDashboard /></AdminRoute>} />
        {/* Catch-all. It lives INSIDE the Layout route so a signed-in user who
            follows a dead link keeps the app chrome and gets told what happened,
            instead of being silently teleported to the Dashboard. Signed-out
            visitors still fall through ProtectedRoute to /login, exactly as
            the old blanket redirect left them. The deliberate legacy redirects
            above (/volunteer, /elections/results…) are unaffected. */}
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
    </Suspense>
  )
}

export default function App() {
  // A build shipped without its Supabase env vars can never work — show a clear
  // message instead of a broken login/white screen.
  if (!supabaseConfigured) {
    return (
      <div className="min-h-screen bg-brand-navy flex items-center justify-center p-8">
        <div className="text-center max-w-md">
          <h1 className="text-white text-xl font-bold mb-2">Configuration error</h1>
          <p className="text-white/60 text-sm">
            This deployment is missing its database configuration. Please contact support
            — the site will be back shortly.
          </p>
        </div>
      </div>
    )
  }
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <AuthProvider>
          <DossierStatusProvider>
            <AppRoutes />
          </DossierStatusProvider>
        </AuthProvider>
      </BrowserRouter>
    </ErrorBoundary>
  )
}
