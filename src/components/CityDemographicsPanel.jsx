// CityDemographicsPanel.jsx — compact side panel shown when a clicked
// municipality has a Census demographics entry. Visual language matches the
// inline DistrictPanel (300px absolutely-positioned panel inside the map
// container): same width/position/close button/z-index. See
// src/lib/placeDemographics.js for the shared data contract.
import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { X, Users, ChevronRight } from 'lucide-react'
import { loadPlaceDemographics, placeKey, fmtNum, fmtMoney, fmtPct, displayName, placePath } from '../lib/placeDemographics'
import { partyGroup } from '../lib/party'

/**
 * usePlaceLookup(info) — resolves a clicked municipal-district info object
 * ({ name, county, ctv, layerKey }) to a demographics place record.
 * Used by the map pages at the click seam to decide whether to render
 * CityDemographicsPanel or fall back to the plain DistrictPanel.
 *
 * Returns { loading, place } — place is null once loading is false and no
 * entry was found (small place / data file missing / 404). Never throws.
 */
export function usePlaceLookup(info) {
  const [state, setState] = useState({ loading: true, place: null })

  useEffect(() => {
    if (!info || info.layerKey !== 'municipal') { setState({ loading: false, place: null }); return }
    let alive = true
    setState({ loading: true, place: null })
    loadPlaceDemographics().then(data => {
      if (!alive) return
      const key = placeKey(info.county, info.name)
      const place = data?.places?.[key] || null
      setState({ loading: false, place })
    }).catch(() => { if (alive) setState({ loading: false, place: null }) })
    return () => { alive = false }
  }, [info?.layerKey, info?.county, info?.name])

  return state
}

// Keyed by partyGroup() so 'Democrat', 'Democratic' and 'DEM' share a dot color.
const PARTY_COLOR = {
  R: '#dc2626',
  D: '#2563eb',
  I: '#7c3aed',
  L: '#f97316',
  G: '#16a34a',
  N: '#6b7280',
}

const STAT_FIELDS = [
  { label: 'Population',         key: 'pop',                fmt: fmtNum },
  { label: 'Median age',         key: 'median_age',         fmt: v => (v == null ? '—' : v) },
  { label: 'Voting-age pop',     key: 'voting_age_pop',     fmt: fmtNum },
  { label: 'Median HH income',   key: 'median_hh_income',   fmt: fmtMoney },
  { label: 'Home ownership',     key: 'ownership_pct',      fmt: fmtPct },
  { label: 'Median home value',  key: 'median_home_value',  fmt: fmtMoney },
  { label: "Bachelor's+",        key: 'bachelors_plus_pct', fmt: fmtPct },
  { label: 'Poverty rate',       key: 'poverty_pct',        fmt: fmtPct },
  { label: 'Veterans',           key: 'veterans',           fmt: fmtNum },
]

/**
 * props:
 *  - place: the demographics record (from wi-place-demographics.json .places[key])
 *  - loading: true while the demographics JSON is still being fetched
 *  - onClose: () => void
 *  - panelOffices / allCandidates: optional pass-through for a "Tracked here" section
 */
