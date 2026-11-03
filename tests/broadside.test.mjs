// tests/broadside.test.mjs — jsdom smoke test for the BROADSIDE conversation loop
// (public/broadside-app.html). Stubs the browser audio/speech stack and drives:
//   1. typed session: sample → Start → Skip mic → typed answer → OPPO replies, LISTENING resumes
//   2. voice session: SpeechRecognition interim/final results, Audio.play() rejecting
//      (autoplay block) → browser-TTS fallback is used AND the line is still logged
//   3. brain 502 → scripted fallback line, never silence
//   4. Done Talking with interim-only transcript ends the turn
//   5. configureProxy() is idempotent (one "connected" line, token updates silent)
// Prints "N passed, M failed" for scripts/run-unit-tests.mjs.
import { readFileSync } from 'node:fs'
import { JSDOM, VirtualConsole } from 'jsdom'

const HTML = readFileSync(new URL('../public/broadside-app.html', import.meta.url), 'utf8')
let passed = 0, failed = 0
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')) }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function waitFor(fn, ms = 6000, step = 25) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(step) }
  return fn()
}

/** Build a jsdom window with the audio / speech / network stack stubbed. */
function boot(opts = {}) {
  const state = {
    audioPlays: 0, audioRejects: opts.rejectPlay ? 'NotAllowedError' : null,
    ttsSpoken: [], recogs: [], fetches: [], warnings: [],
    brainStatus: opts.brainStatus || 200,
    streamMode: opts.streamMode || 'missing',   // 'missing' (404) | 'json' (200 non-SSE) | 'hang'
    brainText: opts.brainText || 'Look — fourteen missed votes, including the budget. Why should anyone believe the mailer?',
  }
  const vc = new VirtualConsole()
  vc.on('warn', (...a) => state.warnings.push(a.join(' ')))
  vc.on('error', () => {})
  vc.on('log', () => {})
  vc.on('jsdomError', e => { if (!/not implemented/i.test(String(e && e.message))) state.warnings.push('jsdomError: ' + (e && e.message)) })

  const dom = new JSDOM(HTML, {
    url: 'http://localhost/broadside-app.html',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(window) {
      // canvas: jsdom has no 2D context — hand back a no-op proxy
      const noop = new Proxy({}, { get: (_, k) => (k === 'globalAlpha' ? 1 : () => {}), set: () => true })
      window.HTMLCanvasElement.prototype.getContext = () => noop
      window.URL.createObjectURL = () => 'blob:fake-' + Math.random().toString(36).slice(2)
      window.URL.revokeObjectURL = () => {}
      // Web Audio
      window.AudioContext = class { constructor() { this.state = 'running' } resume() { return Promise.resolve() } createMediaStreamSource() { return { connect() {} } } createAnalyser() { return { fftSize: 512, getByteTimeDomainData(a) { a.fill(128) } } } }
      window.navigator.mediaDevices = { getUserMedia: () => (opts.denyMic ? Promise.reject(Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' })) : opts.grantMic ? Promise.resolve({}) : new Promise(() => {})) }
      // HTMLMediaElement replacement
      window.Audio = class {
        constructor(src) { this.src = src; this.playbackRate = 1; this.volume = 1; this.duration = 0.4; this.onplay = null; this.onended = null; this.onerror = null }
        play() {
          state.audioPlays++
          if (/blob:fake/.test(this.src) && state.audioRejects) {
            const e = new Error('play() failed because the user didn\'t interact with the document first'); e.name = state.audioRejects
            return Promise.reject(e)
          }
          setTimeout(() => { this.onplay && this.onplay() }, 5)
          setTimeout(() => { this.onended && this.onended() }, 40)
          return Promise.resolve()
        }
        pause() {}
      }
      // speechSynthesis
      window.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; this.onstart = null; this.onend = null; this.onerror = null } }
      window.speechSynthesis = {
        paused: false, _q: [],
        getVoices: () => [{ lang: 'en-US', name: 'Google US English Male' }],
        addEventListener() {}, resume() {}, cancel() { this._q = [] },
        speak(u) { state.ttsSpoken.push(u.text); this._q.push(u); setTimeout(() => u.onstart && u.onstart(), 5); setTimeout(() => u.onend && u.onend(), 40) },
      }
      // SpeechRecognition
      window.webkitSpeechRecognition = class {
        constructor() { this.started = false; this.aborted = false; this.onresult = null; this.onerror = null; this.onend = null; state.recogs.push(this) }
        start() { if (this.started) { const e = new Error('already started'); e.name = 'InvalidStateError'; throw e } this.started = true }
        stop() { this.started = false; setTimeout(() => this.onend && this.onend(), 2) }
        abort() { this.started = false; this.aborted = true; setTimeout(() => this.onend && this.onend(), 2) }
        // test helper: emit a result event
        emit(text, isFinal) {
          const res = [{ transcript: text }]; res.isFinal = isFinal
          this.onresult && this.onresult({ resultIndex: 0, results: [res] })
        }
      }
      // network
      window.fetch = async (url, init) => {
        state.fetches.push({ url: String(url), init })
        const u = String(url)
        const json = (status, body, headers = {}) => new window.Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
        if (/broadside-brain-stream/.test(u)) {
          if (state.streamMode === 'missing') return json(404, { error: 'nope' })
          if (state.streamMode === 'json') return json(200, { text: state.brainText })
          if (state.streamMode === 'hang') return new Promise((_, rej) => { init && init.signal && init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e) }) })
        }
        if (/broadside-brain/.test(u)) {
          if (state.brainStatus !== 200) return json(state.brainStatus, { error: 'brain-upstream-error' })
          await sleep(30)
          return json(200, { text: state.brainText })
        }
        if (/broadside-voice/.test(u)) {
          return new window.Response(new window.Blob([new Uint8Array([0xff, 0xfb, 0x90, 0x00])], { type: 'audio/mpeg' }), { status: 200, headers: { 'content-type': 'audio/mpeg' } })
        }
        if (/broadside-debrief/.test(u)) return json(200, { debrief: '**Overall: B** — solid.\n\n**Fix first** — slow down.', saved: false })
        return json(404, {})
      }
      window.Response = Response; window.Blob = Blob
    },
  })
  const { window } = dom
  const $ = id => window.document.getElementById(id)
  const lines = cls => Array.from(window.document.querySelectorAll('#screen .line' + (cls ? '.' + cls : '')))
  const texts = cls => lines(cls).map(l => l.textContent)
  return { dom, window, $, lines, texts, state }
}

