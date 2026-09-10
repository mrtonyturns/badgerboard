#!/usr/bin/env node
// Badger Board — VSWEEP: 9 verified visual-defect fixes (profiler report
// reader, the Profiler library table, AdminDashboard, CampaignConnect, and
// the two dashboards).
//
// Same loader trick as tests/r3b.test.mjs: the pure helpers live inside .jsx
// pages, so each page brackets its pure block with
//   // ─── VSWEEP PURE HELPERS BEGIN ───  …  // ─── VSWEEP PURE HELPERS END ───
// and this file slices that block out and imports it as a real ES module. The
// block must therefore stay free of JSX and of imports. Everything else here
// is a source-slice regex assertion against the real file — the same
// convention r3b/r3c use for pieces that can't be isolated as pure functions
// (JSX, or logic that depends on DOMPurify/browser globals reportModel.js
// pulls in for its non-pure exports).
//
// Zero-config: node tests/vsweep.test.mjs

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

async function loadPureBlock(file, tag = 'VSWEEP') {
  const s = src(file)
  const a = s.indexOf(`${tag} PURE HELPERS BEGIN`)
  const b = s.indexOf(`${tag} PURE HELPERS END`)
  if (a < 0 || b < 0 || b < a) throw new Error(`${file}: ${tag} pure-helper sentinels missing`)
  const block = s.slice(s.indexOf('\n', a) + 1, s.lastIndexOf('\n', b))
  if (/^\s*import\s/m.test(block)) throw new Error(`${file}: pure block must not import`)
  return import('data:text/javascript;base64,' + Buffer.from(block, 'utf8').toString('base64'))
}

const admin = await loadPureBlock('src/pages/AdminDashboard.jsx')
const report = await loadPureBlock('src/pages/profiler/reportModel.js')

// ═══ 1 — ReportReader: Verification Flags rows no longer collide ═════════════
console.log('1 — profiler list rows: wrapped claim labels can\'t collide with the source column')
{
  const s = src('src/pages/profiler/ReportReader.jsx')
  t('the list-row flex container aligns items to the top, not to the baseline',
    /case 'list':[\s\S]{0,1100}alignItems: 'flex-start'/.test(s))
  t('baseline alignment on that row is gone', !/case 'list':[\s\S]{0,1100}alignItems: 'baseline'/.test(s))
  t('the label column still has no fixed height (content-driven row)',
    !/case 'list':[\s\S]{0,1200}height: \d/.test(s))
  t('the real column gap between the label and the value/source is untouched',
    /case 'list':[\s\S]{0,1100}gap: 12/.test(s))
}