export default function CityDemographicsPanel({ place, loading, onClose, panelOffices, allCandidates }) {
  const navigate = useNavigate()
  const [showTracked, setShowTracked] = React.useState(false)

  if (!place && !loading) return null

  const trackedCandidates = (panelOffices && panelOffices.length && allCandidates)
    ? (allCandidates || []).filter(c => (panelOffices || []).some(o => o.id === c.office_id))
    : []

  return (
    <div style={{
      position: 'absolute', left: 0, top: 0, bottom: 0, width: 'min(300px, 85vw)',
      zIndex: 2000, background: 'white',
      boxShadow: '4px 0 24px rgba(0,0,0,0.18)',
      display: 'flex', flexDirection: 'column',
      borderRadius: '12px 0 0 12px',
    }}>
      {/* Header */}
      <div style={{
        background: '#dcfce7', padding: '14px 16px',
        borderBottom: '1px solid rgba(0,0,0,0.07)',
        borderRadius: '12px 0 0 0',
        display: 'flex', alignItems: 'flex-start', gap: 10,
      }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1, color: '#14532d', marginBottom: 3 }}>
            {place
              ? [place.ctv ? place.ctv[0].toUpperCase() + place.ctv.slice(1) : 'Municipality', place.county ? `${place.county} County` : null].filter(Boolean).join(' · ')
              : 'Municipality'}
          </div>
          <div style={{ fontSize: 15, fontWeight: 800, color: '#111', lineHeight: 1.3 }}>
            {place ? displayName(place) : 'Loading…'}
          </div>
        </div>
        <button
          onClick={onClose}
          style={{ color: '#14532d', opacity: 0.6, flexShrink: 0, marginTop: 1, background: 'none', border: 'none', cursor: 'pointer', padding: 2 }}
          title="Close"
        >
          <X size={16} />
        </button>
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '14px 12px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          {STAT_FIELDS.map(({ label, key, fmt }) => (
            <div key={key} style={{
              background: '#F8FAFC', borderRadius: 10, padding: '8px 10px',
              borderLeft: '3px solid #E2E8F0',
            }}>
              <div style={{ fontSize: 9.5, color: '#94A3B8', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.03em' }}>
                {label}
              </div>
              {place ? (
                <div style={{ fontSize: 15, fontWeight: 800, color: '#0F172A', marginTop: 2, lineHeight: 1.25 }}>
                  {fmt(place[key])}
                </div>
              ) : (
                <div style={{ height: 15, marginTop: 4, width: '60%', borderRadius: 4, background: '#EEF2F6' }} />
              )}
            </div>
          ))}
        </div>

        <div style={{ fontSize: 10.5, color: '#B6BFCC', marginTop: 10, fontWeight: 600, padding: '0 2px' }}>
          U.S. Census ACS 5-year
        </div>

        {trackedCandidates.length > 0 && (
          <div style={{ marginTop: 12, borderTop: '1px solid #eef1f5', paddingTop: 10 }}>
            <button
              onClick={() => setShowTracked(s => !s)}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                background: 'none', border: 'none', cursor: 'pointer', padding: '4px 2px',
                fontSize: 11.5, fontWeight: 700, color: '#374151', textTransform: 'uppercase', letterSpacing: '0.04em',
              }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <Users size={12} /> Tracked here ({trackedCandidates.length})
              </span>
              <ChevronRight size={13} style={{ transform: showTracked ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }} />
            </button>
            {showTracked && (
              <div style={{ marginTop: 6 }}>
                {trackedCandidates.map((c, idx) => (
                  <div key={c.id}
                    onClick={() => navigate(`/candidates/${c.id}`)}
                    style={{
                      padding: '6px 8px', display: 'flex', alignItems: 'center', gap: 8,
                      background: idx % 2 === 0 ? 'white' : '#fafafa', borderRadius: 8, cursor: 'pointer',
                    }}>
                    <div style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: PARTY_COLOR[partyGroup(c.party)] || '#6b7280' }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12.5, fontWeight: 600, color: '#111', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {c.name}
                      </div>
                      {c.party && <div style={{ fontSize: 10.5, color: '#6b7280' }}>{c.party}</div>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Footer CTA */}
      <div style={{ padding: 12, borderTop: '1px solid #eef1f5' }}>
        <button
          disabled={!place}
          onClick={() => place && navigate(placePath(place.county, place.name))}
          style={{
            width: '100%', fontSize: 13, fontWeight: 800, padding: '10px 14px', borderRadius: 10,
            border: 'none', background: place ? '#14532d' : '#cbd5e1', color: '#fff',
            cursor: place ? 'pointer' : 'default',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
          }}
        >
          Full demographics <ChevronRight size={14} />
        </button>
      </div>
    </div>
  )
}
