#!/usr/bin/env node
// Badger Board — R3C UI-repair fixes (COSMETIC items from the Sep-09 audit).
//
// Same loader trick as tests/r1c.test.mjs and tests/r2c.test.mjs: the pure
// helpers live inside .jsx pages, so AdminDashboard.jsx brackets its pure block
// with
//   // ─── R3C PURE HELPERS BEGIN ───  …  // ─── R3C PURE HELPERS END ───
// and this file slices that block out and imports it as a real ES module. The
// block must therefore stay free of JSX and of imports.
//
// Zero-config: node tests/r3c.test.mjs

import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const src  = (p) => readFileSync(join(ROOT, p), 'utf8')

let pass = 0, fail = 0
const t = (name, cond) => { cond ? pass++ : fail++; console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${name}`) }
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) console.log(`      got ${JSON.stringify(got)} · want ${JSON.stringify(want)}`)
  t(name, ok)
}

async function loadPureBlock(file, tag = 'R3C') {
  const s = src(file)
  const a = s.indexOf(`${tag} PURE HELPERS BEGIN`)
  const b = s.indexOf(`${tag} PURE HELPERS END`)
  if (a < 0 || b < 0 || b < a) throw new Error(`${file}: ${tag} pure-helper sentinels missing`)
  const block = s.slice(s.indexOf('\n', a) + 1, s.lastIndexOf('\n', b))
  if (/^\s*import\s/m.test(block)) throw new Error(`${file}: pure block must not import`)
  return import('data:text/javascript;base64,' + Buffer.from(block, 'utf8').toString('base64'))
}

const admin = await loadPureBlock('src/pages/AdminDashboard.jsx')
const { isTestAccountEmail, fmtDate, sanitizeAnnouncementDisplay } = admin

// ═══ 1 — the test-account predicate ══════════════════════════════════════════
console.log('1 — isTestAccountEmail: QA seeds on the reserved .invalid TLD')
{
  // the two shapes actually sitting in the live list
  t('sectest-…@badger-test.invalid is a test account',
    isTestAccountEmail('sectest-3f21@badger-test.invalid'))
  t('ftesta-…@badger-test.invalid is a test account',
    isTestAccountEmail('ftesta-9c04@badger-test.invalid'))
  t('any *.invalid domain counts, not just badger-test',
    isTestAccountEmail('someone@qa-run.invalid'))
  t('a bare .invalid TLD counts', isTestAccountEmail('nobody@invalid'))
  t('case and surrounding space do not matter',
    isTestAccountEmail('  SecTest-01@BADGER-TEST.INVALID '))

  t('a real customer is not a test account',
    !isTestAccountEmail('tony@thebluejackgroup.com'))
  t('a lookalike LOCAL part is not enough',
    !isTestAccountEmail('badger-test.invalid@gmail.com'))
  t('a domain that merely contains "invalid" is not enough',
    !isTestAccountEmail('user@invalidation.com'))
  t('a domain ending in "invalid" without the dot is not enough',
    !isTestAccountEmail('user@notinvalid'))
  t('null / undefined / empty are safe',
    !isTestAccountEmail(null) && !isTestAccountEmail(undefined) && !isTestAccountEmail(''))
  t('a string with no @ is safe', !isTestAccountEmail('not-an-email'))

  // the count an admin actually reads: 43 total, 25 hidden, 18 real
  const list = [
    ...Array.from({ length: 14 }, (_, i) => ({ email: `sectest-${i}@badger-test.invalid` })),
    ...Array.from({ length: 11 }, (_, i) => ({ email: `ftesta-${i}@badger-test.invalid` })),
    ...Array.from({ length: 18 }, (_, i) => ({ email: `real${i}@example.com` })),
  ]
  eq('43 accounts → 25 test', list.filter(u => isTestAccountEmail(u.email)).length, 25)
  eq('43 accounts → 18 real', list.filter(u => !isTestAccountEmail(u.email)).length, 18)
}

// ═══ 2 — the one date format ═════════════════════════════════════════════════
console.log('2 — fmtDate: one en-US "MMM d, yyyy" for the whole admin surface')
{
  eq('a Date renders MMM d, yyyy', fmtDate(new Date(2026, 7, 16)), 'Aug 16, 2026')
  eq('single-digit days are not padded', fmtDate(new Date(2026, 0, 3)), 'Jan 3, 2026')
  eq('December still reads Dec', fmtDate(new Date(2026, 11, 31)), 'Dec 31, 2026')

  // never the old 8/16/2026 shape, whatever the input type
  const shape = /^[A-Z][a-z]{2} \d{1,2}, \d{4}$/
  t('an ISO timestamp renders in the same shape',
    shape.test(fmtDate('2026-08-16T18:30:00.000Z')))
  t('an epoch number renders in the same shape',
    shape.test(fmtDate(Date.parse('2026-08-16T18:30:00.000Z'))))
  t('never the bare-locale slash format',
    !/\d+\/\d+\/\d+/.test(fmtDate('2026-08-16T18:30:00.000Z')))

  eq('missing values render an em dash, not "Invalid Date"', fmtDate(null), '—')
  eq('empty strings render an em dash', fmtDate(''), '—')
  eq('undefined renders an em dash', fmtDate(undefined), '—')
  eq('unparseable input renders an em dash', fmtDate('not a date'), '—')
  eq('the fallback is overridable', fmtDate(null, 'N/A'), 'N/A')
}

// ═══ 3 — the announcement display sanitizer ══════════════════════════════════
console.log('3 — sanitizeAnnouncementDisplay: render-time tidy-up, stored row untouched')
{
  eq('double spaces collapse',
    sanitizeAnnouncementDisplay('Maintenance  window  tonight.'),
    'Maintenance window tonight.')
  eq('longer space runs collapse too',
    sanitizeAnnouncementDisplay('Deploy    complete'),
    'Deploy complete')
  eq('the contenteditable &nbsp; artifact collapses',
    sanitizeAnnouncementDisplay('Deploy&nbsp; complete'),
    'Deploy complete')
  eq('a literal non-breaking space collapses',
    sanitizeAnnouncementDisplay('Deploy  complete'),
    'Deploy complete')

  eq('an emoji run into text gets a space',
    sanitizeAnnouncementDisplay('🎉New feature shipped'),
    '🎉 New feature shipped')
  eq('an emoji that already has its space is left alone',
    sanitizeAnnouncementDisplay('🎉 New feature shipped'),
    '🎉 New feature shipped')
  eq('a variation-selector emoji is one glyph, not two',
    sanitizeAnnouncementDisplay('⚠️Heads up'),
    '⚠️ Heads up')
  eq('an emoji at the very end gets no trailing space',
    sanitizeAnnouncementDisplay('Ship it 🚀'),
    'Ship it 🚀')

  eq('trailing whitespace is trimmed',
    sanitizeAnnouncementDisplay('Scheduled downtime Sunday.   '),
    'Scheduled downtime Sunday.')
  eq('trailing editor padding is trimmed',
    sanitizeAnnouncementDisplay('Scheduled downtime Sunday.<br><br>'),
    'Scheduled downtime Sunday.')
  eq('trailing &nbsp; padding is trimmed',
    sanitizeAnnouncementDisplay('Scheduled downtime Sunday.&nbsp;'),
    'Scheduled downtime Sunday.')

  // markup is display formatting, not text — it must survive byte-for-byte
  eq('tags and their attributes pass through untouched',
    sanitizeAnnouncementDisplay('<a href="https://x.test/a  b" title="two  spaces">go</a>'),
    '<a href="https://x.test/a  b" title="two  spaces">go</a>')
  eq('formatting inside a body still works',
    sanitizeAnnouncementDisplay('🎉<strong>Big  news</strong>  today  '),
    '🎉<strong>Big news</strong> today')

  eq('non-strings are safe', sanitizeAnnouncementDisplay(null), '')
  eq('undefined is safe', sanitizeAnnouncementDisplay(undefined), '')
  eq('an already-clean body is returned unchanged',
    sanitizeAnnouncementDisplay('🎉 Broadside is out of beta.'),
    '🎉 Broadside is out of beta.')
}

// ═══ 4 — the fixes are actually wired into the pages ═════════════════════════
console.log('4 — wiring: the helpers are used where the audit found the drift')
{
  const a = src('src/pages/AdminDashboard.jsx')
  t('no bare toLocaleDateString() is left in AdminDashboard',
    !/(?<!`)\.toLocaleDateString\(\)/.test(a.replace(/^\s*\*.*$/gm, '')))
  t('the Total Users stat carries a "N total · N test hidden" note',
    /total · \$\{testCount\} test hidden/.test(a))
  t('a Hide test accounts toggle exists', /Hide test accounts/.test(a))
  t('the users table filters on the predicate',
    /hideTestAccounts && isTestAccountEmail/.test(a))
  t('the billing accounts list filters on the predicate too',
    /const billingUsers = hideTestAccounts \? users\.filter/.test(a))
  t('the billing accounts scroll box has bottom padding',
    /max-h-96 overflow-y-auto pb-2/.test(a))
  t('announcement bodies render through the display sanitizer',
    /sanitizeAnnouncementDisplay\(sanitizeAnnouncementHtml\(announcement\.message\)\)/.test(a))
  t('the Action Icons Reference flows instead of using fixed grid rows',
    /Action Icons Reference[\s\S]{0,400}flex flex-wrap/.test(a))
  // v1.37.0: manage-coupons.js gained a reactivate branch, so the
  // "Reactivate in Stripe" link became a real in-app Reactivate button.
  t('inactive coupons no longer render an empty Actions cell',
    /handleToggleActive\(pc\)/.test(a) && !/Reactivate in Stripe/.test(a))
  t('the coupons header links to /plans as "Plans & Pricing"',
    /<Link to="\/plans"[\s\S]{0,160}Plans &amp; Pricing/.test(a))
  t('no "&" standing in for "and" in admin prose', !/crons &amp; background/.test(a))

  const terms = src('src/pages/Terms.jsx')
  t('Terms no longer hardcodes "Back to sign in"', !/Back to sign in/.test(terms))
  t('Terms no longer hardcodes "Return to sign in"', !/Return to sign in/.test(terms))
  t('Terms goes back through history', /navigate\(-1\)/.test(terms))
  t('…with a signed-in / signed-out fallback', /navigate\(user \? '\/' : '\/login'\)/.test(terms))
  t('billing section points at Plans & Pricing, not Settings',
    /<Link to="\/plans"[\s\S]{0,140}Plans &amp; Pricing<\/Link> page/.test(terms))
  t('…and no longer says "Settings page"', !/platform's Settings page/.test(terms))

  const pricing = src('src/pages/Pricing.jsx')
  t('Pricing spells the brand "Badger Board"', !/BadgerBoard/.test(pricing))
  t('highlighted-column dashes get real contrast',
    /isHighlighted \? 'text-gray-500' : 'text-gray-300'/.test(pricing))

  for (const f of ['src/pages/candidate/NotesFiles.jsx', 'src/pages/candidate/RecordViews.jsx']) {
    t(`${f} spells the brand "Badger Board"`, !/BadgerBoard/.test(src(f)))
  }

  const intel = src('src/pages/candidate/IntelViews.jsx')
  t('the Social posts scroller clears its last row',
    /maxHeight: 520, overflowY: 'auto', paddingBottom: 8/.test(intel))

  const bs = src('public/broadside-app.html')
  t('the Session Role select is width-locked to its siblings',
    /width:min\(255px,100%\)/.test(bs))
  t('the pill selects no longer size to their longest option',
    !/min-width:225px/.test(bs))
  t('disabled transport buttons are no longer 35% opacity',
    !/\.tbtn:disabled\{opacity:\.35/.test(bs))
  t('disabled transport buttons get a legible muted treatment',
    /\.tbtn:disabled\{[\s\S]{0,200}opacity:1/.test(bs))
  t('the dossier placeholder ends in a single ellipsis',
    /placeholder="Choose a dossier — type to search…"/.test(bs))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
