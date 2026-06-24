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
| Agentic mind (Claude Agent SDK, Opus 4.8) | ✅ Streaming, resumable sessions, tool-gating | `src/main/agent.ts` |
| Self-hosting (reads/edits own source, runs terminal) | ✅ cwd = own repo, gated by permission dialog | `src/main/agent.ts`, `TerminalPane.tsx` |
| Body (3D orb, 5 states) | ✅ idle/thinking/executing/speaking/error | `src/renderer/src/components/Orb.tsx` |
| Voice **out** (TTS → orb pulse) | ✅ Web Speech API, word-boundary envelope | `src/renderer/src/hooks/useVoice.ts` |
| Spoken summaries (`⟦say⟧` marker) | ✅ Screen gets detail, voice gets the gist | `agent.ts`, `agent/speech.ts` |
| Memory (file tier) | ⚠️ Store exists but **not wired into the agent loop** | `src/main/memory.ts` |
| Permission / safety gating | ✅ Dangerous-cmd blocklist + UI approval | `src/main/agent.ts`, `PermissionDialog.tsx` |
| Terminal pane | ✅ node-pty, toolbar toggle | `src/main/index.ts`, `TerminalPane.tsx` |
| Voice **in** (STT / wake word) | ❌ Not built | — |
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
- **Batch main-process work.** Group `src/main` edits so we take the session-killing restart once, not repeatedly.

---

## Architectural cornerstone — the brain must outlive the face 🔴
*A restart should never close our session. This underpins every phase below.*

**The problem.** Editing `src/main/**` or `src/preload/**` makes electron-vite relaunch the
whole Electron process, which feels like losing the conversation. It's already *half*
solved: the Agent SDK session id is persisted to disk (`artemis-session.json`) and
`resume`d each turn, so the conversation's *memory* survives. What dies is the on-screen
transcript (React state), any in-flight turn (the `turns` buffer is in-memory only), and
the terminal (its pty is killed). So it *feels* like the session closed even though the
mind didn't fully forget.

**Fix in two levels — we want both:**

1. **Graceful restart (cheap, do first).** Persist the full transcript + terminal
   scrollback to disk and restore them on boot, the same way the session id already is.
   A restart becomes a ~1s blink that returns with everything intact instead of a wipe.
   Extends the pattern already in `agent.ts`.
2. **Sidecar brain (the real fix).** Move the agent loop out of the Electron main process
   into a **persistent local daemon**. The Electron app becomes a disposable *face* that
   connects over IPC/websocket. Then restarting the window — for any UI or shell edit —
   leaves the daemon (live session, terminal, agent state) running; the face just
   reconnects. Only editing the daemon's own code restarts the brain. Bonus: this same
   always-on process is exactly what **Phase 6 (proactivity)** needs for background agents
   and watchers.

- **Done when:** editing the UI or Electron shell, then taking a restart, leaves the
  conversation and terminal exactly as they were — no lost turn, no wiped transcript.

**Status — graceful restart (level 1): DONE & running.** `src/main/store.ts` is the live
SQLite backbone; the transcript, in-flight turn, and rolling-capped terminal scrollback all
persist and restore. Verified running in dev (new messages commit to SQLite). The sidecar
brain (level 2) remains future work, slated alongside Phase 6.

**Known issues:**
- *Migration-guard ordering bug (low priority).* The one-time localStorage→SQLite transcript
  migration in `App.tsx` is gated on "SQLite is empty", but `electron-vite dev` auto-restarts
  on every `src/main` save, so an earlier boot (backbone landed, migration not yet) committed
  a greeting into SQLite — leaving it non-empty and short-circuiting the migration. Fix: gate
  on "no *user* messages yet" (or "contains only a single auto-greeting") instead of "empty",
  so a seeded greeting doesn't block the import. Largely moot now (the real transcript was
  ported directly), but worth correcting so the path is sound.

### Data & persistence — decided

