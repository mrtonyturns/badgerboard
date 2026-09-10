#!/usr/bin/env node
// Badger Board — R3A: the approved COSMETIC items from the Aug-16 UI audit.
//
// Covers the one brand accent (#8B0000 / #0A1628), Geist-first typography, the
// single focus ring, the Layout top-bar/account-menu fixes, the "Badger Board"
// spelling, UpgradePrompt's retired default price, the Settings pane scroll
// reset, the security-activity verb humanizer, and the Profiler polish.
//
// Same loader trick as tests/r2c.test.mjs: pure helpers that live inside a .jsx
// file are bracketed with
//   // ─── R3A PURE HELPERS BEGIN ───  …  // ─── R3A PURE HELPERS END ───
// and sliced out here as a real ES module. That block must stay free of JSX and
// of imports.
//
// Zero-config: node tests/r3a.test.mjs

import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const src  = (p) => readFileSync(join(ROOT, p), 'utf8')

// "This value must not appear ANYWHERE" assertions have to ignore comments —
// the fixes below are documented in comments that quote the old value they
// replaced. Strips /* … */ (which covers {/* … */} JSX comments) and whole-line
// // comments; a trailing // on a line of code is left alone, so no URL breaks.
const codeOnly = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '')

let pass = 0, fail = 0
const t = (name, cond) => { cond ? pass++ : fail++; console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${name}`) }
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) console.log(`      got ${JSON.stringify(got)} · want ${JSON.stringify(want)}`)
  t(name, ok)
}

async function loadPureBlock(file, tag = 'R3A') {
  const s = src(file)
  const a = s.indexOf(`${tag} PURE HELPERS BEGIN`)
  const b = s.indexOf(`${tag} PURE HELPERS END`)
  if (a < 0 || b < 0 || b < a) throw new Error(`${file}: ${tag} pure-helper sentinels missing`)
  const block = s.slice(s.indexOf('\n', a) + 1, s.lastIndexOf('\n', b))
  if (/^\s*import\s/m.test(block)) throw new Error(`${file}: pure block must not import`)
  return import('data:text/javascript;base64,' + Buffer.from(block, 'utf8').toString('base64'))
}

const settingsShared = await loadPureBlock('src/pages/settings/shared.jsx')

// ═══ 1 — Brand tokens: ONE red, ONE navy ═════════════════════════════════════
console.log('1 — one brand accent (#8B0000 red / #0A1628 navy)')
{
  const tw = src('tailwind.config.js')
  t('tailwind brand.red is still the canonical #8B0000', /red:\s*'#8B0000'/.test(tw))
  t('tailwind brand.navy is still the canonical #0A1628', /navy:\s*'#0A1628'/.test(tw))

  const pf = src('src/pages/profiler/shared.jsx')
  t('profiler token red is #8B0000',  /\n\s*red:\s*'#8B0000',/.test(pf))
  t('profiler token navy is #0A1628', /\n\s*navy:\s*'#0A1628',/.test(pf))
  t('profiler redHot (danger shade) is untouched at #B91C1C', /redHot:\s*'#B91C1C'/.test(pf))
  t('no #A51C24 left in the profiler tokens', !/#A51C24/i.test(pf))

  const st = src('src/pages/settings/shared.jsx')
  t('settings token red is #8B0000',  /\n\s*red:\s*'#8B0000',/.test(st))
  t('settings token navy is #0A1628', /\n\s*navy:\s*'#0A1628',/.test(st))
  t('settings error tints (redBg/redBr) are untouched',
    /redBg:\s*'#FEF2F2'/.test(st) && /redBr:\s*'#FBD5D5'/.test(st))

  const layout = codeOnly(src('src/components/Layout.jsx'))
  t('no #dc2626 left in Layout (support-chat widget)', !/#dc2626/i.test(layout))
  t('no #1e3a5f left in Layout (support-chat widget)', !/#1e3a5f/i.test(layout))
  t('Layout declares the two brand literals once',
    /const BRAND_RED\s*=\s*'#8B0000'/.test(layout) && /const BRAND_NAVY\s*=\s*'#0A1628'/.test(layout))

  // Semantic reds are NOT part of the accent and must survive untouched.
  t('party red (lib/party.js) is untouched', /R:\s*'#dc2626'/.test(src('src/lib/party.js')))
}

// ═══ 2 — Geist-first typography ══════════════════════════════════════════════
console.log('2 — Geist is the app-wide primary typeface')
{
  const tw = src('tailwind.config.js')
  const m  = tw.match(/sans:\s*\[([^\]]+)\]/)
  t('tailwind fontFamily.sans exists', !!m)
  const stack = (m ? m[1] : '').split(',').map(s => s.trim().replace(/^'|'$/g, ''))
  eq('the sans stack starts with Geist, then Inter', stack.slice(0, 2), ['Geist', 'Inter'])

  const html = src('index.html')
  t('Geist is actually loaded in index.html', /family=[^"']*Geist/.test(html))
  t('Inter is still loaded as the first fallback', /family=[^"']*Inter/.test(html))
}

// ═══ 3 — ONE focus ring ══════════════════════════════════════════════════════
console.log('3 — one focus ring, and it is not red')
{
  const css = src('src/index.css')
  t('a global :focus-visible ring exists', /:focus-visible\s*,?[\s\S]{0,400}?outline:\s*2px solid rgba\(10,\s*22,\s*40/.test(css))
  t('inputs, selects, textareas and buttons are all covered',
    /input:focus-visible/.test(css) && /select:focus-visible/.test(css) &&
    /textarea:focus-visible/.test(css) && /button:focus-visible/.test(css))
  t('no focus ring in brand red is left in index.css', !/focus(-visible)?:ring-brand-red/.test(css))
  t('the .input helper focuses navy, not red', /\.input[\s\S]{0,300}?focus:ring-brand-navy\/40/.test(css))

  // The two redesigns used to kill the outline outright (the "grey ring").
  t('.pf-input no longer suppresses the outline',
    !/\.pf-input:focus\s*\{[^}]*outline:\s*none/.test(src('src/pages/profiler/shared.jsx')))
  t('.st-input no longer suppresses the outline',
    !/\.st-input:focus\s*\{[^}]*outline:\s*none/.test(src('src/pages/settings/shared.jsx')))
  t('no inline outline:none survives in the settings Field control',
    !/outline:\s*'none'/.test(src('src/pages/settings/shared.jsx')))
  t('no inline outline:none survives in Layout', !/outline:\s*'none'/.test(src('src/components/Layout.jsx')))
}

// ═══ 4 — Layout: avatar, menu labels, route loader, BETA chip ════════════════
console.log('4 — Layout top bar and account menu')
{
  const s = src('src/components/Layout.jsx')

  t('an AccountAvatar component exists', /function AccountAvatar\(/.test(s))
  t('it reads the same field Settings writes (user_metadata.avatar_url)',
    /user\?\.user_metadata\?\.avatar_url/.test(s))
  t('it renders an <img> for the uploaded photo', /<img[\s\S]{0,200}?src=\{src\}/.test(s))
  t('initials remain the fallback', /const initial = user\?\.user_metadata\?\.display_name/.test(s))
  t('both the top bar and the menu header use it',
    (s.match(/<AccountAvatar user=\{user\}/g) || []).length === 2)

  t('the menu says "Your account" (Settings\' own name)', /Your account\s*\n/.test(s))
  t('the menu says "Plan &amp; billing"', /Plan &amp; billing/.test(s))
  t('the retired "My Profile" label is gone', !/My Profile/.test(codeOnly(s)))
  t('the retired "Billing &amp; Plan" label is gone', !/Billing &amp; Plan/.test(codeOnly(s)))
  t('menu items link to the real pane routes',
    /to="\/settings\/plan"/.test(s) && /to="\/settings\/security"/.test(s))

  t('the route transition uses the top LoadingBar, not a bordered spinner',
    /<Suspense fallback=\{<LoadingBar loading \/>\}>/.test(s))
  t('LoadingBar is imported', /import LoadingBar from '\.\/LoadingBar'/.test(s))

  t('the nav/page BETA badge is no longer purple', !/bg-purple-600/.test(s))
  t('it is a neutral brand-navy chip that keeps its label',
    /bg-brand-navy\/10 text-brand-navy[\s\S]{0,120}?\{pageHeader\.badge\}/.test(s))
}

// ═══ 5 — Product name is "Badger Board" ══════════════════════════════════════
console.log('5 — one spelling of the product name')
{
  for (const f of [
    'src/components/UpgradePrompt.jsx',
    'src/components/PaymentLockOverlay.jsx',
    'src/components/Layout.jsx',
    'src/pages/Settings.jsx',
    'src/pages/Dossiers.jsx',
  ]) {
    t(`${f}: no "BadgerBoard"`, !/BadgerBoard(?!Logo)/.test(src(f)))
  }
  t('UpgradePrompt says "Badger Board website"', /the Badger Board website/.test(src('src/components/UpgradePrompt.jsx')))
  t('PaymentLockOverlay says it twice', (src('src/components/PaymentLockOverlay.jsx').match(/Badger Board website/g) || []).length === 2)
}

// ═══ 6 — UpgradePrompt: the founder-era default price is gone ════════════════
console.log('6 — UpgradePrompt has no misleading plan/price defaults')
{
  const s = src('src/components/UpgradePrompt.jsx')
  t('the $69/mo default is gone',            !/from \$69\/mo/.test(codeOnly(s)))
  t('the "Campaign" plan default is gone',   !/plan\s*=\s*'Campaign'/.test(s))
  t('plan falls back to something generic',  /plan\s*=\s*'a higher plan'/.test(s))
  t('price has no default at all',           /\n\s*price,\n/.test(s))
  t('a missing price renders no price line', /const priceLabel =[\s\S]{0,120}?:\s*null/.test(s))
  t('the price callout is conditional',      /\{priceLabel &&/.test(s))
  t('the CTA drops the dash when there is no price', /\$\{priceLabel\}`\s*:\s*''/.test(s))

  // Every live call site still passes both explicitly.
  for (const f of ['src/pages/Recruit.jsx', 'src/pages/Prospecting.jsx', 'src/pages/GamePlan.jsx']) {
    const c = src(f)
    t(`${f}: passes plan and price explicitly`,
      /<UpgradePrompt[\s\S]{0,400}?plan=/.test(c) && /<UpgradePrompt[\s\S]{0,400}?price=/.test(c))
  }
}

