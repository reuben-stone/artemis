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

// Marker the operator appends to carry a short, spoken-aloud summary that is
// distinct from the on-screen answer. Everything after it is the voice line and
// is hidden from the transcript. Kept in sync with the renderer (agent/speech.ts).
const SAY_MARKER = '⟦say⟧'

/** Split a reply into the on-screen text and the (optional) spoken-aloud line. */
function splitSpeech(text: string): { display: string; speech: string } {
  const i = text.indexOf(SAY_MARKER)
  if (i === -1) return { display: text, speech: '' }
  return {
    display: text.slice(0, i).trimEnd(),
    speech: text.slice(i + SAY_MARKER.length).trim()
  }
}

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
  // Spoken summary: the chat shows the full answer; the voice should be conversational.
  parts.push(
    [
      'SPOKEN SUMMARY — you have a voice, and it should sound like a person, not a recital.',
      `End every reply with a final line that starts with the marker ${SAY_MARKER} followed by ONE or TWO short, natural sentences capturing the gist — what you did, found, or need next. No markdown, code, lists, or file paths in this line; write it to be heard, not read.`,
      `Everything before ${SAY_MARKER} is shown on screen; everything after it is spoken aloud and hidden from the transcript. Example ending:`,
      `${SAY_MARKER} Done — I trimmed the voice down to a quick summary and smoothed out the chat. Want me to try it live?`
    ].join('\n')
  )
  return parts.join('\n\n')
}

export interface PermissionAsker {
  (req: { toolName: string; input: unknown }): Promise<boolean>
}

/**
 * Durable session state — deliberately kept in the *main* process, which survives
 * renderer hot-reloads (electron-vite only reloads the renderer when renderer files
 * change). This is what lets a conversation persist across the code changes Artemis
 * makes to its own UI.
 *
 *  - `currentSessionId` is the Agent SDK session we `resume` on every turn, so the
 *    operator actually remembers prior turns. It's mirrored to disk so it also
 *    survives a full main-process restart (a rebuild of `src/main`).
 *  - `turns` buffers each turn's streamed text/result so a renderer that reloaded
 *    mid-answer can re-attach and recover what it missed (see `getResyncTurn`).
 */
interface TurnBuffer {
  requestId: string
  text: string
  done: string | null
  speech: string
  error: string | null
  state: string
  claimed: boolean
}

let currentSessionId: string | null = null
let sessionLoaded = false
const turns = new Map<string, TurnBuffer>()
let lastTurnId: string | null = null

function sessionFile(): string {
  return join(app.getPath('userData'), 'artemis-session.json')
}

async function loadSessionId(): Promise<void> {
  if (sessionLoaded) return
  sessionLoaded = true
  try {
    const data = JSON.parse(await fs.readFile(sessionFile(), 'utf8'))
    if (typeof data.sessionId === 'string') currentSessionId = data.sessionId
  } catch {
    // no prior session on disk — first run, nothing to resume
  }
}

async function saveSessionId(id: string): Promise<void> {
  currentSessionId = id
  try {
    await fs.writeFile(sessionFile(), JSON.stringify({ sessionId: id }), 'utf8')
  } catch (err) {
    console.error('[artemis] failed to persist session id:', err)
  }
}

/**
 * Snapshot of the most recent turn so a freshly-reloaded renderer can re-attach.
 * - In-flight turn: returned every time (the renderer must keep streaming it).
 * - Finished turn: returned once, then marked `claimed` so later reloads don't
 *   re-apply a stale answer over a transcript that's already up to date.
 */
export function getResyncTurn(): TurnBuffer | null {
  if (!lastTurnId) return null
  const t = turns.get(lastTurnId)
  if (!t) return null
  if (t.done !== null || t.error !== null) {
    if (t.claimed) return null
    t.claimed = true
  }
  return t
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
  await loadSessionId()

  const turn: TurnBuffer = {
    requestId,
    text: '',
    done: null,
    speech: '',
    error: null,
    state: 'thinking',
    claimed: false
  }
  turns.set(requestId, turn)
  lastTurnId = requestId
  // keep the buffer bounded — drop the oldest finished turns
  if (turns.size > 8) {
    for (const [id, t] of turns) {
      if (turns.size <= 8) break
      if (id !== requestId && (t.done !== null || t.error !== null)) turns.delete(id)
    }
  }

  const send = (payload: Record<string, unknown>) => {
    if (typeof payload.state === 'string') turn.state = payload.state
    if (!win.isDestroyed()) win.webContents.send('agent:event', { requestId, ...payload })
  }

  // Subscription-first auth: only set the key when there's no login to inherit.
  if (!process.env.ANTHROPIC_API_KEY && !(await hasSubscriptionLogin())) {
    const key = await getApiKey()
    if (key) process.env.ANTHROPIC_API_KEY = key
  }

  send({ state: 'thinking' })

  const systemAppend = await buildSystemAppend()

  // One streaming attempt. Returns 'retry-fresh' if a resume target was missing
  // (e.g. the on-disk session was pruned or the cwd changed) and we produced no
  // output yet — in that case we drop the stale id and start a clean session so a
  // turn is never lost to an unresumable id.
  const attempt = async (resumeId: string | null): Promise<'ok' | 'retry-fresh'> => {
    let produced = false
    let full = ''
    try {
      const stream = query({
        prompt,
        options: {
          cwd: repoRoot(),
          model: MODEL,
          includePartialMessages: true,
          settingSources: ['project'],
          resume: resumeId ?? undefined,
          systemPrompt: {
            type: 'preset',
            preset: 'claude_code',
            append: systemAppend
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
        // Capture/refresh the resumable session id from any message that carries it.
        if (typeof message.session_id === 'string' && message.session_id !== currentSessionId) {
          await saveSessionId(message.session_id)
        }
        if (message.type === 'stream_event') {
          const ev = message.event
          if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
            produced = true
            full += ev.delta.text
            turn.text = full
            send({ token: ev.delta.text })
          }
        } else if (message.type === 'assistant') {
          // surface tool use as "executing" state
          for (const block of message.message?.content ?? []) {
            if (block?.type === 'tool_use') send({ state: 'executing' })
          }
        } else if (message.type === 'result') {
          produced = true
          if (message.subtype === 'success') {
            const { display, speech } = splitSpeech((message.result ?? full).trim())
            turn.done = display
            turn.speech = speech
            send({ done: display, speech, cost: message.total_cost_usd })
          } else {
            turn.error = `Stopped: ${message.subtype}`
            send({ error: turn.error, state: 'error' })
          }
        }
      }
      return 'ok'
    } catch (err: any) {
      // A resume that fails before producing anything → stale id; retry clean.
      if (resumeId && !produced) {
        console.error('[artemis] resume failed, starting a fresh session:', err?.message ?? err)
        return 'retry-fresh'
      }
      const msg = String(err?.message ?? err)
      // surface an auth problem with an actionable hint
      const isAuth = /auth|api[_-]?key|401|unauthor/i.test(msg)
      turn.error = isAuth
        ? 'Not authenticated. Log into Claude Code (run `claude` once), or add an API key in settings.'
        : msg
      send({ error: turn.error, state: 'error' })
      return 'ok'
    }
  }

  if ((await attempt(currentSessionId)) === 'retry-fresh') {
    currentSessionId = null
    await attempt(null)
  }
}
