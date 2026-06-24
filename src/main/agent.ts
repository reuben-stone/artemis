import Anthropic from '@anthropic-ai/sdk'
import { app, BrowserWindow } from 'electron'
import { join, dirname, resolve } from 'path'
import { promises as fs } from 'fs'
import { exec } from 'child_process'
import { promisify } from 'util'
import { glob } from 'glob'
import { getModelClient } from './model'
import { loadMemory, saveMemory } from './memory'
import {
  loadRecentMessages,
  appendMessage,
  saveTurn,
  loadLastTurn,
  markTurnClaimed,
  startNewConversation,
  undoNewConversation,
  type StoredTurn
} from './store'

const execAsync = promisify(exec)

// Marker carried in every reply: everything after it is spoken aloud and hidden
// from the on-screen transcript. Kept in sync with renderer/agent/speech.ts.
const SAY_MARKER = '⟦say⟧'

// Patterns we refuse without asking the user.
export const DANGEROUS = /\b(rm\s+-rf?\s+[~/]|mkfs|dd\s+if=|:\(\)\s*\{|shutdown|reboot|>\s*\/dev\/sd)/i

// Tools that need no permission prompt (read-only + our own memory ops).
export const AUTO_ALLOW = new Set(['Read', 'Glob', 'Grep', 'save_memory', 'recall_memory', 'WebFetch'])

function repoRoot(): string {
  return app.getAppPath()
}

// ─── System prompt cache ───────────────────────────────────────────────────

let _systemCache: string | null = null
let _systemCacheTime = 0
const SYSTEM_CACHE_TTL = 60_000

export function invalidateSystemCache(): void {
  _systemCache = null
}

async function buildSystemPrompt(): Promise<string> {
  const now = Date.now()
  if (_systemCache && now - _systemCacheTime < SYSTEM_CACHE_TTL) return _systemCache

  const parts: string[] = []
  try {
    parts.push(await fs.readFile(join(repoRoot(), 'ARTEMIS.md'), 'utf8'))
  } catch {
    parts.push('Your name is Artemis. You are a Claude-based operator.')
  }

  // Durable self-model — keeps Artemis accurate about how it's actually built, so it
  // stops hallucinating about its own architecture/memory. High-altitude by design.
  try {
    parts.push(await fs.readFile(join(repoRoot(), 'ARTEMIS-CORE.md'), 'utf8'))
  } catch {
    // optional — absence just means a thinner self-model
  }

  try {
    const { index, facts } = await loadMemory()
    if (facts.length) {
      parts.push(
        [
          'PERSISTENT MEMORY — durable facts you saved across past sessions. Treat them as',
          'background knowledge about the user and their projects: rely on them, but if one',
          'names a file/flag/function, verify it still exists before acting on it. You can',
          'curate this yourself: save_memory to store a new durable fact, recall_memory to',
          'reload everything you know. Save when you learn something stable and worth keeping.',
          '',
          index.trim(),
          '',
          facts.map((f) => f.trim()).join('\n\n---\n\n')
        ].join('\n')
      )
    }
  } catch {
    // no memory store yet
  }

  parts.push(
    [
      `SPOKEN SUMMARY — you have a voice, and it should sound like a person, not a recital.`,
      `End every reply with a final line that starts with the marker ${SAY_MARKER} followed by ONE or TWO short, natural sentences capturing the gist — what you did, found, or need next. No markdown, code, lists, or file paths in this line; write it to be heard, not read.`,
      `Everything before ${SAY_MARKER} is shown on screen; everything after it is spoken aloud and hidden from the transcript. Example ending:`,
      `${SAY_MARKER} Done — I trimmed the voice down to a quick summary and smoothed out the chat. Want me to try it live?`
    ].join('\n')
  )

  parts.push(
    [
      'CHAT FORMATTING — the on-screen answer renders as GitHub-flavoured markdown with',
      'single line breaks preserved. When a reply makes several points, put each on its own',
      'line or as a short bulleted list ("- ") instead of running them together as a',
      'paragraph of sentences. Keep it scannable. This applies to the on-screen text only,',
      `never to the spoken ${SAY_MARKER} line.`
    ].join('\n')
  )

  parts.push(
    'TOOL DISCIPLINE — for conversational replies, greetings, or answers you already know, respond directly without calling any tools. Only use Read, Grep, Glob, Bash, Edit, or Write when the task genuinely requires inspecting or changing files. Unnecessary tool calls add latency.'
  )

  parts.push(
    [
      'CONVERSATION CONTEXT — you are given only the *active* conversation thread, not',
      'your entire history. Earlier conversations are archived in the local SQLite store',
      'below a "view floor"; raising that floor is exactly what the "new conversation"',
      'control does. Archived threads are NOT in your context and you cannot read their',
      'contents back (they are not lost — just out of view) unless they were summarized',
      'into PERSISTENT MEMORY. So when asked about a past conversation you do not see, say',
      'plainly that it is archived and not in your current context rather than guessing or',
      'pretending to recall it. And do not confuse this with save_memory: a question like',
      '"do you remember our last conversation?" is asking about recall, NOT a request to',
      'save a memory — only call save_memory for a specific, durable fact worth keeping.'
    ].join('\n')
  )

  _systemCache = parts.join('\n\n')
  _systemCacheTime = now
  return _systemCache
}

// ─── Tool definitions ──────────────────────────────────────────────────────

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'Read',
    description:
      'Read a file from the local filesystem. Returns the file content with line numbers. Use offset/limit to read a slice of a large file.',
    input_schema: {
      type: 'object' as const,
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file to read' },
        offset: { type: 'number', description: 'Line number to start reading from (1-indexed)' },
        limit: { type: 'number', description: 'Maximum number of lines to read' }
      },
      required: ['file_path']
    }
  },
  {
    name: 'Write',
    description:
      'Write content to a file. Creates parent directories if needed. Overwrites the file if it exists.',
    input_schema: {
      type: 'object' as const,
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file to write' },
        content: { type: 'string', description: 'Content to write to the file' }
      },
      required: ['file_path', 'content']
    }
  },
  {
    name: 'Edit',
    description:
      'Replace an exact string in a file. The old_string must match exactly (including whitespace). Fails if old_string is not found.',
    input_schema: {
      type: 'object' as const,
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file to edit' },
        old_string: { type: 'string', description: 'The exact text to find and replace' },
        new_string: { type: 'string', description: 'The text to replace it with' },
        replace_all: {
          type: 'boolean',
          description: 'Replace all occurrences (default: false, replace only the first)'
        }
      },
      required: ['file_path', 'old_string', 'new_string']
    }
  },
  {
    name: 'Glob',
    description:
      'Find files matching a glob pattern. Returns absolute paths sorted by modification time.',
    input_schema: {
      type: 'object' as const,
      properties: {
        pattern: { type: 'string', description: 'Glob pattern, e.g. "**/*.ts" or "src/**/*.tsx"' },
        path: {
          type: 'string',
          description: 'Directory to search in (defaults to the repo root)'
        }
      },
      required: ['pattern']
    }
  },
  {
    name: 'Grep',
    description:
      'Search for a regex pattern in files. Returns matching lines with file and line number.',
    input_schema: {
      type: 'object' as const,
      properties: {
        pattern: { type: 'string', description: 'Regex pattern to search for' },
        path: {
          type: 'string',
          description: 'File or directory to search in (defaults to repo root)'
        },
        glob: {
          type: 'string',
          description: 'File glob filter, e.g. "*.ts" (searches all files if omitted)'
        },
        output_mode: {
          type: 'string',
          enum: ['content', 'files_with_matches', 'count'],
          description: 'content = matching lines, files_with_matches = file paths only, count = match counts'
        },
        '-i': { type: 'boolean', description: 'Case-insensitive search' }
      },
      required: ['pattern']
    }
  },
  {
    name: 'Bash',
    description:
      'Run a shell command. Working directory is the repo root. Avoid destructive commands — they will be blocked. Timeout defaults to 30s.',
    input_schema: {
      type: 'object' as const,
      properties: {
        command: { type: 'string', description: 'Shell command to execute' },
        timeout: { type: 'number', description: 'Timeout in milliseconds (default: 30000)' },
        description: {
          type: 'string',
          description: 'Short human-readable description of what this command does'
        }
      },
      required: ['command']
    }
  },
  {
    name: 'WebFetch',
    description: 'Fetch a URL and return the page content as plain text (HTML stripped).',
    input_schema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'The URL to fetch' },
        prompt: {
          type: 'string',
          description: 'What to extract or look for in the page (hint, not a filter)'
        }
      },
      required: ['url']
    }
  },
  {
    name: 'save_memory',
    description:
      'Save a durable fact to persistent memory so you remember it across sessions. Use for stable facts about the user, their preferences, projects, or decisions — never ephemeral chatter.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string',
          description: 'Short kebab-case slug naming the fact (used as the filename)'
        },
        description: {
          type: 'string',
          description: 'One-line summary, shown in the memory index'
        },
        type: {
          type: 'string',
          enum: ['user', 'feedback', 'project', 'reference'],
          description:
            'Category: who the user is / how to work with them / ongoing work / external pointer'
        },
        body: { type: 'string', description: 'The fact itself, in full' }
      },
      required: ['name', 'description', 'type', 'body']
    }
  },
  {
    name: 'recall_memory',
    description:
      'Recall everything in persistent memory — the index plus every saved fact. Use to check what you already know before answering.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: []
    }
  }
]