function connectTwice(window) {
  window.ControversyPrep.configureProxy({ token: 'tok-1' })
  window.ControversyPrep.configureProxy({ token: 'tok-1' })   // React effect re-run / duplicate load
}

async function startAndSkipMic({ $ }) {
  $('btnSample').click()
  $('btnStart').click()
  await waitFor(() => $('btnSkipMic').style.display === 'inline-block', 2000)
  $('btnSkipMic').click()
}

// ─── 1. Typed session ──────────────────────────────────────────────────────────
console.log('\n[1] typed session: sample → Start → Skip mic → typed answer')
{
  const t = boot({ streamMode: 'missing' })
  const { $, window, texts, state } = t
  connectTwice(window)
  check('"Badger Board connected" printed exactly once', texts('sys').filter(s => /Badger Board connected/.test(s)).length === 1)
  window.ControversyPrep.configureProxy({ token: 'tok-2' })   // TOKEN_REFRESHED
  check('token refresh stays silent', texts('sys').filter(s => /Badger Board connected/.test(s)).length === 1)
  check('connect() alias exists', typeof window.ControversyPrep.connect === 'function')
  check('VOICE pill reads CARTESIA after connect', $('stVoice').textContent === 'CARTESIA')

  await startAndSkipMic(t)
  const oppo1 = await waitFor(() => texts('ai').length >= 1 && texts('ai')[0].length > 20 && texts('ai'))
  check('first OPPO line logged after Start', !!oppo1, JSON.stringify(texts('ai')))
  check('stream 404 → classic brain path used (brain fetched)', state.fetches.some(f => /broadside-brain(?!-stream)/.test(f.url)))
  await waitFor(() => $('sessionState').textContent === 'LISTENING', 4000)
  check('state is LISTENING after the opponent finishes', $('sessionState').textContent === 'LISTENING', $('sessionState').textContent)
  check('typed box visible in typed mode', $('typedFallback').style.display === 'flex')

  const inp = $('typedInput')
  inp.value = 'Because I self-reported the issue and paid the fine immediately in 2023, and I amended the disclosure the same week.'
  inp.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  const you = await waitFor(() => texts('you').length >= 1)
  check('YOU line logged', !!you)
  const oppo2 = await waitFor(() => texts('ai').length >= 2, 6000)
  check('opponent responds to the typed answer', !!oppo2, JSON.stringify(texts('ai')))
  await waitFor(() => $('sessionState').textContent === 'LISTENING', 5000)
  check('LISTENING resumes after the reply', $('sessionState').textContent === 'LISTENING', $('sessionState').textContent)
  check('audio was attempted through the proxy voice', state.audioPlays > 0)

  $('btnEnd').click()
  const report = await waitFor(() => texts('sys').find(s => /SESSION REPORT/.test(s)), 4000)
  check('debrief renders after End', !!report, texts('sys').slice(-3).join(' | '))
  check('debrief keeps line breaks (pre-wrap)', !!report && /\n/.test(report) && t.lines('sys').find(l => /SESSION REPORT/.test(l.textContent)).style.whiteSpace === 'pre-wrap')
  check('no uncaught jsdom errors', !state.warnings.some(w => /jsdomError/.test(w)), state.warnings.filter(w => /jsdomError/.test(w)).join(' | '))
}

