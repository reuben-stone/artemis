import Anthropic from '@anthropic-ai/sdk'
import { app, clipboard } from 'electron'
import { join, dirname, resolve } from 'path'
import { promises as fs } from 'fs'
import { exec } from 'child_process'
import { promisify } from 'util'
import os from 'node:os'
import { promises as dnsp } from 'node:dns'
import { glob } from 'glob'
import { getModelClient, type ModelFinal } from './model'
import { runWorker } from './worker'
import { loadMemory, saveMemory } from './memory'
import {
  loadRecentMessages,
  appendMessage,
  saveTurn,
  loadLastTurn,
  markTurnClaimed,
  startNewConversation,
  undoNewConversation,
  getActiveProjectPath,
  setActiveProjectPath,
  getActiveProject,
  listProjects,
  getProjectGaProps,
  listPrReviews,
  getPermissionMode,
  isCommandAllowed,
  allowCommand,
  localDay,
  listTodos,
  addTodo,
  updateTodo,
  removeTodo,
  carryOverTodos,
  unfinishedBefore,
  listEvents,
  listEventsRange,
  addEvent,
  updateEvent,
  removeEvent,
  type Todo,
  type TodoStatus,
  type CalendarEvent,
  type StoredTurn
} from './store'
import { gaSummary, hasGaCredentials } from './ga'
import { parseGitRemote } from './github'

const execAsync = promisify(exec)

// Marker carried in every reply: everything after it is spoken aloud and hidden
// from the on-screen transcript. Kept in sync with renderer/agent/speech.ts.
const SAY_MARKER = '⟦say⟧'

// Shared safety primitives (also used by the worker loop). Imported for internal use
// and re-exported so existing importers/tests that reference them via agent.ts work.
import { DANGEROUS, clampToolOutput, isSafeReadOnly } from './safety'
export { DANGEROUS, clampToolOutput, isSafeReadOnly }

// Tools that need no permission prompt (read-only + our own memory ops).
export const AUTO_ALLOW = new Set([
  'Read',
  'Glob',
  'Grep',
  'save_memory',
  'recall_memory',
  'WebFetch',
  'ecosystem_status',
  'system_context',
  'pr_queue',
  'tasks_view',
  'calendar_view',
  'plan_my_day',
  'show_panel',
  'switch_project'
])

// Artemis's OWN repo — identity docs, self-model, memory live here regardless of
// which project is active.
function repoRoot(): string {
  return app.getAppPath()
}

