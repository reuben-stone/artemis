import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import os from 'os'

import {
  splitSpeech,
  DANGEROUS,
  AUTO_ALLOW,
  buildMessages,
  executeTool,
  clampToolOutput,
  isSafeReadOnly
} from '../src/main/agent'
import { toOllamaMessages } from '../src/main/model/ollama'
import { parseGitRemote } from '../src/main/github'
import { buildBoardQuery, mapBoardResponse, formatTicketBranch, formatClosesLine, mapPrOutcome } from '../src/main/board'
import { withinWorktree } from '../src/main/safety'

/**
 * Artemis smoke harness — a fast, free, deterministic check that the core
 * capabilities still work after a change: read / edit / glob / grep / execute,
 * the spoken-summary split, the permission/danger gate, durable memory recall,
 * conversation assembly, and the Ollama backend translation. No Electron, no API
 * calls. Run with `npm test` before relying on a self-modification.
 *
 * NOT covered here (needs an Electron/native-SQLite context): the store's
 * view-floor / undo / turn-recovery. Tracked as a follow-up.
 */

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(os.tmpdir(), 'artemis-smoke-'))
})
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('speak — spoken-summary split', () => {
  it('splits display text from the spoken line on the marker', () => {
    const { display, speech } = splitSpeech('On screen text.\n⟦say⟧ Spoken gist.')
    expect(display).toBe('On screen text.')
    expect(speech).toBe('Spoken gist.')
  })
  it('returns all display and empty speech when no marker is present', () => {
    const { display, speech } = splitSpeech('Just a normal reply.')
    expect(display).toBe('Just a normal reply.')
    expect(speech).toBe('')
  })
})

describe('gate — danger blocklist & auto-allow set', () => {
  it('flags destructive commands', () => {
    expect(DANGEROUS.test('rm -rf /')).toBe(true)
    expect(DANGEROUS.test('sudo mkfs.ext4 /dev/sda')).toBe(true)
    expect(DANGEROUS.test('dd if=/dev/zero of=/dev/sda')).toBe(true)
  })
  it('leaves ordinary commands alone', () => {
    expect(DANGEROUS.test('npm run build')).toBe(false)
    expect(DANGEROUS.test('ls -la src')).toBe(false)
  })
  it('auto-allows read-only and memory tools only', () => {
    expect(AUTO_ALLOW.has('Read')).toBe(true)
    expect(AUTO_ALLOW.has('save_memory')).toBe(true)
    expect(AUTO_ALLOW.has('Bash')).toBe(false)
    expect(AUTO_ALLOW.has('Write')).toBe(false)
  })
  it('gates ticket writes but not the read-only board view', () => {
    expect(AUTO_ALLOW.has('tickets_view')).toBe(true) // read-only board read
    expect(AUTO_ALLOW.has('ticket_create')).toBe(false) // outward-effecting write → gated
    expect(AUTO_ALLOW.has('ticket_comment')).toBe(false) // public comment → gated
    expect(AUTO_ALLOW.has('ticket_update')).toBe(false) // status/close write → gated
    expect(AUTO_ALLOW.has('dispatch_worker')).toBe(false) // still gated
  })
})

describe('gate — safe read-only command classifier (Smart mode)', () => {
  it('auto-approves obviously read-only commands', () => {
    for (const c of ['ls -la src', 'pwd', 'cat package.json', 'date +%Y-%m-%d', 'git status', 'git log -5', 'git diff HEAD', 'node -v', 'npm ls']) {
      expect(isSafeReadOnly(c)).toBe(true)
    }
  })
  it('refuses anything that could chain, redirect, or write', () => {
    for (const c of [
      'rm file.txt', // a writer/deleter
      'npm install left-pad', // installs/executes
      'git commit -m x', // mutates
      'git config user.name Bob', // a set, not a get
      'git branch new-feature', // creates a ref
      'echo hi > out.txt', // redirect (write)
      'cat a | tee b', // pipe to a writer
      'ls && rm x', // chaining
      'python3 -c "print(1)"', // arbitrary code
      'date 2>/dev/null || python3 -c "x"' // the compound from the screenshot
    ]) {
      expect(isSafeReadOnly(c)).toBe(false)
    }
  })
})

