#!/usr/bin/env node
// Badger Board — R1a UI-audit regression tests (B1, B2, B16, B5)
// Zero-config: node tests/r1a.test.mjs
//
// These are static-source assertions, not DOM tests: the four fixes are all
// structural (a z-index ladder, flex/flow structure, listener wiring), so the
// thing worth locking down is the source shape that produces them.
import { readFileSync, readdirSync, statSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join, relative } from 'path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

let pass = 0, fail = 0
const t = (name, cond) => { cond ? pass++ : fail++; console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${name}`) }

const layout    = read('src/components/Layout.jsx')
const tailwind  = read('tailwind.config.js')
const indexCss  = read('src/index.css')
const broadside = read('src/pages/Broadside.jsx')

// ─── B1: the z-scale ─────────────────────────────────────────────────────────
console.log('B1 — z-index scale')

const zBlock = layout.match(/export const Z = \{([\s\S]*?)\}/)
t('Layout.jsx exports a Z scale', !!zBlock)
const Z = Object.fromEntries(
  [...(zBlock?.[1] ?? '').matchAll(/(\w+):\s*(\d+)/g)].map(([, k, v]) => [k, Number(v)])
)
const ORDER = ['CHROME', 'STICKY', 'POPOVER', 'CHAT', 'DRAWER', 'MODAL', 'TOAST']
t('scale defines every band', ORDER.every(k => Number.isFinite(Z[k])))
t('bands are strictly increasing (chrome→toast)',
  ORDER.every((k, i) => i === 0 || Z[ORDER[i - 1]] < Z[k]))
t('chat sits below the mobile drawer', Z.CHAT < Z.DRAWER)
t('mobile drawer sits below the modal band', Z.DRAWER < Z.MODAL)
t('the scale is documented in Layout.jsx', /z-index scale/i.test(layout))
t('the scale is documented in tailwind.config.js', /z-index scale/i.test(tailwind))

// Tailwind tokens must be the same ladder, or class names and inline styles drift.
const twBlock = tailwind.match(/zIndex:\s*\{([\s\S]*?)\}/)
t('tailwind.config.js defines zIndex tokens', !!twBlock)
const TW = Object.fromEntries(
  [...(twBlock?.[1] ?? '').matchAll(/(\w+):\s*'(\d+)'/g)].map(([, k, v]) => [k, Number(v)])
)
t('tailwind tokens match the Z scale',
  ORDER.every(k => TW[k.toLowerCase()] === Z[k]))

// The chat widget must no longer live in the 9998/9999 band it used to occupy.
const chatWidget = layout.slice(layout.indexOf('function SupportChatWidget'))
t('chat panel + FAB use Z.CHAT', (chatWidget.match(/zIndex: Z\.CHAT/g) || []).length === 2)
// v1.37.0: match actual style usage, not any occurrence — an R3 comment
// below the widget legitimately mentions "z-9999 = Z.TOAST".
t('chat widget no longer uses 9998/9999', !/zIndex:\s*999[89]/.test(chatWidget))
t('mobile drawer uses the z-drawer token', /fixed inset-0 z-drawer/.test(layout))
t('no element still renders at the old z-[9990]', !/className="[^"]*z-\[9990\]/.test(layout))

// Nothing that blocks the page (a full-screen overlay/modal) may sit at or
// below the chat or the drawer. Scan every page + component for the two ways
// this app writes a full-screen overlay.
const jsxFiles = []
;(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p)
    else if (name.endsWith('.jsx')) jsxFiles.push(p)
  }
})(join(root, 'src'))

const overlays = []
for (const file of jsxFiles) {
  const src = readFileSync(file, 'utf8')
  const rel = relative(root, file)
  for (const m of src.matchAll(/fixed inset-0[^"'`]*?\bz-\[?(\d+)\]?/g)) overlays.push([rel, Number(m[1])])
  for (const m of src.matchAll(/position:\s*'fixed',\s*inset:\s*0,[^}]*?zIndex:\s*(\d+)/g)) overlays.push([rel, Number(m[1])])
}
t('found the app\'s full-screen overlays', overlays.length >= 15)
const tooLow = overlays.filter(([, z]) => z <= Z.DRAWER)
t('every full-screen overlay/modal outranks the chat and the drawer',
  tooLow.length === 0 || (console.log('    offenders:', tooLow), false))
