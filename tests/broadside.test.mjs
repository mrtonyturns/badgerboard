// tests/broadside.test.mjs — jsdom smoke test for the BROADSIDE conversation loop
// (public/broadside-app.html). Stubs the browser audio/speech stack and drives:
//   1. typed session: sample → Start → Skip mic → typed answer → OPPO replies, LISTENING resumes
//   2. voice session: SpeechRecognition interim/final results, Audio.play() rejecting
//      (autoplay block) → browser-TTS fallback is used AND the line is still logged
//   3. brain 502 → scripted fallback line, never silence
//   4. Done Talking with interim-only transcript ends the turn
//   5. configureProxy() is idempotent (one "connected" line, token updates silent)
//   7-11. "WHO ARE YOU UP AGAINST?" intake: candidate picker (Profile ready / No
//      profile yet chips, Generate → onGenerate, setGenerationStatus progress →
//      loaded card), describe-them path (broadside-prep stub → N vectors; pasted
//      markdown short-circuits without a fetch), "+ New candidate" → onCreate,
//      START with nothing loaded → hint + picker focus, legacy setDossierPicker.
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
    prepStatus: opts.prepStatus || 200,
    prepBody: opts.prepBody || null,
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
        if (/broadside-prep/.test(u)) {
          await sleep(20)
          if (state.prepStatus !== 200) return json(state.prepStatus, { error: state.prepBody?.error || 'prep-upstream-error' })
          return json(200, state.prepBody || { name: 'Jane Roe', office: 'Mayor', fetched: [], items: [] })
        }
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

