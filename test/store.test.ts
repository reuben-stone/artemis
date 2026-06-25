import { describe, it, expect, beforeEach } from 'vitest'
import { createRequire } from 'node:module'
// Load node:sqlite at runtime — Vite doesn't recognise this newer builtin and would
// fail to resolve a static import of it.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')
import {
  __setDbOpener,
  appendMessage,
  loadRecentMessages,
  startNewConversation,
  undoNewConversation,
  saveTurn,
  loadLastTurn,
  markTurnClaimed,
  ensureSelfProject,
  addProject,
  listProjects,
  getActiveProjectPath,
  setActiveProjectPath,
  removeProject,
  getProjectGaProps,
  setProjectGaProps,
  addPrReview,
  listPrReviews,
  setPrReviewed,
  clearReviewedPrs,
  addTodo,
  listTodos,
  updateTodo,
  removeTodo,
  carryOverTodos,
  unfinishedBefore,
  addEvent,
  listEvents,
  listEventsRange,
  updateEvent,
  removeEvent,
  getPermissionMode,
  setPermissionMode,
  allowCommand,
  isCommandAllowed,
  listAllowedCommands,
  clearAllowedCommands
} from '../src/main/store'

/**
 * Real store tests against an in-memory node:sqlite DB (the production better-sqlite3
 * binary is built for Electron's ABI and won't load under plain Node). Exercises the
 * exact state the sidecar daemon will share with the face: transcript + view-floor,
 * undo, turn recovery, the project registry, GA props, and the PR review queue.
 */
beforeEach(() => {
  __setDbOpener(() => new DatabaseSync(':memory:'))
})

describe('transcript + view floor', () => {
  it('loads recent messages, then archives them behind the floor on new conversation', () => {
    appendMessage('user', 'hello')
    appendMessage('assistant', 'hi there')
    expect(loadRecentMessages().map((m) => m.text)).toEqual(['hello', 'hi there'])

    startNewConversation()
    // prior thread is archived (below the floor), not deleted
    expect(loadRecentMessages()).toEqual([])

    appendMessage('assistant', 'Fresh start')
    expect(loadRecentMessages().map((m) => m.text)).toEqual(['Fresh start'])
  })
})

describe('undo new conversation', () => {
  it('restores the prior thread and drops the fresh-start greeting', () => {
    appendMessage('user', 'u1')
    appendMessage('assistant', 'a1')
    startNewConversation()
    appendMessage('assistant', 'Fresh start') // the greeting, above the new floor
    expect(loadRecentMessages().map((m) => m.text)).toEqual(['Fresh start'])

    undoNewConversation()
    // greeting removed, original thread back
    expect(loadRecentMessages().map((m) => m.text)).toEqual(['u1', 'a1'])
  })
})

describe('in-flight turn recovery', () => {
  it('saves, recalls, and claims the latest turn', () => {
    saveTurn({ requestId: 'r1', text: 'partial', done: null, speech: '', error: null, state: 'thinking', claimed: false })
    const t = loadLastTurn()
    expect(t?.requestId).toBe('r1')
    expect(t?.text).toBe('partial')
    expect(t?.claimed).toBe(false)

    markTurnClaimed('r1')
    expect(loadLastTurn()?.claimed).toBe(true)
  })
})

describe('project registry', () => {
  it('seeds self, adds/lists, switches active, and falls back on remove', () => {
    ensureSelfProject()
    const selfPath = getActiveProjectPath()
    expect(listProjects().length).toBe(1)

    const web = addProject('livana-web', '/repos/web', 'git@github.com:o/web.git')
    expect(listProjects().length).toBe(2)
    expect(web.remote).toBe('git@github.com:o/web.git')

    setActiveProjectPath('/repos/web')
    expect(getActiveProjectPath()).toBe('/repos/web')

    removeProject(web.id) // removing the active one falls back to a remaining project
    expect(getActiveProjectPath()).toBe(selfPath)
    expect(listProjects().length).toBe(1)
  })
})

describe('per-project GA properties', () => {
  it('round-trips a labelled list and drops empty ids', () => {
    setProjectGaProps('/repos/scanner', [
      { label: 'Lumi', id: '111' },
      { label: 'LumiLens', id: '222' },
      { label: 'blank', id: '' }
    ])
    expect(getProjectGaProps('/repos/scanner')).toEqual([
      { label: 'Lumi', id: '111' },
      { label: 'LumiLens', id: '222' }
    ])
    expect(getProjectGaProps('/repos/none')).toEqual([])
  })
})

describe('PR review queue', () => {
  it('logs PRs unreviewed-first, marks reviewed, and clears done', () => {
    addPrReview({ project: 'web', title: 'Fix a', url: 'http://x/1', branch: 'artemis/a', agent: 'worker' })
    const second = addPrReview({ project: 'scanner', title: 'Fix b', url: 'http://x/2' })

    let prs = listPrReviews()
    expect(prs.length).toBe(2)
    expect(prs.every((p) => !p.reviewed)).toBe(true)

    setPrReviewed(second.id, true)
    prs = listPrReviews()
    expect(prs[0].reviewed).toBe(false) // unreviewed sorts first
    expect(prs.find((p) => p.id === second.id)?.reviewed).toBe(true)

    clearReviewedPrs()
    expect(listPrReviews().map((p) => p.title)).toEqual(['Fix a'])
  })
})