// ─── 2. Voice session with autoplay-blocked media ──────────────────────────────
console.log('\n[2] voice session: SR results + Audio.play() rejects → browser TTS fallback, line still logged')
{
  const t = boot({ rejectPlay: true, grantMic: true, streamMode: 'json' })
  const { $, window, texts, state } = t
  connectTwice(window)
  $('btnSample').click()
  $('btnStart').click()
  const oppo1 = await waitFor(() => texts('ai').length >= 1 && texts('ai')[0].length > 20 && texts('ai'), 8000)
  check('OPPO line logged even though every Audio.play() rejects', !!oppo1, JSON.stringify(texts('ai')))
  check('stream endpoint returning plain JSON did not hang — classic path used', state.fetches.some(f => /broadside-brain(?!-stream)/.test(f.url)))
  const lineText = oppo1 ? oppo1[0].replace(/^OPPO[^A-Za-z]*THE [A-Z]+(?: \(rattled\))?/, '') : ''
  const spokeLine = () => state.ttsSpoken.some(s => s.length > 10 && lineText.includes(s))
  await waitFor(spokeLine, 8000)
  check('browser speechSynthesis fallback spoke the opponent\'s actual line (not just a reaction grunt)', spokeLine(), JSON.stringify(state.ttsSpoken))
  await waitFor(() => $('sessionState').textContent === 'LISTENING', 8000)
  check('LISTENING resumes after fallback TTS ends', $('sessionState').textContent === 'LISTENING', $('sessionState').textContent)
  const r = await waitFor(() => state.recogs.find(x => x.started))
  check('a SpeechRecognition session is live', !!r)
  check('mic lamp on', $('lampMic').classList.contains('on'))

  // interim → shows live line; final → silence detector ends the turn
  r.emit('I took responsibility and', false)
  await sleep(30)
  check('interim transcript shown live', !!texts('you').find(s => /took responsibility/.test(s)))
  r.emit('I took responsibility and paid the fine in 2023 because the disclosure was late and I fixed it.', true)
  const you = await waitFor(() => t.lines('you').find(l => !l.classList.contains('interim')), 5000)
  check('final YOU line logged after the silence window', !!you)
  const oppo2 = await waitFor(() => texts('ai').length >= 2, 8000)
  check('opponent responds to the spoken answer', !!oppo2, JSON.stringify(texts('ai')))
  await waitFor(() => $('sessionState').textContent === 'LISTENING', 8000)
  check('LISTENING resumes again', $('sessionState').textContent === 'LISTENING')
  const live = state.recogs.filter(x => x.started)
  check('exactly one recognizer live (no double-start)', live.length === 1, 'live=' + live.length)

  // recognizer ends (Chrome 60s cutoff) → auto-restart, still listening
  const cur = live[0]
  cur.started = false; cur.onend && cur.onend()
  await sleep(400)
  check('recognizer restarted after onend', state.recogs.some(x => x.started && x !== cur))

  // fatal error → typed fallback shown, no restart loop
  const cur2 = state.recogs.find(x => x.started)
  cur2.onerror && cur2.onerror({ error: 'not-allowed' })
  cur2.started = false; cur2.onend && cur2.onend()
  await sleep(500)
  check('not-allowed → typed box shown', $('typedFallback').style.display === 'flex')
  check('not-allowed → no recognizer restart loop', !state.recogs.some(x => x.started), 'live=' + state.recogs.filter(x => x.started).length)
  $('btnEnd').click()
}