// ─── 7. Candidate picker: chips, Generate → onGenerate, progress → loaded card ─
console.log('\n[7] WHO ARE YOU UP AGAINST? — candidate picker + generate flow')
{
  const t = boot({ streamMode: 'missing' })
  const { $, window, texts, state } = t
  connectTwice(window)
  const cp = window.ControversyPrep
  check('new host API present', ['setCandidatePicker', 'setGenerationStatus', 'selectCandidate', 'setDossierPicker'].every(k => typeof cp[k] === 'function'))
  check('dock heading reads WHO ARE YOU UP AGAINST?', /WHO ARE YOU\s*UP AGAINST\?/.test(window.document.querySelector('.dock h2').textContent))
  check('legacy Load button + loaded pill are gone', !$('btnLoad') && !$('loadedPill'))
  check('picker section hidden until the host feeds it', $('secPick').style.display === 'none')

  const calls = { pick: [], gen: [], create: [] }
  cp.setCandidatePicker({
    items: [
      { id: 'c1', name: 'Jane Roe', office: 'Mayor · Wausau', party: 'NP', dossierId: 'd1' },
      { id: 'c2', name: 'John Q. Public', office: 'County Board · District 4', party: 'R', dossierId: null },
    ],
    onPick: (d, c) => calls.pick.push([d, c]),
    onGenerate: (id) => { calls.gen.push(id) },
    onCreate: async (x) => { calls.create.push(x) },
  })
  check('picker section shown after setCandidatePicker', $('secPick').style.display !== 'none')
  const inp = $('profilerSearch')
  inp.dispatchEvent(new window.Event('focus'))
  const rows = Array.from(window.document.querySelectorAll('#profilerResults .pr-item'))
  check('two candidate rows + a "+ New candidate" row', rows.length === 3 && /New candidate/.test(rows[2].textContent), rows.map(r => r.textContent).join(' | '))
  check('row shows name · office', /Jane Roe/.test(rows[0].textContent) && /Mayor · Wausau/.test(rows[0].textContent))
  check('"Profile ready" chip on the candidate with a dossier', rows[0].querySelector('.pr-chip.ready')?.textContent === 'Profile ready')
  check('"No profile yet" chip on the candidate without one', rows[1].querySelector('.pr-chip.none')?.textContent === 'No profile yet')

  // type-to-search filters
  inp.value = 'john'; inp.dispatchEvent(new window.Event('input'))
  const filtered = Array.from(window.document.querySelectorAll('#profilerResults .pr-item:not(.pr-new)'))
  check('search filters rows', filtered.length === 1 && /John/.test(filtered[0].textContent))

  // pick the no-profile candidate (mousedown on the row)
  filtered[0].dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }))
  check('no-profile card appears with the name', $('noProfileCard').style.display === 'flex' && $('noProfileText').textContent === 'No profile for John Q. Public yet')
  check('Generate button present and labelled', /Generate profile \(2–4 min\)/.test($('btnGenerate').textContent))
  check('onPick NOT called for a candidate without a profile', calls.pick.length === 0)
  $('btnGenerate').click()
  check('Generate → onGenerate(candidateId)', calls.gen.length === 1 && calls.gen[0] === 'c2', JSON.stringify(calls.gen))
  check('button goes busy while generating', $('btnGenerate').classList.contains('busy') && $('btnGenerate').disabled)
  check('console logs that generation started', texts('sys').some(s => /Generating a profile for John Q\. Public/.test(s)))

  cp.setGenerationStatus({ state: 'running', stage: 2, message: 'Searching press & filings…', elapsedMs: 72000 })
  check('progress renders "<stage> — step 2 of 4 · 1:12"', $('genStatus').classList.contains('on') && $('genStatusText').textContent === 'Searching press & filings… — step 2 of 4 · 1:12', $('genStatusText').textContent)
  check('progress also logged in the session console', texts('sys').some(s => /step 2 of 4: Searching press & filings/.test(s)))
  cp.setGenerationStatus({ state: 'running', stage: 2, message: 'Searching press & filings…', elapsedMs: 77000 })
  check('same stage re-render does not spam the console', texts('sys').filter(s => /step 2 of 4/.test(s)).length === 1)

  // host loads the finished dossier, then signals done
  cp.setDossierMeta({ id: 'd2', title: 'Political Profile — John Q. Public' })
  cp.loadDossier({ name: 'John Q. Public', controversies: [
    { topic: 'Missed votes', detail: 'Missed 14 of 31 county board votes in 2024.' },
    { topic: 'Ethics fine', detail: 'Fined $2,500 by the state ethics board in 2023.' },
    { topic: 'Highway flip-flop', detail: 'Opposed the expansion in 2022, voted for it in 2024 after a PAC donation.' },
  ] })
  cp.setGenerationStatus({ state: 'done', dossierId: 'd2', message: 'Profile ready — press START' })
  check('dock collapses to the loaded card', $('loadedCard').classList.contains('on') && $('intakeBody').style.display === 'none')
  check('loaded card reads "John Q. Public · 3 attack vectors"', $('loadedName').textContent === 'John Q. Public' && /^3 attack vectors/.test($('loadedMeta').textContent), $('loadedMeta').textContent)
  check('"Profile ready — press START" logged', texts('sys').some(s => /Profile ready — press START/.test(s)))
  check('hint says Press START', $('hint').textContent === 'Press START')
  check('Generate button released', !$('btnGenerate').classList.contains('busy'))
  check('dock lamp on', $('dockLamp').classList.contains('on'))

  // Change → expand; pick the profile-ready candidate → onPick(dossierId)
  $('btnChange').click()
  check('Change re-expands the intake', !$('loadedCard').classList.contains('on') && $('intakeBody').style.display === '')
  check('re-feeding the list keeps selection and stays silent', cp.setCandidatePicker({ items: [
    { id: 'c1', name: 'Jane Roe', office: 'Mayor · Wausau', dossierId: 'd1' },
    { id: 'c2', name: 'John Q. Public', office: 'County Board · District 4', dossierId: 'd2' },
  ] }) === true && calls.pick.length === 0)
  check('selectCandidate(profile-ready) → onPick(dossierId, candidateId)', cp.selectCandidate('c1') === true && calls.pick.length === 1 && calls.pick[0][0] === 'd1' && calls.pick[0][1] === 'c1', JSON.stringify(calls.pick))
  check('no-profile card hidden for a profile-ready pick', $('noProfileCard').style.display === 'none')

  // error state
  cp.selectCandidate('c2')
  cp.setGenerationStatus({ state: 'error', message: "You've used all 3 of your profile generations for this month." })
  check('error renders inline and is logged', $('genErr').classList.contains('on') && /used all 3/.test($('genErr').textContent) && texts('sys').some(s => /Profile generation stopped/.test(s)))
  check('no uncaught jsdom errors', !state.warnings.some(w => /jsdomError/.test(w)), state.warnings.filter(w => /jsdomError/.test(w)).join(' | '))
}

