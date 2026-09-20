# Roadmap

> The plan for growing Artemis from an operator into a proactive, always-present
> assistant for a whole product ecosystem. This is a living document - we revise
> it as we ship.

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

## The north star — the ticket operator loop  ← ✅ BUILT (2026-06-25)

The single feature that turns Artemis from "a clever assistant" into a **true repo
operator**: one operator holding a **cross-repo feed of project tickets**, dispatching
agents at them, and producing PRs that are all linked back through GitHub's own graph.
This is the *mechanism* of the Livana ops-layer use case — it ties together pillars 1 and 3
(multi-project oversight + worker agents) into a single loop.

**Shipped (2026-06-25):** GitHub **Projects v2** board ingest via `gh api graphql` →
`project_tickets` cache (`store.ts`) + connector (`board.ts`); `tickets_view` / `ticket_create`
tools; **dispatch-from-ticket** linkage (worker branches `artemis/ticket-<n>`, PR body
`Closes #<n>` → GitHub wires ticket↔PR↔board and auto-Dones on merge); **outcome awareness**
(`pr_queue refresh` + PR card badges pull live merge/CI/review state — "close the loop I
open"); HUD board rail card + full `BoardPanel` (status columns, per-ticket dispatch); board
mapping + scope hint in Settings → Connections. Auth rides the existing `gh` CLI — Projects v2
needs `gh auth refresh -s read:project,project` once. Ticket creation makes the loop bidirectional.

**The loop:**

1. **Ingest** — pull tickets from **GitHub Projects (v2) / Issues** across the ecosystem
   repos. A ticket is its own entity (number, title, repo, project, **assignee**, **status
   column**, labels, linked PRs) — *not* a personal todo.
2. **Overview** — a cross-repo board in the HUD: what's open, **what's assigned to what**,
   in what status. The "state of the work" the way `ecosystem_status` is the state of the code.
3. **Dispatch** — send a worker agent at a chosen ticket. It branches `artemis/ticket-<n>`,
   does the work, runs that repo's checks, and **opens a PR — never pushes** (the existing
   `dispatch_worker` posture).
4. **Link** — the PR references the ticket (`Closes #<n>` + branch convention), so **GitHub
   itself** wires ticket ↔ PR ↔ repo ↔ project together. Artemis rides that graph; it does not
   rebuild it.
5. **Approve** — the PR lands in the **PR Review Queue**; the human reviews and merges; GitHub
   moves the ticket to Done. Loop closes.

**Design commitments (learned-the-hard-way constraints, not decoration):**
- **GitHub is the source of truth.** Artemis caches **read-mostly** and writes back only
  narrow, explicit mutations (open PR, move status, comment/link). No two-way mirror — drift
  is the death of these systems.
- **Riding GitHub's native linking is the whole trick.** `Closes #n` + branch naming makes the
  ticket/PR/repo/project graph assemble itself. Don't reimplement it.
- **Dispatch stays human-gated.** A ticket appearing must *not* auto-run an agent. The feed
  makes *selection* effortless; *firing a worker* stays a gated decision until trust is earned.
- **Projects v2 is GraphQL-only** — richer (status columns, custom fields, cross-repo boards)
  but a real connector cost. The board view is the value, so it's likely worth it; budget it,
  don't assume it's a quick REST call.
- **"Assigned to Artemis"** needs a concrete signal (a label or a Project field) so the agent
  knows its queue versus the humans'.

**Two-tier task model (keep these separate):**
- **Personal daily todos** — lightweight, local-first, ephemeral, the user's own day. *Built*
  (Phase 7 day planner: the `todos`/`events` tables + HUD rail). Personal layer only.
- **Project tickets** — authoritative, GitHub-synced, a distinct richer entity and its own
  data model + board. *The subsystem described here.* These never collapse into the daily list,
  though Artemis can promote a ticket into "today's focus" on the personal list when working it.

