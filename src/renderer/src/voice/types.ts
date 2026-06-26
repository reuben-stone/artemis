import type { MutableRefObject } from 'react'

/**
 * The TTS backend seam — mirrors the ModelClient seam (src/main/model). One interface,
 * swappable implementations, chosen from a setting:
 *   · system     — Web Speech API (on-device, free; includes macOS Siri/Premium/Enhanced voices)
 *   · kokoro      — local neural TTS (Kokoro-82M) — free + private; STUB until wired
 *   · elevenlabs  — cloud neural TTS — max quality, metered; STUB until wired
 *
 * A backend fully owns synthesis AND driving the orb amplitude (`env.amplitudeRef`): the
 * system backend fakes an envelope from word-boundary events; audio backends (kokoro/eleven)
 * will play real audio through a Web Audio AnalyserNode and write its RMS straight in — which
 * makes the orb sync *better*, not just the voice.
 */
export type VoiceBackendId = 'system' | 'kokoro' | 'elevenlabs'

export interface SpeakOpts {
  voice?: string
  rate?: number
  pitch?: number
}

/** What a backend drives: the orb amplitude (0..1) and a speaking on/off signal. */
export interface VoiceEnv {
  amplitudeRef: MutableRefObject<number>
  setSpeaking: (v: boolean) => void
}

export interface VoiceClient {
  readonly id: VoiceBackendId
  speak(text: string, opts?: SpeakOpts): void
  cancel(): void
  /** Voice names for the Settings picker (system enumerates installed OS voices; stubs: []). */
  getVoices(): string[]
  /** The best default voice name for this backend (system: a premium/Siri pick; stubs: ''). */
  bestVoiceName(): string
  /** Subscribe to voice-list changes (Web Speech loads voices async). Returns an unsubscribe. */
  onVoicesChanged(cb: () => void): () => void
  /** Stop loops / free resources when the backend is swapped out. */
  dispose(): void
}
