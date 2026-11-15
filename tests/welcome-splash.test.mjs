// tests/welcome-splash.test.mjs — the post-sign-in welcome animation wiring.
import { readFileSync } from 'node:fs'
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8')
let passed = 0, failed = 0
const t = (n, c) => { if (c) { passed++; console.log('  ✓ ' + n) } else { failed++; console.log('  ✗ ' + n) } }
const login = read('src/pages/Login.jsx'), layout = read('src/components/Layout.jsx'), splash = read('src/components/WelcomeSplash.jsx'), w = read('src/lib/welcome.js')
t('sign-in arms the splash before going home', /else \{ armWelcomeSplash\(\); navigate\('\/'\) \}/.test(login))
t('layout lazy-loads it only when pending', /lazy\(\(\) => import\('\.\/WelcomeSplash'\)\)/.test(layout) && /showWelcome && <Suspense/.test(layout) && /welcomePending\(\)/.test(layout))
t('the flag is consumed so a refresh never replays it', /sessionStorage\.removeItem\(WELCOME_FLAG\)/.test(splash))
t('?welcome=1 replays it on demand', /get\('welcome'\) === '1'/.test(w))
t('counts down to your own race first, else the next Wisconsin election', /self\?\.election\?\.election_date/.test(splash) && /isUpcoming\(x\.election_date\)/.test(splash))
t('uses the real logo image, not drawn shapes', /src="\/badger-board-logo\.png"/.test(splash))
t('skippable by click or key, and has a reduced-motion version', /onClick=\{\(\) => setLeaving\(true\)\}/.test(splash) && /keydown/.test(splash) && /prefers-reduced-motion/.test(splash))
t('never waits forever for the number', /DATA_WAIT_MS/.test(splash))
console.log(`\n${passed} passed, ${failed} failed`)
if (failed) process.exitCode = 1
