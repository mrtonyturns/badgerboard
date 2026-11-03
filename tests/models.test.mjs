// tests/models.test.mjs — the shared AI model registry (_models.js) and the
// platform-wide rule that every Claude call goes through it on the current
// model generation. Prints "N passed, M failed" for scripts/run-unit-tests.mjs.
import { createRequire } from 'node:module'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const M = require('../netlify/functions/_models.js')
const ROOT = new URL('..', import.meta.url).pathname
const FN_DIR = join(ROOT, 'netlify/functions')

let passed = 0, failed = 0
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')) }
}

console.log('\n[1] registry — current-generation ids')
{
  check('Claude QUALITY is Opus 5.5', M.MODELS.CLAUDE_QUALITY === 'claude-opus-5-5')
  check('Claude BALANCED is Sonnet 5.5', M.MODELS.CLAUDE_BALANCED === 'claude-sonnet-5-5')
  check('Claude FAST is Haiku 5.5', M.MODELS.CLAUDE_FAST === 'claude-haiku-5-5')
  check('Grok is 4.7', M.MODELS.GROK === 'grok-4.7')
  check('Gemini is 3.8 Flash', M.MODELS.GEMINI === 'gemini-3.8-flash')
  check('Perplexity sonar / sonar-pro', M.MODELS.PPLX === 'sonar' && M.MODELS.PPLX_PRO === 'sonar-pro')
  check('no dated snapshot ids (aliases only, so retirements do not break us)', !Object.values(M.MODELS).some(v => /\d{8}$/.test(v)))
}

console.log('\n[2] tier options follow the 5.5 request rules')
{
  const all = [M.CLAUDE.QUALITY, M.CLAUDE.BALANCED, M.CLAUDE.FAST]
  check('no tier sends temperature/top_p/top_k', all.every(o => !('temperature' in o) && !('top_p' in o) && !('top_k' in o)))
  check('QUALITY never disables thinking (Opus 5.5 returns 400)', !M.CLAUDE.QUALITY.thinking)
  check('QUALITY pins effort explicitly', M.CLAUDE.QUALITY.output_config?.effort === 'medium')
  check('BALANCED skips up-front thinking (between_tools) at low effort', M.CLAUDE.BALANCED.thinking?.type === 'between_tools' && M.CLAUDE.BALANCED.output_config?.effort === 'low')
  check('FAST turns thinking off so max_tokens is the text budget', M.CLAUDE.FAST.thinking?.type === 'disabled')
  check('FAST does not force xhigh/max (thinking:disabled is rejected there)', !['xhigh', 'max'].includes(M.CLAUDE.FAST.output_config?.effort))
}

console.log('\n[3] claudeMaxTokens — headroom for thinking')
{
  check('doubles the text budget', M.claudeMaxTokens(6000) === 12000)
  check('floor of 2048 for tiny budgets', M.claudeMaxTokens(100) === 2048)
  check('capped at the 128k output limit', M.claudeMaxTokens(100000) === 128000)
}

console.log('\n[4] claudeText — reads text blocks by type')
{
  const d = { content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'Hello ' }, { type: 'tool_use', name: 'web_search' }, { type: 'text', text: 'world' }] }
  check('skips thinking + tool blocks, joins text', M.claudeText(d) === 'Hello world')
  check('empty string for no content', M.claudeText({}) === '' && M.claudeText(null) === '')
  check('ignores malformed blocks', M.claudeText({ content: [null, { type: 'text' }, { type: 'text', text: 'ok' }] }) === 'ok')
}

