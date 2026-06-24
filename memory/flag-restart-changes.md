---
name: flag-restart-changes
description: Warn before main/preload edits that restart the app; proceed silently for UI
metadata:
  type: feedback
---

When changing Artemis's own source, flag up-front any edit to src/main/** or src/preload/** — they force a full Electron restart that can disrupt the live session. For renderer/UI changes under src/renderer/** (hot-reload, safe), just proceed without flagging. Why: Reuben wants a heads-up before a restart, but no friction for safe edits. Batch main-process edits so the restart is taken once.
