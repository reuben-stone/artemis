import type { SpeakOpts, VoiceClient, VoiceEnv } from './types'

/**
 * System backend — Web Speech API `SpeechSynthesis`. On-device, free, and on macOS it can use
 * the Siri / Premium / Enhanced system voices (the "real human voice" stopgap). It exposes no
 * audio stream, so the orb amplitude is faked: each word-boundary event kicks a target up, which
 * an envelope loop decays. This is the original useVoice logic, lifted behind the VoiceClient seam.
 */
const PREFERRED = ['siri', 'ava', 'samantha', 'allison', 'serena', 'zoe', 'susan', 'karen', 'victoria', 'moira', 'tessa', 'fiona']

function score(v: SpeechSynthesisVoice): number {
  const n = v.name.toLowerCase()
  if (!v.lang.toLowerCase().startsWith('en')) return -1
  let s = 0
  const idx = PREFERRED.findIndex((p) => n.includes(p))
  if (idx >= 0) s += 100 - idx * 5
  if (/siri/.test(n)) s += 60
  if (/premium|enhanced/.test(n)) s += 40 // favour the downloadable high-quality macOS voices
  if (/female|woman/.test(n)) s += 10
  return s
}

export function createSystemVoice(env: VoiceEnv): VoiceClient {
  const synth = window.speechSynthesis
  const targetRef = { current: 0 }
  const speakingRef = { current: false }
  let raf: number | null = null
  const listeners = new Set<() => void>()

  const setSpeaking = (v: boolean): void => {
    speakingRef.current = v
    env.setSpeaking(v)
  }

  // Envelope loop: ease the orb amplitude toward a decaying target while speaking; settle to 0 otherwise.
  let last = performance.now()
  const tick = (now: number): void => {
    const dt = Math.min(0.05, (now - last) / 1000)
    last = now
    if (speakingRef.current) {
      targetRef.current *= Math.exp(-dt * 6)
      const wobble = 0.06 * Math.sin(now * 0.02)
      env.amplitudeRef.current = Math.max(0, targetRef.current + wobble * targetRef.current)
    } else {
      env.amplitudeRef.current += (0 - env.amplitudeRef.current) * Math.min(1, dt * 8)
    }
    raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(tick)

  const onVoices = (): void => listeners.forEach((cb) => cb())
  synth?.addEventListener('voiceschanged', onVoices)

  const enVoices = (): SpeechSynthesisVoice[] => (synth?.getVoices() ?? []).filter((v) => v.lang.toLowerCase().startsWith('en'))

  return {
    id: 'system',
    speak(text: string, opts?: SpeakOpts): void {
      if (!synth || !text.trim()) return
      synth.cancel()
      const utter = new SpeechSynthesisUtterance(text)
      utter.rate = opts?.rate ?? 0.98
      utter.pitch = opts?.pitch ?? 1.05
      const chosen = opts?.voice ? synth.getVoices().find((x) => x.name === opts.voice) : null
      if (chosen) utter.voice = chosen
      utter.onstart = () => setSpeaking(true)
      utter.onend = () => {
        targetRef.current = 0
        setSpeaking(false)
      }
      utter.onerror = () => setSpeaking(false)
      utter.onboundary = (e) => {
        const word = text.slice(e.charIndex, e.charIndex + (e.charLength || 4))
        const len = Math.min(8, word.trim().length || 3)
        targetRef.current = Math.min(1, 0.45 + len * 0.07)
      }
      synth.speak(utter)
    },
    cancel(): void {
      synth?.cancel()
      targetRef.current = 0
      setSpeaking(false)
    },
    getVoices: () => enVoices().map((v) => v.name),
    bestVoiceName: () => {
      const all = enVoices()
      if (!all.length) return ''
      return all.map((v) => ({ v, s: score(v) })).sort((a, b) => b.s - a.s)[0]?.v.name ?? all[0].name
    },
    onVoicesChanged(cb: () => void): () => void {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    dispose(): void {
      if (raf) cancelAnimationFrame(raf)
      synth?.removeEventListener('voiceschanged', onVoices)
      synth?.cancel()
      listeners.clear()
    }
  }
}
