import React, { useEffect, useState } from 'react'
import { X, Info, AlertTriangle, CheckCircle, AlertCircle } from 'lucide-react'
import { supabase } from '../lib/supabase'

const TYPE_CONFIG = {
  info:    { bg: 'bg-blue-600',  icon: Info,          text: 'text-white', close: 'hover:bg-blue-700'  },
  warning: { bg: 'bg-amber-500', icon: AlertTriangle,  text: 'text-white', close: 'hover:bg-amber-600' },
  success: { bg: 'bg-green-600', icon: CheckCircle,    text: 'text-white', close: 'hover:bg-green-700' },
  error:   { bg: 'bg-red-600',   icon: AlertCircle,    text: 'text-white', close: 'hover:bg-red-700'   },
}

export default function AnnouncementBanner() {
  const [announcements, setAnnouncements] = useState([])
  const [dismissed, setDismissed]         = useState(() => {
    try { return new Set(JSON.parse(sessionStorage.getItem('bb_dismissed_banners') || '[]')) }
    catch { return new Set() }
  })

  useEffect(() => {
    supabase
      .from('announcements')
      .select('*')
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .then(({ data, error }) => {
        if (error) { console.warn('[AnnouncementBanner] Failed to load:', error.message); return }
        if (data) setAnnouncements(data)
      })
  }, [])

  const dismiss = (id) => {
    setDismissed(prev => {
      const next = new Set(prev)
      next.add(id)
      try { sessionStorage.setItem('bb_dismissed_banners', JSON.stringify([...next])) } catch {}
      return next
    })
  }

  const visible = announcements.filter(a => !dismissed.has(a.id))
  if (visible.length === 0) return null

  return (
    <div className="flex flex-col">
      {visible.map(ann => {
        const cfg  = TYPE_CONFIG[ann.type] || TYPE_CONFIG.info
        const Icon = cfg.icon
        return (
          <div
            key={ann.id}
            className={`${cfg.bg} ${cfg.text} px-4 py-2.5 flex items-center gap-3`}
          >
            <Icon className="w-4 h-4 flex-shrink-0" />
            <p className="flex-1 text-sm font-medium">{ann.message}</p>
            <button
              onClick={() => dismiss(ann.id)}
              className={`p-1 rounded transition-colors ${cfg.close} flex-shrink-0`}
              aria-label="Dismiss"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )
      })}
    </div>
  )
}
