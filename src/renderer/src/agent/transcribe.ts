/**
 * Speech-to-text seam (Phase 1 — "ears").
 *
 * The capture layer (hooks/useSpeech.ts) produces mono 16kHz Float32 samples and
 * hands them here. We transcribe with local Whisper (transformers.js) running in a
 * Web Worker — private, offline after the first model download, no API key. The engine
 * stays swappable: a cloud STT could replace the worker behind this same signature.
 *
 * Every failure path returns null so the caller falls back to typing — transcription
 * can never crash the app.
 */
let worker: Worker | null = null
let seq = 0
const pending = new Map<number, { resolve: (t: string) => void; reject: (e: Error) => void }>()

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./whisper.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent<{ id: number; text?: string; error?: string }>) => {
      const { id, text, error } = e.data
      const p = pending.get(id)
      if (!p) return
      pending.delete(id)
      if (error) p.reject(new Error(error))
      else p.resolve(text ?? '')
    }
    worker.onerror = (e) => {
      for (const [, p] of pending) p.reject(new Error(e.message || 'transcription worker error'))
      pending.clear()
    }
  }
  return worker
}

export interface TranscriptionResult {
  text: string | null
  error?: string
}

export async function transcribe(
  samples: Float32Array,
  _sampleRate: number
): Promise<TranscriptionResult> {
  try {
    const w = getWorker()
    const id = ++seq
    const text = await new Promise<string>((resolve, reject) => {
      pending.set(id, { resolve, reject })
      // transfer the sample buffer to avoid a copy (we don't reuse it)
      w.postMessage({ id, samples }, [samples.buffer])
    })
    return { text: text.trim() || null }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[artemis] transcription failed:', err)
    return { text: null, error: message }
  }
}

/**
 * Kick off model load WITHOUT transcribing, so the first real transcription doesn't pay
 * the download/build cost. Fire-and-forget — safe to call repeatedly (the worker caches
 * the pipeline). Triggered when the user enables the mic.
 */
export function warmTranscriber(): void {
  try {
    const w = getWorker()
    w.postMessage({ id: ++seq, warm: true })
  } catch {
    // worker unavailable — the next transcribe() will load lazily as before
  }
}

export const transcriberReady = true
