import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import os from 'os'

import {
  splitSpeech,
  DANGEROUS,
  AUTO_ALLOW,
  buildMessages,
  executeTool
} from '../src/main/agent'
import { toOllamaMessages } from '../src/main/model/ollama'
import { parseGitRemote } from '../src/main/github'

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
