# Artemis

A Claude-based **operator** for all your projects — a desktop agent shell with a
3D voice-reactive orb, a real terminal, and persistent markdown memory.

## Status — slice 1 of the build: the visual shell

What works now:

- **Electron desktop app** (macOS hidden-titlebar, vibrancy).
- **3D pulsing orb** (React Three Fiber + custom GLSL) that changes color/behavior
  with operator **state** (`idle · thinking · executing · speaking · error`) and
  **pulses to speech amplitude**.
- **Voice (text-to-speech)** via the Web Speech API. Word-boundary events drive an
  amplitude envelope so the orb pulse matches the spoken words. Toggle with 🔊.
- **Real terminal** — a true PTY (`node-pty`) rendered with xterm.js, sharing your
  shell. The operator and you both use it.
- **Stub agent** — simulates the Claude Agent SDK lifecycle so the UI is fully
  wired before real intelligence lands.

## Run

```bash
npm install      # builds node-pty for your Electron version (postinstall)
npm run dev
```

## Architecture

```
Electron main  ──IPC──  Renderer (React)
  • node-pty PTY host      • Orb (R3F + GLSL, amplitude-reactive)
  • (next) Agent SDK       • xterm.js terminal
  • (next) memory store    • Chat + voice (TTS → amplitude)
```

## Roadmap (next slices)

1. **Real operator** — replace `src/renderer/src/agent/stubAgent.ts` with the
   Claude Agent SDK. Map SDK stream messages onto the existing `AgentEvent`s
   (`state` / `token` / `done`) — the orb, voice, and chat keep working unchanged.
2. **Memory** — file-based markdown context store under `memory/` (one fact per
   file + `MEMORY.md` index), loaded into the agent each session.
3. **Per-project connectors** — MCP servers per project; a project switcher.
4. **Higher-fidelity voice** — swap Web Speech for a streaming TTS (e.g.
   ElevenLabs); pipe its audio through a Web Audio `AnalyserNode` and write the RMS
   into the same `amplitudeRef` the orb already reads. No orb changes needed.

## Key files

| File | Role |
|---|---|
| `src/main/index.ts` | Electron main + PTY host |
| `src/renderer/src/components/Orb.tsx` | Audio/state-reactive 3D orb |
| `src/renderer/src/hooks/useVoice.ts` | TTS → amplitude envelope |
| `src/renderer/src/agent/stubAgent.ts` | Operator lifecycle (swap for Agent SDK) |
| `memory/` | Markdown context store |
