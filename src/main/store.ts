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

// Minimal driver interface shared by better-sqlite3 (prod) and node:sqlite (tests).
// Both expose exec() + prepare().{get,all,run}; run() returns {changes,lastInsertRowid}.
export interface DbLike {
  exec(sql: string): unknown
  prepare(sql: string): {
    get(...params: unknown[]): unknown
    all(...params: unknown[]): unknown[]
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint }
  }
}

let db: DbLike | null = null
let openDb: (file: string) => DbLike = (file) => new Database(file) as unknown as DbLike

// Test seam: swap the driver (e.g. an in-memory node:sqlite) and reset the cache.
// Also the daemon prerequisite — the DB is no longer hard-wired to a single opener.
export function __setDbOpener(opener: (file: string) => DbLike): void {
  openDb = opener
  db = null
}

function getDb(): DbLike {
  if (db) return db
  const file = join(app.getPath('userData'), 'artemis.db')
  db = openDb(file)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
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

    -- A lightweight ticket system, day-scoped. Beyond a checkbox: status workflow,
    -- priority, a project link (Lumi / LumiLens / …), tags, and external-source linkage
    -- so tickets can be imported (Lumi scanner, GitHub issues, …) and de-duped, then
    -- carried forward day to day until done.
    CREATE TABLE IF NOT EXISTS todos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      day TEXT NOT NULL,                       -- local 'YYYY-MM-DD' the ticket sits on
      text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'todo',      -- 'todo' | 'doing' | 'done'
      priority TEXT,                            -- 'low' | 'med' | 'high' (null = unset)
      project TEXT,                             -- associated project/repo name (null = personal)
      tags TEXT,                                -- comma-separated labels
      position INTEGER NOT NULL DEFAULT 0,      -- manual order within a day
      source TEXT NOT NULL DEFAULT 'local',     -- 'local' | 'github' | 'lumi' | … (provenance)
      external_id TEXT,                         -- source ticket id, for de-dup on import
      external_url TEXT,                        -- link back to the source ticket
      carried_from TEXT,                        -- original day if pulled forward from a past day
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_todos_day ON todos(day);

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      day TEXT NOT NULL,                        -- local 'YYYY-MM-DD'
      starts TEXT,                              -- local 'HH:MM' (null = all-day)
      ends TEXT,                                -- local 'HH:MM' (null = open-ended)
      title TEXT NOT NULL,
      notes TEXT,
      source TEXT NOT NULL DEFAULT 'local',     -- 'local' | 'google' | … (sync provenance)
      external_id TEXT,                         -- e.g. a Google Calendar event id, for sync
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_day ON events(day);
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

// --- day planner: todos (a lightweight ticket system) + local calendar -------
//
// Both tables carry a `source` (+ external ids) so a future sync can adopt rows
// without a schema change: GitHub issues / Lumi-scanner tickets become source-tagged
// todos, Google-Calendar entries become source='google' events, each de-duped on its
// external id. Today everything is source='local'. See ROADMAP-TO-JARVIS.md Phase 7.

/** The user's wall-clock day as 'YYYY-MM-DD' (local, NOT UTC — a planner is local). */
export function localDay(d = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export type TodoStatus = 'todo' | 'doing' | 'done'

export interface Todo {
  id: number
  day: string
  text: string
  status: TodoStatus
  priority: string | null
  project: string | null
  tags: string | null
  position: number
  source: string
  externalId: string | null
  externalUrl: string | null
  carriedFrom: string | null
  created_at: number
}

function rowToTodo(r: Record<string, unknown>): Todo {
  return {
    id: r.id as number,
    day: r.day as string,
    text: r.text as string,
    status: (r.status as TodoStatus) ?? 'todo',
    priority: (r.priority as string) ?? null,
    project: (r.project as string) ?? null,
    tags: (r.tags as string) ?? null,
    position: r.position as number,
    source: (r.source as string) ?? 'local',
    externalId: (r.external_id as string) ?? null,
    externalUrl: (r.external_url as string) ?? null,
    carriedFrom: (r.carried_from as string) ?? null,
    created_at: r.created_at as number
  }
}

/** All tickets on a day: open work first (by priority then manual order), done last. */
export function listTodos(day: string): Todo[] {
  return (
    getDb()
      .prepare(
        `SELECT * FROM todos WHERE day = ?
         ORDER BY (status = 'done') ASC,
                  CASE priority WHEN 'high' THEN 0 WHEN 'med' THEN 1 WHEN 'low' THEN 2 ELSE 3 END ASC,
                  position ASC, id ASC`
      )
      .all(day) as Array<Record<string, unknown>>
  ).map(rowToTodo)
}

/** Add a ticket. Imported items (with an externalId) are de-duped per day, so a repeat
 *  import is a no-op rather than a pile of duplicates. */
export function addTodo(input: {
  day: string
  text: string
  priority?: string | null
  project?: string | null
  tags?: string | null
  status?: TodoStatus
  source?: string
  externalId?: string | null
  externalUrl?: string | null
  carriedFrom?: string | null
}): Todo {
  const db = getDb()
  if (input.externalId) {
    const dup = db
      .prepare('SELECT * FROM todos WHERE external_id = ? AND source = ?')
      .get(input.externalId, input.source ?? 'local') as Record<string, unknown> | undefined
    if (dup) return rowToTodo(dup)
  }
  const pos = (
    db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM todos WHERE day = ?').get(input.day) as {
      p: number
    }
  ).p
  const info = db
    .prepare(
      `INSERT INTO todos (day, text, status, priority, project, tags, position, source, external_id, external_url, carried_from, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.day,
      input.text,
      input.status ?? 'todo',
      input.priority ?? null,
      input.project ?? null,
      input.tags ?? null,
      pos,
      input.source ?? 'local',
      input.externalId ?? null,
      input.externalUrl ?? null,
      input.carriedFrom ?? null,
      Date.now()
    )
  return rowToTodo(db.prepare('SELECT * FROM todos WHERE id = ?').get(info.lastInsertRowid) as Record<string, unknown>)
}

export function updateTodo(
  id: number,
  patch: {
    text?: string
    status?: TodoStatus
    priority?: string | null
    project?: string | null
    tags?: string | null
    day?: string
  }
): Todo | null {
  const db = getDb()
  const cur = db.prepare('SELECT * FROM todos WHERE id = ?').get(id) as Record<string, unknown> | undefined
  if (!cur) return null
  db.prepare(
    'UPDATE todos SET text = ?, status = ?, priority = ?, project = ?, tags = ?, day = ? WHERE id = ?'
  ).run(
    patch.text ?? (cur.text as string),
    patch.status ?? (cur.status as string) ?? 'todo',
    patch.priority !== undefined ? patch.priority : (cur.priority as string) ?? null,
    patch.project !== undefined ? patch.project : (cur.project as string) ?? null,
    patch.tags !== undefined ? patch.tags : (cur.tags as string) ?? null,
    patch.day ?? (cur.day as string),
    id
  )
  return rowToTodo(db.prepare('SELECT * FROM todos WHERE id = ?').get(id) as Record<string, unknown>)
}

export function removeTodo(id: number): void {
  getDb().prepare('DELETE FROM todos WHERE id = ?').run(id)
}

/** Pull every unfinished ticket from days BEFORE `toDay` forward onto `toDay`. The
 *  original day is recorded once in carried_from (stable across repeated carries), so
 *  "this has slipped 3 days" stays visible. Returns how many moved. */
export function carryOverTodos(toDay: string): number {
  return getDb()
    .prepare(
      `UPDATE todos SET carried_from = COALESCE(carried_from, day), day = ?
       WHERE status != 'done' AND day < ?`
    )
    .run(toDay, toDay).changes
}

/** Unfinished tickets still parked on days before `day` — carry-over candidates. */
export function unfinishedBefore(day: string): Todo[] {
  return (
    getDb()
      .prepare("SELECT * FROM todos WHERE status != 'done' AND day < ? ORDER BY day ASC, position ASC")
      .all(day) as Array<Record<string, unknown>>
  ).map(rowToTodo)
}

// --- local calendar -----------------------------------------------------------

export interface CalendarEvent {
  id: number
  day: string
  starts: string | null
  ends: string | null
  title: string
  notes: string | null
  source: string
  externalId: string | null
  created_at: number
}

function rowToEvent(r: Record<string, unknown>): CalendarEvent {
  return {
    id: r.id as number,
    day: r.day as string,
    starts: (r.starts as string) ?? null,
    ends: (r.ends as string) ?? null,
    title: r.title as string,
    notes: (r.notes as string) ?? null,
    source: (r.source as string) ?? 'local',
    externalId: (r.external_id as string) ?? null,
    created_at: r.created_at as number
  }
}

const EVENT_ORDER = 'ORDER BY day ASC, (starts IS NULL) ASC, starts ASC, id ASC'

export function listEvents(day: string): CalendarEvent[] {
  return (
    getDb().prepare(`SELECT * FROM events WHERE day = ? ${EVENT_ORDER}`).all(day) as Array<Record<string, unknown>>
  ).map(rowToEvent)
}

export function listEventsRange(fromDay: string, toDay: string): CalendarEvent[] {
  return (
    getDb()
      .prepare(`SELECT * FROM events WHERE day >= ? AND day <= ? ${EVENT_ORDER}`)
      .all(fromDay, toDay) as Array<Record<string, unknown>>
  ).map(rowToEvent)
}

export function addEvent(input: {
  day: string
  title: string
  starts?: string | null
  ends?: string | null
  notes?: string | null
  source?: string
  externalId?: string | null
}): CalendarEvent {
  const db = getDb()
  if (input.externalId) {
    const dup = db
      .prepare('SELECT * FROM events WHERE external_id = ? AND source = ?')
      .get(input.externalId, input.source ?? 'local') as Record<string, unknown> | undefined
    if (dup) return rowToEvent(dup)
  }
  const info = db
    .prepare(
      `INSERT INTO events (day, starts, ends, title, notes, source, external_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.day,
      input.starts ?? null,
      input.ends ?? null,
      input.title,
      input.notes ?? null,
      input.source ?? 'local',
      input.externalId ?? null,
      Date.now()
    )
  return rowToEvent(db.prepare('SELECT * FROM events WHERE id = ?').get(info.lastInsertRowid) as Record<string, unknown>)
}

export function updateEvent(
  id: number,
  patch: { title?: string; day?: string; starts?: string | null; ends?: string | null; notes?: string | null }
): CalendarEvent | null {
  const db = getDb()
  const cur = db.prepare('SELECT * FROM events WHERE id = ?').get(id) as Record<string, unknown> | undefined
  if (!cur) return null
  db.prepare('UPDATE events SET title = ?, day = ?, starts = ?, ends = ?, notes = ? WHERE id = ?').run(
    patch.title ?? (cur.title as string),
    patch.day ?? (cur.day as string),
    patch.starts !== undefined ? patch.starts : (cur.starts as string) ?? null,
    patch.ends !== undefined ? patch.ends : (cur.ends as string) ?? null,
    patch.notes !== undefined ? patch.notes : (cur.notes as string) ?? null,
    id
  )
  return rowToEvent(db.prepare('SELECT * FROM events WHERE id = ?').get(id) as Record<string, unknown>)
}

export function removeEvent(id: number): void {
  getDb().prepare('DELETE FROM events WHERE id = ?').run(id)
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
  // Positional params (not named) so this works on both better-sqlite3 and node:sqlite.
  d.prepare(
    `INSERT INTO turns (request_id, text, done, speech, error, state, claimed, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(request_id) DO UPDATE SET
       text=excluded.text, done=excluded.done, speech=excluded.speech,
       error=excluded.error, state=excluded.state, claimed=excluded.claimed`
  ).run(t.requestId, t.text, t.done, t.speech, t.error, t.state, t.claimed ? 1 : 0, Date.now())
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