// ═══ 7 — Settings: switching panes lands at the top ══════════════════════════
console.log('7 — Settings resets scroll on pane change')
{
  const s = src('src/pages/Settings.jsx')
  t('the reset is keyed on the pane, so deep links get it too',
    /useEffect\(\(\) => \{[\s\S]{0,400}?main\.scrollTo\(\{ top: 0 \}\)[\s\S]{0,200}?\}, \[pane\]\)/.test(s))
  t('it scrolls the real scroller (Layout\'s <main>), not just the window',
    /document\.querySelector\('main'\)/.test(s))
  t('goPane no longer relies on the window scroll that never fired',
    /const goPane = \(id\) => \{\s*navigate\([^\n]*\)\s*\}/.test(s))
}

// ═══ 8 — Activity verbs read as English ══════════════════════════════════════
console.log('8 — the security-activity verb humanizer')
{
  const { humanizeVerb } = settingsShared
  t('humanizeVerb is exported from settings/shared.jsx', typeof humanizeVerb === 'function')

  eq('ai_unlock',          humanizeVerb('ai_unlock'),        'Unlocked AI access')
  eq('"ai unlock" (spaced, as the old feed rendered it)',
     humanizeVerb('ai unlock'), 'Unlocked AI access')
  eq('ai_lock',            humanizeVerb('ai_lock'),          'Locked AI access')
  eq('profile_updated',    humanizeVerb('profile_updated'),  'Updated profile')
  eq('"profile updated"',  humanizeVerb('profile updated'),  'Updated profile')
  eq('login',              humanizeVerb('login'),            'Signed in')
  eq('password_changed',   humanizeVerb('password_changed'), 'Changed password')
  eq('unknown verb is sentence-cased', humanizeVerb('widget_frobbed'), 'Widget frobbed')
  eq('empty verb is honest',           humanizeVerb(''),     'Account activity')
  eq('missing verb is honest',         humanizeVerb(null),   'Account activity')
  t('the raw "Ai unlock" spelling is impossible now', humanizeVerb('ai_unlock') !== 'Ai unlock')

  const pane = src('src/pages/settings/SecurityPane.jsx')
  t('SecurityPane imports the shared humanizer', /humanizeVerb,?\s*\n?\}\s*from '\.\/shared'/.test(pane) || /humanizeVerb/.test(pane))
  t('SecurityPane no longer sentence-cases the raw column itself',
    !/String\(row\.action \|\| ''\)\.replace\(\/_\/g/.test(pane))
  t('the candidate name is still appended', /\$\{label\} · \$\{name\}/.test(pane))
}

