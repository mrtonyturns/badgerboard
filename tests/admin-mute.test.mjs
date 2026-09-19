#!/usr/bin/env node
// Badger Board — admin mute-emails + reset-to-free controls (Account
// Management tab). Source-level checks only: confirms the new row actions
// are wired to the admin-manage-access actions the backend already
// implements (mute_emails / unmute_emails / reset_to_free), that the
// destructive confirm() prompts exist, and that the lucide icons they use
// are imported. Zero-config: node tests/admin-mute.test.mjs

import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const src  = (p) => readFileSync(join(ROOT, p), 'utf8')

let pass = 0, fail = 0
const t = (name, cond) => { cond ? pass++ : fail++; console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${name}`) }

const admin = src('src/pages/AdminDashboard.jsx')

// ─── 1: icons imported from lucide-react ─────────────────────────────────────
console.log('1 — new icons imported from lucide-react')

const lucideImportBlock = admin.match(/import\s*{([\s\S]*?)}\s*from\s*'lucide-react'/)?.[1] || ''
t('Bell is imported', /\bBell\b/.test(lucideImportBlock))
t('BellOff is imported', /\bBellOff\b/.test(lucideImportBlock))
t('RotateCcw is imported', /\bRotateCcw\b/.test(lucideImportBlock))

// ─── 2: accessCall is threaded into AccountManagementTab ─────────────────────
console.log('2 — accessCall helper reaches the Account Management tab')

t(
  'AccountManagementTab is rendered with accessCall prop',
  /<AccountManagementTab[^>]*\baccessCall={accessCall}/.test(admin)
)
t(
  'AccountManagementTab destructures accessCall',
  /const AccountManagementTab = \(\{[^}]*\baccessCall\b[^}]*\}\)/.test(admin)
)

// ─── 3: mute_emails / unmute_emails wired ────────────────────────────────────
console.log('3 — mute/unmute actions wired to admin-manage-access')

t('mute_emails action string is present', admin.includes("'mute_emails'"))
t('unmute_emails action string is present', admin.includes("'unmute_emails'"))
t(
  'mute/unmute calls go through accessCall(...)',
  /accessCall\(\s*muting \? 'mute_emails' : 'unmute_emails'/.test(admin)
)
t(
  'mute confirm prompt matches the required copy',
  admin.includes('Mute ALL emails to ${u.email}? Includes payment and security alerts.')
)
t(
  'mute confirmation is gated to the muting direction only (no confirm on unmute)',
  /if \(muting && !window\.confirm\(`Mute ALL emails/.test(admin)
)
t('row button toggles Bell / BellOff based on emails_muted', /u\.emails_muted \? <BellOff /.test(admin))
t('emails_muted pill rendered next to the email', /u\.emails_muted && \(/.test(admin) && admin.includes('>Muted<'))
t(
  'plan sub-line appends "· emails muted" when muted',
  admin.includes("u.emails_muted ? ' · emails muted' : ''")
)

// ─── 4: reset_to_free wired ───────────────────────────────────────────────────
console.log('4 — reset_to_free action wired to admin-manage-access')

t('reset_to_free action string is present', admin.includes("'reset_to_free'"))
t(
  'reset_to_free call goes through accessCall(...)',
  /accessCall\('reset_to_free', \{ user_id: u\.id \}\)/.test(admin)
)
t(
  'reset confirm prompt matches the required copy',
  admin.includes('Reset ${u.email} to the free Scout plan? Clears plan, beta and trial access.')
)
t('RotateCcw icon used for the reset button', /<RotateCcw className="w-4 h-4" \/>/.test(admin))
t(
  '409 error message is surfaced verbatim (parsed from the response body, not swallowed)',
  /JSON\.parse\(err\.message\)\?\.error/.test(admin)
)

// ─── 5: pending state disables the row buttons while a call is in flight ────
console.log('5 — buttons disable while a mute/reset call is pending')

t('accessPending state exists', /const \[accessPending, setAccessPending\] = useState\(new Set\(\)\)/.test(admin))
t(
  'mute/unmute button is disabled while pending',
  /onClick={\(\) => handleMuteToggle\(u\)}[\s\S]{0,120}disabled={accessPending\.has\(u\.id\)}/.test(admin)
)
t(
  'reset-to-free button is disabled while pending',
  /onClick={\(\) => handleResetToFree\(u\)}[\s\S]{0,120}disabled={accessPending\.has\(u\.id\)}/.test(admin)
)

// ─── 6: documented in the Action Icons Reference legend ──────────────────────
console.log('6 — new actions documented in the Action Icons Reference legend')

t('legend documents the mute/unmute action', /icon: BellOff, label: 'Mute\/Unmute Emails'/.test(admin))
t('legend documents the reset-to-free action', /icon: RotateCcw, label: 'Reset to Free'/.test(admin))

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