// ─── Tool implementations ─────────────────────────────────────────────────

async function toolRead(input: {
  file_path: string
  offset?: number
  limit?: number
}): Promise<string> {
  const content = await fs.readFile(input.file_path, 'utf8')
  const lines = content.split('\n')
  const start = Math.max(0, (input.offset ?? 1) - 1)
  const end = input.limit != null ? start + input.limit : lines.length
  return lines
    .slice(start, end)
    .map((l, i) => `${start + i + 1}\t${l}`)
    .join('\n')
}

async function toolWrite(input: { file_path: string; content: string }): Promise<string> {
  await fs.mkdir(dirname(resolve(input.file_path)), { recursive: true })
  await fs.writeFile(input.file_path, input.content, 'utf8')
  return `Written ${input.content.length} bytes to ${input.file_path}`
}

async function toolEdit(input: {
  file_path: string
  old_string: string
  new_string: string
  replace_all?: boolean
}): Promise<string> {
  let content = await fs.readFile(input.file_path, 'utf8')
  if (!content.includes(input.old_string)) {
    throw new Error(
      `old_string not found in ${input.file_path}. The string must match exactly including whitespace.`
    )
  }
  if (input.replace_all) {
    content = content.split(input.old_string).join(input.new_string)
  } else {
    content = content.replace(input.old_string, input.new_string)
  }
  await fs.writeFile(input.file_path, content, 'utf8')
  return `Edited ${input.file_path}`
}

