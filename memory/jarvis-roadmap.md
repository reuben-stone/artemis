---
name: jarvis-roadmap
description: Roadmap-to-Jarvis status and next steps
metadata:
  type: project
---

Artemis is being built toward a Jarvis-class voice operator per ROADMAP-TO-JARVIS.md (repo root).

FULLY DONE:
- Phase 0 (memory, tools, cost meter)
- Phase 1 STT (whisper-tiny.en fp32 WASM, verified live 2026-06-24); wake word + VAD still pending
- Phase 4 SENSES — SUBSTANTIALLY DONE (2026-06-25): file drag-and-drop / paste / paperclip into chat (images=vision, PDFs=document, text/code inlined) AND on-demand screen capture (desktopCapturer source picker → flows in as an image attachment; macOS Screen Recording permission). "What's this error?" with a captured screen works on-demand. NOT a tool — passive input Reuben hands in. STILL OPEN in Phase 4: continuous/always-on variants (watch screen/clipboard/filesystem) — deferred to the sidecar daemon (needs always-on process). Vision needs a cloud model; local backend won't interpret images.
- Architecture milestone (raw SDK agent loop, ModelClient abstraction with Anthropic + Ollama backends, prompt caching)
- Graceful restart (SQLite backbone, level 1 cornerstone)
- Minimal eval harness — `npm test` (vitest): smoke cases covering read/edit/glob/grep/execute, speak-split, danger gate, memory recall, conversation assembly, Ollama translation (47 pass as of board work)
- Multi-project foundation (Phase M walking skeleton + full): project registry, switcher, per-project cwd, ecosystem_status tool, dispatch_worker tool, PR Review Queue (SQLite-backed)
- Connections & onboarding UI + GA connector (built 2026-06-24): ⚙ panel for Anthropic key, GitHub live-status, Google Analytics service-account JSON (safeStorage); GA4 last-7-days injected into ecosystem_status / morning reviews
- Toolbar redesign: lucide-react icons, lean bar, tabbed Settings modal, drag + brand spacing
- HUD left rail + day planner (built 2026-06-25): collapsible Artemis-managed rail; local tasks (todo/doing/done, priority, project, tags, day) + local calendar, local-first SQLite (todos/events), CRUD by Artemis tools AND user in rail. Tools: tasks_view/task_add/task_update/task_remove/task_carry_over, calendar_view/event_add/event_update/event_remove, plan_my_day. source+external_id columns reserve future import/sync (all source='local' today).
- THE NORTH-STAR TICKET OPERATOR LOOP (built 2026-06-25) — GitHub Projects v2 ingest via `gh api graphql` → project_tickets SQLite cache (full-replace per board) + connector src/main/board.ts. Tools: tickets_view (read, auto-allow), ticket_create / ticket_comment / ticket_update (gated writes). dispatch_worker takes ticketNumber → branch artemis/ticket-<n> + PR body Closes #<n> (GitHub auto-Done on merge). Outcome awareness: pr_queue refresh pulls live merge/CI/review via `gh pr view --json`. UI: OpsRail board card + BoardPanel (status columns, per-ticket Dispatch) + show_panel 'board' (with board + ticket params). MONOREPO = ONE project mapping to a LIST of boards (JSON array at meta gh_project:{path}); each board has optional subdir; worker focuses subdir but keeps full-repo access. Board filter shared via localStorage artemis.board.filter (by boardTitle, not project). AUTH = gh CLI; Projects v2 needs `gh auth refresh -s read:project,project`. Multi-provider (Jira/Azure) seam prepped (provider-neutral nouns, BoardConfig.provider default github) but interface NOT frozen — build gated on real need.
- VOICE-FIRST UI PARITY (slices 1-4, 2026-06-25): TasksView modal, CalendarView deep-link, live-refresh on turn settle, pr_review/notifications_view/notifications_mark_read tools, NotificationsView modal, app_control tool (model/backend/voice). Permission posture excluded by design (security gate stays human-only).
- WORKER MODEL DECOUPLED (2026-06-26): workers run on separate cheaper model (default claude-sonnet-4-6) independent of chat model. store.getWorkerModel/setWorkerModel; Settings→Model "Worker model" seg. Endgame = route workers to local Ollama (free) once new Mac arrives.
- WORKER DISPATCH HARDENED (2026-06-26): runChecks returns structured pass/fail/skip. Checks FAIL → PR opens as DRAFT (⚠️ banner, can't merge by accident, diff preserved). PR body leads with check-status banner + "What the worker did" activity log (full tool trail, auditable). Round-cap hit flagged in PR + result. WorkerResult.note surfaces status in chat + board. ARTEMIS-CORE updated to relay check status.
- ticket_comments tool (2026-06-26): read ONE ticket's full discussion (description + comment thread) live from GitHub. AUTO_ALLOW. Enables pre-dispatch context reading so workers get full spec including teammate comments.
- VoiceClient seam (2026-06-26): system/kokoro/elevenlabs stubs — neural TTS groundwork laid.
- Composer prompt-history + model chip, styled tooltips with viewport clamp (2026-06-26).

CURRENT FOCUS (as of 2026-06-26): agentic tooling + HUD UI / Artemis capabilities. Sidecar brain ON HOLD until Reuben has a new external drive.

NEXT ITEMS while sidecar is parked:
- Dispatch outstanding LumiLens tickets (#7, #9, #10) — pending Anthropic credit top-up
- RAG/retrieval layer (sqlite-vec, scoped in roadmap Phase 3)
- Ticket-import + Google Calendar connectors
- Wake word + VAD (Phase 1 remainder)
- Neural TTS via VoiceClient seam (Phase 2)
- CONTINUOUS senses (Phase 4 remainder) — needs sidecar
- Local model routing (Phase 8)

PARKED:
- Sidecar brain (cornerstone L2) — persistent daemon; blocked on external drive.

Decisions: local-first throughout; cloud only as optional backup/sync. Agents propose (PRs), human approves.
