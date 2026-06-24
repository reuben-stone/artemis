# A.R.T.E.M.I.S.

> **A**utonomous **R**epository-**T**ending **E**ngineering, **M**onitoring & **I**ntelligence **S**ystem

A desktop **AI operations layer for your codebase ecosystem.** Artemis oversees several
repositories at once, gives you cross-repo briefings (git status *and* live analytics),
and dispatches autonomous worker agents that fix issues and open **gated pull requests**
for your review — all from a voice-capable desktop app whose memory and conversation
**survive restarts**.

It's built on Claude, runs on your machine, and is designed to be pointed at *any*
ecosystem of repos — not a single project.

---

## What it does

- **Multi-project oversight** — register the repos you work across; switch the active one;
  Artemis operates in its directory. Generic by design (point it at any repo set).
- **Morning review** — one command summarises *every* repo at once: branch, uncommitted
  files, recent activity, ahead/behind — plus **live Google Analytics** (last-7-day users /
  sessions / views) for each project you've connected.
- **Worker agents → gated PRs** — hand Artemis a fix-it task and a worker runs in an
  isolated **git worktree**, makes the change on a new branch, runs the repo's checks, and
  **opens a PR — it never pushes to main.** Every PR lands in a **PR Review Queue** you
  check off (built to handle several agents running overnight).
- **Swappable brains** — a `ModelClient` seam routes turns to the Claude API, a **local
  model** via Ollama (your laptop or a dedicated brain box), or the Claude subscription CLI.
- **Persistent & restart-survivable** — SQLite-backed transcript, in-flight-turn recovery,
  and terminal scrollback; close and reopen and you're exactly where you left off.
- **Voice & presence** — local Whisper speech-to-text, text-to-speech, and a reactive 3D orb.
- **Memory** — a git-tracked markdown fact store injected each turn, plus an accurate
  self-model so Artemis describes itself and its tools correctly.
- **Connections panel** — one screen to set up the Anthropic key, GitHub, and Google
  Analytics, so moving to a new machine is point-and-click.

## Safety posture

- Worker agents **only ever open PRs — never push to a protected branch.** You approve the
  dispatch (a permission prompt) and later the PR.
- Tool writes and shell commands run behind a **permission gate**; destructive commands are
  blocked outright.
- Single source of truth, local-first: your data lives in a SQLite file and git-tracked
  markdown — no cloud runtime dependency.

## Architecture

Three-process Electron app:

```
Main process (the brain, Node)        Preload (typed IPC bridge)     Renderer (React + Three.js, the face)
 • agent loop — raw @anthropic-ai/sdk    • window.artemis API           • 3D orb (R3F + GLSL, voice-reactive)
   + own tool loop + prompt caching                                     • chat, settings, projects, PR queue
 • tools: Read/Write/Edit/Glob/Grep/Bash/WebFetch/memory                • embedded terminal (xterm + node-pty)
 • ModelClient seam (Anthropic | Ollama | claude-cli)                   • Whisper STT (transformers.js worker)
 • SQLite store (better-sqlite3) · GA connector · worker-PR producer
```

## Getting started

Requirements: macOS, Node 20+, and either a Claude Code login *or* an Anthropic API key.
Optional: `gh` (GitHub CLI, for worker PRs), Ollama (local models), a GA4 service account.

```bash
npm install        # builds native deps for Electron (postinstall)
npm run dev        # run in development
npm run build      # build all targets
npm test           # vitest smoke suite (read/edit/gate/memory/seam/…)
```

**Auth** is subscription-first: if you're logged into Claude Code (`claude` in a terminal
once), Artemis inherits it. Otherwise add an Anthropic API key in **Settings → Connections**.
Connect **GitHub** with `gh auth login`, and **Google Analytics** by adding a GA4
service-account JSON + per-project property id in the same panel.

## Roadmap

Direction and phases live in **[ROADMAP-TO-JARVIS.md](./ROADMAP-TO-JARVIS.md)** — the goal
is to grow Artemis from an operator into a proactive, always-present assistant for a whole
product ecosystem.

## Status & licence

Early but genuinely functional — built and dogfooded on a real multi-repo product ecosystem.
It may become a packaged platform others can use on their own projects (open-source and/or
commercial — to be decided). **Licence: TBD.**
