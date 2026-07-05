import React, { Suspense, lazy } from 'react'
import { BrowserRouter, Routes, Route, Navigate, useParams } from 'react-router-dom'

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
import { supabaseConfigured } from './lib/supabase'
import { DossierStatusProvider } from './contexts/DossierStatusContext'
import Layout from './components/Layout'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import Offices from './pages/Offices'
const Elections = lazy(() => import('./pages/Elections'))  // code-split: trims the initial bundle (M1)
const GamePlan = lazy(() => import('./pages/GamePlan'))  // code-split: trims the initial bundle (M1)
// ElectionResults (legacy standalone page) replaced by Elections.jsx two-tab UI.
// Redirect helper preserves bookmarked /elections/results/:id URLs.
function ElectionResultsRedirect() {
  const { id } = useParams()
  return <Navigate to={`/elections?tab=results${id ? `&election=${id}` : ''}`} replace />
}
const Candidates = lazy(() => import('./pages/Candidates'))  // code-split: trims the initial bundle (M1)
const CandidateDetail = lazy(() => import('./pages/CandidateDetail'))  // code-split: trims the initial bundle (M1)
const Prospecting = lazy(() => import('./pages/Prospecting'))  // code-split: trims the initial bundle (M1)
const VoterLists = lazy(() => import('./pages/VoterLists'))  // code-split: trims the initial bundle (M1)
// Door Knocking parked — restore import + route to re-enable
// import DoorKnocking from './pages/DoorKnocking'
const CampaignConnect = lazy(() => import('./pages/CampaignConnect'))  // code-split: trims the initial bundle (M1)
const Dossiers = lazy(() => import('./pages/Dossiers'))  // code-split: trims the initial bundle (M1)
import Settings from './pages/Settings'
import Terms from './pages/Terms'
const Pricing = lazy(() => import('./pages/Pricing'))  // code-split: trims the initial bundle (M1)
const AdminDashboard = lazy(() => import('./pages/AdminDashboard'))  // code-split: trims the initial bundle (M1)
import DossierDisclaimer from './pages/DossierDisclaimer'
const Compare = lazy(() => import('./pages/Compare'))  // code-split: trims the initial bundle (M1)
import VolunteerPortal from './pages/VolunteerPortal'
import SharedDossier from './pages/SharedDossier'
const Events = lazy(() => import('./pages/Events'))  // code-split: trims the initial bundle (M1)
import ResetPassword from './pages/ResetPassword'

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

const AppRoutes = () => {
  const { user, loading } = useAuth()

  if (loading) {
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
        <Route path="elections" element={<Elections />} />
        <Route path="elections/results/:id" element={<ElectionResultsRedirect />} />
        <Route path="elections/results" element={<Navigate to="/elections?tab=results" replace />} />
        <Route path="game-plan" element={<GamePlan />} />
        <Route path="candidates" element={<Candidates />} />
        <Route path="candidates/:id" element={<CandidateDetail />} />
        <Route path="prospecting" element={<Prospecting />} />
        <Route path="voter-lists" element={<VoterLists />} />
        {/* <Route path="door-knocking" element={<AdminRoute><DoorKnocking /></AdminRoute>} /> */}
        <Route path="dossiers" element={<Dossiers />} />
        <Route path="profiler" element={<Dossiers />} />
        <Route path="compare" element={<Compare />} />
        <Route path="events" element={<Events />} />
        <Route path="campaign-connect" element={<CampaignConnect />} />
        <Route path="settings" element={<Settings />} />
        <Route path="plans" element={<Pricing />} />
        <Route path="admin" element={<AdminRoute><AdminDashboard /></AdminRoute>} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
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