describe('read / write / edit tools', () => {
  it('writes then reads a file back with line numbers', async () => {
    const f = join(dir, 'note.txt')
    await executeTool('Write', { file_path: f, content: 'alpha\nbeta\ngamma' })
    const out = await executeTool('Read', { file_path: f })
    expect(out).toContain('1\talpha')
    expect(out).toContain('3\tgamma')
  })
  it('reads a slice with offset/limit', async () => {
    const f = join(dir, 'slice.txt')
    await executeTool('Write', { file_path: f, content: 'a\nb\nc\nd\ne' })
    const out = await executeTool('Read', { file_path: f, offset: 2, limit: 2 })
    expect(out).toBe('2\tb\n3\tc')
  })
  it('edits an exact string and errors on a missing match', async () => {
    const f = join(dir, 'edit.txt')
    await executeTool('Write', { file_path: f, content: 'hello world' })
    await executeTool('Edit', { file_path: f, old_string: 'world', new_string: 'Artemis' })
    expect(await executeTool('Read', { file_path: f })).toContain('hello Artemis')
    await expect(
      executeTool('Edit', { file_path: f, old_string: 'nope', new_string: 'x' })
    ).rejects.toThrow()
  })
})

describe('glob / grep tools', () => {
  it('globs files under a directory', async () => {
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1')
    writeFileSync(join(dir, 'b.ts'), 'export const b = 2')
    const out = await executeTool('Glob', { pattern: '*.ts', path: dir })
    expect(out).toContain('a.ts')
    expect(out).toContain('b.ts')
  })
  it('greps a pattern and reports file:line', async () => {
    writeFileSync(join(dir, 'search.txt'), 'first\nNEEDLE here\nlast')
    const out = await executeTool('Grep', { pattern: 'NEEDLE', path: dir })
    expect(out).toContain('NEEDLE here')
    expect(out).toContain(':2:')
  })
})

describe('execute — bash tool', () => {
  it('runs a safe command', async () => {
    const out = await executeTool('Bash', { command: 'echo artemis-ok' })
    expect(out).toContain('artemis-ok')
  })
  it('refuses a destructive command', async () => {
    await expect(executeTool('Bash', { command: 'rm -rf /' })).rejects.toThrow(/dangerous/i)
  })
})

describe('agent-driven UI — show_panel', () => {
  it('emits a ui open event for a known panel and reports it', async () => {
    const events: Record<string, unknown>[] = []
    const out = await executeTool('show_panel', { panel: 'calendar' }, { emit: (e) => events.push(e) })
    expect(events).toContainEqual({ ui: { panel: 'calendar' } })
    expect(out).toMatch(/opened/i)
  })
  it('rejects an unknown panel without emitting', async () => {
    const events: Record<string, unknown>[] = []
    const out = await executeTool('show_panel', { panel: 'nope' }, { emit: (e) => events.push(e) })
    expect(events).toEqual([])
    expect(out).toMatch(/unknown panel/i)
  })
})

describe('remember — durable memory round-trip', () => {
  it('saves a fact and recalls it', async () => {
    await executeTool('save_memory', {
      name: 'smoke-fact',
      description: 'a fact saved by the smoke test',
      type: 'project',
      body: 'Artemis remembers across sessions.'
    })
    const recalled = await executeTool('recall_memory', {})
    expect(recalled).toContain('Artemis remembers across sessions.')
  })
})

describe('context — conversation assembly', () => {
  it('drops leading assistant turns, merges same-role, appends the new user msg', () => {
    const msgs = buildMessages(
      [
        { role: 'assistant', text: 'stray greeting' }, // dropped (must start with user)
        { role: 'user', text: 'one' },
        { role: 'user', text: 'two' } // merged with previous user turn
      ],
      'three'
    )
    expect(msgs[0].role).toBe('user')
    expect(msgs[0].content).toBe('one\n\ntwo')
    expect(msgs[msgs.length - 1]).toEqual({ role: 'user', content: 'three' })
  })
})

