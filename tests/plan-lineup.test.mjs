// tests/plan-lineup.test.mjs — Nov 15 2026 plan-family lineup (Tony's broad
// cut list): which features each family has, the admin/beta bypass, and that
// every entry point (nav, routes, server endpoints, cron) follows the lineup.
// Prints "N passed, M failed".
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const T = await import('../src/lib/tiers.js')
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8')

let passed = 0, failed = 0
const t = (n, c, d) => { if (c) { passed++; console.log('  ✓ ' + n) } else { failed++; console.log('  ✗ ' + n + (d ? ' — ' + d : '')) } }

console.log('\n[1] candidate plans')
for (const k of T.CANDIDATE_PLAN_ORDER) {
  const f = T.PLAN_CONFIG[k].features
  t(`${k}: field home, events, calendar feed`, f.fieldHome && f.events && f.calendarFeed)
  t(`${k}: no map / CSV / autofill / discovery / sharing / offices / voter lists / compare / results`,
    !f.candidateMap && !f.csvImport && !f.autofill && !f.discoverCandidates && !f.sharing && !f.offices && !f.voterLists && !f.compare && !f.electionResults)
  t(`${k}: unlock copy never sells a cut feature`, ![...T.PLAN_CONFIG[k].unlocks, ...T.PLAN_CONFIG[k].nextUnlocks].some(u => /compare|csv import|discovery/i.test(u)))
}
t('paid candidate plans keep Broadside; Scout does not', ['c_monitor', 'c_active', 'c_campaign'].every(k => T.hasFeature(k, 'broadside')) && !T.hasFeature('scout', 'broadside'))

console.log('\n[2] action plans')
for (const k of T.ACTION_PLAN_ORDER) {
  const f = T.PLAN_CONFIG[k].features
  t(`${k}: keeps tracking tools, sharing, offices, voter lists, compare (back), prospecting, recruit`,
    f.candidateMap && f.csvImport && f.autofill && f.discoverCandidates && f.sharing && f.offices && f.voterLists && f.compare && f.prospecting && f.recruit)
  t(`${k}: no events, Broadside, calendar feed, results, field home`, !f.events && !f.broadside && !f.calendarFeed && !f.electionResults && !f.fieldHome)
  t(`${k}: unlock copy never sells a cut feature`, ![...T.PLAN_CONFIG[k].unlocks, ...T.PLAN_CONFIG[k].nextUnlocks].some(u => /broadside|events|calendar/i.test(u)))
}

console.log('\n[3] planAllows bypass')
t('admin and beta pass anything', T.planAllows({ plan: 'a_campaign', source: 'admin' }, 'events') && T.planAllows({ plan: 'a_campaign', source: 'beta' }, 'broadside'))
t('paid user follows the plan', !T.planAllows({ plan: 'a_monitor', source: 'paid' }, 'events') && T.planAllows({ plan: 'c_active', source: 'paid' }, 'events'))
t('bare plan key works', T.planAllows('a_active', 'compare') && !T.planAllows('c_campaign', 'compare'))

console.log('\n[4] entry points follow the lineup')
const layout = read('src/components/Layout.jsx'), app = read('src/App.jsx')
t('nav: Offices, Events, Voter Lists are feature-gated', /label: 'Offices', feature: 'offices'/.test(layout) && /label: 'Events', feature: 'events'/.test(layout) && /label: 'Voter Lists', feature: 'voterLists'/.test(layout))
t('nav: candidate plans call the dashboard "Home"', /candidateLabel: 'Home'/.test(layout))
t('routes: offices, places, voter-lists, events behind FeatureRoute', ['offices', 'voterLists', 'events'].every(f => app.includes(`<FeatureRoute feature="${f}">`)) && /places\/:countySlug\/:nameSlug" element={<FeatureRoute feature="offices">/.test(app))
t('Compare is back (flag on, gated by plan feature)', /COMPARE_ENABLED\s+= true/.test(read('src/lib/featureFlags.js')))
t('candidate home is the Field home', /<FieldHome \/>/.test(read('src/pages/Dashboard.jsx')))
t('Candidates page goes basic without candidateMap', /basicPage = !useFeature\('candidateMap'\)/.test(read('src/pages/Candidates.jsx')))
t('Profiler hides Share without the sharing feature', /canShare && <Btn onClick=\{\(\) => setShowShare\(true\)\}/.test(read('src/pages/Dossiers.jsx')))
t('Settings hides the Calendars pane without calendarFeed', /useFeature\('calendarFeed'\)/.test(read('src/pages/Settings.jsx')))

console.log('\n[5] server gates')
t('events research gated on events', /planAllowsUser\(authUser, 'events'\)/.test(read('netlify/functions/research-district-events-background.js')))
t('discovery + autofill gated on their features', /planAllowsUser\(caller, 'discoverCandidates'\)/.test(read('netlify/functions/discover-candidates.js')) && /planAllowsUser\(caller, 'autofill'\)/.test(read('netlify/functions/autofill-candidate.js')))
t('share links gated on sharing', /planAllowsUser\(user, 'sharing'\)/.test(read('netlify/functions/create-dossier-share.js')))
t('Broadside gated on broadside (both brains)', /planAllows\(ent, 'broadside'\)/.test(read('netlify/functions/_shared.js')) && /planAllows\(ent, 'broadside'\)/.test(read('netlify/functions/broadside-brain-stream.mjs')))
const gate = require('../netlify/functions/_plan-gate.js')
t('plan gate exports a helper and messages', typeof gate.planAllowsUser === 'function' && gate.FEATURE_MESSAGES.events)

console.log('\n[6] election results jobs are off')
const toml = read('netlify.toml')
t('poller has no active schedule', /\[functions\."election-results-poller"\]\s*\n\s*# schedule/.test(toml))
t('certification watch has no active schedule', /\[functions\."certification-watch"\]\s*\n\s*# schedule/.test(toml))

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) process.exitCode = 1
