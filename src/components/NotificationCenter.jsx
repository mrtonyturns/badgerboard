// NotificationCenter.jsx — bell inbox + success toast for announcements (v1.19.2)
//
// Product spec:
//   • ALL announcements (info / warning / success / error) land in the bell in
//     the upper-right header with an unread-count badge and a dropdown list.
//   • SUCCESS announcements ADDITIONALLY show a popup for 10 seconds while the
//     user is actively using the app; if they weren't active when it was
//     posted, the popup shows the next time they open the app. Other types
//     (errors, warnings, info) never pop up — bell only.
//
// Pattern follows the common notification-center convention (GitHub/Slack):
// persistent inbox for everything, transient toast only for celebratory news.
// Read + toast-shown state is tracked per device in localStorage.

import React, { useEffect, useState, useRef, useCallback } from 'react'
import { Bell, Info, AlertTriangle, CheckCircle, AlertCircle, X } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { supabase } from '../lib/supabase'
import { sanitizeAnnouncementHtml } from '../lib/sanitize'

const READ_KEY   = 'bb_read_announcements'    // ids the user has seen in the bell
const TOAST_KEY  = 'bb_toasted_announcements' // success ids already popped up
const TOAST_MS   = 10000                      // 10-second popup per spec

const TYPE_CONFIG = {
  info:    { Icon: Info,          color: '#2563eb', bg: 'bg-blue-50',  ring: 'border-blue-200'  },
  warning: { Icon: AlertTriangle, color: '#d97706', bg: 'bg-amber-50', ring: 'border-amber-200' },
  success: { Icon: CheckCircle,   color: '#16a34a', bg: 'bg-green-50', ring: 'border-green-200' },
  error:   { Icon: AlertCircle,   color: '#dc2626', bg: 'bg-red-50',   ring: 'border-red-200'   },
}

const loadSet = (key) => {
  try { return new Set(JSON.parse(localStorage.getItem(key) || '[]')) } catch { return new Set() }
}
const saveSet = (key, set) => {
  try { localStorage.setItem(key, JSON.stringify([...set].slice(-100))) } catch {}
}