async function toolGlob(input: { pattern: string; path?: string }): Promise<string> {
  const cwd = input.path ? resolve(input.path) : repoRoot()
  const files = await glob(input.pattern, { cwd, absolute: true, nodir: true })
  // Sort by modification time (newest first)
  const stats = await Promise.all(
    files.map(async (f) => {
      try {
        const s = await fs.stat(f)
        return { f, mtime: s.mtimeMs }
      } catch {
        return { f, mtime: 0 }
      }
    })
  )
  stats.sort((a, b) => b.mtime - a.mtime)
  return stats.map((s) => s.f).join('\n') || '(no matches)'
}

async function toolGrep(input: {
  pattern: string
  path?: string
  glob?: string
  output_mode?: 'content' | 'files_with_matches' | 'count'
  '-i'?: boolean
}): Promise<string> {
  const searchPath = input.path ? resolve(input.path) : repoRoot()
  const mode = input.output_mode ?? 'content'
  const flags = input['-i'] ? 'gi' : 'g'
  let re: RegExp
  try {
    re = new RegExp(input.pattern, flags)
  } catch {
    throw new Error(`Invalid regex: ${input.pattern}`)
  }

  // Collect files to search
  const globPattern = input.glob ?? '**/*'
  let files: string[]
  try {
    const stat = await fs.stat(searchPath)
    if (stat.isFile()) {
      files = [searchPath]
    } else {
      files = await glob(globPattern, {
        cwd: searchPath,
        absolute: true,
        nodir: true,
        ignore: ['**/node_modules/**', '**/.git/**', '**/out/**', '**/dist/**']
      })
    }
  } catch {
    files = []
  }

  const results: string[] = []
  let totalCount = 0

  for (const file of files) {
    let text: string
    try {
      text = await fs.readFile(file, 'utf8')
    } catch {
      continue // skip binary files
    }
    // Reset lastIndex between files
    re.lastIndex = 0
    const lines = text.split('\n')
    const matchingLines: string[] = []
    let fileCount = 0

    for (let i = 0; i < lines.length; i++) {
      re.lastIndex = 0
      if (re.test(lines[i])) {
        matchingLines.push(`${i + 1}:${lines[i]}`)
        fileCount++
      }
    }

    if (fileCount === 0) continue
    totalCount += fileCount

    if (mode === 'files_with_matches') {
      results.push(file)
    } else if (mode === 'count') {
      results.push(`${file}: ${fileCount}`)
    } else {
      for (const line of matchingLines) results.push(`${file}:${line}`)
    }
  }

  if (results.length === 0) return '(no matches)'
  return results.join('\n')
}

