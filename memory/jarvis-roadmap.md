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
- Architecture milestone (raw SDK agent loop, ModelClient abstraction with Anthropic + Ollama backends, prompt caching)
- Graceful restart (SQLite backbone, level 1 cornerstone)
- Minimal eval harness — `npm test` (vitest): 15 smoke cases covering read/edit/glob/grep/execute, speak-split, danger gate, memory recall, conversation assembly, Ollama translation
- Multi-project foundation (Phase M walking skeleton + full): project registry, switcher, per-project cwd, ecosystem_status tool, dispatch_worker tool, PR Review Queue (SQLite-backed)
- Connections & onboarding UI + GA connector (built 2026-06-24): ⚙ panel for Anthropic key, GitHub live-status, Google Analytics service-account JSON (safeStorage); GA4 last-7-days injected into ecosystem_status / morning reviews
- Toolbar redesign: lucide-react icons, lean bar, tabbed Settings modal, drag + brand spacing

CURRENT FOCUS (as of 2026-06-25): agentic tooling + HUD UI / Artemis capabilities.
Sidecar brain is ON HOLD until Reuben has a new external drive for it to live on.

DONE while sidecar parked:
- HUD left rail + day planner (built 2026-06-25): collapsible Artemis-managed rail in the orb pane. A lightweight TICKET system (status todo/doing/done, priority, project link, tags, day) + local calendar, both local-first SQLite (todos/events tables), CRUD'd by Artemis via tools AND by the user in the rail (one source of truth, refetch each turn). Tools: tasks_view/task_add/task_update/task_remove/task_carry_over, calendar_view/event_add/event_update/event_remove, plan_my_day. Carry-over rolls unfinished tickets forward day to day. Both tables carry source+external_id so future import (Lumi scanner / GitHub issues) + Google Calendar sync need no schema change (all source='local' today). 5 store tests added. Calendar chosen LOCAL (not Google OAuth) for now.

NEXT ITEMS while sidecar is parked:
- Migrate ops cards (PR queue, briefing, ecosystem status) into the rail (currently docked over orb)
- Agent-driven UI (panel actions) — let Artemis open/focus a specific rail card on command
- Ticket-import + Google Calendar connectors (in/after Phase 5 reach)
- Agentic tooling — keep expanding/sharpening Artemis's own tools (ops, senses, worker dispatch)
- Reach (Phase 5) — fuller GA4 (top pages, trends) + GitHub connectors; clone-from-GitHub in Connections panel
- Worker agents + proactive digests (Phase 6) — fix-it sub-agents across repos; morning briefings

PARKED:
- Sidecar brain (cornerstone L2) — persistent daemon; blocked on external drive (host disk for the daemon)

DEFERRED BELOW THE OPS SPINE:
- Wake word + VAD (Phase 1)
- Neural TTS / ElevenLabs (Phase 2)
- Senses / screen awareness (Phase 4)
- Local model routing (Phase 8)

Decisions: local-first throughout; cloud only as optional backup/sync. Agents propose (PRs), human approves.
