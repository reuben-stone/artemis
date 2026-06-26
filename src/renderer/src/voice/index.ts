import type { VoiceBackendId, VoiceClient, VoiceEnv } from './types'
import { createSystemVoice } from './system'
import { createKokoroVoice } from './kokoro'
import { createElevenLabsVoice } from './elevenlabs'

export type { VoiceBackendId, VoiceClient, VoiceEnv, SpeakOpts } from './types'

/** Which backends are actually wired (others show as "Planned" in Settings and fall back to system). */
export const VOICE_BACKENDS: Array<{ id: VoiceBackendId; label: string; live: boolean }> = [
  { id: 'system', label: 'System', live: true },
  { id: 'kokoro', label: 'Kokoro (local)', live: false },
  { id: 'elevenlabs', label: 'ElevenLabs', live: false }
]

export function createVoiceClient(id: VoiceBackendId, env: VoiceEnv): VoiceClient {
  switch (id) {
    case 'kokoro':
      return createKokoroVoice(env)
    case 'elevenlabs':
      return createElevenLabsVoice(env)
    default:
      return createSystemVoice(env)
  }
}
