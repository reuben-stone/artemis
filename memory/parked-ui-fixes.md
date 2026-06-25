---
name: parked-ui-fixes
description: Two parked renderer-only UI fixes, on hold until senses work completes
metadata:
  type: project
---

RESOLVED 2026-06-25 (both addressed):

1. Streaming render polish — mid-stream, new sentences/points can momentarily butt together. Investigated: NOT a CSS/markdown-spacing gap (.md p/li margins are correct; remarkBreaks is on). It's a token-boundary artifact — the newline and the next sentence can arrive in either order within streamed chunks, so they render adjacent for a beat then settle when the newline token lands. A real fix needs buffering partial lines (adds latency/complexity) for a purely cosmetic, self-correcting glitch the owner already deemed minor. Decision: deliberately LEFT — not worth the streaming-regression risk. Revisit only with a concrete repro that bothers in practice.

2. Ecosystem-status card truncation — the original "Last commit … : <message>" line no longer exists: the briefing-card redesign replaced it with branch + commits/7d + KPIs. Hardened the current cards instead so long branches/PR-titles/paths wrap or ellipsis rather than clip (brief-pr, brief-dirty, brief-proj-meta → overflow-wrap; OpsRail hud-eco-branch → ellipsis). DONE.
