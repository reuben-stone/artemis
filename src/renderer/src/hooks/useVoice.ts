import { useEffect, useRef, useCallback, useState } from 'react'
import { createVoiceClient, type VoiceBackendId, type VoiceClient } from '../voice'

/**
 * Drives the orb amplitude ref (0..1) in sync with speech and manages voice selection, behind
 * the swappable VoiceClient seam (src/renderer/src/voice). The `system` backend (Web Speech —
 * incl. macOS Siri/Premium/Enhanced voices) is always created: it owns the amplitude loop + the
 * installed-voice list, and is the graceful fallback if a not-yet-wired backend (Kokoro /
 * ElevenLabs) is selected. The chosen backend, when not `system`, is layered on top.
 */
const BACKEND_KEY = 'artemis.voiceBackend'

export function useVoice(
  amplitudeRef: React.MutableRefObject<number>,
  onSpeakingChange?: (speaking: boolean) => void
) {
  const [voices, setVoices] = useState<string[]>([])
  const [selectedVoice, setSelectedVoice] = useState<string>('')
  const selectedRef = useRef('')
  selectedRef.current = selectedVoice
  const [voiceBackend, setVoiceBackendState] = useState<VoiceBackendId>(
    () => (localStorage.getItem(BACKEND_KEY) as VoiceBackendId) || 'system'
  )

  const onSpeakingRef = useRef(onSpeakingChange)
  onSpeakingRef.current = onSpeakingChange

  // The system backend: always present (amplitude envelope + OS voice list + fallback).
  const systemRef = useRef<VoiceClient | null>(null)
  // The chosen backend, when it isn't `system` (Kokoro / ElevenLabs).
  const primaryRef = useRef<VoiceClient | null>(null)

  useEffect(() => {
    const env = { amplitudeRef, setSpeaking: (v: boolean) => onSpeakingRef.current?.(v) }
    const system = createVoiceClient('system', env)
    systemRef.current = system
    // Populate + track the installed voices; seed a sensible default once.
    const refresh = (): void => {
      const list = system.getVoices()
      if (!list.length) return
      setVoices(list)
      setSelectedVoice((cur) => cur || system.bestVoiceName() || list[0])
    }
    refresh()
    const off = system.onVoicesChanged(refresh)
    return () => {
      off()
      system.dispose()
      systemRef.current = null
    }
  }, [amplitudeRef])

  // (Re)create the chosen backend when it changes; `system` needs no separate client.
  useEffect(() => {
    primaryRef.current?.dispose()
    primaryRef.current = null
    if (voiceBackend !== 'system') {
      const env = { amplitudeRef, setSpeaking: (v: boolean) => onSpeakingRef.current?.(v) }
      primaryRef.current = createVoiceClient(voiceBackend, env)
    }
    return () => {
      primaryRef.current?.dispose()
      primaryRef.current = null
    }
  }, [voiceBackend, amplitudeRef])

  const cancel = useCallback(() => {
    primaryRef.current?.cancel()
    systemRef.current?.cancel()
  }, [])

  const speak = useCallback((text: string, opts?: { voice?: string; rate?: number; pitch?: number }) => {
    if (!text.trim()) return
    const o = { voice: opts?.voice ?? selectedRef.current, rate: opts?.rate, pitch: opts?.pitch }
    const primary = primaryRef.current
    if (primary) {
      try {
        primary.speak(text, o)
        return
      } catch (e) {
        // Not-yet-wired backend (stub throws) — fall back to system so voice never silently breaks.
        console.warn('[voice] backend fell back to system:', e instanceof Error ? e.message : e)
      }
    }
    systemRef.current?.speak(text, o)
  }, [])

  const setVoice = useCallback((name: string) => setSelectedVoice(name), [])

  const setVoiceBackend = useCallback((id: VoiceBackendId) => {
    setVoiceBackendState(id)
    try {
      localStorage.setItem(BACKEND_KEY, id)
    } catch {
      /* private mode — non-fatal */
    }
  }, [])

  // preview the chosen voice when switching
  const previewVoice = useCallback(
    (name: string) => speak(`Hi, I'm ${name.replace(/\(.*\)/, '').trim()}.`, { voice: name }),
    [speak]
  )

  return { speak, cancel, voices, selectedVoice, setVoice, previewVoice, voiceBackend, setVoiceBackend }
}
