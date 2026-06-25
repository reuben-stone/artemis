/// <reference lib="webworker" />
/**
 * Local Whisper transcription worker (Phase 1 — ears).
 *
 * Runs transformers.js off the main thread so model load + inference never block the
 * UI. The model (whisper-tiny.en, ~40MB) downloads from the HF hub on first use and is
 * then cached by the browser, so it's local/offline thereafter. Single-threaded WASM is
 * forced so we don't need SharedArrayBuffer / cross-origin isolation.
 */
import { pipeline, env, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers'

env.allowLocalModels = false
// Single-threaded avoids needing COOP/COEP headers for SharedArrayBuffer.
if (env.backends?.onnx?.wasm) env.backends.onnx.wasm.numThreads = 1

// fp32: genuinely unquantized — no MatMulNBits, fully supported by onnxruntime-web. (q8
// was tried and FAILED to build on this runtime — 2026-06-25 — so we stay on fp32. A real
// speedup needs multi-threaded WASM / WebGPU, tracked in ROADMAP Phase 1.)
const MODEL = 'Xenova/whisper-tiny.en'

let asr: Promise<AutomaticSpeechRecognitionPipeline> | null = null
const getAsr = (): Promise<AutomaticSpeechRecognitionPipeline> =>
  (asr ??= pipeline('automatic-speech-recognition', MODEL, {
    dtype: 'fp32'
  }) as Promise<AutomaticSpeechRecognitionPipeline>)

self.onmessage = async (e: MessageEvent<{ id: number; samples?: Float32Array; warm?: boolean }>) => {
  const { id, samples, warm } = e.data
  try {
    // A warm-up call downloads + constructs the model (the bulk of first-use cost) so the
    // first real transcription is faster — without running a (fragile) dummy inference.
    const pipe = await getAsr()
    if (warm || !samples) {
      self.postMessage({ id, text: '' })
      return
    }
    const out = await pipe(samples)
    const text = (Array.isArray(out) ? out[0]?.text : out?.text) ?? ''
    self.postMessage({ id, text })
  } catch (err) {
    self.postMessage({ id, error: err instanceof Error ? err.message : String(err) })
  }
}
