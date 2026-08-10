// src/pages/profiler/ShareModal.jsx — PDF export + timed share links.
//
// Lifted out of Dossiers.jsx unchanged in behaviour (same endpoints, same
// disclosure copy, same expiry range) so the Profiler rewrite doesn't alter a
// legally reviewed flow. Only the imports moved.

import React, { useEffect, useState } from 'react'
import { RefreshCw, Link2, X, Copy, Check, CheckCircle, Clock, Eye, ExternalLink, Download, ShieldAlert } from 'lucide-react'
import { supabase } from '../../lib/supabase'

const EXPIRY_OPTIONS = [
  { value: 1,   label: '1 Hour'   },
  { value: 3,   label: '3 Hours'  },
  { value: 12,  label: '12 Hours' },
  { value: 24,  label: '24 Hours' },
  { value: 72,  label: '3 Days'   },
  { value: 168, label: '7 Days'   },
]

const APP_URL = 'https://www.badgerboardwi.com'

export default function ShareModal({ dossier, onClose, onExportPdf }) {
  const [step, setStep]             = useState('disclosure') // disclosure | manage
  const [expiresIn, setExpiresIn]   = useState(24)
  const [creating, setCreating]     = useState(false)
  const [newLink, setNewLink]       = useState(null)
  const [copied, setCopied]         = useState(false)
  const [shares, setShares]         = useState([])
  const [loadingShares, setLoading] = useState(false)
  const [deactivating, setDeact]    = useState(null)
  const [error, setError]           = useState('')

  const getToken = async () => {
    const { data: { session } } = await supabase.auth.getSession()
    return session?.access_token || null
  }

  useEffect(() => {
    const load = async () => {
      setLoading(true)
      try {
        const token = await getToken()
        const res = await fetch('/.netlify/functions/get-shared-dossier', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ action: 'list', dossier_id: dossier.id }),
        })
        const data = await res.json()
        if (data.shares) setShares(data.shares)
      } catch { /* offline — the create path reports its own errors */ }
      setLoading(false)
    }
    if (dossier?.id) load()
  }, [dossier?.id])

  const handleCreate = async () => {
    setCreating(true); setError('')
    try {
      const token = await getToken()
      const res = await fetch('/.netlify/functions/create-dossier-share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ dossier_id: dossier.id, expires_hours: expiresIn }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error || 'Failed to create link'); setCreating(false); return }
      setNewLink(data)
      setShares(prev => [{
        id: data.id, token: data.token, expires_at: data.expires_at,
        view_count: 0, is_active: true, created_at: new Date().toISOString(),
      }, ...prev])
      setStep('manage')
    } catch (e) { setError(e.message || 'Network error') }
    setCreating(false)
  }

  const handleCopy = (url) => {
    navigator.clipboard?.writeText(url)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleDeactivate = async (shareId) => {
    setDeact(shareId)
    try {
      const token = await getToken()
      await fetch('/.netlify/functions/get-shared-dossier', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'deactivate', share_id: shareId }),
      })
      setShares(prev => prev.map(s => (s.id === shareId ? { ...s, is_active: false } : s)))
      if (newLink?.id === shareId) setNewLink(null)
    } catch { /* the row stays listed; retry is safe */ }
    setDeact(null)
  }

  const activeShares = shares.filter(s => s.is_active && new Date(s.expires_at) > new Date())

  const ShareRow = ({ share }) => {
    const url = `${APP_URL}/temporary-dossier/${share.token}`
    const expired = new Date(share.expires_at) < new Date()
    const expiresLabel = expired
      ? 'Expired'
      : `Expires ${new Date(share.expires_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
    return (
      <div className="flex items-center gap-3 p-3 bg-gray-50 border border-gray-200 rounded-xl">
        <div className="flex-1 min-w-0">
          <p className="text-xs font-mono text-gray-600 truncate">/temporary-dossier/{share.token.slice(0, 12)}…</p>
          <div className="flex items-center gap-3 mt-1">
            <span className={`text-xs ${expired ? 'text-red-600' : 'text-gray-500'}`}>{expiresLabel}</span>
            <span className="text-xs text-gray-500 flex items-center gap-1">
              <Eye className="w-3 h-3" /> {share.view_count} view{share.view_count !== 1 ? 's' : ''}
            </span>
          </div>
        </div>
        <button onClick={() => handleCopy(url)} className="p-2 rounded-lg hover:bg-gray-100 text-gray-500 hover:text-gray-700" title="Copy link">
          <Copy className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => handleDeactivate(share.id)}
          disabled={deactivating === share.id}
          className="p-2 rounded-lg hover:bg-red-50 text-gray-500 hover:text-red-600 disabled:opacity-40"
          title="Deactivate link"
        >
          {deactivating === share.id ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <X className="w-3.5 h-3.5" />}
        </button>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
      <div className="bg-white rounded-2xl shadow-2xl border border-gray-200 w-full max-w-lg max-h-[90vh] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 flex-shrink-0">
          <div className="flex items-center gap-2">
            <Link2 className="w-4 h-4 text-brand-navy" />
            <span className="text-sm font-bold text-gray-900">Share profile</span>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-gray-100 text-gray-500 hover:text-gray-700" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {step === 'disclosure' && (
            <>
              <button
                onClick={() => { onExportPdf?.(); onClose() }}
                className="w-full flex items-center gap-3 p-4 bg-gray-50 border border-gray-200 rounded-xl hover:border-gray-300 hover:bg-gray-100 transition-all text-left"
              >
                <div className="w-9 h-9 rounded-lg bg-brand-navy/10 flex items-center justify-center flex-shrink-0">
                  <Download className="w-4 h-4 text-brand-navy" />
                </div>
                <div>
                  <p className="text-sm font-bold text-gray-900">Export as PDF</p>
                  <p className="text-xs text-gray-600">Download a printable copy of this profile</p>
                </div>
              </button>

              <div className="flex items-center gap-3">
                <div className="flex-1 h-px bg-gray-200" />
                <span className="text-xs text-gray-600 font-semibold">OR SHARE A TIMED LINK</span>
                <div className="flex-1 h-px bg-gray-200" />
              </div>

              <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 space-y-2">
                <div className="flex items-center gap-2">
                  <ShieldAlert className="w-4 h-4 text-amber-700 flex-shrink-0" />
                  <span className="text-sm font-bold text-amber-800">Responsibility disclosure</span>
                </div>
                <p className="text-xs text-amber-800 leading-relaxed">
                  By generating this link, you acknowledge that <strong>you are solely responsible</strong> for who accesses this profile and how they use the information. This profile is AI-generated from publicly available sources and requires independent verification before use.
                </p>
                <p className="text-xs text-amber-800 leading-relaxed">
                  Do not share with anyone who may use this content for FCRA-regulated purposes (employment screening, credit, housing), formal legal proceedings, or publishing without independent corroboration. <strong>The Bluejack Group assumes no liability for the use of shared profile links.</strong>
                </p>
              </div>

              <div className="space-y-2">
                <span className="text-xs font-semibold text-gray-700">Link active for</span>
                <div className="grid grid-cols-3 gap-2">
                  {EXPIRY_OPTIONS.map(opt => (
                    <button
                      key={opt.value}
                      onClick={() => setExpiresIn(opt.value)}
                      className={`py-2.5 px-3 rounded-xl border text-xs font-semibold transition-all ${
                        expiresIn === opt.value
                          ? 'bg-brand-navy text-white border-brand-navy shadow-sm'
                          : 'bg-gray-50 text-gray-700 border-gray-200 hover:border-gray-300'
                      }`}
                    >{opt.label}</button>
                  ))}
                </div>
                <p className="text-xs text-gray-600">After this time, the link stops working automatically. Minimum 1 hour, maximum 7 days.</p>
              </div>

              {error && <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>}

              <button
                onClick={handleCreate}
                disabled={creating}
                className="w-full bg-brand-navy text-white text-sm font-bold py-3 rounded-xl hover:bg-navy-700 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {creating ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Link2 className="w-4 h-4" />}
                {creating ? 'Generating link…' : 'I understand — generate link'}
              </button>
            </>
          )}

          {step === 'manage' && newLink && (
            <div className="bg-green-50 border border-green-200 rounded-xl p-4 space-y-3">
              <div className="flex items-center gap-2">
                <CheckCircle className="w-4 h-4 text-green-700" />
                <span className="text-sm font-bold text-green-800">Link created</span>
                <span className="text-xs text-green-800 ml-auto flex items-center gap-1">
                  <Clock className="w-3 h-3" />
                  Active for {EXPIRY_OPTIONS.find(o => o.value === expiresIn)?.label}
                </span>
              </div>
              <div className="flex items-center gap-2 bg-white border border-green-200 rounded-lg px-3 py-2">
                <span className="flex-1 text-xs text-gray-700 truncate font-mono">{newLink.share_url}</span>
                <button onClick={() => handleCopy(newLink.share_url)} className="flex-shrink-0 flex items-center gap-1 text-xs font-semibold text-brand-navy hover:text-blue-700">
                  {copied ? <Check className="w-3.5 h-3.5 text-green-700" /> : <Copy className="w-3.5 h-3.5" />}
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
              <a href={newLink.share_url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 text-xs text-brand-navy hover:underline">
                <ExternalLink className="w-3 h-3" /> Preview link
              </a>
            </div>
          )}

          {(step === 'manage' || activeShares.length > 0) && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-gray-700">Active links</span>
                {step === 'manage' && (
                  <button
                    onClick={() => { setStep('disclosure'); setNewLink(null); setError('') }}
                    className="text-xs text-brand-navy hover:underline flex items-center gap-1"
                  >
                    <Link2 className="w-3 h-3" /> New link
                  </button>
                )}
              </div>
              {loadingShares && <p className="text-xs text-gray-600 text-center py-2">Loading…</p>}
              {!loadingShares && activeShares.length === 0 && (
                <p className="text-xs text-gray-600 text-center py-3">No active links for this profile.</p>
              )}
              {activeShares.map(share => <ShareRow key={share.id} share={share} />)}
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-gray-100 bg-gray-50 flex-shrink-0">
          <p className="text-xs text-gray-600 leading-relaxed">
            Links are public and don't require a Badger Board account to view. Deactivating a link immediately stops access for anyone who has it.
          </p>
        </div>
      </div>
    </div>
  )
}