async function toolBash(input: {
  command: string
  timeout?: number
  description?: string
}): Promise<string> {
  if (DANGEROUS.test(input.command)) {
    throw new Error('Refused: dangerous command blocked by Artemis.')
  }
  const { stdout, stderr } = await execAsync(input.command, {
    cwd: repoRoot(),
    timeout: input.timeout ?? 30_000,
    maxBuffer: 2 * 1024 * 1024
  })
  return [stdout, stderr].filter(Boolean).join('\n').trim() || '(no output)'
}

async function toolWebFetch(input: { url: string; prompt?: string }): Promise<string> {
  const res = await fetch(input.url, {
    headers: { 'User-Agent': 'Artemis/1.0 (operator bot)' }
  })
  const html = await res.text()
  // Strip tags and collapse whitespace
  const text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 50_000)
  return text || '(empty page)'
}

async function toolSaveMemory(input: {
  name: string
  description: string
  type: 'user' | 'feedback' | 'project' | 'reference'
  body: string
}): Promise<string> {
  const { file } = await saveMemory(input)
  invalidateSystemCache()
  return `Saved to memory (${file}).`
}

async function toolRecallMemory(): Promise<string> {
  const { index, facts } = await loadMemory()
  return facts.length
    ? `${index.trim()}\n\n${facts.map((f) => f.trim()).join('\n\n---\n\n')}`
    : 'No memories saved yet.'
}

