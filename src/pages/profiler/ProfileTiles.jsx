// src/pages/profiler/ProfileTiles.jsx — the Profiler library as a shelf of
// short paper documents (v2.0 facelift).
//
// Each tile reads like the first page of a report: a red POLITICAL PROFILE
// eyebrow, the candidate's name in heavy type, the office/party line, a few
// faint lines standing in for the page, and a footer strip with when it was
// written, how well it is sourced and what is still to verify. A candidate
// profiled more than once shows the newest version with the older ones as a
// stacked-paper edge behind it; those versions stay reachable from the tile's
// menu and from inside the reader. Same motif as the Home "Profiles" tile.

import { useState } from 'react'
import { MoreHorizontal } from 'lucide-react'
import { useDialog } from '../../lib/useDialog'
import { T, RatioBar } from './shared'
import { sourcedLabel } from './library'

const PAGE_LINES = ['100%', '91%', '96%', '58%']

/** A short paper document for one candidate's newest profile. */
export function DocTile({ group, onOpen, menu }) {
  const r = group.latest
  const versions = group.versions.length
  const stacked = versions > 1
  const sourced = sourcedLabel(r)
  const sub = [r.office, r.party].filter(Boolean).join(' · ')

  return (
    // pb-2 on every tile, stacked or not, so footers line up across a row.
    <div className="pf-doctile relative pb-2">
      {/* The older versions, peeking out from under the newest one. */}
      {stacked && (
        <>
          <span aria-hidden="true" className="absolute inset-x-4 bottom-0 top-4 rounded-xl bg-[#F4F5F7] shadow-e2" />
          <span aria-hidden="true" className="absolute inset-x-2 bottom-1 top-2 rounded-xl bg-[#FAFBFC] shadow-e2" />
        </>
      )}
      <div
        data-pf-tile
        role="button"
        tabIndex={0}
        onClick={() => onOpen(r.id)}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(r.id) } }}
        aria-label={`Open the profile of ${r.name}`}
        className="relative flex h-full min-h-[236px] cursor-pointer flex-col overflow-hidden rounded-xl bg-white shadow-e2 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-e4 focus-visible:shadow-e4"
      >
        <div className="flex flex-1 flex-col px-[18px] pt-4 pb-3 max-[520px]:px-3.5">
          <div className="flex items-center gap-2 pr-7 max-[520px]:pr-6">
            <span className="whitespace-nowrap text-[10.5px] font-extrabold uppercase tracking-[0.14em] text-brand-red max-[520px]:text-[9.5px] max-[520px]:tracking-[0.08em]">
              Political profile
            </span>
            {r.isNew && (
              <span className="rounded-full bg-brand-red-wash px-1.5 py-px text-[10px] font-extrabold uppercase tracking-wider text-brand-red">New</span>
            )}
          </div>
          <div className="mt-2 line-clamp-2 text-[19px] font-extrabold leading-[1.15] tracking-display text-brand-ink max-[520px]:text-[16px]">
            {r.name}
          </div>
          {sub && (
            <div className="mt-1 truncate text-[12.5px] font-medium text-brand-mute" title={sub}>{sub}</div>
          )}
          {stacked && (
            <div className="mt-1 text-[11.5px] font-semibold text-brand-mute">{versions} versions</div>
          )}

          {/* The "page": a few faint lines of text. */}
          <div className="mt-auto flex flex-col gap-[7px] pt-4" aria-hidden="true">
            {PAGE_LINES.map((w, i) => (
              <span key={i} className="block h-[5px] rounded-full bg-[#EEF0F2]" style={{ width: w }} />
            ))}
          </div>
        </div>

        {/* Footer strip: when, how well sourced, what is left to verify. */}
        <div className="border-t border-black/[.06] bg-[#FAFBFC] px-[18px] py-2.5 max-[520px]:px-3.5">
          <div className="flex items-center gap-2">
            <span className="whitespace-nowrap text-[12px] font-bold text-brand-ink" title={r.age || undefined}>{r.date}</span>
            {r.monitored && (
              <span
                title="Active Monitoring refreshes this profile every week"
                className="ml-auto rounded-full bg-[#E6F5EC] px-1.5 py-px text-[10px] font-extrabold tracking-wider text-[#15803D]"
              >WEEKLY</span>
            )}
          </div>
          {(sourced || r.flags.verifyLabel) && (
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11.5px] font-semibold">
              {sourced && (
                <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-brand-mute" title={`${sourced} to a primary record`}>
                  <RatioBar good={r.good} weak={r.weak} style={{ width: 28, height: 4, marginTop: 0, flex: 'none' }} />
                  {sourced}
                </span>
              )}
              {r.flags.verifyLabel && (
                <span className="whitespace-nowrap" style={{ color: T.amber }}>{r.flags.verifyLabel}</span>
              )}
            </div>
          )}
        </div>
      </div>
      {menu}
    </div>
  )
}