// ─── 8. Describe them → broadside-prep → N vectors ────────────────────────────
console.log('\n[8] describe them: Build sparring file → broadside-prep → dossier loads')
{
  const prepBody = { name: 'Pat Doe', office: 'County Board', fetched: [{ url: 'https://news.example/story', ok: true, title: 'Story' }, { url: 'https://dead.example/x', ok: false, error: 'timed out' }], items: [
    { topic: 'Missed votes', detail: 'Missed 14 of 31 votes in 2024 while claiming perfect attendance.' },
    { topic: 'Ethics fine', detail: 'Fined $2,500 in 2023 for an undisclosed rental income.' },
    { topic: 'Highway flip-flop', detail: 'Opposed the expansion, then voted for it after a PAC donation.' },
    { topic: 'Family hire', detail: 'Hired a family member as treasurer at above-market pay.' },
  ] }
  const t = boot({ streamMode: 'missing', prepBody })
  const { $, window, texts, state } = t
  connectTwice(window)
  check('describe placeholder is the plain-words prompt', /Paste links to news articles, or describe them in your own words/.test($('dossierText').placeholder))

  $('btnBuild').click()
  check('empty box → inline error, no fetch', $('buildErr').classList.contains('on') && !state.fetches.some(f => /broadside-prep/.test(f.url)))

  $('describeName').value = 'Pat Doe'
  $('dossierText').value = 'County board member. https://news.example/story and https://dead.example/x — she skipped a bunch of meetings and I think there was something about a fine.'
  $('btnBuild').click()
  check('button goes busy while building', $('btnBuild').classList.contains('busy'))
  const built = await waitFor(() => texts('sys').find(s => /Built 4 attack vectors from your notes/.test(s)), 3000)
  check('"Built N attack vectors from your notes (+ M articles)" logged', built === 'SYSTEMBuilt 4 attack vectors from your notes (+ 1 article).', built)
  const prep = state.fetches.find(f => /broadside-prep/.test(f.url))
  check('POSTs {name,text} with the proxy bearer token', !!prep && prep.init.method === 'POST' && /Bearer tok-/.test(prep.init.headers.Authorization) && JSON.parse(prep.init.body).name === 'Pat Doe' && /skipped a bunch/.test(JSON.parse(prep.init.body).text))
  check('dossier loaded from the result', $('loadedCard').classList.contains('on') && $('loadedName').textContent === 'Pat Doe' && /^4 attack vectors/.test($('loadedMeta').textContent), $('loadedMeta').textContent)
  check('unreadable link reported, not fatal', texts('sys').some(s => /Could not read 1 link: dead\.example\/x \(timed out\)/.test(s)))
  check('button released, no inline error', !$('btnBuild').classList.contains('busy') && !$('buildErr').classList.contains('on'))
  check('hint says Press START', $('hint').textContent === 'Press START')

  // a session actually runs on the built file
  $('btnStart').click()
  await waitFor(() => $('btnSkipMic').style.display === 'inline-block', 2000)
  $('btnSkipMic').click()
  const armed = await waitFor(() => texts('sys').find(s => /Session armed — 4 attack vectors loaded for Pat Doe/.test(s)), 3000)
  check('START arms a session on the built file', !!armed)
  $('btnEnd').click()

  // server failure → inline error, dossier untouched
  state.prepStatus = 502
  $('btnChange').click()
  $('dossierText').value = 'Some other person, nothing much known.'
  $('btnBuild').click()
  await waitFor(() => $('buildErr').classList.contains('on'), 3000)
  check('502 → friendly inline error', /writer is unavailable/.test($('buildErr').textContent), $('buildErr').textContent)
  check('…and the previously built file is still loaded', $('loadedName').textContent === 'Pat Doe')
  check('no uncaught jsdom errors', !state.warnings.some(w => /jsdomError/.test(w)), state.warnings.filter(w => /jsdomError/.test(w)).join(' | '))
}

// ─── 9. Pasted markdown with ≥3 items short-circuits (no server call) ─────────
console.log('\n[9] pasted markdown/JSON dossier loads locally without calling broadside-prep')
{
  const t = boot({ streamMode: 'missing' })
  const { $, window, texts, state } = t
  connectTwice(window)
  $('dossierText').value = `Candidate: Sam Smith
## Controversies
- Was sued in 2021 over unpaid contractor invoices totalling $40,000.
- Missed 9 of 20 council votes in 2023, including the levy vote.
- Criticized for a flip-flop on the downtown parking garage after a developer donation.`
  $('btnBuild').click()
  await sleep(60)
  check('3 vectors parsed locally', $('loadedCard').classList.contains('on') && $('loadedName').textContent === 'Sam Smith' && /^3 attack vectors/.test($('loadedMeta').textContent), $('loadedMeta').textContent)
  check('no broadside-prep fetch', !state.fetches.some(f => /broadside-prep/.test(f.url)))
  check('"Info locked in" logged', texts('sys').some(s => /Info locked in: Sam Smith — 3 attack vectors/.test(s)))

  // JSON works too
  $('btnChange').click()
  $('dossierText').value = JSON.stringify({ name: 'JSON Jones', controversies: [{ topic: 'a', detail: 'Detail one.' }, { topic: 'b', detail: 'Detail two.' }, { topic: 'c', detail: 'Detail three.' }] })
  $('btnBuild').click()
  await sleep(60)
  check('pasted JSON loads locally', $('loadedName').textContent === 'JSON Jones' && !state.fetches.some(f => /broadside-prep/.test(f.url)))

  // fewer than 3 local hits → goes to the server
  $('btnChange').click()
  $('dossierText').value = 'He was fined once, I think. Otherwise just a regular small-town guy who runs a hardware store.'
  $('btnBuild').click()
  await waitFor(() => state.fetches.some(f => /broadside-prep/.test(f.url)), 2000)
  check('a plain description (<3 local hits) DOES call broadside-prep', state.fetches.some(f => /broadside-prep/.test(f.url)))
  await sleep(100)
}