- **Local-first SQLite** (`better-sqlite3`) is the single persistence backbone: transcript,
  terminal scrollback, and session state now; the semantic-memory vector tier (via
  `sqlite-vec`) in Phase 3. One engine that grows with the roadmap, not three.
- **No cloud runtime dependency.** Reads/writes hit the embedded file directly — synchronous,
  instant, and fully offline. The whole point is surviving a *local* restart fast; a network
  hop would defeat it.
- **Cloud is optional and later**, only for backup or multi-device sync — bolted on as a sync
  layer (libSQL/Turso embedded replica, or Litestream → S3) without changing local-first
  access. The `memory/` fact tier is already cloud-backed via git on GitHub.
- **Portability.** Moving to a new machine = pull the repo + copy one SQLite file (it lives
  under `userData` in packaged builds, outside the repo). No server to migrate, no
  export/import. With the optional sync layer added, even the file-copy disappears — the new
  machine logs in and pulls. The SQLite file stays **out of git** (binary diffs/merge noise);
  the human-readable `memory/` facts stay git-tracked.

## Phase 0 — Foundation hardening 🔴  ← *wrapping up*
*Make the existing mind unshakeable before we pile on.*

- ✅ Wire **`src/main/memory.ts` into the agent loop** — `buildSystemAppend` now loads the memory index + facts into context, not just `ARTEMIS.md`.
- ✅ **First-class memory tools** (`mcp__memory__save_memory` / `recall_memory`) via an in-process SDK MCP server, so the operator curates its own memory mid-conversation (runs without a permission prompt).
- ✅ **Session/cost in the UI + "new conversation" control** — running cost shows in the titlebar; "＋ new" drops the SDK session and archives the thread via a DB *view floor* (history kept, not deleted).
- ◻︎ Error & auth UX: clearer states when the key/login is missing — already in reasonable shape (KeySetup + actionable auth error); revisit if it bites.
- **Done when:** Artemis reliably remembers facts across restarts *and* uses them in answers, with visible session state. → **essentially met; pending the restart that loads the memory tools + a quick live check.**

## Phase 1 — Give Artemis ears 🔴  ← *active*
*The single biggest leap toward Jarvis: talking instead of typing.*

- ✅ **Capture foundation** — `useSpeech` grabs the mic, pulses the orb to your live voice, records, and emits mono 16kHz Float32 samples through a swappable `transcribe()` seam. Mic button + `listening` orb state + main-process mic permissions.
- ✅ **Barge-in** — starting to listen cancels in-progress TTS.
- ✅ **Speech-to-text engine** — local Whisper (`whisper-tiny.en`) via transformers.js in a Web Worker (`agent/whisper.worker.ts`). Model downloads once from the HF hub, then browser-cached (offline after). Builds clean; **pending a live restart to confirm runtime** (model fetch + mic).
  - *CSP note:* needed a scoped relaxation in `index.html` — `wasm-unsafe-eval` + `connect-src` to the HF hub & jsDelivr (onnxruntime WASM). **Tightening path: vendor the model + WASM into the app to drop the remote `connect-src` and restore a strict CSP (true offline-first).**
- ◻︎ **Wake word** ("Artemis…") for hands-free activation.
- ◻︎ **Voice activity detection** so it knows when you've finished a thought (auto-stop) — pairs well with upgrading `whisper-tiny.en` → `base` for accuracy.
- **Done when:** you can hold a spoken back-and-forth, hands-free, and interrupt naturally.

## Phase 2 — A voice worth listening to 🟢→🔴
*From robotic to alive.*

- Swap Web Speech for **streaming neural TTS** (e.g. ElevenLabs) — the `useVoice` swap path is already documented: pipe audio through a Web Audio `AnalyserNode` into the same `amplitudeRef`, so the orb code is untouched (🟢). API key plumbing lives in main (🔴).
- **Lower latency**: start speaking the first sentence while the rest still streams.
- **Expressiveness**: tone/pace that matches state (calm idle, crisp executing, warm summaries).
- **Done when:** Artemis's voice is indistinguishable-from-human enough that you forget it's TTS.

