---
name: parked-ui-fixes
description: Two parked renderer-only UI fixes, on hold until senses work completes
metadata:
  type: project
---

Two small, renderer-only UI fixes are parked, deliberately ON HOLD until the "senses" work (vision/attachments, happening in a separate shell editing src/main + src/preload) is complete — to avoid restart collisions.

1. Streaming render polish — mid-stream, new sentences/points can butt together without a space because separate lines only settle on completion. Fix: when adding points on the fly, drop to a new line/paragraph so partial render breaks cleanly too. Lives in the chat MessageContent renderer (src/renderer). Reuben says it's minor (final render is correct), behavioural habit-change may suffice over a code fix.

2. Ecosystem-status card truncation — the "Last commit … : <message>" line is clipped at the card's right edge instead of wrapping. Renderer-only fix (word-wrap/overflow on the status-card text).

Do NOT touch src/main or src/preload while senses work is live.
