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
  setPrReviewed,
  clearReviewedPrs,
  listUnreadComments,
  markCommentsRead,
  setModel,
  setBackend,
  setWorkerModel,
  listAllTickets,
  listTicketsByProject,
  getProjectBoards,
  type ProjectTicket,
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
import { syncBoardForProject, syncPrOutcomes, createTicket, formatTicketBranch, addTicketComment, updateTicket, getTicketDetail } from './board'

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
  'tickets_view',
  'ticket_comments',
  'notifications_view',
  'tasks_view',
  'calendar_view',
  'plan_my_day',
  'show_panel',
  'switch_project',
  'app_control'
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
      "Read the PR Review Queue — pull requests that worker agents opened and that are awaiting the user's review/approval (project, title, branch, agent, reviewed status, link). Pass refresh:true to pull each pending PR's LIVE OUTCOME from GitHub — merge state, CI checks (pass/fail), and review decision — so you can see the fate of PRs you opened ('did my PRs land', 'what's the state of what I dispatched', 'anything failing CI'). Use for 'what PRs are waiting / what needs review / how did my fixes go'. Distinct from `ecosystem_status`, which lists live open PRs across all repos. Read-only.",
    input_schema: {
      type: 'object' as const,
      properties: {
        refresh: {
          type: 'boolean',
          description: 'Pull live merge/CI/review status from GitHub for each pending PR before reporting (a network call).'
        }
      },
      required: []
    }
  },
  {
    name: 'pr_review',
    description:
      "Act on the PR Review Queue: mark a PR reviewed (or not), or clear all reviewed rows. Identify the PR by its queue id — the #<id> shown by pr_queue. The queue is LOCAL (this is the human's approval flag, no GitHub effect). Gated WRITE. Use for 'mark PR 3 reviewed', 'clear the reviewed PRs'.",
    input_schema: {
      type: 'object' as const,
      properties: {
        id: { type: 'number', description: 'The PR queue id (the #<id> from pr_queue).' },
        reviewed: { type: 'boolean', description: 'Mark reviewed (true, default) or un-review (false).' },
        clearReviewed: { type: 'boolean', description: 'Instead of one PR, drop ALL reviewed rows from the queue.' }
      },
      required: []
    }
  },
  {
    name: 'notifications_view',
    description:
      "Read new (unread) comments across the watched GitHub Projects boards — the notifications feed (who commented, on which board/ticket, the text). Excludes your own comments. Use for 'any new comments', 'what did people say on the boards', 'catch me up'. Optional project filter. Reply with ticket_comment; clear with notifications_mark_read. Read-only.",
    input_schema: {
      type: 'object' as const,
      properties: {
        project: { type: 'string', description: 'Optional: only comments on this project\'s boards.' }
      },
      required: []
    }
  },
  {
    name: 'notifications_mark_read',
    description:
      "Mark board comments as read — advances the 'seen' watermark so the current comments stop showing as new (in the notifications feed + the rail card). Optional project filter (else all boards). Gated WRITE (local only). Use for 'mark all read', 'clear my notifications'.",
    input_schema: {
      type: 'object' as const,
      properties: {
        project: { type: 'string', description: 'Optional: only mark this project\'s board comments read.' }
      },
      required: []
    }
  },
  {
    name: 'app_control',
    description:
      "Drive app-level settings by voice/command: which MODEL runs turns ('use Opus', 'switch to Sonnet'), the WORKER MODEL that dispatched worker sub-agents run on ('run workers on Haiku' — keep it cheap; workers are the big credit sink), which BRAIN/BACKEND ('use the local model', 'go back to cloud'), and VOICE/TTS on or off ('stop talking', 'enable voice'). Model/worker-model/backend changes apply to the NEXT turn/dispatch. Does NOT change the permission posture — that gate stays a human-only, on-screen decision. (Read-only/benign — no permission prompt.)",
    input_schema: {
      type: 'object' as const,
      properties: {
        model: { type: 'string', enum: ['opus', 'sonnet'], description: 'Switch the chat model: opus (max capability, pricier) or sonnet (fast default).' },
        workerModel: { type: 'string', enum: ['haiku', 'sonnet', 'opus'], description: 'Set the model worker sub-agents run on (cheap by default — they loop many rounds).' },
        backend: { type: 'string', enum: ['anthropic', 'ollama'], description: 'Switch the brain: anthropic (metered cloud) or ollama (local).' },
        voice: { type: 'string', enum: ['on', 'off'], description: 'Turn spoken replies (TTS) on or off. "off" also stops any current speech.' }
      },
      required: []
    }
  },
  {
    name: 'tickets_view',
    description:
      "Read the GitHub Projects ticket boards — the ingest half of the ticket operator loop. Tickets are grouped BY BOARD (each registered project maps to one Projects v2 board, shown by its GitHub name e.g. Lumi/LumiLens), then by status column, and the output ends with a board-coverage summary (which projects have a board mapped, which don't). Each ticket shows #number, title, [repo], assignees, labels, and a worker-PR flag. IMPORTANT: a ticket's [repo] is where the issue LIVES on GitHub — it is NOT the board; one board can aggregate issues from several repos, so never infer board membership from the repo. Pass project to filter to one board, or refresh:true to re-sync from GitHub first (a network call). Use for 'what's on the boards / what should I work on'. To act on one, dispatch_worker with its ticketNumber. Read-only.",
    input_schema: {
      type: 'object' as const,
      properties: {
        project: { type: 'string', description: 'Optional: only this project (loose name match).' },
        refresh: { type: 'boolean', description: 'Re-sync the board(s) from GitHub before reporting.' }
      },
      required: []
    }
  },
  {
    name: 'ticket_comments',
    description:
      "Read ONE ticket's full discussion — its description AND the entire comment thread, pulled live from GitHub. tickets_view only has titles/status; this is how you get the CONTEXT teammates left in comments (often the real spec for a fix). Read this BEFORE dispatching a worker on a ticket whose details live in the comments. Identify by project + issue number (+ board if the number is ambiguous across the project's boards). Read-only.",
    input_schema: {
      type: 'object' as const,
      properties: {
        project: { type: 'string', description: 'The project the ticket is on (as in tickets_view).' },
        number: { type: 'number', description: 'The issue number (e.g. 7).' },
        board: { type: 'string', description: 'Which board the ticket is on (e.g. "Lumi"). Only needed if the number is ambiguous.' }
      },
      required: ['project', 'number']
    }
  },
  {
    name: 'ticket_create',
    description:
      'Create a GitHub issue, add it to the project\'s Projects v2 board, and optionally set its status column. This files a ticket on the board (the other end of the loop — e.g. "noticed a flaky test, file a ticket"). Outward-effecting WRITE on GitHub, so it is permission-gated like dispatch_worker. Requires the project to have a GitHub remote and a configured board.',
    input_schema: {
      type: 'object' as const,
      properties: {
        project: { type: 'string', description: 'The project name (as registered, e.g. "livana-scanner").' },
        board: { type: 'string', description: 'Which board to file it on, if the project has several (e.g. "Lumi"). Omit if it has one.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'Optional issue body / description.' },
        status: { type: 'string', description: 'Optional board status column to drop it into (e.g. "Todo").' }
      },
      required: ['project', 'title']
    }
  },
  {
    name: 'ticket_comment',
    description:
      "Post a comment (reply) on a board ticket — e.g. acknowledge a teammate's comment, note progress, or explain a decision. Outward-effecting WRITE on GitHub (the comment is public to the repo), so it is permission-gated. Identify the ticket by its project + issue number (from tickets_view). If the project has several boards and the same number exists on more than one, pass `board` to say which.",
    input_schema: {
      type: 'object' as const,
      properties: {
        project: { type: 'string', description: 'The project the ticket is on (as in tickets_view).' },
        number: { type: 'number', description: 'The issue number (e.g. 11).' },
        body: { type: 'string', description: 'The comment text (markdown allowed).' },
        board: { type: 'string', description: 'Which board the ticket is on (e.g. "Lumi"). Required only when the number is ambiguous across the project\'s boards.' }
      },
      required: ['project', 'number', 'body']
    }
  },
  {
    name: 'ticket_update',
    description:
      "Update a board ticket: move its Status column and/or close/reopen it — e.g. 'move #11 to In Progress', 'close #7'. Outward-effecting WRITE on GitHub, permission-gated. Identify the ticket by project + issue number (from tickets_view). status must match one of that board's columns. If the same number exists on more than one of the project's boards, pass `board` to say which.",
    input_schema: {
      type: 'object' as const,
      properties: {
        project: { type: 'string', description: 'The project the ticket is on.' },
        number: { type: 'number', description: 'The issue number.' },
        status: { type: 'string', description: 'Optional: the Status column to move it to (must match a board column).' },
        state: { type: 'string', enum: ['open', 'closed'], description: 'Optional: close or reopen the issue.' },
        board: { type: 'string', description: 'Which board the ticket is on (e.g. "Lumi"). Required only when the number is ambiguous across the project\'s boards.' }
      },
      required: ['project', 'number']
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
      "Drive your own interface: open or focus a panel so the user SEES it, not just reads a description of it. Use for 'show me the PR queue', 'open my calendar', 'pull up my tasks', 'open settings'. For the ticket board you can also pass `board` to filter to one board ('open the Lumi board' → panel:'board', board:'Lumi'), AND `ticket` (an issue number) to open straight into that ticket's detail view ('open ticket 5 on the Lumi board' → panel:'board', board:'Lumi', ticket:5). For panel='tasks' or 'calendar' you can pass `day` (YYYY-MM-DD) to open focused on that day ('show my tasks for tomorrow'). After you add/move/delete a task or event via the task_*/event_* tools, opening 'tasks'/'calendar' is a good way to let the user SEE the change. You can still summarise alongside opening it. (briefing = the ecosystem-status card.)",
    input_schema: {
      type: 'object' as const,
      properties: {
        panel: {
          type: 'string',
          enum: ['pr_queue', 'board', 'tasks', 'calendar', 'notifications', 'briefing', 'projects', 'settings', 'terminal', 'rail'],
          description: 'Which panel to open. "tasks" = the day-planner tasks modal; "notifications" = new board comments; "board" = the cross-repo ticket board; "rail" expands the left HUD rail.'
        },
        board: { type: 'string', description: 'For panel="board": the board name to open it filtered to (e.g. "Lumi", "LumiLens").' },
        ticket: { type: 'number', description: 'For panel="board": an issue number to open straight into its detail view. Pass `board` too if the number is ambiguous across boards.' },
        day: { type: 'string', description: 'For panel="tasks" or "calendar": a YYYY-MM-DD day to open focused on (default today).' }
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
      'Dispatch an autonomous worker agent to FIX an issue in one of the registered projects. The worker runs in an isolated git worktree, makes the change on a new branch, runs the repo checks, and opens a PR (it NEVER pushes to main) — the PR is logged to the review queue for the user to approve. Use this for concrete fix-it tasks across the ecosystem, not for questions. Requires the project to have a GitHub remote. When dispatching FROM a board ticket, pass its ticketNumber so the PR is branched `artemis/ticket-<n>` and includes `Closes #<n>` — GitHub then wires the ticket↔PR↔board together and moves the ticket to Done on merge.',
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
        title: { type: 'string', description: 'Optional PR title (defaults to the task)' },
        ticketNumber: {
          type: 'number',
          description: 'If this fix is for a board ticket, its issue number — links the PR back to the ticket.'
        },
        ticketUrl: { type: 'string', description: 'Optional: the ticket URL, for the PR body.' }
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
  ticketNumber?: number
  ticketUrl?: string
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
    label: 'worker',
    ticketNumber: input.ticketNumber,
    ticketUrl: input.ticketUrl
  })
  const linked = input.ticketNumber != null ? ` Linked to ticket #${input.ticketNumber} (Closes #${input.ticketNumber}).` : ''
  return result.ok
    ? `Opened a PR for "${match.name}": ${result.url} (branch ${result.branch}).${linked} It's in the review queue for your approval.`
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

/** A compact, human-readable outcome line for a PR (merge state + CI + reviews). */
function fmtPrOutcome(p: { state: string | null; checks: string | null; reviewDecision: string | null }): string {
  const bits: string[] = []
  if (p.state) bits.push(p.state === 'merged' ? '⛙ merged' : p.state === 'closed' ? '✕ closed' : 'open')
  if (p.checks && p.checks !== 'none') {
    bits.push(p.checks === 'success' ? 'CI ✓' : p.checks === 'failure' ? 'CI ✗' : 'CI …')
  }
  if (p.reviewDecision && p.reviewDecision !== 'none') {
    bits.push(
      p.reviewDecision === 'approved'
        ? 'approved'
        : p.reviewDecision === 'changes_requested'
          ? 'changes requested'
          : 'review required'
    )
  }
  return bits.join(' · ')
}

/** Read the local PR Review Queue — worker-agent PRs awaiting the user's approval. With
 *  refresh, pulls each pending PR's live outcome (merge/CI/review) from GitHub first. */
async function toolPrQueue(input: { refresh?: boolean }): Promise<string> {
  if (input?.refresh) {
    try {
      await syncPrOutcomes()
    } catch {
      /* network/gh hiccup — fall back to last-known outcomes */
    }
  }
  const prs = listPrReviews()
  if (!prs.length) {
    return 'The PR Review Queue is empty — no agent-opened PRs are awaiting review. (For live open PRs on GitHub across all repos, use ecosystem_status.)'
  }
  const pending = prs.filter((p) => !p.reviewed).length
  const rows = prs.map((p) => {
    const head = `${p.reviewed ? '✓ reviewed' : '• awaiting review'} — [#${p.id} · ${p.project}] ${p.title}`
    const outcome = fmtPrOutcome(p)
    const meta = [p.branch ? `branch ${p.branch}` : '', p.agent ? `by ${p.agent}` : '', outcome]
      .filter(Boolean)
      .join(', ')
    return `${head}${meta ? `\n    ${meta}` : ''}\n    ${p.url}`
  })
  const hint = prs.some((p) => p.outcomeSyncedAt == null)
    ? '\n\n(Outcomes not yet pulled — call again with refresh:true for live merge/CI/review status.)'
    : ''
  return `PR Review Queue — ${prs.length} total, ${pending} awaiting review:\n\n${rows.join('\n\n')}${hint}`
}

/** Mark a PR in the review queue reviewed/unreviewed, or clear all reviewed rows. The queue is
 *  LOCAL (no GitHub effect) — this just moves the human's approval flag. Gated all the same. */
function toolPrReview(input: { id?: number; reviewed?: boolean; clearReviewed?: boolean }): string {
  if (input.clearReviewed) {
    clearReviewedPrs()
    return 'Cleared all reviewed PRs from the queue.'
  }
  if (typeof input.id !== 'number') return 'Pass the PR queue id (the #<id> from pr_queue), or clearReviewed:true.'
  const match = listPrReviews().find((p) => p.id === input.id)
  if (!match) return `No PR with queue id #${input.id}. Run pr_queue to see ids.`
  const reviewed = input.reviewed !== false // default true
  setPrReviewed(input.id, reviewed)
  return `Marked PR #${input.id} ([${match.project}] ${match.title}) ${reviewed ? 'reviewed' : 'not reviewed'}.`
}

/** New (unread) comments across watched boards — the notifications feed, read-only. */
function toolNotificationsView(input: { project?: string }): string {
  let notifs = listUnreadComments()
  const filter = input?.project?.trim().toLowerCase()
  if (filter) notifs = notifs.filter((n) => n.project.toLowerCase().includes(filter))
  if (!notifs.length) {
    return filter ? `No new comments on "${input!.project}" boards.` : 'No new comments on any watched board.'
  }
  const rows = notifs.map((n) => {
    const where = `${n.boardTitle ? `${n.boardTitle} ` : ''}#${n.issueNumber ?? '?'}`
    return `• ${n.author} on ${where} — ${n.ticketTitle}\n    "${n.body.replace(/\s+/g, ' ').slice(0, 240)}"`
  })
  return `${notifs.length} new comment(s) on your boards:\n\n${rows.join('\n\n')}\n\nReply with ticket_comment, or mark them read with notifications_mark_read.`
}

/** Advance the "seen" watermark so current board comments stop showing as new. */
function toolNotificationsMarkRead(input: { project?: string }): string {
  const before = listUnreadComments().length
  markCommentsRead(input?.project)
  const after = listUnreadComments().length
  return `Marked ${Math.max(0, before - after)} comment(s) read${input?.project ? ` on "${input.project}" boards` : ''}.`
}

/** Drive app-level settings by voice: which model/brain runs turns, and voice (TTS) on/off.
 *  Model/backend are stored prefs read fresh each turn (so they apply to the NEXT turn). Voice
 *  is a renderer toggle, driven via a UI control event. Deliberately does NOT touch the
 *  permission posture (that gate must stay a human-only, on-screen decision). */
function toolAppControl(
  input: {
    model?: 'opus' | 'sonnet'
    backend?: 'anthropic' | 'ollama'
    voice?: 'on' | 'off'
    workerModel?: 'haiku' | 'sonnet' | 'opus'
  },
  ctx?: ToolContext
): string {
  const done: string[] = []
  if (input.model === 'opus' || input.model === 'sonnet') {
    const id = input.model === 'opus' ? 'claude-opus-4-8' : 'claude-sonnet-4-6'
    setModel(id)
    ctx?.emit?.({ ui: { control: 'model', value: id } }) // keep the titlebar toggle in sync
    done.push(`model → ${input.model} (takes effect next turn)`)
  }
  if (input.workerModel === 'haiku' || input.workerModel === 'sonnet' || input.workerModel === 'opus') {
    const id = input.workerModel === 'opus' ? 'claude-opus-4-8' : input.workerModel === 'haiku' ? 'claude-haiku-4-5-20251001' : 'claude-sonnet-4-6'
    setWorkerModel(id)
    done.push(`worker model → ${input.workerModel} (next dispatch)`)
  }
  if (input.backend === 'anthropic' || input.backend === 'ollama') {
    setBackend(input.backend)
    ctx?.emit?.({ ui: { control: 'backend', value: input.backend } })
    done.push(`brain → ${input.backend === 'ollama' ? 'local (Ollama)' : 'cloud (Anthropic)'} (next turn)`)
  }
  if ((input.voice === 'on' || input.voice === 'off') && ctx?.emit) {
    ctx.emit({ ui: { control: 'voice', value: input.voice } })
    done.push(`voice ${input.voice}`)
  }
  if (!done.length) return 'Nothing to change — pass model ("opus"/"sonnet"), workerModel ("haiku"/"sonnet"/"opus"), backend ("anthropic"/"ollama"), and/or voice ("on"/"off").'
  return `Done: ${done.join(', ')}.`
}

// ─── GitHub Projects ticket board (the ticket operator loop) ────────────────

/** A board ticket as one line — status, repo #number, title, assignees/labels, PR flag. */
function fmtTicket(t: ProjectTicket, hasPr: boolean): string {
  const num = t.issueNumber != null ? `#${t.issueNumber}` : '(draft)'
  const tags: string[] = []
  if (t.assignees) tags.push(`@${t.assignees.split(',')[0].trim()}${t.assignees.includes(',') ? '…' : ''}`)
  if (t.labels) tags.push(...t.labels.split(',').slice(0, 3).map((l) => `#${l.trim()}`))
  if (hasPr) tags.push('▸ PR open')
  return `  ${num} ${t.title}${t.repo ? `  [${t.repo}]` : ''}${tags.length ? `  (${tags.join(', ')})` : ''}`
}

/** Does a worker PR already exist for this ticket? (local join on the artemis/ticket-<n> branch) */
function ticketHasPr(t: ProjectTicket, prBranches: Array<string | null>): boolean {
  if (t.issueNumber == null) return false
  const stable = formatTicketBranch(t.issueNumber)
  return prBranches.some((b) => b === stable || (b?.startsWith(stable + '-') ?? false))
}

/** Order status columns actionable-first, Done last, for a readable board dump. */
function ticketStatusRank(s: string): number {
  const l = s.toLowerCase()
  if (l.includes('progress')) return 0
  if (l === 'todo' || l === 'to do') return 1
  if (l.includes('triage')) return 2
  if (l === 'done') return 9
  return 5
}

async function toolTicketsView(input: { project?: string; refresh?: boolean }): Promise<string> {
  const projects = listProjects()
  // Resolve an optional project filter (loose match), and which projects to refresh.
  const filter = input?.project?.trim().toLowerCase()
  const matched = filter
    ? projects.filter((p) => p.name.toLowerCase().includes(filter) || p.path.toLowerCase().includes(filter))
    : projects
  if (input?.refresh) {
    const withBoards = matched.filter((p) => getProjectBoards(p.path).length > 0)
    if (!withBoards.length) {
      return 'No GitHub Projects board is configured for the matching project(s). Set one up in Settings → Connections (owner, org/user, and the project number).'
    }
    for (const p of withBoards) {
      try {
        await syncBoardForProject(p.name, p.path)
      } catch (e: unknown) {
        return `Could not sync the board for "${p.name}": ${e instanceof Error ? e.message : String(e)}`
      }
    }
  }
  const tickets = filter ? matched.flatMap((p) => listTicketsByProject(p.name)) : listAllTickets()
  const prBranches = listPrReviews().map((p) => p.branch)

  // Group by BOARD (its GitHub title), NOT by project — a project can map to SEVERAL boards
  // (e.g. livana-scanner → Lumi + LumiLens), each its own column set, and each can hold a
  // ticket with the same issue number as another board. Collapsing them under the project
  // would hide that a "#5" exists on two distinct boards (the trap that misrouted a comment).
  // Key on boardTitle+project so identically-named boards across projects stay separate.
  const byBoard = new Map<string, { project: string; boardTitle: string; tickets: ProjectTicket[] }>()
  for (const t of tickets) {
    const boardTitle = t.boardTitle || t.project
    const key = `${t.project} ${boardTitle}`
    if (!byBoard.has(key)) byBoard.set(key, { project: t.project, boardTitle, tickets: [] })
    byBoard.get(key)!.tickets.push(t)
  }

  const lines: string[] = []
  if (!tickets.length) {
    lines.push(filter ? `No tickets cached for "${input!.project}".` : 'No tickets cached on any board yet.')
  } else {
    lines.push(`Ticket board — ${tickets.length} ticket(s) across ${byBoard.size} board(s):`)
    for (const { project, boardTitle, tickets: ts } of byBoard.values()) {
      lines.push('', `▸ ${boardTitle} board  (project: ${project}) — ${ts.length} ticket(s)`)
      const byStatus = new Map<string, ProjectTicket[]>()
      for (const t of ts) {
        const k = t.status || 'No status'
        if (!byStatus.has(k)) byStatus.set(k, [])
        byStatus.get(k)!.push(t)
      }
      for (const [status, sts] of [...byStatus].sort((a, b) => ticketStatusRank(a[0]) - ticketStatusRank(b[0]))) {
        lines.push(`   ${status} (${sts.length}):`)
        lines.push(...sts.map((t) => '  ' + fmtTicket(t, ticketHasPr(t, prBranches))))
      }
    }
  }

  // Board coverage — make the full picture explicit so gaps aren't mistaken for bugs.
  const configured = projects.filter((p) => getProjectBoards(p.path).length > 0)
  const unconfigured = projects.filter((p) => getProjectBoards(p.path).length === 0)
  lines.push(
    '',
    `Boards configured (${configured.reduce((n, p) => n + getProjectBoards(p.path).length, 0)}): ${
      configured
        .flatMap((p) => getProjectBoards(p.path).map((b) => `${b.title || `#${b.number}`} → ${p.name}${b.subdir ? `/${b.subdir}` : ''}`))
        .join('; ') || '(none)'
    }.`
  )
  if (unconfigured.length) {
    lines.push(`No board mapped: ${unconfigured.map((p) => p.name).join(', ')} — expected; these surface no tickets unless you map a board.`)
  }
  lines.push(
    '',
    'Note: a ticket\'s [repo] is where the issue LIVES on GitHub; its board is the Projects v2 board it\'s tracked on — a single board can aggregate issues from several repos, so [repo] ≠ board.',
    'IMPORTANT: the same issue number can exist on more than one board of a project (e.g. Lumi #5 and LumiLens #5 are DIFFERENT tickets). When you comment/update/open/dispatch, pass `board` (the board name above) so you act on the right one — if you omit it and the number is ambiguous, the tool will refuse and ask you to specify.',
    'To act on a ticket, dispatch_worker with its number as ticketNumber (the PR will Closes #n).'
  )
  return lines.join('\n')
}

async function toolTicketCreate(input: {
  project: string
  board?: string
  title: string
  body?: string
  status?: string
}): Promise<string> {
  const projects = listProjects()
  const match = projects.find((p) => p.name.toLowerCase() === input.project.trim().toLowerCase())
  if (!match) {
    return `No project named "${input.project}". Registered: ${projects.map((p) => p.name).join(', ') || '(none)'}.`
  }
  if (!match.remote) return `Project "${match.name}" has no GitHub remote — cannot create an issue.`
  // Which board to file onto — a project can map to several (e.g. Lumi + LumiLens).
  const boards = getProjectBoards(match.path)
  const q = input.board?.trim().toLowerCase()
  const board =
    (q ? boards.find((b) => (b.title ?? '').toLowerCase() === q || String(b.number) === q) : undefined) ??
    (boards.length === 1 ? boards[0] : null)
  if (!board && boards.length > 1) {
    return `"${match.name}" has multiple boards — say which: ${boards.map((b) => b.title || `#${b.number}`).join(', ')}.`
  }
  try {
    const res = await createTicket({
      projectName: match.name,
      projectPath: match.path,
      remote: match.remote,
      board,
      title: input.title,
      body: input.body,
      status: input.status
    })
    if (res.onBoard) {
      return `Created issue #${res.number} in "${match.name}" and added it to the board${res.statusSet ? ` (status: ${res.statusSet})` : ''}: ${res.url}`
    }
    // The issue exists but no board was reachable — be explicit so it isn't mistaken for "on the board".
    return (
      `Created issue #${res.number} in "${match.name}": ${res.url}\n` +
      `Note: "${match.name}" has no GitHub Projects board mapped, so the issue was NOT added to a board` +
      `${input.status ? ' and its status column was not set' : ''}. Map one in Settings → Connections, then it appears on the board.`
    )
  } catch (e: unknown) {
    return `Could not create the ticket: ${e instanceof Error ? e.message : String(e)}`
  }
}

/** Resolve a ticket from the cache by project + issue number → its repo, board item id, and
 *  the board it's on (for status moves). A board ticket's issue can live in another repo. */
function resolveTicketTarget(
  project: string,
  number: number,
  board?: string
): {
  match: ReturnType<typeof listProjects>[number]
  repo: string | null
  itemId?: string
  board: ReturnType<typeof getProjectBoards>[number] | null
  boardTitle: string | null
} | string {
  const projects = listProjects()
  const match = projects.find((p) => p.name.toLowerCase() === project.trim().toLowerCase())
  if (!match) return `No project named "${project}". Registered: ${projects.map((p) => p.name).join(', ') || '(none)'}.`

  // All cached tickets with this issue number — there may be MORE THAN ONE across the project's
  // boards (Lumi #5 vs LumiLens #5 are different GitHub issues). Disambiguate by board name.
  let candidates = listTicketsByProject(match.name).filter((t) => t.issueNumber === number)
  if (board) {
    const want = board.trim().toLowerCase()
    candidates = candidates.filter((t) => (t.boardTitle ?? '').toLowerCase() === want)
    if (!candidates.length) {
      const boards = [...new Set(listTicketsByProject(match.name).filter((t) => t.issueNumber === number).map((t) => t.boardTitle).filter(Boolean))]
      return `No #${number} on the "${board}" board in "${match.name}".${boards.length ? ` It exists on: ${boards.join(', ')}.` : ''}`
    }
  } else {
    const distinctBoards = [...new Set(candidates.map((t) => t.boardTitle).filter(Boolean))]
    if (distinctBoards.length > 1) {
      return `#${number} exists on multiple boards in "${match.name}": ${distinctBoards.join(', ')}. Pass board:"…" to say which one.`
    }
  }

  const cached = candidates[0]
  const repo = cached?.repo || parseGitRemote(match.remote)?.slug || null
  if (!repo) return `Couldn't resolve a GitHub repo for #${number} in "${match.name}".`
  const boards = getProjectBoards(match.path)
  const boardCfg = boards.find((b) => b.boardId && b.boardId === cached?.boardId) ?? (boards.length === 1 ? boards[0] : null)
  return { match, repo, itemId: cached?.itemId, board: boardCfg, boardTitle: cached?.boardTitle ?? boardCfg?.title ?? null }
}

/** Read a ticket's FULL discussion — description + the whole comment thread, live from GitHub.
 *  The board cache only holds titles/status, so this is how you get the *context* a teammate left
 *  in comments (often the real spec for a fix). Read-only. */
async function toolTicketComments(input: { project: string; number: number; board?: string }): Promise<string> {
  const r = resolveTicketTarget(input.project, input.number, input.board)
  if (typeof r === 'string') return r
  let detail: Awaited<ReturnType<typeof getTicketDetail>>
  try {
    detail = await getTicketDetail(r.repo!, input.number)
  } catch (e: unknown) {
    return `Could not read #${input.number}: ${e instanceof Error ? e.message : String(e)}`
  }
  const where = r.boardTitle ? ` · ${r.boardTitle} board` : ''
  const lines: string[] = [`#${detail.number} ${detail.title} (${detail.state}${where} · ${r.repo})`]
  const body = (detail.body ?? '').trim()
  lines.push('', 'DESCRIPTION:', body ? body : '(no description)')
  lines.push('', `COMMENTS (${detail.comments.length}):`)
  if (!detail.comments.length) lines.push('  (none yet)')
  for (const c of detail.comments) {
    const when = c.createdAt ? ` · ${c.createdAt.slice(0, 10)}` : ''
    lines.push('', `${c.author}${when}${c.viewerDidAuthor ? ' (you)' : ''}:`, c.body.trim() || '(empty)')
  }
  return lines.join('\n')
}

async function toolTicketComment(input: { project: string; number: number; body: string; board?: string }): Promise<string> {
  const r = resolveTicketTarget(input.project, input.number, input.board)
  if (typeof r === 'string') return r
  try {
    await addTicketComment(r.repo!, input.number, input.body)
    const where = r.boardTitle ? `on the "${r.boardTitle}" board ` : ''
    return `Commented on #${input.number} ${where}(${r.repo}).`
  } catch (e: unknown) {
    return `Could not post the comment: ${e instanceof Error ? e.message : String(e)}`
  }
}

async function toolTicketUpdate(input: {
  project: string
  number: number
  status?: string
  state?: 'open' | 'closed'
  board?: string
}): Promise<string> {
  if (!input.status && !input.state) return 'Nothing to update — pass a status and/or state.'
  const r = resolveTicketTarget(input.project, input.number, input.board)
  if (typeof r === 'string') return r
  try {
    await updateTicket({
      projectName: r.match.name,
      projectPath: r.match.path,
      repo: r.repo,
      board: r.board,
      number: input.number,
      itemId: r.itemId,
      patch: { status: input.status, state: input.state }
    })
    const done = [input.status ? `status → ${input.status}` : '', input.state ? (input.state === 'closed' ? 'closed' : 'reopened') : '']
      .filter(Boolean)
      .join(', ')
    const where = r.boardTitle ? ` on the "${r.boardTitle}" board` : ''
    return `Updated #${input.number} (${r.repo})${where}: ${done}.`
  } catch (e: unknown) {
    return `Could not update the ticket: ${e instanceof Error ? e.message : String(e)}`
  }
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

const PANELS = ['pr_queue', 'board', 'tasks', 'calendar', 'notifications', 'briefing', 'projects', 'settings', 'terminal', 'rail']

/** Drive the face: ask the renderer to open a panel so the user sees it, not just reads it. */
function toolShowPanel(input: { panel?: string; board?: string; project?: string; ticket?: number; day?: string }, ctx?: ToolContext): string {
  const panel = String(input.panel ?? '')
  if (!PANELS.includes(panel)) return `Unknown panel '${panel}'. Valid panels: ${PANELS.join(', ')}.`
  if (!ctx?.emit) return 'Cannot open panels right now (no UI attached).'

  // Day-focused surfaces: open the tasks / calendar modal on a specific day.
  if (panel === 'tasks' || panel === 'calendar') {
    const day = input.day && /^\d{4}-\d{2}-\d{2}$/.test(input.day) ? input.day : undefined
    ctx.emit({ ui: { panel, ...(day ? { day } : {}) } })
    return `Opened the ${panel} panel${day ? ` on ${day}` : ''} for the user.`
  }

  if (panel === 'board') {
    let board = input.board ? String(input.board) : undefined
    const num = typeof input.ticket === 'number' ? input.ticket : undefined
    if (num != null) {
      // Resolve the ticket in the cache so we open the RIGHT board for it (and catch the
      // "same number on two boards" trap) rather than trusting a guessed board name.
      const projects = listProjects()
      const scope = input.project
        ? projects.filter((p) => p.name.toLowerCase() === input.project!.trim().toLowerCase())
        : projects
      let hits = scope.flatMap((p) => listTicketsByProject(p.name)).filter((t) => t.issueNumber === num)
      if (board) hits = hits.filter((t) => (t.boardTitle ?? '').toLowerCase() === board!.toLowerCase())
      const distinctBoards = [...new Set(hits.map((t) => t.boardTitle ?? t.project))]
      if (!hits.length) {
        return `No cached ticket #${num}${board ? ` on the "${board}" board` : ''}. Run tickets_view (refresh:true) first, or check the number/board.`
      }
      if (distinctBoards.length > 1) {
        return `#${num} exists on multiple boards: ${distinctBoards.join(', ')}. Pass board:"…" so I open the right one.`
      }
      board = hits[0].boardTitle ?? board
      ctx.emit({ ui: { panel, ...(board ? { board } : {}), ticket: num } })
      return `Opened ticket #${num}${board ? ` on the "${board}" board` : ''} for the user.`
    }
    ctx.emit({ ui: { panel, ...(board ? { board } : {}) } })
    return board ? `Opened the board filtered to "${board}" for the user.` : 'Opened the ticket board for the user.'
  }

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
      // If the project is a monorepo subdirectory, scope file-level metrics to it via the
      // `.` pathspec (resolves to cwd) so a workspace reports its own status, not the whole
      // repo. Empty prefix = the project IS the repo root, where `.` is the whole repo anyway.
      const prefix = (await run('git rev-parse --show-prefix')).trim()
      const status = await run('git status --porcelain .')
      const changed = status ? status.split('\n').filter(Boolean) : []
      // Single-quote formats with spaces: the shell would otherwise split them into
      // separate args / treat parens as a subshell (→ empty result).
      const last = (await run("git log -1 --pretty=format:'%h %s (%cr)' -- .")) || '(no commits)'
      const recent = (await run("git log --since='7 days ago' --oneline -- ."))
        .split('\n')
        .filter(Boolean).length
      const ahead = (await run('git rev-list --count @{u}..HEAD')) || '0'
      const behind = (await run('git rev-list --count HEAD..@{u}')) || '0'
      const sync = ahead !== '0' || behind !== '0' ? ` [↑${ahead} ↓${behind}]` : ''
      const star = p.path === activePath ? ' ←active' : ''
      const ws = prefix ? ` ⟂${prefix.replace(/\/$/, '')}` : '' // workspace marker for a subdir project

      const lines = [
        `• ${p.name}${ws}${star} — ${branch}${sync}, ${changed.length} uncommitted file(s)`,
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
      return toolPrQueue(input as Parameters<typeof toolPrQueue>[0])
    case 'pr_review':
      return toolPrReview(input as Parameters<typeof toolPrReview>[0])
    case 'notifications_view':
      return toolNotificationsView(input as Parameters<typeof toolNotificationsView>[0])
    case 'notifications_mark_read':
      return toolNotificationsMarkRead(input as Parameters<typeof toolNotificationsMarkRead>[0])
    case 'app_control':
      return toolAppControl(input as Parameters<typeof toolAppControl>[0], ctx)
    case 'tickets_view':
      return toolTicketsView(input as Parameters<typeof toolTicketsView>[0])
    case 'ticket_comments':
      return toolTicketComments(input as Parameters<typeof toolTicketComments>[0])
    case 'ticket_create':
      return toolTicketCreate(input as Parameters<typeof toolTicketCreate>[0])
    case 'ticket_comment':
      return toolTicketComment(input as Parameters<typeof toolTicketComment>[0])
    case 'ticket_update':
      return toolTicketUpdate(input as Parameters<typeof toolTicketUpdate>[0])
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
      return toolShowPanel(input as { panel?: string; board?: string; project?: string; ticket?: number; day?: string }, ctx)
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
