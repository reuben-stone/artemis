import Anthropic from '@anthropic-ai/sdk'
import { getApiKey } from '../secrets'
import { getBackend, getModel, getOllamaHost, getOllamaModel } from '../store'
import type { ModelClient } from './types'
import { AnthropicClient } from './anthropic'
import { OllamaClient } from './ollama'
import { ClaudeCliClient } from './claude-cli'

export type { ModelClient, ModelTurnRequest, ModelFinal, ModelStream, BackendId } from './types'

// The Anthropic SDK instance is the expensive part to construct; cache it and
// rebuild only if the key changes. The thin per-turn client wrapper is cheap.
let _anthropic: Anthropic | null = null
let _anthropicKey: string | null = null

/**
 * Build the model client for this turn, reading the backend preference fresh from
 * SQLite each time (so flipping backend/model/host takes effect on the next turn,
 * no restart). The agent loop never knows or cares which backend it got.
 */
export async function getModelClient(opts?: { model?: string }): Promise<ModelClient> {
  const backend = getBackend()

  if (backend === 'ollama') {
    return new OllamaClient(getOllamaHost(), getOllamaModel())
  }
  if (backend === 'claude-cli') {
    return new ClaudeCliClient()
  }

  // default: metered Anthropic API. `opts.model` lets a caller (e.g. a worker sub-agent)
  // run on a cheaper model than the chat loop without changing the global preference.
  const key = await getApiKey()
  if (!key) {
    throw new Error(
      'No API key found. Set ANTHROPIC_API_KEY in your environment or add one in Artemis settings.'
    )
  }
  if (!_anthropic || _anthropicKey !== key) {
    _anthropic = new Anthropic({ apiKey: key })
    _anthropicKey = key
  }
  return new AnthropicClient(_anthropic, opts?.model ?? getModel())
}
