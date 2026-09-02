#!/usr/bin/env node
// Badger Board — key-weakness extraction (Opposition tab "Key weaknesses").
//
// Regression for the bug where schema field labels from the profile
// ("**Background Narrative:**", "**WEC Committee Filing:**") were stored as
// weaknesses and rendered as five empty cards.
//
// Zero-config: node tests/weaknesses.test.mjs

import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { createRequire } from 'module'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const src  = (p) => readFileSync(join(ROOT, p), 'utf8')
const require = createRequire(import.meta.url)

let pass = 0, fail = 0
const t = (name, cond) => { cond ? pass++ : fail++; console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${name}`) }
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) console.log(`      got ${JSON.stringify(got)} · want ${JSON.stringify(want)}`)
  t(name, ok)
}

const esm = await import('../src/lib/weaknesses.js')
const cjs = require('../netlify/functions/_weaknesses.js')
const { extractWeaknesses, isRealWeakness, isLabelOnly, cleanWeaknessText } = esm

// ═══ The two copies must not drift ═══════════════════════════════════════════
console.log('src/lib/weaknesses.js and netlify/functions/_weaknesses.js stay in sync')
const block = (s) => {
  const a = s.indexOf('WEAKNESSES PURE HELPERS BEGIN'), b = s.indexOf('WEAKNESSES PURE HELPERS END')
  return s.slice(s.indexOf('\n', a) + 1, s.lastIndexOf('\n', b))
}
t('sentinel blocks are byte-identical', block(src('src/lib/weaknesses.js')) === block(src('netlify/functions/_weaknesses.js')))
t('CJS mirror exports the same helpers', ['extractWeaknesses', 'isRealWeakness', 'isLabelOnly', 'cleanWeaknessText'].every(k => typeof cjs[k] === 'function'))

// ═══ Label-only lines are never weaknesses ═══════════════════════════════════
console.log('isLabelOnly / isRealWeakness')
for (const label of ['Background Narrative:', '**Prior Campaign Donations Made:**', 'WEC Committee Filing:', '**Public Testimony / Statements:**', 'Voter Registration Match:'])
  t(`"${label}" is a bare label`, isLabelOnly(label) && !isRealWeakness(label))
t('a label with a non-finding value is still label-only', isLabelOnly('**Bankruptcy:** None') && isLabelOnly('Committees: —'))
t('a label with a real value is a weakness', isRealWeakness('**Tax lien:** $12,000 UCC lien filed 2019 (WDFI)'))
t('empty / nullish / placeholder-only are not weaknesses', !isRealWeakness('') && !isRealWeakness(null) && !isRealWeakness('[RESEARCH REQUIRED]') && !isRealWeakness('**[KNOWN]**'))
t('headings are not weaknesses', !isRealWeakness('## SECTION 6: CONTROVERSIES'))
t('an object entry is judged by its text', isRealWeakness({ text: 'Missed 14 of 22 board votes', severity: 'high' }) && !isRealWeakness({ text: 'Background Narrative:' }))
t('short real text still renders (render filter is lenient)', isRealWeakness('Missed 14 of 22 board votes'))
eq('markdown is stripped from stored text',
  cleanWeaknessText('- **Tax lien:** $12,000 lien [3] **[KNOWN]**'), 'Tax lien: $12,000 lien')

// ═══ Extraction ══════════════════════════════════════════════════════════════
console.log('extractWeaknesses()')
const doc = `## SECTION 1: EXECUTIVE SUMMARY
**[HIGH]**
Jane Doe has faced no major controversies; weaknesses are mostly thin fundraising.

## SECTION 2: IDENTITY & BIOGRAPHY
**Background Narrative:**
Jane grew up in Wausau.

## SECTION 4: CIVIC & POLITICAL BACKGROUND
**Prior Campaign Donations Made:**
**WEC Committee Filing:** (committee name, filing date — or NOT FOUND)
**Public Testimony / Statements:**
**Voter Registration Match:**

## SECTION 6: CONTROVERSIES & OPPOSITION RESEARCH
**[MEDIUM]**

| Issue | Date | Summary (2 sent.) | Source | Response | Status | Confidence |
|---|---|---|---|---|---|---|
| Delinquent property tax | 2021 | Marathon County lists a $3,400 delinquent tax balance on the Rib Mountain parcel for tax year 2021. Paid in 2023. [1] | DOR | None | Resolved | [KNOWN] |
| Campaign finance | — | [RESEARCH REQUIRED] | WEC | | | |
| Board attendance | 2022-23 | Missed 14 of 22 county board votes. | County minutes [2] | | Open | [Confirmed] |

- **Tax lien:** $12,000 UCC lien filed by Nicolet Bank in 2019 against Doe Landscaping LLC (WDFI). **[KNOWN]**
- **Bankruptcy:** None found in PACER.
- [ ] Digital public record review — [RESEARCH REQUIRED]
**Inconsistencies in public record:**
*Label all items RESEARCH REQUIRED unless sourced.*

## SECTION 12: CAMPAIGN
**SWOT Analysis**
- **Strengths** (advantages):
  - Strong name recognition from 12 years on the county board.
- **Weaknesses** (documented vulnerabilities):
  - Thin fundraising: only $4,200 raised through the July 2026 WEC report.
- **Opportunities** (external):
  - Open seat.

## SECTION 13: ATTACK & DEFENSE
**Attack angles (for opponents):**

| Vulnerability | Evidence | Framing | Src |
|---|---|---|---|
| Absentee legislator | Missed 14 of 22 board votes in 2022-23 | "Doesn't show up for work" | Minutes |

**Defense prep (for candidate):**
| Vulnerability | Evidence | Framing | Src |
| Should not appear | this is defense-prep content that is long enough | x | y |
`
const got = extractWeaknesses(doc)
eq('rows, bullets, SWOT weaknesses and attack angles are lifted in order', got, [
  'Delinquent property tax: Marathon County lists a $3,400 delinquent tax balance on the Rib Mountain parcel for tax year 2021. Paid in 2023.',
  'Board attendance: Missed 14 of 22 county board votes.',
  'Tax lien: $12,000 UCC lien filed by Nicolet Bank in 2019 against Doe Landscaping LLC (WDFI).',
  'Thin fundraising: only $4,200 raised through the July 2026 WEC report.',
  'Absentee legislator: Missed 14 of 22 board votes in 2022-23',
])
t('no schema field label leaks in', !got.some(w => /Background Narrative|Donations Made|Committee Filing|Public Testimony|Registration Match|Inconsistencies/i.test(w)))
t('every extracted entry passes the render filter', got.every(w => isRealWeakness(w)))
t('the "Controversies" word in Section 1 does not start capture', !got.some(w => /Wausau/.test(w)))
t('Strengths / Opportunities bullets are not weaknesses', !got.some(w => /name recognition|Open seat/.test(w)))
t('defense-prep rows are excluded', !got.some(w => /Should not appear/.test(w)))
t('checkbox research-framework items are excluded', !got.some(w => /Digital public record/.test(w)))
t('a Scout-gated Section 6 yields nothing', extractWeaknesses(`## SECTION 6: X\n**[LOCKED — PAID PLANS]**\n\n*This section is available on paid plans.*\n\n## SECTION 7: Y\n- Real bullet that is long enough to count here.`).length === 0)
eq('empty / nullish content', [extractWeaknesses(''), extractWeaknesses(null)], [[], []])
t('caps at 8', extractWeaknesses('## SECTION 6: X\n' + Array.from({ length: 12 }, (_, i) => `- Documented finding number ${i} with enough detail to count.`).join('\n')).length === 8)
t('the ESM and CJS copies agree on the sample', JSON.stringify(cjs.extractWeaknesses(doc)) === JSON.stringify(got))

// ═══ Wiring ══════════════════════════════════════════════════════════════════
console.log('wiring')
t('the background function syncs weaknesses after saving the dossier',
  /syncCandidateWeaknesses\(candidate_id, content/.test(src('netlify/functions/generate-dossier-background.js')))
t('the Opposition tab filters label-only rows before counting',
  /\.filter\(w => isRealWeakness\(w\)\)/.test(src('src/pages/candidate/IntelViews.jsx')))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
