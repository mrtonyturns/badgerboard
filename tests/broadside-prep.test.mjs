// tests/broadside-prep.test.mjs — unit tests for the pure helpers behind
// /.netlify/functions/broadside-prep (BROADSIDE "just describe them" intake):
// URL extraction, the SSRF guard, HTML → text, model-JSON parsing and the
// item validator. The handler itself (auth, fetch, model) is not exercised.
// Prints "N passed, M failed" for scripts/run-unit-tests.mjs.
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

const require = createRequire(import.meta.url)
const M = require('../netlify/functions/broadside-prep.js')
const SRC = readFileSync(new URL('../netlify/functions/broadside-prep.js', import.meta.url), 'utf8')
const RL = require('../netlify/functions/_rate-limit.js')
const TOML = readFileSync(new URL('../netlify.toml', import.meta.url), 'utf8')

let passed = 0, failed = 0
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')) }
}

console.log('\n[1] exports + wiring')
{
  for (const k of ['extractUrls', 'isSafeUrl', 'htmlToText', 'extractTitle', 'parseModelJson', 'validatePrep', 'buildUserPrompt', 'handler']) {
    check(`exports ${k}`, typeof M[k] === 'function')
  }
  check('rate limit registered at 6/min 60/day', RL.RATE_LIMITS['broadside-prep']?.perMinute === 6 && RL.RATE_LIMITS['broadside-prep']?.perDay === 60, JSON.stringify(RL.RATE_LIMITS['broadside-prep']))
  check('netlify.toml raises the function timeout to 26s', /\[functions\."broadside-prep"\]\s*\n\s*timeout\s*=\s*26/.test(TOML))
  check('uses requireBroadside (plan gate) and enforceRateLimit', /requireBroadside\(event\)/.test(SRC) && /enforceRateLimit\(user\.id, 'broadside-prep'/.test(SRC))
  check('model id is the brain\'s "speed" constant (Haiku)', /MODELS\.speed/.test(SRC) && /require\('\.\/broadside-brain'\)/.test(SRC))
  check('limits: 6 URLs, 8s fetch, 300KB cap, ~6000 chars, 12s model', M.LIMITS.MAX_URLS === 6 && M.LIMITS.FETCH_TIMEOUT_MS === 8000 && M.LIMITS.FETCH_CAP_BYTES === 300 * 1024 && M.LIMITS.ARTICLE_CHARS === 6000 && M.LIMITS.MODEL_TIMEOUT_MS === 12000, JSON.stringify(M.LIMITS))
}

console.log('\n[2] extractUrls')
{
  const text = `See https://example.com/a-story. Also (https://news.example.org/x?y=1&z=2) and http://foo.bar/baz,
plus a dupe https://example.com/a-story and "https://quoted.example/path".
ftp://not.http/ignored  www.no-scheme.example/ignored`
  const urls = M.extractUrls(text)
  check('finds http + https links, in order', urls[0] === 'https://example.com/a-story' && urls[1] === 'https://news.example.org/x?y=1&z=2' && urls[2] === 'http://foo.bar/baz', JSON.stringify(urls))
  check('trims trailing punctuation / quotes / parens', urls.includes('https://quoted.example/path') && !urls.some(u => /[.,)"]$/.test(u)), JSON.stringify(urls))
  check('dedupes', urls.filter(u => u === 'https://example.com/a-story').length === 1)
  check('ignores non-http schemes and bare domains', !urls.some(u => /ftp:|no-scheme/.test(u)))
  const many = Array.from({ length: 10 }, (_, i) => `https://site${i}.example/p`).join(' ')
  check('caps at 6 by default', M.extractUrls(many).length === 6)
  check('custom cap honoured', M.extractUrls(many, 2).length === 2)
  check('empty / non-string input → []', M.extractUrls('').length === 0 && M.extractUrls(null).length === 0)
}

console.log('\n[3] isSafeUrl (SSRF guard)')
{
  const ok = ['https://www.jsonline.com/story', 'http://example.com', 'https://8.8.8.8/x']
  const bad = ['http://localhost/admin', 'http://127.0.0.1:8080/', 'http://10.1.2.3/', 'http://192.168.1.1/', 'http://172.16.0.9/', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/', 'http://user:pw@example.com/', 'file:///etc/passwd', 'http://foo.internal/', 'http://svc.local/', 'http://100.64.0.1/', 'not a url']
  check('public hosts allowed', ok.every(M.isSafeUrl), JSON.stringify(ok.map(u => [u, M.isSafeUrl(u)])))
  check('loopback / private / link-local / metadata / creds / non-http blocked', bad.every(u => !M.isSafeUrl(u)), JSON.stringify(bad.filter(M.isSafeUrl)))
}

console.log('\n[4] htmlToText + extractTitle')
{
  const html = `<!doctype html><html><head><title>Mayor &amp; council clash &#8212; Local News</title>
<style>body{color:red}</style><script>window.x = "<p>not text</p>"</script></head>
<body><nav><a href="/">Home</a><a href="/news">News</a></nav>
<header>Site header</header>
<article><h1>Mayor skipped 14 votes</h1><p>The mayor missed <b>14 of 31</b> votes in 2024, including the budget.</p>
<p>She said &quot;it was a family matter&quot;.</p><!-- hidden comment --><ul><li>One</li><li>Two</li></ul></article>
<footer>© 2026 Paper</footer></body></html>`
  const t = M.htmlToText(html)
  check('strips scripts, styles, nav/header/footer and comments', !/color:red|window\.x|not text|Home|Site header|hidden comment|© 2026/.test(t), t)
  check('keeps article text and decodes entities', /Mayor skipped 14 votes/.test(t) && /14 of 31 votes in 2024/.test(t) && /"it was a family matter"/.test(t), t)
  check('block elements become line breaks', t.split('\n').length >= 4, JSON.stringify(t))
  check('caps length', M.htmlToText('<p>' + 'x'.repeat(10000) + '</p>', 500).length === 500)
  check('default cap is ~6000 chars', M.htmlToText('<p>' + 'y'.repeat(20000) + '</p>').length === 6000)
  check('extractTitle decodes entities', M.extractTitle(html) === 'Mayor & council clash — Local News', M.extractTitle(html))
  check('extractTitle → null when absent', M.extractTitle('<p>no title</p>') === null)
  check('decodeEntities handles numeric + hex + named', M.decodeEntities('&#65;&#x42;&lt;&amp;&rsquo;') === 'AB<&’', M.decodeEntities('&#65;&#x42;&lt;&amp;&rsquo;'))
}

console.log('\n[5] parseModelJson')
{
  const good = { name: 'Pat Doe', office: 'Mayor', items: [{ topic: 'Missed votes', detail: 'Missed 14 of 31 votes in 2024.' }] }
  check('plain JSON', JSON.stringify(M.parseModelJson(JSON.stringify(good))) === JSON.stringify(good))
  check('JSON inside prose + code fence', M.parseModelJson('Sure! Here it is:\n```json\n' + JSON.stringify(good) + '\n```\nHope that helps.')?.name === 'Pat Doe')
  check('first { to last } (nested braces ok)', M.parseModelJson('x {"a":{"b":1},"c":[{"d":2}]} y')?.c?.[0]?.d === 2)
  check('tolerates a trailing comma', M.parseModelJson('{"name":"X","items":[{"topic":"t","detail":"d"},],}')?.items?.length === 1)
  check('garbage → null', M.parseModelJson('no json here') === null && M.parseModelJson('{broken') === null && M.parseModelJson('') === null)
}

console.log('\n[6] validatePrep')
{
  const v = M.validatePrep({
    name: '  Pat  Doe ', office: 'County Board', items: [
      { topic: 'Missed votes', detail: 'Missed 14 of 31 county board votes in 2024, including the budget vote.' },
      { topic: 'Missed votes', detail: 'duplicate topic should be dropped' },
      { topic: '', detail: 'Ethics fine: fined $2,500 by the state ethics board in 2023.' },
      { topic: 'too short', detail: 'nope' },
      null, 'junk',
      { title: 'alt keys', description: 'Flip-flopped on the highway expansion after a PAC donation.' },
    ],
  })
  check('normalises name/office', v.name === 'Pat Doe' && v.office === 'County Board', JSON.stringify(v))
  check('drops dupes, short details and junk', v.items.length === 3, JSON.stringify(v.items))
  check('derives a topic when missing', v.items[1].topic === 'Ethics fine', v.items[1].topic)
  check('accepts title/description aliases', v.items[2].topic === 'alt keys')
  check('falls back to the user-supplied name', M.validatePrep({ items: [{ topic: 'a', detail: 'Something attackable here.' }] }, 'Jane Roe').name === 'Jane Roe')
  check('"controversies" key accepted', M.validatePrep({ controversies: [{ topic: 'a', detail: 'Something attackable here.' }] })?.items.length === 1)
  check('no usable items → null', M.validatePrep({ items: [] }) === null && M.validatePrep(null) === null && M.validatePrep({ items: [{ topic: 'x', detail: 'short' }] }) === null)
  const many = { items: Array.from({ length: 30 }, (_, i) => ({ topic: 't' + i, detail: `Attackable detail number ${i} with enough length.` })) }
  check('caps at 12 items', M.validatePrep(many).items.length === 12)
  check('strips control chars and caps lengths', M.validatePrep({ name: 'A\x00B', items: [{ topic: 'x'.repeat(200), detail: 'y'.repeat(1000) }] }).items[0].topic.length === 80 && M.validatePrep({ name: 'A\x00B', items: [{ topic: 't', detail: 'y'.repeat(1000) }] }).name === 'AB')
}

console.log('\n[7] buildUserPrompt')
{
  const p = M.buildUserPrompt({ name: 'Pat Doe', text: 'She skipped votes.', articles: [{ url: 'https://x.example/a', title: 'Story', text: 'Article body.' }] })
  check('includes name, notes and numbered articles with titles', /CANDIDATE NAME \(from the user\): Pat Doe/.test(p) && /USER'S NOTES:\nShe skipped votes\./.test(p) && /ARTICLE 1 — Story \(https:\/\/x\.example\/a\):\nArticle body\./.test(p), p)
  check('name omitted when empty', !/CANDIDATE NAME/.test(M.buildUserPrompt({ name: '', text: 'x', articles: [] })))
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
