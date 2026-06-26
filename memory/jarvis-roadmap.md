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

CURRENT FOCUS (as of 2026-06-25): agentic tooling + HUD UI / Artemis capabilities. Sidecar brain ON HOLD until Reuben has a new external drive for it to live on.

NEXT ITEMS while sidecar is parked:
- Migrate ops cards (PR queue, briefing, ecosystem status) into the rail
- Ticket-import + Google Calendar connectors (in/after Phase 5 reach)
- Keep expanding/sharpening Artemis's own tools (ops, senses, worker dispatch)
- Reach (Phase 5) — fuller GA4 (top pages, trends) + GitHub connectors; clone-from-GitHub in Connections
- Worker agents + proactive digests (Phase 6)
- VOICE-FIRST UI PARITY track (started 2026-06-25, Reuben's ask): goal = operate the WHOLE app by voice/tools if needed. Principle = tool–UI parity (every user action has a tool twin) + deep-linkable panels (show_panel takes focus params) + act-then-show (after a mutation tool, open/refresh the view so the user SEES it). Honest framing: voice-CAPABLE for everything, not voice-only-mandatory (voice is poor for dense scanning / drag). Security line: voice must NEVER silently flip permission posture or auto-approve a gated write. SLICE 1 DONE (2026-06-25): new TasksView day-planner modal (src/renderer/.../TasksView.tsx) mirroring CalendarView — day nav, status groups, edit text/priority/project, move-day, visible carry-over (new IPC tasks:listBefore → unfinishedBefore); show_panel gained 'tasks' panel + a `day` param (also accepted for 'calendar'); HudRail Tasks card got a Maximize button; App openTasks + handleUi 'tasks'. SLICE 2 DONE (2026-06-25, renderer-only): CalendarView gained initialDay (deep-link to a day, wired from show_panel calendar day:…) + refreshSignal; TasksView gained refreshSignal; App openCalendar(day?) + passes hudRefresh as refreshSignal to BOTH modals → an already-open Tasks/Calendar modal now LIVE-refreshes when a turn settles (true act-then-show: say "add 3 tasks" with the modal open and watch them appear). SLICE 3 DONE (2026-06-25): new agent tools pr_review (mark reviewed/unreviewed by queue #id, or clearReviewed — local flag, gated), notifications_view (read unread board comments, AUTO_ALLOW), notifications_mark_read (advance watermark, gated); pr_queue output now shows the #id; new NotificationsView modal (reply / mark-all-read / read-aloud) + show_panel 'notifications' + rail Notifications card Maximize. NOTE: agent ticket-comment edit/delete tools were DEFERRED on purpose (the in-app detail view already does it via viewerDidAuthor, and an agent tool needs comment-id discovery the cache lacks — low value vs effort; revisit if voice comment-editing is wanted). SLICE 4 DONE (2026-06-25): app_control tool (AUTO_ALLOW) — model opus/sonnet (store.setModel), backend anthropic/ollama (store.setBackend), voice on/off; model/backend apply next turn + emit ui.control to keep titlebar in sync; voice via ui.control:'voice' → App toggles voiceOn + cancels TTS. EXCLUDED by design: permission posture (security — gate stays human-only/on-screen) and new-conversation (mid-turn hazard). SLICE 5 (wake word + VAD) DEFERRED — it's a large standalone real-time-audio feature (the pre-existing open Phase 1 item), warrants its own focused session, not a late-night half-build. ARTEMIS-CORE updated for slices 1-4. All validated: node+web typecheck clean, 47 tests, build exit 0. Slices 1/3/4 touch main → need the pending app restart; slice 2 is live.

PARKED:
- Sidecar brain (cornerstone L2) — persistent daemon; blocked on external drive. It is the keystone: it unblocks CONTINUOUS senses (always-on screen/clipboard/fs watching), proactive digests, and background board polling.

DEFERRED BELOW THE OPS SPINE (open items):
- Wake word + VAD (Phase 1) — STT done, these two still ◻︎
- Neural TTS / ElevenLabs (Phase 2) — swap Web Speech for streaming neural voice through existing amplitude envelope
- CONTINUOUS senses / always-on watching (Phase 4 remainder) — needs the sidecar
- Local model routing (Phase 8)

Decisions: local-first throughout; cloud only as optional backup/sync. Agents propose (PRs), human approves.

CORRECTION NOTE (2026-06-25): a prior version of this fact listed "Senses / screen awareness (Phase 4)" as wholly deferred/unbuilt, which caused me to undersell on-demand vision. Phase 4 on-demand capture IS shipped; only the continuous/always-on variants remain (sidecar-blocked).
