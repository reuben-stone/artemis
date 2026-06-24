import type Anthropic from '@anthropic-ai/sdk'
import { promises as fs } from 'fs'
import { resolve, dirname, join } from 'path'
import os from 'os'
import { exec } from 'child_process'
import { promisify } from 'util'
import { glob } from 'glob'
import { getModelClient } from './model'
import { addPrReview } from './store'
import { parseGitRemote } from './github'
import { DANGEROUS, clampToolOutput } from './safety'

const execp = promisify(exec)

/**
 * Worker-agent PR producer (the human-approval autonomy loop).
 *
 * Given a task + a target repo, a worker:
 *   1. creates a throwaway git WORKTREE on a new `artemis/…` branch (no collision
 *      with the user's working copy; parallel-safe),
 *   2. runs a focused sub-agent (Read/Write/Edit/Glob/Bash, scoped to the worktree)
 *      to make the change,
 *   3. best-effort runs the repo's own checks,
 *   4. commits, pushes the branch, and opens a PR via `gh` — NEVER pushes to main,
 *   5. logs the PR to the review queue, and
 *   6. always removes the worktree.
 *
 * Decisions: see ROADMAP-TO-JARVIS.md (Phase 6) and the use-case memory.
 */

export interface WorkerSpec {
  projectName: string
  projectPath: string
  remote: string | null
  task: string
  /** PR title (defaults to a trimmed task). */
  title?: string
  /** Label shown in the review queue (e.g. "worker-1"). */
  label?: string
}

export interface WorkerResult {
  ok: boolean
  url?: string
  branch?: string
  error?: string
}

const MAX_ROUNDS = 30 // runaway guard for the worker's tool loop

const WORKER_TOOLS: Anthropic.Tool[] = [
  {
    name: 'Read',
    description: 'Read a file (absolute path under the worktree). Returns numbered lines.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        offset: { type: 'number' },
        limit: { type: 'number' }
      },
      required: ['file_path']
    }
  },
  {
    name: 'Write',
    description: 'Write/overwrite a file (absolute path under the worktree).',
    input_schema: {
      type: 'object',
      properties: { file_path: { type: 'string' }, content: { type: 'string' } },
      required: ['file_path', 'content']
    }
  },
  {
    name: 'Edit',
    description: 'Replace an exact string in a file. old_string must match exactly.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
        replace_all: { type: 'boolean' }
      },
      required: ['file_path', 'old_string', 'new_string']
    }
  },
  {
    name: 'Glob',
    description: 'Find files matching a glob within the worktree (node_modules etc. ignored).',
    input_schema: {
      type: 'object',
      properties: { pattern: { type: 'string' } },
      required: ['pattern']
    }
  },
  {
    name: 'Bash',
    description:
      'Run a shell command in the worktree (build, grep, find, test). Destructive commands are blocked. Do NOT run git commit/push — the orchestrator handles git.',
    input_schema: {
      type: 'object',
      properties: { command: { type: 'string' }, timeout: { type: 'number' } },
      required: ['command']
    }
  }
]

