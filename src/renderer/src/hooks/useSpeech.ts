import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Microphone capture for voice input (Phase 1 — "ears").
 *
 * Engine-agnostic on purpose: this hook only *captures*. It drives `amplitudeRef`
 * from the live mic level (so the orb pulses to YOUR voice while listening), records
 * the utterance, and hands back mono 16kHz Float32 samples — exactly the shape a
 * Whisper engine wants. Transcription is a separate, swappable step (see
 * agent/transcribe.ts), so we can move from local Whisper to anything else without
 * touching capture.
 */
export interface SpeechCapture {
  supported: boolean
  listening: boolean
  error: string | null
  start: () => Promise<void>
  stop: () => void
}

export function useSpeech(
  amplitudeRef: React.MutableRefObject<number>,
  onAudio: (samples: Float32Array, sampleRate: number) => void
): SpeechCapture {
  const [listening, setListening] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const streamRef = useRef<MediaStream | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const ctxRef = useRef<AudioContext | null>(null)
  const rafRef = useRef<number | null>(null)
  const onAudioRef = useRef(onAudio)
  onAudioRef.current = onAudio

  const supported =
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== 'undefined'

  const cleanup = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    rafRef.current = null
    ctxRef.current?.close().catch(() => {})
    ctxRef.current = null
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    amplitudeRef.current = 0
  }, [amplitudeRef])

  const start = useCallback(async () => {
    if (!supported || listening) return
    setError(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream

      // Analyser → drive the orb amplitude from the live mic RMS level.
      const ctx = new AudioContext()
      ctxRef.current = ctx
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 512
      ctx.createMediaStreamSource(stream).connect(analyser)
      const data = new Uint8Array(analyser.frequencyBinCount)
      const tick = () => {
        analyser.getByteTimeDomainData(data)
        let sum = 0
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128
          sum += v * v
        }
        amplitudeRef.current = Math.min(1, Math.sqrt(sum / data.length) * 3)
        rafRef.current = requestAnimationFrame(tick)
      }
      rafRef.current = requestAnimationFrame(tick)

      // Record the utterance for transcription.
      chunksRef.current = []
      const rec = new MediaRecorder(stream)
      recorderRef.current = rec
      rec.ondataavailable = (e) => {
        if (e.data.size) chunksRef.current.push(e.data)
      }
      rec.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' })
        cleanup()
        setListening(false)
        if (blob.size > 0) {
          try {
            const { samples, sampleRate } = await decodeTo16k(blob)
            onAudioRef.current(samples, sampleRate)
          } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not decode audio')
          }
        }
      }
      rec.start()
      setListening(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Microphone unavailable')
      cleanup()
      setListening(false)
    }
  }, [supported, listening, cleanup])

  const stop = useCallback(() => {
    const rec = recorderRef.current
    if (rec && rec.state !== 'inactive') rec.stop()
    else {
      cleanup()
      setListening(false)
    }
  }, [cleanup])

  useEffect(
    () => () => {
      cleanup()
      recorderRef.current = null
    },
    [cleanup]
  )

  return { supported, listening, error, start, stop }
}

/** Decode an audio blob to mono 16kHz Float32 — the format Whisper expects. */
async function decodeTo16k(blob: Blob): Promise<{ samples: Float32Array; sampleRate: number }> {
  const arrayBuf = await blob.arrayBuffer()
  const tmp = new AudioContext()
  const decoded = await tmp.decodeAudioData(arrayBuf)
  tmp.close().catch(() => {})
  const rate = 16000
  const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * rate)), rate)
  const src = offline.createBufferSource()
  src.buffer = decoded
  src.connect(offline.destination)
  src.start()
  const rendered = await offline.startRendering()
  return { samples: rendered.getChannelData(0), sampleRate: rate }
}
