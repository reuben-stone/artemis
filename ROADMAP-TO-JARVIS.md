# Roadmap to Jarvis

> The plan for turning Artemis from a voiced operator into a true Jarvis-class
> assistant: present, perceptive, proactive, and able to act across your digital life.
> This is a living document — we revise it as we ship.

## The vision

A Jarvis is four things at once:

1. **Present** — always there, ambient, with a face and a voice you can talk *to* and *over*.
2. **Perceptive** — it hears you, sees your screen, knows your context, remembers your history.
3. **Capable** — it can actually *do* things: run code, manage files, reach into your calendar, email, web, and tools.
4. **Proactive** — it doesn't just wait for prompts; it anticipates, schedules, watches, and surfaces things unasked.

Artemis today is a strong **operator** — an agentic mind in a body with a voice. The
journey to Jarvis is adding *ears*, *senses*, *living memory*, *reach*, and *initiative*,
while keeping the careful-operator safety posture that already exists.

---

## Where we are today (June 2026)

| Capability | State | Lives in |
|---|---|---|
| Agentic mind (Sonnet 4.6, raw Anthropic SDK) | ✅ Streaming, own tool loop, prompt caching | `src/main/agent.ts` |
| Self-hosting (reads/edits own source, runs terminal) | ✅ cwd = own repo, gated by permission dialog | `src/main/agent.ts`, `TerminalPane.tsx` |
| Body (3D orb, 6 states) | ✅ idle/thinking/executing/speaking/listening/error | `src/renderer/src/components/Orb.tsx` |
| Voice **out** (TTS → orb pulse) | ✅ Web Speech API, word-boundary envelope | `src/renderer/src/hooks/useVoice.ts` |
| Spoken summaries (`⟦say⟧` marker) | ✅ Screen gets detail, voice gets the gist | `agent.ts`, `agent/speech.ts` |
| Memory (file tier, wired into loop) | ✅ Injected + save/recall tools, cached per turn | `src/main/memory.ts` |
| Persistence backbone (SQLite) | ✅ Transcript + terminal scrollback survive restart | `src/main/store.ts` |
| Text barge-in | ✅ Queue messages while mid-turn, drains FIFO | `App.tsx`, `Chat.tsx` |
| Permission / safety gating | ✅ Dangerous-cmd blocklist + UI approval | `src/main/agent.ts`, `PermissionDialog.tsx` |
| Terminal pane | ✅ node-pty, toolbar toggle | `src/main/index.ts`, `TerminalPane.tsx` |
| Voice **in** (mic capture + Whisper STT) | ✅ whisper-tiny.en fp32 WASM, verified live | `hooks/useSpeech.ts`, `agent/whisper.worker.ts` |
| Model toggle (Sonnet ↔ Opus) | ✅ Persisted in SQLite, read per turn | `src/main/store.ts`, titlebar |
| Wake word / VAD | ❌ Not built | — |
| Senses (vision / screen / files) | ❌ Not built | — |
| External reach (calendar/email/MCP) | ❌ Not built | — |
| Proactivity (schedules / background) | ❌ Not built | — |

**Restart note:** changes under `src/main/**` or `src/preload/**` force a full Electron
restart (kills the live session); renderer changes hot-reload. Each phase below is tagged
🔴 (main/preload-heavy, plan the restart) or 🟢 (renderer-only, safe to iterate live).

---

## Guiding principles

- **One focused change at a time.** Build, confirm it works, then move on — especially for self-modification.
- **Reversible and gated by default.** New powers ship behind the same permission posture; nothing destructive runs unasked.
- **Presence over features.** A Jarvis that *feels* alive beats a pile of capabilities. Latency, voice quality, and responsiveness are features.
- **Memory is the moat.** The longer Artemis remembers you well, the more it becomes *yours*. Wire it deep and early.
- **Own the stack.** Where possible, prefer code we write and understand over opaque SDK abstractions. This keeps the architecture evolvable.
- **Batch main-process work.** Group `src/main` edits so we take the session-killing restart once, not repeatedly.

---

## Architectural cornerstone — the brain must outlive the face 🔴
*A restart should never close our session. This underpins every phase below.*

**Fix in two levels — we want both:**

1. **Graceful restart (level 1) — ✅ DONE.** Transcript + terminal scrollback persist to SQLite and restore on boot. A restart is a ~1s blink that returns with everything intact. `src/main/store.ts` is the live backbone.

