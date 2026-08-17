// NotFound.jsx — the app's 404.
//
// Unknown routes used to <Navigate to="/" replace />, which silently swallowed
// every typo, dead bookmark and stale link: the user asked for one page, landed
// on the Dashboard, and nothing said why. This renders inside Layout for
// signed-in users (it is a child of the "/" route), so it keeps the sidebar and
// top bar and only replaces the page body.

import React from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { Compass, ArrowLeft } from 'lucide-react'

export default function NotFound() {
  const { pathname } = useLocation()
  const navigate = useNavigate()

  return (
    <div className="card py-16 px-6 text-center">
      <div className="w-16 h-16 rounded-2xl bg-red-50 flex items-center justify-center mx-auto mb-4">
        <Compass className="w-8 h-8 text-brand-red" />
      </div>
      <p className="text-xs font-extrabold uppercase tracking-wider text-gray-400">Error 404</p>
      <h1 className="text-2xl font-black text-gray-900 mt-1">Page not found</h1>
      <p className="text-sm text-gray-500 font-medium mt-2 max-w-md mx-auto leading-relaxed">
        There&rsquo;s nothing at <span className="font-mono text-gray-600 break-all">{pathname}</span>.
        The link may be out of date, or the page may have moved.
      </p>
      <div className="flex flex-wrap items-center justify-center gap-3 mt-6">
        <button onClick={() => navigate(-1)} className="btn-secondary flex items-center gap-2 text-sm">
          <ArrowLeft className="w-4 h-4" /> Go back
        </button>
        <Link to="/" className="btn-primary text-sm">Back to Dashboard</Link>
      </div>
    </div>
  )
}
