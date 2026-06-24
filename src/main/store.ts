import { app } from 'electron'
import { join } from 'path'
import Database from 'better-sqlite3'

/**
 * Artemis's local-first persistence backbone (SQLite).
 *
 * Holds the durable transcript, an in-flight turn buffer (so a mid-answer restart
 * recovers), and a rolling terminal scrollback. It lives as a single file under the OS
 * userData dir — deliberately *outside* the repo (kept out of git), portable by copying
 * that one file. This is the substrate the Phase 3 semantic-memory tier (sqlite-vec)
 * will extend; see ROADMAP-TO-JARVIS.md.
 *
 * Why SQLite over the old localStorage transcript: no ~5MB quota ceiling (months of
 * conversation silently stopped persisting once localStorage filled), it's queryable,
 * and reads/writes are synchronous — exactly what makes restart-restore instant.
 *
 * Growth is bounded by design: we load only the recent slice for display, never replay
 * the whole DB into the model's context, and cap the terminal scrollback.
 */

export interface StoredMessage {
  role: 'user' | 'assistant'
  text: string
}

export interface StoredTurn {
  requestId: string
  text: string
  done: string | null
  speech: string
  error: string | null
  state: string
  claimed: boolean
}

const TERMINAL_CAP_BYTES = 256 * 1024 // rolling scrollback ceiling
const TURN_HISTORY = 20 // keep only the most recent turns for recovery

let db: Database.Database | null = null

