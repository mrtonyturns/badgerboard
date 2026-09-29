// scripts/run-unit-tests.mjs — run every self-contained unit suite in tests/.
// Each tests/*.test.mjs is a standalone Node script that prints a
// "N passed, M failed" line and exits non-zero on failure. This runner
// discovers them (so a new suite can never be silently left out of `npm
// test`, which is how test:unit came to cover 4 of 26 files) and fails if
// ANY suite fails or prints no result line.
import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const SKIP = new Set(['gamePlanTasks.integration.test.mjs']) // needs live Supabase env
const files = readdirSync('tests').filter(f => f.endsWith('.test.mjs') && !SKIP.has(f)).sort()

let failedSuites = 0, totalPassed = 0, totalFailed = 0
for (const f of files) {
  const r = spawnSync(process.execPath, [`tests/${f}`], { encoding: 'utf8' })
  const out = (r.stdout || '') + (r.stderr || '')
  const m = out.match(/(\d+) passed,\s*(\d+) failed/) || out.match(/(\d+) passed/)
  const passed = m ? Number(m[1]) : 0
  const failed = m && m[2] !== undefined ? Number(m[2]) : (r.status === 0 ? 0 : 1)
  const ok = r.status === 0 && failed === 0 && m
  totalPassed += passed; totalFailed += failed
  if (!ok) failedSuites++
  console.log(`${ok ? '✓' : '✗'} ${f.padEnd(40)} ${passed} passed, ${failed} failed${!m ? ' (no result line)' : ''}`)
  if (!ok) console.log(out.split('\n').filter(l => /✗|FAIL|Error|error:/i.test(l)).slice(0, 8).map(l => '    ' + l).join('\n'))
}
console.log(`\n${files.length} suites · ${totalPassed} passed · ${totalFailed} failed · ${failedSuites} failing suite(s)`)
process.exit(failedSuites ? 1 : 0)
