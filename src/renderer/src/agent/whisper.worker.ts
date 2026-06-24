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

// On WASM the default dtype is q8, and this model's q8 decoder ships broken 4-bit
// (MatMulNBits) ops that onnxruntime-web can't build a session from — the session is
// created lazily at first inference, so a load-time fallback never sees the failure.
// Force genuinely unquantized fp32: no quantization, no MatMulNBits, fully supported.
const MODEL = 'Xenova/whisper-tiny.en'

let asr: Promise<AutomaticSpeechRecognitionPipeline> | null = null
const getAsr = (): Promise<AutomaticSpeechRecognitionPipeline> =>
  (asr ??= pipeline('automatic-speech-recognition', MODEL, {
    dtype: 'fp32'
  }) as Promise<AutomaticSpeechRecognitionPipeline>)

self.onmessage = async (e: MessageEvent<{ id: number; samples: Float32Array }>) => {
  const { id, samples } = e.data
  try {
    const pipe = await getAsr()
    const out = await pipe(samples)
    const text = (Array.isArray(out) ? out[0]?.text : out?.text) ?? ''
    self.postMessage({ id, text })
  } catch (err) {
    self.postMessage({ id, error: err instanceof Error ? err.message : String(err) })
  }
}
