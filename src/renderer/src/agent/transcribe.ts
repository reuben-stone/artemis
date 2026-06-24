/**
 * Speech-to-text seam (Phase 1 — "ears").
 *
 * The capture layer (hooks/useSpeech.ts) produces mono 16kHz Float32 samples and
 * hands them here. The engine is deliberately swappable: the planned default is local
 * Whisper via transformers.js running in a Web Worker (local-first — private, offline,
 * no API key), but a cloud streaming STT could slot in behind the same signature.
 *
 * Until the engine is wired, this returns null so the UI can fall back to typing.
 * NEXT STEP: implement the Whisper worker and return its transcript here.
 */
export async function transcribe(
  _samples: Float32Array,
  _sampleRate: number
): Promise<string | null> {
  return null
}

/** Whether a transcription engine is available yet (false until Whisper is wired). */
export const transcriberReady = false
