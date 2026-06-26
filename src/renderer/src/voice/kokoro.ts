import type { VoiceClient, VoiceEnv } from './types'

/**
 * Kokoro (Kokoro-82M) — local neural TTS. Free, private, and good enough to be the daily voice,
 * especially on the Apple-Silicon target machine. ⚠️ STUB for now.
 *
 * Real implementation sketch (when we build it):
 *   1. Run Kokoro locally — either in a Web Worker via transformers.js/ONNX (kokoro-js), or a
 *      tiny local HTTP server, behind a configurable host like the Ollama backend.
 *   2. speak(text): synthesise to PCM/WAV (chunk by sentence for low latency).
 *   3. Play via Web Audio: AudioContext → AudioBufferSourceNode → AnalyserNode → destination.
 *   4. Each animation frame, read the AnalyserNode RMS and write it into env.amplitudeRef — REAL
 *      amplitude, so the orb pulses to the actual audio (no faked envelope).
 *   5. cancel(): stop the source + close/suspend the context; setSpeaking(false).
 */
export function createKokoroVoice(_env: VoiceEnv): VoiceClient {
  const notWired = (): void => {
    throw new Error('Kokoro (local neural TTS) is not wired yet — using the system voice. See src/renderer/src/voice/kokoro.ts.')
  }
  return {
    id: 'kokoro',
    speak: notWired,
    cancel: () => {},
    getVoices: () => [],
    bestVoiceName: () => '',
    onVoicesChanged: () => () => {},
    dispose: () => {}
  }
}