function getDb(): Database.Database {
  if (db) return db
  const file = join(app.getPath('userData'), 'artemis.db')
  db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_id ON messages(id);

    CREATE TABLE IF NOT EXISTS turns (
      request_id TEXT PRIMARY KEY,
      text TEXT NOT NULL DEFAULT '',
      done TEXT,
      speech TEXT NOT NULL DEFAULT '',
      error TEXT,
      state TEXT NOT NULL DEFAULT 'thinking',
      claimed INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS terminal (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      data TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      remote TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pr_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      branch TEXT,
      agent TEXT,
      reviewed INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
  `)
  return db
}

// --- key/value meta ----------------------------------------------------------

const VIEW_FLOOR = 'view_floor' // messages at/below this id are archived, not shown
const PREV_VIEW_FLOOR = 'prev_view_floor' // the floor before the last new-conversation, for undo

function getMeta(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row?.value ?? null
}

function setMeta(key: string, value: string): void {
  getDb()
    .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, value)
}

/**
 * Start a fresh conversation *view* without deleting anything: raise the view floor
 * to the current newest message, so loadRecentMessages stops returning the prior
 * thread. History stays in the DB (archived), recoverable by lowering the floor.
 */
export function startNewConversation(): void {
  const prevFloor = getMeta(VIEW_FLOOR) ?? '0'
  const max = (getDb().prepare('SELECT COALESCE(MAX(id), 0) AS m FROM messages').get() as { m: number }).m
  setMeta(PREV_VIEW_FLOOR, prevFloor)
  setMeta(VIEW_FLOOR, String(max))
}

/**
 * Undo the most recent startNewConversation: delete any messages added since the
 * floor was raised (e.g. the fresh-start greeting) and restore the previous floor,
 * un-archiving the prior thread. The reversible alternative to a confirm dialog.
 */
export function undoNewConversation(): void {
  const prev = getMeta(PREV_VIEW_FLOOR)
  if (prev == null) return
  const raisePoint = Number(getMeta(VIEW_FLOOR) ?? '0')
  getDb().prepare('DELETE FROM messages WHERE id > ?').run(raisePoint)
  setMeta(VIEW_FLOOR, prev)
}

// --- model preference --------------------------------------------------------

// Default to Sonnet: ~5x cheaper and much faster than Opus for everyday conversation.
const MODEL_KEY = 'model'
const DEFAULT_MODEL = 'claude-sonnet-4-6'

export function getModel(): string {
  return getMeta(MODEL_KEY) ?? DEFAULT_MODEL
}

export function setModel(model: string): void {
  setMeta(MODEL_KEY, model)
}

// --- model backend (which brain) ---------------------------------------------

// 'anthropic' = metered Claude API (default), 'ollama' = local/home-box model,
// 'claude-cli' = flat subscription via the claude CLI (not wired yet).
// The backend seam lives in src/main/model/; see ROADMAP-TO-JARVIS.md Phase 8.
const BACKEND_KEY = 'backend'
const DEFAULT_BACKEND = 'anthropic'

export function getBackend(): string {
  return getMeta(BACKEND_KEY) ?? DEFAULT_BACKEND
}

export function setBackend(backend: string): void {
  setMeta(BACKEND_KEY, backend)
}

// Ollama connection: host is configurable so the same code points at the laptop
// (localhost) or a dedicated brain box on the LAN / Tailscale.
const OLLAMA_HOST_KEY = 'ollama_host'
const DEFAULT_OLLAMA_HOST = 'http://localhost:11434'
const OLLAMA_MODEL_KEY = 'ollama_model'
const DEFAULT_OLLAMA_MODEL = 'qwen2.5-coder:7b'

export function getOllamaHost(): string {
  return getMeta(OLLAMA_HOST_KEY) ?? DEFAULT_OLLAMA_HOST
}

export function setOllamaHost(host: string): void {
  setMeta(OLLAMA_HOST_KEY, host)
}

export function getOllamaModel(): string {
  return getMeta(OLLAMA_MODEL_KEY) ?? DEFAULT_OLLAMA_MODEL
}

export function setOllamaModel(model: string): void {
  setMeta(OLLAMA_MODEL_KEY, model)
}

// --- multi-project registry (the ops-layer spine) ----------------------------

// Generic by design: a list of overseen repos (any ecosystem, not just Livana),
// each a working dir Artemis can switch into. The active one drives the agent's
// file-tool cwd. See ROADMAP-TO-JARVIS.md → Phase M.
const ACTIVE_PROJECT_KEY = 'active_project' // stores the active project's path

export interface Project {
  id: number
  name: string
  path: string
  remote: string | null
}

export function listProjects(): Project[] {
  return getDb()
    .prepare('SELECT id, name, path, remote FROM projects ORDER BY id ASC')
    .all() as Project[]
}

/** Add (or upsert by path) a project. First project added becomes active. */
export function addProject(name: string, path: string, remote: string | null): Project {
  const db = getDb()
  db.prepare(
    `INSERT INTO projects (name, path, remote, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET name=excluded.name, remote=excluded.remote`
  ).run(name, path, remote, Date.now())
  if (!getMeta(ACTIVE_PROJECT_KEY)) setMeta(ACTIVE_PROJECT_KEY, path)
  return db.prepare('SELECT id, name, path, remote FROM projects WHERE path = ?').get(path) as Project
}

export function removeProject(id: number): void {
  const db = getDb()
  const row = db.prepare('SELECT path FROM projects WHERE id = ?').get(id) as
    | { path: string }
    | undefined
  db.prepare('DELETE FROM projects WHERE id = ?').run(id)
  // If we removed the active project, fall back to the first remaining one.
  if (row && getMeta(ACTIVE_PROJECT_KEY) === row.path) {
    const next = db.prepare('SELECT path FROM projects ORDER BY id ASC LIMIT 1').get() as
      | { path: string }
      | undefined
    setMeta(ACTIVE_PROJECT_KEY, next?.path ?? '')
  }
}

/** The active project's path — defaults to Artemis's own repo if none set. */
export function getActiveProjectPath(): string {
  return getMeta(ACTIVE_PROJECT_KEY) || app.getAppPath()
}

export function setActiveProjectPath(path: string): void {
  setMeta(ACTIVE_PROJECT_KEY, path)
}

// Per-project GA4 properties (meta-keyed by path). A project (e.g. a monorepo) can
// expose several apps, each with its own GA4 property — so we store a labelled list.
export interface GaProp {
  label: string
  id: string
}

export function getProjectGaProps(path: string): GaProp[] {
  const raw = getMeta(`ga_props:${path}`)
  if (raw) {
    try {
      return JSON.parse(raw) as GaProp[]
    } catch {
      return []
    }
  }
  // Migrate the old single-id format, if present.
  const legacy = getMeta(`ga_property:${path}`)
  return legacy ? [{ label: '', id: legacy }] : []
}

export function setProjectGaProps(path: string, props: GaProp[]): void {
  const clean = props.filter((p) => p.id.trim()).map((p) => ({ label: p.label.trim(), id: p.id.trim() }))
  setMeta(`ga_props:${path}`, JSON.stringify(clean))
}

export function getActiveProject(): Project | null {
  const path = getActiveProjectPath()
  return (
    (getDb()
      .prepare('SELECT id, name, path, remote FROM projects WHERE path = ?')
      .get(path) as Project | undefined) ?? null
  )
}

// --- PR Review Queue (worker-agent output, human-approval surface) ------------

export interface PrReview {
  id: number
  project: string
  title: string
  url: string
  branch: string | null
  agent: string | null
  reviewed: boolean
  created_at: number
}

/** Log a PR a worker agent opened, for the human to review later. */
export function addPrReview(r: {
  project: string
  title: string
  url: string
  branch?: string | null
  agent?: string | null
}): PrReview {
  const db = getDb()
  const info = db
    .prepare(
      'INSERT INTO pr_reviews (project, title, url, branch, agent, reviewed, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)'
    )
    .run(r.project, r.title, r.url, r.branch ?? null, r.agent ?? null, Date.now())
  return db
    .prepare('SELECT * FROM pr_reviews WHERE id = ?')
    .get(info.lastInsertRowid) as PrReview
}

/** PRs awaiting review first (newest), then recently-reviewed for reference. */
export function listPrReviews(): PrReview[] {
  return (
    getDb()
      .prepare('SELECT * FROM pr_reviews ORDER BY reviewed ASC, created_at DESC')
      .all() as Array<Record<string, unknown>>
  ).map((row) => ({
    id: row.id as number,
    project: row.project as string,
    title: row.title as string,
    url: row.url as string,
    branch: (row.branch as string) ?? null,
    agent: (row.agent as string) ?? null,
    reviewed: !!row.reviewed,
    created_at: row.created_at as number
  }))
}

export function setPrReviewed(id: number, reviewed: boolean): void {
  getDb().prepare('UPDATE pr_reviews SET reviewed = ? WHERE id = ?').run(reviewed ? 1 : 0, id)
}

/** Drop reviewed rows (a "clear done" action for the queue). */
export function clearReviewedPrs(): void {
  getDb().prepare('DELETE FROM pr_reviews WHERE reviewed = 1').run()
}

/** Seed Artemis's own repo as a project on first run so the switcher is never empty. */
export function ensureSelfProject(): void {
  const db = getDb()
  const selfPath = app.getAppPath()
  const existing = db.prepare('SELECT id FROM projects WHERE path = ?').get(selfPath)
  if (!existing) {
    db.prepare(
      'INSERT INTO projects (name, path, remote, created_at) VALUES (?, ?, ?, ?)'
    ).run('artemis (self)', selfPath, null, Date.now())
  }
  if (!getMeta(ACTIVE_PROJECT_KEY)) setMeta(ACTIVE_PROJECT_KEY, selfPath)
}

// --- transcript ---------------------------------------------------------------

/** Append one committed message to the durable transcript. */
export function appendMessage(role: 'user' | 'assistant', text: string): void {
  getDb()
    .prepare('INSERT INTO messages (role, text, created_at) VALUES (?, ?, ?)')
    .run(role, text, Date.now())
}

/** Load the most recent `limit` messages above the view floor, oldest-first. */
export function loadRecentMessages(limit = 200): StoredMessage[] {
  const floor = Number(getMeta(VIEW_FLOOR) ?? '0')
  return getDb()
    .prepare(
      `SELECT role, text FROM (
         SELECT id, role, text FROM messages WHERE id > ? ORDER BY id DESC LIMIT ?
       ) ORDER BY id ASC`
    )
    .all(floor, limit) as StoredMessage[]
}

// --- in-flight turn (durable across a full restart) ---------------------------

/** Upsert the live turn so a mid-answer restart can recover it. */
export function saveTurn(t: StoredTurn): void {
  const d = getDb()
  d.prepare(
    `INSERT INTO turns (request_id, text, done, speech, error, state, claimed, created_at)
     VALUES (@requestId, @text, @done, @speech, @error, @state, @claimed, @createdAt)
     ON CONFLICT(request_id) DO UPDATE SET
       text=excluded.text, done=excluded.done, speech=excluded.speech,
       error=excluded.error, state=excluded.state, claimed=excluded.claimed`
  ).run({
    requestId: t.requestId,
    text: t.text,
    done: t.done,
    speech: t.speech,
    error: t.error,
    state: t.state,
    claimed: t.claimed ? 1 : 0,
    createdAt: Date.now()
  })
  // keep the table tiny — recovery only ever needs the latest turn
  d.prepare(
    `DELETE FROM turns WHERE request_id NOT IN (
       SELECT request_id FROM turns ORDER BY created_at DESC LIMIT ?
     )`
  ).run(TURN_HISTORY)
}

/** The most recently active turn, or null. Used to recover after a full restart. */
export function loadLastTurn(): StoredTurn | null {
  const row = getDb()
    .prepare('SELECT * FROM turns ORDER BY created_at DESC LIMIT 1')
    .get() as Record<string, unknown> | undefined
  if (!row) return null
  return {
    requestId: row.request_id as string,
    text: row.text as string,
    done: (row.done as string) ?? null,
    speech: row.speech as string,
    error: (row.error as string) ?? null,
    state: row.state as string,
    claimed: !!row.claimed
  }
}

export function markTurnClaimed(requestId: string): void {
  getDb().prepare('UPDATE turns SET claimed = 1 WHERE request_id = ?').run(requestId)
}

// --- terminal scrollback (rolling cap) ----------------------------------------

/** Persist a chunk of terminal output, trimming oldest chunks past the cap. */
export function appendTerminal(data: string): void {
  if (!data) return
  const d = getDb()
  d.prepare('INSERT INTO terminal (data, bytes, created_at) VALUES (?, ?, ?)').run(
    data,
    Buffer.byteLength(data, 'utf8'),
    Date.now()
  )
  const total = (d.prepare('SELECT COALESCE(SUM(bytes), 0) AS s FROM terminal').get() as { s: number }).s
  if (total > TERMINAL_CAP_BYTES) {
    const rows = d.prepare('SELECT id, bytes FROM terminal ORDER BY id ASC').all() as Array<{
      id: number
      bytes: number
    }>
    let running = total
    const drop: number[] = []
    for (const r of rows) {
      if (running <= TERMINAL_CAP_BYTES) break
      drop.push(r.id)
      running -= r.bytes
    }
    if (drop.length) {
      d.prepare(`DELETE FROM terminal WHERE id IN (${drop.map(() => '?').join(',')})`).run(...drop)
    }
  }
}

/** The retained terminal scrollback, oldest-first, ready to replay into xterm. */
export function loadTerminalScrollback(): string {
  const rows = getDb().prepare('SELECT data FROM terminal ORDER BY id ASC').all() as Array<{
    data: string
  }>
  return rows.map((r) => r.data).join('')
}
