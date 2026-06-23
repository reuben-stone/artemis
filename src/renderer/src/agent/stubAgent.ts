import type { OrbState } from '../components/Orb'
import { NAME } from './identity'

export interface AgentEvent {
  state?: OrbState
  /** a chunk of assistant text to append to the transcript */
  token?: string
  /** the full assistant message, emitted once at the end (for TTS) */
  done?: string
}

/**
 * Placeholder operator. Mimics the lifecycle the real Claude Agent SDK loop will
 * drive: think → (maybe) execute a tool → speak. Replace `run()` with an SDK
 * `query()` stream; map SDK message types onto these same AgentEvents and the
 * UI + orb + voice keep working unchanged.
 */
export async function* run(prompt: string): AsyncGenerator<AgentEvent> {
  yield { state: 'thinking' }
  await sleep(500)

  const wantsCommand = /\b(run|ls|build|test|install|git|status)\b/i.test(prompt)
  if (wantsCommand) {
    yield { state: 'executing' }
    await sleep(700)
  }

  const reply = compose(prompt, wantsCommand)
  yield { state: 'speaking' }

  // stream the reply token-by-token
  const words = reply.split(' ')
  for (let i = 0; i < words.length; i++) {
    yield { token: (i ? ' ' : '') + words[i] }
    await sleep(35)
  }

  yield { done: reply, state: 'idle' }
}

function compose(prompt: string, ranCommand: boolean): string {
  // identity question → introduce self by name
  if (/\b(who are you|your name|what are you)\b/i.test(prompt)) {
    return `I'm ${NAME} — your operator. I run inside this desktop shell with a voice, a shared terminal, and a memory, and this repository is my own source code, so I can even build on myself. Right now I'm a stub; once my Agent SDK mind is wired in I'll reason over your projects for real.`
  }
  const lead = ranCommand
    ? 'Done — I would have executed that in the terminal pane.'
    : 'Got it.'
  return `${lead} This is ${NAME} running as a stub operator. Once the Claude Agent SDK is wired in, I'll actually reason over your projects, run tools, and remember context between sessions. You said: "${prompt.trim()}".`
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