// ─── 3. Brain 502 → scripted fallback ──────────────────────────────────────────
console.log('\n[3] brain 502 → scripted attack line, never silence')
{
  const t = boot({ brainStatus: 502, streamMode: 'missing' })
  const { $, window, texts } = t
  connectTwice(window)
  await startAndSkipMic(t)
  const oppo = await waitFor(() => texts('ai').length >= 1 && texts('ai')[0].length > 20 && texts('ai'), 8000)
  check('fallback line logged when the brain fails', !!oppo, JSON.stringify(texts('ai')))
  await waitFor(() => $('sessionState').textContent === 'LISTENING', 5000)
  check('LISTENING after fallback line', $('sessionState').textContent === 'LISTENING')
  $('btnEnd').click()
}

// ─── 4. Done Talking with interim-only text ────────────────────────────────────
console.log('\n[4] Done Talking ends the turn on interim text; empty → hint, still listening')
{
  const t = boot({ grantMic: true, streamMode: 'missing' })
  const { $, window, texts, state } = t
  connectTwice(window)
  $('btnSample').click(); $('btnStart').click()
  await waitFor(() => $('sessionState').textContent === 'LISTENING', 8000)
  $('btnDone').click()
  await sleep(50)
  check('Done with nothing heard → hint, still LISTENING', /Nothing heard/.test($('hint').textContent) && $('sessionState').textContent === 'LISTENING', $('hint').textContent)
  const r = state.recogs.find(x => x.started)
  r.emit('the attendance dip was a documented family medical situation and I made every vote that', false)
  await sleep(20)
  $('btnDone').click()
  const you = await waitFor(() => t.lines('you').find(l => !l.classList.contains('interim')), 3000)
  check('Done Talking used the interim transcript', !!you && /family medical/.test(you.textContent))
  const oppo2 = await waitFor(() => texts('ai').length >= 2, 8000)
  check('opponent replies', !!oppo2)
  $('btnEnd').click()
}

// ─── 5. Stream endpoint hangs → first-byte timeout → classic path ─────────────
console.log('\n[5] streaming proxy that never answers does not hold the turn hostage')
{
  const t = boot({ streamMode: 'hang' })
  const { $, window, texts, state } = t
  connectTwice(window)
  await startAndSkipMic(t)
  const t0 = Date.now()
  const oppo = await waitFor(() => texts('ai').length >= 1 && texts('ai')[0].length > 20 && texts('ai'), 12000)
  const dt = Date.now() - t0
  check('line arrives via classic path after the stream guard fires', !!oppo, JSON.stringify(texts('ai')))
  check('…within ~9s (first-byte guard 8s)', dt < 9500, dt + 'ms')
  check('STREAM_OK dropped — only one stream attempt per session', state.fetches.filter(f => /brain-stream/.test(f.url)).length === 1)
  $('btnEnd').click()
}

// ─── 6. Mic prompt denied → meter fails, session still runs on SR / typing ────
console.log('\n[6] getUserMedia rejected: mic meter failure does not break the session')
{
  const t = boot({ denyMic: true, streamMode: 'missing' })
  const { $, window, texts, state } = t
  connectTwice(window)
  $('btnSample').click(); $('btnStart').click()
  const denied = await waitFor(() => texts('sys').find(s => /Microphone access denied/.test(s)), 3000)
  check('denial is reported in the console', !!denied)
  const oppo = await waitFor(() => texts('ai').length >= 1 && texts('ai')[0].length > 20 && texts('ai'), 8000)
  check('first attack still delivered', !!oppo)
  await waitFor(() => $('sessionState').textContent === 'LISTENING', 8000)
  check('LISTENING with a recognizer attempted (SR independent of the meter)', $('sessionState').textContent === 'LISTENING' && state.recogs.some(x => x.started))
  check('no uncaught errors', !state.warnings.some(w => /jsdomError/.test(w)), state.warnings.filter(w => /jsdomError/.test(w)).join(' | '))
  $('btnEnd').click()
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