describe('context safety — tool output clamp', () => {
  it('passes small output through unchanged', () => {
    expect(clampToolOutput('short')).toBe('short')
  })
  it('truncates a huge output to protect the context window', () => {
    const huge = 'x'.repeat(500_000)
    const out = clampToolOutput(huge)
    expect(out.length).toBeLessThan(huge.length)
    expect(out).toMatch(/truncated/)
  })
})

describe('multi-project — GitHub remote parsing', () => {
  it('parses SSH and HTTPS GitHub remotes to slug + web url', () => {
    expect(parseGitRemote('git@github.com:livana/scanner.git')).toEqual({
      slug: 'livana/scanner',
      url: 'https://github.com/livana/scanner'
    })
    expect(parseGitRemote('https://github.com/livana/web.git')?.slug).toBe('livana/web')
    expect(parseGitRemote('https://github.com/livana/web')?.url).toBe(
      'https://github.com/livana/web'
    )
  })
  it('returns null for non-GitHub or empty remotes', () => {
    expect(parseGitRemote('git@gitlab.com:foo/bar.git')).toBeNull()
    expect(parseGitRemote('')).toBeNull()
    expect(parseGitRemote(null)).toBeNull()
  })
})

describe('ticket operator — GitHub Projects board helpers', () => {
  // A captured-shape response (organization root) with an Issue, a DraftIssue, and a
  // second Issue from another repo — the cross-repo board.
  const boardFixture = {
    data: {
      organization: {
        projectV2: {
          id: 'PVT_board1',
          title: 'Livana Ops',
          items: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: 'ITEM_1',
                updatedAt: '2026-06-20T10:00:00Z',
                fieldValueByName: { name: 'In Progress' },
                content: {
                  __typename: 'Issue',
                  id: 'I_1',
                  number: 42,
                  title: 'Fix flaky scan test',
                  url: 'https://github.com/livana/scanner/issues/42',
                  repository: { nameWithOwner: 'livana/scanner' },
                  assignees: { nodes: [{ login: 'reuben' }] },
                  labels: { nodes: [{ name: 'bug' }, { name: 'p1' }] }
                }
              },
              {
                id: 'ITEM_2',
                updatedAt: '2026-06-19T08:00:00Z',
                fieldValueByName: null,
                content: { __typename: 'DraftIssue', title: 'brainstorm onboarding' }
              },
              {
                id: 'ITEM_3',
                updatedAt: '2026-06-18T08:00:00Z',
                fieldValueByName: { name: 'Todo' },
                content: {
                  __typename: 'Issue',
                  id: 'I_3',
                  number: 7,
                  title: 'Add dark mode',
                  url: 'https://github.com/livana/web/issues/7',
                  repository: { nameWithOwner: 'livana/web' },
                  assignees: { nodes: [] },
                  labels: { nodes: [] }
                }
              }
            ]
          }
        }
      }
    }
  }

  it('builds the query against the right root field for org vs user projects', () => {
    expect(buildBoardQuery('org')).toContain('organization(login:')
    expect(buildBoardQuery('org')).not.toContain('user(login:')
    expect(buildBoardQuery('user')).toContain('user(login:')
    expect(buildBoardQuery('user')).not.toContain('organization(login:')
    // status read name-addressably — no field-id lookup needed for reads
    expect(buildBoardQuery('org')).toContain('fieldValueByName(name: "Status")')
  })

  it('maps a board response, flattening status/assignees/labels and skipping drafts', () => {
    const { boardId, title, tickets, pageInfo } = mapBoardResponse(boardFixture)
    expect(boardId).toBe('PVT_board1')
    expect(title).toBe('Livana Ops')
    expect(pageInfo.hasNextPage).toBe(false)
    expect(tickets.length).toBe(2) // the DraftIssue is skipped (not dispatchable)

    const a = tickets[0]
    expect(a.repo).toBe('livana/scanner')
    expect(a.itemId).toBe('ITEM_1')
    expect(a.issueNumber).toBe(42)
    expect(a.contentId).toBe('I_1')
    expect(a.status).toBe('In Progress')
    expect(a.assignees).toBe('reuben')
    expect(a.labels).toBe('bug, p1')
    expect(a.url).toBe('https://github.com/livana/scanner/issues/42')
    expect(typeof a.updatedAt).toBe('number')

    const b = tickets[1]
    expect(b.repo).toBe('livana/web')
    expect(b.status).toBe('Todo')
    expect(b.assignees).toBeNull()
    expect(b.labels).toBeNull()
  })

  it('reads a user-owned board response too', () => {
    const userFixture = { data: { user: boardFixture.data.organization } }
    const { boardId, tickets } = mapBoardResponse(userFixture)
    expect(boardId).toBe('PVT_board1')
    expect(tickets.length).toBe(2)
  })

  it('formats the ticket branch and Closes line that wire PR↔ticket on GitHub', () => {
    expect(formatTicketBranch(42)).toBe('artemis/ticket-42')
    expect(formatClosesLine(42)).toBe('Closes #42')
  })

  it('confines worker file ops to the worktree sandbox (injection/error containment)', () => {
    const root = '/tmp/wt'
    // in-sandbox paths resolve fine
    expect(withinWorktree(root, 'src/index.ts')).toBe('/tmp/wt/src/index.ts')
    expect(withinWorktree(root, './a/b.ts')).toBe('/tmp/wt/a/b.ts')
    // escapes are refused: absolute paths, parent traversal, and sibling-prefix tricks
    expect(() => withinWorktree(root, '/etc/passwd')).toThrow(/escapes the worktree/)
    expect(() => withinWorktree(root, '../other/secret')).toThrow(/escapes the worktree/)
    expect(() => withinWorktree(root, '../../etc/shadow')).toThrow(/escapes the worktree/)
    expect(() => withinWorktree('/tmp/wt', '/tmp/wt-evil/x')).toThrow(/escapes the worktree/) // sibling-prefix
    expect(() => withinWorktree(root, '')).toThrow(/missing file path/)
    // `~` is NOT shell-expanded by resolve — it's a literal segment, so it stays contained.
    expect(withinWorktree(root, '~/.ssh/id_rsa')).toBe('/tmp/wt/~/.ssh/id_rsa')
  })

  it('maps PR outcome — merge state, CI rollup, review decision (close the loop)', () => {
    // merged, all checks passed, approved
    expect(
      mapPrOutcome({
        state: 'MERGED',
        reviewDecision: 'APPROVED',
        statusCheckRollup: [
          { status: 'COMPLETED', conclusion: 'SUCCESS' },
          { state: 'SUCCESS' }
        ]
      })
    ).toEqual({ state: 'merged', checks: 'success', reviewDecision: 'approved' })

    // open, a failing check beats the rest, changes requested
    expect(
      mapPrOutcome({
        state: 'OPEN',
        reviewDecision: 'CHANGES_REQUESTED',
        statusCheckRollup: [
          { status: 'COMPLETED', conclusion: 'SUCCESS' },
          { status: 'COMPLETED', conclusion: 'FAILURE' }
        ]
      })
    ).toEqual({ state: 'open', checks: 'failure', reviewDecision: 'changes_requested' })

    // a still-running check → pending; no review → none
    expect(
      mapPrOutcome({ state: 'OPEN', statusCheckRollup: [{ status: 'IN_PROGRESS' }] })
    ).toEqual({ state: 'open', checks: 'pending', reviewDecision: 'none' })

    // no checks at all → none; empty payload defaults sanely
    expect(mapPrOutcome({ state: 'OPEN' }).checks).toBe('none')
    expect(mapPrOutcome({})).toEqual({ state: 'open', checks: 'none', reviewDecision: 'none' })
  })
})

describe('model seam — Ollama message translation', () => {
  it('maps assistant tool_use to tool_calls and tool_result to a named tool turn', () => {
    const out = toOllamaMessages([
      { role: 'user', content: 'read the file' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'reading' },
          { type: 'tool_use', id: 'ollama_tool_0', name: 'Read', input: { file_path: '/x' } }
        ]
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'ollama_tool_0', content: 'file body' }]
      }
    ])
    const assistant = out.find((m) => m.role === 'assistant')
    expect(assistant?.tool_calls?.length).toBe(1)
    const toolTurn = out.find((m) => m.role === 'tool')
    expect(toolTurn?.tool_name).toBe('Read') // re-paired by id -> name
    expect(toolTurn?.content).toBe('file body')
  })
})
