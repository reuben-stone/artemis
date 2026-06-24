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

## The mission has a target — the Livana ops layer

Artemis isn't a generic personal assistant; its **killer daily use case is to be the AI
operations layer for the Livana product ecosystem** (Livana Group Ltd — Reuben + brothers
Kofi & Daniel Stone). That target reprioritizes everything below: build what serves
multi-repo oversight first; treat voice polish and senses as supporting cast.

**The ecosystem Artemis oversees — 3 repos (all on `~/Desktop`):**

| Repo | What it is | Stack | Analytics / signals | CI |
|---|---|---|---|---|
| `livana-web` | Marketing site (livana.io) | SvelteKit, Vercel | GA4 `G-Q2CD264F3W`, Sentry, Vercel Analytics | none |
| `livana-scanner` | Product monorepo (npm workspaces + Turbo): **Lumi Scanner** (Next.js, lumi.livana.io), **LumiLens** (Next.js + Anthropic, lumilens.livana.io), **worker** (Express on Railway), **Chrome extension** (spike); shared `scanner-core` engine | Next.js 16, MongoDB, Stripe, NextAuth | GA4 `G-2NG7EL8BGP` (scanner) / `G-9D9ENPK0SZ` (lens), per-product Sentry | ✅ Vitest, typecheck, lint-changed, daily selfscan, lighthouse |
| `livana-audit` | Internal WCAG 2.2 audit tool | SvelteKit, MongoDB/GridFS | none | none |

*(`livana-dashboard` is **obsolete** — its devops/ticketing moved into the scanner; excluded.)*

**The three capability pillars this use case needs:**
1. **Multi-project oversight** — hold all 3 repos at once: per-repo cwd, config, memory, and status.
2. **Live analytics intake** — pull GA4 (Google Analytics Data API) + Sentry to give health/usage overviews per app.
3. **Worker agents** — dispatch sub-agents to fix issues across repos, **producing gated PRs, never autonomous pushes** (run each repo's own checks first — the scanner has CI; web/audit don't, so extra caution there).

These map to **Multi-project foundation → sidecar brain → reach (GA + GitHub) → worker agents + proactive digests**. Voice (Phases 1–2) and senses (Phase 4) are demoted below this spine.

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
- **Presence over features.** A Jarvis that *feels* alive beats a pile of capabilities. Latency, voice quality, and responsiveness are features. **Make it measurable:** target TTFT < 800ms, end-to-end voice round-trip (speech end → first spoken word) < 2s. Track these, don't just vibe them — a regression here is a presence regression.
- **Memory is the moat.** The longer Artemis remembers you well, the more it becomes *yours*. Wire it deep and early.
- **Own the stack.** Where possible, prefer code we write and understand over opaque SDK abstractions. This keeps the architecture evolvable.
- **Batch main-process work.** Group `src/main` edits so we take the session-killing restart once, not repeatedly.
- **Generic mechanism, projects as data.** Build the ops layer for *any* ecosystem of repos, not hardcoded to Livana — the registry holds arbitrary projects; paths, analytics IDs, CI commands, and PR rules are per-project config. Livana is the first tenant (seed data), not baked in. Don't gold-plate for hypothetical tenants (YAGNI); config-driven is enough to point at a second ecosystem later.
- **Agents propose, the human approves.** Worker agents acting on overseen repos **only ever open PRs, never push** — and every PR they open is surfaced to the human for review (see the PR Review Queue). Autonomy produces reviewable artifacts, not silent changes.

---

## Architectural cornerstone — the brain must outlive the face 🔴
*A restart should never close our session. This underpins every phase below.*

**Fix in two levels — we want both:**

1. **Graceful restart (level 1) — ✅ DONE.** Transcript + terminal scrollback persist to SQLite and restore on boot. A restart is a ~1s blink that returns with everything intact. `src/main/store.ts` is the live backbone.

