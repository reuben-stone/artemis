import type Anthropic from '@anthropic-ai/sdk'

/**
 * The model-backend seam.
 *
 * Artemis's agent loop (agent.ts) is written entirely in terms of Anthropic's
 * message/tool shapes — that stays the *canonical* in-loop format. A ModelClient
 * is responsible for translating that canonical format to and from whatever its
 * backend speaks, so the loop never changes when we swap brains:
 *
 *   - AnthropicClient — near-passthrough to the metered Claude API (+ prompt caching)
 *   - OllamaClient    — a local (or home-box) model over HTTP, $0 marginal
 *   - ClaudeCliClient — delegate to the `claude -p` CLI to ride the flat subscription
 *
 * See ROADMAP-TO-JARVIS.md → "own the agent loop" / Phase 8.
 */

export type BackendId = 'anthropic' | 'ollama' | 'claude-cli'

export interface ModelTurnRequest {
  /** System prompt as a plain string — each client applies its own caching, if any. */
  system: string
  /** Canonical conversation, Anthropic shape, with NO cache_control (clients add it). */
  messages: Anthropic.MessageParam[]
  /** Tool definitions, Anthropic shape. Clients translate to their own schema. */
  tools: Anthropic.Tool[]
}

/** Token counts for one model call. Local backends report all zeros. */
export interface ModelUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export interface ModelFinal {
  /**
   * The assistant's full reply as Anthropic content blocks (text + tool_use), so
   * the agent loop can push it straight into history and execute any tool_use
   * blocks with the existing code path — regardless of which backend produced it.
   */
  content: Anthropic.ContentBlockParam[]
  /** 'tool_use' means the loop should run the tools and continue; else it's done. */
  stopReason: string
  /** Token usage for this call, when the backend reports it. */
  usage?: ModelUsage
  /**
   * Estimated USD cost of this single model call at list prices. Each client owns
   * its own pricing (it knows its model) — $0 for local backends. The agent sums
   * these across a turn's model calls for the running session cost meter.
   */
  cost?: number
}

export interface ModelStream {
  /** Text token deltas as they arrive, streamed to the renderer in real time. */
  tokens: AsyncIterable<string>
  /** Resolves once the stream is fully consumed — the assembled assistant message. */
  final: () => Promise<ModelFinal>
}

export interface ModelClient {
  readonly id: BackendId
  /** Run one model turn. Synchronous: returns a live stream + a final() promise. */
  stream(req: ModelTurnRequest): ModelStream
}
