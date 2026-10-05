#!/usr/bin/env node
// Badger Board — candidate sweep: notes/files write races, the candidates CSV
// import (office match, parser, dedupe), Discover status, Profiler research
// context + delete, Recruit poll/search isolation + CSV guard, map popup XSS,
// safe website hrefs, Prospecting name columns, the Offices county panel and
// CandidateDetail delete/status error handling.
//
// Pure helpers (src/lib/candidateImport.js, src/lib/safeUrl.js) are tested
// by behaviour; JSX pages by source assertions, same convention as vsweep.
//
// Zero-config: node tests/candidate-sweep.test.mjs

import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { matchImportOffice, pickNameColumns, rowName } from '../src/lib/candidateImport.js'
import { safeHttpUrl } from '../src/lib/safeUrl.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const src  = (p) => readFileSync(join(ROOT, p), 'utf8')

let pass = 0, fail = 0
const t = (name, cond) => { cond ? pass++ : fail++; console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${name}`) }
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) console.log(`      got ${JSON.stringify(got)} · want ${JSON.stringify(want)}`)
  t(name, ok)
}

// ── matchImportOffice ───────────────────────────────────────────────────────
console.log('\nmatchImportOffice')
const offices = [
  { id: 'ad86', name: 'State Assembly Representative', district_number: '86', district_name: '86th Assembly District' },
  { id: 'ad87', name: 'State Assembly Representative', district_number: '87', district_name: '87th Assembly District' },
  { id: 'mayW', name: 'Mayor', city: 'Wausau' },
  { id: 'mayM', name: 'Mayor', city: 'Madison' },
  { id: 'gov',  name: 'Governor' },
  { id: 'sen',  name: 'State Senator', district_number: '29' },
]
eq('exact unique name matches', matchImportOffice(offices, { office: 'governor' })?.id, 'gov')
eq('case/space-normalized', matchImportOffice(offices, { office: '  GOVERNOR ' })?.id, 'gov')
eq('substring no longer matches', matchImportOffice(offices, { office: 'Gov' }), null)
eq('blank cell → null', matchImportOffice(offices, { office: '   ' }), null)
eq('ambiguous name, no hint → null', matchImportOffice(offices, { office: 'State Assembly Representative' }), null)
eq('district disambiguates (number)', matchImportOffice(offices, { office: 'State Assembly Representative', district: '87' })?.id, 'ad87')
eq('district disambiguates ("District 086")', matchImportOffice(offices, { office: 'State Assembly Representative', district: 'District 086' })?.id, 'ad86')
eq('unknown district → null', matchImportOffice(offices, { office: 'State Assembly Representative', district: '12' }), null)
eq('city disambiguates', matchImportOffice(offices, { office: 'Mayor', city: 'wausau' })?.id, 'mayW')
eq('"City of Madison" normalizes', matchImportOffice(offices, { office: 'Mayor', city: 'City of Madison' })?.id, 'mayM')
eq('contradicting district on a unique name → null', matchImportOffice(offices, { office: 'State Senator', district: '12' }), null)
eq('unique name, office without district accepts any hint', matchImportOffice(offices, { office: 'Governor', district: '5' })?.id, 'gov')

// ── pickNameColumns / rowName ───────────────────────────────────────────────
console.log('\npickNameColumns')
eq('"name"', pickNameColumns(['email', 'name']), { full: 1 })
eq('first+last joined', pickNameColumns(['first name', 'last name', 'email']), { first: 0, last: 1 })
eq('candidate name beats office name', pickNameColumns(['office name', 'candidate name']), { full: 1 })
eq('full_name underscore', pickNameColumns(['full_name']), { full: 0 })
eq('loose fallback', pickNameColumns(['nominee name', 'phone']), { full: 0 })
eq('none → null', pickNameColumns(['email', 'phone']), null)
eq('rowName joins first/last', rowName([' Jane ', 'Doe'], { first: 0, last: 1 }), 'Jane Doe')
eq('rowName first only when last blank', rowName(['Jane', ''], { first: 0, last: 1 }), 'Jane')
eq('rowName full', rowName(['x', ' Pat Lee '], { full: 1 }), 'Pat Lee')

// ── safeHttpUrl ─────────────────────────────────────────────────────────────
console.log('\nsafeHttpUrl')
eq('https kept', safeHttpUrl('https://example.com/a'), 'https://example.com/a')
eq('http kept', safeHttpUrl('http://example.com'), 'http://example.com/')
eq('bare domain gets https', safeHttpUrl('example.com'), 'https://example.com/')
eq('host:port is not a scheme', safeHttpUrl('example.com:8080/x'), 'https://example.com:8080/x')
eq('javascript: refused', safeHttpUrl('javascript:alert(1)'), null)
eq('JavaScript: mixed case refused', safeHttpUrl(' JavaScript:alert(1)'), null)
eq('data: refused', safeHttpUrl('data:text/html,<script>'), null)
eq('embedded whitespace refused', safeHttpUrl('java\nscript:alert(1)'), null)
eq('single word refused', safeHttpUrl('notaurl'), null)
eq('empty → null', safeHttpUrl(''), null)

// ── NotesFiles (bug 1) ──────────────────────────────────────────────────────
console.log('\nNotesFiles.jsx')
const nf = src('src/pages/candidate/NotesFiles.jsx')
t('keeps a latest-data ref', /const dataRef = useRef\(data\)/.test(nf))
t('persist takes an updater of the latest data', /const previous = dataRef\.current\s*\n\s*const newData = update\(previous\)/.test(nf))
t('writes are chained', /writeChainRef\.current\.then\(run, run\)/.test(nf))
t('no persist builds from captured `data`', !/persist\(\{\s*\.\.\.data/.test(nf) && !/\.\.\.data,/.test(nf))
t('upload input disabled while uploading', /type="file"\s*\n\s*disabled=\{uploading\}/.test(nf))
t('drop zone ignores drops while uploading', /if \(uploading\) return\s*\n\s*const file = e\.dataTransfer/.test(nf))
t('uploadFile re-entrancy guard', /if \(!file \|\| uploadingRef\.current\) return/.test(nf))

// ── Candidates (bugs 2, 3, 4, 9) ────────────────────────────────────────────
console.log('\nCandidates.jsx')
const cj = src('src/pages/Candidates.jsx')
t('office matched via matchImportOffice', /matchImportOffice\(offices, \{/.test(cj))
t('substring office match removed', !/o\.name\.toLowerCase\(\)\.includes\(oName\)/.test(cj))
t('CSV uses parseCsvRows', /parseCsvRows\(ev\.target\.result\)/.test(cj) && !/text\.split\(\/\\r\?\\n\/\)/.test(cj))
t('dedupe reads all of the user\'s names', /\.from\('candidates'\)\s*\n\s*\.select\('name'\)\s*\n\s*\.eq\('created_by', user\.id\)/.test(cj))
t('dedupe no longer uses filtered list', !/new Set\(candidates\.map/.test(cj))
t('inserted names added to the set', /inserted\+\+; existingNames\.add\(/.test(cj))
t('Discover status normalized', /status: normalizeStatus\(candidate\.status\) \|\| 'exploring'/.test(cj))
t('Discover Add disabled while saving', /disabled=\{saveProgress\[`result_\$\{i\}`\] === true \|\|/.test(cj))
t('website href is safeHttpUrl', /href=\{safeHttpUrl\(c\.website\)\}/.test(cj) && !/href=\{c\.website\}/.test(cj))

// ── Dossiers (bugs 5, 6) ────────────────────────────────────────────────────
console.log('\nDossiers.jsx')
const dj = src('src/pages/Dossiers.jsx')
t('research context filled once per candidate', /if \(researchFilledForRef\.current === candidateId\) return/.test(dj))
t('delete error checked', /const \{ error: delErr \} = await deleteDossier\(confirmDelete\)/.test(dj))
t('delete error surfaced', /setError\(`Could not delete this profile/.test(dj))