2. **Sidecar brain (level 2).** Move the agent loop into a persistent local daemon. Electron becomes a disposable face that reconnects. Only editing the daemon's own code restarts the brain. Unblocks safe self-modification (Phase 9) and proactivity (Phase 6), and ends session-killing on every `src/main` edit.
   - **Prep DONE (2026-06-24)** — the two de-risking prerequisites are in, both valuable today:
     (a) the agent loop is decoupled from Electron behind an `AgentEmit` transport (`agent.ts`/`index.ts`), so the daemon split is just "swap the transport"; (b) the store's DB driver is injectable + covered by real tests (`store.ts`, `test/store.test.ts` via node:sqlite) — the daemon and the face will share that persistence, so it's now hardened.
   - **Daemon itself: deferred to the new always-on Apple Silicon machine** ([[artemis-target-hardware]]) — a 24/7 daemon only pays off on an always-on host; building the full split + reconnection + autostart belongs there.

### Data & persistence — decided

- **Local-first SQLite** (`better-sqlite3`, WAL mode) — single backbone for transcript, terminal, session state, and eventually the vector memory tier (`sqlite-vec`). One engine that grows with the roadmap.
- **No cloud runtime dependency.** All reads/writes hit the embedded file. Cloud is optional sync-only (libSQL/Litestream).
- **Portability.** New machine = pull repo + copy one SQLite file. With optional sync enabled, even that disappears.

---

## Architecture milestone — own the agent loop 🔴  ← ✅ DONE (commit `b01c148`)
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
- ✅ Implement raw SDK tool loop (`agent.ts` rewrite, commit `b01c148`)
- ✅ Tool implementations: Read, Write, Edit, Glob, Grep, Bash, WebFetch, save_memory, recall_memory
- ✅ Prompt caching on system prompt + history turns (cache points in `agent.ts`)
- ✅ ModelClient interface — extracted to `src/main/model/` (seam in `types.ts`, factory in `index.ts`). **Anthropic** (default, owns prompt caching) + **Ollama** (configurable host → laptop or brain box) backends implemented; **claude-cli** (subscription) is a documented stub (needs delegated-turn mode that bypasses the permission gate). Backend/host/model are SQLite-stored prefs (`store.ts`), settable via `agent:setBackendConfig` IPC. Loop in `agent.ts` is now backend-agnostic.
- ✅ Remove `@anthropic-ai/claude-agent-sdk` dependency
- ✅ Verify: same tool execution behaviour, streaming, permission gating

> **⚠️ Billing consequence — do not lose track of this.** Owning the loop means we
> now call the raw API with an `sk-ant-api…` key (`agent.ts` `getClient()` →
> `new Anthropic({ apiKey })`). That is **metered pay-per-token billing**, a
> *separate rail* from the flat Pro/Max subscription. The old Agent SDK rode the
> subscription only because it spawned Claude Code (OAuth via `~/.claude`) under
> the hood. "Own the transparent loop" and "ride the flat subscription" are
> mutually exclusive through supported means. The flat rate is recoverable only by
> delegating a turn to the `claude -p` CLI as a ModelClient backend (see Phase 8),
> or by going local (zero marginal cost). Titlebar cost meter is now *real* spend,
> not an estimate.

---

## Phase 0 — Foundation hardening 🔴  ← ✅ DONE

- ✅ Wire `memory.ts` into the agent loop (`buildSystemAppend` loads index + facts, cached 60s)
- ✅ First-class memory tools (`save_memory` / `recall_memory`) — run without permission prompt
- ✅ "New conversation" control — `resetSession()`, archives thread via DB view floor
- ✅ Cost meter in titlebar (cumulative estimate, resets on new conversation)
- ✅ Chat spacing + markdown formatting tightened (`remark-breaks`, reduced margins)
- ✅ Tool discipline hint in system prompt (no unnecessary tool calls for conversational replies)
- ✅ Auth/error UX — `KeySetup` component + actionable auth error messages

## Phase M — Multi-project foundation (the spine) 🔴  ← TOP PRODUCT PRIORITY
*Hold the whole Livana ecosystem at once. Everything ops-related builds on this.*

- **Project registry (generic)** — a list of overseen repos, each with a cwd, display name,
  and per-project config (analytics IDs, CI commands, PR rules). Stored in SQLite (`store.ts`),
  editable. **Ecosystem-agnostic by design** — the 3 Livana repos are just the seed entries;
  pointing Artemis at a different ecosystem is adding rows, not changing code.
- **Project switcher** — titlebar/HUD control to set the active project; the agent loop's
  `repoRoot()` becomes per-project instead of hardwired to Artemis's own repo.
