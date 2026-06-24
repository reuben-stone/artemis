import Anthropic from '@anthropic-ai/sdk'
import type { ModelClient, ModelStream, ModelFinal, ModelTurnRequest } from './types'

/**
 * The metered Claude API backend (current default).
 *
 * Owns the prompt-caching concern so the canonical messages handed in by the loop
 * stay backend-neutral: we cache the system prompt and anchor the conversation
 * prefix on the last history assistant message (~90% cheaper on cache hits).
 */
export class AnthropicClient implements ModelClient {
  readonly id = 'anthropic' as const

  constructor(
    private readonly client: Anthropic,
    private readonly model: string
  ) {}

  stream(req: ModelTurnRequest): ModelStream {
    const s = this.client.messages.stream({
      model: this.model,
      max_tokens: 8096,
      system: [
        {
          type: 'text',
          text: req.system,
          cache_control: { type: 'ephemeral' }
        }
      ],
      messages: withCacheAnchor(req.messages),
      tools: req.tools
    })

    async function* tokens(): AsyncIterable<string> {
      for await (const event of s as AsyncIterable<Anthropic.MessageStreamEvent>) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          yield event.delta.text
        }
      }
    }

    return {
      tokens: tokens(),
      final: async (): Promise<ModelFinal> => {
        const msg = await s.finalMessage()
        return {
          content: msg.content as unknown as Anthropic.ContentBlockParam[],
          stopReason: msg.stop_reason ?? 'end_turn'
        }
      }
    }
  }
}

/**
 * Wrap the last *history* assistant message (string content) in a cached text block
 * so Anthropic caches the conversation prefix. Mirrors the original buildMessages
 * behaviour exactly: assistant messages generated mid-turn carry array content and
 * are intentionally skipped. Non-mutating — the loop reuses the messages array.
 */
function withCacheAnchor(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  const out = messages.slice()
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i]
    if (m.role === 'assistant' && typeof m.content === 'string') {
      out[i] = {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: m.content,
            cache_control: { type: 'ephemeral' }
          }
        ]
      }
      break
    }
  }
  return out
}