2. **Sidecar brain (level 2 — future).** Move the agent loop into a persistent local daemon. Electron becomes a disposable face that reconnects. Only editing the daemon's own code restarts the brain. Scheduled alongside Phase 6 (proactivity), which needs the same always-on process.

### Data & persistence — decided

- **Local-first SQLite** (`better-sqlite3`, WAL mode) — single backbone for transcript, terminal, session state, and eventually the vector memory tier (`sqlite-vec`). One engine that grows with the roadmap.
- **No cloud runtime dependency.** All reads/writes hit the embedded file. Cloud is optional sync-only (libSQL/Litestream).
- **Portability.** New machine = pull repo + copy one SQLite file. With optional sync enabled, even that disappears.

---

## Architecture milestone — own the agent loop 🔴  ← *active*
*Drop the Claude Agent SDK. Build the tool loop ourselves. Unlock prompt caching and model portability.*

### Why

The Agent SDK (`@anthropic-ai/claude-agent-sdk`) is a convenient abstraction but it has a hard ceiling:
- **No prompt caching support** — Anthropic's servers reprocess the full system prompt on every single turn. With the raw SDK we add `cache_control: {type: 'ephemeral'}` and get ~40% TTFT reduction from the second turn onwards.
- **Opaque agentic loop** — we can't see or control what's happening between model call and tool execution.
- **Model lock-in** — tied to Anthropic's SDK session model. We can't route turns to a local model.

### What we build instead

A thin, transparent tool loop (~400 lines in `agent.ts`) using `@anthropic-ai/sdk` directly:

```
User message
    ↓
[ModelClient interface]  ← swappable: Anthropic | Ollama | vLLM | fine-tuned
    ↓
Tool call? → execute locally (Read/Write/Edit/Bash/Glob/Grep/memory)
    ↓
Feed result back → model continues
    ↓
stop_reason = end_turn → done
```

History is managed in SQLite (we already have it) — no more session ID file. Prompt caching covers both the system prompt and prior conversation turns.

### What this unlocks

- **Prompt caching** — TTFT improvement on every turn after the first
- **Local model support** — swap `AnthropicClient` for `OllamaClient`, same tool loop
- **Full control** — we own every line between user message and assistant reply
- **Model routing** — simple tasks to local model, complex to Claude; or hybrid

### Status

- ✅ Planning complete
- ◻︎ Implement raw SDK tool loop (`agent.ts` rewrite)
- ◻︎ Tool implementations: Read, Write, Edit, Glob, Grep, Bash, WebFetch, save_memory, recall_memory
- ◻︎ Prompt caching on system prompt + history turns
- ◻︎ ModelClient interface (Anthropic implementation first; Ollama stub)
- ◻︎ Remove `@anthropic-ai/claude-agent-sdk` dependency
- ◻︎ Verify: same tool execution behaviour, streaming, permission gating

---

## Phase 0 — Foundation hardening 🔴  ← ✅ DONE

- ✅ Wire `memory.ts` into the agent loop (`buildSystemAppend` loads index + facts, cached 60s)
- ✅ First-class memory tools (`save_memory` / `recall_memory`) — run without permission prompt
- ✅ "New conversation" control — `resetSession()`, archives thread via DB view floor
- ✅ Cost meter in titlebar (cumulative estimate, resets on new conversation)
- ✅ Chat spacing + markdown formatting tightened (`remark-breaks`, reduced margins)
- ✅ Tool discipline hint in system prompt (no unnecessary tool calls for conversational replies)
- ✅ Auth/error UX — `KeySetup` component + actionable auth error messages

## Phase 1 — Give Artemis ears 🔴  ← ✅ STT working / wake word pending

- ✅ `useSpeech` hook — mic capture, 16kHz mono Float32, orb amplitude from voice
- ✅ `listening` orb state (cyan)
- ✅ Barge-in — starting to listen cancels in-progress TTS
- ✅ **Local Whisper STT — VERIFIED LIVE (2026-06-24)** — `whisper-tiny.en`, `dtype: 'fp32'` (WASM default `q8` has broken MatMulNBits ops), transformers.js Web Worker, model cached in browser after first download
- ✅ Text barge-in — type and send while mid-turn; queues and drains FIFO
- ◻︎ **STT optimization** — fp32 is heavy; try `q8` with latest transformers.js (may be fixed); benchmark; consider `whisper-base.en`. WebGPU is *not* faster than WASM for Whisper on M-series currently (counterintuitive but benchmarked — revisit Q4 2026).
- ◻︎ **Wake word** ("Artemis…") for hands-free activation
- ◻︎ **Voice activity detection** — auto-stop when you finish speaking; pairs with upgrading to `whisper-base.en` for accuracy
- ◻︎ **Vendor model + WASM** into the app bundle (true offline; drops remote `connect-src` from CSP)
- **Done when:** spoken back-and-forth, hands-free, with natural interrupt