describe('todos (ticket system)', () => {
  it('adds, orders open-by-priority then done-last, and de-dups imported tickets', () => {
    addTodo({ day: '2026-06-25', text: 'low thing', priority: 'low' })
    addTodo({ day: '2026-06-25', text: 'urgent thing', priority: 'high' })
    const done = addTodo({ day: '2026-06-25', text: 'already done' })
    updateTodo(done.id, { status: 'done' })

    const list = listTodos('2026-06-25')
    expect(list.map((t) => t.text)).toEqual(['urgent thing', 'low thing', 'already done'])
    expect(list[2].status).toBe('done')

    // Imports de-dup on (source, external_id) — re-importing is a no-op.
    const a = addTodo({ day: '2026-06-25', text: 'LUM-1 scan bug', source: 'lumi', externalId: 'LUM-1' })
    const b = addTodo({ day: '2026-06-25', text: 'LUM-1 scan bug', source: 'lumi', externalId: 'LUM-1' })
    expect(a.id).toBe(b.id)
    expect(listTodos('2026-06-25').filter((t) => t.source === 'lumi').length).toBe(1)
  })

  it('updates and removes by id', () => {
    const t = addTodo({ day: '2026-06-25', text: 'edit me' })
    updateTodo(t.id, { text: 'edited', priority: 'med', project: 'Lumi' })
    const after = listTodos('2026-06-25')[0]
    expect(after.text).toBe('edited')
    expect(after.project).toBe('Lumi')

    removeTodo(t.id)
    expect(listTodos('2026-06-25')).toEqual([])
  })

  it('carries unfinished tickets forward and records the original day once', () => {
    addTodo({ day: '2026-06-23', text: 'slipped task' })
    const finished = addTodo({ day: '2026-06-23', text: 'finished task' })
    updateTodo(finished.id, { status: 'done' })

    expect(unfinishedBefore('2026-06-25').map((t) => t.text)).toEqual(['slipped task'])

    const moved = carryOverTodos('2026-06-25')
    expect(moved).toBe(1) // only the unfinished one moves
    const today = listTodos('2026-06-25')
    expect(today.map((t) => t.text)).toEqual(['slipped task'])
    expect(today[0].carriedFrom).toBe('2026-06-23')

    // A second carry keeps the ORIGINAL day, not an intermediate one.
    carryOverTodos('2026-06-26')
    expect(listTodos('2026-06-26')[0].carriedFrom).toBe('2026-06-23')
  })
})

describe('local calendar', () => {
  it('lists a day ordered by start (all-day last) and queries a range', () => {
    addEvent({ day: '2026-06-25', title: 'standup', starts: '09:30', ends: '09:45' })
    addEvent({ day: '2026-06-25', title: 'all-day offsite' })
    addEvent({ day: '2026-06-25', title: 'lunch', starts: '12:00' })
    addEvent({ day: '2026-06-27', title: 'review', starts: '15:00' })

    expect(listEvents('2026-06-25').map((e) => e.title)).toEqual(['standup', 'lunch', 'all-day offsite'])

    const week = listEventsRange('2026-06-25', '2026-06-30')
    expect(week.map((e) => e.title)).toEqual(['standup', 'lunch', 'all-day offsite', 'review'])
  })

  it('updates and removes events by id', () => {
    const e = addEvent({ day: '2026-06-25', title: 'call', starts: '14:00' })
    updateEvent(e.id, { starts: '15:00', notes: 'moved' })
    const after = listEvents('2026-06-25')[0]
    expect(after.starts).toBe('15:00')
    expect(after.notes).toBe('moved')

    removeEvent(e.id)
    expect(listEvents('2026-06-25')).toEqual([])
  })
})

describe('permission mode + command allowlist', () => {
  it('defaults to smart and round-trips the mode', () => {
    expect(getPermissionMode()).toBe('smart')
    setPermissionMode('guarded')
    expect(getPermissionMode()).toBe('guarded')
  })

  it('remembers blessed commands per project, dedups, and scopes correctly', () => {
    allowCommand('/repos/web', 'npm test')
    allowCommand('/repos/web', 'npm test') // idempotent — no duplicate row
    expect(listAllowedCommands().length).toBe(1)

    // Only matches the same command in the same project (or a global '' entry).
    expect(isCommandAllowed('/repos/web', 'npm test')).toBe(true)
    expect(isCommandAllowed('/repos/scanner', 'npm test')).toBe(false)
    expect(isCommandAllowed('/repos/web', 'npm run build')).toBe(false)

    // A global allowance ('') applies everywhere.
    allowCommand('', 'git status')
    expect(isCommandAllowed('/repos/anything', 'git status')).toBe(true)

    clearAllowedCommands()
    expect(listAllowedCommands()).toEqual([])
  })
})
