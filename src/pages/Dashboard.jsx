import React, { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { format, differenceInCalendarDays, isPast, isFuture, parseISO } from 'date-fns'
import {
  Building2, CalendarDays, Users, FileText, ListChecks,
  TrendingUp, Clock, ChevronRight, AlertCircle, Star
} from 'lucide-react'
import { supabase } from '../lib/supabase'
import LoadingBar from '../components/LoadingBar'

const StatCard = ({ icon: Icon, label, value, sub, color, to }) => (
  <Link to={to} className="card hover:shadow-md transition-shadow group">
    <div className="flex items-start justify-between">
      <div>
        <p className="text-sm text-gray-500 font-medium">{label}</p>
        <p className="text-3xl font-bold text-gray-900 mt-1">{value ?? '—'}</p>
        {sub && <p className="text-xs text-gray-400 mt-1">{sub}</p>}
      </div>
      <div className={`w-11 h-11 rounded-xl flex items-center justify-center ${color}`}>
        <Icon className="w-5 h-5 text-white" />
      </div>
    </div>
    <div className="flex items-center gap-1 mt-4 text-xs font-medium text-gray-400 group-hover:text-brand-red transition-colors">
      View all <ChevronRight className="w-3 h-3" />
    </div>
  </Link>
)

const ElectionCard = ({ election }) => {
  const daysUntil = differenceInCalendarDays(parseISO(election.election_date), new Date())
  const isPastElection = isPast(parseISO(election.election_date))

  const typeColors = {
    primary:        'bg-orange-100 text-orange-700',
    general:        'bg-blue-100 text-blue-700',
    spring_primary: 'bg-purple-100 text-purple-700',
    spring_general: 'bg-green-100 text-green-700',
    special:        'bg-yellow-100 text-yellow-700',
  }

  const typeLabels = {
    primary:        'Partisan Primary',
    general:        'General Election',
    spring_primary: 'Spring Primary',
    spring_general: 'Spring General',
    special:        'Special Election',
  }

  return (
    <div className={`flex items-center gap-4 p-3 rounded-lg border ${isPastElection ? 'opacity-50 border-gray-100' : 'border-gray-200 hover:bg-gray-50'} transition-colors`}>
      <div className="text-center min-w-[52px]">
        <p className="text-xs text-gray-400 font-medium">{format(parseISO(election.election_date), 'MMM')}</p>
        <p className="text-xl font-bold text-gray-900 leading-tight">{format(parseISO(election.election_date), 'd')}</p>
        <p className="text-xs text-gray-400">{format(parseISO(election.election_date), 'yyyy')}</p>
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-gray-900 truncate">{election.name}</p>
        <div className="flex items-center gap-2 mt-1">
          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${typeColors[election.type] || 'bg-gray-100 text-gray-600'}`}>
            {typeLabels[election.type] || election.type}
          </span>
          {!isPastElection && (
            <span className={`text-xs font-medium ${daysUntil <= 30 ? 'text-brand-red' : 'text-gray-400'}`}>
              {daysUntil === 0 ? 'Today!' : daysUntil < 0 ? 'Past' : `${daysUntil}d away`}
            </span>
          )}
        </div>
        {election.filing_deadline && !isPastElection && (
          <p className="text-xs text-gray-400 mt-1">
            Filing: {format(parseISO(election.filing_deadline), 'MMM d, yyyy')}
          </p>
        )}
      </div>
    </div>
  )
}

export default function Dashboard() {
  const [stats, setStats]         = useState({})
  const [elections, setElections] = useState([])
  const [recent, setRecent]       = useState([])
  const [loading, setLoading]     = useState(true)

  useEffect(() => {
    fetchDashboardData()
  }, [])

  const fetchDashboardData = async () => {
    setLoading(true)
    try {
      const [electionsRes, candidatesRes, dossiersRes, prospectsRes] = await Promise.all([
        supabase.from('elections').select('*').gte('election_date', new Date().toISOString().slice(0, 10)).order('election_date').limit(8),
        supabase.from('candidates').select('id, party, status', { count: 'exact' }),
        supabase.from('dossiers').select('id', { count: 'exact', head: true }),
        supabase.from('prospecting_lists').select('id', { count: 'exact', head: true }),
      ])

      // offices table may not exist yet — query separately so it can't break the page
      let officesCount = 0
      try {
        const officesRes = await supabase.from('offices').select('id', { count: 'exact', head: true })
        officesCount = officesRes.count || 0
      } catch { /* table not yet created */ }

      const candidates = candidatesRes.data || []
      const partyBreakdown = candidates.reduce((acc, c) => {
        acc[c.party] = (acc[c.party] || 0) + 1
        return acc
      }, {})

      setStats({
        offices:      officesCount,
        candidates:   candidatesRes.count || 0,
        dossiers:     dossiersRes.count || 0,
        prospects:    prospectsRes.count || 0,
        republicans:  partyBreakdown['Republican'] || 0,
        democrats:    partyBreakdown['Democrat'] || 0,
      })

      setElections(electionsRes.data || [])

      // Recent candidates — omit the offices join since that table may not exist yet
      const recentCandidates = await supabase
        .from('candidates')
        .select('id, name, party, status, created_at')
        .order('created_at', { ascending: false })
        .limit(6)
      setRecent(recentCandidates.data || [])
    } catch (err) {
      console.error('[Dashboard] fetchDashboardData error:', err)
    } finally {
      setLoading(false)
    }
  }

  const partyBadge = (party) => {
    const map = {
      Republican:  'badge-republican',
      Democrat:    'badge-democrat',
      Independent: 'badge-independent',
      Nonpartisan: 'badge-nonpartisan',
    }
    return map[party] || 'badge-independent'
  }

  const statusBadge = (status) => {
    const map = {
      exploring:       'bg-gray-100 text-gray-600',
      declared:        'bg-blue-100 text-blue-700',
      primary_winner:  'bg-purple-100 text-purple-700',
      general:         'bg-yellow-100 text-yellow-700',
      elected:         'bg-green-100 text-green-700',
      lost:            'bg-red-100 text-red-600',
      withdrawn:       'bg-gray-100 text-gray-500',
    }
    return map[status] || 'bg-gray-100 text-gray-600'
  }

  const upcomingElections = elections.filter(e => isFuture(parseISO(e.election_date)))
  const nextElection = upcomingElections[0]

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-3 border-brand-red border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Intelligence Dashboard</h1>
          <p className="text-gray-500 text-sm mt-1">Wisconsin Statewide Political Tracking — {format(new Date(), 'MMMM d, yyyy')}</p>
        </div>
        {nextElection && (
          <div className="hidden sm:flex items-center gap-2 px-4 py-2 bg-brand-red/10 border border-brand-red/20 rounded-lg">
            <AlertCircle className="w-4 h-4 text-brand-red flex-shrink-0" />
            <div>
              <p className="text-xs font-semibold text-brand-red">Next Election</p>
              <p className="text-xs text-brand-red/80">{nextElection.name} · {format(parseISO(nextElection.election_date), 'MMM d, yyyy')}</p>
            </div>
          </div>
        )}
      </div>

      {/* Stat Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard icon={Building2}    label="Total Offices"     value={stats.offices}    sub="Tracked statewide"     color="bg-brand-navy"    to="/offices" />
        <StatCard icon={Users}        label="Candidates"        value={stats.candidates} sub={`${stats.republicans} R · ${stats.democrats} D`} color="bg-brand-red" to="/candidates" />
        <StatCard icon={FileText}     label="Profiles Built"    value={stats.dossiers}   sub="AI-generated profiles" color="bg-blue-600"       to="/dossiers" />
        <StatCard icon={ListChecks}   label="Prospect Lists"    value={stats.prospects}  sub="Outreach ready"        color="bg-emerald-600"   to="/prospecting" />
      </div>

      {/* Two-column layout */}
      <div className="grid lg:grid-cols-2 gap-6">
        {/* Upcoming Elections */}
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <CalendarDays className="w-5 h-5 text-brand-red" />
              <h2 className="text-base font-bold text-gray-900">Election Calendar</h2>
            </div>
            <Link to="/elections" className="text-xs text-brand-red font-medium hover:underline flex items-center gap-1">
              View all <ChevronRight className="w-3 h-3" />
            </Link>
          </div>
          <div className="space-y-2">
            {elections.length === 0 ? (
              <p className="text-sm text-gray-400 py-4 text-center">No elections found</p>
            ) : (
              elections.map(e => <ElectionCard key={e.id} election={e} />)
            )}
          </div>
        </div>

        {/* Recent Candidates */}
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Users className="w-5 h-5 text-brand-red" />
              <h2 className="text-base font-bold text-gray-900">Recent Candidates</h2>
            </div>
            <Link to="/candidates" className="text-xs text-brand-red font-medium hover:underline flex items-center gap-1">
              View all <ChevronRight className="w-3 h-3" />
            </Link>
          </div>
          {recent.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Users className="w-10 h-10 text-gray-200 mb-3" />
              <p className="text-sm font-medium text-gray-400">No candidates yet</p>
              <p className="text-xs text-gray-300 mt-1">Add candidates to see them here</p>
              <Link to="/candidates" className="btn-primary text-xs mt-4 px-4 py-2">
                Add First Candidate
              </Link>
            </div>
          ) : (
            <div className="space-y-3">
              {recent.map(c => (
                <Link key={c.id} to={`/candidates/${c.id}`} className="flex items-center gap-3 p-3 rounded-lg hover:bg-gray-50 transition-colors group">
                  <div className="w-8 h-8 bg-brand-red/10 rounded-full flex items-center justify-center flex-shrink-0 text-brand-red font-bold text-sm">
                    {c.name?.[0] || '?'}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-gray-900 group-hover:text-brand-red transition-colors truncate">{c.name}</p>
                    <p className="text-xs text-gray-400 truncate">
                      {c.office?.name}{c.office?.district_name ? ` · ${c.office.district_name}` : ''}
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    {c.party && <span className={partyBadge(c.party)}>{c.party[0]}</span>}
                    <span className={`text-xs px-2 py-0.5 rounded-full ${statusBadge(c.status)}`}>
                      {(c.status || '').replace('_', ' ')}
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Quick Action Bar */}
      <div className="card">
        <h2 className="text-sm font-bold text-gray-700 mb-4 flex items-center gap-2">
          <Star className="w-4 h-4 text-brand-red" /> Quick Actions
        </h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Link to="/candidates" className="flex flex-col items-center gap-2 p-4 rounded-xl border-2 border-dashed border-gray-200 hover:border-brand-red hover:bg-brand-red/5 transition-all group">
            <Users className="w-6 h-6 text-gray-300 group-hover:text-brand-red transition-colors" />
            <span className="text-xs font-medium text-gray-500 group-hover:text-brand-red text-center transition-colors">Add Candidate</span>
          </Link>
          <Link to="/prospecting" className="flex flex-col items-center gap-2 p-4 rounded-xl border-2 border-dashed border-gray-200 hover:border-brand-red hover:bg-brand-red/5 transition-all group">
            <ListChecks className="w-6 h-6 text-gray-300 group-hover:text-brand-red transition-colors" />
            <span className="text-xs font-medium text-gray-500 group-hover:text-brand-red text-center transition-colors">Generate Prospect List</span>
          </Link>
          <Link to="/dossiers" className="flex flex-col items-center gap-2 p-4 rounded-xl border-2 border-dashed border-gray-200 hover:border-brand-red hover:bg-brand-red/5 transition-all group">
            <FileText className="w-6 h-6 text-gray-300 group-hover:text-brand-red transition-colors" />
            <span className="text-xs font-medium text-gray-500 group-hover:text-brand-red text-center transition-colors">Build Profile</span>
          </Link>
          <Link to="/elections" className="flex flex-col items-center gap-2 p-4 rounded-xl border-2 border-dashed border-gray-200 hover:border-brand-red hover:bg-brand-red/5 transition-all group">
            <CalendarDays className="w-6 h-6 text-gray-300 group-hover:text-brand-red transition-colors" />
            <span className="text-xs font-medium text-gray-500 group-hover:text-brand-red text-center transition-colors">View Calendar</span>
          </Link>
        </div>
      </div>
    </div>
  )
}
