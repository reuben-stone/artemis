import Anthropic from '@anthropic-ai/sdk'
import type { ModelClient, ModelStream, ModelFinal, ModelTurnRequest, ModelUsage } from './types'

/**
 * List prices in USD per million tokens (5-minute cache TTL: reads ~0.1× input,
 * writes ~1.25× input). Matched loosely by family so model-string suffixes don't
 * break it; unknown models fall back to Sonnet (the default backend model).
 * Source: claude-api skill pricing table (verify if rates change).
 */
const PRICING_PER_MTOK: Record<'opus' | 'sonnet' | 'haiku', {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}> = {
  opus: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  sonnet: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  haiku: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }
}

function estimateCost(model: string, u: ModelUsage): number {
  const m = model.toLowerCase()
  const rate = m.includes('opus')
    ? PRICING_PER_MTOK.opus
    : m.includes('haiku')
      ? PRICING_PER_MTOK.haiku
      : PRICING_PER_MTOK.sonnet
  return (
    (u.inputTokens * rate.input +
      u.outputTokens * rate.output +
      u.cacheReadTokens * rate.cacheRead +
      u.cacheWriteTokens * rate.cacheWrite) /
    1_000_000
  )
}

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
    const model = this.model
    const s = this.client.messages.stream(
      {
        model,
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
      },
      // Aborting this signal stops the HTTP stream; the token iterator + finalMessage()
      // then reject, which the agent loop catches as a cancellation.
      { signal: req.signal }
    )

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
        const u = msg.usage
        const usage: ModelUsage = {
          inputTokens: u?.input_tokens ?? 0,
          outputTokens: u?.output_tokens ?? 0,
          cacheReadTokens: u?.cache_read_input_tokens ?? 0,
          cacheWriteTokens: u?.cache_creation_input_tokens ?? 0
        }
        return {
          content: msg.content as unknown as Anthropic.ContentBlockParam[],
          stopReason: msg.stop_reason ?? 'end_turn',
          usage,
          cost: estimateCost(model, usage)
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