// ═══ 2 — Report footer: raw "##"/"#" no longer prints literally ═════════════
console.log('2 — the verification-flags footer renders as a heading, not literal "##" text')
{
  const s = src('src/pages/profiler/reportModel.js')
  t('the heading matcher now accepts 1-6 hashes, not just 3-6',
    /const head = line\.match\(\/\^\(#\{1,6\}\)\\s\+\(\.\*\)\$\/\)/.test(s))
  t('the narrower 3-6 matcher is gone', !/\/\^\(#\{3,6\}\)\\s\+\(\.\*\)\$\//.test(s))
  t('a leaked "## SECTION n" line is dropped rather than rendered as a heading',
    /if \(\/\^SECTION\\s\+\\d\/i\.test\(title\)\) \{ i\+\+; continue \}/.test(s))

  // Same pattern asserted against the source above — run it against real
  // footer lines to confirm the *behavior*, not just the source text.
  const headRe = /^(#{1,6})\s+(.*)$/

  const flagsHeading = '## ⚠️ VERIFICATION FLAGS (AI Quality Check)'
  const haikuHeading = '# FLAGS IDENTIFIED'
  const sectionLeak  = '## SECTION 14'
  const notAHeading  = 'Business tax disputes/delinquencies'

  const mFlags = flagsHeading.match(headRe)
  t('"## VERIFICATION FLAGS ..." now matches the heading pattern (used to fall through as plain text)',
    !!mFlags && mFlags[2].includes('VERIFICATION FLAGS'))
  const mHaiku = haikuHeading.match(headRe)
  t('"# FLAGS IDENTIFIED" now matches the heading pattern too',
    !!mHaiku && mHaiku[2] === 'FLAGS IDENTIFIED')
  const mSection = sectionLeak.match(headRe)
  t('a leaked "## SECTION 14" line still matches the pattern (caught by the guard, not by non-matching)',
    !!mSection && mSection[2] === 'SECTION 14')
  t('an ordinary claim line is not mistaken for a heading', !notAHeading.match(headRe))
}

// ═══ 3 — Profiler table FLAGS cell: a consistent separator between chips ═════
console.log('3 — the FLAGS cell separates its chips instead of concatenating them')
{
  const { flagChips } = report
  eq('both chips present', flagChips({ riskLabel: '2 MED', verifyLabel: '1 to verify' }),
    ['2 MED', '1 to verify'])
  eq('only a risk chip', flagChips({ riskLabel: '1 HIGH', verifyLabel: '' }), ['1 HIGH'])
  eq('only a verify chip', flagChips({ riskLabel: '', verifyLabel: '3 to verify' }), ['3 to verify'])
  eq('neither chip ("None" row)', flagChips({ riskLabel: '', verifyLabel: '' }), [])
  eq('undefined input is empty, not a crash', flagChips(undefined), [])
  eq('a caller can always join what comes back with a visible separator',
    flagChips({ riskLabel: '2 MED', verifyLabel: '1 to verify' }).join(' · '),
    '2 MED · 1 to verify')

  const s = src('src/pages/Dossiers.jsx')
  t('a visible middot separator renders between the risk and verify chips',
    /r\.flags\.riskLabel && r\.flags\.verifyLabel[\s\S]{0,120}>·</.test(s))
}

// ═══ 4 — AdminDashboard: Signup Trends buckets every day, scales to the real max ═
console.log('4 — the Signup Trends chart fills 30 honest days instead of 3-4 full-height blocks')
{
  const { bucketSignupsByDay } = admin
  const today = new Date('2026-09-10T12:00:00Z')

  const sparse = [{ date: '2026-09-08', count: 2 }, { date: '2026-09-10', count: 1 }]
  const series = bucketSignupsByDay(sparse, 30, today)
  eq('the window is always the full day count', series.length, 30)
  t('every day carries a date and a numeric count',
    series.every(d => typeof d.date === 'string' && Number.isFinite(d.count)))
  t('the window ends on "today"', series[series.length - 1].date === '2026-09-10')
  eq('a day with no signups buckets to zero, not undefined',
    series.find(d => d.date === '2026-09-09')?.count, 0)
  eq('a day that had signups keeps its real count',
    series.find(d => d.date === '2026-09-08')?.count, 2)
  eq('duplicate/garbage rows are ignored, not crashed on',
    bucketSignupsByDay([{ date: '2026-09-10' }, null, {}], 5, today).map(d => d.count),
    [0, 0, 0, 0, 0])
  eq('a totally empty trends array still yields the full window of zeros',
    bucketSignupsByDay([], 7, today).map(d => d.count), [0, 0, 0, 0, 0, 0, 0])
  eq('non-array input does not throw', bucketSignupsByDay(null, 3, today).length, 3)

  const s = src('src/pages/AdminDashboard.jsx')
  t('the chart scales bar height against a real max, floored at 1 (not always 1)',
    /Math\.max\(1, \.\.\.series\.map\(d => d\.count\)\)/.test(s))
  t('a zero-signup day still draws a visible 2px stub, not a 0px sliver',
    /d\.count > 0 \? `\$\{Math\.max\(2, \(d\.count \/ maxCount\) \* 100\)\}%` : '2px'/.test(s))
  t('bars carry a title tooltip with date + count',
    /title=\{`\$\{fmtDay\(d\.date\)\} · \$\{d\.count\} signup/.test(s))
  t('the axis prints first, middle and last date labels',
    /\{fmtDay\(series\[0\]\.date\)\}/.test(s) && /\{fmtDay\(mid\.date\)\}/.test(s) &&
    /\{fmtDay\(series\[series\.length - 1\]\.date\)\}/.test(s))
  t('the old y-axis-labels-only-show-0-and-1 SVG chart is gone', !/Y-axis labels/.test(s))
}

// ═══ 5 — AdminDashboard: Billing panel never renders a blank Stripe field ════
console.log('5 — Subscription Details always shows a fallback, plus a manual-assignment note')
{
  const s = src('src/pages/AdminDashboard.jsx')
  t('Status falls back to explicit "No Stripe subscription" copy, not a blank string',
    /\{subscriptionData\.status \|\| 'No Stripe subscription'\}/.test(s))
  t('Plan falls back to an em dash', /\{subscriptionData\.plan_name \|\| '—'\}/.test(s))
  t('Next Billing falls back to an em dash',
    /subscriptionData\.current_period_end\s*\n\s*\? fmtDate\(subscriptionData\.current_period_end\)\s*\n\s*: '—'/.test(s))
  t('an admin/beta-assigned plan gets an explicit "not billed via Stripe" note',
    /selectedUser\.plan_source === 'admin' \|\| selectedUser\.beta_mode[\s\S]{0,120}Assigned manually — not billed via Stripe\./.test(s))
}

// ═══ 6 — Dashboards: a skeleton instead of a blank "Loading…" screen ═════════
console.log('6 — both dashboards show a shimmer skeleton while loading, not just plain text')
{
  const shared = src('src/pages/dashboard/shared.jsx')
  t('DashboardSkeleton is exported', /export function DashboardSkeleton/.test(shared))
  t('it mirrors the real layout: a stat row plus two columns',
    /gridTemplateColumns: 'repeat\(4, minmax\(0,1fr\)\)'/.test(shared) &&
    /gridTemplateColumns: '1\.65fr 1fr'/.test(shared))
  t('srOnly is exported for the aria-live fallback text', /export const srOnly = \{/.test(shared))

  for (const file of ['src/pages/dashboard/ActionDashboard.jsx', 'src/pages/dashboard/CandidateDashboard.jsx']) {
    const s = src(file)
    t(`${file}: renders the skeleton while loading`, /<DashboardSkeleton \/>/.test(s))
    t(`${file}: the loading sentence is kept, for screen readers`,
      /aria-live="polite" style=\{srOnly\}>Loading your dashboard…</.test(s))
  }
}

// ═══ 7 — ActionDashboard: Recent activity caps with an in-place expand ═══════
console.log('7 — Recent activity previews a short list instead of always running long')
{
  const s = src('src/pages/dashboard/ActionDashboard.jsx')
  t('a preview-count constant exists', /const ACTIVITY_PREVIEW_COUNT = 4/.test(s))
  t('showAllActivity is plain component state (no extra fetch)',
    /const \[showAllActivity, setShowAllActivity\] = useState\(false\)/.test(s))
  t('the feed renders the preview slice until expanded',
    /\(showAllActivity \? activity : activity\.slice\(0, ACTIVITY_PREVIEW_COUNT\)\)\.map/.test(s))
  t('a "Show all activity" toggle appears only when there is more to show',
    /!showAllActivity && activity\.length > ACTIVITY_PREVIEW_COUNT/.test(s))
  t('expanding sets state only — no network call in the handler',
    /onClick=\{\(\) => setShowAllActivity\(true\)\}/.test(s))
}

// ═══ 8 — CampaignConnect / CandidateDetail — investigated, not changed ═══════
console.log('8 — items intentionally left alone (see report)')
{
  // CampaignConnect.jsx has no position:sticky element of its own, and
  // Layout.jsx's page-title bar is a normal-flow, opaque (bg-white) flex
  // sibling ABOVE the scrollable <main> — not an overlapping sticky bar. No
  // reproducible collision exists in this codebase to fix; asserting that
  // stays true rather than inventing a sticky element that isn't there today.
  const cc = src('src/pages/CampaignConnect.jsx')
  t('CampaignConnect.jsx still has no sticky element of its own (nothing to mis-layer)',
    !/\bsticky\b/.test(cc))

  // CandidateDetail's Overview lives at src/pages/candidate/Overview.jsx —
  // outside this task's scope, and it does not import dashboard/shared.jsx,
  // so nothing here could have fixed it as a side effect.
  const ov = src('src/pages/candidate/Overview.jsx')
  t('candidate/Overview.jsx is confirmed independent of dashboard/shared.jsx (out of scope, untouched)',
    !ov.includes('dashboard/shared'))
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
