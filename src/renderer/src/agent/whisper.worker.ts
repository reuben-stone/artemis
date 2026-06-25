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

const MODEL = 'Xenova/whisper-tiny.en'

// Prefer q8 (≈4× smaller + faster on WASM); fall back to fp32 if its decoder won't build.
// Historically this model's q8 decoder shipped broken 4-bit (MatMulNBits) ops that
// onnxruntime-web couldn't construct a session from — but newer runtimes may handle it,
// so we try it and validate with a tiny silent inference (the session is built lazily at
// first inference, so this surfaces a q8 failure HERE, not on the user's first words).
let asr: Promise<AutomaticSpeechRecognitionPipeline> | null = null

async function build(): Promise<AutomaticSpeechRecognitionPipeline> {
  for (const dtype of ['q8', 'fp32'] as const) {
    try {
      const pipe = (await pipeline('automatic-speech-recognition', MODEL, {
        dtype
      })) as AutomaticSpeechRecognitionPipeline
      await pipe(new Float32Array(16000)) // 1s of silence @16k — forces the session to build
      return pipe
    } catch {
      // try the next dtype (q8 unsupported on this runtime → fp32)
    }
  }
  throw new Error('no usable Whisper dtype (q8 and fp32 both failed to build)')
}

const getAsr = (): Promise<AutomaticSpeechRecognitionPipeline> => (asr ??= build())

self.onmessage = async (e: MessageEvent<{ id: number; samples?: Float32Array; warm?: boolean }>) => {
  const { id, samples, warm } = e.data
  try {
    const pipe = await getAsr()
    if (warm || !samples) {
      // A warm-up call: the model is now loaded so the first real transcription is fast.
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