## Phase 2 — A voice worth listening to 🟢→🔴
*From robotic to alive.*

- Swap Web Speech API for **streaming neural TTS** (ElevenLabs or similar) — pipe audio through existing `amplitudeRef` so orb code is untouched (🟢). API key lives in main (🔴).
- **Sentence-level streaming** — speak the first sentence while the rest generates
- **Expressiveness** — tone/pace matching state (calm idle, crisp executing, warm)
- **Done when:** Artemis's voice is indistinguishable-from-human enough that you forget it's TTS

## Phase 3 — Living memory 🔴
*Remember everything that matters, recall it at the right moment.*

- **Semantic tier** — embed each memory fact, recall by similarity via `sqlite-vec`. Inject only relevant facts per turn (replaces "inject everything every turn").
- **Auto-capture** — propose durable facts at the end of meaningful turns
- **Episodic log** — summaries of past conversations, searchable
- **Per-project memory** scoping
- **Done when:** Artemis recalls the right detail unprompted, weeks later

## Phase 4 — Senses 🔴
*See what you see.*

- **Screen awareness** — capture active window/region on request, reason over it (vision models)
- **File drag-and-drop** into chat — images, PDFs, code
- **Clipboard / selection** awareness as opt-in context
- **Done when:** "what's this error?" and Artemis already sees your screen

## Phase 5 — Hands and reach 🔴
*Act beyond the repo.*

- **MCP integration** — calendar, email, GitHub, Slack, notes, smart home — gated by permission flow
- **Skill library** — reusable named procedures Artemis can invoke
- **Web actions** beyond fetch/search — structured browsing
- **Done when:** "Artemis, book that and email them the link" works end-to-end

## Phase 6 — Proactivity + sidecar brain 🔴
*Stop waiting to be asked.*

- **Sidecar brain daemon** — move agent loop to a persistent local process; Electron becomes a reconnectable face (cornerstone level 2, lands here because proactivity needs it too)
- **Scheduling / cron** — run tasks on timer or trigger ("every morning, brief me")
- **Background agents** — long-running tasks that report back via notification
- **Watchers** — monitor a repo, inbox, deploy; surface what changed
- **System notifications** + "what I did while you were away" digest
- **Done when:** Artemis tells *you* things, at the right time, without a prompt

## Phase 7 — The HUD 🟢
*A presence, not a window.*

- **Ambient mode** — small always-on-top orb that listens and glances, expands on interaction
- **Glanceable widgets** — current task, calendar, notifications, system status around the orb
- **Richer chat** — collapsible tool calls, diffs, inline media, command palette
- **Theming & settings** surface — all renderer, safe to iterate live
- **Done when:** Artemis feels like part of the desktop, not an app you open

## Phase 8 — Local model integration 🔴
*The brain becomes yours.*

- **ModelClient abstraction** — already in place after Architecture milestone; swap Anthropic for Ollama/vLLM with one line
- **Local model routing** — simple/fast tasks to on-device model (Qwen 2.5 Coder, Llama 3.x, Mistral, Deepseek); complex multi-file work stays on Claude
- **Privacy mode** — fully offline, zero API calls, all inference local
- **Fine-tuning path** — optional: train on your own codebase and preferences
- **Done when:** Artemis can run fully offline with a capable local model, no API dependency

## Phase 9 — Self-improvement 🔴
*Artemis builds Artemis.*

- **Guided self-modification** — proposes, diffs, and (with approval) applies changes to its own code, then rebuilds
- **Eval loop** — small harness so mind changes can be measured, not just vibe-checked
- **Changelog memory** — remembers what it changed about itself and why
- **Done when:** "Artemis, improve your own X" is a safe, routine operation

---

## Current sprint

1. ✅ ~~Graceful restart (cornerstone level 1)~~
2. ✅ ~~Phase 0 — foundation~~
3. ✅ ~~Phase 1 (partial) — STT working, text barge-in done~~
4. **Architecture milestone — own the agent loop** ← *now*
5. Phase 1 completion — wake word + VAD (after architecture settled)
6. Phase 2 — neural TTS

---

*Maintained by Artemis & Reuben. Last updated June 2026.*