console.log('\n[5] claudeFetch — 400 safety net')
{
  const calls = []
  const realFetch = globalThis.fetch
  const mk = (status, body) => ({ status, ok: status < 300, clone() { return this }, async text() { return body }, async json() { return JSON.parse(body) } })
  globalThis.fetch = async (url, init) => {
    calls.push(JSON.parse(init.body))
    if (calls.length === 1) return mk(400, '{"error":{"message":"thinking: not supported"}}')
    return mk(200, '{"content":[{"type":"text","text":"ok"}]}')
  }
  const r = await M.claudeFetch({ apiKey: 'k', body: { model: 'x', max_tokens: 10, thinking: { type: 'disabled' }, output_config: { effort: 'low' }, messages: [] } })
  check('retries once after a 400 that names a generation field', calls.length === 2 && r.status === 200)
  check('retry strips thinking/output_config but keeps the rest', !('thinking' in calls[1]) && !('output_config' in calls[1]) && calls[1].max_tokens === 10 && calls[1].model === 'x')
  check('first attempt sent the fields untouched', calls[0].thinking?.type === 'disabled')

  calls.length = 0
  globalThis.fetch = async (url, init) => { calls.push(JSON.parse(init.body)); return mk(400, '{"error":{"message":"messages: required"}}') }
  const r2 = await M.claudeFetch({ apiKey: 'k', body: { model: 'x', max_tokens: 10, thinking: { type: 'disabled' } } })
  check('does not retry an unrelated 400', calls.length === 1 && r2.status === 400)

  calls.length = 0
  globalThis.fetch = async (url, init) => { calls.push(JSON.parse(init.body)); return mk(400, '{"error":{"message":"thinking"}}') }
  const r3 = await M.claudeFetch({ apiKey: 'k', body: { model: 'x', max_tokens: 10 } })
  check('does not retry when nothing is strippable', calls.length === 1 && r3.status === 400)

  let hdr = null
  globalThis.fetch = async (url, init) => { hdr = init.headers; return mk(200, '{}') }
  await M.claudeFetch({ apiKey: 'secret', body: { model: 'x' }, headers: { 'anthropic-beta': 'b' } })
  check('sends key, version and extra headers', hdr['x-api-key'] === 'secret' && hdr['anthropic-version'] === '2023-06-01' && hdr['anthropic-beta'] === 'b')
  globalThis.fetch = realFetch
}

console.log('\n[6] every function uses the registry (no stale ids / unsafe reads)')
{
  const files = readdirSync(FN_DIR).filter(f => /\.(js|mjs)$/.test(f) && f !== '_ai-usage.js' && f !== '_models.js')
  const stale = [], direct = [], firstBlock = [], temp = []
  for (const f of files) {
    const src = readFileSync(join(FN_DIR, f), 'utf8')
    if (/claude-(opus-4|sonnet-4|sonnet-5'|haiku-4)|grok-4\.3|gemini-2\.5/.test(src)) stale.push(f)
    if (/api\.anthropic\.com/.test(src)) direct.push(f)
    if (/content\?\.\[0\]\?\.text/.test(src)) firstBlock.push(f)
    // temperature is fine for Perplexity/Grok/Gemini bodies; flag it only next to a Claude tier
    const code = src.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')
    if (/model:\s*(MODELS\.CLAUDE_|CLAUDE_MODEL|SYNTH_MODEL|HAIKU_MODEL|MODELS\[mode\])[\s\S]{0,400}?temperature/.test(code)) temp.push(f)
  }
  check('no function pins an old Claude/Grok/Gemini id', stale.length === 0, stale.join(', '))
  check('no function calls api.anthropic.com directly (claudeFetch only)', direct.length === 0, direct.join(', '))
  check('no function reads content[0].text (thinking block may come first)', firstBlock.length === 0, firstBlock.join(', '))
  check('no Claude call sends temperature', temp.length === 0, temp.join(', '))

  const pricing = readFileSync(join(FN_DIR, '_ai-usage.js'), 'utf8')
  for (const id of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'grok-4.7']) {
    check(`ai-usage prices ${id}`, pricing.includes(`'${id}'`))
  }
  const html = readFileSync(join(ROOT, 'public/broadside-app.html'), 'utf8')
  check('standalone Broadside page uses the 5.5 ids too', html.includes("'claude-sonnet-5-5'") && html.includes("'claude-haiku-5-5'") && !/claude-sonnet-5'|haiku-4-5/.test(html))
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) process.exitCode = 1