export async function executeTool(name: string, input: Record<string, unknown>): Promise<string> {
  switch (name) {
    case 'Read':
      return toolRead(input as Parameters<typeof toolRead>[0])
    case 'Write':
      return toolWrite(input as Parameters<typeof toolWrite>[0])
    case 'Edit':
      return toolEdit(input as Parameters<typeof toolEdit>[0])
    case 'Glob':
      return toolGlob(input as Parameters<typeof toolGlob>[0])
    case 'Grep':
      return toolGrep(input as Parameters<typeof toolGrep>[0])
    case 'Bash':
      return toolBash(input as Parameters<typeof toolBash>[0])
    case 'WebFetch':
      return toolWebFetch(input as Parameters<typeof toolWebFetch>[0])
    case 'save_memory':
      return toolSaveMemory(input as Parameters<typeof toolSaveMemory>[0])
    case 'recall_memory':
      return toolRecallMemory()
    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}

// ─── Message assembly ──────────────────────────────────────────────────────

/** Convert SQLite message history into the canonical Anthropic MessageParam format.
 *  - Skip leading assistant messages (API requires first message to be user).
 *  - Merge consecutive same-role messages to satisfy the alternation constraint.
 *  Backend-neutral: prompt-cache anchoring is the AnthropicClient's job, not this.
 */
export function buildMessages(
  history: { role: 'user' | 'assistant'; text: string }[],
  newUserMessage: string
): Anthropic.MessageParam[] {
  // Drop leading assistant messages (API constraint: must start with user)
  const firstUser = history.findIndex((m) => m.role === 'user')
  const trimmed = firstUser >= 0 ? history.slice(firstUser) : []

  const params: Anthropic.MessageParam[] = []

  // Merge consecutive same-role turns (can happen after error recovery)
  for (const m of trimmed) {
    const prev = params[params.length - 1]
    if (prev && prev.role === m.role) {
      prev.content = (prev.content as string) + '\n\n' + m.text
    } else {
      params.push({ role: m.role, content: m.text })
    }
  }

  // Append the new user turn
  params.push({ role: 'user', content: newUserMessage })
  return params
}

// ─── Speechline helpers ────────────────────────────────────────────────────

export function splitSpeech(text: string): { display: string; speech: string } {
  const i = text.indexOf(SAY_MARKER)
  if (i === -1) return { display: text, speech: '' }
  return {
    display: text.slice(0, i).trimEnd(),
    speech: text.slice(i + SAY_MARKER.length).trim()
  }
}

// ─── Turn buffer (in-flight turn recovery across hot-reloads) ─────────────

interface TurnBuffer {
  requestId: string
  text: string
  done: string | null
  speech: string
  error: string | null
  state: string
  claimed: boolean
}

const turns = new Map<string, TurnBuffer>()
let lastTurnId: string | null = null

export function getResyncTurn(): TurnBuffer | null {
  if (lastTurnId) {
    const t = turns.get(lastTurnId)
    if (t) {
      if (t.done !== null || t.error !== null) {
        if (t.claimed) return null
        t.claimed = true
      }
      return t
    }
  }
  // Full restart: recover from SQLite
  const stored = loadLastTurn()
  if (!stored || stored.claimed || !stored.text.trim()) return null
  markTurnClaimed(stored.requestId)
  appendMessage('assistant', stored.text)
  return {
    requestId: stored.requestId,
    text: stored.text,
    done: stored.text,
    speech: stored.speech,
    error: null,
    state: 'idle',
    claimed: true
  }
}

// ─── Session / conversation reset ─────────────────────────────────────────

// With the raw SDK, "session" is just the SQLite history. Resetting is
// raising the view_floor (already handled by store.startNewConversation).
export async function resetSession(): Promise<void> {
  startNewConversation()
  lastTurnId = null
}

// Reversible counterpart to resetSession: un-archive the prior thread (restore the
// previous view floor and drop the fresh-start greeting). Backs the Undo toast.
export async function undoSession(): Promise<void> {
  undoNewConversation()
  lastTurnId = null
}

// ─── Permission gate ───────────────────────────────────────────────────────

export interface PermissionAsker {
  (req: { toolName: string; input: unknown }): Promise<boolean>
}

// ─── Main agent loop ───────────────────────────────────────────────────────

export async function runAgent(
  win: BrowserWindow,
  requestId: string,
  prompt: string,
  askPermission: PermissionAsker
): Promise<void> {
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
  saveTurn(turn)

  let lastPersist = 0

  // Keep the in-memory buffer bounded
  if (turns.size > 8) {
    for (const [id, t] of turns) {
      if (turns.size <= 8) break
      if (id !== requestId && (t.done !== null || t.error !== null)) turns.delete(id)
    }
  }

  const send = (payload: Record<string, unknown>) => {
    if (typeof payload.state === 'string') turn.state = payload.state as string
    if (!win.isDestroyed()) win.webContents.send('agent:event', { requestId, ...payload })
  }

  send({ state: 'thinking' })

  try {
    // The brain for this turn — Anthropic API, local Ollama, or (later) the
    // subscription CLI — chosen fresh from the backend preference. The loop below
    // is identical regardless of which one we got.
    const client = await getModelClient()
    const systemPrompt = await buildSystemPrompt()
    const history = loadRecentMessages(60)

    // Build the canonical message array: history + new user message.
    const localMessages: Anthropic.MessageParam[] = buildMessages(history, prompt)

    let accText = ''

    // The agentic loop: stream response, execute tool calls, repeat until end_turn.
    while (true) {
      send({ state: 'thinking' })

      const turnStream = client.stream({
        system: systemPrompt,
        messages: localMessages,
        tools: TOOLS
      })

      // Stream text tokens to the renderer in real-time
      for await (const token of turnStream.tokens) {
        accText += token
        turn.text = accText
        send({ token })
        const now = Date.now()
        if (now - lastPersist > 700) {
          lastPersist = now
          saveTurn(turn)
        }
      }

      const final = await turnStream.final()

      // Add the assistant's full response (text + any tool_use blocks) to local context
      localMessages.push({ role: 'assistant', content: final.content })

      if (final.stopReason !== 'tool_use') break // done — exit the loop

      // Execute tool calls
      send({ state: 'executing' })
      const toolResults: Anthropic.ToolResultBlockParam[] = []

      for (const block of final.content) {
        if (block.type !== 'tool_use') continue

        const toolInput = block.input as Record<string, unknown>

        // Permission gate
        if (!AUTO_ALLOW.has(block.name)) {
          if (
            block.name === 'Bash' &&
            typeof toolInput.command === 'string' &&
            DANGEROUS.test(toolInput.command)
          ) {
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: 'Refused: destructive command blocked by Artemis.',
              is_error: true
            })
            continue
          }

          const ok = await askPermission({ toolName: block.name, input: toolInput })
          if (!ok) {
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: 'Denied by user.',
              is_error: true
            })
            continue
          }
        }

        // Execute
        try {
          const result = await executeTool(block.name, toolInput)
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: result
          })
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err)
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: `Error: ${msg}`,
            is_error: true
          })
        }
      }

      // Feed tool results back and loop
      localMessages.push({ role: 'user', content: toolResults })
    }

    // Turn complete — strip the ⟦say⟧ marker and commit
    const { display, speech } = splitSpeech(accText.trim())
    turn.done = display
    turn.speech = speech
    turn.claimed = true
    appendMessage('assistant', display)
    saveTurn(turn)
    send({ done: display, speech, state: 'idle', cost: 0 })
  } catch (err: unknown) {
    const raw = err instanceof Error ? err.message : String(err)
    const isAuth = /auth|api[_-]?key|401|unauthor|no api key/i.test(raw)
    turn.error = isAuth
      ? 'Not authenticated. Set ANTHROPIC_API_KEY in your environment or add a key in Artemis settings.'
      : raw
    turn.claimed = true
    appendMessage('assistant', `⚠️ ${turn.error}`)
    saveTurn(turn)
    send({ error: turn.error, state: 'error' })
  }
}