**Sequencing:** depends on the Phase 5 GitHub connector; builds on the Phase 6 worker-agent +
PR-queue machinery; surfaces in the Phase 7 HUD as the cross-repo board. A multi-week subsystem,
not a quick add-on — named here as the thing the spine is *for*.

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
- **Data migration / import (planned).** A guided "import from another instance" path so a
  user can bring their historic data — transcript, project registry, memory, PR queue,
  encrypted credentials — into a fresh instance, e.g. **dev → packaged app** or **old
  machine → new machine**, instead of starting empty. (A packaged build uses its own
  `userData` keyed to the bundle, so it never inherits the dev instance's data.) Pairs with
  the Connections & onboarding UI (Phase 5). Low priority — the copy-one-SQLite-file path
  already covers power users; this is the point-and-click version for everyone else.

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
- 🟡 **STT optimization** — `q8` was tried live (2026-06-25) and **failed to build** on the
  current onnxruntime-web (broken 4-bit MatMulNBits), so we stay on **fp32**. Kept the win
  that's safe: **warm the model when the mic is enabled** (download + construct up front) so
  the first transcription isn't slow. The real speedup is still open: **multi-threaded WASM**
  (needs COOP/COEP cross-origin isolation — the most promising next step) or `whisper-base.en`
  (more accurate, slower). WebGPU is *not* faster than WASM for Whisper on M-series (revisit Q4 2026).
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
- **Semantic recall over archived threads (retrieval tool)** — Artemis's biggest blind spot
  today: it sees only the active thread; everything below the view floor is genuinely
  unreadable unless hand-saved as a fact. A retrieval tool that searches the SQLite transcript
  (over the episodic summaries + the semantic tier above) turns "what did we decide about X
  last week?" into a real answer instead of "that's archived." This is the agent-facing read
  path that the episodic log + semantic tier exist to feed — highest-leverage gap in the *mind*.
- **Per-project memory** scoping
- **Retrieval / RAG layer (`sqlite-vec`) — scoped, NOT a bolt-on over the live tools.** RAG
  earns its place only for corpora **too big for context that need *semantic* (fuzzy) search**.
  Two real targets: **(a) semantic memory** — the tier above (archived threads, memory facts,
  episodic summaries); and **(b) cross-repo code search** — embed the ecosystem's code so "where
  do we handle X across the 4 repos?" retrieves the right chunks (great for scoping worker
  dispatches). It's a *retriever* (small local embedding model — nomic/bge — + a `sqlite-vec`
  index on the existing SQLite backbone), feeding the existing model; you build no model and
  retrieval is **free + local**. EXPLICIT BOUNDARY: do **NOT** put RAG in front of the live ops
  tools (`tickets_view`, `ecosystem_status`, `ticket_comments`, GA, git) — that data is small,
  structured, and fetched directly on demand; a vector layer there adds latency + infra for no
  gain. Live structured data = direct tool-calls; big/fuzzy/historical = RAG. (Distinct from
  "run read-tools on the local LLM", which is *model routing*, not retrieval — don't conflate.)
- **Done when:** Artemis recalls the right detail unprompted weeks later — and asking
  "what did we discuss last time?" / "what were we working on yesterday?" returns a
  real, accurate summary of the archived thread, not "that's out of my context."

## Phase 4 — Senses 🔴  ← ✅ SUBSTANTIALLY DONE (2026-06-25)
*See what you see.*

- ✅ **File drag-and-drop / paste / paperclip** into chat — images (vision), PDFs (document
  blocks), text/code (inlined). Sent as multimodal content to the cloud model.
- ✅ **Screen capture** on request — `desktopCapturer` source picker → still flows in as an
  image attachment. (macOS Screen Recording permission; in dev attributed to the terminal,
  clean as "Artemis" in the packaged app.)
- ✅ **OS-context awareness** (`system_context` tool) — time, machine, active project,
  frontmost app, battery, network.
- ✅ **Clipboard read** (`read_clipboard` tool) — current clipboard text; permission-gated.
- ◻︎ **Webcam / presence** — deferred (low value for the mission; needs Camera permission).
- ◻︎ **Continuous variants** (watch screen/clipboard/filesystem, always-listen) — deferred to
  the sidecar (need the always-on daemon).
- **Done when:** "what's this error?" works with a captured screen — ✅ for on-demand;
  always-on watching waits on the sidecar.

## Phase 5 — Hands and reach 🔴
*Act beyond the repo.*

- **MCP integration** — calendar, email, GitHub, Slack, notes, smart home — gated by permission flow
- **GitHub ticket connector (the ingest half of the ticket operator)** — read tickets from
  **GitHub Projects v2 / Issues** across the ecosystem repos (number, repo, project, assignee,
  status column, labels, linked PRs). Projects v2 is **GraphQL-only**; this is the connector
  that feeds the cross-repo board and the dispatch loop (see "The north star"). Read-mostly;
  GitHub stays the source of truth. Also covers **Google Calendar** read/write so the Phase 7
  local calendar can sync (today it's `source='local'`).
- **Multi-provider board connectors (nice-to-have, demand-gated)** — extend the ticket board
  beyond GitHub Projects to **Jira** and **Azure DevOps Boards**, so a project tracked on those
  shows up in the same cross-repo board + dispatch loop. The groundwork is already laid: the
  cache (`project_tickets`), agent tools, and UI speak provider-neutral nouns, and every board
  carries a `provider` tag (`BoardConfig.provider`, default `'github'`). `src/main/board.ts` is
  the GitHub **reference** connector; a new provider is a sibling module selected by that tag.
  Per-provider specifics: **Jira** = REST v3 + JQL, OAuth/API-token auth, status changes are
  workflow *transitions*; **Azure** = REST + WIQL, PAT auth, work-item *states*. Auth is the real
  lift — no longer riding `gh`, so tokens go through `safeStorage` (same pattern as the Anthropic
  key / GA JSON). The north-star PR↔ticket loop still closes when code stays on GitHub: swap the
  GitHub-native `Closes #n` for **Jira Smart Commits** (`PROJ-123`) or **Azure Boards** mentions
  (`AB#123`). Deliberately **do not freeze a `BoardProvider` interface until the second
  implementation exists** — the right abstraction (transitions vs states vs field-options) only
  becomes clear then; abstracting earlier would likely be wrong. Gate the actual build on a
  concrete need (a project we oversee that genuinely lives on Jira/Azure).
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
- **Web search / discovery** — a `web_search` tool: query → ranked results (title, URL,
  snippet), then either WebFetch the best hit to read it or hand back the array to choose from.
  Today the only web window is WebFetch, which needs a URL *already in hand* — this turns the
  web from **addressable** into **navigable** ("find me X", "what's the latest on this CVE in
  our deps"). Needs a search backend (Brave / Tavily / SerpAPI behind a key in the Connections
  panel — the local-first-but-cloud-when-needed pattern). *Presentation (renderer, rides on the
  capability):* render results as native cards (title · snippet · favicon) with "open in
  browser" / "read it for me" (WebFetch → summarise), plus a **best-effort** in-app iframe
  preview where the site allows it — many set `X-Frame-Options`/CSP and refuse to frame
  (Google, most news), so the card list is the robust path and the iframe is a bonus. Pairs
  with the senses already shipped: discover → read → summarise is a natural operator move.
- **Skill library** — reusable named procedures Artemis can invoke
- **Web actions** beyond fetch/search — structured browsing
- **Done when:** "Artemis, book that and email them the link" works end-to-end

## Phase 6 — Proactivity + sidecar brain 🔴
*Stop waiting to be asked.*

- **Sidecar brain daemon** — move agent loop to a persistent local process; Electron becomes a reconnectable face (cornerstone level 2, lands here because proactivity needs it too)
- **Scheduling / cron** — run tasks on timer or trigger ("every morning, brief me")
- **Background / worker agents** — long-running fix-it sub-agents across repos. Each runs the
  target repo's own checks (where they exist), then **opens a PR — never pushes**. Multiple
  can run in tandem. **This is the dispatch+PR half of the ticket operator loop** (see "The
  north star"); the missing half is the cross-repo ticket *feed* that selects what to dispatch.
- **PR Review Queue (UI card)** — every PR a worker agent opens is logged to a persistent card
  (repo · title · agent · timestamp · link-out · reviewed checkbox), stored in SQLite so it
  survives restart. Reuben comes back in the morning, clicks through each PR, and checks it off.
  This is the human-approval surface for agent autonomy.
- **Watchers** — monitor a repo, inbox, deploy, analytics; surface what changed
- **Ticket-comment notifications — v2 (background).** v1 is **BUILT** (2026-06-25): new comments
  on watched Projects boards are pulled during board sync, diffed against a per-board "seen"
  watermark (excluding your own), surfaced in a **Notifications rail card** with inline reply +
  mark-read, and read aloud on demand. v1 is **on-sync / on-demand** (it refreshes when you or
  Artemis sync the boards). **v2 needs the sidecar daemon**: poll the boards in the background
  while you're away and **surface + speak new comments unprompted** ("Kofi just replied on #11…"),
  rather than only when you pull. Same machinery, just driven by the proactive tick instead of a
  manual sync — so it lands with the sidecar ([[artemis-target-hardware]]).
- **Outcome-aware follow-up (closing my own loops)** — once Artemis can *see the result of its
  own actions* (CI status, merge/close events, review comments on PRs it dispatched — being
  wired into the current build), proactivity gets a concrete first job: follow up unprompted.
  "The fix I dispatched passed checks and is ready to merge." "That PR's been waiting three
  days." "A ticket I was working slipped." This turns dispatch from fire-and-forget into a
  watched loop, and is the most natural seed for the proactive tick — Artemis surfacing what
  happened to *its own* work without being asked.
- **System notifications** + "what I did while you were away" digest
- **Done when:** Artemis tells *you* things at the right time, and overnight worker-agent PRs
  are waiting in the review queue for you to approve over coffee.

## Phase 7 — The HUD 🟢
*A presence, not a window.*

- **Ambient mode** — small always-on-top orb that listens and glances, expands on interaction
- ✅ **Left-rail HUD sidebar (Artemis-managed widgets) — BUILT 2026-06-25 (day planner)** — a
  collapsible rail in the orb window (the orb pane is mostly empty) hosting *data-backed,
  agent-managed* cards, not decoration. First cards shipped: the day planner.
  - ✅ **Day planner (personal tasks + local calendar)** — the **lightweight personal layer**
    (NOT the GitHub ticket operator — see "The north star" above; these stay separate). Richer
    than a flat checklist: each task has `status` (todo/doing/done), priority, an optional
    project tag, tags, and **carry-forward** of unfinished items day to day. Plus a **local
    calendar** (timed + all-day events). All local-first SQLite (`todos` + `events`),
    CRUD'd by Artemis via tools (`tasks_view`/`task_add`/`task_update`/`task_remove`/
    `task_carry_over`, `calendar_view`/`event_add`/`event_update`/`event_remove`) **and** by the
    user in the rail UI — one source of truth, refetched each turn. `plan_my_day` gathers
    tickets + carry-overs + events in one call so Artemis can synthesise the day (makes the
    "Plan my day" starter chip real). Rail "Plan my day" button hands the day to Artemis.
  - **Built to grow into sync, not replace it:** both tables carry `source` + external ids, so
    later we can **import tickets** (Lumi scanner, GitHub issues/Projects → `source='lumi'/'github'`,
    de-duped on external id) and **sync the calendar** (Google Calendar → `source='google'`)
    without a schema change — today everything is `source='local'`.
  - ✅ **Ops cards in the rail (BUILT 2026-06-25):** a live PR Review card (check-off inline)
    and an Ecosystem health card (per-repo branch/dirty/PRs, lazy + session-cached) sit atop
    the rail as the ops HUD; each expands to its existing full dock.
  - ◻︎ **Google Calendar / ticket-import connectors** — the actual sync, in/after Phase 5 reach.
- ✅ **Agent-driven UI (panel actions) — BUILT 2026-06-25** — the `show_panel` tool lets Artemis
  *drive the interface*, not just emit text: open/focus pr_queue · briefing · calendar · projects ·
  settings · terminal ("show me the PR queue" opens it). Closes the gap where Artemis could read
  the PR queue (`pr_queue`) but not *show* it. Plumbed via an optional emit context into the tool
  loop → a `{ui:{panel}}` event the face maps to its open-handlers. Next: highlight/focus a
  specific project or result, and let the agent expand/collapse the rail.
- **Glanceable widgets** — current task, calendar, notifications, system status around the orb
- **Richer chat** — ✅ collapsible tool calls + diffs, ✅ command palette; inline media TODO
- **Theming & settings** surface — ✅ accent theming; light theme TODO
- **Done when:** Artemis feels like part of the desktop, not an app you open — and the rail is
  a live cockpit (PRs, ecosystem, calendar, day-plan) Artemis keeps current and you act on.

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
- **Self-verification after self-edit (the seatbelt)** — today, when Artemis edits its own
  source it rebuilds and *hopes*. It should close that loop: run the build, parse the result,
  run the relevant test(s), and confirm it's still healthy before declaring done — rolling back
  or flagging if not. Editing the ground you stand on deserves an automatic check, not a vibe.
  Builds on the eval harness below; a prerequisite for routine self-modification.
- **Eval loop** — small harness so mind changes can be measured, not just vibe-checked. **A minimal version should be pulled forward to ~Phase 2** (see Current sprint): every change today is verified by restarting and talking to it. A ~10-case smoke harness (does it still read / edit / remember / speak / gate correctly?) is cheap insurance that makes every later phase faster to trust — and is a prerequisite for safe self-modification, not a successor to it.
- **Changelog memory** — remembers what it changed about itself and why
- **Permission-pattern learning** — Artemis re-asks for spirit-identical commands constantly.
  It should *notice* recurring approvals ("you always approve this shape of command") and
  **propose** them for the per-project allowlist — the human still says yes, but the friction
  of re-confirming the same safe operation drops over time. A learning layer on top of the
  existing permission gate, never a bypass of it.
- **Done when:** "Artemis, improve your own X" is a safe, routine operation

---

## Distribution & auto-update (planned)

Today Artemis is built locally and **self-signed** — fine for one machine (see the README),
but shipping it to *other people* needs two things, both gated on a **Livana Apple Developer
account**:

- **Code signing + notarization (Developer ID).** Self-signed apps are blocked/warned by
  Gatekeeper on anyone else's Mac. A notarized Developer ID build opens cleanly. This is the
  hard prerequisite for any external distribution.
- **Auto-update (`electron-updater`).** Publish releases to a feed (GitHub Releases is
  simplest; S3 / generic server also work); the installed app checks the feed, downloads new
  versions in the background, and installs on relaunch. Note: auto-update only keeps an
  *already-installed* app current — the **initial** download is still an external link
  (website / Releases page), not an in-app channel.

Order: Developer ID + notarization first (so others can run it at all), then electron-updater
on top. Until the developer account exists, self-signed builds are personal-use only.

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
