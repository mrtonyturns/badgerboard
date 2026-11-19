// candidate/kit.jsx — the few pieces the redesigned profile tabs share, built
// on the v2.0 tile kit (src/components/ui.jsx, docs/DESIGN.md).
//
//   SectionHead  big icon chip + heavy title: what makes each part of a tab
//                easy to tell apart at a glance
//   Pill         small rounded label (priority, confidence, status)
//   SourceLine   "Source: …" with a link out when the source carries a URL
//   ImpactPips   ●●●○○ — how much a point matters in this race
//   ExtLink      a link out that opens in a new tab

import { ExternalLink } from 'lucide-react'
import { IconChip } from '../../components/ui'

const cx = (...a) => a.filter(Boolean).join(' ')

export function SectionHead({ icon, color = 'ink', title, sub, right, id, className = '' }) {
  return (
    <div id={id} className={cx('flex flex-wrap items-center gap-x-4 gap-y-3', className)}>
      <IconChip icon={icon} color={color} size={44} />
      <div className="min-w-0 flex-1">
        <h2 className="display text-[24px] leading-tight md:text-[28px]">{title}</h2>
        {sub && <p className="mt-0.5 text-[14px] leading-snug text-brand-mute">{sub}</p>}
      </div>
      {right && <div className="flex flex-wrap items-center gap-2">{right}</div>}
    </div>
  )
}

const PILL = {
  red:    'bg-[#FBEDEB] text-[#B42318]',
  orange: 'bg-[#FFF1E6] text-[#B54708]',
  green:  'bg-[#E8F6EE] text-[#16803C]',
  blue:   'bg-[#EAF0FF] text-[#2F6BFF]',
  purple: 'bg-[#F3EDFB] text-[#7C3AED]',
  gray:   'bg-black/5 text-brand-mute',
  dark:   'bg-brand-ink text-white',
}

export function Pill({ children, tone = 'gray', className = '' }) {
  return (
    <span className={cx('inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-[0.06em]', PILL[tone] || PILL.gray, className)}>
      {children}
    </span>
  )
}

/** Confidence badge from the profile, shown only when the claim needs checking. */
export function ConfidencePill({ value }) {
  const v = String(value || '').toUpperCase()
  if (!v || v === 'KNOWN' || v === 'CONFIRMED' || v === 'X/LIVE' || v === 'WEB/LIVE') return null
  const label = v === 'RESEARCH REQUIRED' ? 'Needs research' : v === 'VERIFY' ? 'Verify' : v === 'LIKELY' ? 'Likely' : v.toLowerCase()
  return <Pill tone="orange">{label}</Pill>
}

export function ExtLink({ href, children, className = '' }) {
  if (!href) return <span className={className}>{children}</span>
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={cx('inline-flex items-center gap-1 font-semibold text-brand-ink underline-offset-2 hover:underline', className)}>
      {children}<ExternalLink className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
    </a>
  )
}

export function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return '' }
}

export function SourceLine({ source, url, className = '' }) {
  if (!source && !url) return null
  return (
    <div className={cx('text-[12.5px] leading-snug text-brand-faint', className)}>
      Source:{' '}
      {url ? <ExtLink href={url} className="text-[12.5px] font-medium text-brand-mute">{source || hostOf(url) || 'link'}</ExtLink> : <span className="text-brand-mute">{source}</span>}
    </div>
  )
}

export function ImpactPips({ value, color = '#11161C' }) {
  if (!value) return null
  return (
    <span className="inline-flex items-center gap-1" title={`Impact ${value} of 5 in this race`} aria-label={`Impact ${value} of 5`}>
      {[1, 2, 3, 4, 5].map(i => (
        <span key={i} className="h-1.5 w-3 rounded-full" style={{ background: i <= value ? color : 'rgba(0,0,0,.1)' }} />
      ))}
    </span>
  )
}