// ── Recruit (bugs 7, 8) ─────────────────────────────────────────────────────
console.log('\nRecruit.jsx')
const rj = src('src/pages/Recruit.jsx')
t('loadProspects ignores non-active search', /if \(activeSearchIdRef\.current !== searchId\) return/.test(rj))
const openBody = rj.slice(rj.indexOf('const openSearch = async'), rj.indexOf('const openSearch = async') + 800)
t('openSearch invalidates the poll', /pollGenRef\.current\+\+/.test(openBody) && /activeSearchIdRef\.current = s\.id/.test(openBody))
t('createSearch marks the new search active', /activeSearchIdRef\.current = search\.id/.test(rj))
t('CSV cell uses csvEscape (formula guard)', /const cell = csvEscape/.test(rj))

// ── LeafletMapView (bug 9) ──────────────────────────────────────────────────
console.log('\nLeafletMapView.jsx')
const lj = src('src/components/LeafletMapView.jsx')
t('candidate name escaped', /<b>\$\{escapeHtml\(c\.name\)\}<\/b>/.test(lj))
t('party + office escaped', /escapeHtml\(c\.party\)/.test(lj) && /escapeHtml\(c\.office\.name\)/.test(lj))
t('no raw ${c.name} in popup', !/<b>\$\{c\.name\}<\/b>/.test(lj))

// ── ProfileData (bug 9) ─────────────────────────────────────────────────────
console.log('\nProfileData.jsx')
const pd = src('src/pages/candidate/ProfileData.jsx')
t('website href is safeHttpUrl', /href=\{safeHttpUrl\(candidate\.website\)\}/.test(pd) && !/href=\{candidate\.website\}/.test(pd))
t('facebook href is safeHttpUrl', !/href=\{candidate\.facebook_url\}/.test(pd))

// ── Prospecting (bug 10) ────────────────────────────────────────────────────
console.log('\nProspecting.jsx')
const pj = src('src/pages/Prospecting.jsx')
t('uses pickNameColumns', /pickNameColumns\(headers\)/.test(pj) && /rowName\(r, nameCols\)/.test(pj))
t('old first-containing-name pick removed', !/find\('name', 'full name', 'candidate'\)/.test(pj))

// ── Offices (bug 11) ────────────────────────────────────────────────────────
console.log('\nOffices.jsx')
const oj = src('src/pages/Offices.jsx')
t('set county is authoritative', /if \(o\.county\) return norm\(o\.county\) === countyName/.test(oj))

// ── CandidateDetail + Overview (bug 12) ─────────────────────────────────────
console.log('\nCandidateDetail.jsx / Overview.jsx')
const cd = src('src/pages/CandidateDetail.jsx')
const delBody = cd.slice(cd.indexOf('const handleDelete = async'), cd.indexOf('const handleAcceptStatus'))
t('delete error checked before navigating', /const \{ error \} = await deleteCandidate\(id\)/.test(delBody)
  && delBody.indexOf('if (error)') < delBody.indexOf("nav('/candidates')"))
t('handleAcceptStatus throws on error', /if \(error\) throw new Error\(error\.message/.test(cd))
const ov = src('src/pages/candidate/Overview.jsx')
t('status card catches rejection', /try \{ await onAccept\(rec\); setDone\(true\) \}\s*\n\s*catch \(e\) \{ setErr\(/.test(ov))
t('status card renders the error', /\{err && <div/.test(ov))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