t('modal band floor is still 40 (Z.MODAL)', Math.min(...overlays.map(([, z]) => z)) === Z.MODAL)
t('Prospecting\'s portal popover is left alone', overlays.some(([f, z]) => f.includes('Prospecting') && z === 9998))

// Map panes (Leaflet 400–700 / MapLibre) must be contained, or they out-paint
// everything below the modal band from inside the page.
t('index.css isolates map stacking contexts',
  /\.leaflet-container[\s\S]{0,80}isolation:\s*isolate/.test(indexCss))

// ─── B2: mobile drawer is one normal-flow scrollable column ──────────────────
console.log('B2 — mobile nav drawer')
t('drawer renders the sidebar in singleColumn mode', /<Sidebar\s+singleColumn/.test(layout))
t('drawer panel is height-capped', /w-72 max-w-xs h-full max-h-\[100dvh\]/.test(layout))
t('singleColumn root owns the only scroller',
  /singleColumn \? 'overflow-y-auto overscroll-contain' : ''/.test(layout))
t('singleColumn nav is NOT its own scroller (no clipped items)',
  /singleColumn \? 'flex-none' : 'flex-1 overflow-y-auto'/.test(layout))
t('nav and footer are plain flow siblings (no absolute positioning)',
  !/(nav|Bottom section)[\s\S]{0,200}className="[^"]*absolute/.test(layout))
t('footer group cannot be squeezed on top of the nav',
  /p-3 border-t border-white\/10 space-y-1 flex-none/.test(layout))

// ─── B16: changelog popover ──────────────────────────────────────────────────
console.log('B16 — "What\'s new" changelog popover')
const popover = layout.slice(layout.indexOf('const CHANGELOG_WIDTH'), layout.indexOf('// ─── Sidebar'))
t('panel is readable width (320–380px)', /CHANGELOG_WIDTH\s*=\s*3[2-8]\d/.test(layout))
t('panel is fixed-position, not clipped to the rail', /className="fixed z-popover/.test(popover))
t('panel is anchored to the version button', /anchorRef\?\.current\?\.getBoundingClientRect/.test(popover))
t('panel is clamped on-screen (both axes)',
  /Math\.min\(\s*Math\.max\(CHANGELOG_MARGIN, r\.left/.test(popover) && /maxHeight = Math\.max\(160/.test(popover))
t('panel height is capped with an internal scroller',
  /maxHeight: pos\.maxHeight/.test(popover) && /flex-1 min-h-0 overflow-y-auto/.test(popover))
t('closes on outside click', /addEventListener\('mousedown', onDown\)/.test(popover))
t('closes on Escape', /e\.key === 'Escape'/.test(popover))
t('listeners are removed on unmount',
  /removeEventListener\('mousedown', onDown\)/.test(popover) && /removeEventListener\('keydown', onKey\)/.test(popover))
t('version button is the anchor', /ref=\{versionBtnRef\}/.test(layout))

// ─── B5: Broadside iframe is fully reachable ─────────────────────────────────
console.log('B5 — /broadside scroll')
t('page wrapper owns a scroller', /flex flex-col h-full overflow-y-auto/.test(broadside))
t('iframe is sized to the module\'s own document',
  /height: frameHeight \? `\$\{frameHeight\}px` : '100%'/.test(broadside))
t('iframe never renders shorter than its slot', /minHeight: '100%'/.test(broadside))
t('iframe no longer clipped to the frame by flex-1/min-h-0',
  !/className="flex-1 min-h-0 w-full border-0"/.test(broadside))
t('height is measured off the module root, not body scrollHeight (no ratchet)',
  /querySelector\('\.layout'\)/.test(broadside) && !/\.scrollHeight\b/.test(broadside))
t('re-measures when the module resizes', /new ResizeObserver/.test(broadside))
t('observer is disconnected on unmount', /resizeObsRef\.current\?\.disconnect\(\)/.test(broadside))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
