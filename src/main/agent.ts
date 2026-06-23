import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { promises as fs } from 'fs'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { getApiKey } from './secrets'

/**
 * Artemis's mind: the Claude Agent SDK agentic loop.
 *
 * Auth is subscription-first — if the user is logged into Claude Code (credentials
 * in ~/.claude / OS keychain), the SDK inherits that login and runs on the flat
 * subscription rate. We only inject a stored ANTHROPIC_API_KEY when there's no
 * login to inherit (setting the key would otherwise override the subscription).
 *
 * Self-hosting: cwd is Artemis's own repo, so it can read and edit its own source,
 * and run its terminal — gated by canUseTool (routed to the renderer for approval).
 */

const MODEL = 'claude-opus-4-8'

// Dangerous shell patterns we refuse outright, before even asking the user.
const DANGEROUS = /\b(rm\s+-rf?\s+[~/]|mkfs|dd\s+if=|:\(\)\s*\{|shutdown|reboot|>\s*\/dev\/sd)/i

const READ_ONLY = new Set(['Read', 'Glob', 'Grep', 'NotebookRead'])

function repoRoot(): string {
  // Dev: app path is the repo root. Self-hosting points the operator at itself.
  return app.getAppPath()
}

async function hasSubscriptionLogin(): Promise<boolean> {
  // Claude Code stores a login under ~/.claude (sessions/credentials). Its presence
  // means the SDK can inherit it; we then avoid setting an API key.
  return existsSync(join(homedir(), '.claude'))
}

/** Build the system prompt: Claude Code preset + Artemis identity + memory. */
async function buildSystemAppend(): Promise<string> {
  const parts: string[] = []
  try {
    parts.push(await fs.readFile(join(repoRoot(), 'ARTEMIS.md'), 'utf8'))
  } catch {
    parts.push('Your name is Artemis. You are a Claude-based operator.')
  }
  return parts.join('\n\n')
}

export interface PermissionAsker {
  (req: { toolName: string; input: unknown }): Promise<boolean>
}

/**
 * Run one operator turn. Streams events to the renderer via webContents and uses
 * `askPermission` to gate write/exec tools through the UI.
 */
export async function runAgent(
  win: BrowserWindow,
  requestId: string,
  prompt: string,
  askPermission: PermissionAsker
): Promise<void> {
  const send = (payload: Record<string, unknown>) => {
    if (!win.isDestroyed()) win.webContents.send('agent:event', { requestId, ...payload })
  }

  // Subscription-first auth: only set the key when there's no login to inherit.
  if (!process.env.ANTHROPIC_API_KEY && !(await hasSubscriptionLogin())) {
    const key = await getApiKey()
    if (key) process.env.ANTHROPIC_API_KEY = key
  }

  send({ state: 'thinking' })

  let full = ''
  try {
    const stream = query({
      prompt,
      options: {
        cwd: repoRoot(),
        model: MODEL,
        includePartialMessages: true,
        settingSources: ['project'],
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: await buildSystemAppend()
        },
        allowedTools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', 'WebFetch', 'WebSearch'],
        permissionMode: 'default',
        canUseTool: async (toolName: string, input: Record<string, unknown>) => {
          // read-only tools run freely
          if (READ_ONLY.has(toolName)) return { behavior: 'allow', updatedInput: input }
          // refuse obviously destructive shell commands without asking
          if (toolName === 'Bash' && typeof input.command === 'string' && DANGEROUS.test(input.command)) {
            return { behavior: 'deny', message: 'Refused: destructive command blocked by Artemis.' }
          }
          send({ state: 'executing' })
          const ok = await askPermission({ toolName, input })
          return ok
            ? { behavior: 'allow', updatedInput: input }
            : { behavior: 'deny', message: 'Denied by user.' }
        }
      }
    })

    for await (const message of stream as AsyncIterable<any>) {
      if (message.type === 'stream_event') {
        const ev = message.event
        if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
          full += ev.delta.text
          send({ token: ev.delta.text })
        }
      } else if (message.type === 'assistant') {
        // surface tool use as "executing" state
        for (const block of message.message?.content ?? []) {
          if (block?.type === 'tool_use') send({ state: 'executing' })
        }
      } else if (message.type === 'result') {
        if (message.subtype === 'success') {
          send({ done: (message.result ?? full).trim(), cost: message.total_cost_usd })
        } else {
          send({ error: `Stopped: ${message.subtype}`, state: 'error' })
        }
      }
    }
  } catch (err: any) {
    const msg = String(err?.message ?? err)
    // surface an auth problem with an actionable hint
    const isAuth = /auth|api[_-]?key|401|unauthor/i.test(msg)
    send({
      error: isAuth
        ? 'Not authenticated. Log into Claude Code (run `claude` once), or add an API key in settings.'
        : msg,
      state: 'error'
    })
  }
}
