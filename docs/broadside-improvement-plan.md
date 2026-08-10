# Broadside — Fluidity & Realism Improvement Plan

Status: **recommendations only — nothing built yet.** Grounded in the actual v1.23 code (broadside-app.html, broadside-brain.js, broadside-voice.js).

---

## 1. Latency between what you say and the reply

**Why it's slow today:** the pipeline is fully serial with zero streaming. After you stop talking, Broadside waits out a fixed 2–3 second silence window, then makes a full round trip to Claude (waits for the complete reply), then sends the whole reply to Cartesia and waits for the complete MP3 to download before playing the first word. Worst case that's 4–7 seconds of dead air.

| # | Fix | What it does | Impact | Effort |
|---|-----|--------------|--------|--------|
| 1a | **Stream the brain** | Stream Claude's reply token-by-token instead of waiting for the whole thing | First words available in ~1s | Medium |
| 1b | **Sentence-chunked TTS** | Synthesize and play sentence 1 while sentence 2 is still generating (Cartesia supports streamed PCM into WebAudio) | Cuts time-to-first-audio by 60–80% | Medium |
| 1c | **Adaptive silence window** | Shrink the fixed 2–3s "are you done talking" wait: short answers finalize after ~1.2s; add an optional tap-to-finish button so you never wait | Removes up to 2s per turn | Low |
| 1d | **Speculative pre-generation** | Start generating the AI's reply from the interim transcript while you're still finishing your sentence; discard if your ending changes the meaning | Perceived latency near zero on short answers | Medium-High |
| 1e | **Instant backchannel lines** | Pre-cached reaction clips ("Mm-hm." / "Go on—" / a skeptical scoff) play immediately while the real reply generates | Dead air *feels* eliminated even before 1a/1b | Low |
| 1f | **Default voice sessions to speed mode** | Haiku "speed" brain already exists server-side; voice sparring should use it by default with the quality model reserved for debriefs | ~1–2s faster per turn, today | Trivial |

Recommended order: 1c + 1e + 1f first (one afternoon, big perceived win), then 1a + 1b (the real fix), 1d last.

## 2. Topics switch too fast

**Why:** each topic allows at most **2 follow-ups** before the queue advances, and there's a 30% random "theme swap" that can yank the conversation sideways. One decent answer often ends a topic.

| # | Fix | What it does | Impact | Effort |
|---|-----|--------------|--------|--------|
| 2a | **Quality-based continuation** | Stay on a topic until you've landed 2 strong answers *or* flubbed 3 — not a flat 2-question cap | Topics get properly drilled | Low |
| 2b | **Escalation ladder per topic** | Every topic runs soft question → pressure → gotcha → close-out instead of jumping after 1–2 exchanges | Feels like a real interviewer working you | Medium |
| 2c | **Pacing setting** | Session setup picks Quick scrum / Standard / Deep drill (questions per topic) | You control the tempo | Low |
| 2d | **Signaled transitions + "stay on this"** | The AI verbally bridges ("Before we leave this…") and a Stay-on-topic button lets you drill deeper on demand | Kills the whiplash | Low |
| 2e | **Remove the 30% random theme swap** | The random mid-answer theme injection is a main source of non-sequitur jumps | Immediate coherence win | Trivial |

## 3. Going on the offensive — opponent profiles

**Today:** every mode puts *you* on defense — the AI attacks using your own candidate's profile. There is no way to attack, and no concept of an opponent profile.

| # | Fix | What it does | Impact | Effort |
|---|-----|--------------|--------|--------|
| 3a | **Attack mode** | New session type: you go on offense, the AI defends in character as your opponent — dodging where their record is weak, counterpunching with their actual talking points | The missing half of debate prep | Medium |
| 3b | **Load opponent from Profiler** | Pick any candidate you've profiled; Broadside ingests their dossier (positions, record, controversies) as the AI's character sheet | Zero extra work if you've already profiled them | Medium |
| 3c | **Upload an opponent doc** | Paste or upload opposition research for candidates you haven't profiled (respects the AI-access toggles) | Covers every race | Low-Medium |
| 3d | **Cross-examination format** | Alternating rounds — you attack, it counterattacks, moderator keeps time | Closest thing to a real debate rep | Medium |
| 3e | **Attack grading in the debrief** | Report card scores your attacks: which landed, which they slipped, and sharper framings to try | Turns reps into improvement | Low (extends existing debrief) |

## 4. Session console scrolling (confirmed bug)

**Root cause found:** the console only auto-scrolls when a *new* line is added. While you're talking, the live interim transcript updates an *existing* line — which grows taller with no re-scroll — so your own words run below the fold exactly as you described.

| # | Fix | What it does | Impact | Effort |
|---|-----|--------------|--------|--------|
| 4a | **Scroll on interim updates** | Re-pin to bottom every time the live transcript line changes | Fixes the reported bug | Trivial |
| 4b | **Stick-to-bottom with escape hatch** | Auto-pin only when you're already at the bottom; scrolling up to review pauses it, with a "↓ latest" pill to jump back | Correct behavior for reviewing mid-session | Low |
| 4c | **Bottom padding under the last line** | Keep the newest line clear of the control bar overlay | Polish | Trivial |

## 5. Bonus realism (worth considering while we're in there)

- **Barge-in:** start talking and the AI's audio stops — real opponents get interrupted.
- **Per-line voice emotion:** Cartesia supports emotion/speed controls — an angry press should not sound like a gracious concession.
- **Natural disfluencies:** occasional "Look—", beat pauses, restarts in the AI's lines.
- **Latency telemetry in the debrief:** track your response times *and* the AI's, so we can prove the fluidity fixes are working.

---

## Suggested build order (pending your approval)

1. **Quick wins package** — 4a/4b/4c scrolling fix, 1c/1e/1f latency trims, 2e random-swap removal, 2a/2d topic pacing. Small, high-impact, low-risk.
2. **Streaming pipeline** — 1a + 1b. The structural latency fix.
3. **Offense mode** — 3a + 3b + 3e (Profiler-linked attack mode with graded debrief), then 3c/3d.

Nothing above has been built. Tell me which numbers to run with and I'll start.
