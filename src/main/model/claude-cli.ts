import type { ModelClient, ModelStream, ModelTurnRequest } from './types'

/**
 * Subscription backend — delegate a turn to the Claude Code CLI (`claude -p`),
 * which authenticates via the local `~/.claude` OAuth login and therefore rides
 * the FLAT Pro/Max subscription instead of metered API billing.
 *
 * ⚠️ Deliberately a stub for now. Unlike the other backends, `claude -p` is not a
 * single model call that returns tool_use blocks for Artemis to execute — it runs
 * its OWN agentic loop with its OWN tools. Wiring it correctly is a separate design:
 * a "delegated turn" execution mode where Artemis streams the CLI's output and lets
 * it use its own tools, which BYPASSES Artemis's permission gate (PermissionDialog)
 * and its own tool implementations. That safety change shouldn't be slipped in
 * silently — hence this explicit stub.
 *
 * Sketch of the real implementation when we choose to build it:
 *   spawn('claude', ['-p', <prompt>, '--output-format', 'stream-json', '--verbose'])
 *   → parse each JSON line → map assistant text to tokens, end with stopReason 'end_turn'
 *   (no tool_use blocks surfaced to our loop; the CLI handled its own tools).
 */
export class ClaudeCliClient implements ModelClient {
  readonly id = 'claude-cli' as const

  stream(_req: ModelTurnRequest): ModelStream {
    throw new Error(
      'The claude-cli (subscription) backend is not wired yet — it needs a delegated-turn ' +
        'execution mode that bypasses the permission gate. Use the "anthropic" or "ollama" ' +
        'backend for now. See src/main/model/claude-cli.ts.'
    )
  }
}