## Phase 3 — Living memory 🔴
*Remember everything that matters, recall it at the right moment.*

- **Semantic tier** on top of the file store: embed each memory, recall by similarity (the `memory.ts` comment already anticipates this — "a semantic/vector tier can be layered on later").
- **Auto-capture**: Artemis proposes durable facts at the end of meaningful turns ("want me to remember that?").
- **Episodic log**: optional summaries of past conversations, searchable — so it *does* have persistence of prior sessions when useful.
- **Per-project memory** scoping.
- **Done when:** Artemis recalls the right detail unprompted, weeks later.

## Phase 4 — Senses 🔴
*See what you see.*

- **Screen awareness**: capture the active window/region on request, reason over it (Opus vision).
- **File drag-and-drop** into the chat — images, PDFs, code.
- **Clipboard / selection** awareness as opt-in context.
- **Camera** (optional) for true presence.
- **Done when:** you can say "what's this error?" and Artemis already sees your screen.

## Phase 5 — Hands and reach 🔴
*Act beyond the repo.*

- **MCP integration**: connect Model Context Protocol servers for calendar, email, GitHub, Slack, notes, smart home — each gated by the existing permission flow.
- **Skill library**: reusable Artemis "skills" (saved multi-step procedures) it can invoke by name.
- **Web actions** beyond fetch/search: form-filling, structured browsing.
- **Done when:** "Artemis, book that and email them the link" works end-to-end.

## Phase 6 — Proactivity 🔴
*Stop waiting to be asked.*

- **Scheduling / cron**: Artemis runs tasks on a timer or trigger ("every morning, brief me").
- **Background agents**: long-running tasks that report back via notification, not a blocked chat.
- **Watchers**: monitor a repo, an inbox, a deploy — surface what changed.
- **System notifications** + a "what I did while you were away" digest.
- **Done when:** Artemis tells *you* things, at the right time, without a prompt.

## Phase 7 — The HUD 🟢
*A presence, not a window.*

- **Ambient mode**: a small always-on-top orb that listens and glances, expands on interaction.
- **Glanceable widgets**: current task, calendar, notifications, system status around the orb.
- **Richer chat**: collapsible tool calls, diffs, inline media, command palette.
- **Theming & settings** surface (voice, model, permissions, integrations) — all renderer, safe to iterate live.
- **Done when:** Artemis feels like part of the desktop, not an app you open.

## Phase 8 — Self-improvement 🔴
*Artemis builds Artemis.*

- **Guided self-modification**: Artemis proposes, diffs, and (with approval) applies changes to its own code, then rebuilds — the restart-aware workflow it already understands.
- **Eval loop**: a small harness so changes to the mind can be measured, not just vibe-checked.
- **Changelog memory**: it remembers what it changed about itself and why.
- **Done when:** "Artemis, improve your own X" is a safe, routine operation.

---

## Suggested first sprint

The highest-leverage, most *felt* improvements, in order:

1. **Graceful restart (cornerstone, level 1).** Persist transcript + terminal, restore on boot — so the work below never costs us a session. Stop the bleeding first. (🔴 one restart to land it.)
2. **Phase 0 — wire memory into the loop.** Small, foundational, immediately makes Artemis feel like it knows you.
3. **Phase 1 — ears (STT + barge-in).** The transformational leap. Talking to Artemis is the moment it stops being a chat app.
4. **Phase 2 — neural voice.** Pairs with ears; together they make Artemis *present*.

The **sidecar brain** (cornerstone, level 2) is the bigger architectural move — schedule it
once we want background/proactive behaviour (Phase 6), since it pays for itself twice there.

Everything after compounds on those three. Memory makes it yours; voice makes it alive;
the rest makes it powerful.

---

*Maintained by Artemis & Reuben. Last updated June 2026.*
