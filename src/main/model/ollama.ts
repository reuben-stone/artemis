import type Anthropic from '@anthropic-ai/sdk'
import type { ModelClient, ModelStream, ModelFinal, ModelTurnRequest } from './types'

/**
 * Local / home-box model backend over Ollama's HTTP API ($0 marginal, offline-capable).
 *
 * The whole point of the ModelClient seam lives here: the agent loop speaks Anthropic
 * shapes, Ollama speaks its own (OpenAI-ish) shape, so this class translates both ways:
 *   - incoming: Anthropic MessageParam[] + tools  →  Ollama /api/chat body
 *   - outgoing: Ollama streamed chunks            →  Anthropic content blocks
 *
 * `host` is configurable (store.getOllamaHost) so the same code points at
 * localhost on the laptop or http://<box-ip>:11434 on a dedicated brain box.
 */
export class OllamaClient implements ModelClient {
  readonly id = 'ollama' as const

  constructor(
    private readonly host: string,
    private readonly model: string
  ) {}

  stream(req: ModelTurnRequest): ModelStream {
    const body = {
      model: this.model,
      stream: true,
      messages: [
        { role: 'system', content: req.system },
        ...toOllamaMessages(req.messages)
      ],
      tools: req.tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description ?? '',
          parameters: t.input_schema
        }
      }))
    }

    // Accumulated across the stream, read by final() once tokens() is exhausted.
    let accText = ''
    const toolCalls: Array<{ name: string; input: Record<string, unknown> }> = []
    let doneReason = 'end_turn'

    const url = `${this.host.replace(/\/$/, '')}/api/chat`

    async function* tokens(): AsyncIterable<string> {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
      if (!res.ok || !res.body) {
        throw new Error(
          `Ollama request failed (${res.status}). Is Ollama running at ${url} and the model "${body.model}" pulled?`
        )
      }

      const decoder = new TextDecoder()
      let buffer = ''
      // undici's response body is async-iterable over Uint8Array chunks.
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true })
        let nl: number
        // Ollama streams newline-delimited JSON; emit per complete line.
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim()
          buffer = buffer.slice(nl + 1)
          if (!line) continue

          let evt: OllamaChunk
          try {
            evt = JSON.parse(line)
          } catch {
            continue // ignore malformed partial line
          }

          const piece = evt.message?.content
          if (piece) {
            accText += piece
            yield piece
          }
          for (const tc of evt.message?.tool_calls ?? []) {
            if (tc.function?.name) {
              toolCalls.push({
                name: tc.function.name,
                input: normalizeArgs(tc.function.arguments)
              })
            }
          }
          if (evt.done) doneReason = evt.done_reason ?? 'end_turn'
        }
      }
    }

    return {
      tokens: tokens(),
      final: async (): Promise<ModelFinal> => {
        const content: Anthropic.ContentBlockParam[] = []
        if (accText) content.push({ type: 'text', text: accText })
        toolCalls.forEach((tc, i) => {
          content.push({
            type: 'tool_use',
            // Stable within this message; the agent loop echoes it back as the
            // tool_result's tool_use_id, which toOllamaMessages re-pairs by name.
            id: `ollama_tool_${i}`,
            name: tc.name,
            input: tc.input
          })
        })
        return {
          content,
          stopReason: toolCalls.length ? 'tool_use' : doneReason
        }
      }
    }
  }
}

interface OllamaChunk {
  message?: {
    content?: string
    tool_calls?: Array<{ function?: { name?: string; arguments?: unknown } }>
  }
  done?: boolean
  done_reason?: string
}

/** Ollama returns tool arguments as an object (sometimes a JSON string). */
function normalizeArgs(args: unknown): Record<string, unknown> {
  if (args && typeof args === 'object') return args as Record<string, unknown>
  if (typeof args === 'string') {
    try {
      return JSON.parse(args)
    } catch {
      return {}
    }
  }
  return {}
}

/**
 * Translate canonical Anthropic messages into Ollama chat messages.
 *
 * Anthropic encodes a tool result as a user message whose content is an array of
 * tool_result blocks (keyed only by tool_use_id). Ollama wants a `tool` role
 * message keyed by tool *name*, so we track id→name as we walk the assistant
 * tool_use blocks and re-pair them when we hit the matching results.
 */
function toOllamaMessages(
  messages: Anthropic.MessageParam[]
): Array<{ role: string; content: string; tool_calls?: unknown[]; tool_name?: string }> {
  const out: Array<{
    role: string
    content: string
    tool_calls?: unknown[]
    tool_name?: string
  }> = []
  const idToName = new Map<string, string>()

  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content })
      continue
    }

    if (m.role === 'assistant') {
      let text = ''
      const calls: unknown[] = []
      for (const block of m.content) {
        if (block.type === 'text') text += block.text
        else if (block.type === 'tool_use') {
          idToName.set(block.id, block.name)
          calls.push({ function: { name: block.name, arguments: block.input } })
        }
      }
      out.push({
        role: 'assistant',
        content: text,
        ...(calls.length ? { tool_calls: calls } : {})
      })
      continue
    }

    // user message with array content = tool_result blocks
    for (const block of m.content) {
      if (block.type === 'tool_result') {
        out.push({
          role: 'tool',
          tool_name: idToName.get(block.tool_use_id) ?? '',
          content:
            typeof block.content === 'string'
              ? block.content
              : (block.content ?? [])
                  .map((c) => (c.type === 'text' ? c.text : ''))
                  .join('')
        })
      } else if (block.type === 'text') {
        out.push({ role: 'user', content: block.text })
      }
    }
  }

  return out
}
