import { useEffect, useRef, useCallback, useState } from 'react'

/**
 * Drives an amplitude ref (0..1) so the orb pulses in sync with speech, and
 * manages voice selection.
 *
 * Backend: Web Speech API `SpeechSynthesis`. It doesn't expose an audio stream,
 * so we synthesize an envelope from `onboundary` (word) events — each word kicks
 * the amplitude up, then it decays. The result reads as speech-synced pulsing.
 *
 * Swap-in path: when you wire a streaming TTS that returns audio (e.g. ElevenLabs),
 * pipe that audio through a Web Audio AnalyserNode and write its RMS into the same
 * `amplitudeRef` — the orb code doesn't change.
 */
export function useVoice(
  amplitudeRef: React.MutableRefObject<number>,
  onSpeakingChange?: (speaking: boolean) => void
) {
  const targetRef = useRef(0)
  const rafRef = useRef<number | null>(null)
  const speakingRef = useRef(false)

  const [voices, setVoices] = useState<string[]>([])
  const [selectedVoice, setSelectedVoice] = useState<string>('')
  const selectedRef = useRef('')
  selectedRef.current = selectedVoice

  // Enumerate English voices and auto-pick the best default (Siri / premium female).
  useEffect(() => {
    const synth = window.speechSynthesis
    if (!synth) return
    const PREFERRED = [
      'siri', 'ava', 'samantha', 'allison', 'serena', 'zoe', 'susan',
      'karen', 'victoria', 'moira', 'tessa', 'fiona'
    ]
    const score = (v: SpeechSynthesisVoice): number => {
      const n = v.name.toLowerCase()
      if (!v.lang.toLowerCase().startsWith('en')) return -1
      let s = 0
      const idx = PREFERRED.findIndex((p) => n.includes(p))
      if (idx >= 0) s += 100 - idx * 5
      if (/siri/.test(n)) s += 60
      if (/premium|enhanced/.test(n)) s += 40
      if (/female|woman/.test(n)) s += 10
      return s
    }
    const refresh = () => {
      const all = synth.getVoices().filter((v) => v.lang.toLowerCase().startsWith('en'))
      if (!all.length) return
      setVoices(all.map((v) => v.name))
      // set a default only once
      setSelectedVoice((cur) => {
        if (cur) return cur
        const best = all
          .map((v) => ({ v, s: score(v) }))
          .sort((a, b) => b.s - a.s)[0]
        return best?.v.name ?? all[0].name
      })
    }
    refresh()
    synth.addEventListener('voiceschanged', refresh)
    return () => synth.removeEventListener('voiceschanged', refresh)
  }, [])

  // Envelope loop: ease the live amplitude toward a decaying target.
  useEffect(() => {
    let last = performance.now()
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      if (speakingRef.current) {
        targetRef.current *= Math.exp(-dt * 6)
        const wobble = 0.06 * Math.sin(now * 0.02)
        amplitudeRef.current = Math.max(0, targetRef.current + wobble * targetRef.current)
      } else {
        amplitudeRef.current += (0 - amplitudeRef.current) * Math.min(1, dt * 8)
      }
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [amplitudeRef])

  const setSpeaking = useCallback(
    (v: boolean) => {
      speakingRef.current = v
      onSpeakingChange?.(v)
    },
    [onSpeakingChange]
  )

  const cancel = useCallback(() => {
    window.speechSynthesis?.cancel()
    targetRef.current = 0
    setSpeaking(false)
  }, [setSpeaking])

  const speak = useCallback(
    (text: string, opts?: { voice?: string; rate?: number; pitch?: number }) => {
      const synth = window.speechSynthesis
      if (!synth || !text.trim()) return
      synth.cancel()
      const utter = new SpeechSynthesisUtterance(text)
      utter.rate = opts?.rate ?? 0.98
      utter.pitch = opts?.pitch ?? 1.05
      const wanted = opts?.voice ?? selectedRef.current
      const chosen = wanted ? synth.getVoices().find((x) => x.name === wanted) : null
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
    [setSpeaking]
  )

  const setVoice = useCallback((name: string) => setSelectedVoice(name), [])

  // preview the chosen voice when switching
  const previewVoice = useCallback(
    (name: string) => speak(`Hi, I'm ${name.replace(/\(.*\)/, '').trim()}.`, { voice: name }),
    [speak]
  )

  return { speak, cancel, voices, selectedVoice, setVoice, previewVoice }
}