// The ACTIVE project's working dir — where file tools (Bash/Glob/Grep) operate.
// Defaults to Artemis's own repo when no other project is selected.
function activeProjectRoot(): string {
  return getActiveProjectPath()
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

  try {
    const projects = listProjects()
    if (projects.length) {
      const active = getActiveProject()
      const list = projects
        .map((p) => `- ${p.name}${active && p.path === active.path ? ' (active)' : ''} — ${p.path}`)
        .join('\n')
      parts.push(
        [
          `PROJECTS YOU OVERSEE — you have ${projects.length} registered project(s):`,
          list,
          '',
          'You are aware of ALL of them at once for generalized advice and overviews. Your file',
          'tools (Bash, Glob, Grep) act in the ACTIVE project; use absolute paths for',
          'Read/Write/Edit. For a cross-repo overview (e.g. a morning review) call the',
          '`ecosystem_status` tool — do NOT switch the active project just to summarize.',
          active
            ? `Active project: "${active.name}" at ${active.path}.${active.remote ? ` Remote: ${active.remote}.` : ''}`
            : '',
          `Your OWN source repo (${repoRoot()}) is one of these projects; editing it restarts you, the others do not.`
        ]
          .filter(Boolean)
          .join('\n')
      )
    }
  } catch {
    // registry not ready yet
  }

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
  },
  {
    name: 'ecosystem_status',
    description:
      'Cross-repo overview of ALL registered projects at once — for each: branch, uncommitted change count, last commit, and ahead/behind vs upstream. Use for morning reviews and generalized ecosystem summaries WITHOUT switching the active project. Read-only (git status only).',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: []
    }
  },
  {
    name: 'system_context',
    description:
      "Snapshot of the user's live desktop/OS context: local time, machine, active project, the frontmost app, battery, and network status. Call this when the answer depends on what the user is doing or the machine's state right now — e.g. 'what am I working on', 'what app am I in', 'am I on battery', 'are you online'. Read-only; a desktop sense a terminal tool doesn't have.",
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: []
    }
  },
  {
    name: 'pr_queue',
    description:
      "Read the PR Review Queue — pull requests that worker agents opened and that are awaiting the user's review/approval (project, title, branch, agent, reviewed status, link). Use for 'what PRs are waiting / what needs review / anything to approve'. Distinct from `ecosystem_status`, which lists live open PRs on GitHub across all repos. Read-only.",
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: []
    }
  },
  {
    name: 'read_clipboard',
    description:
      "Read the user's current clipboard text. Use when they refer to something they just copied — 'what did I copy', 'summarize what's on my clipboard', or 'fix this' right after copying code. Returns the clipboard text (or notes if it holds an image instead). Permission-gated, since the clipboard may contain secrets.",
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: []
    }
  },
  {
    name: 'tasks_view',
    description:
      "Read the user's todo/ticket list for a day (default today) as a formatted list. Tickets carry an id, status (todo/doing/done), optional priority, project, and tags. Also notes unfinished tickets still parked on earlier days (carry-over candidates). Use for 'what's on my list', 'what am I doing today', planning, or before adding/updating a ticket so you have its id.",
    input_schema: {
      type: 'object' as const,
      properties: {
        day: { type: 'string', description: "Day as 'YYYY-MM-DD'. Omit for today." }
      },
      required: []
    }
  },
  {
    name: 'task_add',
    description:
      "Add one or more tickets to a day's list (default today). Each becomes a ticket with status 'todo'. Use for 'add X to my list', 'remind me to…', capturing tasks. Set project to tie a ticket to a repo (e.g. 'Lumi'); priority is low|med|high.",
    input_schema: {
      type: 'object' as const,
      properties: {
        items: {
          type: 'array',
          description: 'The tickets to add.',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string', description: 'The ticket text.' },
              priority: { type: 'string', enum: ['low', 'med', 'high'] },
              project: { type: 'string', description: 'Associated project/repo name.' },
              tags: { type: 'string', description: 'Comma-separated labels.' }
            },
            required: ['text']
          }
        },
        day: { type: 'string', description: "Day as 'YYYY-MM-DD'. Omit for today." }
      },
      required: ['items']
    }
  },
  {
    name: 'task_update',
    description:
      "Update a ticket by id (get ids from tasks_view): change its status (todo/doing/done — use 'done' to check it off), edit the text, set priority/project/tags, or move it to another day. Only the fields you pass change.",
    input_schema: {
      type: 'object' as const,
      properties: {
        id: { type: 'number', description: 'The ticket id.' },
        status: { type: 'string', enum: ['todo', 'doing', 'done'] },
        text: { type: 'string' },
        priority: { type: 'string', enum: ['low', 'med', 'high'] },
        project: { type: 'string' },
        tags: { type: 'string' },
        day: { type: 'string', description: "Move to this day ('YYYY-MM-DD')." }
      },
      required: ['id']
    }
  },
  {
    name: 'task_remove',
    description: 'Delete a ticket by id (get ids from tasks_view). Use for "remove that" / "delete X" — not for completing one (use task_update status=done for that).',
    input_schema: {
      type: 'object' as const,
      properties: { id: { type: 'number', description: 'The ticket id.' } },
      required: ['id']
    }
  },
  {
    name: 'task_carry_over',
    description:
      "Pull every unfinished ticket from earlier days forward onto a target day (default today). Use for 'bring over yesterday's tasks', 'roll forward what I didn't finish', or first thing when planning the day. Each carried ticket remembers the day it started on.",
    input_schema: {
      type: 'object' as const,
      properties: {
        day: { type: 'string', description: "Target day as 'YYYY-MM-DD'. Omit for today." }
      },
      required: []
    }
  },
  {
    name: 'calendar_view',
    description:
      "Read the user's local calendar — a single day (default today) or a range of days. Returns timed and all-day events. Use for 'what's on today', 'am I free this afternoon', 'what's this week'.",
    input_schema: {
      type: 'object' as const,
      properties: {
        day: { type: 'string', description: "Start day as 'YYYY-MM-DD'. Omit for today." },
        days: { type: 'number', description: 'How many days from `day` to include (default 1).' }
      },
      required: []
    }
  },
  {
    name: 'event_add',
    description:
      "Add an event to the user's local calendar. Use for 'put X on my calendar', 'schedule a call at 3'. Times are local 'HH:MM' (24h); omit starts for an all-day event.",
    input_schema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'Event title.' },
        day: { type: 'string', description: "Day as 'YYYY-MM-DD'. Omit for today." },
        starts: { type: 'string', description: "Start time 'HH:MM' (24h). Omit for all-day." },
        ends: { type: 'string', description: "End time 'HH:MM' (24h)." },
        notes: { type: 'string' }
      },
      required: ['title']
    }
  },
  {
    name: 'event_update',
    description:
      'Update a calendar event by id (get ids from calendar_view): retitle, move day/time, or edit notes. Only the fields you pass change.',
    input_schema: {
      type: 'object' as const,
      properties: {
        id: { type: 'number', description: 'The event id.' },
        title: { type: 'string' },
        day: { type: 'string', description: "'YYYY-MM-DD'." },
        starts: { type: 'string', description: "'HH:MM' (24h)." },
        ends: { type: 'string', description: "'HH:MM' (24h)." },
        notes: { type: 'string' }
      },
      required: ['id']
    }
  },
  {
    name: 'event_remove',
    description: 'Delete a calendar event by id (get ids from calendar_view).',
    input_schema: {
      type: 'object' as const,
      properties: { id: { type: 'number', description: 'The event id.' } },
      required: ['id']
    }
  },
  {
    name: 'plan_my_day',
    description:
      "Gather everything needed to plan a day (default today) in one call: the day's tickets, unfinished tickets carried over from earlier days, and the day's calendar events. Use when the user says 'plan my day' / 'what should I focus on'. Then synthesise a focused plan; combine with ecosystem_status if the day is about the repos.",
    input_schema: {
      type: 'object' as const,
      properties: {
        day: { type: 'string', description: "Day as 'YYYY-MM-DD'. Omit for today." }
      },
      required: []
    }
  },
  {
    name: 'show_panel',
    description:
      "Drive your own interface: open or focus a panel so the user SEES it, not just reads a description of it. Use for 'show me the PR queue', 'open my calendar', 'pull up the briefing', 'open settings'. You can still summarise in words alongside opening it. (briefing = the ecosystem-status card.)",
    input_schema: {
      type: 'object' as const,
      properties: {
        panel: {
          type: 'string',
          enum: ['pr_queue', 'briefing', 'calendar', 'projects', 'settings', 'terminal', 'rail'],
          description: 'Which panel to open. "rail" expands the left HUD rail.'
        }
      },
      required: ['panel']
    }
  },
  {
    name: 'switch_project',
    description:
      "Switch the ACTIVE project — the repo your file tools (Bash/Glob/Grep/Read/Edit) operate in — and highlight it in the UI. Use when the user says 'switch to X', 'work on X', or a task clearly targets a specific repo. Names match loosely. Changes your working context from this point on, so do it before acting on that repo.",
    input_schema: {
      type: 'object' as const,
      properties: {
        project: { type: 'string', description: 'Project name or path (loose match).' }
      },
      required: ['project']
    }
  },
  {
    name: 'dispatch_worker',
    description:
      'Dispatch an autonomous worker agent to FIX an issue in one of the registered projects. The worker runs in an isolated git worktree, makes the change on a new branch, runs the repo checks, and opens a PR (it NEVER pushes to main) — the PR is logged to the review queue for the user to approve. Use this for concrete fix-it tasks across the ecosystem, not for questions. Requires the project to have a GitHub remote.',
    input_schema: {
      type: 'object' as const,
      properties: {
        project: {
          type: 'string',
          description: 'The project name (as shown in the registry, e.g. "livana-scanner")'
        },
        task: {
          type: 'string',
          description: 'A clear, self-contained description of the fix the worker should make'
        },
        title: { type: 'string', description: 'Optional PR title (defaults to the task)' }
      },
      required: ['project', 'task']
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

const GLOB_CAP = 500 // never return more than this many paths — protects the context window

async function toolGlob(input: { pattern: string; path?: string }): Promise<string> {
  const cwd = input.path ? resolve(input.path) : activeProjectRoot()
  const files = await glob(input.pattern, {
    cwd,
    absolute: true,
    nodir: true,
    // Skip heavy/vendored dirs — a `**/*` over a repo with node_modules would
    // otherwise return hundreds of thousands of paths and blow the context window.
    ignore: [
      '**/node_modules/**',
      '**/.git/**',
      '**/dist/**',
      '**/build/**',
      '**/.next/**',
      '**/out/**',
      '**/.svelte-kit/**',
      '**/.turbo/**'
    ]
  })
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
  if (!stats.length) return '(no matches)'
  const paths = stats.map((s) => s.f)
  if (paths.length > GLOB_CAP) {
    return (
      paths.slice(0, GLOB_CAP).join('\n') +
      `\n\n…[${paths.length - GLOB_CAP} more matches omitted — narrow the pattern]`
    )
  }
  return paths.join('\n')
}

async function toolGrep(input: {
  pattern: string
  path?: string
  glob?: string
  output_mode?: 'content' | 'files_with_matches' | 'count'
  '-i'?: boolean
}): Promise<string> {
  const searchPath = input.path ? resolve(input.path) : activeProjectRoot()
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
    cwd: activeProjectRoot(),
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

/** Dispatch a worker agent to fix an issue in a registered project and open a gated PR. */
async function toolDispatchWorker(input: {
  project: string
  task: string
  title?: string
}): Promise<string> {
  const projects = listProjects()
  const match = projects.find(
    (p) => p.name.toLowerCase() === input.project.trim().toLowerCase()
  )
  if (!match) {
    return `No project named "${input.project}". Registered: ${projects.map((p) => p.name).join(', ') || '(none)'}.`
  }
  const result = await runWorker({
    projectName: match.name,
    projectPath: match.path,
    remote: match.remote,
    task: input.task,
    title: input.title,
    label: 'worker'
  })
  return result.ok
    ? `Opened a PR for "${match.name}": ${result.url} (branch ${result.branch}). It's in the review queue for your approval.`
    : `Worker did not open a PR for "${match.name}": ${result.error}`
}

/** Quick, bounded network reachability check (DNS) so the tool never hangs. */
async function checkOnline(): Promise<boolean> {
  try {
    await Promise.race([
      dnsp.lookup('apple.com'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 1500))
    ])
    return true
  } catch {
    return false
  }
}

/** Read the user's clipboard text (permission-gated — may hold secrets). */
function toolReadClipboard(): string {
  const text = clipboard.readText()
  if (text && text.trim()) {
    const clamped =
      text.length > 8000 ? `${text.slice(0, 8000)}\n…[${text.length - 8000} more chars]` : text
    return `Clipboard text (${text.length} chars):\n\n${clamped}`
  }
  const img = clipboard.readImage()
  if (img && !img.isEmpty()) {
    return 'The clipboard holds an image, not text. Ask the user to paste it into the chat — it attaches as an image you can see.'
  }
  return 'The clipboard is empty (no text).'
}

/** Read the local PR Review Queue — worker-agent PRs awaiting the user's approval. */
function toolPrQueue(): string {
  const prs = listPrReviews()
  if (!prs.length) {
    return 'The PR Review Queue is empty — no agent-opened PRs are awaiting review. (For live open PRs on GitHub across all repos, use ecosystem_status.)'
  }
  const pending = prs.filter((p) => !p.reviewed).length
  const rows = prs.map((p) => {
    const head = `${p.reviewed ? '✓ reviewed' : '• awaiting review'} — [${p.project}] ${p.title}`
    const meta = [p.branch ? `branch ${p.branch}` : '', p.agent ? `by ${p.agent}` : '']
      .filter(Boolean)
      .join(', ')
    return `${head}${meta ? `\n    ${meta}` : ''}\n    ${p.url}`
  })
  return `PR Review Queue — ${prs.length} total, ${pending} awaiting review:\n\n${rows.join('\n\n')}`
}

// ─── Day planner: todos (a ticket system) + local calendar ──────────────────

/** Friendly day label — names today/yesterday/tomorrow, else the raw date. Noon-anchored
 *  arithmetic so DST never shifts the neighbour days. */
function dayLabel(day: string): string {
  const today = localDay()
  if (day === today) return `${day} (today)`
  const anchor = new Date(`${today}T12:00:00`).getTime()
  if (day === localDay(new Date(anchor - 86400000))) return `${day} (yesterday)`
  if (day === localDay(new Date(anchor + 86400000))) return `${day} (tomorrow)`
  return day
}

function fmtTodo(t: Todo): string {
  const box = t.status === 'done' ? '☑' : t.status === 'doing' ? '◑' : '☐'
  const tags: string[] = []
  if (t.priority) tags.push(`!${t.priority}`)
  if (t.project) tags.push(`@${t.project}`)
  if (t.tags) tags.push(...t.tags.split(',').map((s) => `#${s.trim()}`).filter((s) => s.length > 1))
  if (t.source !== 'local') tags.push(`from:${t.source}`)
  if (t.carriedFrom && t.carriedFrom !== t.day) tags.push(`carried from ${t.carriedFrom}`)
  return `${box} [#${t.id}] ${t.text}${tags.length ? `  (${tags.join(', ')})` : ''}`
}

function toolTasksView(input: { day?: string }): string {
  const day = input.day || localDay()
  const todos = listTodos(day)
  const lines = [`Tickets for ${dayLabel(day)}:`]
  lines.push(...(todos.length ? todos.map((t) => '  ' + fmtTodo(t)) : ['  (none)']))
  const carry = unfinishedBefore(day)
  if (carry.length) {
    lines.push('', `Unfinished from earlier days (${carry.length}) — roll forward with task_carry_over:`)
    lines.push(...carry.slice(0, 12).map((t) => `  ${fmtTodo(t)}  [${t.day}]`))
    if (carry.length > 12) lines.push(`  …and ${carry.length - 12} more`)
  }
  return lines.join('\n')
}

function toolTaskAdd(input: {
  items: Array<{ text: string; priority?: string; project?: string; tags?: string }>
  day?: string
}): string {
  const day = input.day || localDay()
  const added = (input.items ?? [])
    .filter((i) => i?.text?.trim())
    .map((i) =>
      addTodo({ day, text: i.text.trim(), priority: i.priority ?? null, project: i.project ?? null, tags: i.tags ?? null })
    )
  if (!added.length) return 'No items given to add.'
  return `Added ${added.length} ticket(s) to ${dayLabel(day)}:\n${added.map((t) => '  ' + fmtTodo(t)).join('\n')}`
}

function toolTaskUpdate(input: {
  id: number
  status?: TodoStatus
  text?: string
  priority?: string
  project?: string
  tags?: string
  day?: string
}): string {
  const { id, ...patch } = input
  const updated = updateTodo(id, patch)
  if (!updated) return `No ticket with id #${id}.`
  return `Updated ticket #${id}:\n  ${fmtTodo(updated)}  [${updated.day}]`
}

function toolTaskRemove(input: { id: number }): string {
  removeTodo(input.id)
  return `Removed ticket #${input.id}.`
}

function toolTaskCarryOver(input: { day?: string }): string {
  const day = input.day || localDay()
  const n = carryOverTodos(day)
  if (!n) return `Nothing to carry over — no unfinished tickets before ${dayLabel(day)}.`
  return `Carried ${n} unfinished ticket(s) forward onto ${dayLabel(day)}.\n\n${toolTasksView({ day })}`
}

function fmtEvent(e: CalendarEvent): string {
  const when = e.starts ? `${e.starts}${e.ends ? `–${e.ends}` : ''}` : 'all-day'
  const src = e.source !== 'local' ? `  (from:${e.source})` : ''
  const notes = e.notes ? `\n      ${e.notes}` : ''
  return `${when}  [#${e.id}] ${e.title}${src}${notes}`
}

function toolCalendarView(input: { day?: string; days?: number }): string {
  const start = input.day || localDay()
  const span = Math.max(1, Math.min(31, Math.floor(input.days ?? 1)))
  if (span === 1) {
    const events = listEvents(start)
    return [`Calendar — ${dayLabel(start)}:`, ...(events.length ? events.map((e) => '  ' + fmtEvent(e)) : ['  (no events)'])].join('\n')
  }
  const end = localDay(new Date(new Date(`${start}T12:00:00`).getTime() + (span - 1) * 86400000))
  const events = listEventsRange(start, end)
  const lines = [`Calendar — ${start} to ${end}:`]
  if (!events.length) return [...lines, '  (no events)'].join('\n')
  let lastDay = ''
  for (const e of events) {
    if (e.day !== lastDay) {
      lines.push(`  ${dayLabel(e.day)}:`)
      lastDay = e.day
    }
    lines.push('    ' + fmtEvent(e))
  }
  return lines.join('\n')
}

function toolEventAdd(input: { title: string; day?: string; starts?: string; ends?: string; notes?: string }): string {
  if (!input.title?.trim()) return 'An event needs a title.'
  const day = input.day || localDay()
  const e = addEvent({
    day,
    title: input.title.trim(),
    starts: input.starts ?? null,
    ends: input.ends ?? null,
    notes: input.notes ?? null
  })
  return `Added to ${dayLabel(day)}:\n  ${fmtEvent(e)}`
}

function toolEventUpdate(input: {
  id: number
  title?: string
  day?: string
  starts?: string
  ends?: string
  notes?: string
}): string {
  const { id, ...patch } = input
  const e = updateEvent(id, patch)
  if (!e) return `No event with id #${id}.`
  return `Updated event #${id}:\n  ${dayLabel(e.day)}  —  ${fmtEvent(e)}`
}

function toolEventRemove(input: { id: number }): string {
  removeEvent(input.id)
  return `Removed event #${input.id}.`
}

/** One-call planning context: the day's tickets (incl. carry-over candidates) + events. */
function toolPlanMyDay(input: { day?: string }): string {
  const day = input.day || localDay()
  return [`Planning input for ${dayLabel(day)} — synthesise a focused plan from this:`, '', toolTasksView({ day }), '', toolCalendarView({ day })].join('\n')
}

const PANELS = ['pr_queue', 'briefing', 'calendar', 'projects', 'settings', 'terminal', 'rail']

/** Drive the face: ask the renderer to open a panel so the user sees it, not just reads it. */
function toolShowPanel(input: { panel?: string }, ctx?: ToolContext): string {
  const panel = String(input.panel ?? '')
  if (!PANELS.includes(panel)) return `Unknown panel '${panel}'. Valid panels: ${PANELS.join(', ')}.`
  if (!ctx?.emit) return 'Cannot open panels right now (no UI attached).'
  ctx.emit({ ui: { panel } })
  return panel === 'rail' ? 'Expanded the HUD rail for the user.' : `Opened the ${panel.replace('_', ' ')} panel for the user.`
}

/** Switch the active project (file-tool cwd) and highlight it in the UI. */
function toolSwitchProject(input: { project?: string }, ctx?: ToolContext): string {
  const q = String(input.project ?? '').trim().toLowerCase()
  if (!q) return 'Which project? Give a name or path.'
  const projects = listProjects()
  const match =
    projects.find((p) => p.path.toLowerCase() === q) ??
    projects.find((p) => p.name.toLowerCase() === q) ??
    projects.find((p) => p.name.toLowerCase().includes(q)) ??
    projects.find((p) => p.path.toLowerCase().includes(q))
  if (!match) return `No project matches '${input.project}'. Known projects: ${projects.map((p) => p.name).join(', ')}.`
  setActiveProjectPath(match.path)
  invalidateSystemCache() // the active project is baked into the system prompt
  ctx?.emit?.({ ui: { project: match.path } })
  return `Switched the active project to ${match.name} (${match.path}). Your file tools now operate there.`
}

/** A snapshot of the user's live desktop/OS context — a sense a terminal tool lacks. */
async function toolSystemContext(): Promise<string> {
  const lines: string[] = []
  lines.push(`Time: ${new Date().toString()}`)
  lines.push(`Machine: ${os.hostname()} (${process.platform}/${os.arch()}, ${Math.round(os.totalmem() / 1e9)}GB RAM)`)

  try {
    const active = getActiveProject()
    if (active) lines.push(`Active project: ${active.name} — ${active.path}`)
  } catch {
    /* registry not ready */
  }

  if (process.platform === 'darwin') {
    // Frontmost app — best effort; needs macOS Automation permission (prompts once).
    try {
      const app = (
        await execAsync(
          `osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true'`,
          { timeout: 4000 }
        )
      ).stdout.trim()
      if (app) lines.push(`Frontmost app: ${app}`)
    } catch {
      lines.push('Frontmost app: unavailable (needs macOS Automation permission)')
    }
    // Battery — no permission needed.
    try {
      const batt = (await execAsync('pmset -g batt', { timeout: 4000 })).stdout
      const pct = batt.match(/(\d+)%/)?.[1]
      const state = /AC Power/.test(batt) ? 'on AC' : /Battery Power/.test(batt) ? 'on battery' : ''
      if (pct) lines.push(`Battery: ${pct}%${state ? ` (${state})` : ''}`)
    } catch {
      /* not a laptop / pmset unavailable */
    }
  }

  lines.push(`Network: ${(await checkOnline()) ? 'online' : 'offline'}`)
  return lines.join('\n')
}

/** Cross-repo git overview of every registered project — the morning-review data. */
async function toolEcosystemStatus(): Promise<string> {
  const projects = listProjects()
  if (!projects.length) return 'No projects registered yet.'
  const activePath = activeProjectRoot()

  const rows = await Promise.all(
    projects.map(async (p) => {
      const run = async (cmd: string): Promise<string> => {
        try {
          return (await execAsync(cmd, { cwd: p.path, timeout: 10_000 })).stdout.trim()
        } catch {
          return ''
        }
      }
      const branch = (await run('git rev-parse --abbrev-ref HEAD')) || '(no git)'
      const status = await run('git status --porcelain')
      const changed = status ? status.split('\n').filter(Boolean) : []
      // Single-quote formats with spaces: the shell would otherwise split them into
      // separate args / treat parens as a subshell (→ empty result).
      const last = (await run("git log -1 --pretty=format:'%h %s (%cr)'")) || '(no commits)'
      const recent = (await run("git log --since='7 days ago' --oneline"))
        .split('\n')
        .filter(Boolean).length
      const ahead = (await run('git rev-list --count @{u}..HEAD')) || '0'
      const behind = (await run('git rev-list --count HEAD..@{u}')) || '0'
      const sync = ahead !== '0' || behind !== '0' ? ` [↑${ahead} ↓${behind}]` : ''
      const star = p.path === activePath ? ' ←active' : ''

      const lines = [
        `• ${p.name}${star} — ${branch}${sync}, ${changed.length} uncommitted file(s)`,
        `    last: ${last}`,
        `    activity: ${recent} commit(s) in last 7 days`
      ]
      if (changed.length) {
        // Strip the porcelain status prefix (e.g. " M ", "?? ") to bare paths.
        const files = changed.map((l) => l.slice(3))
        const shown = files.slice(0, 6).join(', ')
        lines.push(`    changed: ${shown}${files.length > 6 ? ` (+${files.length - 6} more)` : ''}`)
      }
      // Open PRs (incl. agent-created `artemis/…` branches) — current in-flight work.
      const gh = parseGitRemote(p.remote)
      if (gh) {
        const prJson = await run(
          `gh pr list --repo ${gh.slug} --state open --json number,title,headRefName --limit 10`
        )
        try {
          const prs = prJson ? (JSON.parse(prJson) as Array<{ number: number; title: string; headRefName: string }>) : []
          if (prs.length) {
            const list = prs
              .slice(0, 4)
              .map((pr) => `#${pr.number} ${pr.title}${pr.headRefName?.startsWith('artemis/') ? ' (agent)' : ''}`)
              .join('; ')
            lines.push(`    open PRs: ${prs.length} — ${list}${prs.length > 4 ? ' …' : ''}`)
          }
        } catch {
          /* gh unavailable or no access — skip */
        }
      }

      // Live analytics for each GA4 property configured on this project (read-only).
      // A monorepo can have several (e.g. Lumi + LumiLens), so loop and label each.
      const gaProps = getProjectGaProps(p.path)
      if (gaProps.length && hasGaCredentials()) {
        for (const prop of gaProps) {
          const tag = prop.label ? `${prop.label} — ` : ''
          try {
            lines.push(`    ${tag}${await gaSummary(prop.id)}`)
          } catch (err) {
            lines.push(`    ${tag}GA unavailable (${err instanceof Error ? err.message.slice(0, 70) : 'error'})`)
          }
        }
      }
      lines.push(`    ${p.path}`)
      return lines.join('\n')
    })
  )

  return `Ecosystem status — ${projects.length} project(s):\n\n${rows.join('\n\n')}`
}

// Optional execution context — lets a few tools reach back to the face (e.g. drive the
// UI). Most tools ignore it; the default is a no-op so existing callers/tests are unaffected.
export interface ToolContext {
  emit?: AgentEmit
}

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  ctx?: ToolContext
): Promise<string> {
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
    case 'ecosystem_status':
      return toolEcosystemStatus()
    case 'system_context':
      return toolSystemContext()
    case 'pr_queue':
      return toolPrQueue()
    case 'read_clipboard':
      return toolReadClipboard()
    case 'tasks_view':
      return toolTasksView(input as Parameters<typeof toolTasksView>[0])
    case 'task_add':
      return toolTaskAdd(input as Parameters<typeof toolTaskAdd>[0])
    case 'task_update':
      return toolTaskUpdate(input as Parameters<typeof toolTaskUpdate>[0])
    case 'task_remove':
      return toolTaskRemove(input as Parameters<typeof toolTaskRemove>[0])
    case 'task_carry_over':
      return toolTaskCarryOver(input as Parameters<typeof toolTaskCarryOver>[0])
    case 'calendar_view':
      return toolCalendarView(input as Parameters<typeof toolCalendarView>[0])
    case 'event_add':
      return toolEventAdd(input as Parameters<typeof toolEventAdd>[0])
    case 'event_update':
      return toolEventUpdate(input as Parameters<typeof toolEventUpdate>[0])
    case 'event_remove':
      return toolEventRemove(input as Parameters<typeof toolEventRemove>[0])
    case 'plan_my_day':
      return toolPlanMyDay(input as Parameters<typeof toolPlanMyDay>[0])
    case 'show_panel':
      return toolShowPanel(input as { panel?: string }, ctx)
    case 'switch_project':
      return toolSwitchProject(input as { project?: string }, ctx)
    case 'dispatch_worker':
      return toolDispatchWorker(input as Parameters<typeof toolDispatchWorker>[0])
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

// Trim a tool's output to a UI-friendly preview for the activity timeline. The model
// still receives the full (60k-clamped) result; this only bounds what crosses IPC and
// renders in an expandable row.
const TOOL_PREVIEW_CAP = 8000
function toolPreview(output: string): string {
  if (output.length <= TOOL_PREVIEW_CAP) return output
  return output.slice(0, TOOL_PREVIEW_CAP) + `\n…[${output.length - TOOL_PREVIEW_CAP} more chars]`
}

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

// Per-turn AbortControllers so the UI (Esc / Stop button) can interrupt an in-flight
// turn — aborting stops the model stream and the tool loop at the next boundary.
const abortControllers = new Map<string, AbortController>()
export function cancelTurn(requestId: string): void {
  abortControllers.get(requestId)?.abort()
}

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

// The user's answer to a prompt: deny, allow this once, or allow and remember it.
export type PermissionDecision = 'deny' | 'once' | 'always'

export interface PermissionAsker {
  (req: { toolName: string; input: unknown }): Promise<PermissionDecision>
}

// "Trusted" mode is session-only — auto-approve everything except the hard DANGEROUS
// blocklist, until the next restart. Held here (not persisted) so full trust can never
// silently carry across launches. The face toggles it via setSessionTrusted.
let sessionTrusted = false
export function setSessionTrusted(v: boolean): void {
  sessionTrusted = v
}
export function getSessionTrusted(): boolean {
  return sessionTrusted
}

// ─── Main agent loop ───────────────────────────────────────────────────────

// The agent loop's only link to the outside world: a transport that delivers stream
// events to the face. Today an Electron adapter forwards to the renderer; tomorrow a
// sidecar daemon swaps in a socket transport — the loop itself stays unchanged.
export type AgentEmit = (event: Record<string, unknown>) => void

export async function runAgent(
  emit: AgentEmit,
  requestId: string,
  prompt: string,
  askPermission: PermissionAsker,
  media?: { kind: 'image' | 'document'; mediaType: string; data: string }[]
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

  // Per-turn cancellation: the renderer (Esc / Stop) calls cancelTurn(requestId),
  // which aborts this controller — halting the model stream and the tool loop.
  const ac = new AbortController()
  abortControllers.set(requestId, ac)

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
    emit({ requestId, ...payload })
  }

  send({ state: 'thinking' })

  try {
    // The brain for this turn — Anthropic API, local Ollama, or (later) the
    // subscription CLI — chosen fresh from the backend preference. The loop below
    // is identical regardless of which one we got.
    // Snapshot history BEFORE persisting this turn's user message, then persist it
    // exactly once here (the renderer no longer commits it). Done before the model
    // client call so the message survives even if the client errors (e.g. no key).
    // buildMessages appends `prompt` to the snapshot, so the model sees the message a
    // single time — doing both (renderer-commit + buildMessages) caused the double-send.
    const history = loadRecentMessages(60)
    // Transcript is text-only; note attachments so the persisted turn isn't blank.
    appendMessage('user', prompt || (media?.length ? '[attachment]' : ''))

    const client = await getModelClient()
    const systemPrompt = await buildSystemPrompt()

    // Build the canonical message array: history + new user message.
    const localMessages: Anthropic.MessageParam[] = buildMessages(history, prompt)

    // Attach images/PDFs to the new (last) user turn as a multimodal content array, so a
    // vision-capable model can see them. Text-file attachments were already inlined
    // into `prompt` by the renderer.
    if (media?.length) {
      const lastMsg = localMessages[localMessages.length - 1]
      const textContent = typeof lastMsg.content === 'string' ? lastMsg.content : prompt
      const mediaBlocks: Anthropic.ContentBlockParam[] = media.map((m) =>
        m.kind === 'document'
          ? {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: m.data }
            }
          : {
              type: 'image',
              source: {
                type: 'base64',
                media_type: m.mediaType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
                data: m.data
              }
            }
      )
      lastMsg.content = [
        ...(textContent ? [{ type: 'text' as const, text: textContent }] : []),
        ...mediaBlocks
      ]
    }

    let accText = ''
    let turnCost = 0 // summed across every model call this turn (tool loop included)
    let cancelled = false

    // The agentic loop: stream response, execute tool calls, repeat until end_turn.
    while (true) {
      if (ac.signal.aborted) {
        cancelled = true
        break
      }
      send({ state: 'thinking' })

      const turnStream = client.stream({
        system: systemPrompt,
        messages: localMessages,
        tools: TOOLS,
        signal: ac.signal
      })

      // Stream text tokens to the renderer in real-time. If the turn is cancelled
      // mid-stream the iterator/finalMessage reject with an abort error — caught here,
      // where we keep whatever partial text already arrived.
      let final: ModelFinal
      try {
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
        final = await turnStream.final()
      } catch (streamErr) {
        if (ac.signal.aborted) {
          cancelled = true
          break
        }
        throw streamErr
      }
      turnCost += final.cost ?? 0

      // Add the assistant's full response (text + any tool_use blocks) to local context
      localMessages.push({ role: 'assistant', content: final.content })

      if (final.stopReason !== 'tool_use') break // done — exit the loop
      if (ac.signal.aborted) {
        cancelled = true
        break
      }

      // Execute tool calls
      send({ state: 'executing' })
      const toolResults: Anthropic.ToolResultBlockParam[] = []

      for (const block of final.content) {
        if (block.type !== 'tool_use') continue
        if (ac.signal.aborted) {
          cancelled = true
          break
        }

        const toolInput = block.input as Record<string, unknown>

        // Surface the call to the chat activity timeline before it runs.
        send({ tool: { id: block.id, phase: 'start', name: block.name, input: toolInput } })
        const endTool = (status: 'ok' | 'error' | 'denied', output: string) =>
          send({ tool: { id: block.id, phase: 'end', status, output: toolPreview(output) } })

        // Permission gate
        if (!AUTO_ALLOW.has(block.name)) {
          const bashCmd =
            block.name === 'Bash' && typeof toolInput.command === 'string' ? toolInput.command : null

          // Hard blocklist — refused in every mode, even "trusted".
          if (bashCmd && DANGEROUS.test(bashCmd)) {
            const content = 'Refused: destructive command blocked by Artemis.'
            endTool('denied', content)
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content, is_error: true })
            continue
          }

          // Decide whether this call may skip the prompt:
          //  · trusted (session) → everything but the blocklist above
          //  · smart → provably-safe read-only Bash commands
          //  · any mode → a Bash command the user previously blessed for this project
          const mode = getPermissionMode()
          const project = activeProjectRoot()
          const auto =
            sessionTrusted ||
            (bashCmd != null &&
              ((mode === 'smart' && isSafeReadOnly(bashCmd)) || isCommandAllowed(project, bashCmd)))

          if (!auto) {
            const decision = await askPermission({ toolName: block.name, input: toolInput })
            if (decision === 'deny') {
              endTool('denied', 'Denied by user.')
              toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: 'Denied by user.', is_error: true })
              continue
            }
            // "Allow & don't ask again" remembers the exact command for this project.
            if (decision === 'always' && bashCmd) allowCommand(project, bashCmd)
          }
        }

        // Execute
        try {
          const result = await executeTool(block.name, toolInput, { emit: send })
          endTool('ok', result)
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: clampToolOutput(result)
          })
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err)
          endTool('error', msg)
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

    // Turn complete (or cancelled) — strip the ⟦say⟧ marker and commit what we have.
    const { display, speech } = splitSpeech(accText.trim())
    const finalDisplay = cancelled
      ? display
        ? `${display}\n\n_⏹ Stopped._`
        : '_⏹ Stopped._'
      : display
    turn.done = finalDisplay
    turn.speech = cancelled ? '' : speech
    turn.claimed = true
    appendMessage('assistant', finalDisplay)
    saveTurn(turn)
    // On cancel, suppress the spoken line so Artemis doesn't talk after you stopped it.
    send({ done: finalDisplay, speech: cancelled ? '' : speech, state: 'idle', cost: turnCost })
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
  } finally {
    abortControllers.delete(requestId)
  }
}