/** Placeholder paper while the library loads. */
export function DocTileSkeleton() {
  return (
    <div className="flex min-h-[236px] animate-pulse flex-col rounded-xl bg-white p-[18px] shadow-e1" aria-hidden="true">
      <span className="block h-2 w-24 rounded-full bg-[#F5E3E1]" />
      <span className="mt-3 block h-4 w-3/4 rounded-full bg-[#ECEEF0]" />
      <span className="mt-2 block h-2.5 w-1/2 rounded-full bg-[#F1F2F4]" />
      <div className="mt-auto flex flex-col gap-[7px]">
        {PAGE_LINES.map((w, i) => <span key={i} className="block h-[5px] rounded-full bg-[#F1F2F4]" style={{ width: w }} />)}
      </div>
    </div>
  )
}

/**
 * The ⋯ menu in a tile's corner: the newest version, every older version, the
 * candidate record, and a fresh version. Escape and a click outside close it.
 */
export function TileMenu({ group, onOpen, onCandidate, onNewVersion }) {
  const [open, setOpen] = useState(false)
  const r = group.latest
  const older = group.versions.slice(1)
  return (
    // Open, the menu rises to the modal band (Layout Z.MODAL = 40): above the
    // tiles after it and above the support-chat button.
    <div className={`absolute right-2 top-2 ${open ? 'z-40' : 'z-[2]'}`}>
      <button
        type="button"
        aria-label={`More for ${r.name}`}
        aria-expanded={open}
        onClick={e => { e.stopPropagation(); setOpen(v => !v) }}
        className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-brand-mute transition-colors hover:bg-black/5 hover:text-brand-ink"
      >
        <MoreHorizontal className="h-[18px] w-[18px]" />
      </button>
      {open && <TileMenuPanel {...{ r, older, onOpen, onCandidate, onNewVersion }} onClose={() => setOpen(false)} />}
    </div>
  )
}

function TileMenuPanel({ r, older, onOpen, onCandidate, onNewVersion, onClose }) {
  // Escape only — a menu doesn't lock the page behind it.
  useDialog(onClose, { locked: false })
  const pick = (fn) => (e) => { e.stopPropagation(); onClose(); fn() }
  return (
    <>
      <div className="fixed inset-0 z-40 max-[520px]:bg-black/30" onClick={e => { e.stopPropagation(); onClose() }} />
      <div
        role="menu"
        onClick={e => e.stopPropagation()}
        // A dropdown on desktop; on a phone a bottom sheet, so a tile in the
        // left column can't push the menu off the screen.
        className="absolute right-0 top-[calc(100%+4px)] z-[41] w-60 rounded-xl bg-white p-1.5 shadow-e4 max-[520px]:fixed max-[520px]:inset-x-3 max-[520px]:bottom-3 max-[520px]:top-auto max-[520px]:w-auto max-[520px]:rounded-2xl max-[520px]:p-2 max-[520px]:shadow-e5"
      >
        <MenuItem onClick={pick(() => onOpen(r.id))}>
          Open{older.length ? ` newest · ${r.date}` : ''}
        </MenuItem>
        {older.length > 0 && (
          <>
            <div className="px-3 pb-1 pt-2 text-[10.5px] font-extrabold uppercase tracking-[0.12em] text-brand-faint">
              Earlier versions
            </div>
            <div className="max-h-48 overflow-y-auto">
              {older.map(v => (
                <MenuItem key={v.id} onClick={pick(() => onOpen(v.id))}>
                  {v.date}<span className="ml-1.5 text-brand-faint">{v.age}</span>
                </MenuItem>
              ))}
            </div>
            <div className="my-1 h-px bg-black/[.06]" />
          </>
        )}
        {onNewVersion && <MenuItem onClick={pick(onNewVersion)}>Generate a new version</MenuItem>}
        {r.candidateId && onCandidate && (
          <MenuItem onClick={pick(() => onCandidate(r.candidateId))}>Open candidate record</MenuItem>
        )}
      </div>
    </>
  )
}

function MenuItem({ children, onClick }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="block min-h-[38px] w-full rounded-lg px-3 py-2 text-left text-[13px] font-semibold text-brand-ink transition-colors hover:bg-[#F3F4F6]"
    >{children}</button>
  )
}
