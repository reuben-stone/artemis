import { app } from 'electron'
import { join } from 'path'
import { promises as fs } from 'fs'

/**
 * Persistent, cross-session memory for Artemis.
 *
 * Storage: plain markdown files — one fact per file — plus a `MEMORY.md` index.
 * Human-readable, git-versionable, survives restarts. In dev the store lives in the
 * repo's `memory/` (so it's part of Artemis's own source); in a packaged build it
 * lives under the OS userData dir so it stays writable.
 *
 * This is the file tier of the memory system. A semantic/vector tier can be layered
 * on later (embed each file, recall by similarity) without changing this interface.
 */

export interface MemoryRecord {
  name: string // kebab-case slug → filename
  description: string // one-line summary, shown in the index
  type: 'user' | 'feedback' | 'project' | 'reference'
  body: string
}

function memoryDir(): string {
  // Dev: ELECTRON_RENDERER_URL is set → repo root is two levels up from out/main.
  if (process.env['ELECTRON_RENDERER_URL']) {
    return join(app.getAppPath(), 'memory')
  }
  return join(app.getPath('userData'), 'memory')
}

const INDEX = 'MEMORY.md'

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'note'

/** Load the full memory context to inject at session start. */
export async function loadMemory(): Promise<{ index: string; facts: string[] }> {
  const dir = memoryDir()
  await ensureDir(dir)
  let index = ''
  try {
    index = await fs.readFile(join(dir, INDEX), 'utf8')
  } catch {
    index = '# Artemis — Memory Index\n'
  }
  const facts: string[] = []
  const entries = await fs.readdir(dir).catch(() => [] as string[])
  for (const f of entries) {
    if (f.endsWith('.md') && f !== INDEX) {
      facts.push(await fs.readFile(join(dir, f), 'utf8'))
    }
  }
  return { index, facts }
}

/** Persist one durable fact and add a pointer line to the index. */
export async function saveMemory(rec: MemoryRecord): Promise<{ file: string }> {
  const dir = memoryDir()
  await ensureDir(dir)
  const name = slug(rec.name)
  const file = `${name}.md`
  const content = `---
name: ${name}
description: ${rec.description}
metadata:
  type: ${rec.type}
---

${rec.body.trim()}
`
  await fs.writeFile(join(dir, file), content, 'utf8')

  // append a pointer to the index if not already present
  const indexPath = join(dir, INDEX)
  let index = ''
  try {
    index = await fs.readFile(indexPath, 'utf8')
  } catch {
    index = '# Artemis — Memory Index\n\n'
  }
  const pointer = `- [${rec.description}](${file}) — ${rec.type}`
  if (!index.includes(`(${file})`)) {
    index = index.trimEnd() + '\n' + pointer + '\n'
    await fs.writeFile(indexPath, index, 'utf8')
  }
  return { file }
}
