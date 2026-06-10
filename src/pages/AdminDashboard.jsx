import React, { useState, useEffect, useCallback, useRef } from 'react'
import { Link } from 'react-router-dom'
import {
  Shield,
  Search,
  Edit2,
  Key,
  Mail,
  Lock,
  Unlock,
  Activity,
  StickyNote,
  ChevronDown,
  ChevronUp,
  Trash2,
  Check,
  Wand2,
  Plus,
  X,
  Copy,
  Eye,
  EyeOff,
  ShieldCheck,
  RefreshCw,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  ChevronRight,
  BarChart2,
  Radio,
  CalendarDays,
  Clock,
  Gift,
  Tag,
  Percent,
  DollarSign,
  ExternalLink,
} from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { ADMIN_EMAILS } from '../lib/tiers'
import ElectionResultsAdmin from './ElectionResultsAdmin'

const AdminDashboard = () => {
  const { user, session } = useAuth()
  const navigate = useNavigate()

  // Auth check
  useEffect(() => {
    if (!user?.email || !ADMIN_EMAILS.includes(user.email.toLowerCase())) {
      navigate('/')
    }
  }, [user, navigate])

  const [activeTab, setActiveTab] = useState('health')
  const [toast, setToast] = useState(null)

  const showToast = useCallback((message, type = 'success') => {
    setToast({ message, type })
    setTimeout(() => setToast(null), 3000)
  }, [])

  const apiCall = useCallback(
    async (action, params = {}) => {
      const res = await fetch('/.netlify/functions/admin-dashboard', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session?.access_token}`,
        },
        body: JSON.stringify({ action, ...params }),
      })
      if (!res.ok) throw new Error(await res.text())
      return res.json()
    },
    [session?.access_token]
  )

  const billingCall = useCallback(
    async (action, params = {}) => {
      const res = await fetch('/.netlify/functions/admin-billing', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session?.access_token}`,
        },
        body: JSON.stringify({ action, ...params }),
      })
      if (!res.ok) throw new Error(await res.text())
      return res.json()
    },
    [session?.access_token]
  )

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="border-b border-gray-200 bg-white">
        <div className="max-w-7xl mx-auto px-6 py-6">
          <div className="flex items-center gap-3">
            <Shield className="w-8 h-8 text-red-700" />
            <h1 className="text-3xl font-bold text-gray-900">Admin Panel</h1>
          </div>
        </div>
      </div>

      {/* Tab Navigation */}
      <div className="border-b border-gray-200 bg-white sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-6">
          <div className="flex gap-2 py-4 overflow-x-auto">
            {[
              { id: 'health', label: 'Platform Health' },
              { id: 'accounts', label: 'Account Management' },
              { id: 'billing', label: 'Billing & Plans' },
              { id: 'ai-costs', label: 'AI Costs' },
              { id: 'errors', label: 'Error Logs' },
              { id: 'elections', label: 'Elections' },
              { id: 'announcements', label: 'Announcements' },
              { id: 'security', label: '🔒 Security Audit' },
              { id: 'coupons', label: '🎟️ Coupons' },
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`px-4 py-2 rounded-full font-medium text-sm transition-colors whitespace-nowrap ${
                  activeTab === tab.id
                    ? 'bg-gray-900 text-white'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-7xl mx-auto px-6 py-8">
        {activeTab === 'health' && <PlatformHealthTab apiCall={apiCall} showToast={showToast} onNavigate={setActiveTab} />}
        {activeTab === 'accounts' && <AccountManagementTab apiCall={apiCall} showToast={showToast} user={user} />}
        {activeTab === 'billing' && <BillingPlansTab billingCall={billingCall} apiCall={apiCall} showToast={showToast} />}
        {activeTab === 'ai-costs' && <AICostsTab apiCall={apiCall} showToast={showToast} />}
        {activeTab === 'errors' && <ErrorLogsTab apiCall={apiCall} showToast={showToast} />}
        {activeTab === 'elections' && <ElectionResultsAdmin showToast={showToast} />}
        {activeTab === 'announcements' && <AnnouncementsTab apiCall={apiCall} showToast={showToast} />}
        {activeTab === 'security' && <SecurityAuditTab session={session} showToast={showToast} />}
        {activeTab === 'coupons' && <CouponsTab session={session} showToast={showToast} />}
      </div>

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 right-6 p-4 rounded-lg shadow-lg text-white text-sm font-medium z-50" style={{
          backgroundColor: toast.type === 'success' ? '#10b981' : '#ef4444'
        }}>
          {toast.message}
        </div>
      )}

      {/* Version */}
      <div className="text-center py-6 text-xs text-gray-500">
        v1.10.28
      </div>
    </div>
  )
}

// TAB 1: Platform Health
const PlatformHealthTab = ({ apiCall, showToast, onNavigate }) => {
  const [stats, setStats] = useState(null)
  const [trends, setTrends] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const fetch = async () => {
      try {
        setLoading(true)
        const [usersRaw, trendsRaw, errorsRaw] = await Promise.all([
          apiCall('users'),
          apiCall('signup_trends'),
          apiCall('error_logs'),
        ])

        // Defensive: API may return an error object instead of an array when env vars are missing
        const usersRes  = Array.isArray(usersRaw)  ? usersRaw  : (usersRaw?.users  || [])
        const trendsRes = Array.isArray(trendsRaw)  ? trendsRaw  : (trendsRaw?.trends || [])
        const errorsRes = Array.isArray(errorsRaw)  ? errorsRaw  : (errorsRaw?.logs   || [])

        const pastDue = usersRes.filter((u) => u.payment_status === 'past_due').length
        const unresolved = errorsRes.filter((e) => !e.resolved).length

        setStats({
          totalUsers: usersRes.length,
          activeThisWeek: usersRes.filter((u) => {
            const lastLogin = new Date(u.last_sign_in_at)
            const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
            return lastLogin > weekAgo
          }).length,
          pastDueAccounts: pastDue,
          totalErrors: unresolved,
        })

        setTrends(Array.isArray(trendsRes) ? trendsRes : [])
      } catch (err) {
        console.error(err)
        showToast('Failed to load health data', 'error')
      } finally {
        setLoading(false)
      }
    }

    fetch()
  }, [apiCall, showToast])

  if (loading) {
    return <Spinner />
  }

  return (
    <div className="space-y-8">
      {/* Stat Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        {[
          { label: 'Total Users', value: stats?.totalUsers || 0, color: 'blue' },
          { label: 'Active This Week', value: stats?.activeThisWeek || 0, color: 'green' },
          { label: 'Past Due Accounts', value: stats?.pastDueAccounts || 0, color: 'amber' },
          { label: 'Total Errors (Unresolved)', value: stats?.totalErrors || 0, color: 'red', link: 'errors' },
        ].map((stat, idx) => (
          <div
            key={idx}
            className={`bg-white rounded-lg shadow p-6 border-l-4${stat.link ? ' cursor-pointer hover:shadow-md hover:bg-gray-50 transition-all' : ''}`}
            style={{ borderColor: stat.color === 'blue' ? '#3b82f6' : stat.color === 'green' ? '#10b981' : stat.color === 'amber' ? '#f59e0b' : '#ef4444' }}
            onClick={stat.link ? () => onNavigate(stat.link) : undefined}
            title={stat.link ? `View ${stat.label}` : undefined}
          >
            <p className="text-gray-500 text-sm font-medium">{stat.label}</p>
            <div className="flex items-center justify-between mt-2">
              <p className="text-3xl font-bold text-gray-900">{stat.value}</p>
              {stat.link && <span className="text-xs text-red-500 font-medium">View logs →</span>}
            </div>
          </div>
        ))}
      </div>

      {/* Signup Trends Chart */}
      <div className="bg-white rounded-lg shadow p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">Signup Trends (Last 30 Days)</h3>
        {trends && trends.length > 0 ? (
          <SignupChart data={trends} />
        ) : (
          <p className="text-gray-500 text-sm">No signup data available</p>
        )}
      </div>

      {/* Feature Usage Note */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <p className="text-blue-900 text-sm">
          <span className="font-medium">Feature usage analytics coming soon</span> — requires activity log data to accumulate.
        </p>
      </div>
    </div>
  )
}

// Signup Chart Component (SVG-based)
const SignupChart = ({ data }) => {
  const validData = data.filter(d => d.count !== null && d.count !== undefined)
  if (!validData.length) {
    return <p className="text-gray-500 text-sm">No data</p>
  }

  const maxCount = Math.max(...validData.map(d => d.count), 1)
  const barWidth = Math.max(15, 600 / validData.length)
  const barSpacing = Math.max(2, (600 - barWidth * validData.length) / (validData.length + 1))
  const chartHeight = 300

  return (
    <div className="overflow-x-auto">
      <svg width={Math.max(600, barWidth * validData.length + barSpacing * (validData.length + 1))} height={chartHeight} className="mx-auto">
        {/* Y-axis labels */}
        {[0, 0.25, 0.5, 0.75, 1].map((ratio, i) => {
          const y = chartHeight - 40 - ratio * (chartHeight - 80)
          const label = Math.round(maxCount * ratio)
          return (
            <g key={`y-${i}`}>
              <text x={30} y={y + 4} className="text-xs fill-gray-600" textAnchor="end">
                {label}
              </text>
              <line x1={35} y1={y} x2={barSpacing + barWidth * validData.length + barSpacing} y2={y} stroke="#e5e7eb" strokeWidth={1} />
            </g>
          )
        })}

        {/* Bars */}
        {validData.map((d, i) => {
          const barHeight = ((d.count || 0) / maxCount) * (chartHeight - 80)
          const x = barSpacing + i * (barWidth + barSpacing)
          const y = chartHeight - 40 - barHeight

          return (
            <g key={i}>
              <rect x={x} y={y} width={barWidth} height={barHeight} fill="#1a2744" rx={2} />
              {i % 7 === 0 && (
                <text
                  x={x + barWidth / 2}
                  y={chartHeight - 10}
                  className="text-xs fill-gray-600"
                  textAnchor="middle"
                >
                  {d.date ? new Date(d.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : ''}
                </text>
              )}
            </g>
          )
        })}

        {/* Axes */}
        <line x1={35} y1={40} x2={35} y2={chartHeight - 40} stroke="#d1d5db" strokeWidth={2} />
        <line x1={35} y1={chartHeight - 40} x2={barSpacing + barWidth * validData.length + barSpacing} y2={chartHeight - 40} stroke="#d1d5db" strokeWidth={2} />
      </svg>
    </div>
  )
}

// TAB 2: Account Management
const AccountManagementTab = ({ apiCall, showToast, user }) => {
  const [users, setUsers] = useState([])
  const [searchQuery, setSearchQuery] = useState('')
  const [selected, setSelected] = useState(new Set())
  const [loading, setLoading] = useState(true)
  const [expandedActivity, setExpandedActivity] = useState(null)
  const [activityData, setActivityData] = useState({})

  const [modals, setModals] = useState({
    editEmail: null,
    changePassword: null,
    notes: null,
  })

  useEffect(() => {
    const fetch = async () => {
      try {
        setLoading(true)
        const data = await apiCall('users')
        setUsers(Array.isArray(data) ? data : (data?.users || []))
      } catch (err) {
        console.error(err)
        showToast('Failed to load users', 'error')
      } finally {
        setLoading(false)
      }
    }

    fetch()
  }, [apiCall, showToast])

  const filteredUsers = users.filter((u) =>
    (u.email || '').toLowerCase().includes(searchQuery.toLowerCase())
  )

  const handleSelectAll = () => {
    if (selected.size === filteredUsers.length) {
      setSelected(new Set())
    } else {
      setSelected(new Set(filteredUsers.map((u) => u.id)))
    }
  }

  const toggleSelect = (id) => {
    const newSelected = new Set(selected)
    if (newSelected.has(id)) {
      newSelected.delete(id)
    } else {
      newSelected.add(id)
    }
    setSelected(newSelected)
  }

  const handleBulkAction = async (action) => {
    if (!window.confirm(`Are you sure you want to ${action} for ${selected.size} user(s)?`)) return

    try {
      await apiCall(`bulk_${action}`, { user_ids: Array.from(selected) })
      setSelected(new Set())
      const data = await apiCall('users')
      setUsers(Array.isArray(data) ? data : (data?.users || []))
      showToast(`Bulk action completed`)
    } catch (err) {
      console.error(err)
      showToast('Action failed', 'error')
    }
  }

  const handleEditEmail = async (userId, newEmail) => {
    try {
      await apiCall('update_user_email', { user_id: userId, new_email: newEmail })
      const data = await apiCall('users')
      setUsers(Array.isArray(data) ? data : (data?.users || []))
      setModals({ ...modals, editEmail: null })
      showToast('Email updated')
    } catch (err) {
      console.error(err)
      showToast('Failed to update email', 'error')
    }
  }

  const handleChangePassword = async (userId, newPassword) => {
    try {
      await apiCall('change_user_password', { user_id: userId, new_password: newPassword })
      setModals({ ...modals, changePassword: null })
      showToast('Password changed')
    } catch (err) {
      console.error(err)
      showToast('Failed to change password', 'error')
    }
  }

  const handleSendReset = async (userId) => {
    if (!window.confirm('Send password reset email?')) return
    try {
      await apiCall('send_reset', { user_id: userId })
      showToast('Reset email sent')
    } catch (err) {
      console.error(err)
      showToast('Failed to send reset email', 'error')
    }
  }

  const handleTogglePaymentLock = async (userId, isLocked) => {
    if (!window.confirm(`${isLocked ? 'Unlock' : 'Lock'} payment for this user?`)) return
    try {
      await apiCall(isLocked ? 'unlock_payment' : 'lock_payment', { user_id: userId })
      const data = await apiCall('users')
      setUsers(Array.isArray(data) ? data : (data?.users || []))
      showToast(`Payment ${isLocked ? 'unlocked' : 'locked'}`)
    } catch (err) {
      console.error(err)
      showToast('Failed to update payment status', 'error')
    }
  }

  const toggleActivity = async (userId) => {
    if (expandedActivity === userId) {
      setExpandedActivity(null)
    } else {
      try {
        if (!activityData[userId]) {
          const data = await apiCall('get_user_activity', { user_id: userId })
          setActivityData({ ...activityData, [userId]: (Array.isArray(data) ? data : []).slice(0, 20) })
        }
        setExpandedActivity(userId)
      } catch (err) {
        console.error(err)
        showToast('Failed to load activity', 'error')
      }
    }
  }

  const handleAddNote = async (userId, noteText) => {
    try {
      await apiCall('add_user_note', { user_id: userId, note: noteText })
      setModals({ ...modals, notes: null })
      showToast('Note added')
    } catch (err) {
      console.error(err)
      showToast('Failed to add note', 'error')
    }
  }

  if (loading) {
    return <Spinner />
  }

  return (
    <div className="space-y-4">
      {/* Action Glossary */}
      <div className="bg-white rounded-lg shadow p-4 mb-4">
        <h3 className="text-sm font-bold text-gray-700 mb-3">Action Icons Reference</h3>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
          {[
            { icon: Edit2, label: 'Edit Email', desc: 'Change the user\'s login email address' },
            { icon: Key, label: 'Change Password', desc: 'Set a new password for the account' },
            { icon: Mail, label: 'Send Reset', desc: 'Email a password reset link to the user' },
            { icon: Lock, label: 'Lock Payment', desc: 'Mark account as past due — restricts access' },
            { icon: Unlock, label: 'Unlock Payment', desc: 'Clear past due status — restore access' },
            { icon: Activity, label: 'View Activity', desc: 'Show recent actions taken by this user' },
            { icon: StickyNote, label: 'Notes', desc: 'View or add internal admin notes for this user' },
          ].map(({ icon: Icon, label, desc }) => (
            <div key={label} className="flex items-start gap-2 p-2 bg-gray-50 rounded-lg">
              <Icon className="w-4 h-4 text-blue-600 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-xs font-semibold text-gray-800">{label}</p>
                <p className="text-xs text-gray-500">{desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-3 w-4 h-4 text-gray-400" />
        <input
          type="text"
          placeholder="Search by email..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-red-700"
        />
      </div>

      {/* Bulk Actions */}
      {selected.size > 0 && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 flex items-center gap-4">
          <span className="text-sm font-medium text-blue-900">{selected.size} selected</span>
          <button
            onClick={() => handleBulkAction('lock_payment')}
            className="px-3 py-1 bg-red-700 text-white text-sm rounded hover:bg-red-800 transition"
          >
            Bulk Lock Payment
          </button>
          <button
            onClick={() => handleBulkAction('unlock_payment')}
            className="px-3 py-1 bg-green-600 text-white text-sm rounded hover:bg-green-700 transition"
          >
            Bulk Unlock Payment
          </button>
          <button
            onClick={() => handleBulkAction('send_reset')}
            className="px-3 py-1 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 transition"
          >
            Bulk Send Reset
          </button>
        </div>
      )}

      {/* Users Table */}
      <div className="bg-white rounded-lg shadow overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="px-4 py-3 text-left w-8">
                <input
                  type="checkbox"
                  checked={selected.size === filteredUsers.length && filteredUsers.length > 0}
                  onChange={handleSelectAll}
                  className="w-4 h-4"
                />
              </th>
              <th className="px-4 py-3 text-left font-semibold text-gray-700">Email</th>
              <th className="px-4 py-3 text-left font-semibold text-gray-700">Plan</th>
              <th className="px-4 py-3 text-left font-semibold text-gray-700">Status</th>
              <th className="px-4 py-3 text-left font-semibold text-gray-700">Joined</th>
              <th className="px-4 py-3 text-left font-semibold text-gray-700">Last Login</th>
              <th className="px-4 py-3 text-left font-semibold text-gray-700">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredUsers.map((u) => (
              <React.Fragment key={u.id}>
                <tr className="border-b border-gray-200 hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <input
                      type="checkbox"
                      checked={selected.has(u.id)}
                      onChange={() => toggleSelect(u.id)}
                      className="w-4 h-4"
                    />
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span>{u.email}</span>
                      {ADMIN_EMAILS.includes((u.email || '').toLowerCase()) && (
                        <span className="px-2 py-0.5 bg-red-100 text-red-800 text-xs rounded-full font-medium">Admin</span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-gray-600">{u.plan || 'Free'}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`px-2 py-1 text-xs rounded-full font-medium ${
                        u.status === 'active'
                          ? 'bg-green-100 text-green-800'
                          : 'bg-amber-100 text-amber-800'
                      }`}
                    >
                      {u.status === 'active' ? 'Active' : 'Past Due'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-600">{new Date(u.created_at).toLocaleDateString()}</td>
                  <td className="px-4 py-3 text-gray-600">
                    {u.last_login ? new Date(u.last_login).toLocaleDateString() : 'Never'}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex gap-2">
                      <button
                        onClick={() => setModals({ ...modals, editEmail: u })}
                        className="p-1 text-blue-600 hover:bg-blue-50 rounded transition"
                        title="Edit email"
                      >
                        <Edit2 className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => setModals({ ...modals, changePassword: u })}
                        className="p-1 text-blue-600 hover:bg-blue-50 rounded transition"
                        title="Change password"
                      >
                        <Key className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => handleSendReset(u.id)}
                        className="p-1 text-blue-600 hover:bg-blue-50 rounded transition"
                        title="Send reset email"
                      >
                        <Mail className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => handleTogglePaymentLock(u.id, u.status !== 'active')}
                        className="p-1 text-blue-600 hover:bg-blue-50 rounded transition"
                        title={u.status !== 'active' ? 'Unlock payment' : 'Lock payment'}
                      >
                        {u.status !== 'active' ? <Unlock className="w-4 h-4" /> : <Lock className="w-4 h-4" />}
                      </button>
                      <button
                        onClick={() => toggleActivity(u.id)}
                        className="p-1 text-blue-600 hover:bg-blue-50 rounded transition"
                        title="View activity"
                      >
                        <Activity className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => setModals({ ...modals, notes: u })}
                        className="p-1 text-blue-600 hover:bg-blue-50 rounded transition"
                        title="View/add notes"
                      >
                        <StickyNote className="w-4 h-4" />
                      </button>
                    </div>
                  </td>
                </tr>

                {/* Activity Panel */}
                {expandedActivity === u.id && (
                  <tr className="bg-gray-50 border-b border-gray-200">
                    <td colSpan="7" className="px-4 py-4">
                      <div>
                        <h4 className="font-semibold text-gray-900 mb-3">Recent Activity</h4>
                        {activityData[u.id] && activityData[u.id].length > 0 ? (
                          <div className="space-y-2 max-h-64 overflow-y-auto">
                            {activityData[u.id].map((activity, i) => (
                              <div key={i} className="text-sm text-gray-700 bg-white p-3 rounded border border-gray-200">
                                <div className="font-medium">{activity.action || 'Unknown'}</div>
                                <div className="text-xs text-gray-500">{activity.page || 'Unknown page'}</div>
                                <div className="text-xs text-gray-500">
                                  {activity.created_at ? new Date(activity.created_at).toLocaleString() : 'Unknown time'}
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <p className="text-gray-500 text-sm">No activity recorded yet</p>
                        )}
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>

      {/* Edit Email Modal */}
      {modals.editEmail && (
        <EditEmailModal
          user={modals.editEmail}
          onSave={(newEmail) => handleEditEmail(modals.editEmail.id, newEmail)}
          onClose={() => setModals({ ...modals, editEmail: null })}
        />
      )}

      {/* Change Password Modal */}
      {modals.changePassword && (
        <ChangePasswordModal
          user={modals.changePassword}
          onSave={(newPassword) => handleChangePassword(modals.changePassword.id, newPassword)}
          onClose={() => setModals({ ...modals, changePassword: null })}
        />
      )}

      {/* Notes Modal */}
      {modals.notes && (
        <NotesModal
          user={modals.notes}
          onAddNote={(noteText) => handleAddNote(modals.notes.id, noteText)}
          onClose={() => setModals({ ...modals, notes: null })}
        />
      )}
    </div>
  )
}

const EditEmailModal = ({ user, onSave, onClose }) => {
  const [email, setEmail] = useState(user.email)

  const handleSave = () => {
    if (!email.trim()) {
      alert('Email is required')
      return
    }
    onSave(email)
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-40">
      <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4 shadow-lg">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">Edit Email</h3>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-red-700 mb-4"
        />
        <div className="flex gap-3 justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="px-4 py-2 text-white rounded-lg transition"
            style={{ backgroundColor: '#1a2744' }}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

const ChangePasswordModal = ({ user, onSave, onClose }) => {
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)

  const handleSave = () => {
    if (password.length < 8) {
      alert('Password must be at least 8 characters')
      return
    }
    onSave(password)
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-40">
      <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4 shadow-lg">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">Change Password for {user.email}</h3>
        <div className="relative mb-4">
          <input
            type={showPassword ? 'text' : 'password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="New password (min 8 chars)"
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-red-700 pr-10"
          />
          <button
            onClick={() => setShowPassword(!showPassword)}
            className="absolute right-3 top-2.5 text-gray-500 hover:text-gray-700"
          >
            {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          </button>
        </div>
        <div className="flex gap-3 justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="px-4 py-2 text-white rounded-lg transition"
            style={{ backgroundColor: '#1a2744' }}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

const NotesModal = ({ user, onAddNote, onClose }) => {
  const [noteText, setNoteText] = useState('')
  const [notes, setNotes] = useState([])

  const handleAddNote = () => {
    if (!noteText.trim()) return
    onAddNote(noteText)
    setNoteText('')
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-40">
      <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4 shadow-lg max-h-96 overflow-y-auto">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">Notes for {user.email}</h3>

        {/* Existing Notes */}
        <div className="mb-4 max-h-48 overflow-y-auto">
          {notes.length > 0 ? (
            <div className="space-y-2">
              {notes.map((note, i) => (
                <div key={i} className="bg-yellow-50 border border-yellow-200 rounded p-3 text-sm">
                  <p className="text-gray-700">{note.text}</p>
                  <p className="text-xs text-gray-500 mt-1">{new Date(note.created_at).toLocaleString()}</p>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-gray-500 text-sm">No notes yet</p>
          )}
        </div>

        {/* Add Note */}
        <textarea
          value={noteText}
          onChange={(e) => setNoteText(e.target.value)}
          placeholder="Add a note..."
          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-red-700 mb-4"
          rows={3}
        />

        <div className="flex gap-3 justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition"
          >
            Close
          </button>
          <button
            onClick={handleAddNote}
            disabled={!noteText.trim()}
            className="px-4 py-2 text-white rounded-lg transition disabled:opacity-50"
            style={{ backgroundColor: '#1a2744' }}
          >
            Add Note
          </button>
        </div>
      </div>
    </div>
  )
}

// TAB 3: Billing & Plans
const BillingPlansTab = ({ billingCall, apiCall, showToast }) => {
  const [users, setUsers] = useState([])
  const [selectedUser, setSelectedUser] = useState(null)
  const [loading, setLoading] = useState(true)
  const [subscriptionData, setSubscriptionData] = useState(null)
  const [paymentHistory, setPaymentHistory] = useState([])

  const [modals, setModals] = useState({
    applyCredit: false,
    changePlan: false,
  })

  useEffect(() => {
    const fetch = async () => {
      try {
        setLoading(true)
        const data = await apiCall('users')
        setUsers(Array.isArray(data) ? data : (data?.users || []))
      } catch (err) {
        console.error(err)
        showToast('Failed to load users', 'error')
      } finally {
        setLoading(false)
      }
    }

    fetch()
  }, [apiCall, showToast])

  const handleSelectUser = async (u) => {
    try {
      const data = await billingCall('get_subscription', { user_id: u.id })
      setSelectedUser(u)
      setSubscriptionData(data)
      const history = await billingCall('payment_history', { user_id: u.id })
      setPaymentHistory(history?.invoices || [])
    } catch (err) {
      console.error(err)
      showToast('Failed to load billing data', 'error')
    }
  }

  const handleCancelSubscription = async () => {
    if (!window.confirm('Cancel this subscription?')) return
    try {
      await billingCall('cancel_subscription', { user_id: selectedUser.id })
      const data = await billingCall('get_subscription', { user_id: selectedUser.id })
      setSubscriptionData(data)
      showToast('Subscription cancelled')
    } catch (err) {
      console.error(err)
      showToast('Failed to cancel subscription', 'error')
    }
  }

  const handleRetryPayment = async () => {
    if (!window.confirm('Retry failed payment?')) return
    try {
      await billingCall('retry_invoice', { user_id: selectedUser.id })
      const data = await billingCall('get_subscription', { user_id: selectedUser.id })
      setSubscriptionData(data)
      showToast('Payment retry initiated')
    } catch (err) {
      console.error(err)
      showToast('Failed to retry payment', 'error')
    }
  }

  const handleOpenStripePortal = async () => {
    try {
      const data = await billingCall('portal_link', { user_id: selectedUser.id })
      window.open(data.url, '_blank')
    } catch (err) {
      console.error(err)
      showToast('Failed to open Stripe portal', 'error')
    }
  }

  const handleApplyCredit = async (amount, description) => {
    try {
      await billingCall('apply_credit', { user_id: selectedUser.id, amount, description })
      const data = await billingCall('get_subscription', { user_id: selectedUser.id })
      setSubscriptionData(data)
      setModals({ ...modals, applyCredit: false })
      showToast('Credit applied')
    } catch (err) {
      console.error(err)
      showToast('Failed to apply credit', 'error')
    }
  }

  const handleChangePlan = async (plan, bracket) => {
    try {
      await billingCall('change_plan', { user_id: selectedUser.id, plan, bracket })
      // Refresh Stripe subscription data
      const data = await billingCall('get_subscription', { user_id: selectedUser.id })
      setSubscriptionData(data)
      // Update selectedUser so the modal pre-fills correctly if reopened
      const updatedUser = { ...selectedUser, plan, bracket }
      setSelectedUser(updatedUser)
      // Also update the users list sidebar so the new plan shows immediately
      setUsers(prev => prev.map(u => u.id === selectedUser.id ? updatedUser : u))
      setModals({ ...modals, changePlan: false })
      showToast(`Plan updated to ${plan} — changes take effect on user's next login`)
    } catch (err) {
      console.error(err)
      showToast('Failed to change plan', 'error')
    }
  }

  const handleGrantTrial = async (days) => {
    if (!window.confirm(`Grant ${days}-day free trial to ${selectedUser.email}?`)) return
    try {
      await billingCall('grant_trial', { user_id: selectedUser.id, days })
      const data = await billingCall('get_subscription', { user_id: selectedUser.id })
      setSubscriptionData(data)
      showToast(`${days}-day trial granted`)
    } catch (err) {
      console.error(err)
      showToast('Failed to grant trial', 'error')
    }
  }

  if (loading) {
    return <Spinner />
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      {/* Users List */}
      <div className="lg:col-span-1">
        <div className="bg-white rounded-lg shadow overflow-hidden">
          <div className="p-4 border-b border-gray-200 bg-gray-50">
            <h3 className="font-semibold text-gray-900">Accounts</h3>
          </div>
          <div className="max-h-96 overflow-y-auto">
            {users.map((u) => (
              <button
                key={u.id}
                onClick={() => handleSelectUser(u)}
                className={`w-full px-4 py-3 text-left border-b border-gray-100 hover:bg-gray-50 transition text-sm ${
                  selectedUser?.id === u.id ? 'bg-blue-50 border-l-4 border-blue-500' : ''
                }`}
              >
                <div className="font-medium text-gray-900">{u.email}</div>
                <div className="text-xs text-gray-500">{u.plan || 'Free'}</div>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Billing Details */}
      <div className="lg:col-span-2">
        {selectedUser && subscriptionData ? (
          <div className="space-y-6">
            {/* Subscription Details */}
            <div className="bg-white rounded-lg shadow p-6">
              <h3 className="text-lg font-semibold text-gray-900 mb-4">Subscription Details</h3>
              <div className="space-y-3 mb-6">
                <div className="flex justify-between">
                  <span className="text-gray-600">Status</span>
                  <span className={`font-medium ${subscriptionData.status === 'active' ? 'text-green-600' : 'text-amber-600'}`}>
                    {subscriptionData.status}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">Plan</span>
                  <span className="font-medium text-gray-900">{subscriptionData.plan_name || 'N/A'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">Next Billing</span>
                  <span className="font-medium text-gray-900">
                    {subscriptionData.current_period_end
                      ? new Date(subscriptionData.current_period_end).toLocaleDateString()
                      : 'N/A'}
                  </span>
                </div>
                {subscriptionData.cancel_at_period_end && (
                  <div className="p-3 bg-amber-50 border border-amber-200 rounded text-amber-900 text-sm">
                    Subscription will be cancelled at the end of the current billing period.
                  </div>
                )}
              </div>

              <div className="flex flex-wrap gap-2">
                <button
                  onClick={handleCancelSubscription}
                  className="px-3 py-2 bg-red-700 text-white text-sm rounded hover:bg-red-800 transition"
                >
                  Cancel Subscription
                </button>
                <button
                  onClick={handleRetryPayment}
                  className="px-3 py-2 bg-amber-600 text-white text-sm rounded hover:bg-amber-700 transition"
                >
                  Retry Failed Payment
                </button>
                <button
                  onClick={handleOpenStripePortal}
                  className="px-3 py-2 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 transition"
                >
                  Open Stripe Portal
                </button>
              </div>
            </div>

            {/* Free Trial Management */}
            <div className="bg-white rounded-lg shadow p-6">
              <h3 className="text-lg font-semibold text-gray-900 mb-4">Free Trial</h3>
              <p className="text-sm text-gray-600 mb-4">Grant this user a free trial period. Their card will be charged automatically when the trial ends.</p>
              <div className="flex flex-wrap gap-2">
                {[7, 30, 90].map(days => (
                  <button
                    key={days}
                    onClick={() => handleGrantTrial(days)}
                    className="px-4 py-2 bg-purple-600 text-white text-sm rounded-lg hover:bg-purple-700 transition font-medium"
                  >
                    {days}-Day Trial
                  </button>
                ))}
              </div>
              {subscriptionData?.trial_end && (
                <div className="mt-3 p-3 bg-purple-50 border border-purple-200 rounded-lg">
                  <p className="text-sm text-purple-900 font-medium">
                    Trial active — ends {new Date(subscriptionData.trial_end).toLocaleDateString()}
                    {' '}({Math.max(0, Math.ceil((new Date(subscriptionData.trial_end) - new Date()) / 86400000))} days remaining)
                  </p>
                </div>
              )}
            </div>

            {/* Payment History */}
            <div className="bg-white rounded-lg shadow p-6">
              <h3 className="text-lg font-semibold text-gray-900 mb-4">Payment History</h3>
              {paymentHistory.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 border-b border-gray-200">
                      <tr>
                        <th className="px-3 py-2 text-left font-semibold text-gray-700">Date</th>
                        <th className="px-3 py-2 text-left font-semibold text-gray-700">Amount</th>
                        <th className="px-3 py-2 text-left font-semibold text-gray-700">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {paymentHistory.map((payment, i) => (
                        <tr key={i} className="border-b border-gray-200">
                          <td className="px-3 py-2 text-gray-600">
                            {new Date(payment.date).toLocaleDateString()}
                          </td>
                          <td className="px-3 py-2 font-medium text-gray-900">${(payment.amount / 100).toFixed(2)}</td>
                          <td className="px-3 py-2">
                            <span
                              className={`px-2 py-1 text-xs rounded-full font-medium ${
                                payment.status === 'succeeded'
                                  ? 'bg-green-100 text-green-800'
                                  : 'bg-red-100 text-red-800'
                              }`}
                            >
                              {payment.status}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-gray-500 text-sm">No payment history</p>
              )}
            </div>

            {/* Credit & Plan Changes */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <button
                onClick={() => setModals({ ...modals, applyCredit: true })}
                className="px-4 py-3 bg-green-600 text-white rounded-lg hover:bg-green-700 transition font-medium"
              >
                Apply Credit
              </button>
              <button
                onClick={() => setModals({ ...modals, changePlan: true })}
                className="px-4 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition font-medium"
              >
                Change Plan
              </button>
            </div>
          </div>
        ) : (
          <div className="bg-white rounded-lg shadow p-6 text-center text-gray-500">
            <p>Select a user to view billing details</p>
          </div>
        )}
      </div>

      {/* Apply Credit Modal */}
      {modals.applyCredit && (
        <ApplyCreditModal
          onSave={handleApplyCredit}
          onClose={() => setModals({ ...modals, applyCredit: false })}
        />
      )}

      {/* Change Plan Modal — reads plan/bracket from selectedUser (Supabase metadata),
           not subscriptionData (Stripe), because free users have no Stripe subscription */}
      {modals.changePlan && (
        <ChangePlanModal
          currentPlan={selectedUser?.plan}
          currentBracket={selectedUser?.bracket}
          onSave={handleChangePlan}
          onClose={() => setModals({ ...modals, changePlan: false })}
        />
      )}

      {/* Manual User Creation */}
      <div className="lg:col-span-3">
        <div className="bg-white rounded-lg shadow p-6 mt-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-2">Add User Manually</h3>
          <p className="text-sm text-gray-500 mb-4">Create a new user account and set their initial plan. They'll receive a welcome email with login instructions.</p>
          <ManualUserCreation billingCall={billingCall} showToast={showToast} />
        </div>
      </div>
    </div>
  )
}

const ApplyCreditModal = ({ onSave, onClose }) => {
  const [amount, setAmount] = useState('')
  const [description, setDescription] = useState('')

  const handleSave = () => {
    if (!amount || isNaN(parseFloat(amount))) {
      alert('Valid amount required')
      return
    }
    onSave(parseFloat(amount), description)
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-40">
      <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4 shadow-lg">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">Apply Credit</h3>
        <input
          type="number"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="Amount ($)"
          step="0.01"
          min="0"
          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-red-700 mb-3"
        />
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Description (optional)"
          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-red-700 mb-4"
          rows={3}
        />
        <div className="flex gap-3 justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="px-4 py-2 text-white rounded-lg transition"
            style={{ backgroundColor: '#1a2744' }}
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  )
}

const PLAN_FAMILIES = {
  candidate: [
    { key: 'scout',      label: 'Scout',    price: 'Free',       desc: '1 lite profile' },
    { key: 'c_monitor',  label: 'Monitor',  price: '$59/mo',     desc: '1 full profile/mo' },
    { key: 'c_active',   label: 'Active',   price: '$89/mo',     desc: '2 profiles/mo, compare, intel' },
    { key: 'c_campaign', label: 'Campaign', price: '$139/mo',    desc: '4 profiles/mo, 2 seats, weekly auto-refresh' },
  ],
  action: [
    { key: 'a_monitor',  label: 'Monitor',  price: 'From $69/mo',  desc: '15 profiles/mo, prospecting, offices' },
    { key: 'a_active',   label: 'Active',   price: 'From $119/mo', desc: '30 profiles/mo, 2 seats, compare' },
    { key: 'a_campaign', label: 'Campaign', price: 'From $159/mo', desc: '50 profiles/mo, unlimited seats, bulk profiler' },
  ],
}

const ACTION_PLAN_KEYS = PLAN_FAMILIES.action.map(p => p.key)

const BRACKET_OPTIONS = [
  { key: 'b1',   label: '1 candidate' },
  { key: 'b2',   label: '2–3 candidates' },
  { key: 'b3',   label: '4–5 candidates' },
  { key: 'b4',   label: '6–10 candidates' },
  { key: 'b5',   label: '11–25 candidates' },
  { key: 'b6',   label: '26–50 candidates' },
  { key: 'b7',   label: '51–100 candidates' },
  { key: 'b8',   label: '100+ candidates' },
]

const ChangePlanModal = ({ currentPlan, currentBracket, onSave, onClose }) => {
  // Normalize legacy plan keys to new keys for display
  const normalizePlan = (p) => {
    if (!p) return 'scout'
    const MAP = { monitor: 'c_monitor', campaign: 'c_campaign', agency: 'a_campaign' }
    return MAP[p] || p
  }

  const [plan, setPlan]       = useState(normalizePlan(currentPlan))
  const [bracket, setBracket] = useState(currentBracket || 'b1')
  const [saving, setSaving]   = useState(false)
  const isAction = ACTION_PLAN_KEYS.includes(plan)

  const handleSave = () => {
    setSaving(true)
    onSave(plan, isAction ? bracket : null)
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-40">
      <div className="bg-white rounded-xl p-6 max-w-lg w-full mx-4 shadow-xl">
        <h3 className="text-lg font-semibold text-gray-900 mb-1">Change Plan</h3>
        <p className="text-sm text-gray-500 mb-5">Select a plan family and tier. Changes take effect on the user's next login.</p>

        {/* Candidate Plans */}
        <div className="mb-5">
          <p className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-2">Candidate Plans</p>
          <div className="grid grid-cols-2 gap-2">
            {PLAN_FAMILIES.candidate.map(p => (
              <button
                key={p.key}
                onClick={() => setPlan(p.key)}
                className={`text-left p-3 rounded-lg border-2 transition ${plan === p.key ? 'border-brand-red bg-brand-red/5' : 'border-gray-200 hover:border-gray-300'}`}
              >
                <div className="flex items-center justify-between mb-0.5">
                  <span className="font-semibold text-sm text-gray-900">{p.label}</span>
                  <span className="text-xs text-gray-500">{p.price}</span>
                </div>
                <p className="text-xs text-gray-400">{p.desc}</p>
              </button>
            ))}
          </div>
        </div>

        {/* Action Plans */}
        <div className="mb-5">
          <p className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-2">Action Plans</p>
          <div className="grid grid-cols-3 gap-2">
            {PLAN_FAMILIES.action.map(p => (
              <button
                key={p.key}
                onClick={() => setPlan(p.key)}
                className={`text-left p-3 rounded-lg border-2 transition ${plan === p.key ? 'border-brand-red bg-brand-red/5' : 'border-gray-200 hover:border-gray-300'}`}
              >
                <div className="flex items-center justify-between mb-0.5">
                  <span className="font-semibold text-sm text-gray-900">{p.label}</span>
                </div>
                <p className="text-xs text-gray-400 leading-tight">{p.price}</p>
                <p className="text-xs text-gray-400 leading-tight mt-0.5">{p.desc}</p>
              </button>
            ))}
          </div>
        </div>

        {/* Bracket — only for action plans */}
        {isAction && (
          <div className="mb-5">
            <label className="block text-sm font-medium text-gray-700 mb-2">Candidate Bracket</label>
            <select
              value={bracket}
              onChange={(e) => setBracket(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-red-700"
            >
              {BRACKET_OPTIONS.map(b => (
                <option key={b.key} value={b.key}>{b.label}</option>
              ))}
            </select>
          </div>
        )}

        {/* Selected plan summary */}
        <div className="mb-4 px-3 py-2 bg-gray-50 rounded-lg text-sm text-gray-600">
          Setting plan to: <span className="font-semibold text-gray-900">{plan}</span>
          {isAction && <span className="text-gray-500"> · bracket: <span className="font-semibold text-gray-900">{bracket}</span></span>}
        </div>

        <div className="flex gap-3 justify-end">
          <button onClick={onClose} className="px-4 py-2 text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition text-sm">
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 text-white rounded-lg transition text-sm disabled:opacity-50"
            style={{ backgroundColor: '#1a2744' }}
          >
            {saving ? 'Saving...' : 'Save Plan'}
          </button>
        </div>
      </div>
    </div>
  )
}

// TAB 4: AI Costs
const AICostsTab = ({ apiCall, showToast }) => {
  const [costs, setCosts] = useState(null)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [hoveredIndex, setHoveredIndex] = useState(null)

  useEffect(() => {
    const fetch = async () => {
      try {
        setLoading(true)
        const data = await apiCall('ai_costs')
        const categories = Array.isArray(data) ? data : (data?.categories || [])
        const normalized = categories.map(c => ({ ...c, cost: c.estimated_cost ?? c.cost ?? 0 }))
        setCosts(normalized)
        setTotal(data?.total ?? normalized.reduce((s, c) => s + (c.cost || 0), 0))
      } catch (err) {
        console.error(err)
        showToast('Failed to load AI costs', 'error')
      } finally {
        setLoading(false)
      }
    }
    fetch()
  }, [apiCall, showToast])

  if (loading) return <Spinner />

  // Even if DB returned nothing, costs should have fixed estimates from backend
  const hasCosts = costs && costs.length > 0

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white rounded-lg shadow p-6 border-l-4 border-red-500">
          <p className="text-gray-500 text-sm font-medium">Total Estimated Spend</p>
          <p className="text-3xl font-bold text-red-700 mt-1">${total.toFixed(2)}</p>
          <p className="text-xs text-gray-400 mt-1">All-time across all AI services</p>
        </div>
        <div className="bg-white rounded-lg shadow p-6 border-l-4 border-blue-500">
          <p className="text-gray-500 text-sm font-medium">Dynamic (logged calls)</p>
          <p className="text-3xl font-bold text-gray-900 mt-1">
            ${(costs || []).filter(c => c.count !== null).reduce((s, c) => s + (c.cost || 0), 0).toFixed(2)}
          </p>
          <p className="text-xs text-gray-400 mt-1">From generation_logs table</p>
        </div>
        <div className="bg-white rounded-lg shadow p-6 border-l-4 border-amber-500">
          <p className="text-gray-500 text-sm font-medium">Fixed Baseline Estimates</p>
          <p className="text-3xl font-bold text-gray-900 mt-1">
            ${(costs || []).filter(c => c.count === null).reduce((s, c) => s + (c.cost || 0), 0).toFixed(2)}
          </p>
          <p className="text-xs text-gray-400 mt-1">Background jobs &amp; Perplexity</p>
        </div>
      </div>

      {hasCosts ? (
        <>
          {/* Donut Chart */}
          <div className="bg-white rounded-lg shadow p-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-6">Cost Breakdown by Category</h3>
            <DonutChart data={costs} hoveredIndex={hoveredIndex} setHoveredIndex={setHoveredIndex} />
          </div>

          {/* Detail Table */}
          <div className="bg-white rounded-lg shadow overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-200">
              <h3 className="text-lg font-semibold text-gray-900">Cost Detail</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="px-4 py-3 text-left font-semibold text-gray-700">Category</th>
                    <th className="px-4 py-3 text-left font-semibold text-gray-700">Model / Service</th>
                    <th className="px-4 py-3 text-left font-semibold text-gray-700">Calls</th>
                    <th className="px-4 py-3 text-right font-semibold text-gray-700">Est. Cost</th>
                    <th className="px-4 py-3 text-right font-semibold text-gray-700">% of Total</th>
                    <th className="px-4 py-3 text-left font-semibold text-gray-700">Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {[...costs].sort((a, b) => (b.cost || 0) - (a.cost || 0)).map((c, i) => (
                    <tr key={i} className="border-b border-gray-100 hover:bg-gray-50">
                      <td className="px-4 py-3 font-medium text-gray-900">{c.label}</td>
                      <td className="px-4 py-3 text-gray-500 text-xs font-mono">{c.model || '—'}</td>
                      <td className="px-4 py-3 text-gray-600">{c.count !== null ? c.count.toLocaleString() : <span className="text-gray-400 italic">fixed estimate</span>}</td>
                      <td className="px-4 py-3 text-right font-semibold text-gray-900">${(c.cost || 0).toFixed(4)}</td>
                      <td className="px-4 py-3 text-right text-gray-500">
                        {total > 0 ? (((c.cost || 0) / total) * 100).toFixed(1) + '%' : '—'}
                      </td>
                      <td className="px-4 py-3 text-gray-400 text-xs">{c.note || '—'}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-gray-50 border-t-2 border-gray-300">
                  <tr>
                    <td colSpan={3} className="px-4 py-3 font-bold text-gray-900">Total</td>
                    <td className="px-4 py-3 text-right font-bold text-red-700">${total.toFixed(4)}</td>
                    <td colSpan={2} className="px-4 py-3 text-right text-gray-400 text-xs">All estimates are approximations</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        </>
      ) : (
        <div className="bg-white rounded-lg shadow p-8 text-center text-gray-500">
          <p className="font-medium">No cost data available</p>
          <p className="text-sm mt-1">The generation_logs table may not be set up yet. Fixed estimates will appear here once the backend is configured.</p>
        </div>
      )}
    </div>
  )
}

const DonutChart = ({ data, hoveredIndex, setHoveredIndex }) => {
  const colors = ['#cc0000', '#1a2744', '#3b82f6', '#f59e0b', '#10b981', '#8b5cf6', '#ef4444', '#6b7280']
  const total = data.reduce((sum, d) => sum + (d.cost || 0), 0)

  let currentAngle = 0
  const arcs = data.map((d, i) => {
    const sliceAngle = (d.cost / total) * 360
    const startAngle = currentAngle
    const endAngle = currentAngle + sliceAngle

    const start = polarToCartesian(130, 130, 110, endAngle)
    const end = polarToCartesian(130, 130, 110, startAngle)
    const innerStart = polarToCartesian(130, 130, 60, endAngle)
    const innerEnd = polarToCartesian(130, 130, 60, startAngle)

    const largeArc = sliceAngle > 180 ? 1 : 0
    const path = `M ${start.x} ${start.y} A 110 110 0 ${largeArc} 0 ${end.x} ${end.y} L ${innerEnd.x} ${innerEnd.y} A 60 60 0 ${largeArc} 1 ${innerStart.x} ${innerStart.y} Z`

    currentAngle = endAngle

    return { path, color: colors[i % colors.length] }
  })

  return (
    <div className="flex flex-col items-center">
      <svg width={260} height={260} viewBox="0 0 260 260" className="mb-8">
        {arcs.map((arc, i) => (
          <path
            key={i}
            d={arc.path}
            fill={arc.color}
            opacity={hoveredIndex === i ? 1 : 0.8}
            className="transition-opacity cursor-pointer"
            onMouseEnter={() => setHoveredIndex(i)}
            onMouseLeave={() => setHoveredIndex(null)}
          />
        ))}

        {/* Center hover info */}
        {hoveredIndex !== null && (
          <text
            x={130}
            y={130}
            textAnchor="middle"
            dominantBaseline="middle"
            className="text-xs font-bold fill-gray-900"
          >
            {data[hoveredIndex]?.label || 'N/A'}
          </text>
        )}
      </svg>

      {/* Legend */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 w-full">
        {data.map((d, i) => {
          const percentage = ((d.cost / total) * 100).toFixed(1)
          return (
            <button
              key={i}
              onClick={() => setHoveredIndex(hoveredIndex === i ? null : i)}
              className="flex items-center gap-3 p-3 rounded-lg hover:bg-gray-50 transition text-left"
            >
              <div
                className="w-4 h-4 rounded"
                style={{ backgroundColor: colors[i % colors.length] }}
              />
              <div className="flex-1 min-w-0">
                <div className="font-medium text-gray-900 text-sm truncate">{d.label}</div>
                <div className="text-xs text-gray-500">
                  ${d.cost?.toFixed(2)} ({percentage}%)
                </div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

const polarToCartesian = (centerX, centerY, radius, angleInDegrees) => {
  const angleInRadians = ((angleInDegrees - 90) * Math.PI) / 180.0
  return {
    x: centerX + radius * Math.cos(angleInRadians),
    y: centerY + radius * Math.sin(angleInRadians),
  }
}

// TAB 5: Error Logs
const ErrorLogsTab = ({ apiCall, showToast }) => {
  const [errors, setErrors] = useState([])
  const [showResolved, setShowResolved] = useState(false)
  const [loading, setLoading] = useState(true)
  const [fixPromptModal, setFixPromptModal] = useState(null)
  const [expandedId, setExpandedId] = useState(null)
  const [componentFilter, setComponentFilter] = useState('all')
  const [search, setSearch] = useState('')

  const loadErrors = async (resolved = showResolved) => {
    try {
      setLoading(true)
      const data = await apiCall('error_logs', { show_resolved: resolved })
      setErrors(Array.isArray(data) ? data : (data?.logs || []))
    } catch (err) {
      console.error(err)
      showToast('Failed to load error logs', 'error')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadErrors() }, []) // eslint-disable-line

  const handleToggleResolved = (val) => {
    setShowResolved(val)
    loadErrors(val)
  }

  const handleMarkResolved = async (errorId) => {
    try {
      await apiCall('resolve_error', { id: errorId })
      showToast('Error marked as resolved')
      loadErrors()
    } catch (err) {
      console.error(err)
      showToast('Failed to resolve error', 'error')
    }
  }

  const handleResolveAll = async () => {
    const unresolved = filteredErrors.filter(e => !e.resolved)
    if (unresolved.length === 0) return
    if (!window.confirm(`Resolve all ${unresolved.length} visible unresolved errors?`)) return
    try {
      await Promise.all(unresolved.map(e => apiCall('resolve_error', { id: e.id })))
      showToast(`Resolved ${unresolved.length} errors`)
      loadErrors()
    } catch (err) {
      console.error(err)
      showToast('Failed to resolve all errors', 'error')
    }
  }

  // Unique components for filter dropdown
  const components = ['all', ...Array.from(new Set(errors.map(e => e.component || 'Unknown'))).sort()]

  const filteredErrors = errors.filter((e) => {
    if (componentFilter !== 'all' && (e.component || 'Unknown') !== componentFilter) return false
    if (search) {
      const s = search.toLowerCase()
      const msg = (e.error_message || '').toLowerCase()
      const comp = (e.component || '').toLowerCase()
      const url = (e.url || '').toLowerCase()
      const user = (e.user_email || '').toLowerCase()
      if (!msg.includes(s) && !comp.includes(s) && !url.includes(s) && !user.includes(s)) return false
    }
    return true
  })

  if (loading) return <Spinner />

  return (
    <div className="space-y-4">
      {/* Controls bar */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="showResolved"
            checked={showResolved}
            onChange={(e) => handleToggleResolved(e.target.checked)}
            className="w-4 h-4"
          />
          <label htmlFor="showResolved" className="text-sm font-medium text-gray-700">
            Show Resolved
          </label>
        </div>
        <select
          value={componentFilter}
          onChange={(e) => setComponentFilter(e.target.value)}
          className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-gray-400"
        >
          {components.map(c => <option key={c} value={c}>{c === 'all' ? 'All Components' : c}</option>)}
        </select>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search errors…"
          className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-gray-400 w-56"
        />
        <span className="text-sm text-gray-500 ml-auto">{filteredErrors.length} of {errors.length} errors</span>
        {filteredErrors.some(e => !e.resolved) && (
          <button
            onClick={handleResolveAll}
            className="px-3 py-1.5 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 transition font-medium"
          >
            Resolve All Visible
          </button>
        )}
      </div>

      {/* Errors Table */}
      <div className="bg-white rounded-lg shadow overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="px-4 py-3 text-left font-semibold text-gray-700 w-36">Timestamp</th>
              <th className="px-4 py-3 text-left font-semibold text-gray-700 w-28">Component</th>
              <th className="px-4 py-3 text-left font-semibold text-gray-700">Error Message</th>
              <th className="px-4 py-3 text-left font-semibold text-gray-700 w-24">User</th>
              <th className="px-4 py-3 text-left font-semibold text-gray-700 w-24">Status</th>
              <th className="px-4 py-3 text-left font-semibold text-gray-700 w-20">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredErrors.length > 0 ? (
              filteredErrors.map((error) => (
                <React.Fragment key={error.id}>
                  <tr
                    className={`border-b border-gray-200 hover:bg-gray-50 cursor-pointer ${expandedId === error.id ? 'bg-blue-50' : ''}`}
                    onClick={() => setExpandedId(expandedId === error.id ? null : error.id)}
                  >
                    <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">
                      {new Date(error.created_at).toLocaleString()}
                    </td>
                    <td className="px-4 py-3">
                      <span className="px-2 py-0.5 bg-gray-100 text-gray-700 rounded text-xs font-mono">
                        {error.component || 'Unknown'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-800 font-medium max-w-md">
                      <div className="truncate">{error.error_message || '(no message)'}</div>
                      {error.url && (
                        <div className="text-xs text-gray-400 truncate mt-0.5">{error.url}</div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500 truncate max-w-[6rem]">
                      {error.user_email ? (
                        <span title={error.user_email}>{error.user_email.split('@')[0]}</span>
                      ) : '—'}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-1 text-xs rounded-full font-medium ${
                        error.resolved ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
                      }`}>
                        {error.resolved ? 'Resolved' : 'Open'}
                      </span>
                    </td>
                    <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                      <div className="flex gap-1">
                        {!error.resolved && (
                          <button
                            onClick={() => handleMarkResolved(error.id)}
                            className="p-1.5 text-green-600 hover:bg-green-50 rounded transition"
                            title="Mark resolved"
                          >
                            <Check className="w-4 h-4" />
                          </button>
                        )}
                        <button
                          onClick={() => setFixPromptModal(error)}
                          className="p-1.5 text-purple-600 hover:bg-purple-50 rounded transition"
                          title="Generate fix prompt"
                        >
                          <Wand2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>

                  {/* Expanded detail row */}
                  {expandedId === error.id && (
                    <tr className="bg-blue-50 border-b border-blue-200">
                      <td colSpan={6} className="px-6 py-4">
                        <div className="space-y-3">
                          {/* Full message */}
                          <div>
                            <p className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-1">Full Error Message</p>
                            <p className="text-sm text-gray-900 font-medium">{error.error_message || '(none)'}</p>
                          </div>

                          {/* Stack trace */}
                          {error.error_stack && (
                            <div>
                              <p className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-1">Stack Trace</p>
                              <pre className="bg-gray-900 text-green-300 text-xs rounded-lg p-4 overflow-x-auto whitespace-pre-wrap font-mono max-h-64 overflow-y-auto">
                                {error.error_stack}
                              </pre>
                            </div>
                          )}

                          {/* Metadata grid */}
                          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                            <div>
                              <p className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-1">URL</p>
                              <p className="text-xs text-gray-700 break-all">{error.url || '—'}</p>
                            </div>
                            <div>
                              <p className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-1">User</p>
                              <p className="text-xs text-gray-700 break-all">{error.user_email || error.user_id || '—'}</p>
                            </div>
                            <div>
                              <p className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-1">User Agent</p>
                              <p className="text-xs text-gray-700 break-all line-clamp-2" title={error.user_agent}>{error.user_agent || '—'}</p>
                            </div>
                            <div>
                              <p className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-1">Error ID</p>
                              <p className="text-xs text-gray-500 font-mono">{error.id}</p>
                            </div>
                          </div>

                          {/* Metadata JSON */}
                          {error.metadata && (
                            <div>
                              <p className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-1">Metadata</p>
                              <pre className="bg-gray-100 text-gray-800 text-xs rounded-lg p-3 overflow-x-auto font-mono">
                                {JSON.stringify(error.metadata, null, 2)}
                              </pre>
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))
            ) : (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-gray-500">
                  {errors.length === 0 ? '🎉 No errors logged' : 'No errors match your filters'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Fix Prompt Modal */}
      {fixPromptModal && (
        <FixPromptModal error={fixPromptModal} onClose={() => setFixPromptModal(null)} />
      )}
    </div>
  )
}

const FixPromptModal = ({ error, onClose }) => {
  const [copied, setCopied] = useState(false)

  const prompt = `I have a bug in my React/Netlify app (Badger Board — a Wisconsin political intelligence SaaS). Please help me diagnose and fix it.

**Error:** ${error.error_message || error.message || 'Unknown error'}

**Stack Trace:**
${error.error_stack || error.stack || 'Not available'}

**Component:** ${error.component || 'Unknown'}
**URL when it occurred:** ${error.url || 'Unknown'}
**User:** ${error.user_email || error.user_id || 'Unknown'}
**User Agent:** ${error.user_agent || 'Unknown'}
**Occurred at:** ${new Date(error.created_at).toLocaleString()}
${error.metadata ? `\n**Metadata:**\n${JSON.stringify(error.metadata, null, 2)}` : ''}

Please:
1. Diagnose the root cause
2. Provide the exact code fix
3. Suggest any related issues to watch for`

  const handleCopy = () => {
    navigator.clipboard.writeText(prompt)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-40">
      <div className="bg-white rounded-lg p-6 max-w-2xl w-full mx-4 shadow-lg max-h-[80vh] overflow-y-auto">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">Claude Fix Prompt</h3>
        <textarea
          value={prompt}
          readOnly
          className="w-full px-3 py-2 border border-gray-300 rounded-lg bg-gray-50 font-mono text-xs mb-4"
          rows={12}
        />
        <div className="flex gap-3 justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition"
          >
            Close
          </button>
          <button
            onClick={handleCopy}
            className="px-4 py-2 text-white rounded-lg transition flex items-center gap-2"
            style={{ backgroundColor: '#1a2744' }}
          >
            <Copy className="w-4 h-4" />
            {copied ? 'Copied!' : 'Copy Prompt'}
          </button>
        </div>
      </div>
    </div>
  )
}

// TAB 6: Announcements
const AnnouncementsTab = ({ apiCall, showToast }) => {
  const [announcements, setAnnouncements] = useState([])
  const [loading, setLoading] = useState(true)
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [formData, setFormData] = useState({
    type: 'info',
    message: '',
  })

  useEffect(() => {
    const fetch = async () => {
      try {
        setLoading(true)
        const data = await apiCall('announcements')
        // Server returns { announcements: [...] } — extract the array
        setAnnouncements(Array.isArray(data) ? data : (data?.announcements || []))
      } catch (err) {
        console.error(err)
        showToast('Failed to load announcements', 'error')
      } finally {
        setLoading(false)
      }
    }

    fetch()
  }, [apiCall, showToast])

  const handleCreateAnnouncement = async () => {
    if (!formData.message.trim()) {
      alert('Message is required')
      return
    }

    try {
      await apiCall('create_announcement', {
        type: formData.type,
        message: formData.message,
      })
      const data = await apiCall('announcements')
      setAnnouncements(Array.isArray(data) ? data : (data?.announcements || []))
      setShowCreateForm(false)
      setFormData({ type: 'info', message: '' })
      showToast('Announcement created')
    } catch (err) {
      console.error(err)
      showToast('Failed to create announcement', 'error')
    }
  }

  const handleToggleActive = async (announcementId, isActive) => {
    try {
      await apiCall('toggle_announcement', {
        announcement_id: announcementId,
        active: !isActive,
      })
      const data = await apiCall('announcements')
      setAnnouncements(Array.isArray(data) ? data : (data?.announcements || []))
      showToast(`Announcement ${!isActive ? 'activated' : 'deactivated'}`)
    } catch (err) {
      console.error(err)
      showToast('Failed to toggle announcement', 'error')
    }
  }

  const handleDeleteAnnouncement = async (announcementId) => {
    if (!window.confirm('Delete this announcement?')) return

    try {
      await apiCall('delete_announcement', { announcement_id: announcementId })
      const data = await apiCall('announcements')
      setAnnouncements(Array.isArray(data) ? data : (data?.announcements || []))
      showToast('Announcement deleted')
    } catch (err) {
      console.error(err)
      showToast('Failed to delete announcement', 'error')
    }
  }

  if (loading) {
    return <Spinner />
  }

  const typeColors = {
    info: 'bg-blue-100 text-blue-800',
    warning: 'bg-amber-100 text-amber-800',
    success: 'bg-green-100 text-green-800',
    error: 'bg-red-100 text-red-800',
  }

  const typeBackgrounds = {
    info: 'bg-blue-50',
    warning: 'bg-amber-50',
    success: 'bg-green-50',
    error: 'bg-red-50',
  }

  return (
    <div className="space-y-6">
      {/* Create Button */}
      <button
        onClick={() => setShowCreateForm(!showCreateForm)}
        className="inline-flex items-center gap-2 px-4 py-2 bg-red-700 text-white rounded-lg hover:bg-red-800 transition font-medium"
      >
        <Plus className="w-4 h-4" />
        Create Announcement
      </button>

      {/* Create Form */}
      {showCreateForm && (
        <div className="bg-white rounded-lg shadow p-6 border border-gray-200">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">New Announcement</h3>

          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 mb-2">Type</label>
            <select
              value={formData.type}
              onChange={(e) => setFormData({ ...formData, type: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-red-700"
            >
              <option value="info">Info</option>
              <option value="warning">Warning</option>
              <option value="success">Success</option>
              <option value="error">Error</option>
            </select>
          </div>

          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 mb-2">Message</label>
            <textarea
              value={formData.message}
              onChange={(e) => setFormData({ ...formData, message: e.target.value })}
              placeholder="Enter announcement message..."
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-red-700"
              rows={4}
            />
          </div>

          {/* Preview */}
          {formData.message && (
            <div className="mb-4 p-4 rounded-lg" style={{ backgroundColor: typeBackgrounds[formData.type] }}>
              <p className="font-medium text-gray-900">Preview:</p>
              <div className="mt-2">
                <span className={`px-3 py-1 text-xs rounded-full font-medium mr-2 ${typeColors[formData.type]}`}>
                  {formData.type.charAt(0).toUpperCase() + formData.type.slice(1)}
                </span>
              </div>
              <p className="text-gray-800 mt-2 text-sm">{formData.message}</p>
            </div>
          )}

          <div className="flex gap-3 justify-end">
            <button
              onClick={() => setShowCreateForm(false)}
              className="px-4 py-2 text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition"
            >
              Cancel
            </button>
            <button
              onClick={handleCreateAnnouncement}
              className="px-4 py-2 text-white rounded-lg transition"
              style={{ backgroundColor: '#1a2744' }}
            >
              Post Announcement
            </button>
          </div>
        </div>
      )}

      {/* Announcements Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {announcements.map((announcement) => (
          <div
            key={announcement.id}
            className="bg-white rounded-lg shadow p-6 border border-gray-200"
          >
            <div className="flex items-start justify-between mb-3">
              <span className={`px-3 py-1 text-xs rounded-full font-medium ${typeColors[announcement.type]}`}>
                {announcement.type.charAt(0).toUpperCase() + announcement.type.slice(1)}
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleToggleActive(announcement.id, announcement.active)}
                  className={`px-3 py-1 text-xs rounded font-medium transition ${
                    announcement.active
                      ? 'bg-green-100 text-green-800 hover:bg-green-200'
                      : 'bg-gray-100 text-gray-800 hover:bg-gray-200'
                  }`}
                >
                  {announcement.active ? 'Active' : 'Inactive'}
                </button>
              </div>
            </div>

            <p className="text-gray-800 mb-4">{announcement.message}</p>

            <div className="flex gap-2">
              <button
                onClick={() => handleDeleteAnnouncement(announcement.id)}
                className="px-3 py-2 text-red-600 hover:bg-red-50 rounded transition text-sm font-medium flex items-center gap-1"
              >
                <Trash2 className="w-4 h-4" />
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>

      {announcements.length === 0 && !showCreateForm && (
        <div className="bg-white rounded-lg shadow p-6 text-center text-gray-500">
          <p>No announcements yet</p>
        </div>
      )}
    </div>
  )
}

// Manual User Creation Component
const ManualUserCreation = ({ billingCall, showToast }) => {
  const [form, setForm] = useState({ email: '', password: '', plan: 'scout', bracket: 'b1' })
  const [saving, setSaving] = useState(false)

  const isActionPlan = ACTION_PLAN_KEYS.includes(form.plan)

  const handleCreate = async () => {
    if (!form.email || !form.password) { showToast('Email and password required', 'error'); return }
    if (form.password.length < 8) { showToast('Password must be at least 8 characters', 'error'); return }
    setSaving(true)
    try {
      await billingCall('create_user', {
        email: form.email,
        password: form.password,
        plan: form.plan,
        bracket: isActionPlan ? form.bracket : undefined,
      })
      showToast(`Account created for ${form.email}`)
      setForm({ email: '', password: '', plan: 'scout', bracket: 'b1' })
    } catch (err) {
      showToast(err.message || 'Failed to create user', 'error')
    } finally { setSaving(false) }
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-semibold text-gray-700 mb-1">Email</label>
          <input type="email" value={form.email} onChange={e => setForm({...form, email: e.target.value})}
            placeholder="user@example.com" className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-red-700" />
        </div>
        <div>
          <label className="block text-xs font-semibold text-gray-700 mb-1">Initial Password</label>
          <input type="password" value={form.password} onChange={e => setForm({...form, password: e.target.value})}
            placeholder="Min. 8 characters" className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-red-700" />
        </div>
        <div>
          <label className="block text-xs font-semibold text-gray-700 mb-1">Plan</label>
          <select value={form.plan} onChange={e => setForm({...form, plan: e.target.value})}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-red-700">
            <optgroup label="── Candidate Plans ──">
              {PLAN_FAMILIES.candidate.map(p => (
                <option key={p.key} value={p.key}>{p.label} — {p.price}</option>
              ))}
            </optgroup>
            <optgroup label="── Action Plans ──">
              {PLAN_FAMILIES.action.map(p => (
                <option key={p.key} value={p.key}>{p.label} (Action) — {p.price}</option>
              ))}
            </optgroup>
          </select>
        </div>
        {isActionPlan && (
        <div>
          <label className="block text-xs font-semibold text-gray-700 mb-1">Candidate Bracket</label>
          <select value={form.bracket} onChange={e => setForm({...form, bracket: e.target.value})}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-red-700">
            {BRACKET_OPTIONS.map(b => <option key={b.key} value={b.key}>{b.label}</option>)}
          </select>
        </div>
        )}
      </div>
      <button onClick={handleCreate} disabled={saving}
        className="px-5 py-2.5 bg-green-600 text-white rounded-lg hover:bg-green-700 transition font-medium text-sm disabled:opacity-50">
        {saving ? 'Creating...' : 'Create Account'}
      </button>
    </div>
  )
}

// ─── Security Audit Tab ───────────────────────────────────────────────────────
const SUITE_ORDER = [
  'Support Chat — Authentication',
  'JWT Manipulation Attacks',
  'Supabase RLS — Data Isolation',
  'Volunteer System — RLS',
  'HTTP Method Enforcement',
  'Admin Endpoint Isolation',
  'Input Validation',
  'Sensitive Data Exposure',
]

const SUITE_DESCRIPTIONS = {
  'Support Chat — Authentication':   'Verifies the in-app chat widget rejects unauthenticated and malformed requests.',
  'JWT Manipulation Attacks':        'Attempts tampered, alg:none, and signature-stripped tokens — all must be rejected.',
  'Supabase RLS — Data Isolation':   'Confirms User B cannot read, write, update, or delete User A\'s data.',
  'Volunteer System — RLS':          'Cross-user isolation for volunteer messages and notifications.',
  'HTTP Method Enforcement':         'Ensures POST-only endpoints reject GET, PUT, DELETE.',
  'Admin Endpoint Isolation':        'Regular users must be blocked from all admin functions.',
  'Input Validation':                'SQL injection tautologies and oversized payloads must be handled safely.',
  'Sensitive Data Exposure':         'Service keys, stack traces, and cross-user data must not appear in responses.',
}

function buildClaudePrompt(results, summary, lastRun) {
  const failures = results.filter(r => !r.ok)
  const now      = lastRun ? lastRun.toLocaleString() : new Date().toLocaleString()

  const failureBlock = failures.length === 0
    ? '  (none — all checks passed)'
    : failures.map(f => [
        `  Suite:  ${f.suite}`,
        `  Check:  ${f.name}`,
        `  Reason: ${f.reason || 'no detail'}`,
      ].join('\n')).join('\n\n')

  const passingBlock = results
    .filter(r => r.ok)
    .map(r => `  ✓ [${r.suite}] ${r.name}`)
    .join('\n')

  return `# Badger Board — Security Audit Report
Run at: ${now}
Result: ${summary.passed}/${summary.total} checks passed${failures.length > 0 ? `, ${failures.length} FAILED` : ' — all clear'}

## App Context
Badger Board is a Wisconsin political intelligence SaaS platform built on:
- Frontend: React 18 + Vite, deployed to Netlify
- Backend: Netlify Functions (Node.js, ES modules, esbuild bundler)
- Database: Supabase (PostgreSQL) with Row Level Security (RLS)
- Auth: Supabase Auth (JWTs)
- Key tables: door_knock_lists, door_knocks, volunteers, volunteer_messages,
  volunteer_notifications, dossiers, candidates, elections, error_logs

## Failed Checks (${failures.length})
${failureBlock}

## Passing Checks (${summary.passed})
${passingBlock}

## What I need
${failures.length === 0
  ? 'All security checks passed. Please review the passing checks above and suggest any additional security hardening measures I should consider for a political data SaaS platform.'
  : `For each failed check above, please:
1. Explain exactly what the vulnerability is and why it matters
2. Show the specific code fix (Netlify function, Supabase RLS policy, or React component — whichever applies)
3. Confirm whether any other parts of the codebase are likely affected by the same issue

Tech details that may help:
- Netlify functions are in /netlify/functions/*.js (ES module syntax, export const handler)
- Supabase RLS policies are applied via SQL migrations in /supabase/migrations/
- The support chat function verifies JWTs via Supabase /auth/v1/user before processing
- All DB queries in Netlify functions should use the caller's JWT (not service role) so RLS runs`}
`
}

function SecurityAuditTab({ session, showToast }) {
  const [running, setRunning]         = useState(false)
  const [results, setResults]         = useState(null)   // null = never run
  const [summary, setSummary]         = useState(null)
  const [lastRun, setLastRun]         = useState(null)
  const [expanded, setExpanded]       = useState({})
  const [error, setError]             = useState(null)
  const [promptOpen, setPromptOpen]   = useState(false)
  const [promptCopied, setPromptCopied] = useState(false)
  const promptRef                       = useRef(null)

  const generatedPrompt = results ? buildClaudePrompt(results, summary, lastRun) : null

  const copyPrompt = () => {
    if (!generatedPrompt) return
    navigator.clipboard.writeText(generatedPrompt).then(() => {
      setPromptCopied(true)
      showToast('Prompt copied — paste it into Claude', 'success')
      setTimeout(() => setPromptCopied(false), 2500)
    })
  }

  const runAudit = async () => {
    setRunning(true)
    setResults(null)
    setSummary(null)
    setError(null)
    setExpanded({})

    try {
      const res  = await fetch('/.netlify/functions/run-security-audit', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ token: session?.access_token }),
      })
      const data = await res.json()

      if (!res.ok || data.error) {
        setError(data.error || `Server error (${res.status})`)
        showToast('Security audit failed to run', 'error')
        return
      }

      setResults(data.results)
      setSummary(data.summary)
      setLastRun(new Date())

      if (data.summary.failed === 0) {
        showToast(`All ${data.summary.total} security checks passed ✓`, 'success')
      } else {
        showToast(`${data.summary.failed} security issue(s) found — review below`, 'error')
      }
    } catch (err) {
      setError(err.message)
      showToast('Security audit error: ' + err.message, 'error')
    } finally {
      setRunning(false)
    }
  }

  // Group results by suite
  const grouped = results
    ? SUITE_ORDER.reduce((acc, suite) => {
        const tests = results.filter(r => r.suite === suite)
        if (tests.length) acc[suite] = tests
        return acc
      }, {})
    : {}

  const allSuites = results
    ? [...SUITE_ORDER.filter(s => grouped[s]), ...Object.keys(grouped).filter(s => !SUITE_ORDER.includes(s))]
    : []

  return (
    <div className="space-y-6">
      {/* Header card */}
      <div className="bg-white rounded-2xl border border-gray-200 p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-4">
            <div className="w-12 h-12 rounded-xl bg-gray-900 flex items-center justify-center flex-shrink-0">
              <ShieldCheck className="w-6 h-6 text-white" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-gray-900">Security Audit</h2>
              <p className="text-sm text-gray-500 mt-0.5 max-w-xl">
                Runs {35}+ automated checks against the live app — JWT attacks, cross-user RLS isolation,
                admin endpoint access, input validation, and sensitive data exposure.
                Creates two throwaway test users, runs all checks, then deletes them.
              </p>
              {lastRun && (
                <p className="text-xs text-gray-400 mt-2">
                  Last run: {lastRun.toLocaleTimeString()} on {lastRun.toLocaleDateString()}
                </p>
              )}
            </div>
          </div>

          <button
            onClick={runAudit}
            disabled={running}
            className={`flex items-center gap-2 px-5 py-2.5 rounded-xl font-semibold text-sm transition-all flex-shrink-0 ${
              running
                ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                : 'bg-gray-900 text-white hover:bg-gray-800 active:scale-95'
            }`}
          >
            <RefreshCw className={`w-4 h-4 ${running ? 'animate-spin' : ''}`} />
            {running ? 'Running audit…' : results ? 'Run Again' : 'Run Security Audit'}
          </button>
        </div>

        {/* Summary bar */}
        {summary && (
          <div className="mt-5 pt-5 border-t border-gray-100 flex items-center gap-4 flex-wrap">
            <div className="flex items-center gap-2">
              <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${summary.failed === 0 ? 'bg-green-50' : 'bg-red-50'}`}>
                {summary.failed === 0
                  ? <CheckCircle2 className="w-5 h-5 text-green-600" />
                  : <XCircle className="w-5 h-5 text-red-600" />
                }
              </div>
              <div>
                <p className={`text-lg font-bold ${summary.failed === 0 ? 'text-green-700' : 'text-red-700'}`}>
                  {summary.passed}/{summary.total} passed
                </p>
                <p className="text-xs text-gray-400">
                  {summary.failed === 0 ? 'No vulnerabilities detected' : `${summary.failed} issue${summary.failed > 1 ? 's' : ''} require attention`}
                </p>
              </div>
            </div>

            {/* Mini progress bar */}
            <div className="flex-1 h-2.5 bg-gray-100 rounded-full overflow-hidden max-w-xs">
              <div
                className={`h-full rounded-full transition-all ${summary.failed === 0 ? 'bg-green-500' : 'bg-red-500'}`}
                style={{ width: `${(summary.passed / summary.total) * 100}%` }}
              />
            </div>

            {/* Generate Claude Prompt button */}
            <button
              onClick={() => { setPromptOpen(o => !o) }}
              className={`ml-auto flex items-center gap-2 px-4 py-2 rounded-xl font-semibold text-sm border transition-all ${
                promptOpen
                  ? 'bg-violet-600 text-white border-violet-600 hover:bg-violet-700'
                  : 'bg-white text-violet-700 border-violet-300 hover:bg-violet-50'
              }`}
              title={summary.failed === 0 ? 'Generate a hardening review prompt for Claude' : 'Generate a fix prompt for Claude'}
            >
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4 flex-shrink-0">
                <path d="M8 1.5a.5.5 0 0 1 .447.276l1.5 3 .047.106.117.026 3.3.66a.5.5 0 0 1 .277.842l-2.39 2.33-.076.074.018.104.565 3.29a.5.5 0 0 1-.726.527L8 11.202l-.08.042-2.949 1.533a.5.5 0 0 1-.726-.527l.565-3.29.018-.104-.076-.074L2.312 6.41a.5.5 0 0 1 .277-.842l3.3-.66.117-.026.047-.106 1.5-3A.5.5 0 0 1 8 1.5z"/>
              </svg>
              {promptOpen ? 'Hide Claude Prompt' : summary.failed > 0 ? `Ask Claude to Fix ${summary.failed} Issue${summary.failed > 1 ? 's' : ''}` : 'Ask Claude to Review'}
            </button>
          </div>
        )}

        {/* Prompt panel */}
        {promptOpen && generatedPrompt && (
          <div className="mt-4 rounded-xl border border-violet-200 bg-violet-50 overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-violet-200 bg-violet-100/60">
              <div className="flex items-center gap-2">
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4 text-violet-600 flex-shrink-0">
                  <path d="M8 1.5a.5.5 0 0 1 .447.276l1.5 3 .047.106.117.026 3.3.66a.5.5 0 0 1 .277.842l-2.39 2.33-.076.074.018.104.565 3.29a.5.5 0 0 1-.726.527L8 11.202l-.08.042-2.949 1.533a.5.5 0 0 1-.726-.527l.565-3.29.018-.104-.076-.074L2.312 6.41a.5.5 0 0 1 .277-.842l3.3-.66.117-.026.047-.106 1.5-3A.5.5 0 0 1 8 1.5z"/>
                </svg>
                <span className="text-sm font-semibold text-violet-800">Claude Prompt — paste this into a new Claude conversation</span>
              </div>
              <button
                onClick={copyPrompt}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all ${
                  promptCopied
                    ? 'bg-green-600 text-white border-green-600'
                    : 'bg-white text-violet-700 border-violet-300 hover:bg-violet-50'
                }`}
              >
                {promptCopied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                {promptCopied ? 'Copied!' : 'Copy to Clipboard'}
              </button>
            </div>
            <textarea
              readOnly
              value={generatedPrompt}
              className="w-full bg-transparent text-xs font-mono text-violet-900 p-4 resize-none focus:outline-none leading-relaxed"
              rows={18}
              onClick={e => e.target.select()}
            />
          </div>
        )}

        {/* Error state */}
        {error && (
          <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
            <p className="text-sm text-red-700">{error}</p>
          </div>
        )}
      </div>

      {/* Running state */}
      {running && (
        <div className="bg-white rounded-2xl border border-gray-200 p-8 flex flex-col items-center gap-4">
          <div className="w-14 h-14 rounded-full bg-gray-900 flex items-center justify-center">
            <RefreshCw className="w-7 h-7 text-white animate-spin" />
          </div>
          <div className="text-center">
            <p className="font-semibold text-gray-900">Running security checks…</p>
            <p className="text-sm text-gray-500 mt-1">Creating test users, running all {35}+ checks, cleaning up. Takes ~20 seconds.</p>
          </div>
          <div className="flex gap-1.5 mt-1">
            {[0,1,2].map(i => (
              <div key={i} className="w-2 h-2 rounded-full bg-gray-400" style={{ animation: `bounce 1s ease-in-out ${i * 0.2}s infinite` }} />
            ))}
          </div>
          <style>{`@keyframes bounce { 0%,80%,100%{transform:scale(0.6);opacity:.4} 40%{transform:scale(1);opacity:1} }`}</style>
        </div>
      )}

      {/* Results */}
      {!running && results && allSuites.map(suite => {
        const tests      = grouped[suite] || []
        const suiteFail  = tests.filter(t => !t.ok).length
        const suitePass  = tests.filter(t => t.ok).length
        const isExpanded = expanded[suite] ?? (suiteFail > 0)

        return (
          <div key={suite} className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
            {/* Suite header */}
            <button
              onClick={() => setExpanded(e => ({ ...e, [suite]: !isExpanded }))}
              className="w-full flex items-center gap-3 p-5 hover:bg-gray-50 transition-colors text-left"
            >
              <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${suiteFail > 0 ? 'bg-red-100' : 'bg-green-100'}`}>
                {suiteFail > 0
                  ? <XCircle className="w-4 h-4 text-red-600" />
                  : <CheckCircle2 className="w-4 h-4 text-green-600" />
                }
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-gray-900 text-sm">{suite}</p>
                {SUITE_DESCRIPTIONS[suite] && (
                  <p className="text-xs text-gray-400 mt-0.5 truncate">{SUITE_DESCRIPTIONS[suite]}</p>
                )}
              </div>
              <div className="flex items-center gap-3 flex-shrink-0">
                <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${suiteFail > 0 ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'}`}>
                  {suitePass}/{tests.length}
                </span>
                <ChevronRight className={`w-4 h-4 text-gray-400 transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
              </div>
            </button>

            {/* Individual tests */}
            {isExpanded && (
              <div className="border-t border-gray-100 divide-y divide-gray-50">
                {tests.map((test, idx) => (
                  <div key={idx} className={`flex items-start gap-3 px-5 py-3.5 ${test.ok ? '' : 'bg-red-50/50'}`}>
                    <div className="flex-shrink-0 mt-0.5">
                      {test.ok
                        ? <CheckCircle2 className="w-4 h-4 text-green-500" />
                        : <XCircle className="w-4 h-4 text-red-500" />
                      }
                    </div>
                    <div className="min-w-0">
                      <p className={`text-sm font-medium ${test.ok ? 'text-gray-700' : 'text-red-800'}`}>{test.name}</p>
                      {!test.ok && test.reason && (
                        <p className="text-xs text-red-600 mt-1 font-mono break-all">{test.reason}</p>
                      )}
                    </div>
                    <span className={`ml-auto flex-shrink-0 text-xs font-semibold px-2 py-0.5 rounded-full ${test.ok ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                      {test.ok ? 'PASS' : 'FAIL'}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })}

      {/* Never-run state */}
      {!running && !results && !error && (
        <div className="bg-white rounded-2xl border border-gray-200 border-dashed p-12 flex flex-col items-center gap-3 text-center">
          <ShieldCheck className="w-10 h-10 text-gray-300" />
          <p className="font-medium text-gray-500">No audit results yet</p>
          <p className="text-sm text-gray-400 max-w-sm">Click "Run Security Audit" to test authentication, RLS isolation, JWT attacks, and more against the live app.</p>
        </div>
      )}
    </div>
  )
}

// ── Elections Admin Tab — replaced by ElectionResultsAdmin (imported above) ──
// keeping this stub so git blame is clear
function _ElectionsAdminTab_REMOVED({ showToast }) {
  const [pollerLog, setPollerLog]       = useState([])
  const [logLoading, setLogLoading]     = useState(true)
  const [syncRunning, setSyncRunning]   = useState(false)
  const [contests, setContests]         = useState([])
  const [statsLoading, setStatsLoading] = useState(true)

  useEffect(() => { loadData() }, [])

  async function loadData() {
    setLogLoading(true)
    setStatsLoading(true)

    // Poller health log
    const { data: log } = await supabase
      .from('election_poller_log')
      .select('*')
      .order('ran_at', { ascending: false })
      .limit(20)
    setPollerLog(log || [])
    setLogLoading(false)

    // Recent contest count
    const { data: recentContests } = await supabase
      .from('election_contests')
      .select('id, office, office_type, precincts_rptg, precincts_total, updated_at')
      .order('updated_at', { ascending: false })
      .limit(50)
    setContests(recentContests || [])
    setStatsLoading(false)
  }

  async function runSync() {
    setSyncRunning(true)
    try {
      const res  = await fetch('/.netlify/functions/election-results-poller?force=true', { method: 'POST' })
      const data = await res.json()
      if (data.error) {
        showToast('Sync error: ' + data.error, 'error')
      } else if (data.skipped) {
        showToast('Poller skipped — no active elections found', 'info')
      } else {
        showToast(`Synced ${data.contests_synced || 0} contests, ${data.results_upserted || 0} results`, 'success')
      }
      await loadData()
    } catch (err) {
      showToast('Sync failed: ' + err.message, 'error')
    }
    setSyncRunning(false)
  }

  const lastRun     = pollerLog[0]
  const lastSuccess = pollerLog.find(r => !r.error)
  const minutesAgo  = lastRun ? Math.round((Date.now() - new Date(lastRun.ran_at)) / 60000) : null
  const isStale     = minutesAgo !== null && minutesAgo > 10  // warn if no run in 10+ min

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-gray-900 flex items-center gap-2">
            <BarChart2 className="w-5 h-5 text-brand-red" />
            Election Results System
          </h2>
          <p className="text-sm text-gray-500 mt-1">WEC poller health, contest sync status, and live results management</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={runSync}
            disabled={syncRunning}
            className="btn-primary flex items-center gap-1.5 text-sm py-2"
          >
            <RefreshCw className={`w-4 h-4 ${syncRunning ? 'animate-spin' : ''}`} />
            {syncRunning ? 'Syncing…' : 'Force Sync WEC'}
          </button>
          <Link to="/elections?tab=results" className="btn-secondary flex items-center gap-1.5 text-sm py-2">
            <Radio className="w-4 h-4" />
            View Live Board
          </Link>
        </div>
      </div>

      {/* Poller health */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className={`rounded-xl border-2 p-4 ${isStale ? 'border-amber-300 bg-amber-50' : 'border-green-200 bg-green-50'}`}>
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Last Run</p>
          {lastRun ? (
            <>
              <p className={`text-lg font-bold ${isStale ? 'text-amber-700' : 'text-green-700'}`}>
                {minutesAgo === 0 ? 'Just now' : `${minutesAgo}m ago`}
              </p>
              <p className="text-xs text-gray-500">{new Date(lastRun.ran_at).toLocaleTimeString()}</p>
              {lastRun.error && (
                <p className="text-xs text-red-600 mt-1 font-medium">Error: {lastRun.error}</p>
              )}
            </>
          ) : (
            <p className="text-lg font-bold text-gray-400">Never</p>
          )}
        </div>

        <div className="rounded-xl border-2 border-gray-200 bg-white p-4">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Last Success</p>
          {lastSuccess ? (
            <>
              <p className="text-lg font-bold text-gray-900">
                {lastSuccess.contests_synced} races
              </p>
              <p className="text-xs text-gray-500">{lastSuccess.results_upserted} results upserted</p>
            </>
          ) : (
            <p className="text-lg font-bold text-gray-400">None yet</p>
          )}
        </div>

        <div className="rounded-xl border-2 border-gray-200 bg-white p-4">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Live Contests</p>
          <p className="text-lg font-bold text-gray-900">{contests.length}</p>
          <p className="text-xs text-gray-500">in election_contests table</p>
        </div>
      </div>

      {/* Poller log table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-2">
          <Clock className="w-4 h-4 text-gray-400" />
          <h3 className="text-sm font-bold text-gray-900">Poller Log (last 20 runs)</h3>
        </div>
        {logLoading ? (
          <div className="flex justify-center py-8">
            <div className="w-6 h-6 border-3 border-brand-red border-t-transparent rounded-full animate-spin" />
          </div>
        ) : pollerLog.length === 0 ? (
          <p className="text-center text-sm text-gray-400 py-8">
            No runs yet. The poller runs every 2 minutes during election windows, or click "Force Sync WEC" above.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="text-left text-xs font-semibold text-gray-500 px-4 py-2">Time</th>
                  <th className="text-left text-xs font-semibold text-gray-500 px-4 py-2">Election Date</th>
                  <th className="text-right text-xs font-semibold text-gray-500 px-4 py-2">Contests</th>
                  <th className="text-right text-xs font-semibold text-gray-500 px-4 py-2">Results</th>
                  <th className="text-right text-xs font-semibold text-gray-500 px-4 py-2">Duration</th>
                  <th className="text-left text-xs font-semibold text-gray-500 px-4 py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {pollerLog.map(row => (
                  <tr key={row.id} className="border-b border-gray-50 hover:bg-gray-50">
                    <td className="px-4 py-2 text-xs text-gray-600 tabular-nums">
                      {new Date(row.ran_at).toLocaleString()}
                    </td>
                    <td className="px-4 py-2 text-xs text-gray-600">{row.election_date || '—'}</td>
                    <td className="px-4 py-2 text-xs text-gray-900 text-right tabular-nums">{row.contests_synced}</td>
                    <td className="px-4 py-2 text-xs text-gray-900 text-right tabular-nums">{row.results_upserted}</td>
                    <td className="px-4 py-2 text-xs text-gray-500 text-right tabular-nums">{row.duration_ms}ms</td>
                    <td className="px-4 py-2">
                      {row.error ? (
                        <span className="inline-flex items-center gap-1 text-xs text-red-600 font-medium">
                          <XCircle className="w-3 h-3" /> {row.error.slice(0, 40)}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-xs text-green-600 font-medium">
                          <CheckCircle2 className="w-3 h-3" /> OK
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Recent contests */}
      {contests.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-2">
            <CalendarDays className="w-4 h-4 text-gray-400" />
            <h3 className="text-sm font-bold text-gray-900">Recent Contests ({contests.length})</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="text-left text-xs font-semibold text-gray-500 px-4 py-2">Office</th>
                  <th className="text-left text-xs font-semibold text-gray-500 px-4 py-2">Type</th>
                  <th className="text-right text-xs font-semibold text-gray-500 px-4 py-2">Precincts</th>
                  <th className="text-left text-xs font-semibold text-gray-500 px-4 py-2">Last Updated</th>
                </tr>
              </thead>
              <tbody>
                {contests.slice(0, 20).map(c => (
                  <tr key={c.id} className="border-b border-gray-50 hover:bg-gray-50">
                    <td className="px-4 py-2 text-xs text-gray-900 font-medium">{c.office}</td>
                    <td className="px-4 py-2 text-xs text-gray-500">{c.office_type || '—'}</td>
                    <td className="px-4 py-2 text-xs text-gray-600 text-right tabular-nums">
                      {c.precincts_rptg}/{c.precincts_total}
                    </td>
                    <td className="px-4 py-2 text-xs text-gray-400">
                      {new Date(c.updated_at).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

// Spinner Component
const Spinner = () => (
  <div className="flex justify-center py-12">
    <div className="animate-spin rounded-full h-12 w-12 border-4 border-gray-200 border-t-red-700"></div>
  </div>
)

// ─── Coupons Tab ──────────────────────────────────────────────────────────────
const CouponsTab = ({ session, showToast }) => {
  const DURATION_OPTS = [
    { value: 'once',       label: 'Once (applies to first payment only)' },
    { value: 'repeating',  label: 'Repeating (applies for N months)' },
    { value: 'forever',    label: 'Forever (applies to all payments)' },
  ]

  const defaultForm = {
    discountType:   'free',
    percentOff:     '',
    amountOff:      '',
    code:           '',
    maxRedemptions: '',
    expiresAt:      '',
    duration:       'forever',
    durationMonths: '3',
    name:           '',
  }

  const [form, setForm]                 = useState(defaultForm)
  const [creating, setCreating]         = useState(false)
  const [lastCreated, setLastCreated]   = useState(null)
  const [promoCodes, setPromoCodes]     = useState([])
  const [loadingList, setLoadingList]   = useState(true)
  const [deactivating, setDeactivating] = useState(null)
  const [copiedId, setCopiedId]         = useState(null)

  const f = (key) => (e) => setForm(prev => ({ ...prev, [key]: e.target.value }))

  const couponCall = async (body) => {
    const res = await fetch('/.netlify/functions/manage-coupons', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
      body:    JSON.stringify(body),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
      throw new Error(err.error || `HTTP ${res.status}`)
    }
    return res.json()
  }

  const loadCodes = async () => {
    setLoadingList(true)
    try {
      const json = await couponCall({ action: 'list' })
      setPromoCodes(json.promoCodes || [])
    } catch (err) {
      console.error('Failed to load promo codes:', err)
      showToast('Failed to load promo codes', 'error')
    } finally {
      setLoadingList(false)
    }
  }

  useEffect(() => { loadCodes() }, [])

  const handleCreate = async (e) => {
    e.preventDefault()
    setCreating(true)
    setLastCreated(null)
    try {
      const json = await couponCall({
        action:         'create',
        discountType:   form.discountType,
        percentOff:     Number(form.percentOff) || 0,
        amountOff:      Number(form.amountOff)  || 0,
        code:           form.code,
        maxRedemptions: form.maxRedemptions ? Number(form.maxRedemptions) : null,
        expiresAt:      form.expiresAt || null,
        duration:       form.duration,
        durationMonths: Number(form.durationMonths) || 3,
        name:           form.name,
      })
      if (json.success) {
        setLastCreated(json)
        setForm(defaultForm)
        showToast(`Created promo code ${json.code}`, 'success')
        loadCodes()
      } else {
        showToast(json.error || 'Failed to create coupon', 'error')
      }
    } catch (err) {
      console.error('Failed to create promo code:', err)
      showToast('Network error — could not create promo code', 'error')
    } finally {
      setCreating(false)
    }
  }

  const handleDeactivate = async (pc) => {
    if (!window.confirm(`Deactivate code "${pc.code}"? This cannot be undone.`)) return
    setDeactivating(pc.id)
    try {
      const json = await couponCall({ action: 'deactivate', id: pc.id })
      if (json.success) {
        showToast(`Code ${pc.code} deactivated`, 'success')
        loadCodes()
      } else {
        showToast(json.error || 'Failed to deactivate', 'error')
      }
    } catch (err) {
      console.error('Failed to deactivate promo code:', err)
      showToast('Network error — could not deactivate code', 'error')
    } finally {
      setDeactivating(null)
    }
  }

  const copyCode = (code, id) => {
    navigator.clipboard.writeText(code).then(() => {
      setCopiedId(id)
      setTimeout(() => setCopiedId(null), 1500)
    })
  }

  const discountLabel = (pc) => {
    if (pc.discountType === 'percent' && pc.percentOff === 100) return '100% off (free)'
    if (pc.discountType === 'percent' && pc.percentOff != null) return `${pc.percentOff}% off`
    if (pc.discountType === 'amount' && pc.amountOff != null) return `$${Number(pc.amountOff).toFixed(2)} off`
    return 'Custom discount'
  }

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-xl font-bold text-gray-900 flex items-center gap-2 mb-1">
          <Gift className="w-5 h-5 text-brand-red" /> Coupon &amp; Promo Code Generator
        </h2>
        <p className="text-sm text-gray-500">
          Generate Stripe promo codes to give customers free or discounted access.
          Codes work with the Stripe checkout on the <strong>Pricing</strong> page.
        </p>
      </div>

      {/* ── Create Form ──────────────────────────────────────────────────────── */}
      <div className="bg-white border border-gray-200 rounded-2xl p-6 shadow-sm">
        <h3 className="font-semibold text-gray-900 mb-5 flex items-center gap-2">
          <Plus className="w-4 h-4" /> Generate New Code
        </h3>

        <form onSubmit={handleCreate} className="space-y-5">
          {/* Discount type selector */}
          <div>
            <label className="text-xs font-semibold text-gray-500 uppercase tracking-wider block mb-2">
              Discount Type
            </label>
            <div className="flex gap-3 flex-wrap">
              {[
                { value: 'free',    icon: Gift,       label: '100% Free',    desc: 'Full access, no charge' },
                { value: 'percent', icon: Percent,    label: 'Percent Off',  desc: 'e.g. 50% off' },
                { value: 'amount',  icon: DollarSign, label: 'Dollar Off',   desc: 'e.g. $20 off' },
              ].map(({ value, icon: Icon, label, desc }) => (
                <label
                  key={value}
                  className={`flex items-start gap-3 p-3.5 rounded-xl border-2 cursor-pointer transition-all flex-1 min-w-[140px] ${
                    form.discountType === value
                      ? 'border-brand-red bg-brand-red/5'
                      : 'border-gray-200 hover:border-gray-300'
                  }`}
                >
                  <input
                    type="radio" name="discountType" value={value}
                    checked={form.discountType === value}
                    onChange={f('discountType')} className="mt-0.5 accent-red-600"
                  />
                  <div>
                    <p className="text-sm font-semibold text-gray-900 flex items-center gap-1.5">
                      <Icon className="w-3.5 h-3.5 text-brand-red" /> {label}
                    </p>
                    <p className="text-xs text-gray-500 mt-0.5">{desc}</p>
                  </div>
                </label>
              ))}
            </div>
          </div>

          {/* Percent / amount inputs */}
          {form.discountType === 'percent' && (
            <div>
              <label className="text-xs font-semibold text-gray-500 uppercase tracking-wider block mb-1.5">
                Percent Off
              </label>
              <div className="relative w-40">
                <input
                  type="number" min="1" max="99" required
                  value={form.percentOff} onChange={f('percentOff')}
                  placeholder="e.g. 50"
                  className="input-field pr-8"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">%</span>
              </div>
            </div>
          )}
          {form.discountType === 'amount' && (
            <div>
              <label className="text-xs font-semibold text-gray-500 uppercase tracking-wider block mb-1.5">
                Amount Off (USD)
              </label>
              <div className="relative w-40">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">$</span>
                <input
                  type="number" min="0.01" step="0.01" required
                  value={form.amountOff} onChange={f('amountOff')}
                  placeholder="e.g. 20.00"
                  className="input-field pl-7"
                />
              </div>
            </div>
          )}

          {/* Duration */}
          <div>
            <label className="text-xs font-semibold text-gray-500 uppercase tracking-wider block mb-1.5">
              Duration
            </label>
            <select value={form.duration} onChange={f('duration')} className="input-field w-full max-w-sm">
              {DURATION_OPTS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            {form.duration === 'repeating' && (
              <div className="mt-2 flex items-center gap-2">
                <input
                  type="number" min="1" max="24"
                  value={form.durationMonths} onChange={f('durationMonths')}
                  className="input-field w-20"
                />
                <span className="text-sm text-gray-500">months</span>
              </div>
            )}
          </div>

          {/* Code + settings row */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <div>
              <label className="text-xs font-semibold text-gray-500 uppercase tracking-wider block mb-1.5">
                Promo Code <span className="font-normal text-gray-400">(leave blank to auto-generate)</span>
              </label>
              <input
                type="text" value={form.code} onChange={f('code')}
                placeholder="e.g. LAUNCH50"
                className="input-field w-full uppercase"
                style={{ textTransform: 'uppercase' }}
              />
            </div>
            <div>
              <label className="text-xs font-semibold text-gray-500 uppercase tracking-wider block mb-1.5">
                Max Redemptions <span className="font-normal text-gray-400">(leave blank = unlimited)</span>
              </label>
              <input
                type="number" min="1" value={form.maxRedemptions} onChange={f('maxRedemptions')}
                placeholder="e.g. 10"
                className="input-field w-full"
              />
            </div>
            <div>
              <label className="text-xs font-semibold text-gray-500 uppercase tracking-wider block mb-1.5">
                Expiry Date <span className="font-normal text-gray-400">(optional)</span>
              </label>
              <input
                type="date" value={form.expiresAt} onChange={f('expiresAt')}
                min={new Date().toISOString().split('T')[0]}
                className="input-field w-full"
              />
            </div>
          </div>

          {/* Internal name */}
          <div>
            <label className="text-xs font-semibold text-gray-500 uppercase tracking-wider block mb-1.5">
              Internal Name / Note <span className="font-normal text-gray-400">(for your records)</span>
            </label>
            <input
              type="text" value={form.name} onChange={f('name')}
              placeholder="e.g. Free trial for demo call on 5/20"
              className="input-field w-full max-w-md"
            />
          </div>

          <button
            type="submit" disabled={creating}
            className="btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {creating ? (
              <><div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> Generating...</>
            ) : (
              <><Gift className="w-4 h-4" /> Generate Promo Code</>
            )}
          </button>
        </form>

        {/* Success result */}
        {lastCreated && (
          <div className="mt-5 bg-emerald-50 border border-emerald-200 rounded-xl p-5">
            <p className="text-sm font-semibold text-emerald-800 mb-3 flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4" /> Promo code created successfully!
            </p>
            <div className="flex items-center gap-3 mb-3">
              <span className="text-3xl font-black text-emerald-900 tracking-widest font-mono">
                {lastCreated.code}
              </span>
              <button
                onClick={() => copyCode(lastCreated.code, 'last')}
                className="flex items-center gap-1.5 text-xs font-semibold text-emerald-700 hover:text-emerald-900 bg-emerald-100 hover:bg-emerald-200 px-3 py-1.5 rounded-lg transition-colors"
              >
                {copiedId === 'last' ? <><Check className="w-3.5 h-3.5" /> Copied!</> : <><Copy className="w-3.5 h-3.5" /> Copy</>}
              </button>
            </div>
            <div className="flex flex-wrap gap-4 text-xs text-emerald-700">
              <span>Discount: <strong>{lastCreated.discountLabel}</strong></span>
              <span>Duration: <strong>{lastCreated.duration}</strong></span>
              {lastCreated.maxRedemptions && <span>Max uses: <strong>{lastCreated.maxRedemptions}</strong></span>}
              {lastCreated.expiresAt && <span>Expires: <strong>{new Date(lastCreated.expiresAt).toLocaleDateString()}</strong></span>}
            </div>
          </div>
        )}
      </div>

      {/* ── Existing Codes ───────────────────────────────────────────────────── */}
      <div className="bg-white border border-gray-200 rounded-2xl p-6 shadow-sm">
        <div className="flex items-center justify-between mb-5">
          <h3 className="font-semibold text-gray-900 flex items-center gap-2">
            <Tag className="w-4 h-4 text-brand-red" /> All Promo Codes
            <span className="text-xs font-normal text-gray-400">({promoCodes.length})</span>
          </h3>
          <button
            onClick={loadCodes}
            className="flex items-center gap-1.5 text-xs font-semibold text-gray-600 hover:text-gray-900 bg-gray-100 hover:bg-gray-200 px-3 py-1.5 rounded-lg transition-colors"
          >
            <RefreshCw className="w-3.5 h-3.5" /> Refresh
          </button>
        </div>

        {loadingList ? (
          <div className="flex items-center justify-center py-10">
            <div className="animate-spin rounded-full h-8 w-8 border-4 border-gray-200 border-t-red-700" />
          </div>
        ) : promoCodes.length === 0 ? (
          <div className="text-center py-10 text-gray-400">
            <Gift className="w-10 h-10 mx-auto mb-2 opacity-40" />
            <p className="text-sm">No promo codes yet. Generate your first one above.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wider border-b border-gray-100">
                  <th className="pb-3 pr-4">Code</th>
                  <th className="pb-3 pr-4">Discount</th>
                  <th className="pb-3 pr-4">Duration</th>
                  <th className="pb-3 pr-4">Uses</th>
                  <th className="pb-3 pr-4">Expires</th>
                  <th className="pb-3 pr-4">Status</th>
                  <th className="pb-3">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {promoCodes.map(pc => (
                  <tr key={pc.id} className={`${!pc.active ? 'opacity-50' : ''}`}>
                    <td className="py-3 pr-4">
                      <div className="flex items-center gap-2">
                        <span className="font-mono font-bold text-gray-900 text-sm tracking-wider">
                          {pc.code}
                        </span>
                        <button
                          onClick={() => copyCode(pc.code, pc.id)}
                          title="Copy code"
                          className="text-gray-400 hover:text-gray-700 transition-colors"
                        >
                          {copiedId === pc.id
                            ? <Check className="w-3.5 h-3.5 text-emerald-500" />
                            : <Copy className="w-3.5 h-3.5" />
                          }
                        </button>
                      </div>
                      {pc.couponName && pc.couponName !== pc.couponId && (
                        <p className="text-xs text-gray-400 mt-0.5">{pc.couponName}</p>
                      )}
                    </td>
                    <td className="py-3 pr-4">
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
                        {discountLabel(pc)}
                      </span>
                    </td>
                    <td className="py-3 pr-4 text-gray-600 capitalize">
                      {pc.duration}
                    </td>
                    <td className="py-3 pr-4 text-gray-600">
                      {pc.timesRedeemed}
                      {pc.maxRedemptions ? ` / ${pc.maxRedemptions}` : ' / ∞'}
                    </td>
                    <td className="py-3 pr-4 text-gray-600 text-xs">
                      {pc.expiresAt
                        ? new Date(pc.expiresAt).toLocaleDateString()
                        : <span className="text-gray-400">Never</span>
                      }
                    </td>
                    <td className="py-3 pr-4">
                      {pc.active ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-green-50 text-green-700 border border-green-200">
                          <span className="w-1.5 h-1.5 bg-green-500 rounded-full" /> Active
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-gray-100 text-gray-500 border border-gray-200">
                          Inactive
                        </span>
                      )}
                    </td>
                    <td className="py-3">
                      {pc.active && (
                        <button
                          onClick={() => handleDeactivate(pc)}
                          disabled={deactivating === pc.id}
                          className="flex items-center gap-1 text-xs text-red-600 hover:text-red-800 font-medium disabled:opacity-50 transition-colors"
                        >
                          {deactivating === pc.id
                            ? <div className="w-3.5 h-3.5 border-2 border-red-300 border-t-red-600 rounded-full animate-spin" />
                            : <X className="w-3.5 h-3.5" />
                          }
                          Deactivate
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="text-xs text-gray-400 mt-4 flex items-center gap-1.5">
          <ExternalLink className="w-3 h-3" />
          Manage all coupons in{' '}
          <a href="https://dashboard.stripe.com/promotion-codes" target="_blank" rel="noopener noreferrer" className="underline hover:text-gray-600">
            Stripe Dashboard → Coupons
          </a>
        </p>
      </div>
    </div>
  )
}

export default AdminDashboard
