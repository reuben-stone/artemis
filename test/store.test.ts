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
  clearReviewedPrs
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
