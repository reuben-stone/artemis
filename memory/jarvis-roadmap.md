---
name: jarvis-roadmap
description: Roadmap-to-Jarvis status and next steps
metadata:
  type: project
---

Artemis is being built toward a Jarvis-class voice operator per ROADMAP-TO-JARVIS.md (repo root). 

FULLY DONE: Phase 0 (memory, tools, cost meter), Phase 1 STT (whisper-tiny.en fp32 WASM, verified live 2026-06-24), Architecture milestone (raw SDK agent loop, ModelClient abstraction with Anthropic + Ollama backends, prompt caching), graceful restart (SQLite backbone).

NEXT IN SPRINT:
1. Minimal eval harness (~10 smoke cases, pulled forward from Phase 9)
2. Sidecar brain (cornerstone L2) — persistent daemon, Electron becomes reconnectable face; ends session-killing on main edits and unblocks proactivity + safe self-mod
3. Phase 1 completion — wake word + VAD
4. Phase 2 — neural TTS (ElevenLabs or similar streaming)

Reuben is currently working in a separate shell on architectural features (likely sidecar brain or eval harness). Decisions: local-first throughout; cloud only as optional backup/sync.