async function executeWorkerTool(
  name: string,
  input: Record<string, unknown>,
  root: string
): Promise<string> {
  switch (name) {
    case 'Read': {
      const content = await fs.readFile(input.file_path as string, 'utf8')
      const lines = content.split('\n')
      const start = Math.max(0, ((input.offset as number) ?? 1) - 1)
      const end = input.limit != null ? start + (input.limit as number) : lines.length
      return lines
        .slice(start, end)
        .map((l, i) => `${start + i + 1}\t${l}`)
        .join('\n')
    }
    case 'Write': {
      const p = resolve(input.file_path as string)
      await fs.mkdir(dirname(p), { recursive: true })
      await fs.writeFile(p, input.content as string, 'utf8')
      return `Written ${(input.content as string).length} bytes to ${p}`
    }
    case 'Edit': {
      const p = input.file_path as string
      let content = await fs.readFile(p, 'utf8')
      const oldS = input.old_string as string
      if (!content.includes(oldS)) throw new Error(`old_string not found in ${p}`)
      content = input.replace_all
        ? content.split(oldS).join(input.new_string as string)
        : content.replace(oldS, input.new_string as string)
      await fs.writeFile(p, content, 'utf8')
      return `Edited ${p}`
    }
    case 'Glob': {
      const files = await glob(input.pattern as string, {
        cwd: root,
        absolute: true,
        nodir: true,
        ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/.next/**', '**/out/**']
      })
      return files.slice(0, 500).join('\n') || '(no matches)'
    }
    case 'Bash': {
      const cmd = input.command as string
      if (DANGEROUS.test(cmd)) throw new Error('Refused: dangerous command blocked.')
      if (/\bgit\s+(push|commit)\b/.test(cmd)) {
        throw new Error('Refused: the orchestrator handles git commit/push — do not run it yourself.')
      }
      const { stdout, stderr } = await execp(cmd, {
        cwd: root,
        timeout: (input.timeout as number) ?? 60_000,
        maxBuffer: 4 * 1024 * 1024
      })
      return [stdout, stderr].filter(Boolean).join('\n').trim() || '(no output)'
    }
    default:
      throw new Error(`Unknown worker tool: ${name}`)
  }
}

function shortId(): string {
  return Math.random().toString(36).slice(2, 7)
}

function kebab(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 40)
}

async function git(repo: string, args: string): Promise<string> {
  return (await execp(`git ${args}`, { cwd: repo, maxBuffer: 4 * 1024 * 1024 })).stdout.trim()
}

/** Best-effort: run the repo's typecheck/test scripts if defined, summarise for the PR body. */
async function runChecks(worktree: string): Promise<string> {
  let scripts: Record<string, string> = {}
  try {
    scripts = JSON.parse(await fs.readFile(join(worktree, 'package.json'), 'utf8')).scripts ?? {}
  } catch {
    return 'No package.json — checks skipped.'
  }
  const wanted = ['typecheck', 'test'].filter((s) => scripts[s])
  if (!wanted.length) return 'No typecheck/test scripts — checks skipped.'
  const lines: string[] = []
  for (const s of wanted) {
    try {
      await execp(`npm run -s ${s}`, { cwd: worktree, timeout: 180_000, maxBuffer: 8 * 1024 * 1024 })
      lines.push(`- \`npm run ${s}\`: ✅ passed`)
    } catch (e: unknown) {
      lines.push(`- \`npm run ${s}\`: ❌ failed`)
    }
  }
  return lines.join('\n')
}

export async function runWorker(spec: WorkerSpec): Promise<WorkerResult> {
  const gh = parseGitRemote(spec.remote)
  if (!gh) return { ok: false, error: 'Project has no GitHub remote — cannot open a PR.' }

  const title = (spec.title || spec.task).slice(0, 80)
  const branch = `artemis/${kebab(spec.task) || 'fix'}-${shortId()}`
  const worktree = join(os.tmpdir(), `artemis-wt-${shortId()}`)
  const base = (await git(spec.projectPath, 'rev-parse --abbrev-ref HEAD').catch(() => 'main')) || 'main'

  // 1. isolated worktree on a fresh branch off the current HEAD
  try {
    await git(spec.projectPath, `worktree add -b ${branch} "${worktree}" HEAD`)
  } catch (e: unknown) {
    return { ok: false, error: `Could not create worktree: ${e instanceof Error ? e.message : String(e)}` }
  }

  try {
    // 2. the focused worker sub-agent
    const client = await getModelClient()
    const system = [
      `You are an autonomous WORKER agent fixing one specific issue in the "${spec.projectName}" repo.`,
      `Your working directory is ${worktree} — operate ONLY within it, using absolute paths under it.`,
      `Make the MINIMAL, focused change to accomplish the task. Inspect before editing.`,
      `Do NOT run git commit/push, do NOT touch other repos, do NOT do unrelated cleanup.`,
      `When the change is complete, stop (end your turn) with a one-paragraph summary of what you changed and why.`
    ].join('\n')
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: `Task: ${spec.task}` }]

    let summary = ''
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const stream = client.stream({ system, messages, tools: WORKER_TOOLS })
      let text = ''
      for await (const tok of stream.tokens) text += tok
      const final = await stream.final()
      messages.push({ role: 'assistant', content: final.content })
      if (final.stopReason !== 'tool_use') {
        summary = text.trim()
        break
      }
      const results: Anthropic.ToolResultBlockParam[] = []
      for (const block of final.content) {
        if (block.type !== 'tool_use') continue
        try {
          const out = await executeWorkerTool(block.name, block.input as Record<string, unknown>, worktree)
          results.push({ type: 'tool_result', tool_use_id: block.id, content: clampToolOutput(out) })
        } catch (e: unknown) {
          results.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: `Error: ${e instanceof Error ? e.message : String(e)}`,
            is_error: true
          })
        }
      }
      messages.push({ role: 'user', content: results })
    }

    // 3. bail if nothing changed
    const dirty = await git(worktree, 'status --porcelain')
    if (!dirty) return { ok: false, error: 'Worker made no changes — no PR opened.' }

    // 4. best-effort checks (reported in the PR body, non-blocking)
    const checks = await runChecks(worktree)

    // 5. commit + push the branch (never main)
    await git(worktree, 'add -A')
    await execp(`git commit -m ${shellQuote(title)}`, { cwd: worktree })
    await git(worktree, `push -u origin ${branch}`)

    // 6. open the PR via gh
    const body = [
      `**Automated by Artemis worker agent${spec.label ? ` (${spec.label})` : ''}.**`,
      ``,
      `**Task:** ${spec.task}`,
      ``,
      summary ? `**What changed:** ${summary}` : '',
      ``,
      `**Checks:**`,
      checks,
      ``,
      `_Review before merging — opened on branch \`${branch}\`, base \`${base}\`._`
    ]
      .filter((l) => l !== undefined)
      .join('\n')

    const { stdout } = await execp(
      `gh pr create --repo ${gh.slug} --head ${branch} --base ${base} --title ${shellQuote(title)} --body ${shellQuote(body)}`,
      { cwd: worktree }
    )
    const url = stdout.trim().split('\n').find((l) => l.startsWith('http')) ?? stdout.trim()

    // 7. log to the review queue
    addPrReview({ project: spec.projectName, title, url, branch, agent: spec.label ?? 'worker' })

    return { ok: true, url, branch }
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), branch }
  } finally {
    // 8. always remove the worktree
    await git(spec.projectPath, `worktree remove "${worktree}" --force`).catch(() => {})
  }
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}
