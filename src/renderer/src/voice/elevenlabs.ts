import type { VoiceClient, VoiceEnv } from './types'

/**
 * ElevenLabs — cloud neural TTS. The realism/expressiveness gold standard (voice cloning,
 * streaming), but metered per-character — the optional "max quality" tier. ⚠️ STUB for now.
 *
 * Real implementation sketch (when we build it):
 *   1. API key stored encrypted (safeStorage) via the Connections panel, like the Anthropic key.
 *   2. speak(text): POST to the streaming TTS endpoint; receive audio chunks (mp3/pcm).
 *   3. Play + analyse via Web Audio (AudioContext → AnalyserNode → destination); write the RMS
 *      into env.amplitudeRef each frame for real orb sync. Start audio on the first chunk for low
 *      latency rather than waiting for the whole clip.
 *   4. cancel(): abort the fetch + stop playback; setSpeaking(false).
 *   5. getVoices(): list the account's voices for the Settings picker.
 *
 * (OpenAI TTS / Cartesia would be sibling backends with the same shape — cheaper / lower-latency.)
 */
export function createElevenLabsVoice(_env: VoiceEnv): VoiceClient {
  const notWired = (): void => {
    throw new Error('ElevenLabs (cloud neural TTS) is not wired yet — using the system voice. See src/renderer/src/voice/elevenlabs.ts.')
  }
  return {
    id: 'elevenlabs',
    speak: notWired,
    cancel: () => {},
    getVoices: () => [],
    bestVoiceName: () => '',
    onVoicesChanged: () => () => {},
    dispose: () => {}
  }
}
