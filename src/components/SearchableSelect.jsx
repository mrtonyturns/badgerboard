// SearchableSelect — drop-in replacement for large <select> elements (v1.22.2)
//
// Renders an .input-styled trigger; opening it shows a search box that filters
// the option list as you type. Supports flat options or grouped options,
// keyboard navigation (↑ ↓ Enter Esc), and click-outside close.
//
//   <SearchableSelect
//     value={val}
//     onChange={v => setVal(v)}
//     options={[{ value: 'a', label: 'Alpha' }, ...]}        // flat
//     groups={[{ label: 'Group', options: [...] }, ...]}     // or grouped
//     placeholder="Select..."
//     className="sm:w-40"           // extra classes for the trigger
//     buttonClassName="font-semibold"
//     disabled={false}
//   />
//
// onChange receives the VALUE directly (not an event).

import { useState, useRef, useEffect, useMemo } from 'react'
import { ChevronDown, Search, Check } from 'lucide-react'

export default function SearchableSelect({
  value,
  onChange,
  options,
  groups,
  placeholder = 'Select...',
  className = '',
  buttonClassName = '',
  disabled = false,
  searchPlaceholder = 'Type to search...',
}) {
  const [open, setOpen]       = useState(false)
  const [query, setQuery]     = useState('')
  const [hiIndex, setHiIndex] = useState(0)
  const rootRef   = useRef(null)
  const inputRef  = useRef(null)
  const listRef   = useRef(null)

  // Normalize to grouped shape internally
  const allGroups = useMemo(() => {
    if (groups && groups.length) return groups
    return [{ label: null, options: options || [] }]
  }, [groups, options])

  const flatAll = useMemo(() => allGroups.flatMap(g => g.options), [allGroups])
  const selected = flatAll.find(o => String(o.value) === String(value))

  // Filter by query — every whitespace-separated token must appear in the
  // label (so "senate 1" matches "State Senate District 1")
  const filteredGroups = useMemo(() => {
    const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
    if (!tokens.length) return allGroups
    const matches = (label) => {
      const l = String(label).toLowerCase()
      return tokens.every(t => l.includes(t))
    }
    return allGroups
      .map(g => ({ ...g, options: g.options.filter(o => matches(o.label)) }))
      .filter(g => g.options.length > 0)
  }, [allGroups, query])

  const flatFiltered = useMemo(() => filteredGroups.flatMap(g => g.options), [filteredGroups])

  // Reset highlight when the filtered list changes
  useEffect(() => { setHiIndex(0) }, [query, open])

  // Focus search input on open
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 0)
    else setQuery('')
  }, [open])

  // Click-outside close
  useEffect(() => {
    if (!open) return
    const onDown = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  // Keep the highlighted row visible
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-idx="${hiIndex}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [hiIndex])

  const pick = (opt) => {
    onChange(opt.value)
    setOpen(false)
  }

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setHiIndex(i => Math.min(i + 1, flatFiltered.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHiIndex(i => Math.max(i - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); if (flatFiltered[hiIndex]) pick(flatFiltered[hiIndex]) }
    else if (e.key === 'Escape') { e.preventDefault(); setOpen(false) }
  }

  let runningIdx = -1

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(o => !o)}
        className={`input flex items-center justify-between gap-2 text-left w-full ${disabled ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'} ${buttonClassName}`}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className={`truncate ${selected ? '' : 'text-gray-400'}`}>
          {selected ? selected.label : placeholder}
        </span>
        <ChevronDown className={`w-4 h-4 shrink-0 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute z-50 mt-1 w-full min-w-[220px] bg-white border border-gray-200 rounded-lg shadow-xl overflow-hidden">
          <div className="p-2 border-b border-gray-100">
            <div className="relative">
              <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                ref={inputRef}
                className="w-full pl-8 pr-2 py-1.5 text-sm border border-gray-200 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-navy/30 focus:border-brand-navy"
                placeholder={searchPlaceholder}
                value={query}
                onChange={e => setQuery(e.target.value)}
                onKeyDown={onKeyDown}
              />
            </div>
          </div>
          <div ref={listRef} className="max-h-60 overflow-y-auto py-1" role="listbox">
            {flatFiltered.length === 0 && (
              <div className="px-3 py-3 text-sm text-gray-400 text-center">No matches</div>
            )}
            {filteredGroups.map((g, gi) => (
              <div key={g.label ?? gi}>
                {g.label && (
                  <div className="px-3 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400 sticky top-0 bg-white">
                    {g.label}
                  </div>
                )}
                {g.options.map(opt => {
                  runningIdx += 1
                  const idx = runningIdx
                  const isSel = String(opt.value) === String(value)
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      data-idx={idx}
                      role="option"
                      aria-selected={isSel}
                      onClick={() => pick(opt)}
                      onMouseEnter={() => setHiIndex(idx)}
                      className={`w-full text-left px-3 py-2 text-sm flex items-center justify-between gap-2 ${
                        idx === hiIndex ? 'bg-red-50' : ''
                      } ${isSel ? 'font-semibold text-brand-red' : 'text-gray-700'}`}
                    >
                      <span className="truncate">{opt.label}</span>
                      {isSel && <Check className="w-4 h-4 shrink-0" />}
                    </button>
                  )
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