// ═══ 9 — Profiler polish ═════════════════════════════════════════════════════
console.log('9 — Profiler: one H1, honest stats, a magnifier, even rows')
{
  const s = src('src/pages/Dossiers.jsx')

  // (a) the duplicate H1
  t('the library no longer renders its own <h1>', !/<h1/.test(codeOnly(s)))
  t('the duplicated subtitle is gone', !/AI-generated opposition intelligence profiles/.test(s))
  t('Layout still owns the one page header',
    /title: 'Profiler',\s*sub: 'AI-generated 14-section political intelligence reports'/
      .test(src('src/components/Layout.jsx')))

  // (b) the two near-identical stat cards
  t('"Profiles this month" no longer sits beside "Generated this month"',
    !/label="Profiles this month"/.test(s))
  t('"Generated this month" (all sources) is still there', /label="Generated this month"/.test(s))
  t('the second cell says whose generations it counts', /label="Generated by you"/.test(s))

  // (c) the missing magnifier
  t('lucide Search is imported', /import \{ Search \} from 'lucide-react'/.test(s))
  t('the profiles search box renders the icon',
    /<Search\b[\s\S]{0,700}?aria-label="Search profiles"/.test(s))
  t('the field leaves room for it', /padding: '11px 15px 11px 38px'/.test(s))

  // (d) ragged FLAGS rows
  t('the FLAGS cell no longer wraps', /flexWrap: 'nowrap'/.test(s))
  t('the FLAGS column and its header are the same width',
    (s.match(/width: 132/g) || []).length >= 2)
  t('flag chips stay on one line', (s.match(/whiteSpace: 'nowrap'/g) || []).length >= 3)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