// ── shared announcement feed (poll + focus refetch) ──────────────────────────
function useAnnouncements() {
  const [announcements, setAnnouncements] = useState([])

  useEffect(() => {
    const load = () => {
      supabase
        .from('announcements')
        .select('*')
        .eq('is_active', true)
        .order('created_at', { ascending: false })
        .limit(30)
        .then(({ data, error }) => {
          if (error) { console.warn('[notifications] load failed:', error.message); return }
          if (data) setAnnouncements(data)
        })
    }
    load()
    const interval = setInterval(load, 5 * 60 * 1000)
    const onFocus = () => { if (document.visibilityState === 'visible') load() }
    document.addEventListener('visibilitychange', onFocus)
    window.addEventListener('focus', onFocus)
    return () => {
      clearInterval(interval)
      document.removeEventListener('visibilitychange', onFocus)
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  return announcements
}

// ── main component: render inside the header where the bell lives ────────────
export default function NotificationCenter() {
  const announcements = useAnnouncements()
  const [open, setOpen] = useState(false)
  const [readIds, setReadIds] = useState(() => loadSet(READ_KEY))
  const [toast, setToast] = useState(null)          // announcement currently popped up
  const toastTimerRef = useRef(null)
  const panelRef = useRef(null)

  const unread = announcements.filter(a => !readIds.has(a.id))

  // Opening the panel marks everything as read (and clears any active popup —
  // the inbox and the toast occupy the same corner)
  const openPanel = () => {
    setOpen(o => {
      if (!o) {
        const next = new Set(readIds)
        announcements.forEach(a => next.add(a.id))
        setReadIds(next)
        saveSet(READ_KEY, next)
        clearTimeout(toastTimerRef.current)
        setToast(null)
      }
      return !o
    })
  }

  // Close on outside click
  useEffect(() => {
    if (!open) return
    const onDown = (e) => { if (panelRef.current && !panelRef.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  // ── success popup: 10s, once per announcement per device ──────────────────
  // Fires whether the announcement arrived live (poll) or was waiting when the
  // user opened the app — the toasted-set check makes both paths one-shot.
  useEffect(() => {
    if (toast || open) return  // one at a time; never pop while the inbox is open
    const toasted = loadSet(TOAST_KEY)
    const candidate = announcements.find(a => a.type === 'success' && !toasted.has(a.id))
    if (!candidate) return
    toasted.add(candidate.id)
    saveSet(TOAST_KEY, toasted)
    setToast(candidate)
    toastTimerRef.current = setTimeout(() => setToast(null), TOAST_MS)
    return () => clearTimeout(toastTimerRef.current)
  }, [announcements, toast, open])

  const dismissToast = useCallback(() => {
    clearTimeout(toastTimerRef.current)
    setToast(null)
  }, [])

  return (
    <>
      {/* ── Bell + dropdown ── */}
      <div className="relative" ref={panelRef}>
        <button
          type="button"
          onClick={openPanel}
          aria-label={`Notifications${unread.length ? ` (${unread.length} unread)` : ''}`}
          className="relative p-2 rounded-lg hover:bg-gray-100 transition-colors"
        >
          <Bell className="w-4 h-4 text-gray-600" />
          {unread.length > 0 && (
            <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 bg-brand-red text-white text-[10px] font-bold rounded-full flex items-center justify-center leading-none">
              {unread.length > 9 ? '9+' : unread.length}
            </span>
          )}
        </button>

        {open && (
          <div className="absolute right-0 top-full mt-2 w-80 bg-white rounded-xl shadow-xl border border-gray-200 z-50 overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
              <span className="text-sm font-bold text-gray-900">Notifications</span>
              <button onClick={() => setOpen(false)} className="p-1 rounded hover:bg-gray-100 text-gray-400">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="max-h-96 overflow-y-auto">
              {announcements.length === 0 && (
                <div className="py-10 text-center">
                  <Bell className="w-8 h-8 text-gray-200 mx-auto mb-2" />
                  <p className="text-sm text-gray-400">No notifications yet</p>
                </div>
              )}
              {announcements.map(a => {
                const cfg = TYPE_CONFIG[a.type] || TYPE_CONFIG.info
                return (
                  <div key={a.id} className="px-4 py-3 border-b border-gray-50 last:border-b-0 flex items-start gap-3 hover:bg-gray-50">
                    <div className={`w-7 h-7 rounded-lg ${cfg.bg} flex items-center justify-center flex-shrink-0 mt-0.5`}>
                      <cfg.Icon className="w-4 h-4" style={{ color: cfg.color }} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm text-gray-800 leading-snug"
                        dangerouslySetInnerHTML={{ __html: sanitizeAnnouncementHtml(a.message) }} />
                      <p className="text-xs text-gray-400 mt-1">
                        {a.created_at ? formatDistanceToNow(new Date(a.created_at), { addSuffix: true }) : ''}
                      </p>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>

      {/* ── 10-second success popup ── */}
      {toast && (
        <div
          className="fixed top-16 right-4 z-[300] w-[360px] max-w-[calc(100vw-2rem)] bg-white rounded-2xl shadow-2xl border border-green-200 overflow-hidden"
          role="status"
          aria-live="polite"
        >
          <div className="p-4 flex items-start gap-3">
            <div className="w-9 h-9 rounded-xl bg-green-50 flex items-center justify-center flex-shrink-0">
              <CheckCircle className="w-5 h-5 text-green-600" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-bold text-green-700 uppercase tracking-wide mb-0.5">Announcement</p>
              <div className="text-sm text-gray-800 leading-snug"
                dangerouslySetInnerHTML={{ __html: sanitizeAnnouncementHtml(toast.message) }} />
            </div>
            <button onClick={dismissToast} className="p-1 rounded-lg hover:bg-gray-100 text-gray-400 flex-shrink-0" aria-label="Dismiss">
              <X className="w-4 h-4" />
            </button>
          </div>
          {/* 10-second progress bar */}
          <div className="h-1 bg-green-100">
            <div className="h-full bg-green-500" style={{ animation: `bbToastDrain ${TOAST_MS}ms linear forwards` }} />
          </div>
          <style>{`@keyframes bbToastDrain { from { width: 100% } to { width: 0% } }`}</style>
        </div>
      )}
    </>
  )
}
