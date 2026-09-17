# Changelog

All notable changes to **A.R.T.E.M.I.S.** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

> Changes staged for the next release will appear here.

---

## [0.1.0] — Initial Release

### Added

- **Multi-repo oversight** — register and switch between multiple repositories;
  Artemis operates in the active repo's directory and is generic by design.
- **Morning review** — single-command cross-repo summary covering branch status,
  uncommitted files, recent commits, ahead/behind counts, and live Google Analytics
  metrics (users, sessions, page-views for the last 7 days).
- **Worker-agent dispatch system** — autonomous agents run fix-it tasks inside
  isolated git worktrees on dedicated branches, execute the repo's test/lint checks,
  and open gated pull requests for human review; agents never push directly to `main`.
- **PR Review Queue** — a built-in queue that surfaces every worker-opened PR so
  changes can be inspected and approved before merging, designed to handle multiple
  overnight agents running in parallel.
- **Swappable model backends** — a `ModelClient` seam routes inference to the
  Anthropic Claude API, a local Ollama model, or the Claude subscription CLI with
  no code changes required.
- **Persistent, restart-survivable sessions** — SQLite-backed conversation
  transcript, in-flight turn recovery, and terminal scrollback so context is never
  lost across restarts.
- **Voice & presence** — local Whisper speech-to-text input, text-to-speech output,
  and a reactive 3-D orb visualisation powered by Three.js / React Three Fiber.
- **Git-tracked memory** — a markdown fact store injected into every turn, plus an
  accurate self-model so Artemis correctly describes itself and its available tools.
- **Connections panel** — point-and-click UI for configuring the Anthropic API key,
  GitHub credentials, and Google Analytics, making new-machine setup trivial.

[Unreleased]: https://github.com/your-org/artemis/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/your-org/artemis/releases/tag/v0.1.0