// ─── 10. "+ New candidate" → onCreate ────────────────────────────────────────
console.log('\n[10] + New candidate → onCreate({name, notes})')
{
  const t = boot({ streamMode: 'missing' })
  const { $, window } = t
  connectTwice(window)
  const cp = window.ControversyPrep
  const created = []
  cp.setCandidatePicker({ items: [], onCreate: async (x) => { created.push(x) } })
  $('profilerSearch').dispatchEvent(new window.Event('focus'))
  check('empty account → empty-state row + "+ New candidate"', /No candidates in your account yet/.test($('profilerResults').textContent) && /New candidate/.test($('profilerResults').textContent))
  check('form hidden initially', !$('newCand').classList.contains('on'))
  $('btnNewCand').click()
  check('form opens', $('newCand').classList.contains('on'))
  $('btnCreateCand').click()
  await sleep(10)
  check('empty name → inline error, no onCreate', $('newCandErr').classList.contains('on') && created.length === 0)
  $('newCandName').value = 'New Person'
  $('newCandNotes').value = 'Running for school board'
  $('btnCreateCand').click()
  await waitFor(() => created.length === 1, 1000)
  check('onCreate called with {name, notes}', created.length === 1 && created[0].name === 'New Person' && created[0].notes === 'Running for school board', JSON.stringify(created))
  await sleep(10)
  check('form closes and clears on success', !$('newCand').classList.contains('on') && $('newCandName').value === '')

  // rejection surfaces inline
  cp.setCandidatePicker({ items: [], onCreate: async () => { throw new Error('Monthly limit reached.') } })
  $('btnNewCand').click(); $('newCandName').value = 'Another'; $('btnCreateCand').click()
  await waitFor(() => $('newCandErr').classList.contains('on'), 1000)
  check('onCreate rejection shown inline', /Monthly limit reached/.test($('newCandErr').textContent), $('newCandErr').textContent)

  // typing an unknown name + Enter opens the form prefilled
  cp.setCandidatePicker({ items: [{ id: 'c1', name: 'Jane Roe', office: '', dossierId: 'd1' }] })
  $('btnCancelNew').click()
  const inp = $('profilerSearch')
  inp.value = 'Nobody Here'; inp.dispatchEvent(new window.Event('input'))
  inp.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  check('no match + Enter → new-candidate form prefilled', $('newCand').classList.contains('on') && $('newCandName').value === 'Nobody Here', $('newCandName').value)
}

// ─── 11. START with nothing loaded + legacy setDossierPicker ─────────────────
console.log('\n[11] START with nothing loaded → hint + picker focus; legacy setDossierPicker still works')
{
  const t = boot({ streamMode: 'missing' })
  const { $, window } = t
  connectTwice(window)
  const cp = window.ControversyPrep
  $('btnStart').click()
  check('hint: "Pick a candidate or describe them first"', $('hint').textContent === 'Pick a candidate or describe them first', $('hint').textContent)
  check('focus lands on the describe box when no picker is configured', window.document.activeElement === $('dossierText'))

  const picks = []
  cp.setDossierPicker({ items: [{ id: 'd9', title: 'Political Profile — Old Style', label: 'Political Profile — Old Style · Jan 1, 2026' }], onPick: (id) => picks.push(id) })
  $('profilerSearch').dispatchEvent(new window.Event('focus'))
  const row = window.document.querySelector('#profilerResults .pr-item')
  check('legacy items render as Profile-ready rows', !!row && /Old Style/.test(row.textContent) && row.querySelector('.pr-chip.ready'))
  row.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }))
  check('legacy onPick(id) fires with the dossier id', picks.length === 1 && picks[0] === 'd9', JSON.stringify(picks))
  $('btnStart').click()
  check('…and START with nothing loaded now focuses the picker', window.document.activeElement === $('profilerSearch'))
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