- **Per-project memory namespaces** — facts/episodes scoped to a repo (pairs with Phase 3),
  plus a shared "ecosystem" scope for cross-cutting facts.
- **Per-project status** — last-touched, current branch, dirty/clean, last analytics pull.
- **Done when:** Artemis can switch to `livana-scanner`, answer "what's the state of this
  repo?", and act in its cwd — without losing its own self-repo as one project among many.

### Walking skeleton — the first vertical slice (do this next)
*Prove the whole shape cheaply before building each pillar out.* One thin path that
touches all three pillars, read-mostly and safe:
1. **Multi-project (min):** register the 3 repos; switch active project; agent acts in that cwd.
2. **Reach (read-only):** one GA4 overview for the active project via the Google Analytics
   Data API (users/sessions last 7d) — no writes, no actions.
3. **Worker (gated):** given an issue, a worker sub-agent opens a **PR** in the right repo
   (runs that repo's checks first where they exist) — never pushes to main — and logs it to a
   minimal **PR Review Queue** card (link + reviewed checkbox), the seed of the Phase 6 queue.
If this slice feels right, widen each pillar (full reach in Phase 5, full workers + digests
in Phase 6). If the shape's wrong, you learn now, not after building two whole phases.

## Phase 1 — Give Artemis ears 🔴  ← DEMOTED (below the ops spine) · ✅ STT working / wake word pending

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

- **Semantic tier** — embed each memory fact, recall by similarity via `sqlite-vec`. Inject only relevant facts per turn (replaces "inject everything every turn" — currently every fact is injected on every turn in `agent.ts`, which both dilutes attention and burns tokens).
- **Garbage collection + conflict resolution** — dedup near-identical facts, supersede stale ones, resolve contradictions instead of accumulating forever. Memory that only grows becomes noise (and cost). This is a quality *and* a billing lever.
- **Auto-capture** — propose durable facts at the end of meaningful turns
- **Episodic log** — summaries of past conversations, searchable
- **Per-project memory** scoping
- **Done when:** Artemis recalls the right detail unprompted weeks later — and asking
  "what did we discuss last time?" / "what were we working on yesterday?" returns a
  real, accurate summary of the archived thread, not "that's out of my context."

## Phase 4 — Senses 🔴
*See what you see.*

- **Screen awareness** — capture active window/region on request, reason over it (vision models)
- **File drag-and-drop** into chat — images, PDFs, code
- **Clipboard / selection** awareness as opt-in context
- **Done when:** "what's this error?" and Artemis already sees your screen

## Phase 5 — Hands and reach 🔴
*Act beyond the repo.*

- **MCP integration** — calendar, email, GitHub, Slack, notes, smart home — gated by permission flow
- **Product data connectors (read-only)** — pull from the Livana product databases (the Lumi/LumiLens **MongoDB Atlas**: reviews, subscribers, scan/usage records) for summaries and overviews. Start **read-only** behind a per-project connection config; any write capability is a separate, explicitly-gated decision. Pairs with the GA4 analytics intake to give Reuben a real "state of the products" briefing.
- **Trust boundary for untrusted content** — the moment Artemis can *read* email/web AND *act* (send, book, run), prompt injection becomes a real attack surface ("ignore previous instructions and …" hidden in an email/page). The current `DANGEROUS` regex blocklist won't catch this. Required: treat all fetched/received content as untrusted data (never instructions), and require explicit confirmation for any *outward-effecting* action (send/post/pay/delete), separate from the existing command gate.
- ✅ **Connections & onboarding UI + GA connector (BUILT 2026-06-24)** — titlebar ⚙ panel:
  Anthropic key (set/clear), GitHub (live `connected as <user>`), Google Analytics
  (service-account JSON via safeStorage + per-project GA4 property id). GA connector is
  SDK-free (service-account JWT via Node crypto → GA Data API REST); `ecosystem_status`
  now appends a live last-7-days GA line per configured project, so the morning review
  includes analytics. Still TODO: clone-from-GitHub; richer GA (top pages, trends).
- **Connections & onboarding UI (portability)** — a single "Connections" panel so moving
  Artemis to a new machine is point-and-click, not terminal setup. Shows live status and
  setup for each integration: Anthropic API key (already have `KeySetup`), **GitHub** (`gh
  auth status` → connected-as, with a guided `gh auth login`), **Google Analytics**
  (file-pick a GA4 service-account JSON, stored encrypted via `safeStorage` like the API
  key, + per-project property IDs), and **clone-from-GitHub** (pull a Livana repo that
  isn't local yet). Pairs with building the GA connector — the GA credential picker needs
  a home, so build this alongside that work.
- **Skill library** — reusable named procedures Artemis can invoke
- **Web actions** beyond fetch/search — structured browsing
- **Done when:** "Artemis, book that and email them the link" works end-to-end

## Phase 6 — Proactivity + sidecar brain 🔴
*Stop waiting to be asked.*

- **Sidecar brain daemon** — move agent loop to a persistent local process; Electron becomes a reconnectable face (cornerstone level 2, lands here because proactivity needs it too)
- **Scheduling / cron** — run tasks on timer or trigger ("every morning, brief me")
- **Background / worker agents** — long-running fix-it sub-agents across repos. Each runs the
  target repo's own checks (where they exist), then **opens a PR — never pushes**. Multiple
  can run in tandem.
- **PR Review Queue (UI card)** — every PR a worker agent opens is logged to a persistent card
  (repo · title · agent · timestamp · link-out · reviewed checkbox), stored in SQLite so it
  survives restart. Reuben comes back in the morning, clicks through each PR, and checks it off.
  This is the human-approval surface for agent autonomy.
- **Watchers** — monitor a repo, inbox, deploy, analytics; surface what changed
- **System notifications** + "what I did while you were away" digest
- **Done when:** Artemis tells *you* things at the right time, and overnight worker-agent PRs
  are waiting in the review queue for you to approve over coffee.

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
- **Eval loop** — small harness so mind changes can be measured, not just vibe-checked. **A minimal version should be pulled forward to ~Phase 2** (see Current sprint): every change today is verified by restarting and talking to it. A ~10-case smoke harness (does it still read / edit / remember / speak / gate correctly?) is cheap insurance that makes every later phase faster to trust — and is a prerequisite for safe self-modification, not a successor to it.
- **Changelog memory** — remembers what it changed about itself and why
- **Done when:** "Artemis, improve your own X" is a safe, routine operation

---

## Current sprint

1. ✅ ~~Graceful restart (cornerstone level 1)~~
2. ✅ ~~Phase 0 — foundation~~
3. ✅ ~~Phase 1 (partial) — STT working, text barge-in done~~
4. ✅ ~~Architecture milestone — own the agent loop~~ (commit `b01c148`)
5. ✅ ~~`ModelClient` abstraction~~ — built in `src/main/model/`: Anthropic + Ollama backends, claude-cli stubbed. Switch via `window.artemis.agent.setBackendConfig({backend:'ollama', ollamaHost, ollamaModel})`. Renderer backend-picker UI still TODO (🟢, no restart).
6. ✅ ~~Minimal eval harness~~ — `npm test` (vitest): 15 fast/free/deterministic smoke cases over read/edit/glob/grep/execute, speak-split, danger gate, memory recall, conversation assembly, Ollama translation. Electron + native-SQLite stubbed so it runs under plain Node. (Store view-floor/undo/turn-recovery still needs an Electron-context test — follow-up.)
7. **Walking skeleton — the Livana ops slice** (Phase M) ← *next*: register the 3 repos +
   project switcher; one read-only GA4 overview; one gated worker-agent PR. Proves the spine.
8. **Multi-project foundation** (Phase M, full) — registry, switcher, per-project cwd/memory/status.
9. **Sidecar brain (cornerstone L2)** — now load-bearing: background workers + live monitoring
   must outlive the Electron window. Pulled up; pairs naturally with the new always-on machine.
10. **Reach** (Phase 5) — Google Analytics Data API + GitHub connectors (gated, PR-based).
11. **Worker agents + proactive digests** (Phase 6) — fix-it sub-agents across repos; "what
    changed / what needs attention" overviews.

*Deferred below the spine:* harden the store with Electron-context tests + wire real cost
visibility (do alongside the skeleton); then wake word + VAD (Phase 1), neural TTS (Phase 2),
senses (Phase 4), local models (Phase 8).

---

*Maintained by Artemis & Reuben. Last updated June 2026.*
