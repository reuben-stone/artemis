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

CURRENT SPRINT — NEXT ITEMS (in order):
1. Sidecar brain (cornerstone L2) — persistent daemon, Electron becomes reconnectable face; ends session-killing on main edits and unblocks proactivity + safe self-mod. Now load-bearing: background workers + live monitoring must outlive the Electron window.
2. Reach (Phase 5) — fuller GA4 (top pages, trends) + GitHub connectors; clone-from-GitHub in Connections panel
3. Worker agents + proactive digests (Phase 6) — fix-it sub-agents across repos; morning briefings

DEFERRED BELOW THE OPS SPINE:
- Wake word + VAD (Phase 1)
- Neural TTS / ElevenLabs (Phase 2)
- Senses / screen awareness (Phase 4)
- Local model routing (Phase 8)

Decisions: local-first throughout; cloud only as optional backup/sync. Agents propose (PRs), human approves.
